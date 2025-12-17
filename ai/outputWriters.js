const fs = require('fs');
const path = require('path');
const os = require('os');
// ... other requires
// Avoid destructuring functions from transcribeEngine here to prevent
// circular dependency issues. Instead require the module and reference the
// methods dynamically when called.
const transcribeEngine = require('./transcribeEngine');
const { ensureUnique } = require('./whisperUtils');
// use the canonical 608 wrap from the encoder
const scc = require('../modules/sccEncoder');
const { extendedGlyphMap } = require('../modules/sccGlyphMap');
// Pretty DF timecodes for warnings + canonical DF predicate (centralized)
const { formatTimecode, isDropFrameRate } = require('../utils/timeUtils');
const { addFullTimecodeMetadata } = require('./whisperFormatter');

function writeAtomic(outPath, data, encoding = 'utf8') {
  const dir = path.dirname(outPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }

  const tempPath = `${outPath}.__temp__`;

  // Best-effort cleanup of any old temp
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {
    /* ignore */
  }

  // Single-process assumption: we just write then rename.
  fs.writeFileSync(tempPath, data, encoding);

  // If this throws, you *don’t* end up with a half-written final file.
  fs.renameSync(tempPath, outPath);

  return outPath;
}

function stripLegacyTimecodeFields(segments) {
  if (!Array.isArray(segments)) return;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    delete seg.timecodeStart;
    delete seg.timecodeEnd;
    if (Array.isArray(seg.tokens)) {
      for (const tok of seg.tokens) {
        if (!tok || typeof tok !== 'object') continue;
        delete tok.timecodeStart;
        delete tok.timecodeEnd;
        delete tok.timestamps; // string {from,to} mirror
      }
    }
  }
}

// Parse fps from values like 29.97, "29.97", or "29.97DF" and derive a DF hint
function parseFpsDf(raw, dflt = 29.97) {
  if (typeof raw === 'string') {
    const m = raw.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/);
    if (m) return { fps: parseFloat(m[1]), dfFromString: !!m[2] };
  }
  const n = Number(raw);
  if (Number.isFinite(n)) return { fps: n, dfFromString: false };
  return { fps: dflt, dfFromString: false };
}

function getFilename(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

async function writeTXT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.txt`));
  const src = wrapped.finalWords
    ? { system: wrapped.system, segments: wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      })) }
    : wrapped;
  const overrideFps = Number(config?.fpsOverride);
  const resolvedFps = Number.isFinite(overrideFps)
    ? overrideFps
    : (Number.isFinite(Number(wrapped?.system?.fps)) ? Number(wrapped.system.fps) : null);
  const requestedTimecodeStyle = config?.timecodeStyle || (config?.dropFrame ? 'df' : 'ndf');
  const wantsDropFrame = config?.dropFrame || config?.timecodeStyle === 'df';
  const safeTimecodeStyle =
    wantsDropFrame && resolvedFps != null && !isDropFrameRate(resolvedFps)
      ? 'ndf'
      : requestedTimecodeStyle;
  if (wantsDropFrame && safeTimecodeStyle === 'ndf' && resolvedFps != null) {
    console.warn(`[writeTXT] Drop-frame formatting disabled: ${resolvedFps} fps is not a supported drop-frame rate.`);
  }
  const text = transcribeEngine.generatePlainText(
    src,
    {
      ...(config.txtOptions || {}),
      startTimecodeOffset: config.txtOptions?.startTimecodeOffset ?? config.startTC,
      timecodeStyle: safeTimecodeStyle,
      fps: resolvedFps ?? src?.system?.fps
    }
  );
  return [`📝 TXT → ${writeAtomic(outPath, text, 'utf8')}`];
}

async function writeJSON(wrapped, filePath, config) {
  // Belt-and-suspenders: guarantee tri-format on segments/tokens before writing the plain JSON.
  try {
    const fps =
      (wrapped && wrapped.system && wrapped.system.fps) ??
      (typeof config?.fps === 'number' ? config.fps : Number(config?.fps));
    if (!fps) throw new Error('[writeJSON] Missing fps; expected wrapped.system.fps or config.fps');
    if (Array.isArray(wrapped?.segments)) {
      const sysPick = wrapped?.system?.timecodeRepresentations;
      const pick = sysPick
        ? sysPick
        : ((config.timecodeStyle === 'ms')
            ? { ndf: false, df: false, ms: true }
            : (config.dropFrame ? { ndf: false, df: true, ms: false }
                                : { ndf: true, df: false, ms: false }));
      const dfPref = Boolean(wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame);
      addFullTimecodeMetadata(wrapped.segments, fps, dfPref, pick);
      stripLegacyTimecodeFields(wrapped.segments);
    }
  } catch (e) {
    console.warn('writeJSON: reapply timecode metadata failed:', e);
  }
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.json`));
  writeAtomic(outPath, JSON.stringify(wrapped, null, 2));
  return [`📝 JSON → ${outPath}`];
}

async function writeSRT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.srt`));
  const segments = wrapped.finalWords
    ? wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      }))
    : wrapped.segments;
  const srt = transcribeEngine.generateSRT(segments, { ...config, strictTiming: true });
  writeAtomic(outPath, srt, 'utf8');
  return [`📼 SRT → ${outPath}`];
}

async function writeVTT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.vtt`));
  const segments = wrapped.finalWords
    ? wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      }))
    : wrapped.segments;
  const vtt = transcribeEngine.generateVTT(segments, config);
  writeAtomic(outPath, vtt, 'utf8');
  return [`🌐 VTT → ${outPath}`];
}

// ── NEW: SCC writer ─────────────────────────────────────────────────────────

function normalizeMusicGlyphLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return line;
  const up = raw.toUpperCase();
  // Only treat whole-line tokens as music icons.
  if (up === '[MUSIC]' || up === '[MUSIC ONLY]' || up === '[MUSIC INTRO]' || up === '[MUSIC OUT]') {
    return '♪';
  }
  return line;
}

async function writeSCC(wrapped, filePath, config) {
  const base = getFilename(filePath);
  const outPath = ensureUnique(path.join(config.outputPath, `${base}.scc`));

  const raw = wrapped?.system?.fps ?? config?.fpsOverride ?? config?.fps ?? 29.97;
  const { fps, dfFromString } = parseFpsDf(raw, 29.97);
  // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
  // We keep DF as the default, and only allow NDF when explicitly enabled.
  const is2997 = Math.abs(Number(fps) - 29.97) <= 0.02;
  const dfCapable = isDropFrameRate(fps);
  const allowNdf = Boolean(config?.sccOptions?.allowNdf);

  const dropPref = config?.dropFrame ?? wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame ?? dfFromString;
  const wantsDf = (dropPref === true) || (dropPref == null); // default DF
  const dropFrame = dfCapable && wantsDf;

  const dfOk = is2997 && dropFrame === true;
  const ndfOk = is2997 && dropFrame === false && allowNdf;
  if (!dfOk && !ndfOk) {
    if (!is2997) {
      throw new Error(`SCC timebase guard: writer requires 29.97; got fps=${fps}`);
    }
    if (dropFrame === false && !allowNdf) {
      throw new Error('SCC NDF guard: export of ":" timecodes is disabled. Enable sccOptions.allowNdf to export NDF SCC.');
    }
    throw new Error(`SCC timing guard: writer requires 29.97 DF (;) or (opt-in) 29.97 NDF (:); got dropFrame=${dropFrame}`);
  }

  // Encoder understands 'auto' | 'start' | 'ms' | 'df-string'; default to 'auto'.
  const timeSource = config?.sccOptions?.timeSource ?? 'auto';

  // SCC start timecode offset (e.g. 01:00:00;00).
  // This is the program-time origin used when captions are generated from 0-based segment timings.
  const startTc =
    config?.sccOptions?.startTc ||
    config?.sccOptions?.startTC ||
    config?.startTC ||
    config?.startTc ||
    null;

  // Honor UI width for SCC (cap at 32), but default to 28 (a common broadcast-safe wrap width).
  const uiMax = Number(config.maxCharsPerLine ?? 28);
  const per608Max = Math.min(32, Number.isFinite(uiMax) ? uiMax : 28);

  const safeLeft = (() => {
    const v = Number(config?.sccOptions?.safeMargins?.left);
    return Number.isFinite(v) ? Math.max(0, Math.min(31, Math.floor(v))) : 0;
  })();
  const safeRight = (() => {
    const v = Number(config?.sccOptions?.safeMargins?.right);
    return Number.isFinite(v) ? Math.max(0, Math.min(31, Math.floor(v))) : 0;
  })();
  const safeWidth = Math.max(1, 32 - safeLeft - safeRight);

  const effectiveMax = Math.min(per608Max, safeWidth);

  // SCC: hard 1–2 lines per pop-on block for broadcast sanity
  const rawLines = Number(config.maxLinesPerBlock ?? 2);
  const maxLinesPerBlock = Math.max(1, Math.min(2, rawLines));

  const segs = Array.isArray(wrapped?.segments) ? wrapped.segments : [];
  // SCC speaker labels are a separate opt-in for QC safety.
  const includeSpeakerNamesScc = Boolean(config?.sccOptions?.includeSpeakerNames);

  // If enabled, bake speaker labels into the text here and disable encoder auto-prefixing.
  // This avoids placement/wrapping mismatches when we pre-wrap for row/col tags below.
  const segs608 = includeSpeakerNamesScc
    ? segs.map(seg => {
        if (!seg) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        const base = String(seg.text || '');
        return base.startsWith(prefix) ? seg : { ...seg, text: `${prefix}${base}` };
      })
    : segs;
  const placements = [];
  const wrappedLines = [];
  segs608.forEach((seg, i) => {
    const lines = scc.wrapTextAndClamp(
      String(seg?.text || ''),
      effectiveMax,
      maxLinesPerBlock,
      {
        // Broadcast deliverables must never silently truncate.
        overflowPolicy: 'error',
        cueIndex: i + 1
      }
    );
    wrappedLines[i] = Array.isArray(lines) ? lines : [String(seg?.text || '')];
    placements[i] = seg?.sccPlacement ? seg.sccPlacement : null;
  });

  const segsForScc = segs608.map((seg, i) => {
    const p = placements[i];
    if (!p || !seg) return seg;
    const lines = wrappedLines[i] || [];
    const withTags = lines.map((line, li) => {
      const pl = p[li] || {};
      const rowTag = Number.isFinite(pl.row) ? `{row:${pl.row}}` : '';
      const colTag = Number.isFinite(pl.col) ? `{col:${pl.col}}` : '';
      const body = normalizeMusicGlyphLine(line);
      return `${rowTag}${colTag}${body}`;
    }).join('\n');
    return { ...seg, text: withTags };
  });

  const getColumnStart =
    (config?.sccOptions && typeof config.sccOptions.getColumnStart === 'function')
      ? config.sccOptions.getColumnStart
      : null;

  const sccRes = scc.generateSCC(segsForScc, {
    fps,
    dropFrame,
    startTc,
    maxCharsPerLine: effectiveMax,
    maxLinesPerBlock,
    // Speaker labels (if enabled) were baked into seg text above.
    includeSpeakerNames: false,
    sccOptions: {
      mode:      'pop-on',
      alignment: (config?.sccOptions?.alignment) ?? 'left',           // hard-left
      channel:   (config?.sccOptions?.channel)   ?? 1,
      rowPolicy: (config?.sccOptions?.rowPolicy) ?? 'bottom2',        // rows 14–15
      safeMargins: { left: safeLeft, right: safeRight },
      padEven:   config?.sccOptions?.padEven === true,
      extendedGlyphMap,
      overflowPolicy: (config?.sccOptions?.overflowPolicy) ?? 'error',
      // NDF SCC export is opt-in and must be explicitly enabled.
      allowNdf,
      // Match encoder's "redundancy ON by default" unless explicitly disabled
      repeatControlCodes:  config?.sccOptions?.repeatControlCodes !== false,
      repeatPreambleCodes: config?.sccOptions?.repeatPreambleCodes !== false,
      getColumnStart,
      // new plumbed options
      timeSource,
      // Start TC offset for SCC exports (HH:MM:SS;FF or HH:MM:SS:FF)
      startTc,
      appendEOFAt: (config?.sccOptions?.appendEOFAt) ?? 'afterLast',
      eofOp:       (config?.sccOptions?.eofOp)       ?? 'edm',
      // NEW:
      stripLeadingDashes: Boolean(config?.sccOptions?.stripLeadingDashes)
    },
    returnStats: true
  });

  let sccText = (sccRes && typeof sccRes === 'object' && 'scc' in sccRes) ? sccRes.scc : sccRes;
  const stats   = (sccRes && typeof sccRes === 'object' && sccRes.stats) ? sccRes.stats : {};
  // Belt‑and‑suspenders: ensure header is the first line in case a future change adds preface text.
  sccText = sccText.replace(/^\uFEFF/, '');
  const _lines = sccText.replace(/\r/g,'').split('\n');
  const _hdrIdx = _lines.findIndex(l => /^Scenarist_SCC\b/i.test(l.trim()));
  if (_hdrIdx > 0) {
    const pre = _lines.slice(0, _hdrIdx).filter(l => l.trim().startsWith('//'));
    sccText = [_lines[_hdrIdx], ...pre, ..._lines.slice(_hdrIdx + 1)]
      .join('\n').replace(/\n+$/, '') + '\n';
  }
  // SCC is traditionally CRLF-delimited; some broadcast/QC pipelines are picky.
  const sccWriteText = sccText.replace(/\r?\n/g, '\r\n');
  writeAtomic(outPath, sccWriteText, 'utf8');
  const notes = [`📺 SCC → ${outPath}`];

  // ── Timing validation (Phase 2 — I) ───────────────────────────────────────
  // Use the SCC "Max subtitle duration" slider as the primary limit;
  // fall back to any explicit sccOptions.timing.maxBlockSec, then 6s default.
  const maxBlockSec = (() => {
    const ui = Number(config?.maxDurationSeconds);
    if (Number.isFinite(ui) && ui > 0) return ui;
    const opt = Number(config?.sccOptions?.timing?.maxBlockSec);
    return Number.isFinite(opt) && opt > 0 ? opt : 6;
  })();
  const timing = validateTiming(segs, { fps, dropFrame, maxBlockSec });
  if (stats) stats.timingWarnings = timing;
  if (timing.longBlocks.length) {
    console.warn(
      `⚠️ ${timing.longBlocks.length} caption block(s) exceed ${maxBlockSec}s —`,
      timing.longBlocks.slice(0, 3)
        .map(w => `${w.startTc}–${w.endTc} (${w.durationSec}s)`).join(' • ')
    );
  }
  if (timing.overlaps.length) {
    console.warn(
      `⚠️ ${timing.overlaps.length} overlap(s) detected —`,
      timing.overlaps.slice(0, 3)
        .map(w => `${w.endTc} > ${w.nextStartTc} (+${w.overlapMs}ms)`).join(' • ')
    );
  }

  // ── Content-level QC (Phase D) ────────────────────────────────────────────
  // Broadcast QC cares about *readability* and *timing*, not just file structure.
  // We compute CPS/WPM, minimum duration/gap, and late-EOC thresholds.
  const qcCfg = (config && config.sccOptions && config.sccOptions.qc) ? config.sccOptions.qc : {};
  const contentQc = validateSccContentQc(segsForScc, {
    fps,
    dropFrame,
    startTc,
    // Thresholds (defaults are pragmatic; override via config.sccOptions.qc.*)
    maxCps: qcCfg.maxCps,
    maxWpm: qcCfg.maxWpm,
    minDurationSec: qcCfg.minDurationSec,
    minGapSec: qcCfg.minGapSec,
    maxLateEocSec: qcCfg.maxLateEocSec,
    maxLateEocCount: qcCfg.maxLateEocCount,
    // Encoder-derived late EOC stats (when available)
    lateEocCount: Number(stats?.lateEocCount ?? 0),
    maxLateEocSecObserved: Number(stats?.maxLateEocSec ?? 0)
  });
  if (stats) stats.contentQc = contentQc;

  // ── QC sidecar (report) including chosen row policy ────────────────────────
  // QC report mirrors actual writer settings
  const chan   = (config?.sccOptions?.channel)   ?? 1;
  const align  = (config?.sccOptions?.alignment) ?? 'left';
  const policy = (config?.sccOptions?.rowPolicy) ?? 'bottom2';
  const policyLabel = policy === '13-14' ? 'rows 13–14'
    : policy === '12-13' ? 'rows 12–13'
      : 'rows 14–15';
  const timeAnchor = timeSource;
  const language = config?.language || wrapped?.system?.language || 'en';

  let paritySummary = '';
  let rep;
  try {
    if (typeof scc.verifySCC === 'function') {
      rep = scc.verifySCC(outPath, { fps });
      paritySummary = rep?.summary || '';
    }
  } catch (e) {
    paritySummary = `Verifier error: ${e.message}`;
  }

  const reportPath = ensureUnique(path.join(config.outputPath, `${base}.scc.report.txt`));
  const lastSegment = segs.length ? segs[segs.length - 1] : null;
  const durationSec = Number(wrapped?.metadata?.durationSeconds ?? lastSegment?.end ?? 0) || 0;
  const nominalFps  = Math.round(Number(fps) || 30);
  const totalFrames = Math.max(0, Math.round(durationSec * nominalFps));
  const maxChars    = effectiveMax;  // reflect the writer’s actual width
  const maxLines    = maxLinesPerBlock;

  // ── SCC transmit clamp annotation ─────────────────────────────────────────
  // Encoder-side clamp (when implemented) ensures no SCC lines are emitted earlier
  // than Start TC. We annotate the intent here so QC has explicit documentation.
  const transmitClampEnabled = !!(startTc && String(startTc).trim());

  // Capture encoder warnings when returnStats is enabled (e.g. clamp warnings).
  const encoderWarnings = Array.isArray(stats?.warnings) ? stats.warnings.filter(Boolean) : [];
  const clampWarnings = encoderWarnings.filter(w =>
    /pre[- ]transmit/i.test(String(w)) || /clamp/i.test(String(w))
  );
  const maxWarnLines = 12;
  const warnList = encoderWarnings.slice(0, maxWarnLines).map(w => `  - ${String(w)}`);
  const clampList = clampWarnings.slice(0, maxWarnLines).map(w => `  - ${String(w)}`);

  const report = [
    'SCC QC REPORT',
    `File: ${outPath}`,
    `Start TC offset: ${startTc || '(none)'}`,
    `Transmit clamp (no SCC earlier than Start TC): ${transmitClampEnabled ? 'ON' : 'OFF'}`,
    `Channel: CC${chan}`,
    `Row policy: ${policy} (${policyLabel})`,
    `Alignment: ${align}`,
    `Safe margins: L${safeLeft} / R${safeRight} (usable width ${maxChars})`,
    `Timing anchor: ${timeAnchor}`,
    `Language: ${language}`,
    '',
    '--- Metrics ---',
    `Video FPS: ${fps}${dropFrame ? ' (drop-frame)' : ''}`,
    `Total frames (approx): ${totalFrames}`,
    `Caption blocks: ${Number(stats.captionsCount ?? 0)}`,
    `Average block duration: ${Number(stats.avgDurationSec ?? 0).toFixed(2)} s`,
    `Longest visible line: ${Number(stats.longestLineChars ?? 0)} / ${maxChars}`,
    `Max lines per block: ${maxLines}`,
    '',
    '--- Content QC (readability/timing) ---',
    `Thresholds: maxCPS ${contentQc.thresholds.maxCps}, maxWPM ${contentQc.thresholds.maxWpm}, minDur ${contentQc.thresholds.minDurationSec}s, minGap ${contentQc.thresholds.minGapSec}s, maxLateEOC ${contentQc.thresholds.maxLateEocSec}s (count ≤ ${contentQc.thresholds.maxLateEocCount})`,
    `Observed: maxCPS ${Number(contentQc.metrics.maxCps || 0).toFixed(2)}, maxWPM ${Number(contentQc.metrics.maxWpm || 0).toFixed(0)}, minDur ${Number.isFinite(contentQc.metrics.minDurationSec) ? contentQc.metrics.minDurationSec.toFixed(3) : 'n/a'}s, minGap ${Number.isFinite(contentQc.metrics.minGapSec) ? contentQc.metrics.minGapSec.toFixed(3) : 'n/a'}s, lateEOC ${Number(contentQc.metrics.lateEocCount || 0)} (max ${Number(contentQc.metrics.maxLateEocSec || 0).toFixed(3)}s)`,
    `Content QC: ${contentQc.ok ? 'PASS' : 'FAIL'} • failures ${contentQc.failures.length} • warnings ${contentQc.warnings.length}`,
    ...(contentQc.failures.length ? ['Failures:'].concat(contentQc.failures.slice(0, 10).map(f => `  > ${f.type} ${f.startTc ? (f.startTc + '–' + f.endTc) : ''} ${f.message}`)) : ['Failures: (none)']),
    ...(contentQc.warnings.length ? ['Warnings:'].concat(contentQc.warnings.slice(0, 10).map(w => `  - ${w.type} ${w.startTc ? (w.startTc + '–' + w.endTc) : ''} ${w.message}`)) : ['Warnings: (none)']),
    '',
    '--- Encoder warnings ---',
    `Warnings: ${encoderWarnings.length}`,
    ...(warnList.length ? warnList : ['  (none)']),
    '',
    '--- Transmit clamp details ---',
    `Clamp warnings: ${clampWarnings.length}`,
    ...(clampList.length ? clampList : ['  (none)']),
    '',
    '--- Timing validation ---',
    `Max block allowed: ${maxBlockSec} s`,
    `Over‑long blocks: ${timing.longBlocks.length}`,
    `Overlaps: ${timing.overlaps.length}`,
    ...(timing.count ? [
      'Examples:',
      ...timing.longBlocks.slice(0, 10).map(w => `  > LONG  ${w.startTc} → ${w.endTc} (${w.durationSec}s)  ${w.text}`),
      ...timing.overlaps.slice(0, 10).map(w => `  > OVERL ${w.endTc} > ${w.nextStartTc} (+${w.overlapMs}ms)  ${w.text}`)
    ] : []),
    '',
    '--- Parity ---',
    paritySummary ? `Parity: ${paritySummary}` : null,
    rep ? `Parsed lines: ${rep.parsedLines} • Words: ${rep.totalWords} • Invalid tokens: ${rep.invalidTokens} • Parity errors: ${rep.parityErrors}` : null
  ].filter(Boolean).join('\n');
  writeAtomic(reportPath, report, 'utf8');
  notes.push(`🧪 SCC report → ${reportPath}`);

  // 🚨 QC gate: fail on content-level QC violations (reading rate, min durations/gaps, late EOC).
  if (contentQc && contentQc.ok === false) {
    const top = contentQc.failures && contentQc.failures.length
      ? (contentQc.failures[0].message || contentQc.failures[0].type)
      : 'content QC failed';
    throw new Error(`SCC QC failed — content QC (${contentQc.failures.length} issue(s)): ${top}`);
  }

  // 🚨 QC gate: fail on any SCC structural issue (timecode, overlap, parity, etc.)
  if (rep && !rep.ok) {
    throw new Error(`SCC QC failed — ${rep.summary}`);
  }

  // Optional: parallel 608 XML sidecar (Phase 4)
  if (config?.sccOptions?.xmlSidecar) {
    try {
      // Force 'colon' style with the same fps/DF used for SCC so the XML timecodes
      // match the SCC frame grid exactly (HH:MM:SS;FF for DF).
      const xml = transcribeEngine.generateXML(
        wrapped.finalWords
          ? wrapped.finalWords.map(w => ({
              start: w.start,
              end: w.end,
              text: w.text || w.word,
              speaker: w.speaker
            }))
          : (wrapped.segments || []),
        'colon',
        fps,
        dropFrame
      );
      const xmlPath = ensureUnique(path.join(config.outputPath, `${base}.xml`));
      writeAtomic(xmlPath, xml, 'utf8');
      notes.push(`🧾 SCC XML sidecar → ${xmlPath}`);
    } catch (e) {
      notes.push(`⚠️ Failed to write SCC XML sidecar: ${e?.message || e}`);
    }
  }

  return notes;
}

