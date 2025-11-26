(() => {


/* global setupStyledDropdown, setDropdownValue */
  // Collapse all detail sections on load
document.querySelectorAll('#transcode details').forEach(section => {
  section.open = false;
});

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}

const watchUtils = window.watchUtils;

function autoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function setupResizableGrid(gridEl, storageKey) {
  if (!gridEl || gridEl.dataset.resizable === '1') return;
  gridEl.dataset.resizable = '1';

  const COL_VARS = [
    '--col-file', '--col-format', '--col-resolution',
    '--col-fps', '--col-audio', '--col-duration'
  ];

  // Restore saved widths
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    COL_VARS.forEach(v => { if (saved[v]) gridEl.style.setProperty(v, saved[v]); });
  } catch {}

  const headers = gridEl.querySelectorAll('.file-info-grid-header');
  headers.forEach((h, idx) => {
    h.style.position = 'relative';
    const handle = document.createElement('span');
    handle.className = 'resize-handle';
    handle.title = 'Drag to resize • Double‑click to auto‑fit';
    h.appendChild(handle);

    let startX = 0, startW = 0;

    const finish = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      gridEl.classList.remove('resizing');
      // Persist current sizes
      const map = {};
      COL_VARS.forEach(v => {
        const val = gridEl.style.getPropertyValue(v);
        if (val) map[v] = val.trim();
      });
      try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const newW = Math.max(90, startW + dx); // clamp min width
      gridEl.style.setProperty(COL_VARS[idx], newW + 'px');
    };

    const onUp = () => finish();

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = h.getBoundingClientRect().width;
      gridEl.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double‑click header to auto‑fit column to content
    h.addEventListener('dblclick', () => {
      // children: 6 header cells, then body cells repeating in groups of 6
      const all = Array.from(gridEl.children);
      const body = all.slice(6);
      let maxW = h.scrollWidth;
      for (let i = idx; i < body.length; i += 6) {
        const w = body[i]?.scrollWidth || 0;
        if (w > maxW) maxW = w;
      }
      const pad = 24;
      const newW = Math.min(Math.max(maxW + pad, 90), gridEl.clientWidth - 60);
      gridEl.style.setProperty(COL_VARS[idx], newW + 'px');
      // persist after auto-fit
      const map = {};
      COL_VARS.forEach(v => {
        const val = gridEl.style.getPropertyValue(v);
        if (val) map[v] = val.trim();
      });
      try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
    });
  });
}

const FILE_INFO_HEADERS = `
  <div class="file-info-grid-header">File</div>
  <div class="file-info-grid-header">Format</div>
  <div class="file-info-grid-header">Resolution</div>
  <div class="file-info-grid-header">FPS</div>
  <div class="file-info-grid-header">Audio</div>
  <div class="file-info-grid-header">Duration</div>
`;

function resetFileInfoGrid(panelId, storageKey) {
  const infoEl = document.getElementById(`${panelId}-file-info`);
  if (!infoEl) return null;
  infoEl.classList.add('file-info-grid');
  infoEl.classList.add('placeholder');
  infoEl.innerHTML = FILE_INFO_HEADERS;
  delete infoEl.dataset.resizable;

  const COL_VARS = [
    '--col-file',
    '--col-format',
    '--col-resolution',
    '--col-fps',
    '--col-audio',
    '--col-duration'
  ];
  COL_VARS.forEach(v => infoEl.style.removeProperty(v));

  if (storageKey) {
    try { localStorage.removeItem(storageKey); } catch {}
  }

  const wrapper = infoEl.closest('.file-info-scroll');
  if (wrapper) {
    wrapper.scrollLeft = 0;
    wrapper.classList.add('no-hscroll');
  }

  return infoEl;
}

function prepareFileInfoGrid(panelId) {
  const infoEl = document.getElementById(`${panelId}-file-info`);
  if (!infoEl) return null;
  infoEl.classList.add('file-info-grid');
  infoEl.classList.remove('placeholder');
  infoEl.innerHTML = FILE_INFO_HEADERS;
  delete infoEl.dataset.resizable;

  const wrapper = infoEl.closest('.file-info-scroll');
  if (wrapper) {
    wrapper.classList.remove('no-hscroll');
  }

  return infoEl;
}

let currentJobId = null;
let lastProgressSnapshot = { completed: 0, total: 0 };

function ensureTranscodeHamsterStructure(root) {
  if (!root) return;
  if (root.querySelector('.wheel')) return;
  root.innerHTML = `
    <div class="wheel"></div>
    <div class="hamster">
      <div class="hamster__body">
        <div class="hamster__head">
          <div class="hamster__ear"></div>
          <div class="hamster__eye"></div>
          <div class="hamster__nose"></div>
        </div>
        <div class="hamster__limb hamster__limb--fr"></div>
        <div class="hamster__limb hamster__limb--fl"></div>
        <div class="hamster__limb hamster__limb--br"></div>
        <div class="hamster__limb hamster__limb--bl"></div>
        <div class="hamster__tail"></div>
      </div>
    </div>
    <div class="spoke"></div>
  `;
}

function showTranscodeHamster() {
  const status = document.getElementById('transcode-job-status');
  if (!status) return;
  let wheel = status.querySelector('.wheel-and-hamster');
  if (!wheel) {
    wheel = document.createElement('div');
    wheel.className = 'wheel-and-hamster';
    status.appendChild(wheel);
  }
  ensureTranscodeHamsterStructure(wheel);
  status.style.display = 'block';
  status.dataset.jobActive = 'true';
}

function hideTranscodeHamster() {
  const status = document.getElementById('transcode-job-status');
  if (!status) return;
  delete status.dataset.jobActive;
  status.style.display = 'none';
  status.querySelector('.wheel-and-hamster')?.remove();
}

function ensureTranscodeEtaInline() {
  const host = document.getElementById('transcode-loader-inline');
  if (!host) return null;
  let eta = document.getElementById('transcode-eta-inline');
  if (!eta) {
    eta = document.createElement('span');
    eta.id = 'transcode-eta-inline';
    eta.className = 'eta-inline';
    host.appendChild(eta);
  }
  return eta;
}

function resetTranscodeProgressUI() {
  const bar = document.getElementById('transcode-progress');
  const out = document.getElementById('transcode-progress-output');
  if (bar) { bar.value = 0; bar.style.display = 'none'; }
  if (out) out.value = '';
  const eta = document.getElementById('transcode-eta-inline');
  if (eta) eta.textContent = '';
  hideTranscodeHamster();
}

function logTranscode(msg, opts = {}) {
  window.logPanel?.log('transcode', msg, opts);
}

// Compatibility resolution now comes from the backend Codex API (no local maps).
// We retain the map names as transient caches so existing helpers keep working.
const __compatCache = new Map(); // format -> {containers,resolutions,frameRates,pixelFormats,audioCodecs,defaults}

// ✅ Declare compatibility maps before they are used
const resolutionCompatibility = {};   // populated from Codex at runtime
const pixelFormatCompatibility = {};  // populated from Codex at runtime
const audioCodecCompatibility = {};   // populated from Codex at runtime
const sampleRateCompatibility = {};   // populated from Codex at runtime
const channelCompatibility = {};      // populated from Codex at runtime
const frameRateCompatibility = {};    // populated from Codex at runtime

function isAudioOnlyFile(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return ['mp3', 'aac', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext);
}

const presetDir = window.electron.resolvePath('config', 'presets', 'transcode');

function getFileMetadata(filePath) {
  return window.electron.ffprobeJson(filePath).then(data => {
    if (data?.error) {
      return Promise.reject(data.error);
    }
    return data;
  });
}

