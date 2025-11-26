const { sendLogMessage, writeLogToFile } = require('./logUtils');
const { copyFileWithProgress } = require('./fileUtils');
const { compareFilesByteByByte } = require('../utils/compare');
const { StageProgressManager } = require('../progressBridge');
const {
  getBlake3Hash,
  getSha256Hash,
  getMd5Hash,
  getXxHashHash
} = require('./hashUtils');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../utils/ffmpeg');
const { dialog, BrowserWindow, app } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Bind CEP forwarders for a given jobId and return a cleanup fn
function bindCepForwardersForJob(jobId, config) {
  if (!global.cepBridge) return () => {};
  // OLD behavior: forward progress only; completion is emitted by finalizer

  const forward = msg => {
    try {
      const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
      // Mirror progress to the queue so Electron UI stays in sync
      if (data?.type === 'queue-job-progress' && data.panel === 'adobe-utilities') {
        global.queue?.emit('job-progress', {
          id: jobId,
          panel: 'adobe-utilities',
          stage: data.stage,
          status: data.status,
          percent: data.percent,
          origin: data.origin,
          jobId: data.jobId
        });
        return;
      }
      // Do not emit job-complete here (OLD behavior defers to finalizer).
    } catch {
      /* ignore parse errors */
    }
  };

  const onComplete = data => forward(data);
  const onProgress = data => forward(data);

  global.cepBridge.on('queue-job-complete', onComplete);
  global.cepBridge.on('queue-job-progress', onProgress);
  global.cepBridge.on('message', forward); // fallback for legacy packets

  return () => {
    try { global.cepBridge?.off?.('queue-job-complete', onComplete); } catch {}
    try { global.cepBridge?.off?.('queue-job-progress', onProgress); } catch {}
    try { global.cepBridge?.off?.('message', forward); } catch {}
  };
}

// ───────────────────────────────────────────────────────────────
// Match‑Source support
// ───────────────────────────────────────────────────────────────
const MATCH_SOURCE_SENTINEL = 'match-source-ffmpeg';

function normalizeProxyPresetValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'match-source') {
    return MATCH_SOURCE_SENTINEL;
  }
  return trimmed;
}

function normalizeAdobeConfig(config = {}) {
  if (!config || typeof config !== 'object') return {};
  if (typeof config.proxyPreset === 'string' || typeof config.proxyPreset === 'number') {
    config.proxyPreset = normalizeProxyPresetValue(config.proxyPreset);
  }
  return config;
}

const LEGACY_MATCH_SOURCE_SENTINEL = 'match-source';
const isMatchSourcePreset = value =>
  value === MATCH_SOURCE_SENTINEL || value === LEGACY_MATCH_SOURCE_SENTINEL;

function fileExists(p) {
  try {
    return !!(p && fs.existsSync(p));
  } catch {
    return false;
  }
}

const filterSupportCache = new Map();
function ffmpegSupportsFilter(name) {
  if (filterSupportCache.has(name)) {
    return filterSupportCache.get(name);
  }

  let supported = false;
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    if (res?.status === 0 && typeof res.stdout === 'string') {
      supported = res.stdout.indexOf(` ${name} `) !== -1;
    }
  } catch (_) {
    supported = false;
  }

  filterSupportCache.set(name, supported);
  return supported;
}

// 🔹 Active job tracking
const activeAdobeJobs = new Map();

// 🔧 Progress smoothing knobs
const SMOOTH_INTERVAL_MS = 500; // how often to tick fake progress
const SMOOTH_INCREMENT = 2; // % increment per tick
const SMOOTH_CAP = 90; // don't exceed this % until real complete

function isAMEAvailable(pushLog) {
  try {
    if (process.platform === 'darwin') {
      const apps = fs.readdirSync('/Applications');
      const matches = apps.filter(a => String(a).toLowerCase().includes('adobe media encoder'));
      pushLog?.(`🔍 /Applications AME matches: ${JSON.stringify(matches)}`);
      return matches.length > 0;
    }
    if (process.platform === 'win32') {
      const base = 'C:/Program Files/Adobe';
      const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
      const matches = dirs.filter(d => String(d).toLowerCase().includes('adobe media encoder'));
      pushLog?.(`🔍 C:/Program Files/Adobe AME matches: ${JSON.stringify(matches)}`);
      return matches.length > 0;
    }
    return false;
  } catch (err) {
    pushLog?.(`⚠️ isAMEAvailable error: ${err.message || err}`);
    return false;
  }
}