async function writeSccFromTranscriptionJob(opts) {
  const {
    segments,
    sccConfig,
    outPath
  } = opts || {};

  if (!segments || !sccConfig || !outPath) return null;

  const sccText = scc.generateSCC(segments, sccConfig);
  fs.writeFileSync(outPath, sccText, 'utf8');

  // G) Write QC report sidecar for SCC output
  const verify = (typeof scc.verifySCC === 'function') ? scc.verifySCC(sccText) : null;
  const reportOut = writeSccQcReport({
    sccText,
    verify,
    metrics: verify?.metrics || null,
    srcLabel: opts?.srcLabel || 'transcription',
    outPath
  });
  if (reportOut?.reportPath) {
    // optional: log/report path
  }

  return { outPath };
}

function writeSccQcReport({
  sccText,
  verify,
  metrics,
  srcLabel = '',
  outPath
}) {
  if (!outPath) return null;
  const reportPath = `${outPath}.report.txt`;
  const lines = [];
  lines.push('=== SCC QC REPORT ===');
  if (srcLabel) lines.push(`Source: ${srcLabel}`);
  lines.push(`Output: ${outPath}`);
  lines.push('');
  if (verify) {
    lines.push('--- verifySCC() ---');
    lines.push(JSON.stringify(verify, null, 2));
    lines.push('');
  }
  if (metrics) {
    lines.push('--- metrics ---');
    lines.push(JSON.stringify(metrics, null, 2));
    lines.push('');
  }
  if (sccText) {
    lines.push('--- preview ---');
    lines.push(String(sccText).split(/\r?\n/).slice(0, 6).join('\n'));
    lines.push('');
  }
  try {
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  } catch (e) {
    return { reportPath, error: String(e?.message || e) };
  }
  return { reportPath };
}