async function containsDNXSource(files) {
  for (const f of files) {
    try {
      const data = await getFileMetadata(f);
      const v = data.streams.find(s => s.codec_type === 'video');
      if (v?.codec_name && v.codec_name.toLowerCase().startsWith('dnx')) {
        return true;
      }
    } catch {
      /* ignore errors */
    }
  }
  return false;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function parseFrameRate(rFrameRate) {
  if (!rFrameRate || rFrameRate === '0/0') return 'N/A';
  const [num, denom] = rFrameRate.split('/').map(Number);
  return `${(num / denom).toFixed(3)} fps`;
}

function formatFrameRateForGrid(metadata) {
  if (!metadata || !Array.isArray(metadata.streams)) return 'N/A';

  const videoStream = metadata.streams.find(s => s.codec_type === 'video');
  if (!videoStream) return 'N/A';

  const r = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
  if (!r || r === '0/0') return 'N/A';

  const parts = r.split('/');
  if (parts.length !== 2) return r;

  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return r;

  let fps = num / den;

  // Snap to common broadcast rates to avoid ugly 29.970029...
  const snap = (x, target) => Math.abs(x - target) < 0.01;
  if (snap(fps, 23.976)) fps = 23.976;
  else if (snap(fps, 24)) fps = 24;
  else if (snap(fps, 25)) fps = 25;
  else if (snap(fps, 29.97)) fps = 29.97;
  else if (snap(fps, 30)) fps = 30;
  else if (snap(fps, 50)) fps = 50;
  else if (snap(fps, 59.94)) fps = 59.94;
  else if (snap(fps, 60)) fps = 60;

  // Interlaced? (field_order like 'tb', 'bt', etc.)
  const fo = String(videoStream.field_order || '').toLowerCase();
  const isInterlaced = fo && fo !== 'progressive' && fo !== 'unknown';

  // Timecode tag: semicolon = drop-frame
  const tc =
    (videoStream.tags && videoStream.tags.timecode) ||
    (metadata.format && metadata.format.tags && metadata.format.tags.timecode) ||
    '';

  const hasTC = !!tc;
  const isDrop = hasTC && tc.includes(';');

  // If interlaced 29.97, treat as 59.94 fields/s for display
  let displayRate = fps;
  if (isInterlaced && snap(fps, 29.97)) {
    displayRate = fps * 2; // 29.97 frames → 59.94 fields
  }

  const rateStr = displayRate.toFixed(2).replace(/\.00$/, '');
  const tcSuffix = hasTC ? (isDrop ? 'DF' : 'NDF') : 'fps';

  return `${rateStr} ${tcSuffix}`;
}

// ─── Container + audio helpers (match Adobe panel semantics) ────────────────
function _normalizeExt(p) {
  const m = /\.([^.]+)$/.exec(String(p || ''));
  return (m && m[1] ? m[1].toLowerCase() : '');
}
function resolveContainerLabel(metadata, filePath) {
  const ext = _normalizeExt(filePath);
  const up = ext ? ext.toUpperCase() : '';
  const reported = (metadata?.format?.format_name || '').toLowerCase();
  if (!reported) return up || 'N/A';
  const tokens = reported.split(',').map(s => s.trim());
  if (ext && tokens.includes(ext)) return up;
  if (tokens.includes('matroska')) {
    if (ext === 'mkv') return 'MKV';
    if (ext === 'webm') return 'WEBM';
  }
  if (tokens.includes('image2') && up) return up;
  if (tokens.includes('mov') && ext === 'mp4') return 'MP4';
  if (tokens.includes('mp4') && ext === 'mov') return 'MOV';
  return (tokens[0] || up || 'N/A').toUpperCase();
}
function summarizeAudioStreams(streams = []) {
  const aud = streams.filter(s => s.codec_type === 'audio');
  if (!aud.length) return { codec: 'N/A', label: '', tracks: 0 };
  const codecs = [...new Set(aud.map(s => String(s.codec_name || '').toUpperCase()))];
  const codec = codecs.length === 1 ? codecs[0] : codecs.join('+');
  const total = aud.reduce((sum, s) => sum + (s.channels || 0), 0);
  const allMono = aud.every(s => (s.channels || 0) === 1);
  let label = '';
  if (total === 1) label = 'Mono';
  else if (total === 2) label = 'Stereo';
  else label = `${total}ch${allMono ? ' (multi-mono)' : ''}`;
  return { codec, label, tracks: aud.length };
}

async function summarizeTranscodeFile(filePath) {
  const name =
    (window.electron?.basename && window.electron.basename(filePath)) ||
    (filePath.split(/[\\\/]/).pop());

  try {
    const md = await getFileMetadata(filePath);
    const container = resolveContainerLabel(md, filePath);
    const v = (md.streams || []).find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(md.streams || []);

    const res = v ? `${v.width}×${v.height}` : (audioInfo.tracks > 0 ? 'Audio only' : 'N/A');
    const fps = formatFrameRateForGrid(md);
    const dur = formatDuration(+md.format?.duration || 0);

    const vc = v?.codec_name ? v.codec_name.toUpperCase() : '';

    const line1 = `🎞️ ${name}`;
    const line2 = `  ${container}  ${res}${fps ? `  ${fps}` : ''}`;
    const line3 = `  🎧 ${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}${vc ? ` • 🎬 ${vc}` : ''} • ${dur}`;
    return [line1, line2, line3].join('\n');
  } catch (err) {
    return `❌ ${name} — ${String(err)}`;
  }
}

function setDropdownIfNeeded(id, value) {
  if (!value) return;
  const hidden = document.getElementById(id);
  const list = hidden?.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!hidden || !list) return;
  const exists = [...list.children].some(li => li.dataset.value === value);
  if (!exists) {
    const li = document.createElement('li');
    li.dataset.value = value;
    li.textContent = value;
    list.appendChild(li);
  }
  setDropdownValue(id, value);
}

async function applyMatchSource() {
  const files = JSON.parse(el.inputFiles.dataset.fileList || '[]');
  if (!files.length) return false;
  const meta = await window.electron.getSourceMetadata?.(files[0]);
  if (!meta) return false;
  const res = `${meta.width}x${meta.height}`;
  let fps = '';
  if (meta.avg_frame_rate) {
    const [n, d] = String(meta.avg_frame_rate).split('/');
    if (d && Number(d)) {
      fps = (Number(n) / Number(d)).toFixed(3);
    }
  }
  setDropdownIfNeeded('resolution', res);
  if (fps) setDropdownIfNeeded('frameRate', fps);
  return true;
}

async function updateFileInfoDisplay(filePath) {
  const infoBox = prepareFileInfoGrid('transcode');
  if (!infoBox) return;

  try {
    const metadata = await getFileMetadata(filePath);
    const container = resolveContainerLabel(metadata, filePath);
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(streams);

    const duration = formatDuration(+metadata.format?.duration || 0);
    const resolution = videoStream ? `${videoStream.width}×${videoStream.height}` : (audioInfo.tracks > 0 ? 'Audio only' : 'N/A');
    const frameRate = formatFrameRateForGrid(metadata);

    const row = `
      <div class="file-info-row">
        <div>${window.electron.basename(filePath)}</div>
        <div>${container || 'N/A'}</div>
        <div>${resolution}</div>
        <div>${frameRate}</div>
        <div>${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}</div>
        <div>${duration}</div>
      </div>`;
    infoBox.insertAdjacentHTML('beforeend', row);
  } catch (err) {
    const row = `
      <div class="file-info-row">
        <div>${window.electron.basename(filePath)}</div>
        <div style="grid-column: span 5;">❌ ${err}</div>
      </div>`;
    infoBox.insertAdjacentHTML('beforeend', row);
  }

  setupResizableGrid(infoBox, 'gridCols-transcode');
}

// Bootstrap caches from backend Codex once at startup (formats + audio constraints).
(async () => {
  try {
    const formats = await window.codex?.listFormats?.();
    for (const fmt of (formats || [])) {
      const compat = await window.codex?.getCompatibility?.(fmt);
      if (!compat) continue;
      __compatCache.set(fmt, compat);
      resolutionCompatibility[fmt] = compat?.resolutions || [];
      pixelFormatCompatibility[fmt] = compat?.pixelFormats || [];
      frameRateCompatibility[fmt] = compat?.frameRates || [];
      audioCodecCompatibility[fmt] = compat?.audioCodecs || [];
    }
    const audioList = await window.codex?.listAudioCodecs?.();
    for (const c of (audioList || [])) {
      const ac = await window.codex?.getAudioConstraints?.(c);
      sampleRateCompatibility[c] = ac?.sampleRates || [];
      channelCompatibility[c] = ac?.channels || [];
    }
  } catch (err) {
    console.error('❌ Codex bootstrap failed:', err);
  }
})();


async function enforceLicenseLocks() {
  // No license object in test/non‑Electron environments → leave options unlocked
  if (!window.license?.isFeatureEnabled) return;
  const items = Array.from(document.querySelectorAll('[data-locked]'));
  await Promise.all(items.map(async (option) => {
    const key = option.value;
    try {
      const ok = await window.license.isFeatureEnabled(key);
      if (!ok) {
        option.disabled = true;
        option.textContent = `${option.textContent} 🔒`;
        option.title = 'Requires a license';
      }
    } catch {
      /* on IPC failure, fail open */
    }
  }));
}

async function filterContainerOptions(format) {
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const valid = compat?.containers || [];
  const hidden = document.getElementById('containerFormat');
  const list = hidden?.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!list || !hidden) return;
  [...list.children].forEach(li => {
    const isValid = valid.includes(li.dataset.value);
    li.style.display = isValid ? '' : 'none';
  });
  if (!valid.includes(hidden.value)) {
    setDropdownValue('containerFormat', valid[0] || '');
  }
}



async function filterResolutionOptions(format, el) {
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  filterGenericOptions(el.resolution, compat?.resolutions || []);
}

async function filterPixelFormats(format, el) {
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  filterGenericOptions(el.pixelFormat, compat?.pixelFormats || []);
}

async function filterAudioCodecs(format, el) {
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  filterGenericOptions(el.audioCodec, compat?.audioCodecs || []);
}

async function filterSampleRates(_format, el) {
  const codec = el.audioCodec?.value || '';
  const ac = await window.codex?.getAudioConstraints?.(codec);
  filterGenericOptions(el.sampleRate, ac?.sampleRates || []);
}

async function filterChannels(_format, el) {
  const codec = el.audioCodec?.value || '';
  const ac = await window.codex?.getAudioConstraints?.(codec);
  filterGenericOptions(el.channels, ac?.channels || []);
}

function filterGenericOptions(hiddenEl, allowed) {
  if (!hiddenEl) return;
  const list = hiddenEl.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!list) return;
  [...list.children].forEach(li => {
    const baseVal = li.dataset.value.endsWith('df') ? li.dataset.value.replace('df', '') : li.dataset.value;
    const valid = !allowed || allowed.includes(li.dataset.value) || allowed.includes(baseVal) || li.dataset.value === 'preserve';
    li.style.display = valid ? '' : 'none';
    li.style.color = valid ? '' : '#9ca3af';
  });
  if (allowed) {
    const current = hiddenEl.value;
    const baseCurrent = current.endsWith('df') ? current.replace('df', '') : current;
    if (!allowed.includes(current) && !allowed.includes(baseCurrent) && current !== 'preserve') {
      setDropdownValue(hiddenEl.id, allowed[0] || 'preserve');
    }
  }
}