async function pathExists(p) {
  if (!p) return false;
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateAdobeConfig(config = {}) {
  config = normalizeAdobeConfig(config);
  const errors = [];

  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (sources.length > 0) {
    const checks = await Promise.all(sources.map(pathExists));
    const missing = sources.filter((_, index) => !checks[index]);
    if (missing.length > 0) {
      const localMissing = missing.filter(p =>
        !(p?.startsWith?.('/Volumes/') || p?.startsWith?.('/media/') || p?.startsWith?.('/mnt/'))
      );
      if (localMissing.length > 0) {
        errors.push(`❌ Missing file(s):\n${localMissing.join('\n')}`);
      }
    }

  } else {
    errors.push('❌ No source files selected.');
  }

  if (!config.importPremiere) {
    if (!config.destination || !config.destination.trim()) {
      errors.push('❌ No destination selected.');
    } else if (!(await pathExists(config.destination))) {
      errors.push(`❌ Destination folder does not exist: ${config.destination}`);
    }
  }

  // 🔁 New behavior:
  // • Proxy preset is OPTIONAL (we synthesize/patch per group).
  // • Proxy destination is auto-chosen/created later if missing.
  // Allow virtual preset "match-source-ffmpeg" without requiring a file on disk.
  if (config.generateProxies && config.proxyPreset && !isMatchSourcePreset(config.proxyPreset)) {
    if (!(await pathExists(config.proxyPreset))) {
      errors.push(`❌ Proxy preset file does not exist: ${config.proxyPreset}`);
    }
  }

  return errors;
}

async function validateProxyConfig(config) {
  config = normalizeAdobeConfig(config);
  const errors = [];
  if (!config.generateProxies || !config.proxyPreset) return errors;

  let presetXml;
  try {
    presetXml = fs.readFileSync(config.proxyPreset, 'utf8');
  } catch {
    errors.push('❌ Could not load proxy preset.');
    return errors;
  }

  const width = parseInt(
    /<VideoFrameWidth>(\d+)<\/VideoFrameWidth>/.exec(presetXml)?.[1] || 0,
    10
  );
  const height = parseInt(
    /<VideoFrameHeight>(\d+)<\/VideoFrameHeight>/.exec(presetXml)?.[1] || 0,
    10
  );
  const fps = /<FrameRate>([\d.]+)<\/FrameRate>/.exec(presetXml)?.[1];
  const channels = parseInt(
    /<AudioChannels>(\d+)<\/AudioChannels>/.exec(presetXml)?.[1] || 0,
    10
  );
  const fileExt =
    /<FileExt>([^<]+)<\/FileExt>/.exec(presetXml)?.[1] ||
    /<FileExtension>([^<]+)<\/FileExtension>/.exec(presetXml)?.[1];

  if (fileExt && !['mov', 'mp4'].includes(fileExt.toLowerCase())) {
    errors.push(`⚠️ Output format must be .mov or .mp4 (got .${fileExt})`);
  }

  for (const src of config.sources || []) {
    let probe;
    try {
      const args = [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_streams',
        src
      ];
      const res = spawnSync(ffprobePath, args, { encoding: 'utf8' });
      if (res.status !== 0) throw new Error(res.stderr);
      probe = JSON.parse(res.stdout);
    } catch {
      errors.push(`❌ Could not read source media: ${src}`);
      continue;
    }

    const videoStream = probe.streams?.find(s => s.codec_type === 'video');
    const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
    if (videoStream && width && height) {
      const sourceRatio = videoStream.width / videoStream.height;
      const presetRatio = width / height;
      if (Math.abs(sourceRatio - presetRatio) > 0.01) {
        errors.push(
          `⚠️ ${path.basename(src)} aspect ratio mismatch: Source ${videoStream.width}x${videoStream.height}, Proxy ${width}x${height}`
        );
      }
    }

    if (videoStream && fps) {
      const [num, den] = (videoStream.avg_frame_rate || '0/1').split('/');
      const sourceFps =
        den && den !== '0'
          ? parseFloat(num) / parseFloat(den)
          : parseFloat(num);
      if (Math.abs(parseFloat(fps) - sourceFps) > 0.01) {
        errors.push(
          `⚠️ ${path.basename(src)} frame rate mismatch: Source ${sourceFps}, Proxy ${fps}`
        );
      }
    }

    if (channels && audioStream && channels !== audioStream.channels) {
      errors.push(
        `⚠️ ${path.basename(src)} audio channel mismatch: Source ${audioStream.channels}, Proxy ${channels}`
      );
    }
  }

  return errors;
}

function getActiveStages(cfg) {
  const stages = [];

  if (cfg.destination) {
    stages.push({ key: 'copy', weight: 0.4, label: '📂 Copying files' });
  }

  if (cfg.importPremiere) {
    stages.push({ key: 'import', weight: 0.05, label: '🎬 Importing media' });
  }

  if (cfg.createBins) {
    stages.push({ key: 'bins', weight: 0.05, label: '🗂 Creating bins' });
  }

  if (cfg.generateProxies) {
    stages.push({ key: 'proxies', weight: 0.5, label: '🎞 Generating proxies' });
  }

  const total = stages.reduce((s, st) => s + st.weight, 0) || 1;
  stages.forEach(st => (st.weight = st.weight / total));

  return stages;
}

// ✅ Finder-style recursive proxy collector with source name matching
function collectProxyFiles(proxyDest, sourceList = []) {
  const found = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse one level deep — covers AME subfolders
        walk(fullPath);
      } else if (/\.(mov|mp4|mxf)$/i.test(entry.name)) {
        found.push(fullPath);
      }
    }
  }

  try {
    walk(proxyDest);
  } catch {
    return { found: [], mapped: [] };
  }

  // Sort matches by similarity to original source names
  const mapped = [];
  const sources = sourceList.map(s => path.basename(s, path.extname(s)));
  for (const src of sources) {
    const match = found.find(f => f.includes(src));
    if (match) mapped.push({ original: src, proxy: match });
  }

  return { found, mapped };
}

function formatVerificationLabel(method = 'none') {
  switch ((method || '').toLowerCase()) {
    case 'bytecompare':
      return 'Byte Compare';
    case 'blake3':
      return 'BLAKE3';
    case 'sha256':
      return 'SHA-256';
    case 'md5':
      return 'MD5';
    case 'xxhash64':
      return 'xxHash64';
    default:
      return 'None';
  }
}

async function computeHashForMethod(filePath, method) {
  const normalized = (method || '').toLowerCase();
  switch (normalized) {
    case 'blake3':
      return getBlake3Hash(filePath);
    case 'sha256':
      return getSha256Hash(filePath);
    case 'md5':
      return getMd5Hash(filePath);
    case 'xxhash64':
      return getXxHashHash(filePath);
    default:
      return null;
  }
}

function parseProxyPreset(presetPath) {
  const meta = { fileExt: 'mov' };
  if (!presetPath) return meta;

  try {
    const presetXml = fs.readFileSync(presetPath, 'utf8');
    const widthMatch =
      /<VideoFrameWidth>(\d+)<\/VideoFrameWidth>/i.exec(presetXml) ||
      /<FrameWidth>(\d+)<\/FrameWidth>/i.exec(presetXml);
    const heightMatch =
      /<VideoFrameHeight>(\d+)<\/VideoFrameHeight>/i.exec(presetXml) ||
      /<FrameHeight>(\d+)<\/FrameHeight>/i.exec(presetXml);
    const fpsMatch =
      /<FrameRate>([\d.]+)<\/FrameRate>/i.exec(presetXml) ||
      /<FramesPerSecond>([\d.]+)<\/FramesPerSecond>/i.exec(presetXml);
    const channelMatch = /<AudioChannels>(\d+)<\/AudioChannels>/i.exec(presetXml);
    const extMatch =
      /<FileExt>([^<]+)<\/FileExt>/i.exec(presetXml) ||
      /<FileExtension>([^<]+)<\/FileExtension>/i.exec(presetXml);

    if (widthMatch) meta.width = parseInt(widthMatch[1], 10) || undefined;
    if (heightMatch) meta.height = parseInt(heightMatch[1], 10) || undefined;
    if (fpsMatch) meta.fps = parseFloat(fpsMatch[1]);
    if (channelMatch) meta.channels = parseInt(channelMatch[1], 10) || undefined;
    if (extMatch && extMatch[1]) {
      meta.fileExt = extMatch[1].replace(/^\./, '') || meta.fileExt;
    }
  } catch {
    // ignore parse errors and fall back to defaults
  }

  return meta;
}