async function writeXML(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.xml`));
  // Keep writer behavior in parity with preview: honor the configured timecode style.
  // transcribeEngine.generateXML already accepts (segments, style).
  const style = (config && config.timecodeStyle) || (wrapped && wrapped.metadata && wrapped.metadata.timecodeStyle) || 'colon';
  const fps = wrapped?.system?.fps || config.fps || 30;
  const dropPref = config?.dropFrame ?? wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame;
  const dropFrame = Boolean(dropPref && isDropFrameRate(fps));
  const xml = transcribeEngine.generateXML(wrapped.segments, style, fps, dropFrame);
  writeAtomic(outPath, xml, 'utf8');
  return [`📝 XML → ${outPath}`];
}

async function writeScript(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.sync.csv`));
  const scriptFormat = config?.formats?.script || {};
  const fpsCandidates = [
    Number(scriptFormat.frameRateOverride),
    Number(config?.fpsOverride),
    Number(wrapped?.system?.fps),
    Number(config?.fps)
  ];
  const resolvedFps = fpsCandidates.find(v => Number.isFinite(v) && v > 0) || 30;
  const resolvedTimecodeFormat =
    scriptFormat.timecodeFormat ||
    config?.timecodeStyle ||
    (config?.dropFrame ? 'df' : 'ndf');
  const scriptOptions = {
    fps: resolvedFps,
    timecodeFormat: resolvedTimecodeFormat,
    startTimecodeOffset: scriptFormat.startTimecodeOffset || config?.startTC || null,
    includeSpeakers:
      scriptFormat.includeSpeakers ?? config?.includeSpeakerNames ?? true,
    includeTimecodes: scriptFormat.includeTimecodes ?? true,
    groupBySpeaker: !!scriptFormat.groupBySpeaker,
    speakerStyle: scriptFormat.speakerLabelStyle || 'title',
    timestampStyle: (scriptFormat.timestampPlacement || 'start-end').replace(/_/g, '-')
  };
  const csv = transcribeEngine.generateSyncableScriptCSV(
    wrapped,
    scriptOptions
  );
  writeAtomic(outPath, csv, 'utf8');
  return [`📓 Script → ${outPath}`];
}