// The following helpers were used in an earlier version of the panel but are
// currently unused. They are kept for reference in case future compatibility
// checks are reintroduced.
/*
function isSourceCompatibleWithDNxHD(resolution, pixelFormat, frameRate) {
  const validSizes = ['1920x1080', '1440x1080', '1280x720', '960x720'];
  const validPixFmts = ['yuv422p', 'yuv422p10'];
  const validRates = ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60'];

  return (
    validSizes.includes(resolution) &&
    validPixFmts.includes(pixelFormat) &&
    validRates.includes(frameRate)
  );
}

function isSourceCompatibleWithDNxHR(resolution, pixelFormat, frameRate) {
  const validSizes = ['1920x1080', '3840x2160', '4096x2160'];
  const validPixFmts = ['yuv422p', 'yuv422p10', 'yuv444p10le'];
  const validRates = ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60'];

  return (
    validSizes.includes(resolution) &&
    validPixFmts.includes(pixelFormat) &&
    validRates.includes(frameRate)
  );
}
*/

async function isAudioContainerValid(codec, container) {
  try {
    return !!(await window.codex?.isAudioContainerValid?.(codec, container));
  } catch {
    return true; // fail-open in dev if IPC unavailable
  }
}



  // async, but fire-and-forget is fine for initial UI state
  enforceLicenseLocks();
  let isTranscoding = false;
  let lastError = '';
  function showCompatibilityWarnings(elements) {
  const format = elements.outputFormat.value;
  const container = elements.containerFormat.value;

  let warning = '';

  if (format.includes('4444') && container === 'mp4') {
    warning = '⚠️ MP4 does not support alpha channels. Use MOV.';
  } else if (format.includes('sequence') && container !== 'image_sequence') {
    warning = '⚠️ Output format is an image sequence. Set container to "image_sequence".';
  }

  if (warning) {
    elements.status.textContent = warning;
    elements.status.style.color = '#d97706'; // yellow-orange
  } else {
    elements.status.textContent = 'Idle';
    elements.status.style.color = ''; // reset
  }
}
  const formatDescriptions = {
  prores_422: 'Apple ProRes 422 — good quality and edit-friendly.',
  prores_4444: 'Apple ProRes 4444 — supports alpha and higher color fidelity.',
  prores_4444xq: 'ProRes 4444 XQ — highest quality ProRes, with alpha.',
  h264_auto_gpu: 'H.264 (Auto GPU) — chooses the best available hardware encoder.',
  h264: 'H.264 — efficient compression for general delivery.',
  h265: 'H.265 (HEVC) — more efficient, better for 4K.',
  vp9: 'VP9 — open codec for web, used by YouTube.',
  av1: 'AV1 — modern, royalty-free codec for web streaming.',
  xdcam_hd35: 'XDCAM HD 35 — ENG/news workflows.',
  xdcam_hd50: 'XDCAM HD 50 — broadcast standard.',
  xavc_l_1080p: 'XAVC-L 1080p — Sony long GOP format.',
  xavc_i_4k: 'XAVC-I 4K — high quality intra codec.',
  xavc_s: 'XAVC-S — prosumer H.264 format.',
  jpeg2000: 'JPEG 2000 — archival quality.',
  ffv1: 'FFV1 — lossless archival video.',
  mjpeg: 'Motion JPEG — legacy intraframe codec.',
  qtrle: 'Apple Animation — supports alpha.',
  uncompressed_yuv: 'Uncompressed YUV — high fidelity.',
  uncompressed_rgb: 'Uncompressed RGB — full color fidelity.',
  png_sequence: 'PNG sequence — with transparency support.',
  tiff_sequence: 'TIFF sequence for finishing.',
  exr_sequence: 'EXR sequence for VFX.',
  tga_sequence: 'TGA sequence — legacy graphics.',
  image_sequence: 'Image Sequence — exports as PNG frames.'
};

function updateSummary(elements) {
  const selectedFiles = JSON.parse(elements.inputFiles.dataset.fileList || '[]');
  const fileCount = selectedFiles.length;
  const format = elements.outputFormat.value;
  const container = elements.containerFormat.value;
  const resolution = elements.resolution.value;
  const frameRate = elements.frameRate.value;
  const frLabel = frameRate && frameRate.endsWith('df') ? frameRate : `${frameRate}fps`;
  const audioCodec = elements.audioCodec.value;
  const audioChannels = elements.channels.value;

   const chanText = audioChannels === 'preserve'
    ? 'original channels'
    : audioChannels;
  const summaryText = `🎬 Transcoding ${fileCount} file${fileCount === 1 ? '' : 's'} to ${format} (${resolution} @ ${frLabel}) → ${container} with ${audioCodec} ${chanText}`;
  elements.summary.textContent = summaryText;
  updateTranscodeJobPreview();
}

async function applyPresetToFields(preset, elements) {
  if (!preset) return;
  elements.outputFormat.value = preset.outputFormat || '';
  elements.containerFormat.value = preset.containerFormat || '';
  elements.resolution.value = preset.resolution || '';
  elements.frameRate.value = preset.frameRate || '';
  elements.pixelFormat.value = preset.pixelFormat || '';
  elements.colorRange.value = preset.colorRange || '';
  elements.fieldOrder.value = preset.fieldOrder || '';
  elements.crf.value = preset.crf || '';
  elements.audioCodec.value = preset.audioCodec || '';
  elements.channels.value = preset.channels || '';
  elements.sampleRate.value = preset.sampleRate || '';
  elements.audioBitrate.value = preset.audioBitrate || '';
  elements.audioDelay.value = preset.audioDelay || '';
  elements.normalizeAudio.checked = !!preset.normalizeAudio;
  if (elements.matchSource) {
    elements.matchSource.checked = !!preset.matchSource;
  }

  await filterContainerOptions(elements.outputFormat.value);
  await filterResolutionOptions(elements.outputFormat.value, elements);
  await filterPixelFormats(elements.outputFormat.value, elements);
  await filterAudioCodecs(elements.outputFormat.value, elements);
  await filterSampleRates(elements.outputFormat.value, elements);
  await filterChannels(elements.outputFormat.value, elements);

  updateSummary(elements);
  showCompatibilityWarnings(elements);

  if (elements.matchSource?.checked) {
    applyMatchSource().then(() => {
      elements.resolution.disabled = true;
      elements.frameRate.disabled = true;
    });
  } else {
    elements.resolution.disabled = false;
    elements.frameRate.disabled = false;
  }

  document.querySelectorAll('#transcode [disabled]').forEach(el => {
    el.disabled = false;
  });
}

// Inline status/output area – reuse the existing progress output for legacy log + status text.
const summaryTarget = document.getElementById('transcode-progress-output') || document.createElement('span');

const el = {
  inputFiles: document.getElementById('inputFiles'),
  selectInputFiles: document.getElementById('selectInputFiles'),
  outputFormat: document.getElementById('outputFormat'),
  containerFormat: document.getElementById('containerFormat'),
  outputPath: document.getElementById('outputPath'),
  selectOutput: document.getElementById('selectOutput'),
  resolution: document.getElementById('resolution'),
  frameRate: document.getElementById('frameRate'),
  audioCodec: document.getElementById('audioCodec'),
  channels: document.getElementById('channels'),
  pixelFormat: document.getElementById('pixelFormat'),
  colorRange: document.getElementById('colorRange'),
  fieldOrder: document.getElementById('fieldOrder'),
  crf: document.getElementById('crf'),
  sampleRate: document.getElementById('sampleRate'),
  audioBitrate: document.getElementById('audioBitrate'),
  normalizeAudio: document.getElementById('normalizeAudio'),
  audioDelay: document.getElementById('audioDelay'),
  startBtn: document.getElementById('startTranscode'),
  cancelBtn: document.getElementById('cancelTranscode'),
  resetBtn: document.getElementById('resetTranscode'),
  progressBar: document.getElementById('transcode-progress'),
  progressOutput: document.getElementById('transcode-progress-output'),
  jobStatus: document.getElementById('transcode-job-status'),
  log: summaryTarget,
  status: summaryTarget,
  aiPrompt: document.getElementById('ai-prompt'),
  runAiBtn: document.getElementById('run-ai'),
  aiResponse: document.getElementById('ai-response'),
  summary: summaryTarget,
  formatTooltip: document.getElementById('format-tooltip'),
  presetSelect: document.getElementById('transcode-preset'),
  savePresetBtn: document.getElementById('saveTranscodePreset'),
  loadPresetBtn: document.getElementById('loadTranscodePreset'),
  revealAfter: document.getElementById('revealAfterTranscode'),
  openInMediaInfo: document.getElementById('openInMediaInfo'),
  queueForAutomation: document.getElementById('queueForAutomation'),
  saveLog: document.getElementById('transcode-save-log'),

  enableN8N: document.getElementById('transcode-enable-n8n'),
  n8nUrl: document.getElementById('transcode-n8n-url'),
  n8nLog: document.getElementById('transcode-n8n-log'),

  notes: document.getElementById('transcode-notes'),

  watchMode: document.getElementById('transcode-watch-mode'),
  matchSource: document.getElementById('transcode-match-source'),
  audioOnly: document.getElementById('transcode-audio-only'),
};

el['transcode-verification-method'] = document.getElementById('transcode-verification-method');

autoResize(el.inputFiles);

const transcodeLockWrapper = document.getElementById('transcode-lock-wrapper');

// ========== Job Preview ==========
const transcodePreviewEl = document.getElementById('transcode-job-preview-box');

