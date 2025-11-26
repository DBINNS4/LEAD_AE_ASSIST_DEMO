// modules/sccEncoder.js
'use strict';

const {
  parseTime: parseTimeMs,
  formatTimecode,
  isDropFrameRate,
  secondsToFrames,
  framesToSeconds,
  framesFromTimecodeLabel,
  assertLegalDropFrameLabel
} = require('../utils/timeUtils');
// NOTE: SCC timing policy added: sccOptions.timeSource ∈ 'auto'|'start'|'df-string'
// NEW: sccOptions.allowNdf (default: false) permits 30.00 NDF SCC

// ------------------------ Small text wrappers
function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length > (maxChars || 32)) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapTextAndClamp(text, maxChars, maxLines) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const wrapped = wrapText(clean, maxChars || 32);
  if (!maxLines || wrapped.length <= maxLines) return wrapped.slice(0, maxLines || wrapped.length);

  const clamped = wrapped.slice(0, Math.max(1, maxLines - 1));
  const overflow = wrapped.slice(Math.max(1, maxLines - 1)).join(' ');
  const tail = wrapText(overflow, maxChars || 32);
  if (tail.length) clamped.push(tail[0]);
  return clamped.slice(0, maxLines);
}

// Duplicate helper for SCC redundancy
function maybeDup(word, repeat) {
  return repeat ? [word, word] : [word];
}

// Map a desired start column (0..31) to a legal 608 indent nibble (0..7)
function _colToIndentNibble(col) {
  const c = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
  return Math.min(7, Math.floor(c / 4));
}

// Pull optional placement tags like {col:12} {row:15} from the start of a line
function _pullPlacementTags(s) {
  let text = String(s || '');
  let row = null, col = null;
  // Allow multiple tags in any order at the beginning of the line
  while (true) {
    const m = text.match(/^\{\s*(row|col)\s*:\s*([0-9]{1,2})\s*\}\s*/i);
    if (!m) break;
    if (m[1].toLowerCase() === 'row') row = Number(m[2]);
    else                               col = Number(m[2]);
    text = text.slice(m[0].length);
  }
  return { text, row, col };
}

