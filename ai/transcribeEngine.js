require('dotenv').config();

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const electron = require('electron');

const app = electron.app || null;
const OpenAI = require('openai');
const { convertToWav, ffmpegPath, ffprobePath } = require('../utils/ffmpeg');
const { runWhisperOnce, writeEnrichedLog, ensureUnique } = require('./whisperUtils');
const { detectAIComputeType } = require('../utils/gpuEncoder');
// Initialize export object before requiring modules that depend on this one
// to avoid circular dependency issues.
const exported = {};
module.exports = exported;

const scc = require('../modules/sccEncoder');

// Keep high-level wrappers from whisperFormatter
const {
  wrapToProfessionalFormat,
  addFullTimecodeMetadata
} = require('./whisperFormatter');
// Pull timecode math from centralized utils
const {
  parseTime: parseTimeMs,
  msToTC,
  formatTimecodes,
  formatTimecode,
  isDropFrameRate
} = require('../utils/timeUtils');

const { prepareSegments, normalizeTranscriptionStructure } = require('./prepareUtils');
const { prepareTranscription } = require('./prepareTranscription');
const { writeAllOutputs } = require('./outputWriters');

// Translate wrapped.segments[*].text into a target language, preserving timing and segment boundaries.
// Returns true if any text was changed, false otherwise.
async function translateWrappedSegmentsInPlace(openai, wrapped, targetLabel = 'English') {
  if (!wrapped || !Array.isArray(wrapped.segments) || !wrapped.segments.length) return false;

  const segments = wrapped.segments;
  const originals = segments.map(s => String(s.text || ''));
  const inputs = originals.map(t => t || '');

  if (!inputs.some(t => t.trim())) {
    console.warn('[translateWrappedSegmentsInPlace] No non-empty segment text to translate.');
    return false;
  }

  // 1️⃣ Try a single JSON-array style translation
  const systemMsg =
    `You are a professional subtitle translator. ` +
    `Translate each caption into ${targetLabel}. ` +
    `Preserve meaning, punctuation, tone, and roughly the same line breaks. ` +
    `Return ONLY a JSON array of ${inputs.length} strings, where index i is the translation of input index i. ` +
    `Do not merge, split, reorder, or add items. No commentary.`;

  const userMsg = JSON.stringify(inputs);

  let outputs = null;
  let rawContent = '';

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ]
    });

    rawContent = resp?.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.warn('[translateWrappedSegmentsInPlace] JSON.parse failed on bulk response:', e.message);
    }

    if (Array.isArray(parsed) && parsed.length === inputs.length) {
      outputs = parsed.map(x => (typeof x === 'string' ? x : String(x ?? '')));
    } else {
      console.warn(
        '[translateWrappedSegmentsInPlace] Parsed JSON has wrong shape; expected array length',
        inputs.length,
        'got',
        parsed && parsed.length
      );
    }
  } catch (e) {
    console.warn('[translateWrappedSegmentsInPlace] Bulk translation call failed:', e.message);
  }

  // If bulk path failed or produced junk, fall back to per-line translation.
  const needFallback =
    !outputs ||
    outputs.length !== inputs.length ||
    // if nothing actually changed and target is non-English, treat as failure
    outputs.every((out, i) => out.trim() === inputs[i].trim());

  if (needFallback) {
    console.warn('[translateWrappedSegmentsInPlace] Falling back to per-line translation.');
    outputs = [];
    for (let i = 0; i < inputs.length; i++) {
      const line = inputs[i];
      if (!line.trim()) {
        outputs.push(line);
        continue;
      }
      try {
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                `Translate the following subtitle into ${targetLabel}. ` +
                'Return ONLY the translated text, no explanations, no quotes, no JSON.'
            },
            { role: 'user', content: line }
          ]
        });
        const out = resp?.choices?.[0]?.message?.content ?? '';
        outputs.push(String(out).trim() || line);
      } catch (e) {
        console.warn(`[translateWrappedSegmentsInPlace] Line ${i} translation failed:`, e.message);
        outputs.push(line);
      }
    }
  }

  if (!outputs || outputs.length !== inputs.length) {
    console.warn('[translateWrappedSegmentsInPlace] Translation fallback still invalid; keeping originals.');
    return false;
  }

  // Apply translations
  let changed = false;
  segments.forEach((seg, i) => {
    if (!seg || typeof seg !== 'object') return;
    const next = outputs[i];
    if (typeof next === 'string' && next.trim() && next.trim() !== originals[i].trim()) {
      seg.text = next;
      changed = true;
    }
  });

  if (!changed) {
    console.warn('[translateWrappedSegmentsInPlace] No segment text changed after translation; originals retained.');
  }

  return changed;
}

let currentProcess = null;

function withFfmpegEnv(extra = {}) {
  const env = Object.assign({}, process.env, extra);
  try {
    const appRoot = (app && typeof app.getAppPath === 'function') ? app.getAppPath() : process.cwd();
    const candidateDirs = [
      path.join(appRoot, 'extra', 'bin'),
      path.join(appRoot, 'extra', 'ffmpeg')
    ];
    const resolvedDirs = candidateDirs.filter(dir => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    });
    const existingPath = env.PATH ? env.PATH.split(path.delimiter) : [];
    const nextPath = [...resolvedDirs, ...existingPath].filter(Boolean);
    env.PATH = nextPath.join(path.delimiter);
    if (!env.FFMPEG && ffmpegPath) env.FFMPEG = ffmpegPath;
    if (!env.FFPROBE) {
      env.FFPROBE = ffprobePath || path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    }
  } catch {}
  return env;
}