function updateTranscodeJobPreview() {
  if (!transcodePreviewEl) return;
  const cfg = gatherTranscodeConfig();

  const hasInputs = Array.isArray(cfg.inputFiles) && cfg.inputFiles.length > 0;

  // No source files? Keep the preview empty.
  if (!hasInputs) {
    transcodePreviewEl.value = '';
    autoResize(transcodePreviewEl);
    return;
  }

  const lines = [];

  lines.push('🧾 Transcode Job Preview');
  lines.push('──────────────────────────────');

  const count = cfg.inputFiles.length;
  lines.push(`Input: ${count} file(s)`);
  lines.push(`Output folder: ${cfg.outputFolder || '(not set)'}`);
  lines.push(`Audio-only mode: ${cfg.audioOnly ? 'on' : 'off'}`);

  lines.push(`Output format: ${cfg.outputFormat || '(none)'}`);
  lines.push(`Container: ${cfg.containerFormat || '(none)'}`);
  lines.push(`Resolution: ${cfg.resolution || 'match'}`);
  lines.push(`Frame rate: ${cfg.frameRate || 'match'}`);
  lines.push(`Pixel format: ${cfg.pixelFormat || 'default'}`);
  lines.push(`Color range: ${cfg.colorRange || 'unspecified'}`);
  lines.push(`Field order: ${cfg.fieldOrder || 'progressive'}`);
  lines.push(`CRF: ${cfg.crf || '(none)'}`);
  lines.push(`Match source: ${cfg.matchSource ? 'on' : 'off'}`);

  lines.push(`Audio codec: ${cfg.audioCodec || '(none)'}`);
  lines.push(`Channels: ${cfg.channels || 'preserve'}`);
  lines.push(`Sample rate: ${cfg.sampleRate || 'default'}`);
  lines.push(`Audio bitrate: ${cfg.audioBitrate || '(auto)'}`);
  lines.push(`Normalize audio: ${cfg.normalizeAudio ? 'on' : 'off'}`);
  lines.push(`Audio delay: ${cfg.audioDelay ? `${cfg.audioDelay} ms` : '0 ms'}`);

  const verificationMethod = cfg.verification?.method || 'metadata';
  lines.push(`Verify: ${verificationMethod}`);
  lines.push(`Detect black/freeze: ${cfg.verification?.detectBlack ? 'on' : 'off'}`);
  lines.push(`Save log: ${cfg.verification?.saveLog ? 'on' : 'off'}`);

  lines.push(`Reveal after: ${cfg.revealAfter ? 'on' : 'off'}`);
  lines.push(`Open in MediaInfo: ${cfg.openInMediaInfo ? 'on' : 'off'}`);
  lines.push(`Queue for automation: ${cfg.queueForAutomation ? 'on' : 'off'}`);

  lines.push(`Watch mode: ${cfg.watchFolder ? 'on' : 'off'}`);
  lines.push(`n8n webhook: ${cfg.enableN8N ? (cfg.n8nUrl || '(no URL)') : 'off'}`);
  lines.push(`Send log to n8n: ${cfg.n8nLog ? 'on' : 'off'}`);
  if (cfg.notes?.trim()) {
    lines.push(`Notes: ${cfg.notes.trim()}`);
  }

  transcodePreviewEl.value = lines.join('\n');
  autoResize(transcodePreviewEl);
}

const previewBindingIds = [
  'inputFiles',
  'outputPath',
  'outputFormat',
  'containerFormat',
  'resolution',
  'frameRate',
  'pixelFormat',
  'colorRange',
  'fieldOrder',
  'crf',
  'transcode-match-source',
  'audioCodec',
  'channels',
  'sampleRate',
  'audioBitrate',
  'normalizeAudio',
  'audioDelay',
  'revealAfterTranscode',
  'openInMediaInfo',
  'queueForAutomation',
  'transcode-enable-n8n',
  'transcode-n8n-url',
  'transcode-n8n-log',
  'transcode-watch-mode',
  'transcode-notes',
  'transcode-audio-only',
  'transcode-verification-method',
  'transcode-save-log'
];

previewBindingIds.forEach(id => {
  const target = document.getElementById(id);
  if (!target) return;
  let eventName = 'change';
  if (target.tagName === 'INPUT' && (target.type === 'text' || target.type === 'number')) {
    eventName = 'input';
  } else if (target.tagName === 'TEXTAREA') {
    eventName = 'input';
  }
  target.addEventListener(eventName, updateTranscodeJobPreview);
});

updateTranscodeJobPreview();

function showError(msg) {
  logTranscode(msg, { isError: true });
  el.log.textContent = msg;
  el.status.textContent = msg;
}

// Disable cancel until a transcode is running
el.cancelBtn.disabled = true;

function setTranscodeControlsDisabled(state) {
  document.querySelectorAll('#transcode input,#transcode select,#transcode textarea,#transcode button').forEach(elem => {
if (elem.id === 'transcode-watch-mode') {
  elem.disabled = state; // allow it to lock like others
  return;
}

    if (elem.id === 'cancelTranscode') return;    
    elem.disabled = state;
  });
  el.startBtn.disabled = state;
  el.resetBtn.disabled = state;

  if (state) {
    transcodeLockWrapper?.classList.add('locked');
  } else {
    transcodeLockWrapper?.classList.remove('locked');
  }
}

function setVideoControlsDisabled(state) {
  [
    el.outputFormat,
    el.containerFormat,
    el.resolution,
    el.frameRate,
    el.pixelFormat,
    el.colorRange,
    el.fieldOrder
  ].forEach(field => {
    if (field) field.disabled = state;
  });
}

async function toggleAudioOnlyMode() {
  const enabled = !!el.audioOnly?.checked;
  setVideoControlsDisabled(enabled);
  if (enabled) {
    el.outputFormat.value = '';
    el.containerFormat.value = '';
    el.resolution.value = '';
    el.frameRate.value = '';
    el.pixelFormat.value = '';
    el.colorRange.value = '';
    el.fieldOrder.value = '';
    setupStyledDropdown('audioCodec', audioWrapperList);
    setDropdownValue('audioCodec', '');
  } else {
    if (!cachedAudioCodecList.length) {
      await initAudioCodecDropdown();
    } else {
      setupStyledDropdown('audioCodec', cachedAudioCodecList);
      setDropdownValue('audioCodec', '');
    }
  }
  updateSummary(el);
}

function gatherTranscodeConfig() {
  const inputList = JSON.parse(el.inputFiles.dataset.fileList || '[]');
  const audioOnlyMode = !!el.audioOnly?.checked;
  const isAudioOnly = audioOnlyMode || inputList.every(isAudioOnlyFile);
  const format = el.outputFormat?.value;
  const pixelFmt = el.pixelFormat?.value;
  const sampleRate = el.sampleRate?.value;
  const selectedRate = el.frameRate?.value || '';
  const numericRate = selectedRate.endsWith('df') ? selectedRate.replace('df', '') : selectedRate;  
  const cfg = {
    inputFiles: inputList,
    outputFormat: audioOnlyMode ? null : format,
    containerFormat: audioOnlyMode ? el.audioCodec?.value : el.containerFormat?.value,
    outputFolder: el.outputPath?.value,
    resolution: isAudioOnly ? null : el.resolution?.value,
    frameRate: isAudioOnly ? null : numericRate,
    dropFrame: selectedRate.endsWith('df'),
    audioCodec: el.audioCodec?.value,
    channels: el.channels?.value,
    pixelFormat: isAudioOnly ? null : pixelFmt,
    colorRange: el.colorRange?.value,
    fieldOrder: el.fieldOrder?.value,
    crf: el.crf?.value || null,
    sampleRate: sampleRate,
    audioBitrate: el.audioBitrate?.value || null,
    normalizeAudio: !!el.normalizeAudio?.checked,
    audioDelay: el.audioDelay?.value || null,
    revealAfter: !!el.revealAfter?.checked,
    openInMediaInfo: !!el.openInMediaInfo?.checked,
    queueForAutomation: !!el.queueForAutomation?.checked,
    enableN8N: !!el.enableN8N?.checked,
    n8nUrl: el.n8nUrl?.value || '',
    n8nLog: !!el.n8nLog?.checked,
    notes: el.notes?.value || '',
    verbose: false,
    matchSource: !!el.matchSource?.checked,
    audioOnly: audioOnlyMode
  };

  const detectBlack = document.getElementById('transcode-detect-black')?.checked;
  const detectFreeze = document.getElementById('transcode-detect-freeze')?.checked;

  cfg.verification = {
    method: el['transcode-verification-method']?.value || 'metadata',
    saveLog: !!el.saveLog?.checked,
    detectBlack: !!(detectBlack || detectFreeze)
  };

  if (el.watchMode?.checked && inputList.length) {
    cfg.watchFolder = inputList[0];
  }

  return cfg;
}

function isWatchConfigValid(cfg) {
  if (!cfg) return 'No transcode config found.';
  const missing = [];
  if (!cfg.containerFormat) missing.push('Container Format');
  if (!cfg.audioCodec) missing.push('Audio Codec');
  if (!cfg.audioOnly) {
    if (!cfg.outputFormat) missing.push('Output Format');
    if (!cfg.resolution) missing.push('Resolution');
    if (!cfg.frameRate) missing.push('Frame Rate');
  }
  return missing.length ? `Missing: ${missing.join(', ')}` : true;
}

function formatQualityMessage(quality, verified) {
  if (!quality || !quality.status) return '';
  const reason = quality.reason || 'no reason provided';
  if (quality.status === 'ok') {
    const hasSsim = typeof quality.ssim === 'number' && Number.isFinite(quality.ssim);
    const hasPsnr = typeof quality.psnr === 'number' && Number.isFinite(quality.psnr);
    const ssimText = hasSsim ? quality.ssim.toFixed(4) : 'n/a';
    const psnrText = hasPsnr ? `${quality.psnr.toFixed(2)} dB` : 'n/a';
    const prefix = verified === false ? '⚠️' : '🧪';
    return `${prefix} Quality: SSIM ${ssimText} | PSNR ${psnrText}`;
  }
  if (quality.status === 'skipped') {
    return `🧪 Quality: skipped (${reason})`;
  }
  if (quality.status === 'error') {
    return `🧪 Quality: error (${reason})`;
  }
  return '';
}