async function writeMarkers(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.markers.txt`));
  const dropPref = config?.dropFrame ?? wrapped.system.dropFramePreferred ?? wrapped.system.dropFrame;
  const dropFrame = Boolean(dropPref && isDropFrameRate(wrapped.system.fps));
  const text = transcribeEngine.generateMarkersTXT(
    wrapped.segments,
    wrapped.system.fps,
    wrapped.metadata.timecodeStyle,
    dropFrame
  );
  writeAtomic(outPath, text, 'utf8');
  return [`📌 Markers → ${outPath}`];
}

async function writeTokenAlignedTXT(wrapped, filePath, config) {
  const outPath = ensureUnique(
    path.join(config.outputPath, `${getFilename(filePath)}.tokenAligned.txt`)
  );
  const fmt = config.txtOptions?.timestampStyle || 'FF';
  const text = transcribeEngine.generateSegmentTextWithTokenTiming(
    wrapped.segments,
    fmt
  );
  writeAtomic(outPath, text, 'utf8');
  return [`🧠 Token-Aligned TXT → ${outPath}`];
}

async function writeBurnIn(wrapped, filePath, config) {
  fs.mkdirSync(config.outputPath, { recursive: true });
  const supportBase = path.join(os.homedir(), 'Library', 'Application Support');
  const variants = ['LeadAEAssist', 'LEAD AE – ASSIST', 'LEAD AE - ASSIST', 'Lead AE Assist'];
  const appRoot =
    process.env.USER_DATA_PATH ||
    variants
      .map(v => path.join(supportBase, v))
      .find(p => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) ||
    path.join(supportBase, 'LeadAEAssist');
  const tempDir = path.join(appRoot, 'temp', 'subtitle', 'burnin');
  fs.mkdirSync(tempDir, { recursive: true });
  const srtPath = path.join(tempDir, `${getFilename(filePath)}.srt`);
  if (!fs.existsSync(srtPath)) {
    const segments = wrapped.finalWords
      ? wrapped.finalWords.map(w => ({
          start: w.start,
          end: w.end,
          text: w.text || w.word,
          speaker: w.speaker
        }))
      : wrapped.segments;
    const srt = transcribeEngine.generateSRT(segments, { ...config, strictTiming: true });
    writeAtomic(srtPath, srt, 'utf8');
  }
  const result = await transcribeEngine.burnInSubtitles(
    config.files[0],
    srtPath,
    config.outputPath
  );
  return [result];
}

async function writeFinalJSON(wrapped, filePath, config) {
  // Re-assert tri-format timecode metadata at write time to prevent drift.
  try {
    const fps =
      (wrapped && wrapped.system && wrapped.system.fps) ||
      (typeof config?.fps === 'number' ? config.fps : Number(config?.fps)) ||
      29.97;
    if (Array.isArray(wrapped?.segments)) {
      const sysPick = wrapped?.system?.timecodeRepresentations;
      const pick = sysPick
        ? sysPick
        : ((config.timecodeStyle === 'ms')
            ? { ndf: false, df: false, ms: true }
            : (config.dropFrame ? { ndf: false, df: true, ms: false }
                                : { ndf: true, df: false, ms: false }));
      addFullTimecodeMetadata(wrapped.segments, fps, /*ignored*/ false, pick);
      stripLegacyTimecodeFields(wrapped.segments);
    }
  } catch (e) {
    console.warn('writeFinalJSON: reapply timecode metadata failed:', e);
  }
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.final.json`));
  writeAtomic(outPath, JSON.stringify(wrapped, null, 2));
  return [`📝 Final JSON → ${outPath}`];
}