// Ensure python-based tools (whisperx/diarize) resolve the app's ffmpeg first.
function buildPythonEnv(extra = {}) {
  const env = Object.assign({}, process.env, extra);
  try {
    const appRoot =
      (app && typeof app.getAppPath === 'function') ? app.getAppPath() : process.cwd();

    // Make sure Python sees the app-bundled ffmpeg
    const ffbinDir = path.join(appRoot, 'extra', 'ffmpeg');
    // WhisperX requires these exact env names (NOT FFMPEG / FFPROBE)
    env.FFMPEG_BINARY  = path.join(ffbinDir, 'ffmpeg');
    env.FFPROBE_BINARY = path.join(ffbinDir, 'ffprobe');

    // If there's a venv next to the app, add it to PATH + PYTHONPATH
    const venvDir = path.join(appRoot, 'venv');
    const isWin = process.platform === 'win32';
    const venvBin = isWin
      ? path.join(venvDir, 'Scripts')
      : path.join(venvDir, 'bin');
    const venvSite = path.join(venvDir, 'lib', 'python3.11', 'site-packages');

    const pathParts = [];
    if (fs.existsSync(venvBin)) pathParts.push(venvBin);
    pathParts.push(ffbinDir);
    if (env.PATH) pathParts.push(env.PATH);
    env.PATH = pathParts.join(path.delimiter);

    if (fs.existsSync(venvSite)) {
      env.PYTHONPATH = env.PYTHONPATH
        ? `${venvSite}${path.delimiter}${env.PYTHONPATH}`
        : venvSite;
    }
  } catch {}
  return env;
}

function buildPythonEnvForWhisperX(extra = {}) {
  const env = Object.assign({}, process.env, extra);

  try {
    const appRoot =
      (app && typeof app.getAppPath === 'function')
        ? app.getAppPath()
        : process.cwd();

    // Correct FFmpeg directory inside your packaged app
    const ffbinDir = path.join(appRoot, 'extra', 'ffmpeg');
    const correctFfmpeg = path.join(ffbinDir, 'ffmpeg');
    const correctFfprobe = path.join(ffbinDir, 'ffprobe');

    // 🔥 WhisperX uses THESE names (FFMPEG_BINARY / FFPROBE_BINARY) not FFMPEG / FFPROBE
    env.FFMPEG_BINARY = correctFfmpeg;
    env.FFPROBE_BINARY = correctFfprobe;

    // Prepend ffmpeg folder so plain "ffmpeg" resolves correctly
    env.PATH = [ffbinDir, env.PATH].join(path.delimiter);

    // Add virtualenv paths if present
    const venvDir = path.join(appRoot, 'venv');
    const venvBin = path.join(venvDir, 'bin');
    const venvSite = path.join(venvDir, 'lib', 'python3.11', 'site-packages');

    if (fs.existsSync(venvBin)) {
      env.PATH = [venvBin, env.PATH].join(path.delimiter);
    }
    if (fs.existsSync(venvSite)) {
      env.PYTHONPATH = env.PYTHONPATH
        ? `${venvSite}${path.delimiter}${env.PYTHONPATH}`
        : venvSite;
    }

  } catch (e) {
    console.warn('Failed to build WhisperX env:', e);
  }

  return env;
}

function resolvePythonExecutable() {
  try {
    const appRoot =
      (app && typeof app.getAppPath === 'function') ? app.getAppPath() : process.cwd();
    const venvDir = path.join(appRoot, 'venv');
    const isWin = process.platform === 'win32';
    const pyDir = isWin ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
    const pyName = isWin ? 'python.exe' : 'python3';
    const venvPython = path.join(pyDir, pyName);
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }
  } catch {}
  // Fallback to whatever python3 is on PATH
  return 'python3';
}

async function runDiarization(filePath) {
  const script = path.join(__dirname, '../scripts/diarize.py');
  return new Promise((resolve, reject) => {
    const py = resolvePythonExecutable();
    const proc = spawn(py, [script, filePath], { env: buildPythonEnvForWhisperX() });
    currentProcess = proc;
    let out = '';
    let err = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => (err += d.toString()));
    proc.on('error', errEvt => {
      currentProcess = null;
      reject(errEvt);
    });
    proc.on('close', code => {
      currentProcess = null;
      if (code === 0) {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error('❌ Diarization JSON parse failed: ' + e.message));
        }
      } else {
        if (err.includes("ModuleNotFoundError: No module named 'numpy'")) {
          resolve([]); // skip speaker labels if numpy missing
        } else {
          reject(new Error(`Diarization failed: ${err}`));
        }
      }
    });
  });
}

function injectSpeakersIntoSegments(segments, diarized) {
  if (!Array.isArray(segments) || !Array.isArray(diarized)) return;
  for (const seg of segments) {
    const match = diarized.find(d => seg.start >= d.start && seg.start < d.end);
    if (match) seg.speaker = match.speaker;
  }
}