if (window.watchValidators) {
  window.watchValidators.transcode = isWatchConfigValid;
}

const startBtn = el.startBtn;
const cancelBtn = el.cancelBtn;
const inputBtn = el.selectInputFiles;
watchUtils.initWatchToggle({
  checkboxId: 'transcode-watch-mode',
  startBtnId: startBtn?.id || 'startTranscode',
  cancelBtnId: cancelBtn?.id || 'cancelTranscode',
  onToggle: isWatch => {
    if (inputBtn) {
      inputBtn.textContent = isWatch ? 'Select Watch Folder' : 'Select Source';
    }
  }
});

async function initOutputFormatDropdown() {
  const formats = await window.codex?.listFormats?.();
  const available = new Set(formats || []);
  const orderedFormats = [
    { value: 'prores_422', label: 'ProRes 422' },
    { value: 'prores_422hq', label: 'PreRes 422HQ' },
    { value: 'prores_4444', label: 'ProRes 4444' },
    { value: 'prores_4444xq', label: 'ProRes 4444XQ' },
    { value: 'prores_lt', label: 'ProRes LT' },
    { value: 'prores_proxy', label: 'PreRes Proxy' },
    { value: 'jpeg2000', label: 'JPEG 2000' },
    { value: 'av1', label: 'AV1' },
    { value: 'h264', label: 'H264' },
    { value: 'h264_auto_gpu', label: 'H264 Auto GPU' },
    { value: 'h265', label: 'H265' },
    { value: 'vp9', label: 'VP9' },
    { value: 'ffv1', label: 'FFV1' },
    { value: 'mjpeg', label: 'MJPEG' },
    { value: 'uncompressed_rgb', label: 'Uncompressed RGB' },
    { value: 'uncompressed_yuv', label: 'Uncompressed YUV' },
    { value: 'exr_sequence', label: 'EXR Sequence' },
    { value: 'image_sequence', label: 'IMAGE Sequence' },
    { value: 'png_sequence', label: 'PNG Sequence' },
    { value: 'tga_sequence', label: 'TGA Sequence' },
    { value: 'tiff_sequence', label: 'TIFF Sequence' }
  ];
  const formatOpts = orderedFormats.filter(f => !available.size || available.has(f.value));
  setupStyledDropdown('outputFormat', formatOpts);
  setDropdownValue('outputFormat', el.outputFormat.value || '');
}
initOutputFormatDropdown();

function initContainerFormats() {
  const containerOptions = [
    { value: 'mov', label: 'Quicktime' },
    { value: 'mp4', label: 'MPEG-4' },
    { value: 'mxf', label: 'MXF' },
    { value: 'webm', label: 'WebM' },
    { value: 'avi', label: 'AVI' },
    { value: 'image_sequence', label: 'Image Sequence' }
  ];

  setupStyledDropdown('containerFormat', containerOptions);
  setDropdownValue('containerFormat', el.containerFormat.value || '');
}

if (document.readyState !== 'loading') {
  initContainerFormats();
} else {
  document.addEventListener('DOMContentLoaded', initContainerFormats);
}

