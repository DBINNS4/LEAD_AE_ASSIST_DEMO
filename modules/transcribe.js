require('dotenv').config();

const ProgressManager = require('../utils/progressManager');
// (rest of imports unchanged)

const transcribeEngine = require('../ai/transcribeEngine');
const scc = require('./sccEncoder');
const { extendedGlyphMap } = require('./sccGlyphMap');
const { runEngine, cancelCurrentProcess } = transcribeEngine;
const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  sendLogMessage,
  archiveLog,
  createJobLogger,
  writeJobLogToFile
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
  writeCorrectedVTT,
  writeSccQcReport,
  validateSccContentQc
} = require('../ai/outputWriters');

// ------------------------------------------------------------
// SCC glyph picker support (CEA-608)
// ------------------------------------------------------------
function getSccGlyphs() {
  // Return glyphs supported by the SCC encoder's extendedGlyphMap.
  // Categorize by high-byte family for UI grouping.
  const map = extendedGlyphMap || {};
  const glyphs = Object.keys(map);

  const groups = {
    specialNorthAmerican: [],
    extendedWesternEuropean1: [],
    extendedWesternEuropean2: [],
    other: []
  };

  for (const g of glyphs) {
    const spec = map[g] || {};
    const hi = (spec.hiCh1 ?? spec.hiF1); // prefer new naming, tolerate old
    if (hi === 0x11) groups.specialNorthAmerican.push(g);
    else if (hi === 0x12) groups.extendedWesternEuropean1.push(g);
    else if (hi === 0x13) groups.extendedWesternEuropean2.push(g);
    else groups.other.push(g);
  }

  const sort = (arr) => arr.slice().sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    total: glyphs.length,
    groups: {
      specialNorthAmerican: sort(groups.specialNorthAmerican),
      extendedWesternEuropean1: sort(groups.extendedWesternEuropean1),
      extendedWesternEuropean2: sort(groups.extendedWesternEuropean2),
      other: sort(groups.other)
    }
  };
}

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