// ------------------------ Parity + sanitization (CEA-608)
const CC_ALLOWED_RE = /[A-Z0-9 !"#$%&'()*+,\-.\/?:;@]/;
const MIDROW_MAP = {
  Wh: 0x20, WhU: 0x21,
  Gr: 0x22, GrU: 0x23,
  Bl: 0x24, BlU: 0x25,
  Cy: 0x26, CyU: 0x27,
  R:  0x28, RU:  0x29,
  Y:  0x2A, YU:  0x2B,
  Ma: 0x2C, MaU: 0x2D,
  I:  0x2E // italics on; IU handled as [I, WhU]
};

function midRowWordsForToken(token, channel = 1) {
  if (token === 'IU') {
    return [
      ...midRowWordsForToken('I', channel),
      ...midRowWordsForToken('WhU', channel)
    ];
  }
  const lo = MIDROW_MAP[token];
  if (lo == null) return [];
  const hiData = (channel <= 2) ? 0x11 : 0x19; // F1 vs F2
  const [hi, loP] = ensureOddParityPair(hiData, lo & 0x7f);
  const word = ((hi << 8) | loP).toString(16).padStart(4, '0');
  return [word];
}

function setOddParity7(byte) {
  const d = byte & 0x7f;
  let bits = d;
  bits = bits - ((bits >>> 1) & 0x55);
  bits = (bits & 0x33) + ((bits >>> 2) & 0x33);
  bits = (bits + (bits >>> 4)) & 0x0f;
  const ones = bits;
  const parityBit = (ones % 2 === 0) ? 0x80 : 0x00; // make total odd
  return d | parityBit;
}
function ensureOddParityPair(a, b) {
  return [setOddParity7(a), setOddParity7(b)];
}

function sanitizeFor608(text) {
  if (!text) return '';
  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    // Normalize Windows/Mac line breaks so we can collapse reliably
    .replace(/\r\n?/g, '\n');
  let result = '';
  for (const char of normalized) {
    if (char === '\n') { result += ' '; continue; }
    // Normalize a few common typography chars to ASCII
    if (char === '–' || char === '—') { result += '-'; continue; }
    if (char === '“' || char === '”') { result += '"'; continue; }
    if (char === '’' || char === '‘') { result += '\''; continue; }
    result += CC_ALLOWED_RE.test(char) ? char : ' ';
  }
  return result.replace(/\s+/g, ' ').trim();
}

// Optional extended glyph encoder; pass table in opts.extendedGlyphMap
function _encodeExtendedGlyphsIfAny(text, channel, extendedGlyphMap) {
  if (!extendedGlyphMap) return null;
  const out = [];
  let used = false;
  for (const ch of String(text || '')) {
    const spec = extendedGlyphMap[ch];
    if (!spec) { return null; } // bail unless every char is mapped
    const hi = (channel <= 2) ? (spec.hiF1 & 0x7f) : (spec.hiF2 & 0x7f);
    const lo = spec.lo & 0x7f;
    const [pHi, pLo] = ensureOddParityPair(hi, lo);
    out.push(((pHi << 8) | pLo).toString(16).padStart(4, '0'));
    used = true;
  }
  return used ? out : null;
}

function encode608Line(line, channel = 1, extendedGlyphMap) {
  const sanitized = sanitizeFor608(line);
  if (!sanitized) {
    const extended = _encodeExtendedGlyphsIfAny(line, channel, extendedGlyphMap);
    return extended || [];
  }
  const chars = sanitized.split('');
  if (chars.length % 2 !== 0) chars.push(' ');
  const words = [];
  for (let i = 0; i < chars.length; i += 2) {
    const [hi, lo] = ensureOddParityPair(
      chars[i].charCodeAt(0),
      chars[i + 1].charCodeAt(0)
    );
    words.push(((hi << 8) | lo).toString(16).padStart(4, '0'));
  }
  return words;
}

// Encode a line that may contain {Wh}/{GrU}/.../{I}/{IU} mid-row tags
function encode608StyledLine(line, channel = 1, extendedGlyphMap) {
  const parts = String(line || '').split(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    if (i % 2 === 1) {
      out.push(...midRowWordsForToken(piece, channel));
    } else if (piece) {
      out.push(...encode608Line(piece, channel, extendedGlyphMap));
    }
  }
  return out;
}

// ------------------------ Control/PAC builders
function ctrl(suffix /* '20','ae','2f',... */, channel = 1) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  const hiData = 0x14 + (ch - 1);
  const loData = (parseInt(String(suffix), 16) & 0x7f) >>> 0;
  const [hi, lo] = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function pacForRow(rowIndex = 14, indent = 0, channel = 1, style = {}) {
  // Rows used: 12–15 (CC1 PAC bases — row 14 above bottom, row 15 bottom)
  const ROW_TO_BASE = { 12: 0x9480, 13: 0x94a0, 14: 0x94c0, 15: 0x94e0 };
  const base94 = ROW_TO_BASE[rowIndex] ?? 0x94c0;
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  const base = base94 + (ch - 1) * 0x0100;
  const nibble = Math.max(0, Math.min(7, Math.floor(indent || 0)));
  const pacIndent = (nibble << 1) & 0x0E;
  const value = base + pacIndent;
  const hiData = (value >> 8) & 0x7f;
  const loData = value & 0x7f;
  const [hi, lo] = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function _visible608Length(t) {
  const s = String(t || '').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '');
  return Math.min(32, s.length);
}
function _indentForAlignment(text, align) {
  // Force left (no nibble) unless explicitly center/right
  if (align !== 'center' && align !== 'right') return 0;
  const len = _visible608Length(text);
  const free = Math.max(0, 32 - len);
  const startCol = (align === 'center') ? Math.floor(free / 2) : free;
  const q = Math.max(0, Math.min(28, Math.floor(startCol / 4) * 4));
  return q / 4;
}

// ------------------------ Placement audit (for QC)
function computeCea608PlacementAudit(segments, {
  maxCharsPerLine = 32,
  maxLinesPerBlock = 2,
  includeSpeakerNames = false,
  sccOptions = {}
} = {}) {
  const alignment = sccOptions.alignment || 'left';
  const policy = sccOptions.rowPolicy || 'bottom2';
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];

  const out = [];
  for (const seg of (segments || [])) {
    if (!seg) { out.push(null); continue; }
    let text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) { out.push(null); continue; }
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${text}`;

    const lines = wrapTextAndClamp(text, maxCharsPerLine, maxLinesPerBlock);
    const linesAudit = [];
    lines.forEach((line, idx) => {
      const indentNibble = _indentForAlignment(line, alignment);
      const row = rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14;
      linesAudit.push({
        index: idx,
        text: line,
        row,
        indentNibble,
        columnStart: indentNibble * 4
      });
    });
    out.push({ start: seg.start, end: seg.end, timecodes: seg.timecodes, lines: linesAudit });
  }
  return out;
}

// ------------------------ Word builders (POP-ON only)
function build608WordsForPopOn(lines, alignment = 'left', opts = {}) {
  const ch = Math.max(1, Math.min(4, Number(opts.channel) || 1));
  const repeatCtrl = opts.repeatControlCodes !== false;      // default on
  const repeatPac  = opts.repeatPreambleCodes !== false;     // default on
  const words = [];
  // Optional misc preface (behind flags)
  if (opts.misc && Array.isArray(opts.misc.prefix) && opts.misc.prefix.length) {
    for (const word of opts.misc.prefix) words.push(word);
  }
  // RCL + ENM (duplicated when enabled)
  words.push(...maybeDup(ctrl('20', ch), repeatCtrl)); // RCL
  const policy = opts.rowPolicy || 'bottom2';
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];
  const placements = lines.map(line => _pullPlacementTags(line));
  const plainLines = placements.map(p => p.text);
  const nonEmpty = plainLines.filter(l => l && l.trim()).length;
  const isSingle = nonEmpty === 1;

  placements.forEach((ovr, idx) => {
    const encoded = encode608StyledLine(ovr.text, ch, opts.extendedGlyphMap);
    if (!encoded.length) return;
    // Default row: honor explicit tags; otherwise:
    //  • two-line blocks → rowPair[0], rowPair[1]
    //  • single-line blocks → bottom of the pair by default
    const rowDefault = isSingle
      ? (rowPair[1] || rowPair[0] || 15)
      : (rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14);
    const row = Number.isFinite(ovr.row) ? Math.max(12, Math.min(15, ovr.row)) : rowDefault;
    // Column selection order: explicit callback → {col:N} tag → alignment rule
    let indent = null;
    if (typeof opts.getColumnStart === 'function') {
      const col = opts.getColumnStart({ text: ovr.text, index: idx, row, lines: plainLines, channel: ch });
      if (Number.isFinite(col)) indent = _colToIndentNibble(col);
    }
    if (indent == null && Number.isFinite(ovr.col)) {
      indent = _colToIndentNibble(ovr.col);
    }
    if (indent == null) {
      indent = (alignment === 'left') ? 0 : _indentForAlignment(ovr.text, alignment);
    }
    // PAC (duplicated when enabled)
    words.push(...maybeDup(pacForRow(row, indent, ch), repeatPac));
    // Non-zero indents (center/right) require a color reset to white.
    if (indent > 0) {
      words.push(...midRowWordsForToken('Wh', ch));
    }
    words.push(...encoded);
  });

  // EOC (duplicated) + optional EDM (duplicated)
  words.push(...maybeDup(ctrl('2f', ch), repeatCtrl)); // EOC
  if (opts.edmOnEoc === true) words.push(...maybeDup(ctrl('2c', ch), repeatCtrl)); // EDM
  if (opts.padEven === true && (words.length % 2) !== 0) {
    const pad = words[words.length - 1] || ctrl('ae', ch); // duplicate EOC/ENM
    words.push(pad);
  }
  return words;
}

// ------------------------ The encoder (CEA‑608 .scc)
function generateSCC(
  segments,
  {
    fps = 29.97,
    dropFrame = true,
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    includeSpeakerNames = false,
    sccOptions = {},
    returnStats = false
  } = {}
) {
  // new: timing policy + eof placement
  const timeSource = (sccOptions && sccOptions.timeSource) || 'auto'; // 'auto'|'start'|'df-string'
  const appendEOFAt = (sccOptions && sccOptions.appendEOFAt) || 'zero'; // 'zero'|'afterLast'

  if (!Array.isArray(segments)) return 'Scenarist_SCC V1.0\n';

  const dfRateOk = isDropFrameRate(fps);
  const allowNdf = !!(sccOptions && sccOptions.allowNdf);
  const is30ish = Math.abs((Number(fps) || 0) - 30.0) < 0.05;
  const ndfOk = allowNdf && is30ish && dropFrame === false;
  if (!((dfRateOk && dropFrame === true) || ndfOk)) {
    throw new Error('SCC timing must be 29.97/59.94 DF or (opt-in) 30.00 NDF');
  }

  const header = 'Scenarist_SCC V1.0';
  const lines = [header];

  // Optional broadcaster-facing font line:
  // Scenarist_SCC V1.0
  // // FONT: Helvetica 24 px
  if (sccOptions && sccOptions.fontComment) {
    const fc = String(sccOptions.fontComment).trim();
    if (fc) {
      lines.push(`// FONT: ${fc}`);
    }
  }

  const alignment = sccOptions.alignment || 'left';
  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  // 🔒 hard-lock to pop-on for simplicity & parity with UI
  const ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));
  // Default redundancy ON unless explicitly disabled
  const repeatControlCodes  = sccOptions.repeatControlCodes !== false;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  const frame = 1 / fps;

  let lastStartSec = -Infinity;
  let lastEndSec = -Infinity;
  const metrics = { captionsCount: 0, longestLineChars: 0, durations: [], avgDurationSec: 0 };

  for (const seg of segments) {
    if (!seg) continue;
    const rawText = String(seg.text || '').replace(/\r\n?/g, '\n');
    let text = rawText.trim();
    const skipPrefix = /\{NOP\}/i.test(text);
    if (skipPrefix) {
      text = text.replace(/\{NOP\}/ig, ' ').replace(/\s+/g, ' ').trim();
    }
    // Remove leading dash bullets like "- Hello" / "— Hi" / "– Yo"
    if (sccOptions?.stripLeadingDashes) {
      text = text.replace(/^\s*[-–—]{1,2}\s+/, '');
    }
    if (!text) continue;
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${text}`;

    // IMPORTANT: preserve explicit line breaks or per-line placement tags so the
    // downstream placement parser can spot them before wrapping.
    const hasExplicit = text.includes('\n') || /\{\s*(row|col)\s*:\s*\d+\s*\}/i.test(text);
    const wrapped = hasExplicit
      ? text
          .split('\n')
          .map(s => s.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, maxLinesPerBlock)
      : wrapTextAndClamp(text, maxCharsPerLine, maxLinesPerBlock);
    if (!wrapped.length) continue;

    metrics.captionsCount += 1;
    const localMax = Math.max(...wrapped.map(_visible608Length));
    if (localMax > metrics.longestLineChars) metrics.longestLineChars = localMax;
    if (typeof seg.start === 'number' && typeof seg.end === 'number') {
      metrics.durations.push(Math.max(0, seg.end - seg.start));
    }

    let words = build608WordsForPopOn(wrapped, alignment, {
      padEven: !!sccOptions.padEven, channel: ch, rowPolicy, edmOnEoc: !!sccOptions.edmOnEoc,
      repeatControlCodes, repeatPreambleCodes, extendedGlyphMap: sccOptions.extendedGlyphMap
    });
    // Optional caption prefix words (skippable with {NOP})
    if (!skipPrefix && Array.isArray(sccOptions.prefixWords) && sccOptions.prefixWords.length) {
      words = [...sccOptions.prefixWords, ...words];
    }

    // --- choose a source label/seconds from simplified JSON
    const pickJsonLabel = (segment, dropFrameFlag, frameRate) => {
      const t = segment?.timecodes;
      if (!t) return null;
      const preferred = dropFrameFlag
        ? (t.df && t.df.start)
        : (t.ndf && t.ndf.start);
      if (typeof preferred === 'string' && preferred) return preferred;
      const msStart = t.ms?.start;
      if (Number.isFinite(msStart)) {
        return formatTimecode(msStart / 1000, dropFrameFlag, frameRate, 'colon');
      }
      return null;
    };
    const srcTc = pickJsonLabel(seg, dropFrame, fps);
    // If we're anchoring to the DF label string, reject illegal DF positions early.
    if (timeSource === 'df-string' && dropFrame && typeof srcTc === 'string' && /;/.test(srcTc)) {
      assertLegalDropFrameLabel(srcTc, fps);
    }

    let startSecRaw;
    if (timeSource === 'start' && Number.isFinite(seg.start)) {
      startSecRaw = seg.start;
    } else if (timeSource === 'df-string' && srcTc) {
      // We will echo the label directly below; still compute seconds for EOF bookkeeping
      startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
    } else {
      // 'auto' → prefer numeric start, then msStart, then parse tc string
      if (Number.isFinite(seg.start)) {
        startSecRaw = seg.start;
      } else if (Number.isFinite(seg.msStart)) {
        startSecRaw = seg.msStart / 1000;
      } else if (srcTc) {
        startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
      } else {
        startSecRaw = 0;
      }
    }

    let startSec = Number.isFinite(startSecRaw) ? startSecRaw : 0;
    let endSec = Number.isFinite(seg.end)
      ? seg.end
      : Number.isFinite(seg.msEnd)
        ? seg.msEnd / 1000
        : null;

    if (startSec <= lastEndSec) {
      startSec = lastEndSec + frame; // monotonic clamp
    }

    if (endSec == null && Number.isFinite(seg.duration)) {
      endSec = startSec + Number(seg.duration);
    } else if (endSec == null && Number.isFinite(seg.msDuration)) {
      endSec = startSec + (seg.msDuration / 1000);
    }
    if (endSec != null && endSec <= startSec) {
      endSec = startSec + frame;
    }

    lastStartSec = startSec;
    if (Number.isFinite(endSec)) {
      if (endSec > lastEndSec) lastEndSec = endSec;
    } else if (startSec > lastEndSec) {
      lastEndSec = startSec;
    }

    // Emit TC: either echo the JSON label or reformat from seconds
    const tcFromSec = formatTimecode(startSec, dropFrame, fps, 'colon');
    if (timeSource === 'df-string' && srcTc && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(srcTc)) {
      const match = srcTc.match(/^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/);
      if (match) {
        const [, h, m, s, f] = match;
        const labeledTc = `${h}:${m}:${s}${dropFrame ? ';' : ':'}${f}`;
        if (labeledTc !== tcFromSec) {
          console.warn(`[SCC] df-string mismatch @ ${labeledTc} vs ${tcFromSec}`);
        }
      }
    }
    lines.push(`${tcFromSec} ${words.join(' ')}`);
  }

  if (sccOptions && sccOptions.appendEOF) {
    const op = (sccOptions.eofOp === 'rdc') ? '28' : '2c'; // RDC or EDM
    const eof = ctrl(op, ch);
    let eofSec = 0;
    if (appendEOFAt === 'afterLast') {
      // last visible activity + small safety bump
      const minTail = (lastStartSec > -1) ? lastStartSec + (1 / fps) : 0;
      eofSec = Math.max(minTail, (Number.isFinite(lastEndSec) ? lastEndSec : 0) + (2 / fps));
    }
    const eofTc = formatTimecode(eofSec, dropFrame, fps, 'colon');
    lines.push(`${eofTc} ${eof} ${eof}`);
  }

  const text = lines.join('\n') + '\n';
  if (metrics.durations.length) {
    metrics.avgDurationSec = metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length;
  }
  return returnStats ? { scc: text, stats: {
    captionsCount: metrics.captionsCount,
    longestLineChars: metrics.longestLineChars,
    avgDurationSec: metrics.avgDurationSec
  } } : text;
}

// ------------------------ Verifier (odd parity + token sanity)
function _stripSccComments(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const line of s.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    if (/^Scenarist_SCC\b/i.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out.join('\n');
}
const _isTimecodeToken = tok => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tok);
const _isHexWord = tok => /^[0-9a-fA-F]{4}$/.test(tok);
function _onesCount(b) { let x = b & 0xff, c = 0; for (let i=0;i<8;i++){ c += x & 1; x >>= 1; } return c; }
function _isOddParity(byte) { return (_onesCount(byte) % 2) === 1; }

function verifySCC(fileOrText, { maxErrors = 50 } = {}) {
  const fs = require('fs');
  const path = require('path');

  let source = fileOrText || '';
  let filePath = null;
  try {
    if (typeof source === 'string' && fs.existsSync(source)) {
      filePath = path.resolve(source);
      source = fs.readFileSync(filePath, 'utf8');
    }
  } catch { /* fall through */ }

  const text = _stripSccComments(source);
  const lines = text.split('\n');

  let totalWords = 0, checkedBytes = 0, invalidTokens = 0, parityErrors = 0;
  const errors = [];
  let parsedLines = 0;

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    if (!tokens.length) return;

    const timecode = tokens[0];
    if (!_isTimecodeToken(timecode)) return;

    parsedLines += 1;
    const words = tokens.slice(1);

    for (let w = 0; w < words.length; w++) {
      const tok = words[w];
      if (!_isHexWord(tok)) { invalidTokens += 1; continue; }
      const word = parseInt(tok, 16) & 0xffff;
      const hi = (word >> 8) & 0xff;
      const lo = word & 0xff;

      const hiOk = _isOddParity(hi) && setOddParity7(hi & 0x7f) === hi;
      const loOk = _isOddParity(lo) && setOddParity7(lo & 0x7f) === lo;

      totalWords += 1;
      checkedBytes += 2;

      if (!hiOk || !loOk) {
        parityErrors += (!hiOk ? 1 : 0) + (!loOk ? 1 : 0);
        if (errors.length < maxErrors) {
          if (!hiOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'HI', byte: hi });
          if (!loOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'LO', byte: lo });
        }
      }
    }
  });

  const summary =
    parityErrors === 0
      ? `OK — ${totalWords} words (${checkedBytes} bytes) • 0 parity errors • ${invalidTokens} invalid tokens`
      : `FAIL — ${totalWords} words (${checkedBytes} bytes) • ${parityErrors} parity error(s) • ${invalidTokens} invalid tokens`;

  return {
    ok: parityErrors === 0,
    file: filePath || undefined,
    totalLines: lines.length,
    parsedLines, totalWords, checkedBytes,
    invalidTokens, parityErrors, errors, summary
  };
}

// --- MacCaption (.mcc) time code rate label (importer-friendly enumerations)
function _timeCodeRateLabel(fps = 29.97, dropFrame = true) {
  const f = Number(fps);
  // Canonical DF labels — avoids importers that misread 30DF/60DF as 30/60
  if (dropFrame && Math.abs(f - 29.97) < 0.05) return '29.97DF';
  if (dropFrame && Math.abs(f - 59.94) < 0.10) return '59.94DF';
  // Exact well-known NDF labels
  if (Math.abs(f - 23.976) < 0.06) return '23.976';
  if (Math.abs(f - 24.000) < 0.06) return '24';
  if (Math.abs(f - 25.000) < 0.06) return '25';
  if (Math.abs(f - 29.970) < 0.06) return '29.97';
  if (Math.abs(f - 30.000) < 0.06) return '30';
  if (Math.abs(f - 50.000) < 0.06) return '50';
  if (Math.abs(f - 59.940) < 0.06) return '59.94';
  if (Math.abs(f - 60.000) < 0.06) return '60';
  // Fallback: print the numeric fps
  return String(fps);
}

function _frameRateCode(fps) {
  // Map arbitrary fps to the nearest legal CDP frame-rate code (no 29.97 default).
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 4; // safe default if caller supplied nonsense
  const table = [
    { code: 1, fps: 23.976 },
    { code: 2, fps: 24.000 },
    { code: 3, fps: 25.000 },
    { code: 4, fps: 29.970 },
    { code: 5, fps: 30.000 },
    { code: 6, fps: 50.000 },
    { code: 7, fps: 59.940 },
    { code: 8, fps: 60.000 }
  ];
  let best = table[0], err = Math.abs(f - table[0].fps);
  for (let i = 1; i < table.length; i++) {
    const e = Math.abs(f - table[i].fps);
    if (e < err) { err = e; best = table[i]; }
  }
  return best.code;
}

function _bcd(n) {
  return ((Math.floor(n / 10) & 0x0f) << 4) | (n % 10);
}

function _encodeSmpte12M(seconds, fps, dropFrame) {
  const tc = formatTimecode(seconds, dropFrame, fps, 'colon');
  const match = /^([0-9]{2}):([0-9]{2}):([0-9]{2})[:;]([0-9]{2})$/.exec(tc) || [];
  const H = Number(match[1] || 0);
  const M = Number(match[2] || 0);
  const S = Number(match[3] || 0);
  const F = Number(match[4] || 0);
  const frameByte = (_bcd(F) & 0x3f) | (dropFrame ? 0x40 : 0x00);
  return [0x71, frameByte & 0xff, _bcd(S), _bcd(M), _bcd(H), 0x00];
}

function _mccHeader({ fps, dropFrame, fontComment }) {
  // Slightly fuller header improves importer compatibility
  const rate = _timeCodeRateLabel(fps, dropFrame);
  const headerLines = [
    'File Format=MacCaption_MCC V1.0',
    `Time Code Rate=${rate}`,
    `Drop Frame=${dropFrame ? 'True' : 'False'}`,
    'Caption Service=1',
    'Language=eng'
  ];
  if (fontComment) {
    headerLines.push(`Font=${fontComment}`);
  }
  headerLines.push('');
  return headerLines.join('\r\n') + '\r\n';
}

// Wrap a CDP (0x96 0x69 … 0x74 … + CDP checksum) in a SMPTE-291 ANC packet
// DID=0x61, SDID=0x01, DC=<len>, then UDW bytes (CDP), then 8-bit ANC checksum
function _wrapANC291(userDataBytes) {
  const DID = 0x61, SDID = 0x01;
  const dc  = userDataBytes.length & 0xff;
  const payload = [DID, SDID, dc, ...userDataBytes];
  const sum = payload.reduce((a, b) => (a + (b & 0xff)) & 0xff, 0);
  const cks = (256 - sum) & 0xff;
  return Uint8Array.from([...payload, cks]);
}

function _compressMccLineHex(hexBytesUpperSpaced) {
  // Input: "61 01 2A 96 69 ..." (UPPER hex with spaces)
  const tokens = hexBytesUpperSpaced.trim().split(/\s+/).map(t => t.toUpperCase());

  const out = [];
  for (let i = 0; i < tokens.length; ) {
    // Multi-byte patterns first
    const next2 = tokens.slice(i, i + 2).join(' ');
    const next3 = tokens.slice(i, i + 3).join(' ');

    // Telestream common macros (observed in the wild)
    if (next2 === '61 01') { out.push('T'); i += 2; continue; }      // ANC DID+SDID
    if (next2 === '96 69') { out.push('S'); i += 2; continue; }      // CDP id

    if (next3 === 'FB 80 80') { out.push('P'); i += 3; continue; }   // 608 F2 blank
    if (next3 === 'FC 80 80') { out.push('Q'); i += 3; continue; }   // 608 F1 blank
    if (next3 === 'FD 80 80') { out.push('R'); i += 3; continue; }   // 608 F2 blank (alt)

    // Run-length for FA 00 00 → G..O (1..9). Advance greedily.
    if (tokens[i] === 'FA' && tokens[i + 1] === '00' && tokens[i + 2] === '00') {
      let n = 0;
      while (tokens[i + 3 * n] === 'FA' &&
             tokens[i + 3 * n + 1] === '00' &&
             tokens[i + 3 * n + 2] === '00' &&
             n < 9) n++;
      out.push(String.fromCharCode('G'.charCodeAt(0) + (n - 1))); // G..O
      i += 3 * n;
      continue;
    }

    // Single 00 → Z
    if (tokens[i] === '00') { out.push('Z'); i += 1; continue; }

    // Default: keep hex byte
    out.push(tokens[i]);
    i += 1;
  }
  return out.join(' ');
}

function generateMCC(
  segments,
  {
    fps = 29.97,
    dropFrame: dropFrameOption = true,
    maxCharsPerLine = 42,
    maxLinesPerBlock = 2,
    includeSpeakerNames = false,
    sccOptions = {}
  } = {}
) {
  // _cea708 is guaranteed by the static require below.
  fps = Number(fps) || 29.97;
  // Prefix speakers when requested (parity with SCC path)
  const segs = Array.isArray(segments) ? segments.map(s => {
    const text = includeSpeakerNames && s?.speaker ? `${s.speaker}: ${s.text || ''}` : (s?.text || '');
    return { ...s, text };
  }) : [];

  const isDfRate = isDropFrameRate(fps);
  const dropFrame = !!dropFrameOption && isDfRate;
  const timeSource = sccOptions.timeSource || 'df-string'; // 'df-string'|'start'|'auto'
  const align = sccOptions.alignment || 'left';
  const ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));
  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  const repeatControlCodes = sccOptions.repeatControlCodes !== false;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  const include608 = (sccOptions.mccInclude608 !== false); // default: include 608 CC1
  const useTelestreamCompression = sccOptions?.mccCompress === true;
  const lines = [];
  const header = _mccHeader({
    fps,
    dropFrame,
    fontComment: sccOptions.fontComment
  });
  lines.push(header);

  const frameRateCode = _frameRateCode(fps);
  let frameIndex = 0;
  let cc608Queue = []; // remaining 608 words to mux into upcoming frames

  const secondsForFrame = (frame) => framesToSeconds(frame, fps);

  const buildTimecodeBlock = (frame) => _encodeSmpte12M(secondsForFrame(frame), fps, dropFrame);

  const writeCdpLine = (frame, dtvccChunk) => {
    const tcBlock = buildTimecodeBlock(frame);
    // Capacity for 608 in this frame = 31 - 708 triplets
    const n708Triplets = Math.ceil((dtvccChunk.length || 0) / 2);
    const roomFor608 = Math.max(0, 31 - n708Triplets);
    const cc608Now = cc608Queue.splice(0, roomFor608);
    const cdp = _cea708.buildCdpForDtvcc({
      dtvccBytes: dtvccChunk,
      frameRateCode,
      sequenceCounter: frame & 0xffff,
      timecode: tcBlock,
      cc608WordsF1: cc608Now
    });
    const anc = _wrapANC291(Array.from(cdp));
    const tcRaw = formatTimecode(secondsForFrame(frame), dropFrame, fps, 'colon');
    const tc = tcRaw;
    const hex = Array.from(anc).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const payload = useTelestreamCompression ? _compressMccLineHex(hex) : hex;
    lines.push(`${tc}\t${payload}\r\n`);
  };

  const writeEmptyCdp = (frame) => writeCdpLine(frame, []);

  const startSecondsForSegment = (seg) => {
    if (!seg) return 0;
    if (timeSource === 'df-string' && seg.timecodes) {
      const pref = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      if (pref) {
        if (dropFrame && /;/.test(pref)) assertLegalDropFrameLabel(pref, fps);
        return parseTimeMs(pref, fps, null) / 1000;
      }
    }
    if (Number.isFinite(seg.start)) return seg.start;
    if (Number.isFinite(seg.msStart)) return seg.msStart / 1000;
    const fallback = seg.timecodes?.df?.start || seg.timecodes?.ndf?.start;
    return fallback ? (parseTimeMs(fallback, fps, null) / 1000) : 0;
  };

  const endSecondsForSegment = (seg, startSeconds) => {
    if (!seg) return startSeconds;
    if (Number.isFinite(seg.end)) return seg.end;
    if (Number.isFinite(seg.msEnd)) return seg.msEnd / 1000;
    let label = null;
    if (seg.timecodes) {
      label = (timeSource === 'df-string')
        ? (dropFrame
          ? (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end)
          : (seg.timecodes?.ndf?.end || seg.timecodes?.df?.end))
        : (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end);
    }
    return label ? (parseTimeMs(label, fps, null) / 1000) : startSeconds;
  };

  for (const seg of segs) {
    if (!seg || !seg.text || !seg.text.trim()) continue;
    const wrapped = _wrapLines608Compat(seg.text, maxCharsPerLine, maxLinesPerBlock);
    if (!wrapped.length) continue;

    const colCount = Math.min(42, Math.max(...wrapped.map(l => Math.min(42, l.length || 0))) || 32);
    const svcBytes = _cea708.buildServiceBytesForLines(wrapped, { justify: align, colCount });
    const svcBlocks = _cea708.chunkToServiceBlocks(svcBytes, 1);
    const dtvccPackets = _cea708.packDTVCC(svcBlocks);

    // Build a matching 608 CC1 payload (pop-on) and queue it for this segment
    cc608Queue = [];
    if (include608 && ch === 1) {
      const words608 = build608WordsForPopOn(wrapped, align, {
        padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
        edmOnEoc: !!sccOptions.edmOnEoc,
        repeatControlCodes, repeatPreambleCodes, extendedGlyphMap: sccOptions.extendedGlyphMap
      });
      cc608Queue = words608.map(w => parseInt(w, 16) & 0xFFFF);
    }

    const startSeconds = startSecondsForSegment(seg);
    const endSeconds = endSecondsForSegment(seg, startSeconds);

    let startFrame;
    let endFrame;
    if (timeSource === 'df-string' && seg?.timecodes) {
      const labelStart = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      const labelEnd = dropFrame
        ? (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end)
        : (seg.timecodes?.ndf?.end || seg.timecodes?.df?.end);
      const hasStartLabel = typeof labelStart === 'string' && labelStart.length > 0;
      const hasEndLabel = typeof labelEnd === 'string' && labelEnd.length > 0;
      if (dropFrame) {
        if (hasStartLabel && /;/.test(labelStart)) assertLegalDropFrameLabel(labelStart, fps);
        if (hasEndLabel && /;/.test(labelEnd))   assertLegalDropFrameLabel(labelEnd,   fps);
      }
      startFrame = hasStartLabel
        ? Math.max(0, framesFromTimecodeLabel(labelStart, fps))
        : Math.max(0, secondsToFrames(startSeconds, fps));
      const endFrameLabel = hasEndLabel ? labelEnd : (hasStartLabel ? labelStart : null);
      endFrame = endFrameLabel
        ? Math.max(startFrame, framesFromTimecodeLabel(endFrameLabel, fps))
        : Math.max(startFrame, secondsToFrames(endSeconds, fps));
    } else {
      startFrame = Math.max(0, secondsToFrames(startSeconds, fps));
      endFrame = Math.max(startFrame, secondsToFrames(endSeconds, fps));
    }
    const targetStartFrame = Math.max(frameIndex, startFrame);

    while (frameIndex < targetStartFrame) {
      // Allow empty frames to carry pending 608 words so we don't drop any
      writeEmptyCdp(frameIndex++);
    }

    if (dtvccPackets.length) {
      // One DTVCC packet per CDP line; never break inside a packet.
      // packDTVCC() now guarantees payload ≤ 62 bytes (31 triplets).
      for (const pkt of dtvccPackets) {
        const payload = Array.from(pkt);
        if (Math.ceil(payload.length / 2) > 31) {
          let cursor = 0;
          const MAX = 62;
          while (cursor < payload.length) {
            writeCdpLine(frameIndex++, payload.slice(cursor, cursor + MAX));
            cursor += MAX;
          }
        } else {
          writeCdpLine(frameIndex++, payload);
        }
      }
    }

    const targetEndFrame = Math.max(endFrame, frameIndex);
    while (frameIndex < targetEndFrame) {
      writeEmptyCdp(frameIndex++);
    }
  }

  return lines.join('');
}

module.exports = {
  // Builders + QC
  wrapTextAndClamp,
  encode608Line, encode608StyledLine, pacForRow, ctrl,
  computeCea608PlacementAudit,
  // Encoders
  generateSCC,
  // Verifier
  verifySCC,
  // CTA-708 / MCC
  generateDTVCC, verifyDTVCC,
  generateMCC
};

// ------------------------ CTA-708 glue (service blocks + DTVCC)
// Use a static require so bundlers (esbuild/webpack) don't drop the module.
const _cea708 = require('./cea708Encoder');

function _wrapLines608Compat(text, maxCharsPerLine, maxLinesPerBlock) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return wrapTextAndClamp(clean, maxCharsPerLine || 32, maxLinesPerBlock || 2);
}

function generateDTVCC(
  segments,
  {
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    sccOptions = {},
    returnPackets = true   // true: return array of packets per segment; false: return Buffer of all packets
  } = {}
) {
  // _cea708 is guaranteed by the static require above.
  if (!Array.isArray(segments) || !segments.length) return returnPackets ? [] : Buffer.alloc(0);

  const align = sccOptions.alignment || 'left';
  const packetsOut = [];

  for (const seg of segments) {
    if (!seg) continue;
    let text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const lines = _wrapLines608Compat(text, maxCharsPerLine, maxLinesPerBlock);
    if (!lines.length) continue;

    const colCount = Math.min(42, Math.max(...lines.map(l => Math.min(42, l.length || 0))) || 32);
    const svcBytes = _cea708.buildServiceBytesForLines(lines, { justify: align, colCount });
    const svcBlocks = _cea708.chunkToServiceBlocks(svcBytes, /* service 1 */ 1);
    const dtvccPackets = _cea708.packDTVCC(svcBlocks);

    if (returnPackets) {
      packetsOut.push({ start: seg.start, end: seg.end, packets: dtvccPackets });
    } else {
      packetsOut.push(...dtvccPackets);
    }
  }

  if (returnPackets) return packetsOut;
  // Concatenate raw packets into a single Buffer
  const flat = packetsOut.reduce((acc, arr) => acc.concat(Array.from(arr)), []);
  return Buffer.from(flat);
}

// Pragmatic verifier: sizes/headers and command arities we generate
function verifyDTVCC(input, { maxErrors = 100 } = {}) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Array.isArray(input)
      ? Buffer.from(input.flat ? input.flat() : input)
      : Buffer.from(input || []);

  const errors = [];
  let pos = 0;
  let packets = 0, serviceBlocks = 0;

  function err(msg, at) { if (errors.length < maxErrors) errors.push({ pos: at ?? pos, msg }); }

  while (pos < buf.length) {
    // DTVCC packet header: [ seq(2) | packet_size(6) ]
    const header = buf[pos++];
    if (header == null) { err('EOF before DTVCC header'); break; }
    const pktSize = header & 0x3f;
    const seq = (header >> 6) & 0x03;
    if (pktSize === 0) { err('Packet size = 0', pos - 1); break; }
    if ((pos + pktSize) > buf.length) { err('Packet size exceeds buffer', pos - 1); break; }
    const end = pos + pktSize;
    packets++;

    // Parse service blocks inside this payload
    while (pos < end) {
      const sbHdr = buf[pos++];
      if (sbHdr == null) { err('EOF in service block header', pos - 1); break; }
      let service = (sbHdr & 0xe0) >> 5;
      let blockLen = sbHdr & 0x1f;
      if (service === 7) { // extended
        const ext = buf[pos++];
        if (ext == null) { err('EOF in extended service number', pos - 1); break; }
        service = 7 + (ext & 0x3f);
      }
      if ((pos + blockLen) > end) { err('Service block length exceeds packet', pos - 1); break; }

      // Shallow command scan (only the ones we emit)
      const start = pos, stop = pos + blockLen;
      while (pos < stop) {
        const b = buf[pos++];
        if (b == null) { err('EOF inside service block', pos - 1); break; }
        if (b === 0x03 || b === 0x0d) continue; // ETX/CR
        if (b >= 0x20 && b <= 0x7e) continue;   // G0 text
        // Commands we emit and their arg sizes:
        if (b >= 0x80 && b <= 0x87) { /* CWx */ continue; }
        else if (b === 0x88 || b === 0x89 || b === 0x8a || b === 0x8c) { // CLW/DSW/HDW/DLW +1
          if ((pos + 1) > stop) { err('Truncated window-bitmap param', pos - 1); break; }
          pos += 1;
        } else if (b === 0x92) { // SPL +2
          if ((pos + 2) > stop) { err('Truncated SPL params', pos - 1); break; }
          pos += 2;
        } else if (b === 0x97) { // SWA +4
          if ((pos + 4) > stop) { err('Truncated SWA params', pos - 1); break; }
          pos += 4;
        } else if (b >= 0x98 && b <= 0x9f) { // DFx +6
          if ((pos + 6) > stop) { err('Truncated DFx params', pos - 1); break; }
          pos += 6;
        } else {
          err(`Unexpected/unsupported byte 0x${b.toString(16)}`, pos - 1);
          // bail to avoid loops
          break;
        }
      }
      serviceBlocks++;
    }
    pos = end;
  }

  return {
    ok: errors.length === 0,
    packets, serviceBlocks, errors,
    summary: errors.length
      ? `FAIL — ${packets} packet(s), ${serviceBlocks} service block(s), ${errors.length} error(s)`
      : `OK — ${packets} packet(s), ${serviceBlocks} service block(s) • 0 errors`
  };
}