setupStyledDropdown('resolution', ['720x480', '1280x720', '1920x1080', '3840x2160', '4096x2160']);
setDropdownValue('resolution', el.resolution.value || '');
setupStyledDropdown('frameRate', ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60']);
setDropdownValue('frameRate', el.frameRate.value || '');
setupStyledDropdown('pixelFormat', ['yuv420p', 'yuv422p', 'yuv444p10le', 'yuv422p10', 'yuv420p10le']);
setDropdownValue('pixelFormat', el.pixelFormat.value || '');
setupStyledDropdown('colorRange', [
  { value: 'limited', label: 'Limited (16–235)' },
  { value: 'full', label: 'Full (0–255)' }
]);
setDropdownValue('colorRange', el.colorRange.value || '');
setupStyledDropdown('fieldOrder', ['progressive', 'interlaced']);
setDropdownValue('fieldOrder', el.fieldOrder.value || '');
const audioWrapperList = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'];
let cachedAudioCodecList = [];
async function initAudioCodecDropdown() {
  const codecs = await window.codex?.listAudioCodecs?.();
  cachedAudioCodecList = (codecs || Object.keys(sampleRateCompatibility))
    .filter(k => !k.startsWith('avid_'))
    .sort();
  setupStyledDropdown('audioCodec', cachedAudioCodecList);
  setDropdownValue('audioCodec', el.audioCodec.value || '');
}
initAudioCodecDropdown();
setupStyledDropdown('channels', [
  { value: 'preserve', label: 'Preserve Original' },
  'mono', 'stereo', '5.1', '7.1'
]);
setDropdownValue('channels', el.channels.value || '');
setupStyledDropdown('sampleRate', ['44100', '48000']);
setDropdownValue('sampleRate', el.sampleRate.value || '');
setupStyledDropdown('audioBitrate', [
  { value: '96', label: '96 kbps' },
  { value: '128', label: '128 kbps' },
  { value: '160', label: '160 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '320', label: '320 kbps' }
]);
setDropdownValue('audioBitrate', el.audioBitrate.value || '');

function initVerificationDropdown() {
  const hidden = document.getElementById('transcode-verification-method');
  if (!hidden || typeof window.setupStyledDropdown !== 'function') return;

  window.setupStyledDropdown('transcode-verification-method', [
    { value: 'metadata', label: 'Duration / Frame' },
    { value: 'ssim_psnr', label: 'SSIM / PSNR' }
  ]);

  if (typeof window.setDropdownValue === 'function') {
    // Respect any preloaded value; default to 'metadata'
    window.setDropdownValue('transcode-verification-method', hidden.value || 'metadata');
  }
}

// Panel scripts are lazy‑loaded after the main DOM in renderer.js.
// Run immediately if the DOM is already ready; otherwise fall back to DOMContentLoaded.
if (document.readyState !== 'loading') {
  initVerificationDropdown();
} else {
  document.addEventListener('DOMContentLoaded', initVerificationDropdown);
}

// ─── Transcode tooltips: panel overview + verification ──────────────────────

const transcodeOverviewTooltip = document.querySelector('#transcode #transcode-overview-tooltip');
if (transcodeOverviewTooltip && !transcodeOverviewTooltip.dataset.bound) {
  transcodeOverviewTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">TRANSCODE PANEL OVERVIEW</div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">What this panel is for</span>
        <ul class="tooltip-list">
          <li>Transcode camera masters, intermediates, or deliveries into new formats.</li>
          <li>Normalize resolution, frame rate, pixel format, and color range.</li>
          <li>Standardize audio codec, channels, sample rate, and bitrate.</li>
          <li>Optionally run verification and send logs to automation/webhooks.</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Quick workflow</span>
        <ul class="tooltip-list">
          <li><strong>Input</strong> – choose the files or watch folder to process.</li>
          <li><strong>Output</strong> – set the destination and container/output formats.</li>
          <li><strong>Video & Audio</strong> – pick codecs, resolution, frame rate, channels, and levels.</li>
          <li><strong>Verification & Logging</strong> – select a verification mode and whether to save logs.</li>
          <li><strong>Automation</strong> – enable n8n/webhooks if you want external notifications.</li>
          <li><strong>Run</strong> – click <em>Start</em>, or enable Watch Mode to keep processing new files.</li>
        </ul>
      </div>
    </div>
  `;
  transcodeOverviewTooltip.dataset.bound = 'true';
}

const transcodeVerificationTooltip = document.querySelector('#transcode #transcode-verification-tooltip');
if (transcodeVerificationTooltip && !transcodeVerificationTooltip.dataset.bound) {
  transcodeVerificationTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">VERIFICATION METHODS</div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li><strong>Metadata Duration / Frame Check</strong> – compares duration, frame count, and basic stream metadata between source and output. Very fast and a solid default for most jobs.</li>
          <li><strong>SSIM / PSNR Visual Quality</strong> – decodes source and output and runs SSIM/PSNR analysis to quantify quality loss. Slower, but useful for QC and testing new presets.</li>
        </ul>
      </div>
    </div>
  `;
  transcodeVerificationTooltip.dataset.bound = 'true';
}

if (window.DEBUG_UI) {
  console.debug('Transcode panel initialized');
}

el.audioCodec?.addEventListener('change', async () => {
  const codec = el.audioCodec.value;
  const constraints = await window.codex?.getAudioConstraints?.(codec);
  const allowed = constraints?.containers || [];
  const list = el.containerFormat.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (list) {
    [...list.children].forEach(li => {
      const isValid = allowed.includes(li.dataset.value);
      li.style.display = isValid ? '' : 'none';
    });
  }
  if (!allowed.includes(el.containerFormat.value)) {
    setDropdownValue('containerFormat', allowed[0] || '');
  }

  await filterSampleRates('', el);
  await filterChannels('', el);

  el.status.textContent = allowed.length
    ? `🎧 ${codec} supports: ${allowed.join(', ')}`
    : `⚠️ ${codec} has no valid containers`;
  el.status.style.color = allowed.length ? '' : '#dc2626';
});

// 🟡 Show/hide compatibility warnings for containers
el.containerFormat?.addEventListener('change', () => {
  showCompatibilityWarnings(el);
  const container = el.containerFormat.value;
  if (container === 'mov' && !el.audioCodec.value) {
    const list = el.audioCodec.closest('.dropdown-wrapper')?.querySelector('.value-list');
    const hasOption = codec => [...(list?.children || [])].some(li => li.dataset.value === codec && li.style.display !== 'none');
    const defaultAudio = ['pcm_s16le', 'aac'].find(hasOption);
    if (defaultAudio) {
      setDropdownValue('audioCodec', defaultAudio);
    }
  }
});

// 🔵 Respond to changes in output format
el.outputFormat?.addEventListener('change', async () => {
  const format = el.outputFormat.value;

  if (el.formatTooltip) {
    el.formatTooltip.textContent = formatDescriptions[format] || '';
  }
  showCompatibilityWarnings(el);
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);

  await filterContainerOptions(format);

  await filterResolutionOptions(format, el);
  await filterPixelFormats(format, el);
  await filterAudioCodecs(format, el);
  await filterSampleRates(format, el);
  await filterChannels(format, el);

  // Pull normalized defaults from backend to avoid renderer drift
  try {
    const defaultsSource = compat || await window.codex?.getCompatibility?.(format);
    const d = defaultsSource?.defaults || {};
    if (d.container) setDropdownValue('containerFormat', d.container);
    if (d.resolution) setDropdownValue('resolution', d.resolution);
    if (d.frameRate) setDropdownValue('frameRate', d.frameRate);
    if (d.pixelFormat) setDropdownValue('pixelFormat', d.pixelFormat);
    if (d.colorRange) setDropdownValue('colorRange', d.colorRange);
    if (d.fieldOrder) setDropdownValue('fieldOrder', d.fieldOrder);
    if (d.audio) setDropdownValue('audioCodec', d.audio);
    if (d.channels) setDropdownValue('channels', d.channels);
    if (d.sampleRate) setDropdownValue('sampleRate', d.sampleRate);
    if (d.audioBitrate && el.audioBitrate) el.audioBitrate.value = d.audioBitrate;
  } catch {}

  // 🎯 Enforce valid audio codec when format changes
  const allowedAudio = compat?.audioCodecs || audioCodecCompatibility[format];
  if (allowedAudio && allowedAudio.length) {
    const current = el.audioCodec.value;
    if (!allowedAudio.includes(current)) {
      el.audioCodec.value = allowedAudio[0];
    }
  }

  // 🎯 Enforce valid sample rate
  const audioCodec = el.audioCodec.value;
  const codecConstraints = await window.codex?.getAudioConstraints?.(audioCodec);
  const allowedRates = codecConstraints?.sampleRates || sampleRateCompatibility[audioCodec];
  if (allowedRates && allowedRates.length) {
    const currentRate = el.sampleRate.value;
    if (!allowedRates.includes(currentRate)) {
      el.sampleRate.value = allowedRates[0];
    }
  }

  // 🎯 Enforce valid channels
  const allowedChans = codecConstraints?.channels || channelCompatibility[audioCodec];
  if (allowedChans && allowedChans.length) {
    const currentChans = el.channels.value;
    if (!allowedChans.includes(currentChans)) {
      el.channels.value = allowedChans[0];
    }
  }

  updateSummary(el);
  if (el.matchSource?.checked) {
    await applyMatchSource();
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  }
});

el.matchSource?.addEventListener('change', async e => {
  if (e.target.checked) {
    const ok = await applyMatchSource();
    if (!ok) {
      e.target.checked = false;
      return;
    }
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  } else {
    el.resolution.disabled = false;
    el.frameRate.disabled = false;
  }
  updateSummary(el);
});

el.audioOnly?.addEventListener('change', () => {
  toggleAudioOnlyMode().catch(() => {});
});

el.selectInputFiles?.addEventListener('click', async () => {
  const isWatch = document.getElementById('transcode-watch-mode')?.checked;
  if (isWatch) {
    const folder = await window.electron?.selectFolder?.();
    if (folder) {
      el.inputFiles.value = folder;
      el.inputFiles.dataset.fileList = JSON.stringify([folder]);
      autoResize(el.inputFiles);
      const grid = prepareFileInfoGrid('transcode');
      if (grid) {
        const row = `
          <div class="file-info-row">
            <div>${folder}</div>
            <div>Folder</div>
            <div>—</div>
            <div>—</div>
            <div>—</div>
            <div>—</div>
          </div>`;
        grid.insertAdjacentHTML('beforeend', row);
        setupResizableGrid(grid, 'gridCols-transcode');
      }
      updateSummary(el);
    }
    return;
  }

  const files = await window.electron?.selectFiles?.();
  if (files && files.length) {
    el.inputFiles.value = files.length === 1 ? files[0] : files.join('\n');
    el.inputFiles.dataset.fileList = JSON.stringify(files);
    autoResize(el.inputFiles);

    const grid = prepareFileInfoGrid('transcode');
    if (!grid) return;

    await Promise.all(
      files.map(async f => {
        try {
          const meta = await getFileMetadata(f);
          const container = resolveContainerLabel(meta, f);
          const v = (meta.streams || []).find(s => s.codec_type === 'video');
          const audioInfo = summarizeAudioStreams(meta.streams || []);
          const res = v ? `${v.width}×${v.height}` : (audioInfo.tracks > 0 ? 'Audio only' : 'N/A');
          const fps = formatFrameRateForGrid(meta);
          const dur = formatDuration(+meta.format?.duration || 0);
          const row = `
            <div class="file-info-row">
              <div>${window.electron.basename(f)}</div>
              <div>${container}</div>
              <div>${res}</div>
              <div>${fps}</div>
              <div>${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}</div>
              <div>${dur}</div>
            </div>`;
          grid.insertAdjacentHTML('beforeend', row);
        } catch (err) {
          const row = `
            <div class="file-info-row">
              <div>${window.electron.basename(f)}</div>
              <div style="grid-column: span 5;">❌ ${err}</div>
            </div>`;
          grid.insertAdjacentHTML('beforeend', row);
        }
      })
    );

    setupResizableGrid(grid, 'gridCols-transcode');

    const allAudioOnly = files.every(isAudioOnlyFile);
    const hasDNX = await containsDNXSource(files);

    if (!el.audioOnly?.checked) {
      if (!allAudioOnly) setVideoControlsDisabled(false);
      setVideoControlsDisabled(allAudioOnly);
    }

    if (hasDNX) {
      el.status.textContent = '⚠️ DNxHD/R source detected. FFmpeg may not handle it well.';
    } else {
      el.status.textContent = allAudioOnly
        ? '🎧 Audio-only file(s) detected. Video options disabled.'
        : '✅ Files loaded.';
    }
  } else {
    el.inputFiles.value = '';
    el.inputFiles.dataset.fileList = '[]';
    autoResize(el.inputFiles);
    resetFileInfoGrid('transcode', 'gridCols-transcode');
  }

  updateSummary(el);
  if (el.matchSource?.checked) {
    await applyMatchSource();
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  }
});

el.selectOutput?.addEventListener('click', async () => {
  const folder = await window.electron?.selectFolder?.();
  if (folder) {
    el.outputPath.value = folder;
    updateSummary(el);
  }
});

  el.startBtn?.addEventListener('click', async () => {
    if (isTranscoding) return;
    const cfg = gatherTranscodeConfig();
    const isWatchMode = document.getElementById('transcode-watch-mode')?.checked;
    if (isWatchMode) {
      if (!cfg.watchFolder && cfg.inputFiles?.length) {
        cfg.watchFolder = cfg.inputFiles[0];
      }
      await watchUtils.startWatch('transcode', cfg);
      setTranscodeControlsDisabled(true);
      el.cancelBtn.disabled = false;
      return;
    }

    if (!el.outputPath.value) {
      const msg = "❌ Please select an output folder.";
      logTranscode(msg, { isError: true });
      el.log.textContent = msg;
      return;
    }

    const format = el.outputFormat.value;
    const debugLabel = document.getElementById('gpu-encoder-debug');
    if (debugLabel) debugLabel.textContent = `GPU Encoder: ${format}`;
    const container = el.containerFormat.value;
    const resolution = el.resolution.value;
    const pixelFmt = el.pixelFormat.value;
    const sampleRate = el.sampleRate.value;
    const codec = el.audioCodec.value;
    const audioOnlyMode = !!el.audioOnly?.checked;

    if (!codec) {
      showError('❌ No audio codec selected.');
      isTranscoding = false;
      el.resetBtn.disabled = false;
      el.cancelBtn.disabled = true;
      return;
    }

    const formatCompat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
    if (formatCompat && !__compatCache.has(format)) __compatCache.set(format, formatCompat);

    if (!audioOnlyMode) {
      const validAudioCodecsForMov = ['aac', 'pcm_s16le', 'pcm_s24le'];
      if (container === 'mov' && !validAudioCodecsForMov.includes(codec)) {
        showError(`❌ Audio codec "${codec}" not supported in container "${container}".`);
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }

      const audioContainerOK = await isAudioContainerValid(codec, container);
      if (!audioContainerOK) {
        const msg = `❌ Audio codec "${codec}" not supported in container "${container}".`;
        logTranscode(msg, { isError: true });
        el.log.textContent = msg;
        el.status.textContent = '🛑 Incompatible audio setup';
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }

      // 🚫 Hard block invalid combinations
      if (!(formatCompat?.audioCodecs || audioCodecCompatibility[format] || []).includes(codec)) {
        const msg = `❌ Audio codec "${codec}" not allowed for format "${format}".`;
        logTranscode(msg, { isError: true });
        el.log.textContent = msg;
        el.status.textContent = '🛑 Invalid audio format';
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }

      const validList = formatCompat?.containers || [];
      if (validList.length && !validList.includes(container)) {
        const msg = `❌ ${format} not compatible with ${container}.`;
        logTranscode(msg, { isError: true });
        el.log.textContent = msg;
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }
    }

    const fmtLi = el.outputFormat.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (fmtLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(format))) {
      const msg = `❌ Format "${format}" is restricted.`;
      logTranscode(msg, { isError: true });
      el.log.textContent = msg;
      return;
    }
    const resLi = el.resolution.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (resLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(resolution))) {
      const msg = `❌ Resolution "${resolution}" is restricted.`;
      logTranscode(msg, { isError: true });
      el.log.textContent = msg;
      return;
    }
    const pixLi = el.pixelFormat.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (pixLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(pixelFmt))) {
      const msg = `❌ Pixel format "${pixelFmt}" is restricted.`;
      logTranscode(msg, { isError: true });
      el.log.textContent = msg;
      return;
    }
    const rateLi = el.sampleRate.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (rateLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(sampleRate))) {
      const msg = `❌ Sample rate "${sampleRate}" is restricted.`;
      logTranscode(msg, { isError: true });
      el.log.textContent = msg;
      return;
    }

    isTranscoding = true;
    el.resetBtn.disabled = true;
    el.cancelBtn.disabled = false;

    const config = {
      ...cfg,
      watchMode: el.watchMode.checked,
      verification: {
        method: el['transcode-verification-method']?.value || 'metadata',
        saveLog: el.saveLog.checked
      }
    };

    const inputList = config.inputFiles || [];

    if (audioOnlyMode) {
      try {
        currentJobId = await ipc.invoke('queue-add-transcode', { config });
        const queuedMsg = '🗳️ Transcode job queued.';
        logTranscode(queuedMsg);
        el.log.textContent = queuedMsg;
      } catch (err) {
        const errMsg = `❌ Queue error: ${err.message}`;
        logTranscode(errMsg, { isError: true });
        el.log.textContent = errMsg;
      }
      isTranscoding = false;
      el.resetBtn.disabled = false;
      el.cancelBtn.disabled = false;
      return;
    }

    const selectedEntry = formatCompat?.defaults;
    const metadata = await window.electron.getSourceMetadata?.(inputList[0]);

    if (!metadata) {
      const warnMsg = '⚠️ Unable to read source metadata. Proceeding with caution.';
      logTranscode(warnMsg);
      el.log.textContent = warnMsg;
    }

    if (inputList.length && selectedEntry) {
      const ok = await window.electron.validateCodexInput?.(metadata, selectedEntry);
      if (!ok) {
        const specErr = `❌ Your source file does not meet the required specs for ${selectedEntry.name || format}. Please choose a compatible format or transcode using ProRes.`;
        logTranscode(specErr, { isError: true });
        el.log.textContent = specErr;
        el.status.textContent = '🛑 Incompatible source';
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }
    }

      const startMsg = '⚙️ Starting transcode...';
      logTranscode(startMsg);
      el.log.textContent = startMsg;
    el.status.textContent = `🔄 Starting transcode...`;

