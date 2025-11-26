require('dotenv').config();

const ProgressManager = require('../utils/progressManager');
// (rest of imports unchanged)

const transcribeEngine = require('../ai/transcribeEngine');
const scc = require('./sccEncoder');
const { runEngine, cancelCurrentProcess } = transcribeEngine;
const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  sendLogMessage,
  archiveLog,
  sendComparisonLog,
  sendResolutionLog
} = require('./logUtils');
const { cancelIngest, createCancelToken } = require('./cancelUtils');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const { ffmpegPath } = require('../utils/ffmpeg');
const {
  normalizeTranscriptionStructure,
  segmentsToCueList,
  cueListToSegments
} = require('../ai/normalizeTranscription');
const { formatTimecode, isDropFrameRate } = require('../utils/timeUtils');
const { parseSrtFile, parseVttFile, parseSccFile } = require('../ai/subtitleParsers');
const {
  writeCorrectedJson,
  writeCorrectedSRT,
  writeCorrectedVTT
} = require('../ai/outputWriters');

function runFFmpeg(args) {
  // Sanitize args: drop libx-only or legacy flags your ffmpeg build doesn't support
  const safeArgs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    // These options are valid for libx264/libx265/etc., but not for h264_videotoolbox/prores_ks/mpeg4
    if (flag === '-preset' || flag === '-tune' || flag === '-crf') {
      i++;
      continue;
    }
    safeArgs.push(flag);
  }
  if (process.env.DEBUG_LOGS) {
    console.log('🚀 FFmpeg args:', safeArgs.join(' '));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, safeArgs);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`FFmpeg exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function sendTranscribeLog(msg, isError = false, detail = '', fileId = '') {
  sendLogMessage('transcribe', msg, detail, isError, fileId);
}

const subtitleSessions = new Map();
let lastSubtitleContext = null;

function parseJsonSubtitle(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const fps = data.system?.fps || data.metadata?.fps || lastSubtitleContext?.fps || 30;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = dfCapable && Boolean(
    data.system?.dropFrame || data.metadata?.dropFrame || lastSubtitleContext?.dropFrame
  );
  let segments = Array.isArray(data.segments) ? data.segments : [];

  if (!segments.length && Array.isArray(data.finalWords)) {
    segments = data.finalWords.map((word, idx) => ({
      id: word.id ?? idx,
      start: typeof word.start === 'number' ? word.start : (word.offset ?? 0),
      end: typeof word.end === 'number' ? word.end : (word.offsetEnd ?? word.offset ?? 0),
      text: word.text || word.word || '',
      speaker: word.speaker || null
    }));
  }

  if (!segments.length && Array.isArray(data.transcription)) {
    const clone = JSON.parse(JSON.stringify(data));
    normalizeTranscriptionStructure(clone, fps, dropFrame);
    segments = clone.segments || [];
  }

  if (!segments.length && Array.isArray(data.cues)) {
    segments = data.cues.map((cue, idx) => ({
      id: cue.id ?? idx,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      speaker: cue.speaker || null,
      sccPlacement: cue.sccPlacement || null
    }));
  }

  const cues = segmentsToCueList(segments, fps, dropFrame);
  const mediaPath =
    data.mediaPath ||
    data.inputPath ||
    data.sourceFile ||
    data.source ||
    lastSubtitleContext?.mediaPath ||
    null;

  return {
    sourcePath: filePath,
    displayName: data.displayName || path.basename(filePath),
    fps,
    dropFrame,
    startTc: data.metadata?.startTimecode || data.startTc || null,
    mediaPath,
    cues,
    originalJson: data
  };
}

function storeSession(doc, sessionId) {
  const id = sessionId || randomUUID();
  const existing = subtitleSessions.get(id) || {};
  const next = { ...existing, sessionId: id };
  if (doc && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (value !== undefined) {
        next[key] = value;
      }
    }
  }
  subtitleSessions.set(id, next);
  return next;
}

async function streamTranscript(filePath, engine, language, sendUpdate) {
  try {
    if (engine === 'whisper') {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const resp = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language
      });
      if (resp.segments) {
        for (const segment of resp.segments) {
          const line = `[${segment.start.toFixed(2)} --> ${segment.end.toFixed(2)}] ${segment.text}`;
          sendUpdate(line);
        }
      }
    }
  } catch (err) {
    sendUpdate(`❌ ${err.message}`);
  }
}

async function runTranscribe(config) {
  if (!config.signal) config.signal = createCancelToken();
  if (config.diarization) config.localSpeakerDetection = true;
  const wantsTranslate = !!config.translation?.enabled;
  config.whisperTask = wantsTranslate ? 'translate' : 'transcribe';
  if (!config.diarization && (config.localSpeakerDetection || config.includeSpeakerNames || config.detectSpeakers)) {
    config.diarization = true;
  }
  const sanitized = JSON.parse(JSON.stringify(config));
  if (sanitized.apiKey) {
    sanitized.apiKey = sanitized.apiKey.slice(0, 4) + '...';
  }
  if (process.env.DEBUG_LOGS) {
    console.log('📝 Received transcription config:', JSON.stringify(sanitized, null, 2));
  }
  
  const logs = [];
  const startTime = Date.now();

  const progressManager = new ProgressManager(0, 250, 'files');
  progressManager.setTotalFiles(config.files.length);

  progressManager.on('stream-progress', payload => {
    const window = require('electron').BrowserWindow.getFocusedWindow();
    if (window && !window.isDestroyed()) {
      // Legacy 'transcribe-progress' event removed
    }
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: payload.file,
        percent: payload.overall,
        eta: payload.eta,
        completed: payload.completedFiles,
        total: payload.totalFiles,
        streamId: payload.streamId
      });
    }
  });

  progressManager.on('overall-progress', payload => {
    const window = require('electron').BrowserWindow.getFocusedWindow();
    if (window && !window.isDestroyed()) {
      // Legacy 'transcribe-progress' event removed
    }
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: '',
        percent: payload.overall,
        eta: payload.eta,
        completed: payload.completedFiles,
        total: payload.totalFiles
      });
    }
  });

  progressManager.on('file-status', payload => {
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: payload.file,
        status: { ...payload.statusMap },
        streamId: payload.streamId
      });
    }
  });

  // Basic validation
  const missing = [];
  for (const f of config.files) {
    try {
      await fs.promises.access(f);
    } catch {
      missing.push(f);
    }
  }
  if (missing.length) {
    return { success: false, log: missing.map(f => `❌ File not found: ${f}`) };
  }
  if (!Object.values(config.outputFormats || {}).some(v => v)) {
    return { success: false, log: ['❌ No output format selected.'] };
  }
  if (!config.outputPath) {
    return { success: false, log: ['❌ Output path missing or invalid.'] };
  }
  try {
    await fs.promises.access(config.outputPath);
  } catch {
    return { success: false, log: ['❌ Output path missing or invalid.'] };
  }

  const primaryFile = Array.isArray(config.files) && config.files.length
    ? config.files[0]
    : null;
  const baseName = primaryFile
    ? path.basename(primaryFile, path.extname(primaryFile))
    : (config.fileNameTemplate || 'subtitle');
  // Normalize fps like "29.97DF" → 29.97 and set DF if present
  const co = String(config.fpsOverride ?? '').trim();
  const m1 = co ? co.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/) : null;
  if (m1) {
    config.fpsOverride = parseFloat(m1[1]);
    if (m1[2]) config.dropFrame = true;
  }
  const cf = String(config.fps ?? '').trim();
  const m2 = cf ? cf.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/) : null;
  if (m2) {
    config.fps = parseFloat(m2[1]);
    if (m2[2] && (config.dropFrame == null)) config.dropFrame = true;
  }
  const parsedFps = typeof config.fpsOverride === 'number'
    ? config.fpsOverride
    : parseFloat(config.fpsOverride);
  lastSubtitleContext = {
    outputPath: config.outputPath,
    mediaPath: primaryFile,
    baseName,
    fps: Number.isFinite(parsedFps) ? parsedFps : config.fps || 30,
    dropFrame: !!config.dropFrame,
    startTc: config.startTC || null
  };

  // Defer DF validation until the writer stage when the actual FPS is known.
  // Writers already enforce DF-specific constraints (e.g., SCC requires 29.97 DF).

  if (!config.logPath) {
    const supportBase2 = path.join(os.homedir(), 'Library', 'Application Support');
    const appRoot2 = process.env.USER_DATA_PATH || path.join(supportBase2, 'LeadAEAssist');
    config.logPath = path.join(appRoot2, 'logs', 'transcribe');
  }
  try {
    fs.mkdirSync(config.logPath, { recursive: true });
  } catch (err) {
    const errMsg = `❌ Failed to create log directory: ${err.message}`;
    sendTranscribeLog(errMsg, true);
    return { success: false, log: [errMsg] };
  }
  
  let successCount = 0;
  let failCount = 0;

  for (const [index, file] of config.files.entries()) {
    if (config.signal?.aborted) break;
    let tempWav = null;
    const statusMap = {
      'engine-whisperx': false,
      'engine-cpp': false,
      comparison: false,
      reconcile: false
    };

    const emitStatus = () => {
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'transcribe',
          file,
          status: { ...statusMap },
          streamId: index
        });
      }
    };

    try {
      progressManager.startFile(index, file, 1);
      emitStatus();
      sendTranscribeLog(`🎬 Starting: ${file}`);

      let inputFile = file;
      const ext = path.extname(file).toLowerCase();
      const MAX_SIZE = 26214400;
      const isAudioCompatible = [
        '.wav', '.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.webm', '.mpga', '.mpeg'
      ].includes(ext);

      try {
        const stats = await fs.promises.stat(file);
        if (isAudioCompatible && stats.size <= MAX_SIZE) {
          sendTranscribeLog(`✅ File already compatible and under size limit`);
          inputFile = file;
        } else {
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
          const jobTag = `job-${config.jobId || Date.now()}`;
          const tempDir = path.join(appRoot, 'temp', 'transcribe', jobTag);
          await fs.promises.mkdir(tempDir, { recursive: true });
          const base = path.basename(file, ext);
          tempWav = path.join(tempDir, `${base}_leadai.wav`);
          try {
            await fs.promises.unlink(tempWav);
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }

          sendTranscribeLog(`🔁 Converting ${file} → ${tempWav}`);

          try {
            await runFFmpeg([
              '-i', file,
              '-vn',
              '-ar', '16000',
              '-ac', '1',
              '-c:a', 'pcm_s16le',
              tempWav
            ]);
          } catch (err) {
            console.error(`❌ FFmpeg failed: ${err.message}`);
            if (err.stdout) console.error(`stdout: ${err.stdout}`);
            if (err.stderr) console.error(`stderr: ${err.stderr}`);
            throw err;
          }

          const outStats = await fs.promises.stat(tempWav);
          if (outStats.size > MAX_SIZE) {
            throw new Error(`❌ WAV still too large: ${(outStats.size / 1024 / 1024).toFixed(2)} MB`);
          }

          inputFile = tempWav;
          sendTranscribeLog(`✅ Converted to WAV for transcription (${(outStats.size / 1024 / 1024).toFixed(2)} MB)`);
        }      
      } catch (err) {
        const errMsg = `❌ FFmpeg conversion failed: ${err.message}`;
        sendTranscribeLog(errMsg, true);
        logs.push(errMsg);
        failCount++;
        emitStatus();
        continue;
      }

      const engines = config.dualEngine ? [config.engine, 'whisperx'] : [config.engine];
      sendTranscribeLog(`⚙️ Engines: ${engines.join(', ')}`);
      for (const e of engines) {
        const engineLogs = await runEngine(e, inputFile, config);
        engineLogs.forEach(l => sendTranscribeLog(l));
        logs.push(...engineLogs);
        if (e === 'whisperx') statusMap['engine-whisperx'] = true;
        else statusMap['engine-cpp'] = true;
        emitStatus();
      }

      statusMap.comparison = true;
      emitStatus();
      sendComparisonLog('✅ Engine comparison complete');

      statusMap.reconcile = true;
      emitStatus();
      sendResolutionLog('✅ Reconciliation complete');

      successCount++;
      progressManager.finishFile(index, statusMap);
    } catch (err) {
      const errMsg = `❌ Error for ${file}: ${err.message}`;
      sendTranscribeLog(errMsg, true);
      logs.push(errMsg);
      if (config.allowFallback) {
        const fallback = config.engine === 'lead' ? 'whisper' : 'lead';
        try {
          const fallbackLogs = await runEngine(fallback, file, config);
          sendTranscribeLog(`ℹ️ Fallback to ${fallback}`);
          fallbackLogs.forEach(l => sendTranscribeLog(l));
          logs.push(`ℹ️ Fallback to ${fallback}`);
          logs.push(...fallbackLogs);
          if (fallback === 'whisperx') statusMap['engine-whisperx'] = true;
          else statusMap['engine-cpp'] = true;
          emitStatus();
          successCount++;
          progressManager.finishFile(index, statusMap);
          continue;
        } catch (e) {
          const fmsg = `❌ Fallback failed: ${e.message}`;
          sendTranscribeLog(fmsg, true);
          logs.push(fmsg);
        }
      }
      failCount++;
      progressManager.finishFile(index, statusMap);
    } finally {
      if (tempWav) {
        try {
          await fs.promises.unlink(tempWav);
        } catch (e) {
          if (e.code !== 'ENOENT') {
            console.error(`❌ Failed to cleanup temp file: ${e.message}`);
          }
        }
      }
    }
  }
  
  if (config.signal?.aborted) logs.unshift('🚫 Transcription cancelled by user.');
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  logs.push(`📄 Files processed: ${successCount + failCount} of ${config.files.length}`);
  logs.push(`✅ Success: ${successCount}`);
  logs.push(`❌ Failed: ${failCount}`);
  logs.push(`⏱️ Total time: ${totalTime}s`);
  sendTranscribeLog(`⏱️ Total time: ${totalTime}s`);

  const archivePath = archiveLog(logs, 'transcribe');
  logs.push(`📂 Log archived to: ${archivePath}`);

  if (progressManager?.dispose) progressManager.dispose();
  const wasCanceled = config.signal?.aborted;
  return {
    success: !wasCanceled && failCount === 0,
    cancelled: wasCanceled,
    log: logs
  };
}

function cancelTranscribe(id) {
  cancelCurrentProcess();
  cancelIngest(id);
  if (process.env.DEBUG_LOGS) {
    console.log('🛑 Transcription cancel requested');
  }
}

async function openSubtitleDocument(payload = {}) {
  const { sourcePath, mediaPath, sessionId } = payload;
  let resolvedPath = sourcePath;
  if (!resolvedPath && sessionId) {
    resolvedPath = subtitleSessions.get(sessionId)?.sourcePath;
  }
  if (!resolvedPath) {
    throw new Error('No subtitle path provided');
  }

  let doc;
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext === '.srt') {
    doc = parseSrtFile(resolvedPath, {
      fps: lastSubtitleContext?.fps || 30,
      dropFrame: !!lastSubtitleContext?.dropFrame,
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else if (ext === '.vtt') {
    doc = parseVttFile(resolvedPath, {
      fps: lastSubtitleContext?.fps || 30,
      dropFrame: !!lastSubtitleContext?.dropFrame,
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else if (ext === '.scc') {
    // SCC is 608; assume drop-frame 29.97 unless the file indicates otherwise
    doc = parseSccFile(resolvedPath, {
      fps: lastSubtitleContext?.fps || 29.97,
      dropFrame: (lastSubtitleContext?.dropFrame ?? true),
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else {
    doc = parseJsonSubtitle(resolvedPath);
  }

  if (mediaPath && !doc.mediaPath) {
    doc.mediaPath = mediaPath;
  }

  const session = storeSession(doc, sessionId);
  return {
    ...session,
    lastExport: session.lastExport || null
  };
}

async function exportCorrectedSubtitles(payload = {}) {
  const { doc, sessionId } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  const fps = doc.fps || lastSubtitleContext?.fps || 30;
  const dropFrame = !!(doc.dropFrame || lastSubtitleContext?.dropFrame);
  const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
    const cue = doc.cues?.[idx];
    if (!cue) return seg;
    // Prefer the parsed/editor `lines` so placement and wrapping match 608 reality.
    const lines = (Array.isArray(cue.lines) && cue.lines.length)
      ? cue.lines.slice(0, 2)
      : String(seg.text || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n|\s*\|\s*/g)
        .slice(0, 2);
    const pairs = lines
      .map((ln, i) => ({ ln, pl: cue.sccPlacement?.[i] || null }))
      .filter(p => String(p.ln || '').trim());
    const withTags = pairs.map(({ ln, pl }) => (
      pl && Number.isFinite(pl.row) && Number.isFinite(pl.col)
        ? `{row:${pl.row}}{col:${pl.col}}${ln}`
        : ln
    )).join('\n');
    return { ...seg, text: withTags };
  });
  const cues = segmentsToCueList(segments, fps, dropFrame);

  let targetDir = doc.outputDir;
  if (!targetDir && doc.sourcePath) targetDir = path.dirname(doc.sourcePath);
  if (!targetDir && lastSubtitleContext?.outputPath) targetDir = lastSubtitleContext.outputPath;
  if (!targetDir) targetDir = os.tmpdir();

  const baseName = doc.baseName
    || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
    : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));

  const meta = {
    sourcePath: doc.sourcePath,
    mediaPath: doc.mediaPath,
    fps,
    dropFrame
  };

  const srtPath = await writeCorrectedSRT(segments, targetDir, baseName, { includeSpeakerNames: true });
  const vttPath = await writeCorrectedVTT(segments, targetDir, baseName, { includeSpeakerNames: true });
  const jsonPath = await writeCorrectedJson(cues, targetDir, baseName, meta);

  const outputs = { json: jsonPath, srt: srtPath, vtt: vttPath, directory: targetDir };

  const session = storeSession({
    ...doc,
    sourcePath: doc.sourcePath || (subtitleSessions.get(sessionId || doc.sessionId)?.sourcePath),
    mediaPath: doc.mediaPath || subtitleSessions.get(sessionId || doc.sessionId)?.mediaPath || null,
    outputDir: targetDir,
    lastExport: outputs
  }, sessionId || doc.sessionId);

  return {
    success: true,
    message: `Saved corrections to ${targetDir}`,
    outputs: session.lastExport
  };
}

async function burnInCorrectedSubtitles(payload = {}) {
  const { doc, sessionId, lastExport } = payload;
  const session = subtitleSessions.get(sessionId || doc?.sessionId) || {};
  const combined = { ...session, ...(doc || {}) };
  const mediaPath = combined.mediaPath || lastSubtitleContext?.mediaPath;
  if (!mediaPath) {
    throw new Error('No media path available for burn-in');
  }

  const exportInfo = lastExport || session.lastExport;
  if (!exportInfo?.srt) {
    throw new Error('Export corrections before burn-in');
  }

  const outputDir = combined.outputDir || exportInfo?.directory || path.dirname(mediaPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = path.basename(mediaPath, path.extname(mediaPath));
  const outputMov = path.join(outputDir, `${baseName}.burnin.mov`);

  const srtPath = exportInfo.srt;
  const safeSrt = srtPath.replace(/'/g, "\\'");
  const vf = `subtitles='filename=${safeSrt}:force_style=FontName=Helvetica,FontSize=42,Outline=2,Shadow=1'`;

  await runFFmpeg([
    '-y',
    '-i', mediaPath,
    '-vf', vf,
    '-c:v', 'prores_ks',
    '-profile:v', '3',
    '-c:a', 'copy',
    outputMov
  ]);

  session.outputDir = outputDir;
  session.lastExport = { ...exportInfo, directory: outputDir, burnIn: outputMov };
  subtitleSessions.set(session.sessionId || sessionId || doc?.sessionId || randomUUID(), session);

  return {
    success: true,
    message: `Burn-in complete → ${outputMov}`,
    output: outputMov
  };
}

async function findLatestSubtitleSource(payload = {}) {
  const searchDir = payload.outputPath || lastSubtitleContext?.outputPath;
  if (!searchDir) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(searchDir);
  } catch {
    return null;
  }

  const prefix = payload.baseName || lastSubtitleContext?.baseName;
  const candidates = entries
    .filter(name => /\.(json|srt|vtt|scc)$/i.test(name))
    .filter(name => !prefix || name.startsWith(prefix));

  if (!candidates.length) return null;

  const decorated = candidates
    .map(name => {
      const full = path.join(searchDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const priorities = [
    '.corrected.scc',
    '.scc',
    '.corrected.final.json',
    '.final.json',
    '.corrected.srt',
    '.srt',
    '.corrected.vtt',
    '.vtt',
    '.json'
  ];

  for (const ext of priorities) {
    const match = decorated.find(entry => entry.name.toLowerCase().endsWith(ext));
    if (match) return match.full;
  }

  return decorated[0]?.full || null;
}

async function exportSccFromEditor(payload = {}) {
  const { doc, sessionId } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  const fps = doc.fps || lastSubtitleContext?.fps || 29.97;
  const dropFrame = !!(doc.dropFrame || lastSubtitleContext?.dropFrame);
  const dfOk = isDropFrameRate(fps) && dropFrame && Math.abs(Number(fps) - 29.97) < 0.05;
  if (!dfOk) {
    throw new Error(`SCC requires 29.97 DF; got fps=${fps}, dropFrame=${dropFrame}`);
  }

    const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
      const cue = doc.cues?.[idx];
      if (!cue) return seg;
      // Prefer the parsed/editor `lines` so placement and wrapping match 608 reality.
      const lines = (Array.isArray(cue.lines) && cue.lines.length)
        ? cue.lines.slice(0, 2)
        : String(seg.text || '')
          .replace(/\\n/g, '\n')
          .split(/\r?\n|\s*\|\s*/g)
          .slice(0, 2);
      const pairs = lines
        .map((ln, i) => ({ ln, pl: cue.sccPlacement?.[i] || null }))
        .filter(p => String(p.ln || '').trim());
      const withTags = pairs.map(({ ln, pl }) => (
        pl && Number.isFinite(pl.row) && Number.isFinite(pl.col)
          ? `{row:${pl.row}}{col:${pl.col}}${ln}`
          : ln
      )).join('\n');
      return { ...seg, text: withTags };
    });

  const sccText = scc.generateSCC(segments, {
    fps,
    dropFrame,
    maxCharsPerLine: Math.min(32, Number(doc.maxCharsPerLine || 32)),
    maxLinesPerBlock: Number(doc.maxLinesPerBlock || 2),
    includeSpeakerNames: true,
    sccOptions: {
      // Single-write SCC: no redundancy and no padding
      alignment: 'left',
      rowPolicy: 'bottom2',
      padEven: false,
      repeatControlCodes: false,
      repeatPreambleCodes: false,
      timeSource: 'auto',
      appendEOFAt: 'afterLast',
      eofOp: 'edm',
      stripLeadingDashes: true,
      // optional; will be used if your editor payload starts passing it
      fontComment: doc?.sccOptions?.fontComment
    }
  });

  let targetDir = doc.outputDir || lastSubtitleContext?.outputPath || null;
  if (!targetDir && doc.sourcePath) targetDir = path.dirname(doc.sourcePath);
  if (!targetDir && doc.mediaPath) targetDir = path.dirname(doc.mediaPath);
  if (!targetDir) targetDir = process.cwd();
  fs.mkdirSync(targetDir, { recursive: true });

  const baseName = doc.baseName
    || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
    : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));
  const outPath = path.join(targetDir, `${baseName}.corrected.scc`);
  let outputText = typeof sccText === 'string' ? sccText : sccText?.scc || '';
  // Safety: guarantee header is first, move any pre-header comments beneath it
  outputText = outputText.replace(/^\uFEFF/, '');
  {
    const L = outputText.replace(/\r/g,'').split('\n');
    const i = L.findIndex(l => /^Scenarist_SCC\b/i.test(l.trim()));
    if (i > 0) {
      const pre = L.slice(0, i).filter(l => l.trim().startsWith('//'));
      outputText = [L[i], ...pre, ...L.slice(i + 1)].join('\n').replace(/\n+$/, '') + '\n';
    }
  }
  fs.writeFileSync(outPath, outputText, 'utf8');

  // QC: verify parity/tokens so we fail fast instead of handing Premiere junk
  try {
    if (typeof scc.verifySCC === 'function') {
      const rep = scc.verifySCC(outputText);
      if (!rep.ok || rep.invalidTokens > 0) {
        throw new Error(`SCC verify failed — ${rep.summary}`);
      }
    }
  } catch (e) {
    // Surface verifier problems as an actionable error
    throw new Error(`SCC verification error: ${e.message}`);
  }

  const existing = subtitleSessions.get(sessionId || doc.sessionId) || {};
  const mergedLastExport = {
    ...(existing.lastExport || {}),
    ...(doc.lastExport || {}),
    scc: outPath,
    directory: targetDir
  };

  storeSession({ ...doc, outputDir: targetDir, lastExport: mergedLastExport }, sessionId || doc.sessionId);

  return { success: true, message: `SCC saved → ${outPath}`, output: outPath };
}

module.exports = {
  runTranscribe,
  cancelTranscribe,
  streamTranscript,
  openSubtitleDocument,
  exportCorrectedSubtitles,
  burnInCorrectedSubtitles,
  findLatestSubtitleSource,
  exportSccFromEditor
};