async function writeCorrectedJson(cues, targetDir, baseName, meta = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.final.json`));

  // Use the writing-context FPS/DF so labels match the project timing.
  const fps = Number(meta?.fps) || 29.97;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = !!meta?.dropFrame && dfCapable;
  const style = meta?.timecodeStyle;
  const pick =
    style === 'ms'
      ? 'ms'
      : style === 'df' && dropFrame
        ? 'df'
        : style === 'ndf'
          ? 'ndf'
          : (dropFrame ? 'df' : 'ndf');

  const payload = {
    type: 'subtitleCorrection',
    correctedAt: new Date().toISOString(),
    cues: (cues || []).map(cue => {
      const start = Number(cue.start) || 0;
      const end   = Number(cue.end)   || start;

      // Emit only the chosen representation
      const tc =
        pick === 'ms'
          ? { ms: { start: Math.round(start * 1000), end: Math.round(end * 1000) } }
          : pick === 'df'
              ? { df: {
                  start: formatTimecode(start, dropFrame, fps, 'colon'),
                  end: formatTimecode(end, dropFrame, fps, 'colon'),
                  dfCapable
                } }
              : { ndf: {
                  start: formatTimecode(start, false, fps, 'colon'),
                  end: formatTimecode(end, false, fps, 'colon')
                } };

      return {
        id: cue.id,
        start, end,
        text: cue.text,
        speaker: cue.speaker || null,
        timecodes: tc,
        // new: keep editor placements
        sccPlacement: cue.sccPlacement ? { ...cue.sccPlacement } : undefined
      };
    }),
    meta: {
      ...meta,
      fps,
      dropFrame,
      dfCapable,
      timecodeStyle: pick
    }
  };

  writeAtomic(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function writeCorrectedSRT(cues, targetDir, baseName, config = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.srt`));
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const srt = transcribeEngine.generateSRT(segments, { ...config, strictTiming: true });
  writeAtomic(outPath, srt, 'utf8');
  return outPath;
}