const outputFolder = el.outputPath.value;
const diskStats = await window.electron.getDiskInfo?.(outputFolder);
if (diskStats?.free && diskStats.free < 15 * 1024 * 1024 * 1024) { // 15 GB minimum
  const diskMsg = '❌ Not enough disk space to safely transcode ProRes. Please free up space.';
  logTranscode(diskMsg, { isError: true });
  el.log.textContent = diskMsg;
  el.status.textContent = '🛑 Aborted: Not enough disk space';
  isTranscoding = false;
  el.resetBtn.disabled = false;
  el.cancelBtn.disabled = true;
  return;
}


    if (format.startsWith('xdcam')) {
      const validXDCAMRes = ['1920x1080', '1440x1080'];
      if (!validXDCAMRes.includes(resolution) || el.fieldOrder.value === 'progressive') {
        const xdcamMsg = '❌ XDCAM HD requires 1080i resolutions and interlaced output.';
        logTranscode(xdcamMsg, { isError: true });
        el.log.textContent = xdcamMsg;
        el.status.textContent = '🛑 Invalid XDCAM settings';
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }
    } else if (format.startsWith('xavc')) {
      if (resolution !== '1920x1080' && resolution !== '3840x2160') {
        const xavcMsg = '❌ XAVC formats require 1080p or UHD resolution.';
        logTranscode(xavcMsg, { isError: true });
        el.log.textContent = xavcMsg;
        el.status.textContent = '🛑 Invalid XAVC resolution';
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }
    }

    setTranscodeControlsDisabled(true);

    try {
      currentJobId = await ipc.invoke('queue-add-transcode', { config });
      const queuedMsg2 = '🗳️ Transcode job queued.';
      logTranscode(queuedMsg2);
      el.log.textContent = queuedMsg2;
    } catch (err) {
      const errMsg2 = `❌ Queue error: ${err.message}`;
      logTranscode(errMsg2, { isError: true });
      el.log.textContent = errMsg2;
    }

    isTranscoding = false;
    el.cancelBtn.disabled = false;
  });


  el.cancelBtn?.addEventListener('click', async () => {
    // Decide based on actual watch state, not button text.
    const isWatchCheckboxOn = !!el.watchMode?.checked;
    const isActivelyWatching =
      (typeof watchUtils?.isWatching === 'function' && watchUtils.isWatching('transcode')) || false;

    if (isWatchCheckboxOn || isActivelyWatching) {
      try {
        if (typeof watchUtils?.stopWatch === 'function') {
          await watchUtils.stopWatch('transcode');
        }
      } catch (e) {
        console.warn('stopWatch failed (transcode):', e);
      }
      el.status.textContent = '🛑 Watch Mode stopped.';
      el.startBtn.disabled = false;
      el.cancelBtn.disabled = true;
      el.startBtn.textContent = 'Start';
      el.cancelBtn.textContent = 'Cancel';
      if (el.watchMode) el.watchMode.checked = false;
      const stateEl = document.getElementById('transcode-watch-state');
      if (stateEl) stateEl.textContent = '';
      setTranscodeControlsDisabled(false);
      return;
    }

    el.status.textContent = '🛑 Canceling...';
    logTranscode('🛑 Cancel requested by user.');
    el.log.textContent += '\n🛑 Cancel requested by user.';
    el.cancelBtn.disabled = true;

    try {
      await ipc.invoke('queue-cancel-job', currentJobId);
      currentJobId = null;
      el.status.textContent = '🛑 Cancel requested...';
      await resetTranscodeFields();
    } catch (err) {
      el.status.textContent = '⚠️ Cancel failed.';
      const cancelErr = `❌ Cancel error: ${err.message}`;
      logTranscode(cancelErr, { isError: true });
      el.log.textContent += `\n❌ Cancel error: ${err.message}`;
    }
  });

  async function resetTranscodeFields() {
    if (isTranscoding) return;

    el.inputFiles.value = '';
    el.inputFiles.dataset.fileList = '[]';
    autoResize(el.inputFiles);
    resetFileInfoGrid('transcode', 'gridCols-transcode');
    el.outputPath.value = '';
    el.status.textContent = 'Idle';
    el.log.textContent = '';
    el.cancelBtn.disabled = true;
    resetTranscodeProgressUI();
    // Bottom per-file summary was removed; nothing additional to reset here.

    setDropdownValue('outputFormat', '');
    const format = el.outputFormat.value;
    ['containerFormat','resolution','frameRate','audioCodec','channels','pixelFormat','colorRange','fieldOrder','sampleRate']
      .forEach(id => setDropdownValue(id, ''));
    await filterResolutionOptions(format, el);
    await filterPixelFormats(format, el);
    await filterAudioCodecs(format, el);
    await filterSampleRates(format, el);
    await filterChannels(format, el);

    [
      el.crf, el.audioBitrate, el.audioDelay
    ].forEach(input => { if (input) input.value = ''; });

    [
      el.normalizeAudio,
      el.enableN8N,
      el.n8nLog,
      el.watchMode
    ].forEach(cb => { if (cb) cb.checked = false; });

    if (el.matchSource) {
      el.matchSource.checked = false;
      el.resolution.disabled = false;
      el.frameRate.disabled = false;
    }

    if (el.audioOnly) {
      el.audioOnly.checked = false;
      await toggleAudioOnlyMode();
    }

    if (el.n8nUrl) el.n8nUrl.value = '';
    if (el.notes) el.notes.value = '';
    await filterContainerOptions(el.outputFormat.value);

    updateSummary(el);
  }

  el.resetBtn?.addEventListener('click', () => {
    resetTranscodeFields().catch(() => {});
  });

  el.runAiBtn?.addEventListener('click', () => {
    const prompt = el.aiPrompt.value.toLowerCase();
    let changed = false;
    let summary = '🧠 AI applied:\n';

    if (prompt.includes('why') && prompt.includes('fail')) {
      el.aiResponse.textContent = lastError ? `Last error: ${lastError}` : 'No recent error.';
      return;
    }


    if (prompt.includes('what') && prompt.includes('formats')) {
      el.aiResponse.textContent = 'Use the format dropdown to see compatible options. ProRes and H.264 work with most clips.';
      return;
    }

    const aiMap = {
      outputFormat: {
        'proxy': 'prores_proxy',
        'lt': 'prores_lt',
        '422hq': 'prores_422hq',
        'prores': 'prores_422',
        '4444': 'prores_4444',
        'h264': 'h264',
        'hevc': 'h265',
        'h265': 'h265',
        'vp9': 'vp9',
        'av1': 'av1'
      },
      resolution: {
        '720p': '720p',
        '1080p': '1080p',
        '1440p': '1440p',
        '2k': '2k',
        '4k': '4k',
        '4k dci': '4k_dci'
      },
      channels: {
        'mono': 'mono',
        'stereo': 'stereo',
        '5.1': '5.1',
        '7.1': '7.1'
      }
    };

    for (const [field, options] of Object.entries(aiMap)) {
      for (const [keyword, value] of Object.entries(options)) {
        if (prompt.includes(keyword)) {
          if (el[field]) {
            el[field].value = value;
            summary += `✔️ ${field} → ${value}\n`;
            changed = true;
          }
          break;
        }
      }
    }

    if (!changed) summary = '🤔 No matching settings found in prompt.';
    el.aiResponse.textContent = summary;
    updateSummary(el);
});