// ----------------------------------------
// 🔊 Whisper (OpenAI) API
// ----------------------------------------
async function transcribeWithWhisperAPI(filePath, config) {
  const { language, apiKey } = config;
  const effectiveKey = (apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!effectiveKey) {
    // Fail loudly with a human-readable reason instead of a cryptic 401
    throw new Error(
      'OpenAI Whisper API key is missing. ' +
      'Set an API key in Preferences (or OPENAI_API_KEY in your environment) to run translate jobs.'
    );
  }

  const openai = new OpenAI({ apiKey: effectiveKey });
  const keySource = apiKey ? 'config' : 'env';
  console.log('🔑 OpenAI API key source:', keySource);

  const results = [];
  const wantsTranslate = !!config.translation?.enabled;
  const targetLabel = (config.translation?.target || '').trim() || 'English';

  let resp;
  try {
    // IMPORTANT: transcription only – no `task` here
    resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      // Engine Language dropdown → input language hint
      // Set to "auto" in the UI if you want auto-detect.
      language
    });
  } catch (err) {
    // Surface a clean error to your job queue / UI
    throw new Error(`OpenAI Whisper API error: ${err.message || String(err)}`);
  }

  let jsonData;
  try {
    jsonData = typeof resp === 'object' ? resp : JSON.parse(resp);
  } catch {
    const snippet = String(resp).slice(0, 120).replace(/\n/g, ' ');
    throw new Error(`❌ Expected JSON but got invalid response.\n${snippet}`);
  }

  await prepareSegments(jsonData, filePath, config);
  const diarized = (config.diarization || config.localSpeakerDetection || config.detectSpeakers || config.includeSpeakerNames)
    ? (await runDiarization(filePath).catch(() => []))
    : [];
  const wrapped = await prepareTranscription(jsonData, filePath, config, { engine: 'whisper', diarized });

  // 🔁 If Translate dropdown is ON, convert segment text into the target language
  if (wantsTranslate) {
    try {
      const changed = await translateWrappedSegmentsInPlace(openai, wrapped, targetLabel);
      if (changed) {
        console.log(`🌍 API translation applied → ${targetLabel}`);
      } else {
        console.warn(
          `⚠️ API translation step produced no changes; leaving original language (${jsonData.language || language || 'unknown'}).`
        );
      }
    } catch (e) {
      console.warn('⚠️ API translation step threw:', e?.message || e);
    }
  }

  const outputLogs = await writeAllOutputs(wrapped, filePath, config);
  results.push(...outputLogs);

  return results;
}

// ----------------------------------------
// 🖥️ Local Whisper Binary
// ----------------------------------------

async function transcribeWithLocalWhisper(filePath, config) {
  const defaultDir = app && typeof app.getPath === 'function'
    ? path.join(app.getPath('userData'), 'whisper.cpp')
    : path.join(process.cwd(), 'whisper.cpp');
  const altDir = app && typeof app.getAppPath === 'function'
    ? path.join(app.getAppPath(), 'whisper.cpp')
    : path.join(__dirname, '..', 'whisper.cpp');
  const whisperDir =
    process.env.WHISPER_CPP_DIR ||
    (fs.existsSync(defaultDir) ? defaultDir : altDir);
  const modelPath = path.join(whisperDir, 'models', 'ggml-base.en.bin');
  const binaryPath = path.join(whisperDir, 'build', 'bin', 'whisper-cli');
  const outputDir = config.outputPath;
  const filename = path.basename(filePath, path.extname(filePath));
  const results = [];
  const logDir = config.logPath || outputDir;

  const isWav = path.extname(filePath).toLowerCase() === '.wav';
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
  fs.mkdirSync(tempDir, { recursive: true });

  const inputPath = isWav ? filePath : path.join(tempDir, `${filename}-${Date.now()}.wav`);
  if (!isWav && !fs.existsSync(inputPath)) {
    console.log(`🎛️ Converting to .wav: ${inputPath}`);
    await convertToWav(filePath, inputPath, config.useAltTracks ? 1 : null, p => (currentProcess = p));
  }
  const extraArgs = [];
  if ((config.whisperTask === 'translate') || !!config.translation?.enabled) {
    extraArgs.push('--translate');
  }

  const jsonData = await runWhisperOnce({
    filePath,
    inputPath,
    outputDir,
    binaryPath,
    modelPath,
    config,
    extraArgs,
    setProcess: p => (currentProcess = p)
  });
  // Remove raw Whisper JSON now so our writer can claim the canonical name.
  cleanupRawJSONs(filePath, outputDir);

  await prepareSegments(jsonData, filePath, config);
  const enrichedPath = writeEnrichedLog(jsonData, filePath, config, logDir);
  results.push(`📁 Enriched JSON Log saved → ${enrichedPath}`);

  const diarized = (config.diarization || config.localSpeakerDetection || config.detectSpeakers || config.includeSpeakerNames)
    ? (await runDiarization(inputPath).catch(() => []))
    : [];
  const wrapped = await prepareTranscription(jsonData, filePath, config, { engine: 'lead', diarized });

  // NEW: add indent/row audit into .final.json when enabled
  if (config.verboseQcLogs) {
    try {
      const audit = scc.computeCea608PlacementAudit(wrapped.segments, {
        maxCharsPerLine: config.maxCharsPerLine ?? 32,
        maxLinesPerBlock: config.maxLinesPerBlock ?? 2,
        includeSpeakerNames: config.includeSpeakerNames ?? false,
        sccOptions: {
          alignment: 'left',
          rowPolicy: 'bottom2'
        }
      });
      // Attach compact audit per segment
      wrapped.segments?.forEach((seg, i) => {
        if (!seg || !audit?.[i]) return;
        seg.indentAudit = audit[i].lines; // [{index,row,indentNibble,columnStart,text}]
      });
      // Optionally record the policy used at the top level
      wrapped.qc = Object.assign({}, wrapped.qc, {
        cea608: {
          alignment: 'left',
          rowPolicy: 'bottom2',
          channel: 1,
          fields: ['index', 'row', 'indentNibble', 'columnStart', 'text']
        }
      });
    } catch (e) {
      console.warn('QC indent audit failed:', e);
    }
  }

  // Single source of truth: final JSON will be written by outputWriters.writeFinalJSON (if selected).
  const outputLogs = await writeAllOutputs(wrapped, filePath, config);
  results.push(...outputLogs);

  if (!isWav && fs.existsSync(inputPath)) {
    fs.unlinkSync(inputPath);
  }

  // Burn-in is handled by outputWriters.writeAllOutputs()

  if (config.translation?.enabled && config.whisperTask !== 'translate') {
    const txtPath = path.join(outputDir, `${filename}.txt`);
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf8');
      try {
        // Upgrade local translation engine to GPT-4o-mini for better quality and context fidelity
        const openai = new OpenAI({
          apiKey: config.apiKey || process.env.OPENAI_API_KEY
        });
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                `Translate the following transcript into ${config.translation.target}. ` +
                'Preserve meaning, tone, punctuation, and formatting.'
            },
            { role: 'user', content: text }
          ]
        });
        const translation = resp.choices?.[0]?.message?.content?.trim();
        if (translation) {
          let out = path.join(outputDir, `${filename}.${config.translation.target}.txt`);
          out = ensureUnique(out);
          fs.writeFileSync(out, translation);
          results.push(`🌍 Translation → ${out}`);
        }
      } catch (err) {
        results.push(`⚠️ Translation failed: ${err.message}`);
      }
    }
  }

  return results;
} // ✅ this closing brace is critical to end transcribeWithLocalWhisper