function spawnFFmpegWithSignal(args, outputPath, signal) {
  return new Promise((resolve, reject) => {
    let lastLine = '';
    const lines = [];
    const finalArgs = [...args, outputPath];
    const proc = spawn(ffmpegPath, finalArgs);

    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
    };

    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      cleanup();
      reject(new Error('Proxy generation cancelled'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch {}
    }

    proc.stderr.on('data', data => {
      const s = data.toString();
      lastLine = s.trim() || lastLine;
      lines.push(s.trim());
    });

    proc.on('error', err => {
      cleanup();
      reject(err);
    });

    proc.on('close', code => {
      cleanup();
      if (code !== 0) {
        const tail = lines.slice(-25).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}.\n${tail || lastLine || 'Unknown error'}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies = []) {
  const sources = Array.isArray(groupCfg.sources) ? groupCfg.sources : [];
  if (!sources.length) return [];

  // Skip XML preset parsing in Match-Source (FFMPEG) mode
  let meta = {};
  if (groupCfg.proxyPreset && groupCfg.proxyPreset !== MATCH_SOURCE_SENTINEL) {
    meta = parseProxyPreset(groupCfg.proxyPreset);
  } else {
    meta = {}; // dynamic path: probe each file directly
  }
  const ext = 'mov';
  const isMov = ext === 'mov';
  const total = sources.length;
  const pairs = [];

  const padSupported = ffmpegSupportsFilter('pad');
  if (meta.width && meta.height && !padSupported) {
    pushLog?.('⚠️ FFmpeg pad filter is unavailable; proxies will be scaled without padding.');
  }

  const emitProgress = (percent, status = 'active') => {
    const payload = {
      id: groupCfg.jobId,
      jobId: groupCfg.jobId, // helps ID matching
      panel: 'adobe-utilities',
      stage: 'proxies',
      status,
      percent
    };
    // Electron UI
    global.queue?.emit('job-progress', payload);
    // CEP panel (so the checklist updates in FFmpeg mode too)
    try {
      global.cepBridge?.broadcast({ type: 'queue-job-progress', ...payload });
    } catch {}
  };

  emitProgress(0, 'start');

  let smoothPercent = 0;
  let interval;

  const startSmoothing = target => {
    clearInterval(interval);
    interval = setInterval(() => {
      if (smoothPercent >= target || smoothPercent >= SMOOTH_CAP) return;
      smoothPercent = Math.min(smoothPercent + SMOOTH_INCREMENT, target, SMOOTH_CAP);
      emitProgress(Math.min(smoothPercent, 99));
    }, SMOOTH_INTERVAL_MS);
  };

  try {
    for (let i = 0; i < total; i++) {
      if (groupCfg.signal?.aborted) throw new Error('Proxy generation cancelled');

      const src = sources[i];
      const base = path.basename(src).replace(/\.[^/.]+$/, '');
      const outName = `${base}_Proxy.${ext}`;
      const outputPath = path.join(groupCfg.proxyDest, outName);

      pushLog?.(`🎞 Generating proxy via FFmpeg: ${path.basename(src)} → ${outName}`);

      // Probe per-source audio layout (preserve DISCRETE track parity)
      let audioStreams = [];
      try {
        const res = spawnSync(
          ffprobePath,
          ['-v', 'quiet', '-print_format', 'json', '-show_streams', src],
          { encoding: 'utf8' }
        );
        if (res.status === 0) {
          const probe = JSON.parse(res.stdout || '{}');
          const streams = Array.isArray(probe.streams) ? probe.streams : [];
          audioStreams = streams
            .filter(s => s.codec_type === 'audio')
            .map((s, i) => ({
              inIdx: i,
              ch: Number(s.channels) || 1,
              layout: typeof s.channel_layout === 'string' ? s.channel_layout : ''
            }));
        }
      } catch (_) {}

      const audioChannels = audioStreams.reduce((sum, s) => sum + Math.max(1, s.ch), 0);

      const filters = [];
      if (meta.width && meta.height) {
        filters.push(
          `scale=${meta.width}:${meta.height}:force_original_aspect_ratio=decrease`
        );
        if (padSupported) {
          filters.push(`pad=${meta.width}:${meta.height}:(ow-iw)/2:(oh-ih)/2`);
        }
      } else if (meta.width) {
        filters.push(`scale=${meta.width}:-2`);
      }

      const filterStr = filters.join(',');
      const args = ['-y', '-i', src];
      if (filterStr) {
        args.push('-vf', filterStr);
      }
      if (meta.fps) {
        args.push('-r', String(meta.fps));
      }

      // Ensure deterministic stream selection and audio characteristics
      args.push('-map', '0:v:0');
      if (!audioStreams.length) {
        args.push('-an');
      } else {
        // Map every source audio stream 1:1 to the proxy and keep per-stream channel counts.
        // Preserves discrete layouts: mono↔mono, stereo↔stereo, dual‑mono↔dual‑mono, 8×mono↔8×mono.
        audioStreams.forEach((_s, j) => {
          args.push('-map', `0:a:${j}`);
          args.push(`-c:a:${j}`, 'pcm_s16le');
          args.push(`-ar:a:${j}`, '48000');
          args.push(`-ac:a:${j}`, String(Math.max(1, _s.ch)));
        });
      }

      if (isMov) {
        // ProRes Proxy w/ 10-bit 422 in MOV
        args.push('-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le');
        // Per‑stream audio options already added above (or -an if none)
        args.push('-f', 'mov'); // explicit container
      } else {
        // Use macOS hardware encoder present in FFmpeg build
        args.push('-c:v', 'h264_videotoolbox');
        if (meta.width && meta.height) {
          const mp = (meta.width * meta.height) / 1e6;
          const targetMbps = Math.max(2, Math.min(10, mp * 4));
          args.push('-b:v', `${Math.round(targetMbps)}M`);
        } else {
          args.push('-q:v', '50');
        }
        args.push('-pix_fmt', 'yuv420p');
        if (audioChannels > 0) {
          args.push(
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-ar',
            '48000',
            '-ac',
            String(Math.min(2, audioChannels))
          );
        } else {
          args.push('-an');
        }
      }

      // Log the full command for troubleshooting
      try {
        const printable = [ffmpegPath, ...args, outputPath]
          .map(s => (/\s/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : s))
          .join(' ');
        pushLog?.(`🧪 FFmpeg command:\n${printable}`);
      } catch {}

      smoothPercent = Math.round((i / total) * 100);
      startSmoothing(Math.min(Math.round(((i + 0.5) / total) * 100), 99));

      try {
        // Log discovered audio layout for transparency
        if (audioStreams.length) {
          const sig = `[${audioStreams.map(s => s.ch).join(',')}] (${audioStreams.length} stream${audioStreams.length>1?'s':''})`;
          pushLog?.(`🔎 Audio layout (preserved): ${sig}`);
        } else {
          pushLog?.('🔎 Audio layout: none (video‑only proxy).');
        }
        await spawnFFmpegWithSignal(args, outputPath, groupCfg.signal);
      } catch (err) {
        // Last-resort fallback to prevent hard failure if some rare muxer quirk appears.
        const msg = String(err?.message || err);
        if (isMov && /Invalid argument|codec not currently supported/i.test(msg)) {
          pushLog?.('↩️ Retrying FFmpeg with conservative stereo PCM fallback (1 stream)…');
          const retry = ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0',
            '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le',
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'mov'
          ];
          await spawnFFmpegWithSignal(retry, outputPath, groupCfg.signal);
        } else {
          throw err;
        }
      }

      clearInterval(interval);
      smoothPercent = Math.round(((i + 1) / total) * 100);
      emitProgress(Math.min(smoothPercent, 100));

      generatedProxies.push(outputPath);
      pairs.push({ original: src, proxy: outputPath });
      pushLog?.(`✅ Proxy created: ${outName}`);
    }
  } finally {
    clearInterval(interval);
  }

  emitProgress(100, 'complete');
  return pairs;
}

function broadcastProxyAttach(pairs = []) {
  if (!pairs.length) return;
  try {
    global.cepBridge?.broadcast({
      type: 'premiere-attach-proxy',
      pairs,
      data: JSON.stringify(pairs)
    });
  } catch {}
}

// ───────────────────────────────────────────────────────────────
// 🧠 Grouping Helpers: container / WxH / FPS bucket / channels
// ───────────────────────────────────────────────────────────────
function _extLower(p) {
  try { return (path.extname(p) || '').toLowerCase().replace(/^\./, ''); } catch { return ''; }
}
function _normalizeContainerFromSource(p) {
  // For now we normalize to mov|mp4 (others later).
  return _extLower(p) === 'mp4' ? 'mp4' : 'mov';
}
function _parseFps(avgOrRational) {
  if (!avgOrRational || avgOrRational === '0/0') return 0;
  if (typeof avgOrRational === 'number') return avgOrRational;
  if (String(avgOrRational).includes('/')) {
    const [n, d] = String(avgOrRational).split('/').map(Number);
    if (d && isFinite(d) && d !== 0) return n / d;
    return n || 0;
  }
  const v = parseFloat(avgOrRational);
  return isFinite(v) ? v : 0;
}
function _bucketFrameRate(fps) {
  // Coarse buckets with small tolerance for 24000/1001 etc.
  const buckets = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  if (!fps || !isFinite(fps)) return 30;
  let best = buckets[0], mind = Math.abs(fps - buckets[0]);
  for (const b of buckets) {
    const d = Math.abs(fps - b);
    if (d < mind) { mind = d; best = b; }
  }
  // generous tolerance; anything near lands in its closest bucket
  return best;
}

  /**
   * Probe verified sources and group them by container/WxH/FPS-bucket/channels/layout signature.
   * Returns an array of { attrs, sources } where attrs = { container, width, height, fpsBucket, channels, layoutSig }.
   */
function analyzeSourcesForProxyGroups(config, pushLog) {
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const groups = new Map();

  for (const src of sources) {
    let probe;
    try {
      const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', src];
      const res = spawnSync(ffprobePath, args, { encoding: 'utf8' });
      if (res.status !== 0) throw new Error(res.stderr || 'ffprobe error');
      probe = JSON.parse(res.stdout || '{}');
    } catch (err) {
      // Best-effort defaults for unprobeable files
      pushLog?.(`⚠️ Probe failed for "${path.basename(src)}" — using defaults for grouping.`);
      const attrs = { container: _normalizeContainerFromSource(src), width: 1920, height: 1080, fpsBucket: 29.97, channels: 2 };
      const key = `${attrs.container}|${attrs.width}x${attrs.height}|${attrs.fpsBucket}|${attrs.channels}`;
      if (!groups.has(key)) groups.set(key, { attrs, sources: [] });
      groups.get(key).sources.push(src);
      continue;
    }

    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const v = streams.find(s => s.codec_type === 'video');

    if (!v) {
      // Import/bins still run; proxies only for video sources
      pushLog?.(`ℹ️ Skipping non‑video source for proxies: ${path.basename(src)}`);
      continue;
    }

    const width = parseInt(v.width || 0, 10) || 1920;
    const height = parseInt(v.height || 0, 10) || 1080;
    const fpsRaw = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
    const fpsBucket = _bucketFrameRate(_parseFps(fpsRaw));
    const videoCodec = String(v.codec_name || '').toLowerCase();
    // Sum channels across all audio streams (dual‑mono, multitrack, etc.)
    const aStreams = streams.filter(s => s.codec_type === 'audio');
    const channels = aStreams.reduce((sum, s) => sum + (Number(s.channels) || 0), 0) || 2;
    const layoutSig = aStreams.map(s => Number(s.channels) || 1).join('+') || '0';
    const container = _normalizeContainerFromSource(src);
    const key = `${container}|${width}x${height}|${fpsBucket}|${channels}|${layoutSig}`;
    if (!groups.has(key))
      groups.set(key, { attrs: { container, width, height, fpsBucket, channels, layoutSig, videoCodec }, sources: [] });
    groups.get(key).sources.push(src);
  }

  return Array.from(groups.values());
}
/**
 * Dispatch ingest workflow jobs to the Adobe CEP panel.
 *
 * @param {object} config - Job configuration sent to Premiere
 * @returns {Promise<object>} result with log entries
 */
async function runAdobeUtilities(config = {}) {
  config = normalizeAdobeConfig(config);
  const validationErrors = await validateAdobeConfig(config);
  if (validationErrors.length) {
    return { success: false, log: validationErrors };
  }

  const log = [];
  const pushLog = msg => {
    sendLogMessage('adobe-utilities', msg);
    log.push(msg);
  };

  if (isMatchSourcePreset(config.proxyPreset)) {
    pushLog('✅ Match Source (FFMPEG) mode: using dynamic FFmpeg — no .epr preset involved.');
    config.proxyPreset = MATCH_SOURCE_SENTINEL;
  } else if (config.proxyPreset) {
    pushLog(`🎬 AME preset (direct): ${path.basename(config.proxyPreset)}`);
  }

  const enableN8N = !!config.enableN8N;
  const n8nUrl = typeof config.n8nUrl === 'string' ? config.n8nUrl.trim() : '';
  const n8nLog = !!config.n8nLog;

  if (enableN8N) {
    pushLog(`🌐 Webhook enabled${n8nUrl ? ` → ${n8nUrl}` : ''}`);
  }

  const generatedProxies = [];
  const jobStart = new Date();

  const jobMeta = { cancelled: false, config };
  if (config.jobId) {
    activeAdobeJobs.set(config.jobId, jobMeta);
  }

  let removeForward = bindCepForwardersForJob(config.jobId, config);

  const verificationMethod = (config.verification?.method || 'none').toLowerCase();
  const verifyEnabled = verificationMethod !== 'none';
  const verificationLabel = formatVerificationLabel(verificationMethod);
  const verificationResults = new Map();
  const verifiedForPremiere = new Set();

  const logJobCompletion = () => {
    const end = new Date();
    const durationSec = ((end - jobStart) / 1000).toFixed(1);
    const durationMin = (durationSec / 60).toFixed(1);

    pushLog('✅ Adobe Automate Job Summary');
    pushLog('──────────────────────────────');

    // Source / destination summary
    pushLog(`📦 Sources processed: ${sourceList.length}`);
    if (config.destination) pushLog(`📂 Destination: ${config.destination}`);
    if (config.importPremiere) pushLog('🎬 Imported into Premiere: Yes');
    if (config.createBins) pushLog('🗂 Bins created: Yes');
    if (config.generateProxies) {
      pushLog('🎞 Proxy generation: Enabled');
      pushLog(`   Proxy preset: ${path.basename(config.proxyPreset || '(none)')}`);
      pushLog(`   Proxy destination: ${config.proxyDest || '(default)'}`);
    }

    // File verification stats
    const totalCount = sourceList.length;
    const verifiedCount = verifiedForPremiere.size;
    const failedCount = totalCount - verifiedCount;
    if (verifyEnabled) {
      pushLog(`🧮 Verification method: ${verificationLabel}`);
      pushLog(`✅ Verified files: ${verifiedCount}/${totalCount}`);
      if (failedCount > 0)
        pushLog(`⚠️  Verification failed for ${failedCount} file(s)`);
    } else {
      pushLog('ℹ️ Verification disabled');
    }

    // Transfer metrics
    try {
      const totalBytes = sourceList.reduce((sum, src) => {
        const s = fs.statSync(src);
        return sum + (s?.size || 0);
      }, 0);
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      const mbps = (mb / (durationSec / 60)).toFixed(1);
      pushLog(`💾 Total copied: ${mb} MB`);
      pushLog(`⚡ Average throughput: ${mbps} MB/min`);
    } catch {}

    // Proxy summary — handle both FFmpeg + AME paths
    let proxies = [...generatedProxies];
    if (config.generateProxies && proxies.length === 0) {
      const tryDirs = [];
      if (config.proxyDest) tryDirs.push(config.proxyDest);
      if (config.destination) tryDirs.push(path.join(config.destination, 'Proxies'));

      for (const dir of tryDirs) {
        try {
          const { found, mapped } = collectProxyFiles(dir, sourceList);
          if (found.length) {
            proxies = found;
            pushLog(`🎬 Proxy Files Detected (${found.length}) in: ${dir}`);
            mapped.forEach(p => pushLog(`   • ${path.basename(p.proxy)}`));
            break;
          }
        } catch {}
      }
    }

    if (generatedProxies.length) {
      pushLog(`🎬 Proxy Files Created (${generatedProxies.length}):`);
      for (const p of generatedProxies) {
        pushLog(`   • ${path.basename(p)}`);
      }
    }

    if (config.generateProxies && proxies.length === 0) {
      pushLog('⚠️ No proxies found or generated.');
    } else if (config.generateProxies && proxies.length) {
      pushLog(`🔗 Proxy attachment verified for ${proxies.length} file(s).`);
    }

    // Webhook / automation
    if (config.enableN8N) {
      pushLog(`🌐 Webhook: ${config.n8nUrl || '(URL missing)'}`);
      if (config.n8nLog) pushLog('   • Sent log payload');
    }

    // Threading / retries
    if (config.enableThreads) {
      pushLog(`🧵 Threading: ${config.autoThreads ? 'Auto' : config.maxThreads || 1}`);
    }
    if (config.retryFailures) {
      pushLog('🔁 Retry on failure: Enabled');
    }

    // End markers
    pushLog('──────────────────────────────');
    pushLog(`🕒 Finished at: ${end.toLocaleString()}`);
    pushLog(`⏱ Duration: ${durationSec}s (${durationMin} min)`);
    pushLog('──────────────────────────────');
  };

  // 🔹 COPY STAGE ONLY
  // 🩹 Skip filterOutDestination for Adobe Automate — files, not folders
  const sourceList = Array.isArray(config.sources) ? config.sources.slice() : [];
  const destPathMap = new Map();
  if (config.destination) {
    sourceList.forEach(src => {
      destPathMap.set(src, path.join(config.destination, path.basename(src)));
    });
  } else {
    sourceList.forEach(src => destPathMap.set(src, src));
  }
  const originalBinMap = config.fileToBinMap ? { ...config.fileToBinMap } : {};

  async function verifyFile(src, destPath) {
    if (!verifyEnabled) return true;
    const displayPath = destPath && destPath !== src ? destPath : src;
    const displayName = path.basename(displayPath);
    try {
      if (verificationMethod === 'bytecompare') {
        const hasCopyTarget = destPath && destPath !== src && fs.existsSync(destPath);
        if (!hasCopyTarget) {
          pushLog(`⚠️ ${verificationLabel} skipped for ${displayName} (no destination copy).`);
          return false;
        }
        const identical = await compareFilesByteByByte(src, destPath);
        if (identical) {
          pushLog(`✅ ${verificationLabel} match: ${displayName}`);
          return true;
        }
        pushLog(`❌ ${verificationLabel} mismatch: ${displayName}`);
        return false;
      }

      const sourceHash = await computeHashForMethod(src, verificationMethod);
      if (!sourceHash?.hash) {
        throw new Error('Failed to compute source hash');
      }

      const hasCopyTarget = destPath && destPath !== src && fs.existsSync(destPath);
      if (!hasCopyTarget) {
        pushLog(`ℹ️ ${verificationLabel} hash generated for ${displayName} (source only).`);
        return true;
      }

      const destHash = await computeHashForMethod(destPath, verificationMethod);
      if (!destHash?.hash) {
        throw new Error('Failed to compute destination hash');
      }

      if (destHash.hash === sourceHash.hash) {
        pushLog(`✅ ${verificationLabel} match: ${displayName}`);
        return true;
      }

      pushLog(`❌ ${verificationLabel} mismatch: ${displayName}`);
      return false;
    } catch (err) {
      pushLog(`❌ Verification failed for ${displayName}: ${err.message || err}`);
      return false;
    }
  }

  async function verifyAndStore(src) {
    const destPath = destPathMap.get(src) || src;
    const verified = await verifyFile(src, destPath);
    verificationResults.set(src, verified);
    if (verified) {
      verifiedForPremiere.add(src);
    } else if (verifyEnabled && config.importPremiere) {
      const displayPath = destPath && destPath !== src ? destPath : src;
      pushLog(`⚠️ Skipping Premiere import for ${path.basename(displayPath)} due to verification failure.`);
    }
    return verified;
  }

  if (!sourceList.length) {
    pushLog('❌ No sources provided');
    try { removeForward?.(); } catch {}
    if (config.jobId) activeAdobeJobs.delete(config.jobId);
    return { success: false, log };
  }

  if (config.destination) {
    const totalBytes = sourceList.reduce((sum, src) => {
      try {
        return sum + fs.statSync(src).size;
      } catch {
        return sum;
      }
    }, 0);

    let copiedBytes = 0;

    // Optional precompute of source hashes to avoid rehashing large files
    const srcHashMap = new Map();
    if (verifyEnabled && verificationMethod !== 'none' && verificationMethod !== 'bytecompare') {
      pushLog(`🧮 Precomputing source hashes for verification (${verificationMethod})...`);
      for (const s of sourceList) {
        try {
          const stats = await fs.promises.stat(s);
          if (stats.size > 10 * 1024) {
            const res = await computeHashForMethod(s, verificationMethod);
            if (res?.hash) srcHashMap.set(s, res.hash);
          }
        } catch (err) {
          pushLog(`⚠️ Failed to precompute hash for ${path.basename(s)}: ${err.message}`);
        }
      }
    }

    for (const src of sourceList) {
      if (config.signal?.aborted) {
        pushLog('🛑 Copy cancelled');
        jobMeta.cancelled = true;
        try { removeForward?.(); } catch {}
        if (config.jobId) activeAdobeJobs.delete(config.jobId);
        return { success: false, cancelled: true, log };
      }
      const destPath = destPathMap.get(src) || path.join(config.destination, path.basename(src));
      const tempDestPath = `${destPath}.partial`;

      try {
        // Copy to temp file first
        await copyFileWithProgress(
          src,
          tempDestPath,
          (_percent, chunkSize) => {
            if (config.signal?.aborted) throw new Error('cancelled');
            copiedBytes += chunkSize;
            const percent = Math.min((copiedBytes / totalBytes) * 100, 100);
            global.queue?.emit('job-progress', {
              id: config.jobId,
              panel: 'adobe-utilities',
              stage: 'copy',
              percent
            });
          },
          config.signal
        );

        // Ensure data hits disk before rename (best effort)
        try {
          const fd = await fs.promises.open(tempDestPath, 'r');
          await fd.sync();
          await fd.close();
        } catch {}

        // Atomic rename promotion (with cross-volume fallback)
        try {
          await fs.promises.rename(tempDestPath, destPath);
        } catch (renameErr) {
          if (renameErr.code === 'EXDEV') {
            await fs.promises.copyFile(tempDestPath, destPath);
            await fs.promises.unlink(tempDestPath).catch(() => {});
          } else {
            await fs.promises.unlink(tempDestPath).catch(() => {});
            throw renameErr;
          }
        }

        // Checksum or byte compare verification (src ↔ dest)
        if (verifyEnabled && verificationMethod !== 'none') {
          if (verificationMethod === 'bytecompare') {
            const identical = await compareFilesByteByByte(src, destPath);
            if (!identical) {
              await fs.promises.unlink(destPath).catch(() => {});
              throw new Error('Byte-level mismatch');
            }
          } else {
            let srcHash = srcHashMap.get(src);
            if (!srcHash) {
              const srcRes = await computeHashForMethod(src, verificationMethod);
              srcHash = srcRes?.hash;
              if (srcHash) srcHashMap.set(src, srcHash);
            }

            const destRes = await computeHashForMethod(destPath, verificationMethod);
            const destHash = destRes?.hash;

            if (!srcHash || !destHash || srcHash !== destHash) {
              await fs.promises.unlink(destPath).catch(() => {});
              throw new Error('Checksum mismatch (src vs dest)');
            }
            pushLog(`✅ Checksum verified (${verificationMethod}) for ${path.basename(src)}`);
          }
        }

        pushLog(`✅ Copied: ${path.basename(src)}`);
        verificationResults.set(src, true);
        verifiedForPremiere.add(src);
      } catch (err) {
        if (err?.message === 'cancelled' || err?.name === 'AbortError') {
          pushLog('🛑 Copy cancelled');
          jobMeta.cancelled = true;
          try { removeForward?.(); } catch {}
          if (config.jobId) activeAdobeJobs.delete(config.jobId);
          return { success: false, cancelled: true, log };
        }
        await fs.promises.unlink(tempDestPath).catch(() => {});
        pushLog(`❌ Copy/verify failed: ${path.basename(src)} → ${err.message || err}`);
      }
    }
    global.queue?.emit('job-progress', {
      id: config.jobId,
      panel: 'adobe-utilities',
      stage: 'copy',
      percent: 100
    });

  }

  for (const src of sourceList) {
    if (!verificationResults.has(src)) {
      await verifyAndStore(src);
    }
  }

  if (verifyEnabled) {
    const totalCount = sourceList.length;
    const verifiedCount = verifiedForPremiere.size;
    pushLog(
      `ℹ️ Verification summary (${verificationLabel}): ${verifiedCount}/${totalCount} file(s) verified.`
    );
    const verifiedSources = Array.from(verifiedForPremiere);
    const mappedSources = verifiedSources.map(src => destPathMap.get(src) || src);
    if (config.importPremiere) {
      const skippedCount = totalCount - verifiedSources.length;
      if (skippedCount > 0) {
        pushLog(`⚠️ ${skippedCount} file(s) will be omitted from Premiere import due to verification.`);
      }
      if (!mappedSources.length) {
        pushLog('⚠️ No verified files available for Premiere import.');
      }
    }
    config.sources = mappedSources;
    if (config.fileToBinMap) {
      const newMap = {};
      for (const src of verifiedSources) {
        const dest = destPathMap.get(src) || src;
        const bin = originalBinMap[src] || originalBinMap[dest];
        if (bin) newMap[dest] = bin;
      }
      config.fileToBinMap = newMap;
    }
    if (!config.sources.length && config.generateProxies) {
      pushLog('⚠️ Disabling proxy generation because no verified files remain.');
      config.generateProxies = false;
    }
  } else if (config.importPremiere) {
    const mappedSources = sourceList.map(src => destPathMap.get(src) || src);
    config.sources = mappedSources;
    if (config.fileToBinMap) {
      const newMap = {};
      for (const src of sourceList) {
        const dest = destPathMap.get(src) || src;
        const bin = originalBinMap[src] || originalBinMap[dest];
        if (bin) newMap[dest] = bin;
      }
      config.fileToBinMap = newMap;
    }
  }

  // 🔹 Ensure valid proxy destination if proxies are enabled
  if (config.generateProxies) {
    let baseProxy = null;

    if (config.proxyDest && config.proxyDest.trim() !== '') {
      baseProxy = config.proxyDest;
    } else if (config.destination && config.destination.trim() !== '') {
      baseProxy = config.destination;
    }

    if (baseProxy) {
      config.proxyDest = baseProxy.endsWith('Proxies')
        ? baseProxy
        : path.join(baseProxy, 'Proxies');
      try {
        fs.mkdirSync(config.proxyDest, { recursive: true });
        pushLog(`📁 Proxy folder ready: ${config.proxyDest}`);
      } catch (err) {
        pushLog(`⚠️ Could not create proxy directory: ${err.message}`);
      }
    } else {
      pushLog('⚠️ Proxy generation disabled (no valid destination).');
      config.generateProxies = false;
    }
  }

  const ameAvailable = isAMEAvailable(pushLog);

  const forceFfmpegForMatchSource = config.proxyPreset === MATCH_SOURCE_SENTINEL;
  if (forceFfmpegForMatchSource) {
    pushLog('Match Source (FFMPEG) selected — forcing FFmpeg-only proxy generation (AME bypassed).');
  }

  if (config.generateProxies) {
    // Simplified: do NOT split into multiple groups. Treat all sources as one AME job.
    // This avoids duplicate imports / duplicate proxy generation when only one AME job is desired.
    pushLog('🔎 Single-group mode: treating all sources as a single AME job (grouping disabled).');
    // Use the paths Premiere actually imported (DESTINATION-mapped), not the original inputs.
    const baseSources = Array.isArray(config.sources)
      ? config.sources.slice()
      : sourceList.slice();
    const groups = [{ attrs: {}, sources: baseSources }];

    if (isMatchSourcePreset(config.proxyPreset)) {
      pushLog('⚙️ Using dynamic Match Source (FFMPEG) configuration — no .epr preset required.');
    }
    // Hint JSX to reset sticky proxy state before queueing AME
    config.resetBeforeProxies = true;
    const seenProxyPaths = new Set();
    let totalCreated = 0;
    const trackNewProxies = paths => {
      let added = 0;
      for (const p of paths || []) {
        if (!p) continue;
        const key = path.normalize(p);
        if (!seenProxyPaths.has(key)) {
          seenProxyPaths.add(key);
          added++;
        }
      }
      if (added > 0) totalCreated += added;
      return added;
    };

    // No user prompt for mixed sources — user requested single AME job behavior.
    // (If you later need protective cancellation, add it explicitly.)

    if (!groups.length) {
      pushLog('ℹ️ No proxy-eligible video sources detected; running ingest without proxies.');
      const cepNoProxy = { ...config, generateProxies: false };
      if (global.cepBridge) {
        global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: cepNoProxy });
        pushLog('🚀 Sent ingest (no proxies) to CEP (no wait).');
      }
    }

    // 🧩 Simplified flow — always import first, then generate proxies (no duplicates)
    const ameAvailable = isAMEAvailable(pushLog);

    // ✅ Import sources into Premiere only once before proxy generation
    // Prevents double-import and duplicate proxy creation during AME runs.
    if (groups.length && config.importPremiere && !config._importedAlready) {
      pushLog('🎬 Importing sources into Premiere before first proxy generation…');
      const importCfg = {
        ...config,
        generateProxies: false,
        premiereImportOnly: false,
        _importedAlready: true
      };
      if (global.cepBridge) {
        global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: importCfg });
        pushLog('🚀 Sent import to CEP (no wait).');
      }
    }

    if (config.generateProxies && forceFfmpegForMatchSource) {
      pushLog('🎞 Running FFmpeg-only proxy generation (Match Source mode).');
      for (const g of groups) {
        if (config.signal?.aborted) break;
        const groupCfg = { ...config, sources: g.sources, importPremiere: false };
        try {
          const pairs = await generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies);
          if (pairs?.length) {
            // ✅ The "original" for proxy attachment must be the destination copy, not the source.
            const attachPairs = pairs.map(p => ({
              original: destPathMap?.get?.(p.original) || p.original,
              proxy: p.proxy
            }));
            trackNewProxies(pairs.map(p => p.proxy));
            broadcastProxyAttach(attachPairs);
            pushLog(`🔗 Attached ${pairs.length} proxy file(s) generated by FFmpeg.`);
          } else {
            pushLog('ℹ️ FFmpeg produced no proxies for this group.');
          }
        } catch (err) {
          pushLog(`❌ FFmpeg group generation failed: ${err.message || err}`);
        }
      }
    } else if (config.generateProxies && ameAvailable) {
      pushLog('🎞 Starting AME proxy generation (direct preset)…');
      for (const g of groups) {
        const proxyPresetPath = config.proxyPreset;
        if (!fileExists(proxyPresetPath)) {
          pushLog(`⚠️ Skipping AME for this group — preset not found: ${proxyPresetPath}`);
          continue;
        }

        const groupCfg = {
          ...config,
          sources: g.sources.slice(),
          proxyPreset: proxyPresetPath,
          generateProxies: true,
          importPremiere: false, // ✅ import already done
          premiereImportOnly: false
        };

        // Mark that import has already occurred for this job
        groupCfg._importedAlready = true;

        pushLog(`🚀 Dispatching AME proxy job for ${g.sources.length} file(s) using ${path.basename(proxyPresetPath)}…`);

        if (global.cepBridge) {
          global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: groupCfg });
          pushLog('🚀 Sent AME proxy job to CEP (no wait).');
        }
        // ⛳ No safety/timeout attach here — AME onProxyComplete in JSX does the real attach immediately.
      }
    } else if (config.generateProxies) {
      pushLog('⚠️ AME not detected — skipping forced AME proxy queue.');
    }

    // (Second temp‑EPR pass removed — attachments handled per‑group above.)

    if (totalCreated > 0) {
      pushLog(`🎞 Proxy Files Created (${totalCreated}).`);
    }
  } else {
    // No proxies: fire-and-forget CEP run (import/bins). JSX will emit completion.
    if (global.cepBridge) {
      global.cepBridge.broadcast({ type: 'runIngestWorkflow', config });
      pushLog('🚀 Sent ingest (no proxies) to CEP (no wait).');
    }
  }

  // ⛔ Do NOT print the final summary here for proxy runs.
  // The proxies path completes asynchronously in JSX; printing now creates
  // a misleading "No proxies found..." line and confuses the panels.
  if (!config.generateProxies) {
    logJobCompletion();
  }

  if (enableN8N) {
    if (n8nUrl) {
      const payload = n8nLog
        ? { log }
        : {
            status: 'complete',
            panel: 'adobe-utilities',
            success: true,
            sources: Array.isArray(config.sources) ? config.sources.length : 0,
            destination: config.destination || '',
            importedIntoPremiere: !!config.importPremiere,
            generatedProxies: !!config.generateProxies
          };

      pushLog(`🛰️ Preparing to send data to: ${n8nUrl}`);
      pushLog(`📦 Payload preview:\n${JSON.stringify(payload, null, 2)}`);

      try {
        const fetch = (...args) =>
          import('node-fetch').then(({ default: fetch }) => fetch(...args));
        await fetch(n8nUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        pushLog('🌐 n8n webhook triggered');
      } catch (err) {
        pushLog(`⚠️ Failed to trigger n8n webhook: ${err?.message || err}`);
      }
    } else {
      pushLog('⚠️ Webhook enabled but no URL provided.');
    }
  }

  // Only write the log immediately for jobs that truly end here (no proxies).
  if (!config.generateProxies && config.saveLog && config.destination) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `AdobeAutomateLog_${timestamp}.txt`;
    const logPath = path.join(config.destination, filename);

    try {
      const wrote = writeLogToFile(log, logPath);
      if (wrote) {
        pushLog(`📄 Log saved to destination: ${logPath}`);
      } else {
        pushLog(`⚠️ Failed to write destination log: ${logPath}`);
      }
    } catch (err) {
      pushLog(`⚠️ Failed to write destination log: ${err?.message || err}`);
    }
  }

  const finalPayload = {
    id: config.jobId,
    panel: 'adobe-utilities',
    status: 'completed',
    source: 'backend',
    config
  };

  try {
    // Only self-finalize when proxies are NOT enabled.
    if (!finalPayload.config?.generateProxies) {
      global.queue?.emit('job-progress', {
        id: config.jobId,
        panel: 'adobe-utilities',
        stage: 'complete',
        status: 'complete',
        percent: 100
      });
      global.queue?.emit('job-complete', finalPayload);
      if (global.cepBridge) {
        global.cepBridge.broadcast({
          type: 'queue-job-complete',
          panel: 'adobe-utilities',
          job: finalPayload
        });
      }
    }
  } catch (err) {
    console.error('⚠️ Final completion emit failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // PROXY PATH (MIRROR OLD): finish on either
  //  • JSX 'queue-job-complete'  (origin:'jsx'), OR
  //  • 'queue-job-progress' with stage:'proxies', status:'complete', percent:100.
  // Also be tolerant to missing jobId on these packets (OLD was).
  // Clean up and write the final summary/log at the moment of true finish.
  // ─────────────────────────────────────────────────────────────
  if (finalPayload.config?.generateProxies && global.cepBridge) {
    return await new Promise(resolve => {
      let settled = false;
      let doneTimer = null;

      const finalize = (originHint = 'jsx') => {
        if (settled) return;
        settled = true;
        try { clearTimeout(doneTimer); } catch {}
        try { global.cepBridge?.off?.('queue-job-complete', onMessage); } catch {}
        try { global.cepBridge?.off?.('queue-job-progress', onMessage); } catch {}
        try { global.cepBridge?.off?.('message', onMessage); } catch {}
        try { removeForward?.(); } catch {}
        if (config.jobId) activeAdobeJobs.delete(config.jobId);

        // Write final summary (proxy path) and optionally save the log
        try { logJobCompletion(); } catch {}
        if (config.saveLog && config.destination) {
          try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `AdobeAutomateLog_${timestamp}.txt`;
            const logPath = require('path').join(config.destination, filename);
            writeLogToFile?.(log, logPath);
          } catch {}
        }

        // One authoritative completion with final log (renderer expects this)
        const resultPayload = {
          id: config.jobId,
          panel: 'adobe-utilities',
          status: 'completed',
          source: 'backend',
          origin: originHint,
          config,
          result: { success: true, log, config }
        };
        try {
          global.queue?.emit('job-progress', {
            id: config.jobId,
            panel: 'adobe-utilities',
            stage: 'complete',
            status: 'complete',
            percent: 100
          });
          global.queue?.emit('job-complete', resultPayload);
          global.cepBridge?.broadcast({
            type: 'queue-job-complete',
            panel: 'adobe-utilities',
            job: resultPayload
          });
        } catch {}
        resolve({ success: true, log, config });
      };

      const armFallback = () => {
        try { clearTimeout(doneTimer); } catch {}
        // short grace in case the explicit complete lands right after proxies:complete
        doneTimer = setTimeout(() => finalize('progress'), 1200);
      };

      const sameJob = d => {
        const incomingId = String(d?.jobId || d?.job?.jobId || d?.job?.id || '');
        // OLD tolerated empty/omitted jobId; only reject on a *mismatched* non-empty id
        if (!config.jobId) return true;
        if (!incomingId) return true;
        return String(config.jobId) === incomingId;
      };

      const onMessage = msg => {
        let d;
        try { d = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return; }
        if (!d || (d.panel && d.panel !== 'adobe-utilities')) return;
        const type = d.type || '';

        if (type === 'queue-job-complete') {
          const isJsx = d?.origin === 'jsx' || d?.job?.origin === 'jsx';
          if (isJsx && sameJob(d)) return finalize('jsx');
          return;
        }
        if (type === 'queue-job-progress') {
          if (!sameJob(d)) return;
          const st = String(d.stage || '').toLowerCase();
          const status = String(d.status || '').toLowerCase();
          const pct = Number(d.percent || 0);
          if (st === 'proxies' && status === 'complete' && pct >= 100) {
            armFallback();
          }
        }
      };

      global.cepBridge.on('queue-job-complete', onMessage);
      global.cepBridge.on('queue-job-progress', onMessage);
      global.cepBridge.on('message', onMessage);
    });
  }

  // No proxies: finish immediately (legacy behavior).
  try { removeForward?.(); } catch {}
  if (config.jobId) activeAdobeJobs.delete(config.jobId);
  return { success: true, log, config };
}

function cancelAdobeUtilities(jobId) {
  const job = activeAdobeJobs.get(jobId);
  if (job) {
    job.cancelled = true;
    sendLogMessage('adobe-utilities', `🛑 Cancel requested for ${jobId}`);
    activeAdobeJobs.delete(jobId);
    if (global.cepBridge) {
      global.cepBridge.broadcast({
        type: 'queue-job-cancelled',
        panel: 'adobe-utilities',
        id: jobId
      });
    }
  }
}

module.exports = {
  runAdobeUtilities,
  cancelAdobeUtilities,
  validateAdobeConfig,
  StageProgressManager
};