// 💾 Save Preset
el.savePresetBtn?.addEventListener('click', async () => {
  const preset = {
    outputFormat: el.outputFormat.value,
    containerFormat: el.containerFormat?.value,
    resolution: el.resolution?.value,
    frameRate: el.frameRate?.value,
    pixelFormat: el.pixelFormat?.value,
    colorRange: el.colorRange?.value,
    fieldOrder: el.fieldOrder?.value,
    crf: el.crf?.value,
    audioCodec: el.audioCodec?.value,
    channels: el.channels?.value,
    sampleRate: el.sampleRate?.value,
    audioBitrate: el.audioBitrate?.value,
    audioDelay: el.audioDelay?.value,
    normalizeAudio: !!el.normalizeAudio?.checked,
    matchSource: !!el.matchSource?.checked
  };

  const file = await window.electron.saveFile({
    defaultPath: window.electron.joinPath(presetDir, 'transcode-preset.json'),
    filters: [{ name: 'Preset', extensions: ['json'] }]
  });

  if (file) {
    window.electron.writeTextFile(file, JSON.stringify(preset, null, 2));
    ipc.send('preset-saved', 'transcode');
    const name = window.electron.basename(file);
    el.status.textContent = `💾 Preset saved as ${name}`;
    refreshPresetDropdown();
    setDropdownValue('transcode-preset', name);
    if (el.presetSelect) {
      el.presetSelect.value = name;
    }
  } else {
    el.status.textContent = '⚠️ Save canceled.';
  }
});

// 📂 Load Preset
el.loadPresetBtn?.addEventListener('click', async () => {
  const file = await window.electron.openFile({
    filters: [{ name: 'Preset', extensions: ['json'] }]
  });

  if (!file) {
    el.status.textContent = '⚠️ Load canceled.';
    return;
  }

  try {
    const raw = window.electron.readTextFile(file);
    const preset = JSON.parse(raw);
    await applyPresetToFields(preset, el);
    el.status.textContent = `📂 Loaded ${window.electron.basename(file)}`;
    const name = window.electron.basename(file);
    refreshPresetDropdown();
    setDropdownValue('transcode-preset', name);
    if (el.presetSelect) {
      el.presetSelect.value = name;
    }
  } catch (err) {
    console.error('Failed to load preset:', err);
    el.status.textContent = '❌ Failed to load preset.';
  }
});

// 🧩 Auto-update summary when key fields change
[
  el.containerFormat,
  el.resolution,
  el.frameRate,
  el.audioCodec,
  el.channels,
  el.pixelFormat,
  el.colorRange,
  el.fieldOrder,
  el.sampleRate,
  el.audioBitrate,
  el.audioDelay
].forEach(elm => {
  if (elm) {
    elm.addEventListener('change', () => updateSummary(el));
  }
});


// Show unified progress and ETA like the ingest panel
if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('queue-job-start', (_e, job) => {
    if (job.panel !== 'transcode') return;
    lastProgressSnapshot = { completed: 0, total: job.total ?? 0 };
    const bar = document.getElementById('transcode-progress');
    const out = document.getElementById('transcode-progress-output');
    if (bar) { bar.value = 0; bar.style.display = 'block'; }
    if (out) out.value = '';
    const eta = ensureTranscodeEtaInline();
    if (eta) eta.textContent = '';
    const summaryFill = document.getElementById('transcode-summary-fill');
    if (summaryFill) {
      summaryFill.style.transition = 'none';
      summaryFill.style.width = '0%';
      void summaryFill.offsetWidth;
      summaryFill.style.transition = '';
    }
    showTranscodeHamster();
  });
  ipc.on('queue-job-progress', (_e, payload) => {
    if (payload.panel !== 'transcode') return;

    lastProgressSnapshot = {
      completed: typeof payload.completed === 'number' ? payload.completed : lastProgressSnapshot.completed,
      total: typeof payload.total === 'number' ? payload.total : lastProgressSnapshot.total
    };

    const bar = document.getElementById('transcode-progress');
    const out = document.getElementById('transcode-progress-output');
    const summaryFill = document.getElementById('transcode-summary-fill'); // may be null now
    if (!bar) return;

    const hasPercent =
      typeof payload.overall === 'number' ||
      typeof payload.percent === 'number' ||
      typeof payload.filePercent === 'number';
    if (hasPercent) {
      const isWatchMode = !!el.watchMode?.checked;
      let pct =
        (typeof payload.overall === 'number' ? payload.overall :
         typeof payload.percent === 'number' ? payload.percent : 0);
      if (typeof payload.filePercent === 'number' &&
          (isWatchMode || (typeof payload.overall !== 'number' && typeof payload.percent !== 'number'))) {
        pct = payload.filePercent;
      }
      pct = Math.max(0, Math.min(100, pct));

      bar.style.display = pct >= 100 ? 'none' : 'block';
      bar.value = pct;
      if (out) out.value = pct >= 100 ? '' : Math.round(pct);

      const etaEl = ensureTranscodeEtaInline();
      if (etaEl) {
        const showEta = !isWatchMode && pct < 100 && payload.eta;
        etaEl.textContent = showEta ? ` • ETA ${payload.eta}` : '';
      }

      if (summaryFill) {
        if (typeof payload.filePercent === 'number') {
          const perFile = Math.max(0, Math.min(100, payload.filePercent));
          summaryFill.style.width = `${perFile}%`;
        } else if (pct >= 100) {
          summaryFill.style.width = '100%';
        }
      }
    }

    showTranscodeHamster();

    if (payload.file && payload.status) {
      if (payload.status.transcoded) {
        logTranscode(`✅ Transcoded ${payload.file}`);
      }
      const qualityMsg = formatQualityMessage(payload.status.quality, payload.status.verified);
      if (qualityMsg) {
        logTranscode(qualityMsg);
      }
    }
  });
}


if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('watch-log', (_e, msg) => {
    logTranscode(msg);
    if (el.log) {
      el.log.textContent += `\n${msg}`;
      el.log.scrollTop = el.log.scrollHeight;
    }
  });
  ipc.on('transcode-log-message', () => {
    // Bottom one-line summary removed: ignore transient log text that targeted it.
  });
  ipc.on('queue-job-complete', (_e, job) => {
    if (job.panel !== 'transcode') return;
    currentJobId = null;
    hideTranscodeHamster();
    const completeMsg = `✅ Job complete (${lastProgressSnapshot.completed}/${lastProgressSnapshot.total || lastProgressSnapshot.completed})${job.id ? ` • ${job.id}` : ''}`;
    logTranscode(completeMsg);
    if (!el.watchMode?.checked) {
      setTranscodeControlsDisabled(false);
    }
    resetTranscodeFields().catch(() => {});
    // No bottom per-file overlay or summary text remains to update.
  });
  ipc.on('queue-job-failed', (_e, job) => {
    if (job.panel !== 'transcode') return;
    currentJobId = null;
    resetTranscodeProgressUI();
    if (!el.watchMode?.checked) {
      setTranscodeControlsDisabled(false);
    }
  });
  ipc.on('queue-job-cancelled', (_e, job) => {
    if (job.panel !== 'transcode') return;
    currentJobId = null;
    if (!el.watchMode?.checked) {
      setTranscodeControlsDisabled(false);
    }
    resetTranscodeFields().catch(() => {});
    // No bottom per-file overlay present anymore.
  });
}

function refreshPresetDropdown() {
  const hidden = el.presetSelect;
  if (!hidden) return;
  let opts = [];
  try {
    window.electron.mkdir(presetDir);
    const files = window.electron.readdir(presetDir) || [];
    opts = files
      .filter(f => f.endsWith('.json'))
      .map(f => ({ value: f, label: f.replace(/\.json$/, '') }));
  } catch (err) {
    console.error('Failed to read transcode presets:', err);
  }

  setupStyledDropdown('transcode-preset', opts);
  setDropdownValue('transcode-preset', hidden.value || '');
  window.translatePage?.();

  if (!hidden.dataset.listenerBound) {
    hidden.addEventListener('change', async () => {
      const file = hidden.value;
      if (!file) return;
      try {
        const raw = window.electron.readTextFile(
          window.electron.joinPath(presetDir, file)
        );
        const data = JSON.parse(raw);
        await applyPresetToFields(data, el);
        el.status.textContent = `📂 Loaded ${file}`;
        updateSummary(el);
      } catch (err) {
        console.error('Failed to load preset', err);
      }
    });
    hidden.dataset.listenerBound = 'true';
  }
}

refreshPresetDropdown();

// ✅ Auto-refresh preset dropdown when presets are saved or deleted
if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('preset-saved', (_e, panelId) => {
    if (panelId === 'transcode') refreshPresetDropdown();
  });
  ipc.on('preset-deleted', (_e, panelId) => {
    if (panelId === 'transcode') refreshPresetDropdown();
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    applyPresetToFields,
    gatherTranscodeConfig,
    isWatchConfigValid,
    initContainerFormats
  };
}
})();