// ----------------------------------------
// 🐍 WhisperX (Python)
// ----------------------------------------
async function transcribeWithWhisperX(filePath, config) {
  const finalOutputDir = config.outputPath;
  const filename = path.basename(filePath, path.extname(filePath));
  const outFile = path.join(finalOutputDir, `${filename}.x.json`);

  const jobTag = `job-${config.jobId || Date.now()}`;
  const tempBase = path.join(os.tmpdir(), 'leadai-whisperx', jobTag);
  const tempOutputDir = path.join(tempBase, filename);

  try {
    fs.mkdirSync(tempOutputDir, { recursive: true });
  } catch {
    // best-effort
  }

  const baseArgs = [
    '-m', 'whisperx',
    filePath,
    '--output_dir', tempOutputDir,
    '--output_format', 'json'
  ];

  if (config.language) baseArgs.push('--language', config.language);
  // 🔇 DO NOT let WhisperX attempt diarization; we use our own engine instead.
  // if (config.diarization || config.localSpeakerDetection) baseArgs.push('--diarize');
  if ((config.whisperTask === 'translate') || !!config.translation?.enabled) {
    baseArgs.push('--task', 'translate');
  }

  // --- DEVICE LOGIC ---
  const isMac = process.platform === 'darwin';
  let device = 'cpu';

  if (!isMac) {
    // PC (Windows/Linux)
    // detectAIComputeType() returns "cuda" when available
    device = detectAIComputeType() || 'cpu';
  }

  // CTranslate2 naming consistency
  const deviceFlag = device === 'metal' ? 'mps' : device;

  // --- COMPUTE TYPE ---
  let computeType = 'float32'; // safest
  const accuracy = config.accuracyMode || 'auto';
  if (accuracy === 'accurate') computeType = 'float32';
  else if (accuracy === 'fast') computeType = 'int8';

  const runWhisperXOnce = () => {
    const args = baseArgs.concat(['--device', deviceFlag, '--compute_type', computeType]);

    return new Promise((resolve, reject) => {
      const py = resolvePythonExecutable();
      const env = buildPythonEnvForWhisperX();

      // 🔎 Debug — confirm exactly which ffmpeg WhisperX will use
      console.log(">>> USING FFMPEG_BINARY:", env.FFMPEG_BINARY);
      console.log(">>> USING FFPROBE_BINARY:", env.FFPROBE_BINARY);
      console.log(">>> USING PATH:", env.PATH);

      const proc = spawn(py, args, { env });
      currentProcess = proc;

      let err = '';

      proc.stderr.on('data', d => err += d.toString());
      proc.stdout.on('data', () => {}); // Silence noise

      proc.on('error', e => {
        currentProcess = null;
        reject(e);
      });

      proc.on('close', async code => {
        currentProcess = null;

        if (code !== 0) {
          try {
            fs.rmSync(tempBase, { recursive: true, force: true });
          } catch {}
          return reject(new Error(err || `WhisperX exited with code ${code}`));
        }

        // WhisperX always writes <filename>.json, move to .x.json
        const defaultOut = path.join(tempOutputDir, `${filename}.json`);
        try {
          if (!fs.existsSync(defaultOut)) {
            throw new Error('WhisperX JSON not found');
          }

          const tempFinal = `${outFile}.__temp__`;

          try {
            const dir = path.dirname(outFile);
            fs.mkdirSync(dir, { recursive: true });
          } catch {}

          fs.copyFileSync(defaultOut, tempFinal);
          fs.renameSync(tempFinal, outFile);

          const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          await prepareSegments(raw, filePath, config);

          // ✅ Use the same tokenless diarizer we wired for other engines
          const wantsDiar = (
            config.diarization ||
            config.localSpeakerDetection ||
            config.detectSpeakers ||
            config.includeSpeakerNames
          );

          let diarized = [];
          if (wantsDiar) {
            try {
              // WhisperX runs directly on the original media path
              diarized = await runDiarization(filePath);
            } catch (e) {
              console.warn('WhisperX diarization fallback (tokenless) failed:', e.message || e);
              diarized = [];
            }
          }

          const wrapped = await prepareTranscription(raw, filePath, config, {
            engine: 'whisperx',
            diarized
          });

          const logs = await writeAllOutputs(wrapped, filePath, config);
          resolve([`📝 WhisperX JSON → ${outFile}`, ...logs]);
        } catch (e) {
          reject(new Error(`WhisperX post-processing failed: ${e.message}`));
        } finally {
          try {
            fs.rmSync(tempBase, { recursive: true, force: true });
          } catch {}
        }
      });
    });
  };

  // Run exactly once; no fallback because device is guaranteed valid
  return await runWhisperXOnce();
}

