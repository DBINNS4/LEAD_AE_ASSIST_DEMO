// Utility functions for invoking Whisper CLI and handling output
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { detectAIComputeType } = require('../utils/gpuEncoder');

function ensureUnique(p) {
  if (!fs.existsSync(p)) return p;
  const parsed = path.parse(p);
  let count = 1;
  let candidate;
  do {
    candidate = path.join(parsed.dir, `${parsed.name}(${count})${parsed.ext}`);
    count++;
  } while (fs.existsSync(candidate));
  return candidate;
}

let _supportsNGL;
async function binarySupportsArg(binaryPath, arg) {
  if (_supportsNGL !== undefined) return _supportsNGL;
  return (_supportsNGL = await new Promise(resolve => {
    const p = spawn(binaryPath, ['-h']);
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (out += d.toString()));
    p.on('close', () => resolve(out.includes(arg)));
    p.on('error', () => resolve(false));
  }));
}

async function runWhisperOnce({ filePath, inputPath, outputDir, binaryPath, modelPath, config, setProcess, extraArgs = [] }) {
  const filename = path.basename(filePath, path.extname(filePath));
  const jsonOut = path.join(outputDir, `${filename}.json`);
  const whisperArgs = [
    '-m', modelPath,
    '-f', inputPath,
    '-of', path.join(outputDir, filename),
    '-oj',
    '-l', config.language || 'en',
    '--output-json-full',
    ...extraArgs
  ];

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Whisper CLI not found at ${binaryPath}. ` +
        'Set WHISPER_CPP_DIR or install the local whisper.cpp binary.'
    );
  }

  const device = detectAIComputeType();
  if (device !== 'cpu' && (await binarySupportsArg(binaryPath, '-ngl'))) {
    whisperArgs.push('-ngl', '999');
  }

  console.log(`🔊 Running Whisper JSON: ${binaryPath} ${whisperArgs.join(' ')}`);

  await new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, whisperArgs, { stdio: 'inherit' });
    if (typeof setProcess === 'function') setProcess(proc);
    proc.on('close', code => {
      if (typeof setProcess === 'function') setProcess(null);
      if (code === 0) resolve();
      else reject(new Error(`Whisper exited with code ${code}`));
    });
    proc.on('error', err => {
      if (typeof setProcess === 'function') setProcess(null);
      reject(err);
    });
  });

  if (!fs.existsSync(jsonOut)) {
    throw new Error(`❌ Expected output file missing: ${jsonOut}`);
  }
  return JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
}

function writeEnrichedLog(jsonData, filePath, config, logDir) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const baseName = path.basename(filePath, path.extname(filePath));
  const enrichedPath = path.join(logDir, `${baseName}.final-${timestamp}.json`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.warn(`⚠️  Failed to create log directory ${logDir}:`, err);
  }
  fs.writeFileSync(enrichedPath, JSON.stringify(jsonData, null, 2));
  return enrichedPath;
}

function safeWriteFinalJSON(wrapped, filePath, outputDir) {
  const finalOut = path.join(
    outputDir,
    `${path.basename(filePath, path.extname(filePath))}.final.json`
  );
  const tempPath = `${finalOut}.__temp__`;

  try {
    const dir = path.dirname(finalOut);
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {}

  fs.writeFileSync(tempPath, JSON.stringify(wrapped, null, 2));
  fs.renameSync(tempPath, finalOut);
  return finalOut;
}

module.exports = {
  runWhisperOnce,
  writeEnrichedLog,
  safeWriteFinalJSON,
  ensureUnique
};