async function writeCorrectedVTT(cues, targetDir, baseName, config = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.vtt`));
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const vtt = transcribeEngine.generateVTT(segments, config);
  writeAtomic(outPath, vtt, 'utf8');
  return outPath;
}

async function writeAllOutputs(wrapped, filePath, config) {
  const writers = {
    txt: writeTXT,
    json: writeJSON,
    finalJson: writeFinalJSON,
    srt: writeSRT,
    vtt: writeVTT,
    // NEW:
    scc: writeSCC,
    xml: writeXML,
    script: writeScript,
    markers: writeMarkers,
    burnIn: writeBurnIn,
    tokenAlignedTxt: writeTokenAlignedTXT
  };

  const selected = Object.entries(config.outputFormats).filter(([, v]) => v);
  const outputLogs = [];

  for (const [format] of selected) {
    const writer = writers[format];
    if (writer) {
      try {
        const log = await writer(wrapped, filePath, config);
        outputLogs.push(...[].concat(log));
      } catch (err) {
        outputLogs.push(`❌ ${format.toUpperCase()} export failed: ${err.message}`);
        // SCC drift failures must fail the job (CI gate)
        if (format === 'scc') {
          throw err;
        }
      }
    } else if (format === 'cap') {
      // Legacy configs may still request CAP. Be explicit.
      outputLogs.push('❌ CAP export is no longer supported.');
    }
  }

  return outputLogs;
}

function validateTiming(
  segments = [],
  { fps = 29.97, dropFrame = true, maxBlockSec = 6 } = {}
) {
  const out = { longBlocks: [], overlaps: [], count: 0 };
  const tc = (sec) => formatTimecode(sec, dropFrame, fps);
  const pickLabel = (s, which) => {
    const t = s?.timecodes;
    if (!t) return null;
    // prefer DF label when DF is active, else NDF
    return dropFrame ? (t.df?.[which] || t.ndf?.[which] || null)
                     : (t.ndf?.[which] || t.df?.[which] || null);
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] || {};
    const start = Number.isFinite(s.start) ? s.start : (s.msStart ?? 0) / 1000;
    const end = Number.isFinite(s.end)
      ? s.end
      : (s.msEnd ?? start * 1000) / 1000;
    const dur = Math.max(0, end - start);
    if (dur > maxBlockSec) {
      out.longBlocks.push({
        index: s.id ?? i,
        startTc: pickLabel(s, 'start') || tc(start),
        endTc: pickLabel(s, 'end') || tc(end),
        durationSec: Number(dur.toFixed(3)),
        text: String(s.text || '').trim().slice(0, 80)
      });
    }
    if (i + 1 < segments.length) {
      const next = segments[i + 1] || {};
      const nextStart = Number.isFinite(next.start)
        ? next.start
        : (next.msStart ?? 0) / 1000;
      if (end > nextStart) {
        out.overlaps.push({
          index: s.id ?? i,
          endTc: pickLabel(s, 'end') || tc(end),
          nextStartTc: pickLabel(next, 'start') || tc(nextStart),
          overlapMs: Math.round((end - nextStart) * 1000),
          text: String(s.text || '').trim().slice(0, 80)
        });
      }
    }
  }
  out.count = out.longBlocks.length + out.overlaps.length;
  return out;
}

function _strip608QcText(input) {
  // Remove HTML tags, SCC placement tags, and mid-row style tokens.
  let s = String(input || '');
  s = s.replace(/<[^>]*>/g, '');
  // Remove common editor/encoder tags: {row:15}{col:0}{pac:....}{NOP}{Wh}{GrU}...
  s = s.replace(/\{\s*(row|col|pac)\s*:\s*[^}]+\}\s*/gi, '');
  s = s.replace(/\{\s*(NOP)\s*\}\s*/gi, '');
  s = s.replace(/\{\s*(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\s*\}\s*/g, '');
  // Normalize whitespace but keep explicit line breaks for line-break heuristics
  s = s.replace(/\r\n?/g, '\n');
  return s;
}

function validateSccContentQc(segments = [], {
  fps = 29.97,
  dropFrame = true,
  startTc = null,

  // thresholds (override per deliverable)
  maxCps = 20,              // chars/sec (excluding whitespace)
  maxWpm = 180,             // words/min
  minDurationSec = 0.80,    // blocks shorter than this read as “flashing”
  minGapSec = 0.10,         // gaps smaller than this can feel like flicker

  // late-EOC enforcement (encoder side computes these)
  maxLateEocSec = 0.10,
  maxLateEocCount = 0,

  // observed (optional)
  lateEocCount = 0,
  maxLateEocSecObserved = 0,

  // limits for report verbosity
  maxItems = 50
} = {}) {
  const out = {
    ok: true,
    failures: [],
    warnings: [],
    thresholds: {
      maxCps, maxWpm, minDurationSec, minGapSec,
      maxLateEocSec, maxLateEocCount
    },
    metrics: {
      cues: 0,
      maxCps: 0,
      maxWpm: 0,
      minDurationSec: Infinity,
      minGapSec: Infinity,
      lateEocCount,
      maxLateEocSec: maxLateEocSecObserved
    }
  };

  const { parseTime: parseTimeMs } = require('../utils/timeUtils');

  const baseOffsetSec = (() => {
    const raw = String(startTc || '').trim();
    if (!raw) return 0;
    try {
      const ms = parseTimeMs(raw, fps, null);
      const sec = (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
      return Number.isFinite(sec) ? sec : 0;
    } catch {
      return 0;
    }
  })();

  const labelFor = (seg, which, secFallback) => {
    const t = seg?.timecodes;
    const pref = dropFrame ? (t?.df?.[which] || t?.ndf?.[which]) : (t?.ndf?.[which] || t?.df?.[which]);
    if (typeof pref === 'string' && pref) return pref;
    // SCC encoder applies Start TC as an offset for numeric times; mirror that for labels.
    const sec = Number(secFallback) + (baseOffsetSec || 0);
    return formatTimecode(sec, dropFrame, fps, 'colon');
  };

  const cleaned = (Array.isArray(segments) ? segments : []).map(s => s || {});
  const cues = cleaned.length;
  out.metrics.cues = cues;

  // Duration + reading-rate per cue
  for (let i = 0; i < cleaned.length; i++) {
    const seg = cleaned[i];
    const start = Number.isFinite(seg.start) ? seg.start : (Number(seg.msStart) || 0) / 1000;
    let end = Number.isFinite(seg.end) ? seg.end : (Number(seg.msEnd) || NaN) / 1000;

    // Fallback end if missing: next cue start, else a small tail
    if (!Number.isFinite(end) || end <= start) {
      const next = cleaned[i + 1];
      const ns = next ? (Number.isFinite(next.start) ? next.start : (Number(next.msStart) || NaN) / 1000) : NaN;
      end = (Number.isFinite(ns) && ns > start) ? ns : (start + Math.max(1 / (Number(fps) || 30), 0.5));
    }

    const dur = Math.max(0, end - start);
    out.metrics.minDurationSec = Math.min(out.metrics.minDurationSec, dur);

    const rawText = _strip608QcText(seg.text || seg.lines?.join?.('\n') || '');
    const lines = rawText.split('\n').map(x => x.trim()).filter(Boolean);
    const flat = lines.join(' ').replace(/\s+/g, ' ').trim();

    const charNoSpace = flat.replace(/\s+/g, '').length;
    const wordCount = flat ? flat.split(/\s+/g).filter(Boolean).length : 0;

    const cps = dur > 0 ? (charNoSpace / dur) : Infinity;
    const wpm = dur > 0 ? (wordCount / (dur / 60)) : Infinity;

    out.metrics.maxCps = Math.max(out.metrics.maxCps, cps);
    out.metrics.maxWpm = Math.max(out.metrics.maxWpm, wpm);

    const startTc = labelFor(seg, 'start', start);
    const endTc = labelFor(seg, 'end', end);

    // Hard failures
    if (dur < minDurationSec) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'minDuration',
        index: seg.id ?? i,
        startTc, endTc,
        durationSec: Number(dur.toFixed(3)),
        message: `Duration ${dur.toFixed(3)}s < min ${minDurationSec}s`
      });
    }
    if (cps > maxCps) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'cps',
        index: seg.id ?? i,
        startTc, endTc,
        cps: Number(cps.toFixed(2)),
        message: `CPS ${cps.toFixed(2)} > max ${maxCps}`
      });
    }
    if (wpm > maxWpm) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'wpm',
        index: seg.id ?? i,
        startTc, endTc,
        wpm: Number(wpm.toFixed(0)),
        message: `WPM ${wpm.toFixed(0)} > max ${maxWpm}`
      });
    }

    // Soft heuristics (warnings)
    // Suspicious line breaks: ending a line with a very short “hanger” word.
    if (lines.length >= 2) {
      const end1 = String(lines[0] || '').trim().toLowerCase();
      const lastTok = end1.split(/\s+/g).filter(Boolean).slice(-1)[0] || '';
      const hangers = new Set(['a','an','the','of','to','and','or','but','for','in','on','at','with','from','as','by']);
      if (hangers.has(lastTok)) {
        if (out.warnings.length < maxItems) out.warnings.push({
          type: 'lineBreak',
          index: seg.id ?? i,
          startTc, endTc,
          message: `Line break ends with “${lastTok}” (likely awkward split)`
        });
      }
    }
  }

  // Gap checks (between cues)
  for (let i = 0; i + 1 < cleaned.length; i++) {
    const a = cleaned[i];
    const b = cleaned[i + 1];
    const aEnd = Number.isFinite(a.end) ? a.end : (Number(a.msEnd) || NaN) / 1000;
    const bStart = Number.isFinite(b.start) ? b.start : (Number(b.msStart) || NaN) / 1000;
    if (!Number.isFinite(aEnd) || !Number.isFinite(bStart)) continue;

    const gap = bStart - aEnd;
    out.metrics.minGapSec = Math.min(out.metrics.minGapSec, gap);

    if (gap < minGapSec) {
      const aEndTc = labelFor(a, 'end', aEnd);
      const bStartTc = labelFor(b, 'start', bStart);
      if (out.failures.length < maxItems) out.failures.push({
        type: 'minGap',
        index: a.id ?? i,
        endTc: aEndTc,
        nextStartTc: bStartTc,
        gapSec: Number(gap.toFixed(3)),
        message: `Gap ${gap.toFixed(3)}s < min ${minGapSec}s`
      });
    }
  }

  // Late-EOC enforcement (encoder-side metric)
  if (Number.isFinite(maxLateEocSecObserved) && maxLateEocSecObserved > maxLateEocSec) {
    if (out.failures.length < maxItems) out.failures.push({
      type: 'lateEoc',
      index: null,
      message: `Max late EOC ${Number(maxLateEocSecObserved).toFixed(3)}s > max ${maxLateEocSec}s`
    });
  }
  if (Number.isFinite(lateEocCount) && lateEocCount > maxLateEocCount) {
    if (out.failures.length < maxItems) out.failures.push({
      type: 'lateEocCount',
      index: null,
      message: `Late EOC count ${lateEocCount} > max ${maxLateEocCount}`
    });
  }

  out.ok = out.failures.length === 0;
  return out;
}

module.exports = {
  writeTXT,
  writeJSON,
  writeFinalJSON,
  writeSRT,
  writeVTT,
  writeSCC,
  writeSccFromTranscriptionJob,
  writeXML,
  writeScript,
  writeMarkers,
  writeTokenAlignedTXT,
  writeBurnIn,
  writeAllOutputs,
  writeCorrectedJson,
  writeCorrectedSRT,
  writeCorrectedVTT,
  writeSccQcReport,
  // Exported for subtitle-editor SCC exports so they can enforce the same
  // content-level QC as the automated SCC writer.
  validateSccContentQc
};