// ----------------------------------------
// 🔁 Dispatch Logic
// ----------------------------------------
async function runEngine(engine, filePath, config) {
  switch (engine) {
    case 'whisper':
      return await transcribeWithWhisperAPI(filePath, config);
    case 'lead':
      return await transcribeWithLocalWhisper(filePath, config);
    case 'whisperx':
      return await transcribeWithWhisperX(filePath, config);
    default:
      throw new Error(`❌ Unsupported transcription engine: ${engine}`);
  }
}

function cancelCurrentProcess() {
  if (currentProcess && typeof currentProcess.kill === 'function') {
    currentProcess.kill('SIGINT');
  }
  currentProcess = null;
}

function generatePlainText(jsonResults, opts = {}) {
  const segments = Array.isArray(jsonResults.segments) ? jsonResults.segments : [];
  const lines = [];
  let prevSpeaker = null;
  opts.timecodeStyle = opts.timecodeStyle || 'colon';
  const sysFps = (jsonResults.system?.fps ?? opts.fps);
  if (!sysFps) {
    throw new Error('[generatePlainText] Missing fps. Provide jsonResults.system.fps or opts.fps.');
  }
  const sysDfPref = jsonResults.system?.dropFramePreferred ?? jsonResults.system?.dropFrame;
  const sysDF = Boolean(sysDfPref && isDropFrameRate(sysFps));
  const startOffset = normalizeOffset(opts.startTimecodeOffset, sysFps, sysDF);
  const applyOffset = (value) => {
    if (!Number.isFinite(value)) return null;
    const adjusted = value + startOffset;
    return adjusted < 0 ? 0 : adjusted;
  };

  for (const seg of segments) {
    let text = (seg.text || '').replace(/\n/g, ' ').trim();
    if (opts.removeFillers) {
      text = text
        .replace(/\b(?:um+|uh+|er+|ah+)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    let speaker = seg.speaker || (opts.includeSpeakers ? 'SPEAKER' : '');
    if (opts.speakerStyle === 'caps') speaker = speaker.toUpperCase();
    else if (opts.speakerStyle === 'title') speaker = speaker.replace(/\b\w/g, c => c.toUpperCase());
    else speaker = speaker.trim();

    // Prefer numeric seconds; fall back to ms; last resort: parse nested labels.
    const start =
      Number.isFinite(Number(seg.start)) ? Number(seg.start) :
      (typeof seg?.timecodes?.ms?.start === 'number' ? seg.timecodes.ms.start / 1000 :
       parseTimeMs(seg?.timecodes?.df?.start || seg?.timecodes?.ndf?.start || '0', sysFps, null) / 1000);
    const end =
      Number.isFinite(Number(seg.end)) ? Number(seg.end) :
      (typeof seg?.timecodes?.ms?.end === 'number' ? seg.timecodes.ms.end / 1000 :
       parseTimeMs(seg?.timecodes?.df?.end || seg?.timecodes?.ndf?.end || '0', sysFps, null) / 1000);
    const startSec = applyOffset(start);
    const endSec = applyOffset(end);
    const startTC = Number.isFinite(startSec)
      ? formatTimecode(startSec, sysDF, sysFps, opts.timecodeStyle)
      : opts.timecodeStyle === 'ms'
        ? '00:00:00,000'
        : '00:00:00:00';
    const endTC = Number.isFinite(endSec)
      ? formatTimecode(endSec, sysDF, sysFps, opts.timecodeStyle)
      : opts.timecodeStyle === 'ms'
        ? '00:00:00,000'
        : '00:00:00:00';

    let prefixParts = [];
    if (opts.includeTimecodes && opts.timestampStyle !== 'none') {
      if (opts.timestampStyle === 'start') prefixParts.push(`[${startTC}]`);
      else if (opts.timestampStyle === 'start-end') prefixParts.push(`[${startTC} - ${endTC}]`);
      else if (opts.timestampStyle === 'every-line') prefixParts.push(`[${startTC}]`);
    }

    if (opts.includeSpeakers && (!opts.groupBySpeaker || speaker !== prevSpeaker || opts.timestampStyle === 'every-line')) {
      if (speaker) prefixParts.push(`${speaker}:`);
    }

    const lineText = (prefixParts.join(' ') + ' ' + text).trim();

    if (opts.groupBySpeaker && speaker === prevSpeaker && opts.timestampStyle !== 'every-line') {
      lines[lines.length - 1] += ' ' + text;
    } else {
      lines.push(lineText);
    }

    prevSpeaker = speaker;
  }
  return lines.join('\n');
}

function generateSyncableScriptCSV(jsonResults, arg) {
  const opts = (typeof arg === 'number') ? { fps: arg } : (arg || {});
  const segments = Array.isArray(jsonResults.segments) ? jsonResults.segments : [];
  const fpsCandidates = [
    Number(opts.fps),
    Number(jsonResults.system?.fps)
  ];
  const fps = fpsCandidates.find(v => Number.isFinite(v) && v > 0) || 30;
  const includeSpeakers = opts.includeSpeakers ?? true;
  const includeTimecodes = opts.includeTimecodes ?? true;
  let timestampStyle = String(opts.timestampStyle || 'start-end').replace(/_/g, '-');
  if (!includeTimecodes) timestampStyle = 'none';
  const allowGrouping = Boolean(opts.groupBySpeaker) && timestampStyle !== 'every-line';
  const speakerStyle = opts.speakerStyle || 'title';
  const timecodeFormat = String(opts.timecodeFormat || 'ndf').toLowerCase();
  let dropPref;
  if (typeof opts.dropFrame === 'boolean') dropPref = opts.dropFrame;
  else if (timecodeFormat === 'df') dropPref = true;
  else if (timecodeFormat === 'ndf' || timecodeFormat === 'ms') dropPref = false;
  else dropPref = jsonResults.system?.dropFramePreferred ?? jsonResults.system?.dropFrame;
  const dropFrame = Boolean(dropPref && isDropFrameRate(fps));
  const tcStyle = timecodeFormat === 'ms' ? 'ms' : 'colon';
  const startOffset = normalizeOffset(opts.startTimecodeOffset, fps, dropFrame);
  const defaultTc = tcStyle === 'ms'
    ? '00:00:00,000'
    : dropFrame
      ? '00:00:00;00'
      : '00:00:00:00';
  const lines = ['Timecode,Speaker,Text'];

  const escapeCsv = value => String(value ?? '').replace(/"/g, '""');
  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const resolveTime = (seg, field) => {
    const numeric = Number(seg?.[field]);
    if (Number.isFinite(numeric)) return numeric;
    const ms = seg?.timecodes?.ms?.[field];
    if (typeof ms === 'number') return ms / 1000;
    const tcLabel = seg?.timecodes?.df?.[field] || seg?.timecodes?.ndf?.[field];
    if (tcLabel) {
      const parsed = parseTimeMs(tcLabel, fps, dropFrame);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return null;
  };
  const formatTimeValue = (start, end) => {
    if (timestampStyle === 'none') return '';
    const withOffset = value => {
      if (!Number.isFinite(value)) return null;
      return Math.max(0, value + startOffset);
    };
    const startSec = withOffset(start);
    const endSec = withOffset(end);
    const startLabel = startSec != null
      ? formatTimecode(startSec, dropFrame, fps, tcStyle)
      : defaultTc;
    const endLabel = endSec != null
      ? formatTimecode(endSec, dropFrame, fps, tcStyle)
      : defaultTc;
    if (timestampStyle === 'start-end') return `${startLabel} - ${endLabel}`;
    return startLabel;
  };
  const formatSpeaker = name => {
    if (!name) return '';
    if (speakerStyle === 'caps') return String(name).toUpperCase();
    if (speakerStyle === 'title') {
      return String(name).replace(/\b\w/g, c => c.toUpperCase());
    }
    return String(name).trim();
  };

  let currentGroup = null;
  const flushGroup = () => {
    if (!currentGroup) return;
    const timeValue = formatTimeValue(currentGroup.start, currentGroup.end);
    const speakerValue = includeSpeakers ? currentGroup.displaySpeaker : '';
    const textValue = cleanText(currentGroup.text);
    lines.push(`"${escapeCsv(timeValue)}","${escapeCsv(speakerValue)}","${escapeCsv(textValue)}"`);
    currentGroup = null;
  };

  for (const segment of segments) {
    const text = cleanText(segment.text);
    const start = resolveTime(segment, 'start');
    const endRaw = resolveTime(segment, 'end');
    let speakerRaw = typeof segment.speaker === 'string' ? segment.speaker : '';
    if (!speakerRaw && jsonResults.metadata?.autoSpeakerLabels) {
      if (!jsonResults._speakerMap) jsonResults._speakerMap = [];
      const index = jsonResults._speakerMap.length;
      speakerRaw = `SPEAKER ${1 + (index % 2)}`;
      jsonResults._speakerMap.push(speakerRaw);
    }
    const speakerKey = speakerRaw || (includeSpeakers ? 'SPEAKER' : '');
    let displaySpeaker = includeSpeakers ? (speakerRaw || 'SPEAKER') : '';
    displaySpeaker = formatSpeaker(displaySpeaker);
    const entry = {
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(endRaw) ? endRaw : (Number.isFinite(start) ? start : null),
      speakerKey,
      displaySpeaker,
      text
    };

    if (allowGrouping && currentGroup && entry.speakerKey === currentGroup.speakerKey) {
      currentGroup.text = `${currentGroup.text} ${text}`.trim();
      if (Number.isFinite(entry.end)) currentGroup.end = entry.end;
    } else {
      flushGroup();
      currentGroup = entry;
    }
  }
  flushGroup();
  return lines.join('\n');
}

function normalizeOffset(value, fps, dropFrame) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseTimeMs(value.trim(), fps, dropFrame);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return 0;
}


function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + word).length > maxChars) {
      lines.push(current.trim());
      current = '';
    }
    current += word + ' ';
  }
  if (current) lines.push(current.trim());
  return lines;
}