let transcribeJobLogger = null;
function sendTranscribeLog(msg, isError = false, detail = '', fileId = '') {
  sendLogMessage('transcribe', msg, detail, isError, fileId);
  if (transcribeJobLogger) {
    const meta = {};
    if (detail) meta.detail = detail;
    if (fileId) meta.fileId = fileId;
    transcribeJobLogger[isError ? 'error' : 'info'](msg, meta);
  }
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
  if (!config.jobId) {
    config.jobId = `transcribe-${Date.now()}`;
  }

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

  const structuredLog = [];
  transcribeJobLogger = createJobLogger({
    panel: 'transcribe',
    jobId: config.jobId,
    stage: 'init',
    collector: structuredLog
  });

  const logs = [];
  const startTime = Date.now();

  let archivePath = null;
  let structuredPath = null;

  const progressManager = new ProgressManager(0, 250, 'files');
  progressManager.setTotalFiles(config.files.length);
  transcribeJobLogger.setStage('transcribe');

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
    const messages = missing.map(f => `❌ File not found: ${f}`);
    logs.push(...messages);
    messages.forEach(msg => sendTranscribeLog(msg, true));
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  if (!Object.values(config.outputFormats || {}).some(v => v)) {
    const msg = '❌ No output format selected.';
    logs.push(msg);
    sendTranscribeLog(msg, true);
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  if (!config.outputPath) {
    const msg = '❌ Output path missing or invalid.';
    logs.push(msg);
    sendTranscribeLog(msg, true);
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  try {
    await fs.promises.access(config.outputPath);
  } catch {
    const msg = '❌ Output path missing or invalid.';
    logs.push(msg);
    sendTranscribeLog(msg, true);
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  if (!config.engine) {
    const msg = '❌ No transcription engine selected.';
    logs.push(msg);
    sendTranscribeLog(msg, true);
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
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
    logs.push(errMsg);
    sendTranscribeLog(errMsg, true);
    transcribeJobLogger.setStage('error');
    structuredPath = writeJobLogToFile(
      'transcribe',
      config.jobId,
      transcribeJobLogger.getEntries()
    );
    if (progressManager?.dispose) progressManager.dispose();
    transcribeJobLogger = null;
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: logs.join('\n'),
      archivePath: null,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  
  let successCount = 0;
  let failCount = 0;

  for (const [index, file] of config.files.entries()) {
    if (config.signal?.aborted) break;
    let tempInput = null;
    const statusMap = {
      engine: config.engine || null,
      engineDone: false
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

      // Only do format fixes for the OpenAI Whisper API.
      if (config.engine === 'whisper') {
        try {
          const stats = await fs.promises.stat(file);
          if (isAudioCompatible) {
            if (stats.size > MAX_SIZE) {
              const mb = (stats.size / 1024 / 1024).toFixed(2);
              throw new Error(
                `❌ File too large for Whisper API: ${mb} MB (max ~25 MB per request). ` +
                `Use a local engine or split the media into smaller chunks.`
              );
            }
            sendTranscribeLog('✅ File extension and size are compatible with Whisper API');
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
            tempInput = path.join(tempDir, `${base}_leadai.m4a`);
            try {
              await fs.promises.unlink(tempInput);
            } catch (e) {
              if (e.code !== 'ENOENT') throw e;
            }

            sendTranscribeLog(
              `🔁 Re-encoding unsupported input ${file} → ${tempInput} for Whisper API`
            );

            try {
              await runFFmpeg([
                '-i', file,
                '-vn',
                '-ar', '16000',
                '-ac', '1',
                '-c:a', 'aac',
                '-b:a', '48k',
                '-movflags', '+faststart',
                tempInput
              ]);
            } catch (err) {
              console.error(`❌ FFmpeg failed: ${err.message}`);
              if (err.stdout) console.error(`stdout: ${err.stdout}`);
              if (err.stderr) console.error(`stderr: ${err.stderr}`);
              throw err;
            }

            const outStats = await fs.promises.stat(tempInput);
            if (outStats.size > MAX_SIZE) {
              const mb = (outStats.size / 1024 / 1024).toFixed(2);
              throw new Error(
                `❌ Audio still too large for Whisper API after re-encode: ${mb} MB. ` +
                `Split into chunks or lower the bitrate further.`
              );
            }

            inputFile = tempInput;
            const mb = (outStats.size / 1024 / 1024).toFixed(2);
            sendTranscribeLog(`✅ Re-encoded to Whisper-compatible audio (${mb} MB)`);
          }
        } catch (err) {
          const errMsg = `❌ Whisper API input prep failed: ${err.message}`;
          sendTranscribeLog(errMsg, true);
          logs.push(errMsg);
          failCount++;
          emitStatus();
          continue;
        }
      }

      sendTranscribeLog(`⚙️ Engine: ${config.engine}`);
      const engineLogs = await runEngine(config.engine, inputFile, config);
      engineLogs.forEach(l => sendTranscribeLog(l));
      logs.push(...engineLogs);
      statusMap.engineDone = true;
      emitStatus();

      successCount++;
      progressManager.finishFile(index, statusMap);
    } catch (err) {
      const errMsg = `❌ Error for ${file}: ${err.message}`;
      sendTranscribeLog(errMsg, true);
      logs.push(errMsg);
      failCount++;
      progressManager.finishFile(index, statusMap);
    } finally {
      if (tempInput) {
        try {
          await fs.promises.unlink(tempInput);
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

  archivePath = archiveLog(logs, 'transcribe');
  logs.push(`📂 Log archived to: ${archivePath}`);

  const wasCanceled = config.signal?.aborted;
  const finalStage = !wasCanceled && failCount === 0 ? 'complete' : 'error';
  transcribeJobLogger.setStage(finalStage);
  transcribeJobLogger.info(wasCanceled ? 'Transcription cancelled' : 'Transcription job completed');
  structuredPath = writeJobLogToFile('transcribe', config.jobId, transcribeJobLogger.getEntries());

  if (progressManager?.dispose) progressManager.dispose();
  transcribeJobLogger = null;
  return {
    success: !wasCanceled && failCount === 0,
    cancelled: wasCanceled,
    log: logs,
    archivePath,
    structuredLogPath: structuredPath,
    jobId: config.jobId
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
    // SCC is CEA-608 in Scenarist format.
    // IMPORTANT: don't let lastSubtitleContext (from a prior 24/25/30 fps job) poison SCC metadata.
    // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
    // We lock fps to 29.97, but detect DF/NDF from the file delimiter.
    doc = parseSccFile(resolvedPath, {
      fps: 29.97,
      // auto-detect DF/NDF from SCC delimiter
      dropFrame: null,
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
  const dropFrame = (typeof doc.dropFrame === 'boolean') ? doc.dropFrame : !!lastSubtitleContext?.dropFrame;
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
    dropFrame,
    startTimecode: doc.startTc || doc.startTC || null
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

function normalizeMusicGlyphLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return line;
  const up = raw.toUpperCase();
  if (up === '[MUSIC]' || up === '[MUSIC ONLY]' || up === '[MUSIC INTRO]' || up === '[MUSIC OUT]') {
    return '♪';
  }
  return line;
}

function normalizeOutputPath(input) {
  // Accept either:
  //  - string "/path/to/file.scc"
  //  - { filePath: "/path/to/file.scc" } (dialog-return style)
  //  - { path: "/path/to/file.scc" } (defensive)
  if (!input) return null;
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const p = input.filePath || input.path || input.outPath || null;
    return (typeof p === 'string' && p.trim()) ? p : null;
  }
  return null;
}

async function exportSccFromEditor(payload = {}) {
  const { doc, sessionId, outputPath } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  let outPath = null;
  const normalized = normalizeOutputPath(outputPath);
  if (normalized) {
    outPath = normalized;
  } else {
    let targetDir = doc.outputDir;
    if (!targetDir) {
      throw new Error('No export destination selected.');
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const baseName = doc.baseName
      || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
      : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));
    outPath = path.join(targetDir, `${baseName}.corrected.scc`);
  }

  // SCC export is always 29.97-timebase, but SCC itself supports both:
  //  - DF labels (;) — default
  //  - NDF labels (:) — only when explicitly enabled
  // We intentionally DO NOT fall back to lastSubtitleContext here because that can come from
  // unrelated jobs (e.g. 24/25/30) and would make SCC export inconsistent.
  const fps = 29.97;
  const wantsNdf = doc?.dropFrame === false;
  const allowNdf = !!doc?.sccOptions?.allowNdf;
  const dropFrame = wantsNdf ? false : true;
  if (wantsNdf && !allowNdf) {
    throw new Error('NDF SCC export is disabled. Enable sccOptions.allowNdf (advanced) to export ":" timecodes.');
  }

  const alignment = (() => {
    const raw = doc?.sccOptions?.alignment || doc?.alignment || 'center';
    const norm = String(raw || '').trim().toLowerCase();
    return norm === 'centre' ? 'center' : norm || 'center';
  })();

  // SCC speaker labels are a QC risk for some broadcast deliverables.
  // Keep OFF by default; allow opt-in via doc.sccOptions.includeSpeakerNames.
  const includeSpeakerNamesScc = !!doc?.sccOptions?.includeSpeakerNames;

  const injectSpeakerPrefixAfterPlacementTags = (text, speakerPrefix) => {
    const t = String(text || '');
    const pfx = String(speakerPrefix || '');
    if (!pfx) return t;
    const lines = t.split('\n');
    const first = lines[0] || '';
    const m = first.match(/^((?:\{(?:row|col|pac):[^}]+\})+)(.*)$/);
    if (m) {
      const tags = m[1] || '';
      const body = m[2] || '';
      lines[0] = body.startsWith(pfx) ? `${tags}${body}` : `${tags}${pfx}${body}`;
    } else {
      lines[0] = first.startsWith(pfx) ? first : `${pfx}${first}`;
    }
    return lines.join('\n');
  };

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
      .map((ln, i) => ({ ln: normalizeMusicGlyphLine(ln), pl: cue.sccPlacement?.[i] || null }))
      .filter(p => String(p.ln || '').trim());
    const withTags = pairs.map(({ ln, pl }) => (
      pl && Number.isFinite(pl.row) && Number.isFinite(pl.col)
        ? `{row:${pl.row}}{col:${pl.col}}${ln}`
        : ln
    )).join('\n');
    return { ...seg, text: withTags };
  });

  // If speaker labels are enabled, bake them into the first line *after* any
  // placement tags so we don't break {row}/{col}.
  // Then disable encoder auto-prefixing to avoid double insertion.
  const segmentsForScc = includeSpeakerNamesScc
    ? segments.map(seg => {
        if (!seg || !seg.speaker) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        return { ...seg, text: injectSpeakerPrefixAfterPlacementTags(seg.text, prefix) };
      })
    : segments;

  // Editor SCC shaping: clamp to 608-safe ranges
  const rawMaxChars = Number(doc.maxCharsPerLine);
  const maxCharsPerLine = Math.max(20, Math.min(32, Number.isFinite(rawMaxChars) ? rawMaxChars : 28));
  const rawMaxLines = Number(doc.maxLinesPerBlock || 2);
  const maxLinesPerBlock = Math.max(1, Math.min(2, Number.isFinite(rawMaxLines) ? rawMaxLines : 2));

  const startTc = doc?.startTc || doc?.startTC || doc?.sccOptions?.startTc || doc?.sccOptions?.startTC || null;

  const sccRes = scc.generateSCC(segmentsForScc, {
    fps,
    dropFrame,
    startTc,
    maxCharsPerLine,
    maxLinesPerBlock,
    // Speaker labels (if enabled) were baked into seg text above.
    includeSpeakerNames: false,
    sccOptions: {
      // Defaults aim for broadcaster/QC compatibility.
      alignment,
      // NDF SCC export is opt-in and must be explicitly enabled.
      allowNdf,
      // SCC export is CC1-only for now (Beta). Force channel=1 regardless of doc state.
      // This prevents stale session data / presets from requesting CC2–CC4 which are not
      // implemented end-to-end correctly in the 608 encoder path yet.
      channel: 1,
      rowPolicy: (doc?.sccOptions?.rowPolicy) || 'bottom2',
      // Default safeMargins to full 32-col width (col 0 start).
      // Title-safe width is handled by maxCharsPerLine (defaults to 28 unless overridden by the doc).
      safeMargins: (doc?.sccOptions?.safeMargins) || { left: 0, right: 0 },
      padEven: !!(doc?.sccOptions?.padEven),
      extendedGlyphMap,
      repeatControlCodes: (doc?.sccOptions?.repeatControlCodes) !== false,
      repeatPreambleCodes: (doc?.sccOptions?.repeatPreambleCodes) !== false,
      timeSource: (doc?.sccOptions?.timeSource) || 'auto',
      appendEOFAt: (doc?.sccOptions?.appendEOFAt) || 'afterLast',
      eofOp: (doc?.sccOptions?.eofOp) || 'edm',
      stripLeadingDashes: !!(doc?.sccOptions?.stripLeadingDashes),
      // F) Optional program-start reset support (passed through if present)
      startResetAt: doc?.sccOptions?.startResetAt,
      startResetOp: doc?.sccOptions?.startResetOp
    },
    returnStats: true
  });

  let outputText = typeof sccRes === 'string' ? sccRes : sccRes?.scc || '';
  const encoderStats = (sccRes && typeof sccRes === 'object' && sccRes.stats) ? sccRes.stats : null;
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
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const writeText = outputText.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(outPath, writeText, 'utf8');

  // D) Content-level QC (Rev/MaxCaption-grade): enforce readability + timing
  // thresholds, not just SCC structural validity.
  const qcCfg = (doc && doc.sccOptions && doc.sccOptions.qc) ? doc.sccOptions.qc : {};
  const contentQc = (typeof validateSccContentQc === 'function')
    ? validateSccContentQc(segmentsForScc, {
        fps,
        dropFrame,
        startTc,
        maxCps: qcCfg.maxCps,
        maxWpm: qcCfg.maxWpm,
        minDurationSec: qcCfg.minDurationSec,
        minGapSec: qcCfg.minGapSec,
        maxLateEocSec: qcCfg.maxLateEocSec,
        maxLateEocCount: qcCfg.maxLateEocCount,
        // Encoder-derived late-EOC stats when available
        lateEocCount: Number(encoderStats?.lateEocCount ?? 0),
        maxLateEocSecObserved: Number(encoderStats?.maxLateEocSec ?? 0)
      })
    : null;

  // QC: verify parity/tokens so we fail fast instead of handing Premiere junk
  let verify = null;
  let verifyErr = null;
  try {
    if (typeof scc.verifySCC === 'function') {
      verify = scc.verifySCC(outputText);
      if (!verify.ok || verify.invalidTokens > 0) {
        verifyErr = new Error(`SCC verify failed — ${verify.summary}`);
      }
    }
  } catch (e) {
    // Surface verifier problems as an actionable error
    verifyErr = e;
  }

  // G) QC report sidecar (same pattern as transcription SCC writer)
  writeSccQcReport({
    sccText: outputText,
    verify,
    metrics: {
      encoderStats,
      contentQc
    },
    srcLabel: 'subtitle-editor',
    outPath
  });

  // Fail the export if content QC fails (deliverable would be rejected even if SCC is "valid").
  if (contentQc && !contentQc.ok) {
    const head = contentQc.failures?.[0];
    const sample = head
      ? `${head.message}${head.startTc ? ` @ ${head.startTc}` : ''}`
      : 'One or more content QC failures.';
    throw new Error(`SCC content QC failed — ${contentQc.failures.length} issue(s). ${sample}`);
  }

  // Fail the export if parity/token verification fails.
  if (verifyErr) {
    throw new Error(`SCC verification error: ${verifyErr.message}`);
  }

  const existing = subtitleSessions.get(sessionId || doc.sessionId) || {};
  const mergedLastExport = {
    ...(existing.lastExport || {}),
    ...(doc.lastExport || {}),
    scc: outPath,
    directory: path.dirname(outPath)
  };

  storeSession({ ...doc, outputDir: path.dirname(outPath), lastExport: mergedLastExport }, sessionId || doc.sessionId);

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
  exportSccFromEditor,
  // SCC glyph picker
  getSccGlyphs
};