function toSrtTimestamp(seconds) {
  const whole = Math.floor(seconds);
  let ms = Math.round((seconds - whole) * 1000);
  let sec = whole;
  if (ms === 1000) { sec += 1; ms = 0; }
  const pad2 = v => String(v).padStart(2, '0');
  const pad3 = v => String(v).padStart(3, '0');
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(ms)}`;
}

function toVttTimestamp(seconds) {
  const whole = Math.floor(seconds);
  let ms = Math.round((seconds - whole) * 1000);
  let sec = whole;
  if (ms === 1000) { sec += 1; ms = 0; }
  const pad2 = v => String(v).padStart(2, '0');
  const pad3 = v => String(v).padStart(3, '0');
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

function generateSRT(segments, config = {}) {
  const MAX_CHARS = config.maxCharsPerLine || 42;
  const strict = (config.strictTiming === true) || (config.exactTiming === true);
  const MAX_DURATION = strict ? Infinity : (config.maxDurationSeconds || 6.0);
  const MAX_LINES = config.maxLinesPerBlock || 2;
  const fps = Number(config?.fpsOverride ?? config?.fps ?? 30);
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const nudge = strict ? 0 : (1 / safeFps);

  const cues = [];
  let cueIndex = 1;

  segments.forEach(seg => {
    let endSec = seg.end;
    if (!strict && (endSec - seg.start > MAX_DURATION)) {
      endSec = seg.start + MAX_DURATION;
    }
    const end = toSrtTimestamp(endSec);
    let text = seg.text || '';
    const speaker = seg.speaker || '';
    if (config?.includeSpeakerNames && speaker) {
      text = `${speaker}: ${text}`;
    }
    const lines = wrapText(text, MAX_CHARS);

    const groupedLines = [];
    while (lines.length) {
      groupedLines.push(lines.splice(0, MAX_LINES).join('\n'));
    }

    groupedLines.forEach((g, j) => {
      const start = toSrtTimestamp(seg.start + (strict ? 0 : j * nudge));
      cues.push(`${cueIndex}\n${start} --> ${end}\n${g}\n`);
      cueIndex += 1;
    });
  });

  return cues.join('\n');
}

function generateVTT(segments, config = {}) {
  const header = 'WEBVTT\n';
  const body = segments.map(seg => {
    const start = toVttTimestamp(seg.start);
    const end = toVttTimestamp(seg.end);
    let text = (seg.text || '').trim();
    const speaker = seg.speaker || '';
    if (config?.includeSpeakerNames && speaker) {
      text = `${speaker}: ${text}`;
    }
    return `${start} --> ${end}\n${text}`;
  }).join('\n\n');
  return `${header}\n${body}`;
}


function generateFrameTimecodeTXT(segments, fps = 29.97, style = 'colon', dropFrame = false) {
  return segments
    .map(seg => {
      const startMs =
        Number.isFinite(Number(seg.start)) ? Number(seg.start) * 1000 :
        (typeof seg?.timecodes?.ms?.start === 'number' ? seg.timecodes.ms.start :
         parseTimeMs(seg?.timecodes?.df?.start || seg?.timecodes?.ndf?.start || '0', fps, null));
      const endMs =
        Number.isFinite(Number(seg.end)) ? Number(seg.end) * 1000 :
        (typeof seg?.timecodes?.ms?.end === 'number' ? seg.timecodes.ms.end :
         parseTimeMs(seg?.timecodes?.df?.end || seg?.timecodes?.ndf?.end || '0', fps, null));
      const tcStart = msToTC(startMs, fps, style, dropFrame);
      const tcEnd = msToTC(endMs, fps, style, dropFrame);
      const speaker = seg.speaker || 'SPEAKER';
      const txt = (seg.text || '').trim();
      return `[${tcStart} - ${tcEnd}] ${speaker}: ${txt}`;
    })
    .join('\n');
}

function generateSegmentTextWithTokenTiming(segments, format = 'FF') {
  const lines = [];

  const getTC = (tok, fmt) => {
    if (!tok?.timecodes) return (fmt === 'ms' ? '00:00:00,000' : (fmt === 'ff' ? '00:00:00;00' : '00:00:00:00'));
    if (fmt === 'ms') {
      const ms = tok.timecodes.ms?.start;
      return Number.isFinite(ms) ? msToTC(ms, 29.97, 'ms', false) : '00:00:00,000';
    }
    if (fmt === 'ff') return tok.timecodes.df?.start || '00:00:00;00';
    return tok.timecodes.ndf?.start || '00:00:00:00';
  };

  for (const seg of segments) {
    const tokens = (seg.tokens || []).filter(
      t => t?.text && !(t.text.startsWith('[') && t.text.endsWith(']'))
    );
    if (!tokens.length) continue;

    const start = getTC(tokens[0], format);
    const end = getTC(tokens[tokens.length - 1], format);
    const speaker = seg.speaker || 'SPEAKER';

    // Preserve original spacing as emitted by Whisper
    const text = tokens.map(t => t.text).join('').trim();

    lines.push(`[${start} - ${end}] ${speaker}: ${text}`);
  }

  return lines.join('\n');
}


function generateMarkersTXT(segments, fps = 29.97, style = 'colon', dropFrame = false) {
  return segments.map(seg => {
    const start = typeof seg.start === 'number'
      ? formatTimecode(seg.start, dropFrame, fps, style)
      : style === 'ms' ? '00:00:00,000' : '00:00:00:00';
    const label = (seg.text || '').replace(/\n/g, ' ').trim().slice(0, 60);
    return `${start}\t${label}`;
  }).join('\n');
}

function generateXML(segments, style = 'colon', fps = 29.97, dropFrame = false) {
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  xml.push('<transcription>');

  segments.forEach((seg, i) => {
    const start = formatTimecode(seg.start || 0, dropFrame, fps, style);
    const end = formatTimecode(seg.end || 0, dropFrame, fps, style);
    const speaker = seg.speaker || 'SPEAKER';
    const text = (seg.text || '').replace(/[<>&]/g, c => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;'
    }[c]) || c);
    xml.push(`  <event id="${i + 1}" start="${start}" end="${end}" speaker="${speaker}">${text}</event>`);
  });

  xml.push('</transcription>');
  return xml.join('\n');
}

async function burnInSubtitles(inputVideoPath, srtPath, outputDir) {
  const outName = `${path.basename(inputVideoPath, path.extname(inputVideoPath))}_burnin.mp4`;
  const outputFile = ensureUnique(path.join(outputDir, outName));

  return new Promise((resolve, reject) => {
    const esc = (p) => String(p)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");
    const filter = `subtitles=${esc(srtPath)}:force_style='FontName=Arial,FontSize=22'`;
    const args = [
      '-y', '-i', inputVideoPath,
      '-vf', filter,
      '-c:v', detectBestEncoderSync(), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '192k',
      outputFile
    ];

    console.log('🎬 Burn-in command:', ffmpegPath, args.join(' '));
    // Ensure burn-in uses the app-bundled ffmpeg/ffprobe (extra/bin or extra/ffmpeg)
    const proc = spawn(ffmpegPath, args, { env: withFfmpegEnv() });
    currentProcess = proc;
    let err = '';
    proc.stderr.on('data', d => (err += d.toString()));
    proc.on('error', errEvt => {
      currentProcess = null;
      reject(errEvt);
    });
    proc.on('close', code => {
      currentProcess = null;
      if (code === 0) {
        resolve(`🎬 Burn-in created → ${outputFile}`);
      } else {
        reject(new Error(`❌ Burn-in failed: ${err}`));
      }
    });
  });
}

function detectBestEncoderSync() {
  try {
    // Probe encoders with the same env used elsewhere for consistency
    const out = spawnSync(ffmpegPath, ['-encoders'], { encoding: 'utf8', env: withFfmpegEnv() }).stdout || '';
    if (/\bh264_videotoolbox\b/.test(out)) return 'h264_videotoolbox';
    if (/\bmpeg4\b/.test(out)) return 'mpeg4';
  } catch {}
  return 'mpeg4';
}

function parseTimecode(tc, fps = 30, dropFrameHint = null) {
  if (!tc) return 0;
  // Reuse the DF-aware parser from the formatter (returns ms)
  return parseTimeMs(tc, fps, dropFrameHint) / 1000;
}

function cleanupRawJSONs(filePath, outputDir) {
  const base = path.basename(filePath, path.extname(filePath));
  const rawPath = path.join(outputDir, `${base}.json`);
  const patchedPath = path.join(outputDir, `${base}.patched.json`);
  [rawPath, patchedPath].forEach(p => {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

Object.assign(exported, {
  runEngine,
  cancelCurrentProcess,
  prepareTranscription,
  generateSyncableScriptCSV,
  generatePlainText,
  generateFrameTimecodeTXT,
  generateSegmentTextWithTokenTiming,
  generateMarkersTXT,
  runDiarization,
  injectSpeakersIntoSegments,
  addFullTimecodeMetadata,
  transcribeWithWhisperX,
  wrapToProfessionalFormat,
  parseTimecode,
  parseTime: parseTimeMs,
  msToTC,
  formatTimecodes,
  generateSRT,
  generateVTT,
  generateXML,
  generateSCC: scc.generateSCC,
  wrap608: (text, maxChars = 32, maxLines = 2) => scc.wrapTextAndClamp(text, maxChars, maxLines),
  computeCea608PlacementAudit: scc.computeCea608PlacementAudit,
  verifySCC: scc.verifySCC,
  pacForRow: scc.pacForRow,
  ctrl: scc.ctrl,
  build608WordsForPopOn: scc.build608WordsForPopOn,
  burnInSubtitles,
  formatTimecode,
  normalizeTranscriptionStructure
});
