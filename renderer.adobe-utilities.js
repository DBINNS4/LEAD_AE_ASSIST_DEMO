/* global CSInterface, panelDebug, SystemPath, setupStyledDropdown, setDropdownValue */
(() => {
  // ✅ Prevent double-binding of events and duplicate logs
  if (window.__LEADAE_ADOBE_UTILS_INIT__) return;
  window.__LEADAE_ADOBE_UTILS_INIT__ = true;

  function buildEvalScript(fn, config) {
    if (typeof config === 'undefined') return `${fn}()`;

    const json = (typeof config === 'string' ? config : JSON.stringify(config))
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    const needsObject =
      fn === 'runIngestWorkflow' || fn === 'LEADAE_generateProxies';
    return needsObject
      ? `${fn}(JSON.parse('${json}'))`
      : `${fn}('${json}')`;
  }

  function safeEvalScript(csInterface, fn, config, cb) {
    const script = buildEvalScript(fn, config);
    return csInterface.evalScript(script, cb);
  }

  let BASE_URL = 'http://127.0.0.1:32123';
  let TOKEN = 'supersecret123'; // default; overridden by bridge credentials
  const MATCH_SOURCE_SENTINEL = 'match-source-ffmpeg';

  async function initBridgeCredentials() {
    try {
      if (!window.electron || !window.electron.invoke) return;
      const creds = await window.electron.invoke('bridge:get-credentials');
      if (creds && creds.port) {
        BASE_URL = `http://127.0.0.1:${creds.port}`;
      }
      if (creds && creds.token) {
        TOKEN = creds.token;
      }
    } catch (err) {
      try {
        console.warn('⚠️ Failed to load bridge credentials; using defaults', err);
      } catch {}
    }
  }

  function normalizeProxyPresetValue(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    if (trimmed.toLowerCase() === 'match-source') {
      return MATCH_SOURCE_SENTINEL;
    }
    return trimmed;
  }  const LEGACY_MATCH_SOURCE_SENTINEL = 'match-source';
  const isMatchSourcePreset = value =>
    value === MATCH_SOURCE_SENTINEL || value === LEGACY_MATCH_SOURCE_SENTINEL;

  const electron = window.electron ?? {};
  const ipc = window.ipc ?? electron;

  const reqTooltip = document.getElementById('automation-requirements-tooltip');
  if (reqTooltip) {
    reqTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">Automation Requirements</div>
        <ul class="tooltip-list">
          <li>Adobe Premiere Pro must be open with a project loaded.</li>
          <li>The Lead AE Assist CEP panel must be open and connected.</li>
        </ul>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What this panel is for</span>
          <ul class="tooltip-list">
            <li>Securely copy camera cards or source drives to a project volume.</li>
            <li>Optionally build Premiere bins to match your folder plan.</li>
            <li>Create edit-friendly proxies and attach them back to the master clips.</li>
            <li>Log each job for later audit, checksums, and automation hand-off.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Quick workflow</span>
          <ul class="tooltip-list">
            <li><strong>Input</strong> - select the card/folder you want to ingest.</li>
            <li><strong>Output</strong> - choose the destination (and proxy folder if needed).</li>
            <li><strong>Options</strong> - pick import, bin creation, proxies, and verification.</li>
            <li><strong>Automation</strong> - enable webhook logging if you want n8n/ops alerts.</li>
            <li><strong>Run</strong> - click <em>Automate</em> and monitor progress + summary below.</li>
          </ul>
        </div>
      </div>
    `;
  }

  const verTooltip = document.querySelector('#adobe-utilities #verification-logging-tooltip');
  if (verTooltip) {
    verTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">VERIFICATION METHODS</div>

        <div class="tooltip-section">
          <ul class="tooltip-list">
            <li><strong>None</strong> - fastest, but no data integrity check. Only use for low-risk copies.</li>
            <li><strong>Byte Compare</strong> - reads source and copy and compares bytes 1:1. Safest, but slowest.</li>
            <li><strong>BLAKE3</strong> - modern, very fast and strong. Good default for on-set and production ingest.</li>
            <li><strong>SHA-256</strong> - widely accepted cryptographic hash. Slower but often required by facilities/IT.</li>
            <li><strong>MD5</strong> - legacy option for systems that still expect MD5. Fast but weaker; use only for compatibility.</li>
            <li><strong>xxHash64</strong> - extremely fast, non-cryptographic hash. Great for high-volume sanity checks when speed matters most.</li>
          </ul>
        </div>
      </div>
    `;
  }

  function debugLog(msg, opts = {}) {
    window.logPanel?.log('adobe-utilities', msg, opts);
    if (typeof panelDebug === 'function') panelDebug(msg);
  }

  function triggerPreviewUpdate() {
    requestAnimationFrame(() => updateJobPreview());
  }

  function applyProxySectionVisibility(show, { triggerPreview = true } = {}) {
    const display = show ? 'flex' : 'none';
    if (el.proxyDestRow) {
      el.proxyDestRow.style.display = display;
    }
    if (el.proxyPresetWrapper) {
      el.proxyPresetWrapper.style.display = display;
    }
    // Ensure our toggle exists when the section is shown
    if (show) injectFfmpegFallbackToggle();
    if (triggerPreview) {
      updateJobPreview();
    }
  }

  // === FFmpeg fallback toggle (runtime-injected; no HTML edits) ===
  function injectFfmpegFallbackToggle() {
    if (!el.proxyDestRow) return;
    // Already injected?
    if (document.getElementById('adobe-disable-ffmpeg')) {
      const input = document.getElementById('adobe-disable-ffmpeg');
      input.checked = !!state.disableFfmpegFallback;
      return;
    }
    // Container
    const wrap = document.createElement('span');
    wrap.id = 'adobe-disable-ffmpeg-wrapper';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.marginLeft = '8px';
    // Input
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'adobe-disable-ffmpeg';
    input.title = 'When checked, FFmpeg fallback is disabled; AME failure aborts the job.';
    input.checked = !!state.disableFfmpegFallback;
    // Label
    const label = document.createElement('label');
    label.htmlFor = 'adobe-disable-ffmpeg';
    label.textContent = 'Disable FFmpeg fallback';
    // Bind
    input.addEventListener('change', () => {
      state.disableFfmpegFallback = input.checked;
      updateJobPreview();
    });
    wrap.appendChild(input);
    wrap.appendChild(label);
    // Place next to the Proxy Destination button if present; otherwise at row end.
    if (el.proxyDestBtn && el.proxyDestBtn.parentNode === el.proxyDestRow) {
      el.proxyDestBtn.insertAdjacentElement('afterend', wrap);
    } else {
      el.proxyDestRow.appendChild(wrap);
    }
  }

  const isCEP =
    typeof window.__adobe_cep__ !== 'undefined' &&
    typeof CSInterface !== 'undefined';

  function loadAdobeUtilitiesJSX(cb) {
    try {
      const cs = new CSInterface();
      const jsxPath = `${cs.getSystemPath(SystemPath.EXTENSION)}/jsx/adobe-utilities.jsx`;
      debugLog(`📂 Loading JSX from: ${jsxPath}`);
      const escPath = jsxPath.replace(/\\/g, '\\\\');
      cs.evalScript(`$.evalFile(new File("${escPath}"))`, res => {
        debugLog(`📂 JSX load result: ${res}`);
        cs.evalScript('typeof LEADAE_test', out => {
          debugLog(`🔍 LEADAE_test type: ${out}`);
          window.__leadAE_jsx_ready = (out === 'function');
          cb?.(out === 'function');
        });
      });
    } catch (err) {
      debugLog(`❌ loadAdobeUtilitiesJSX error: ${err.message}`);
      cb?.(false);
    }
  }

  async function ensurePremiereConnected() {
    return new Promise(resolve => {
      loadAdobeUtilitiesJSX(loaded => {
        if (!loaded) {
          resolve(false);
          return;
        }
        const cs = new CSInterface();
        safeEvalScript(cs, 'LEADAE_test', undefined, res => {
          if (!res || res.startsWith('err|')) {
            debugLog(`❌ LEADAE_test failed: ${res}`);
          } else {
            debugLog(`✅ Connection test: ${res}`);
          }
          resolve(res && res.startsWith('ok|'));
        });
      });
    });
  }

  const el = {
    srcBtn: document.getElementById('adobe-select-source'),
    destBtn: document.getElementById('adobe-select-dest'),
    startBtn: document.getElementById('start-adobe-utilities'),
    cancelBtn: document.getElementById('cancel-adobe-utilities'),
    resetBtn: document.getElementById('reset-utilities'),
    srcPath: document.getElementById('adobe-source-path'),
    destPath: document.getElementById('adobe-dest-path'),
    sourceList: document.getElementById('source-file-list'),
    sourceListGroup: document.getElementById('source-file-selection'),
    importPremiere: document.getElementById('adobe-import-premiere'),
    createBins: document.getElementById('adobe-create-bins'),
    generateProxies: document.getElementById('adobe-generate-proxies'),
    proxyPreset: document.getElementById('adobe-proxy-preset'),
    proxyPresetWrapper: document.getElementById('adobe-proxy-preset-wrapper'),
    loadProxyPreset: document.getElementById('load-proxy-preset'),
    proxyDestBtn: document.getElementById('adobe-select-proxy-dest'),
    proxyDestPath: document.getElementById('adobe-proxy-dest-path'),
    proxyDestRow: document.getElementById('adobe-proxy-dest-row'),
    binSelection: document.getElementById('adobe-bin-selection'),
    binList: document.getElementById('adobe-bin-list'),
    addFolder: document.getElementById('add-folder'),
    addSubfolder: document.getElementById('add-subfolder'),
    folderName: document.getElementById('adobe-folder-name'),
    notes: document.getElementById('adobe-notes'),
    summary: document.getElementById('adobe-summary'),
    logWindow: document.getElementById('adobe-log-window'),
    jobPreviewBox: document.getElementById('job-preview-box'),
    presetSelect: document.getElementById('adobe-utilities-preset'),
    saveConfig: document.getElementById('save-config'),
    loadConfig: document.getElementById('load-config'),
    saveLog: document.getElementById('adobe-save-log'),
    enableN8N: document.getElementById('adobe-enable-n8n'),
    n8nUrl: document.getElementById('adobe-n8n-url'),
    n8nLog: document.getElementById('adobe-n8n-log'),
    checksumMethod: document.getElementById('adobe-checksum-method'),
    enableThreads: document.getElementById('adobe-parallel'),
    autoThreads: document.getElementById('adobe-auto-threads'),
    retryFailures: document.getElementById('adobe-retry-failures'),
    concurrencySlider: document.getElementById('adobe-concurrency-slider'),
    concurrencyValue: document.getElementById('adobe-concurrency-value'),
    lockWrapper: document.getElementById('adobe-lock-wrapper'),
    lockControls: document.getElementById('adobe-lock-controls')
  };

  const state = window.watchConfigs?.adobeUtilities || {};
  window.watchConfigs = window.watchConfigs || {};
  window.watchConfigs.adobeUtilities = state;
  // Default for new flag
  if (typeof state.disableFfmpegFallback !== 'boolean') {
    state.disableFfmpegFallback = false;
  }

  if (el.notes && typeof state.notes === 'string') {
    el.notes.value = state.notes;
  }

  const FILE_INFO_HEADERS = `
    <div class="file-info-grid-header">File</div>
    <div class="file-info-grid-header">Format</div>
    <div class="file-info-grid-header">Resolution</div>
    <div class="file-info-grid-header">FPS</div>
    <div class="file-info-grid-header">Audio</div>
    <div class="file-info-grid-header">Duration</div>
  `;

  // --- Premiere compatibility helpers (conservative)
  function extOf(filePath) {
    try {
      return (window.electron.extname?.(filePath) || '').replace('.', '').toLowerCase();
    } catch {
      const m = /\.([^.]+)$/.exec(filePath || '');
      return (m?.[1] || '').toLowerCase();
    }
  }

  const IMPORTABLE_EXTS = new Set([
    // containers
    'mov','mp4','mxf','mkv','webm','avi',
    // audio
    'wav','mp3','aif','aiff','flac','ogg','m4a',
    // stills / gfx
    'jpg','jpeg','png','tiff','tif','tga','bmp','gif','psd','ai','svg'
  ]);

  const KNOWN_NOT_IMPORTABLE = new Set([
    // project/session file types
    'aep','prproj','sesx'
  ]);

  function importabilityOf(filePath) {
    const e = extOf(filePath);
    if (!e) return 'unknown';
    if (KNOWN_NOT_IMPORTABLE.has(e)) return 'no';
    if (IMPORTABLE_EXTS.has(e)) return 'yes';
    return 'unknown'; // be quiet unless we know it's bad
  }

  function setupResizableGrid(gridEl, storageKey) {
    if (!gridEl || gridEl.dataset.resizable === '1') return;
    gridEl.dataset.resizable = '1';

    const COL_VARS = [
      '--col-file', '--col-format', '--col-resolution',
      '--col-fps', '--col-audio', '--col-duration'
    ];

    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      COL_VARS.forEach(v => { if (saved[v]) gridEl.style.setProperty(v, saved[v]); });
    } catch {}

    const headers = gridEl.querySelectorAll('.file-info-grid-header');
    headers.forEach((h, idx) => {
      h.style.position = 'relative';
      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      handle.title = 'Drag to resize • Double-click to auto-fit';
      h.appendChild(handle);

      let startX = 0;
      let startW = 0;

      const finish = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        gridEl.classList.remove('resizing');
        const map = {};
        COL_VARS.forEach(v => {
          const val = gridEl.style.getPropertyValue(v);
          if (val) map[v] = val.trim();
        });
        try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
      };

      const onMove = (e) => {
        const dx = e.clientX - startX;
        const newW = Math.max(90, startW + dx);
        gridEl.style.setProperty(COL_VARS[idx], `${newW}px`);
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

      h.addEventListener('dblclick', () => {
        const all = Array.from(gridEl.children);
        const body = all.slice(6);
        let maxW = h.scrollWidth;
        for (let i = idx; i < body.length; i += 6) {
          const w = body[i]?.scrollWidth || 0;
          if (w > maxW) maxW = w;
        }
        const pad = 24;
        const newW = Math.min(Math.max(maxW + pad, 90), gridEl.clientWidth - 60);
        gridEl.style.setProperty(COL_VARS[idx], `${newW}px`);
        const map = {};
        COL_VARS.forEach(v => {
          const val = gridEl.style.getPropertyValue(v);
          if (val) map[v] = val.trim();
        });
        try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
      });
    });
  }

  function resetFileInfoGrid(panelId, storageKey) {
    const infoEl = document.getElementById(`${panelId}-file-info`);
    if (!infoEl) return null;

    infoEl.classList.add('file-info-grid');
    infoEl.classList.add('placeholder');
    infoEl.innerHTML = FILE_INFO_HEADERS;
    delete infoEl.dataset.resizable;

    // Clear any per-column inline widths
    const COL_VARS = [
      '--col-file',
      '--col-format',
      '--col-resolution',
      '--col-fps',
      '--col-audio',
      '--col-duration'
    ];
    COL_VARS.forEach(v => {
      infoEl.style.removeProperty(v);
    });

    // Drop saved widths so we go back to defaults
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }

    // Reset scroll + hide horizontal scrollbar in placeholder state
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

    // We’re about to show real rows: re-enable horizontal scroll
    const wrapper = infoEl.closest('.file-info-scroll');
    if (wrapper) {
      wrapper.classList.remove('no-hscroll');
    }

    return infoEl;
  }

  /**
   * getFileMetadata - tolerant metadata probe
   * * If ffprobe is present and returns JSON, return that object.
   * * If ffprobe missing or it errors, return a fallback object
   *   containing minimal fields (format, streams=[], and fs stats)
   *   and a `_probeError` string for soft warnings in the UI.
   */
  function getFileMetadata(filePath) {
    return new Promise(async (resolve) => {
      // default fallback skeleton
      const fallback = {
        format: { format_name: (window.electron.extname(filePath) || '').replace(/^\./, '').toUpperCase() || 'FILE' },
        streams: [],
        _probeError: null,
        _fs: {}
      };

      // attach basic filesystem info (size, mtime) if available
      try {
        const st = await window.electron.stat(filePath);
        fallback._fs.size = st?.size || 0;
        fallback._fs.mtime = st?.mtime || null;
      } catch (e) {
        // ignore - we'll still show file row
      }

      try {
        const data = await window.electron.ffprobeJson(filePath);
        if (data && !data.error) {
          data.format = data.format || { format_name: (window.electron.extname(filePath) || '').replace(/^\./, '').toUpperCase() };
          data.streams = Array.isArray(data.streams) ? data.streams : [];
          data._fs = fallback._fs;
          data._probeError = null;
          return resolve(data);
        }
        fallback._probeError = data?.error || 'FFprobe returned no data';
        return resolve(fallback);
      } catch (err) {
        // ffprobe errored (file not media, corrupt, permission, etc.)
        fallback._probeError = typeof err === 'string' ? err : `${err?.message || err}`;
        return resolve(fallback);
      }
    });
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function parseFrameRate(rFrameRate) {
    if (!rFrameRate || rFrameRate === '0/0') return 'N/A';
    const [num, denom] = rFrameRate.split('/').map(Number);
    return `${(num / denom).toFixed(2)} fps`;
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

  // ─── Container + audio helpers ─────────────────────────────────────────────
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

  function normalizeExt(p) {
    try {
      return (window.electron.extname?.(p) || '').replace(/^\./, '').toLowerCase();
    } catch {
      const m = /\.([^.]+)$/.exec(p || '');
      return (m?.[1] || '').toLowerCase();
    }
  }

  /**
   * Prefer the real file extension when ffprobe reports a container "family".
   * Examples:
   *  - "mov,mp4,..." → show MP4 for *.mp4, MOV for *.mov
   *  - "matroska"    → show MKV / WEBM based on extension
   *  - "image2"      → show the still type (JPG/PNG/…)
   */
  function resolveFormatLabel(metadata, filePath) {
    const ext = normalizeExt(filePath);
    const upperExt = ext ? ext.toUpperCase() : '';
    const reported = metadata?.format?.format_name;

    // If ffprobe had no format (or errored), fall back to extension
    if (!reported || typeof reported !== 'string' || reported === 'unknown') {
      return upperExt || 'FILE';
    }

    const tokens = reported.split(',').map(s => s.trim().toLowerCase());

    // If the extension appears in ffprobe's alias list, prefer it
    if (ext && tokens.includes(ext)) return upperExt;

    // QuickTime/MP4 family: ffprobe often lists "mov,mp4,..."
    if (tokens.includes('mov') && ext === 'mp4') return 'MP4';
    if (tokens.includes('mp4') && ext === 'mov') return 'MOV';

    // Matroska family
    if (tokens.includes('matroska')) {
      if (ext === 'mkv') return 'MKV';
      if (ext === 'webm') return 'WEBM';
    }

    // Stills: ffprobe may return "image2"—prefer the real still type
    if (tokens.includes('image2') && upperExt) return upperExt;

    // Otherwise, use the first token as a last resort
    return (tokens[0] || upperExt || 'FILE').toUpperCase();
  }

  async function renderAdobeGrid(files) {
    const grid = prepareFileInfoGrid('adobe');
    if (!grid) return;

    for (const filePath of files) {
      const metadata = await getFileMetadata(filePath);
      const format = metadata.format || {};
      const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
      const container = resolveFormatLabel(metadata, filePath);
      const videoStream = streams.find(s => s.codec_type === 'video');
      const audioInfo = summarizeAudioStreams(streams);

      // human-friendly cells with fallbacks
      const duration = format.duration ? formatDuration(+format.duration) : (metadata._fs?.size ? '—' : 'N/A');
      const resolution = videoStream ? `${videoStream.width}×${videoStream.height}` : (audioInfo.tracks > 0 ? 'Audio only' : 'N/A');
      const frameRate = formatFrameRateForGrid(metadata);

      const fileName = window.electron.basename
        ? window.electron.basename(filePath)
        : (filePath.split(/[\\/]/).pop() || filePath);

      // warning icon if probe had trouble — tooltip shows the ffprobe error
      const warn = metadata._probeError ? `<span class="file-warn" title="${(String(metadata._probeError)).replace(/"/g,'&quot;')}">⚠️</span>` : '';

      const row = `
        <div class="file-info-row">
          <div title="${filePath}">${fileName} ${warn}</div>
          <div>${container}</div>
          <div>${resolution}</div>
          <div>${frameRate}</div>
          <div>${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}</div>
          <div>${duration}</div>
        </div>`;

      grid.insertAdjacentHTML('beforeend', row);
    }

    grid.classList.remove('placeholder');
    // Enable column resizing (persist widths)
    setupResizableGrid(grid, 'adobe-file-grid');
  }

  if (el.enableN8N && typeof state.enableN8N === 'boolean') {
    el.enableN8N.checked = state.enableN8N;
  }
  if (el.n8nLog && typeof state.n8nLog === 'boolean') {
    el.n8nLog.checked = state.n8nLog;
  }
  if (el.n8nUrl && typeof state.n8nUrl === 'string') {
    el.n8nUrl.value = state.n8nUrl;
  }

  if (el.enableThreads && typeof state.enableThreads === 'boolean') {
    el.enableThreads.checked = state.enableThreads;
  }
  if (el.autoThreads && typeof state.autoThreads === 'boolean') {
    el.autoThreads.checked = state.autoThreads;
  }
  if (el.retryFailures && typeof state.retryFailures === 'boolean') {
    el.retryFailures.checked = state.retryFailures;
  }
  if (el.concurrencySlider) {
    if (typeof state.maxThreads === 'number') {
      el.concurrencySlider.value = String(state.maxThreads);
    } else if (!el.concurrencySlider.value) {
      el.concurrencySlider.value = '3';
    }
  }

  function syncAutomationState() {
    state.enableN8N = !!el.enableN8N?.checked;
    const raw = el.n8nUrl?.value;
    state.n8nUrl = typeof raw === 'string' ? raw.trim() : '';
    state.n8nLog = !!el.n8nLog?.checked;
  }

  syncAutomationState();

  function getThreadSettings() {
    // 🔗 Invariant: Auto Threads implies Parallel Copy (enableThreads)
    if (el.autoThreads?.checked && el.enableThreads && !el.enableThreads.checked) {
      el.enableThreads.checked = true;
    }

    const enableThreads = !!el.enableThreads?.checked;
    const autoThreads = !!el.autoThreads?.checked;
    let maxThreads;
    if (!enableThreads) {
      maxThreads = 1;
    } else if (autoThreads) {
      maxThreads = null;
    } else {
      const parsed = parseInt(el.concurrencySlider?.value || '1', 10);
      const clamped = Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 1), 10);
      maxThreads = clamped;
    }
    return { enableThreads, autoThreads, maxThreads };
  }

  function syncThreadState() {
    if (!state) return { enableThreads: false, autoThreads: false, maxThreads: 1 };
    const settings = getThreadSettings();
    state.enableThreads = settings.enableThreads;
    state.autoThreads = settings.autoThreads;
    state.maxThreads = settings.maxThreads;
    state.retryFailures = !!el.retryFailures?.checked;
    return settings;
  }

  function updateThreadControls() {
    const slider = el.concurrencySlider;
    const label = el.concurrencyValue;
    const settings = getThreadSettings();

    // If Parallel Copy is turned off, Auto Threads cannot stay on
    if (!settings.enableThreads && el.autoThreads && el.autoThreads.checked) {
      el.autoThreads.checked = false;
    }

    if (!slider || !label) {
      syncThreadState();
      return;
    }

    if (!settings.enableThreads) {
      slider.disabled = true;
      slider.value = '1';
      label.textContent = '1';
    } else if (settings.autoThreads) {
      slider.disabled = true;
      if (!slider.value) {
        slider.value = settings.maxThreads == null ? '3' : String(settings.maxThreads);
      }
      label.textContent = 'Auto';
    } else {
      slider.disabled = false;
      if (!slider.value) {
        slider.value = String(settings.maxThreads || 1);
      }
      label.textContent = slider.value;
    }

    syncThreadState();
  }

  updateThreadControls();

  if (el.checksumMethod && !el.checksumMethod.value) {
    el.checksumMethod.value = 'none';
  }

  if (typeof setupStyledDropdown === 'function') {
    const checksumOptions = [
      { value: 'none', label: 'None' },
      { value: 'bytecompare', label: 'Byte Compare' },
      { value: 'blake3', label: 'BLAKE3' },
      { value: 'sha256', label: 'SHA-256' },
      { value: 'md5', label: 'MD5' },
      { value: 'xxhash64', label: 'xxHash64' }
    ];
    setupStyledDropdown('adobe-checksum-method', checksumOptions);
    if (typeof setDropdownValue === 'function') {
      setDropdownValue('adobe-checksum-method', el.checksumMethod?.value || 'none');
    }
  }

  // === Adobe Automate Cancel Support ===
  let currentJobId = null;
  let currentJobStage = null;
  // ⛳️ One-shot latch so the panel only resets once per job
  let __adobeJobCompleted = false;

  // ───────────────────────────────────────────────────────────────
  // Finalize-once latch that survives reconnects (per job ID)
  // ───────────────────────────────────────────────────────────────
  const JOB_LATCH_KEY = '__leadae_adobe_job_latch';
  function _getLatch() {
    try {
      return JSON.parse(sessionStorage.getItem(JOB_LATCH_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }
  function _setLatch(obj) {
    try {
      sessionStorage.setItem(JOB_LATCH_KEY, JSON.stringify(obj || {}));
    } catch (_) {}
  }
  function currentJobKeyFrom(job, payload) {
    // prefer explicit job.id; otherwise fall back to currentJobId
    const id =
      job?.id ||
      job?.jobId ||
      payload?.job?.id ||
      payload?.job?.jobId ||
      payload?.jobId ||
      payload?.id ||
      currentJobId ||
      'unknown';
    return String(id);
  }
  function wasFinalized(jobKey) {
    const m = _getLatch();
    return !!m[jobKey || 'unknown'];
  }
  function markFinalized(jobKey) {
    const m = _getLatch();
    m[jobKey || 'unknown'] = Date.now();
    _setLatch(m);
    __adobeJobCompleted = true;
  }
  function clearFinalized(jobKey) {
    const m = _getLatch();
    if (jobKey && m[jobKey]) {
      delete m[jobKey];
      _setLatch(m);
    }
  }

  if (el.cancelBtn) el.cancelBtn.disabled = true;

  const adobeLockSelector =
    '#adobe-lock-wrapper input, #adobe-lock-wrapper select, #adobe-lock-wrapper textarea, #adobe-lock-wrapper button';

  function setAdobeAutomateControlsDisabled(state) {
    document.querySelectorAll(adobeLockSelector).forEach(node => {
      if (node.id === 'cancel-adobe-utilities') return;
      if (!state && node.dataset.locked === 'true') {
        node.disabled = true;
        return;
      }
      node.disabled = state;
    });

    if (state) {
      el.lockWrapper?.classList.add('locked');
      el.lockControls?.classList.add('locked');
      if (el.cancelBtn) el.cancelBtn.disabled = false;
    } else {
      el.lockWrapper?.classList.remove('locked');
      el.lockControls?.classList.remove('locked');
    }
  }

  if (state.currentJobId) {
    currentJobId = state.currentJobId;
    currentJobStage = state.currentJobStage || null;
    setAdobeAutomateControlsDisabled(true);
    if (el.cancelBtn) el.cancelBtn.disabled = false;
  }

  function autoResize(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).maxHeight) || 0;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight || textarea.scrollHeight);
    textarea.style.height = `${newHeight}px`;
  }

  function updateSourcePathDisplay(paths = []) {
    if (!el.srcPath) return;
    if (paths.length === 0) {
      el.srcPath.value = '';
    } else if (paths.length === 1) {
      el.srcPath.value = paths[0];
    } else {
      el.srcPath.value = `${paths.length} items selected:\n${paths.join('\n')}`;
    }
    autoResize(el.srcPath);
  }

  function flattenPaths(paths = []) {
    const out = [];
    function walk(p) {
      try {
        const stat = electron.statSync?.(p);
        if (stat && stat.isDirectory()) {
          const entries =
            electron.readdirWithTypes?.(p) ||
            electron.readdir?.(p, { withFileTypes: true }) || [];
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const next = electron.joinPath
              ? electron.joinPath(p, entry.name)
              : `${p}/${entry.name}`;
            walk(next);
          }
        } else {
          out.push(p);
        }
      } catch {
        out.push(p);
      }
    }
    paths.forEach(walk);
    return out;
  }

  const presetDir = electron.resolvePath('config', 'presets', 'adobe-utilities');
  const proxyPresetDir = electron.resolvePath('presets', 'Adobe');
  const proxyMatchRules = `
Proxy Attachment Rules:
• Container must match (mov/mp4)
• Resolution/frame size must match source
• Frame rate must match source
• Audio channels must match source
`;

  // cache last message to suppress duplicates
  let lastLogMsg = '';

  function setUILog(msg, { append = true, isError } = {}) {
    const logEl = el.logWindow;
    const normalizedMsg = typeof msg === 'string' ? msg : String(msg ?? '');

    if (!append && !normalizedMsg) {
      if (logEl) logEl.textContent = '';
      lastLogMsg = '';
      return;
    }

    if (normalizedMsg === lastLogMsg) return;
    lastLogMsg = normalizedMsg;

    const hasErrorPrefix = normalizedMsg.trim().startsWith('❌');
    const effectiveIsError =
      typeof isError === 'boolean' ? isError : normalizedMsg.includes('❌');
    const prefix = effectiveIsError && !hasErrorPrefix ? '❌ ' : '';
    const now = new Date().toLocaleTimeString();
    const line = `[${now}] ${prefix}${normalizedMsg}`;

    if (logEl) {
      if (append) {
        logEl.textContent = logEl.textContent
          ? `${logEl.textContent}\n${line}`
          : line;
      } else {
        logEl.textContent = line;
      }
    }

    window.logPanel?.log('adobe-utilities', line, { isError: effectiveIsError });
    if (typeof panelDebug === 'function') panelDebug(line);
    logToViewer(line, { isError: effectiveIsError });
  }

  // 🔊 Also forward key events to the global Log Viewer
  function logToViewer(
    msg,
    { detail = '', isError = false, fileId = '' } = {}
  ) {
    try {
      ipc?.send?.('adobe-utilities-log-message', { msg, detail, isError, fileId });
    } catch {
      /* noop */
    }
  }

  function whenCEPReady(cb, timeoutMs = 3000) {
    const start = Date.now();
    const t = setInterval(() => {
      if (window.__adobe_cep__ && typeof CSInterface !== 'undefined') {
        clearInterval(t);
        cb();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        const msg = `❌ CEP not ready after ${timeoutMs}ms — CSInterface: ${typeof CSInterface}, CEP: ${typeof window.__adobe_cep__}`;
        debugLog(msg);
      }
    }, 100);
  }

  function initCS() {
    try {
      if (typeof CSInterface !== 'undefined') {
        window.csInterface = new CSInterface();
        console.log('✅ CSInterface initialized');
        if (typeof panelDebug === 'function') panelDebug('✅ CSInterface initialized');
      } else {
        console.warn('⚠️ CSInterface is undefined — not in CEP environment');
        if (typeof panelDebug === 'function')
          panelDebug('⚠️ CSInterface is undefined — not in CEP environment');
        window.csInterface = undefined;
      }
    } catch (err) {
      console.error('CSInterface init error:', err);
      if (typeof panelDebug === 'function')
        panelDebug(`CSInterface init error: ${err?.message || err}`);
      window.csInterface = undefined;
    }
  }

  function registerPremiereEvents() {
    if (!window.csInterface) return;
    window.csInterface.addEventListener('premiere-attach-proxy', e => {
      let pairs = [];
      try {
        pairs = JSON.parse(e.data || '[]');
      } catch (err) {
        debugLog(`❌ premiere-attach-proxy parse error: ${err}`);
      }
      if (pairs && pairs.length) {
        // Force stringify for ExtendScript
        const arg = JSON.stringify(pairs);
        safeEvalScript(window.csInterface, 'LEADAE_attachProxy', arg);
      }
    });
  }

  const reconnectButtonFallback = {
    reconnect: 'Reconnect',
    bridgeOnly: 'Bridge Only',
    connected: 'Connected'
  };

  function getReconnectInput() {
    return document.getElementById('reconnect-checkbox');
  }

  function getReconnectLabel() {
    return document.querySelector('label[for="reconnect-checkbox"]');
  }

  function translateReconnectButton(label, key) {
    if (!label) return;
    const text = window.i18n?.t ? window.i18n.t(key) : reconnectButtonFallback[key] ?? key;
    label.setAttribute('aria-label', text);
    label.setAttribute('title', text);
    label.dataset.state = key;
    window.translatePage?.();
  }

  function setReconnectButtonState(state) {
    const input = getReconnectInput();
    const label = getReconnectLabel();

    let labelKey = 'reconnect';
    let checked = false;
    let indeterminate = false;

    if (typeof state === 'boolean') {
      labelKey = state ? 'connected' : 'reconnect';
      checked = !!state;
    } else if (typeof state === 'string') {
      if (state === 'connected') {
        labelKey = 'connected';
        checked = true;
      } else if (state === 'bridge-only' || state === 'bridgeOnly' || state === 'bridge') {
        labelKey = 'bridgeOnly';
        indeterminate = true;
      } else {
        labelKey = 'reconnect';
      }
    } else if (state && typeof state === 'object') {
      const backendConnected = !!state.backend;
      const premiereProvided = Object.prototype.hasOwnProperty.call(state, 'premiere');
      const premiereConnected = !!state.premiere;

      if (backendConnected && premiereProvided) {
        if (premiereConnected) {
          labelKey = 'connected';
          checked = true;
        } else {
          labelKey = 'bridgeOnly';
          indeterminate = true;
        }
      } else if (backendConnected) {
        // Treat backend true with no Premiere info as fully connected
        labelKey = 'connected';
        checked = true;
      }
    }

    const shouldDisable = labelKey === 'connected';

    if (input) {
      input.checked = checked;
      input.indeterminate = indeterminate;
      input.disabled = shouldDisable;
    }
    translateReconnectButton(label, labelKey);
    if (label) {
      if (shouldDisable) {
        label.setAttribute('aria-disabled', 'true');
      } else {
        label.removeAttribute('aria-disabled');
      }
    }
  }

  function broadcastState(state) {
    try {
      window.__leadAE_socket?.send(
        JSON.stringify({
          type: 'connection-state',
          ...state
        })
      );
    } catch (err) {
      console.warn('Failed to broadcast state', err);
    }
  }

  function initializeReconnectButtonState() {
    const openState = window.WebSocket?.OPEN ?? 1;
    const isConnected = window.__leadAE_socket?.readyState === openState;
    setReconnectButtonState({ backend: !!isConnected, premiere: false });
  }

  async function connectToLeadAE(_force = false) {
    await initBridgeCredentials();
    try {

      await fetch(`${BASE_URL}/heartbeat`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });

      await fetch(`${BASE_URL}/handshake`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });

      const socket = new WebSocket(BASE_URL.replace('http', 'ws'), ['Bearer', TOKEN]);
      const pingInterval = setInterval(
        () => socket.send(JSON.stringify({ type: 'ping' })),
        25000
      );
      socket.onopen = () => {
        debugLog(
          '✅ Assist WebSocket open → should trigger [CEP Bridge] WebSocket connected in terminal'
        );
        debugLog('✅ Connected to Lead AE');

        if (isCEP) {
          ensurePremiereConnected().then(premiereConnected => {
            if (window.__leadAE_socket === socket) {
              const state = { backend: true, premiere: premiereConnected };
              setReconnectButtonState(state);
              broadcastState(state);
              debugLog(`🔄 Broadcast state: ${JSON.stringify(state)}`);
            }
          });
        } else if (window.__leadAE_socket === socket) {
          // Only mark backend alive, don't force premiere=false
          setReconnectButtonState({ backend: true });
        }
      };
      socket.onclose = e => {
        clearInterval(pingInterval);
        if (window.__leadAE_socket === socket) {
          const state = { backend: false, premiere: false };
          setReconnectButtonState(state);
          broadcastState(state);
        }
        debugLog(`🔌 WS closed ${e.code} ${e.reason || ''}`);
      };
      socket.onerror = e => debugLog(`❌ WS error: ${e?.message || e}`);
      socket.onmessage = e => {
        debugLog(`📩 ${e.data}`);
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === 'connection-state') {
            debugLog(
              `📩 connection-state received: backend=${msg.backend}, premiere=${msg.premiere}`
            );
            setReconnectButtonState({
              backend: !!msg.backend,
              premiere: !!msg.premiere
            });
          }
        } catch (err) {
          debugLog(`❌ WS message parse error: ${err}`);
        }
      };

      window.__leadAE_socket = socket;
    } catch (err) {
      debugLog(`❌ connectToLeadAE error: ${err?.message || err}`);
      const openState = window.WebSocket?.OPEN ?? 1;
      if (window.__leadAE_socket?.readyState !== openState) {
        setReconnectButtonState(false);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureHamsterStructure(document.querySelector('#cep-job-status .wheel-and-hamster'));
    initializeReconnectButtonState();
    setTimeout(() => {
      debugLog('⏳ Auto-connecting to CEP bridge…');
      connectToLeadAE(true);
    }, 500);
    if (isCEP) {
      // Inside Premiere CEP panel
      whenCEPReady(() => {
        initCS();
        registerPremiereEvents();
        loadAdobeUtilitiesJSX(connected => {
          if (connected) debugLog('✅ Premiere connected on startup');
          else debugLog('⚠️ Premiere not connected on startup');
        });
      });
      // Create our toggle as soon as the row exists
      setTimeout(injectFfmpegFallbackToggle, 0);
    } else {
      // Electron-only: skip CEP init
      console.log('⚠️ Not inside Adobe — skipping CEP init');
    }
  });

  const reconnectInput = document.getElementById('reconnect-checkbox');
  reconnectInput?.addEventListener('change', event => {
    if (reconnectInput.disabled || event.target?.disabled) return;
    debugLog('🔄 Reconnecting…');
    setReconnectButtonState(false);
    connectToLeadAE();
  });

  let folderOrder = Array.isArray(state.binFolders) ? [...state.binFolders] : [];
  let draggedChildren = [];
  const fileToBinMap = {};
  let unassignedFiles = [];
  let lastSelectedIndex;

  const folderGroup = el.folderName?.closest('.field-group');

  function renderFolderList() {
    if (!el.binList) return;
    el.binList.innerHTML = '';
    folderOrder.forEach(id => {
      const depth = id.split('/').length - 1;
      const li = document.createElement('li');
      li.className = 'draggable-item';
      li.dataset.id = id;
      li.dataset.groupId = id.split('/')[0];
      li.style.marginLeft = `${depth * 40}px`;

      const container = document.createElement('div');
      container.className = 'folder-row';
      container.style.display = 'flex';
      container.style.alignItems = 'center';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = depth > 0 ? '↳ ' + id.split('/').pop() : id;
      container.appendChild(labelSpan);
      li.appendChild(container);

      if (depth === 0) {
        li.dataset.root = 'true';
        li.draggable = true;
        li.addEventListener('dragstart', handleDragStart);
        li.addEventListener('dragend', handleDragEnd);
      } else {
        li.dataset.root = 'false';
        li.draggable = false;
        li.classList.add('subfolder');
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-files-btn';
      removeBtn.textContent = '-';
      removeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const targetId = li.dataset.id;
        const idsToRemove = folderOrder.filter(
          f => f === targetId || f.startsWith(`${targetId}/`)
        );

        const filesToRestore = Object.entries(fileToBinMap)
          .filter(([, bin]) => idsToRemove.some(id => bin.startsWith(id)))
          .map(([file]) => file);

        filesToRestore.forEach(file => {
          delete fileToBinMap[file];
          if (!unassignedFiles.includes(file)) unassignedFiles.push(file);
        });
        folderOrder = folderOrder.filter(f => !idsToRemove.includes(f));
        renderFolderList();
        triggerPreviewUpdate();
        state.binFolders = folderOrder.slice();

        renderSourceFileList();
      });
      li.appendChild(removeBtn);

      li.addEventListener('dragover', e => e.preventDefault());
      li.addEventListener('drop', e => {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if (data) {
          let files;
            try {
              files = JSON.parse(data);
              if (!Array.isArray(files)) files = [data];
            } catch {
              files = data
                .split('\n')
                .map(f => f.trim())
                .filter(Boolean);
            }
          files.forEach(filePath => {
            fileToBinMap[filePath] = li.dataset.id;
            unassignedFiles = unassignedFiles.filter(f => f !== filePath);
          });
          renderSourceFileList();
          triggerPreviewUpdate();
          renderFolderList();
          triggerPreviewUpdate();
        }
      });

      li.addEventListener('mousedown', event => {
        if (event.target.closest('button')) return;
        el.binList.querySelectorAll('li.draggable-item').forEach(item => item.classList.remove('selected'));
        li.classList.add('selected');
      });

      el.binList.appendChild(li);
    });

    triggerPreviewUpdate();
  }

  function renderSourceFileList() {
    if (!el.sourceList) return;
    el.sourceList.innerHTML = '';
    unassignedFiles.forEach((file, index) => {
      const li = document.createElement('li');
      li.className = 'draggable-item';
      li.textContent = file;
      li.dataset.path = file;
      li.draggable = true;

      li.addEventListener('mousedown', e => {
        const alreadySelected = li.classList.contains('selected');
        if (e.shiftKey && typeof lastSelectedIndex === 'number') {
          const items = el.sourceList.querySelectorAll('li.draggable-item');
          const start = Math.min(lastSelectedIndex, index);
          const end = Math.max(lastSelectedIndex, index);
          for (let i = start; i <= end; i++) {
            items[i].classList.add('selected');
          }
        } else if (!e.ctrlKey && !e.metaKey && !alreadySelected) {
          el.sourceList
            .querySelectorAll('li.draggable-item.selected')
            .forEach(item => item.classList.remove('selected'));
          li.classList.add('selected');
        } else if (e.ctrlKey || e.metaKey) {
          li.classList.toggle('selected');
        }
        lastSelectedIndex = index;
      });

      li.addEventListener('dragstart', e => {
        const selected = el.sourceList.querySelectorAll(
          'li.draggable-item.selected'
        );
        const files = selected.length
          ? Array.from(selected).map(item => item.dataset.path)
          : [file];
        e.dataTransfer.setData('text/plain', JSON.stringify(files));

        if (files.length > 1) {
          const dragPreview = document.createElement('div');
          dragPreview.style.position = 'absolute';
          dragPreview.style.top = '-9999px';
          dragPreview.style.left = '-9999px';
          dragPreview.style.padding = '4px 8px';
          dragPreview.style.background = '#1e2a38';
          dragPreview.style.color = '#fff';
          dragPreview.style.border = '1px solid #ccc';
          dragPreview.style.borderRadius = '4px';
          dragPreview.style.fontSize = '12px';
          dragPreview.style.fontFamily = 'Courier New, monospace';
          dragPreview.textContent = `${files.length} files`;
          document.body.appendChild(dragPreview);
          e.dataTransfer.setDragImage(dragPreview, 0, 0);
          setTimeout(() => document.body.removeChild(dragPreview), 0);
        }
      });

      el.sourceList.appendChild(li);
    });
  }

  function getDragAfterElement(y) {
    const items = [...el.binList.querySelectorAll('.draggable-item:not(.dragging)')].filter(i => !draggedChildren.includes(i));
    return items.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  }

  function handleDragStart(e) {
    const li = e.target.closest('li.draggable-item');
    if (!li || li.dataset.root !== 'true') {
      e.preventDefault();
      return;
    }
    const groupId = li.dataset.groupId;
    li.classList.add('dragging');
    const prefix = groupId + '/';
    draggedChildren = [...el.binList.querySelectorAll('li.draggable-item')].filter(item => item.dataset.id.startsWith(prefix) && item.dataset.id !== li.dataset.id);
  }

  function handleDragEnd() {
    const dragging = el.binList.querySelector('.dragging');
    if (dragging) dragging.classList.remove('dragging');
    draggedChildren = [];
    folderOrder = [...el.binList.querySelectorAll('li.draggable-item')].map(li => li.dataset.id);
  }

  el.binList?.addEventListener('dragover', e => {
    e.preventDefault();
    const after = getDragAfterElement(e.clientY);
    const dragging = el.binList.querySelector('.dragging');
    if (!dragging) return;
    const isAfterRoot = after?.dataset?.root === 'true';
    if (after == null) {
      el.binList.appendChild(dragging);
      draggedChildren.forEach(child => el.binList.appendChild(child));
    } else if (isAfterRoot) {
      el.binList.insertBefore(dragging, after);
      draggedChildren.forEach(child => el.binList.insertBefore(child, after));
    }
  });

  el.addFolder?.addEventListener('click', () => {
    const name = el.folderName.value.trim();
    if (!name || folderOrder.includes(name)) return;
    folderOrder.push(name);
    el.folderName.value = '';
    renderFolderList();
    triggerPreviewUpdate();
    const newItem = el.binList.querySelector(`[data-id="${CSS.escape(name)}"]`);
    if (newItem) newItem.classList.add('selected');
  });

  el.addSubfolder?.addEventListener('click', () => {
    const name = el.folderName.value.trim();
    if (!name) return;
    const selected = el.binList.querySelector('li.draggable-item.selected');
    if (!selected) {
      setUILog('❌ Please select a folder to nest under.');
      return;
    }
    const base = selected.dataset.id;
    const full = `${base}/${name}`;
    if (folderOrder.includes(full)) return;
    let insertPos = folderOrder.indexOf(base) + 1;
    while (insertPos < folderOrder.length && folderOrder[insertPos].startsWith(`${base}/`)) insertPos++;
    folderOrder.splice(insertPos, 0, full);
    el.folderName.value = '';
    renderFolderList();
    triggerPreviewUpdate();
    const newItem = el.binList.querySelector(`[data-id="${CSS.escape(full)}"]`);
    if (newItem) newItem.classList.add('selected');
  });

  function getBinPaths() {
    const items = [...el.binList.querySelectorAll('li.draggable-item')];
    return items.map(li => li.dataset.id);
  }

  function toggleBinControls() {
    const show = el.createBins?.checked;
    if (el.binSelection) el.binSelection.style.display = show ? '' : 'none';
    if (el.sourceListGroup) el.sourceListGroup.style.display = show ? '' : 'none';
    if (folderGroup) folderGroup.style.display = show ? '' : 'none';
  }

  function gatherConfig() {
    const selectedMethod = (el.checksumMethod?.value || 'none').toLowerCase();
    const webhookUrl = typeof el.n8nUrl?.value === 'string' ? el.n8nUrl.value.trim() : '';
    const config = {
      sources: state.sources || [],
      destination: state.destination || '',
      importPremiere: !!el.importPremiere?.checked,
      createBins: !!el.createBins?.checked,
      generateProxies: !!el.generateProxies?.checked,
      proxyPreset: normalizeProxyPresetValue(el.proxyPreset?.value || ''),
      proxyDest: state.proxyDest || '',
      binFolders: folderOrder.slice(),
      saveLog: !!el.saveLog?.checked,
      notes: el.notes?.value || '',
      enableN8N: !!el.enableN8N?.checked,
      n8nUrl: webhookUrl,
      n8nLog: !!el.n8nLog?.checked,
      verification: {
        method: selectedMethod
      }
    };
    // Map UI flag → backend flag: true (disable) ⇒ ffmpegFallback:false
    if (state.disableFfmpegFallback) {
      config.ffmpegFallback = false;
    }

    const threadSettings = syncThreadState();
    config.enableThreads = threadSettings.enableThreads;
    config.autoThreads = threadSettings.autoThreads;
    config.maxThreads = threadSettings.maxThreads;
    config.retryFailures = !!el.retryFailures?.checked;

    if (el.notes) {
      state.notes = el.notes.value;
    }

    syncAutomationState();

    if (config.createBins) {
      config.bins = getBinPaths();
      config.fileToBinMap = { ...fileToBinMap };
    }
    config.sources = flattenPaths(config.sources);

    const verificationLabelMap = {
      none: 'None',
      bytecompare: 'Byte Compare',
      blake3: 'BLAKE3',
      sha256: 'SHA-256',
      md5: 'MD5',
      xxhash64: 'xxHash64'
    };

    const lines = [];
    lines.push('🚀 Job Preview:');
    lines.push(`• Sources: ${config.sources.length}`);
    if (config.destination) lines.push(`• Destination: ${config.destination}`);
    if (config.notes && config.notes.trim()) {
      lines.push(`• Notes: ${config.notes.trim()}`);
    }
    if (config.importPremiere) lines.push('• Import into Premiere: Yes');
    if (config.createBins) {
      lines.push('• Create Bins: Yes');
      const map = config.fileToBinMap || {};
      const binToFiles = Object.entries(map).reduce((acc, [file, bin]) => {
        const name = electron.basename?.(file) || file;
        if (!acc[bin]) acc[bin] = [];
        acc[bin].push(name);
        return acc;
      }, {});

      const orderedBins = Array.isArray(config.bins) && config.bins.length
        ? [...config.bins]
        : Array.isArray(config.binFolders)
          ? [...config.binFolders]
          : [];
      const missingBins = Object.keys(binToFiles).filter(bin => !orderedBins.includes(bin));
      orderedBins.push(...missingBins);

      if (orderedBins.length) {
        lines.push('• Bin Assignments:');
        const maxPerBin = 10;
        orderedBins.forEach(binPath => {
          const depth = binPath ? (binPath.match(/\//g) || []).length : 0;
          const indent = '   '.repeat(depth + 1);
          const labelParts = binPath.split('/').filter(Boolean);
          const label = labelParts.length ? labelParts[labelParts.length - 1] : binPath || '(root)';
          lines.push(`${indent}• ${label}`);
          const files = binToFiles[binPath] || [];
          if (files.length) {
            const fileIndent = '   '.repeat(depth + 2);
            files.slice(0, maxPerBin).forEach(name => {
              lines.push(`${fileIndent}- ${name}`);
            });
            if (files.length > maxPerBin) {
              lines.push(`${fileIndent}…and ${files.length - maxPerBin} more`);
            }
          }
        });
      }
    }

    const maxList = 20; // avoid overly long previews; adjust to taste
    if (config.sources?.length) {
      const names = config.sources.map(f => electron.basename?.(f) || f);
      const verb = config.importPremiere
        ? 'import'
        : config.destination
          ? 'copy'
          : 'process';
      lines.push(`• Files to ${verb}:`);
      names.slice(0, maxList).forEach(n => lines.push(`   • ${n}`));
      if (names.length > maxList) {
        lines.push(`   …and ${names.length - maxList} more`);
      }
    }

    if (config.generateProxies) {
      lines.push('• Generate Proxies: Yes');

      let presetName = '(none)';
      if (isMatchSourcePreset(config.proxyPreset)) {
        presetName = 'Match Source (FFMPEG – dynamic, no .epr)';
      } else if (config.proxyPreset) {
        try {
          const parts = config.proxyPreset.split(/[\\/]/);
          presetName = parts[parts.length - 1] || config.proxyPreset;
        } catch {
          presetName = config.proxyPreset;
        }
      }

      lines.push(`   Preset: ${presetName}`);
      let displayProxyDest = config.proxyDest;

      if (!displayProxyDest) {
        if (config.destination) {
          const base = config.destination.replace(/[\\/]+$/, '');
          displayProxyDest = `${base}/Proxies (auto)`;
        } else {
          displayProxyDest = '(not set)';
        }
      }

      lines.push(`   Proxy Dest: ${displayProxyDest}`);
      if (isMatchSourcePreset(config.proxyPreset)) {
        lines.push('   • Dynamic FFmpeg mode (no Adobe Media Encoder preset)');
      }
      lines.push(`   FFmpeg fallback: ${state.disableFfmpegFallback ? 'Disabled' : 'Auto'}`);
      // Single-group mode in effect (no compatibility auto-split).
    }

    if (selectedMethod) {
      const pretty = verificationLabelMap[selectedMethod] || selectedMethod;
      lines.push(`• Verification: ${pretty}`);
    }

    if (config.saveLog) {
      lines.push('• Save Log: Yes');
    }

    if (config.enableThreads) {
      if (config.autoThreads) {
        lines.push('• Threading: Parallel copy (Auto threads)');
      } else {
        const threadCount = config.maxThreads || 1;
        const plural = threadCount === 1 ? 'thread' : 'threads';
        lines.push(`• Threading: Parallel copy — ${threadCount} ${plural}`);
      }
    } else {
      lines.push('• Threading: Single-thread (Parallel copy off)');
    }

    if (config.retryFailures) {
      lines.push('• Retry Failed Copies: Yes');
    }

    if (config.enableN8N) {
      lines.push(`• Webhook: ${config.n8nUrl ? config.n8nUrl : 'Enabled'}`);
      if (config.n8nLog) {
        lines.push('   • Send log payload');
      }
    } else {
      lines.push('• Webhook: Disabled');
    }

    config.summary = lines.join('\n');
    return config;
  }

  let lastSummary = '';

  function updateJobPreview() {
    const cfg = gatherConfig();

    // Only show a preview once we actually have at least one source
    const hasSources = Array.isArray(cfg.sources) && cfg.sources.length > 0;

    if (!hasSources) {
      lastSummary = '';
      if (el.jobPreviewBox) {
        el.jobPreviewBox.value = '';
        autoResize(el.jobPreviewBox);
      }
      return;
    }

    // Update the inline preview when the summary changes without spamming the log
    if (cfg.summary && cfg.summary !== lastSummary) {
      if (el.jobPreviewBox) {
        el.jobPreviewBox.value = cfg.summary;
        autoResize(el.jobPreviewBox);
      }
    }

    if (cfg.summary) {
      lastSummary = cfg.summary;
    }
  }

  function applyPreset(data) {
    const files = flattenPaths(data.sources || []);
    state.sources = files;
    state.destination = data.destination || '';
    state.proxyDest = data.proxyDest || '';
    if (el.destPath) el.destPath.value = state.destination;
    if (el.proxyDestPath) el.proxyDestPath.value = state.proxyDest;
    if (el.importPremiere) el.importPremiere.checked = !!data.importPremiere;
    if (el.createBins) el.createBins.checked = !!data.createBins;
    if (el.generateProxies) el.generateProxies.checked = !!data.generateProxies;
    if (el.proxyPreset) {
      const presetValue = isMatchSourcePreset(data.proxyPreset)
        ? MATCH_SOURCE_SENTINEL
        : normalizeProxyPresetValue(data.proxyPreset || '');
      el.proxyPreset.value = presetValue;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-proxy-preset', presetValue);
      }
    }
    if (el.saveLog) el.saveLog.checked = !!data.saveLog;
    if (el.enableN8N) el.enableN8N.checked = !!data.enableN8N;
    if (el.n8nLog) el.n8nLog.checked = !!data.n8nLog;
    if (el.n8nUrl) el.n8nUrl.value = data.n8nUrl || '';
    if (el.notes) {
      el.notes.value = data.notes || '';
      autoResize(el.notes);
    }
    // Load fallback behavior from preset/config
    try {
      state.disableFfmpegFallback = (data.ffmpegFallback === false) || false;
      // Reflect into UI if already injected
      const input = document.getElementById('adobe-disable-ffmpeg');
      if (input) input.checked = state.disableFfmpegFallback;
    } catch {}
    if (el.checksumMethod) {
      const method = (data.verification?.method || 'none').toLowerCase();
      el.checksumMethod.value = method;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-checksum-method', method);
      }
    }
    if (el.enableThreads) el.enableThreads.checked = !!data.enableThreads;
    if (el.autoThreads) el.autoThreads.checked = !!data.autoThreads;
    if (el.retryFailures) el.retryFailures.checked = !!data.retryFailures;
    if (el.concurrencySlider) {
      if (data.maxThreads == null || data.autoThreads) {
        el.concurrencySlider.value = '3';
      } else {
        el.concurrencySlider.value = String(data.maxThreads || '1');
      }
    }
    updateThreadControls();

    syncAutomationState();

    folderOrder = Array.isArray(data.binFolders) ? [...data.binFolders] : [];
    state.binFolders = folderOrder.slice();
    state.notes = data.notes || '';
    for (const key in fileToBinMap) delete fileToBinMap[key];
    if (data.fileToBinMap) Object.assign(fileToBinMap, data.fileToBinMap);
    unassignedFiles = files.filter(f => !fileToBinMap[f]);

    renderFolderList();
    updateSourcePathDisplay(state.sources);
    triggerPreviewUpdate();
    renderSourceFileList();
    toggleBinControls();
    updateJobPreview();
    if (files.length) {
      renderAdobeGrid(files);
    } else {
      resetFileInfoGrid('adobe', 'adobe-file-grid');
    }
    // Make sure the toggle exists if proxies are visible
    if (el.generateProxies?.checked) injectFfmpegFallbackToggle();
  }

  async function refreshPresetDropdown() {
    const hidden = document.getElementById('adobe-utilities-preset');
    if (!hidden) return;
    let opts = [];
    try {
      if (ipc?.invoke) {
        const presets = await ipc.invoke('list-panel-presets', 'adobe-utilities');
        opts = (Array.isArray(presets) ? presets : [])
          .filter(p => typeof p?.file === 'string')
          .map(p => ({
            value: p.file,
            label: p.name || p.file.replace(/\.json$/i, '')
          }));
      } else {
        electron.mkdir?.(presetDir);
        const files = electron.readdir?.(presetDir) || [];
        opts = files
          .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'))
          .map(f => ({ value: f, label: f.replace(/\.json$/i, '') }));
      }
    } catch (err) {
      console.error('Failed to read presets:', err);
    }
    setupStyledDropdown('adobe-utilities-preset', opts);
    setDropdownValue('adobe-utilities-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const raw = electron.readTextFile(
            electron.joinPath(presetDir, file)
          );
          const data = JSON.parse(raw);
          applyPreset(data);
        } catch (err) {
          console.error('Failed to load preset', err);
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  refreshPresetDropdown();

  el.saveConfig?.addEventListener('click', async () => {
    const cfg = gatherConfig();
    const file = await ipc.saveFile({
      title: 'Save Preset',
      defaultPath: electron.joinPath(presetDir, 'adobe-utilities-config.json')
    });
    if (file) {
      ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
      ipc.send('preset-saved', 'adobe-utilities');
      await refreshPresetDropdown();
      setUILog('✅ Config saved.');
    }
  });

  el.loadConfig?.addEventListener('click', async () => {
    const file = await ipc.openFile({ title: 'Load Preset' });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      applyPreset(data);
    } catch (err) {
      setUILog('❌ Failed to load config: ' + err.message);
    }
  });

  renderFolderList();
  renderSourceFileList();
  updateSourcePathDisplay(state.sources || []);
  if (Array.isArray(state.sources) && state.sources.length) {
    renderAdobeGrid(state.sources);
  } else {
    resetFileInfoGrid('adobe', 'adobe-file-grid');
  }
  // ⚠️ Don't call updateJobPreview here

  toggleBinControls();
  el.createBins?.addEventListener('change', toggleBinControls);
  el.importPremiere?.addEventListener('change', updateJobPreview);
  el.createBins?.addEventListener('change', updateJobPreview);
  el.saveLog?.addEventListener('change', updateJobPreview);
  el.checksumMethod?.addEventListener('change', updateJobPreview);

  if (el.notes) {
    autoResize(el.notes);
    el.notes.addEventListener('input', () => {
      state.notes = el.notes.value;
      autoResize(el.notes);
      updateJobPreview();
    });
  }

  const handleAutomationChange = () => {
    syncAutomationState();
    updateJobPreview();
  };

  el.enableN8N?.addEventListener('change', handleAutomationChange);
  el.n8nLog?.addEventListener('change', handleAutomationChange);
  el.n8nUrl?.addEventListener('input', handleAutomationChange);

  const handleThreadingChange = () => {
    updateThreadControls();
    updateJobPreview();
  };

  el.enableThreads?.addEventListener('change', handleThreadingChange);
  el.autoThreads?.addEventListener('change', handleThreadingChange);
  el.retryFailures?.addEventListener('change', () => {
    syncThreadState();
    updateJobPreview();
  });
  el.concurrencySlider?.addEventListener('input', () => {
    if (!el.autoThreads?.checked && el.concurrencyValue) {
      el.concurrencyValue.textContent = el.concurrencySlider.value;
    }
    syncThreadState();
    updateJobPreview();
  });

  function resetAdobeFields(opts = {}) {
    const { preserveJobPreview = false } = opts;
    for (const key in state) delete state[key];
    folderOrder = [];
    draggedChildren = [];
    for (const key in fileToBinMap) delete fileToBinMap[key];
    unassignedFiles = [];

    if (el.srcPath) {
      el.srcPath.value = '';
      autoResize(el.srcPath);
    }
    resetFileInfoGrid('adobe', 'adobe-file-grid');
    if (el.destPath) el.destPath.value = '';

    if (el.importPremiere) el.importPremiere.checked = false;
    if (el.createBins) el.createBins.checked = false;
    if (el.generateProxies) el.generateProxies.checked = false;
    if (el.saveLog) el.saveLog.checked = false;
    if (el.enableN8N) el.enableN8N.checked = false;
    if (el.n8nLog) el.n8nLog.checked = false;
    if (el.n8nUrl) el.n8nUrl.value = '';
    if (el.checksumMethod) {
      el.checksumMethod.value = 'none';
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-checksum-method', 'none');
      }
    }
    if (el.enableThreads) el.enableThreads.checked = false;
    if (el.autoThreads) el.autoThreads.checked = false;
    if (el.retryFailures) el.retryFailures.checked = false;
    if (el.concurrencySlider) el.concurrencySlider.value = '3';
    if (el.concurrencyValue) el.concurrencyValue.textContent = '3';
    if (el.proxyPreset) {
      el.proxyPreset.value = MATCH_SOURCE_SENTINEL;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-proxy-preset', MATCH_SOURCE_SENTINEL);
      }
    }
    if (el.proxyPresetWrapper) el.proxyPresetWrapper.style.display = 'none';
    if (el.folderName) el.folderName.value = '';
    if (el.notes) {
      el.notes.value = '';
      autoResize(el.notes);
    }
    if (el.proxyDestPath) el.proxyDestPath.value = '';
    if (el.proxyDestRow) el.proxyDestRow.style.display = 'none';
    // Reset FFmpeg fallback toggle
    state.disableFfmpegFallback = false;
    const ffcb = document.getElementById('adobe-disable-ffmpeg');
    if (ffcb) ffcb.checked = false;

    syncAutomationState();

    renderFolderList();
    renderSourceFileList();
    toggleBinControls();

    const bar = document.getElementById('adobe-progress');
    const out = document.querySelector('output[for="adobe-progress"]');
    if (bar) bar.value = 0;
    if (out) out.value = '';
    setUILog('', { append: false });
    if (el.jobPreviewBox && !preserveJobPreview) {
      el.jobPreviewBox.value = '';
      autoResize(el.jobPreviewBox);
      delete el.jobPreviewBox.dataset.joblogVisible;
    }
    if (!preserveJobPreview) lastSummary = '';

    window.watchConfigs.adobeUtilities = state;
    updateThreadControls();
  }

  el.resetBtn?.addEventListener('click', resetAdobeFields);

  el.srcBtn?.addEventListener('click', async () => {
    const paths = await window.electron.selectFiles?.();
    if (!Array.isArray(paths) || !paths.length) return; // ✅ Prevents beep on cancel
    state.sources = paths;
    unassignedFiles = [...paths];
    for (const key in fileToBinMap) delete fileToBinMap[key];
    updateSourcePathDisplay(paths);
    renderSourceFileList();
    updateJobPreview();
    await renderAdobeGrid(paths);
  });

  el.destBtn?.addEventListener('click', async () => {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return; // ✅ Prevents beep on cancel
    state.destination = folder;
    el.destPath.value = folder;
    updateJobPreview();
  });

  el.proxyDestBtn?.addEventListener('click', async () => {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return; // ✅ Prevents beep on cancel
    state.proxyDest = folder;
    el.proxyDestPath.value = folder;
    updateJobPreview();
  });

  el.loadProxyPreset?.addEventListener('click', async () => {
    const files = await window.electron.selectFiles?.();
    const file = Array.isArray(files) ? files[0] : files;
    if (!file || !file.toLowerCase().endsWith('.epr')) return;
    el.proxyPreset.value = file;
    triggerPreviewUpdate();
    await loadProxyPresets();
    updateJobPreview();
  });

  el.generateProxies?.addEventListener('change', () => {
    const show = el.generateProxies.checked;
    applyProxySectionVisibility(show);
  });

  if (el.generateProxies) {
    const show = el.generateProxies.checked;
    applyProxySectionVisibility(show, { triggerPreview: false });
  }

  // 🔧 Helpers that delegate to main for OS-correct behavior
  async function normalizePath(p) {
    if (!p) return p;
    try {
      const out = await ipc?.invoke?.('normalize-path', p);
      return typeof out === 'string' ? out : p;
    } catch {
      return p;
    }
  }
  async function pathExists(p) {
    if (!p) return false;
    try {
      return !!(await ipc?.invoke?.('path-exists', p));
    } catch {
      return false;
    }
  }

  async function normalizeJobConfig(config) {
    const cfg = { ...config };
    if (Array.isArray(cfg.sources)) {
      const norm = await Promise.all(cfg.sources.map(normalizePath));
      cfg.sources = norm;
    }
    if (cfg.destination) cfg.destination = await normalizePath(cfg.destination);
    if (cfg.proxyDest) cfg.proxyDest = await normalizePath(cfg.proxyDest);
    // ⛔ DO NOT normalize virtual presets like the match-source FFmpeg sentinel
    if (cfg.proxyPreset && !isMatchSourcePreset(cfg.proxyPreset)) {
      cfg.proxyPreset = await normalizePath(cfg.proxyPreset);
    }
    return cfg;
  }

  el.startBtn?.addEventListener('click', () => {
    // DEMO: Automate button is visual-only (hover/press). No job is queued.
  });

  el.cancelBtn?.addEventListener('click', () => {
    // DEMO: Cancel button is visual-only (hover/press). No cancel logic.
  });

  ipc?.on('premiere-import-media', (_e, paths) => {
    if (window.csInterface) {
      safeEvalScript(window.csInterface, 'LEADAE_importMedia', paths);
    }
  });

  ipc?.on('premiere-create-bins', (_e, bins) => {
    if (window.csInterface) {
      safeEvalScript(window.csInterface, 'LEADAE_createBins', bins);
    }
  });

  // (Removed) Proxy attaches are routed exclusively via the CEP bridge to avoid duplicate events.

  // === PROGRESS + CEP STATUS HANDLER ===
  function resetAdobeAutomatePanelUI() {
    setAdobeAutomateControlsDisabled(false);
    try {
      const cepStatus = document.getElementById('cep-job-status');
      const bar = document.getElementById('adobe-progress');
      const out = document.querySelector('output[for="adobe-progress"]');

      if (bar) { bar.style.display = 'none'; bar.value = 0; }
      if (out) out.value = '';
      if (cepStatus) {
        // clear the “job active” latch and hide the hamster
        delete cepStatus.dataset.jobActive;
        cepStatus.style.display = 'none';
        cepStatus.querySelector('.wheel-and-hamster')?.remove();
      }
      // clear checklist lines for the CEP-mirrored feed
      const list = document.getElementById('cep-task-list');
      if (list) {
        list.innerHTML = '';
        list.style.display = 'none';
      }
      document.querySelector('#loader-inline .adobe-stage-line')?.remove();
      console.log('✅ Adobe Automate job finished — panel reset, hamster stopped.');
    } catch (err) {
      console.error('❌ Failed to reset Adobe Automate panel:', err);
    }
  }

  function ensureHamsterStructure(root) {
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

  let currentStageKey = null;

  function clearStageFeed() {
    const list = document.getElementById('cep-task-list');
    if (list) {
      list.innerHTML = '';
      list.style.display = 'none';
    }
    document.querySelector('#loader-inline .adobe-stage-line')?.remove();
    currentStageKey = null;
  }

  // ✅ Single-line, no-emoji status that REPLACES the progress bar
  function upsertStageFeed(stage, state = 'active', _stageLabel) {
    const loader = document.getElementById('loader-inline');
    if (!loader) return;
    const line =
      loader.querySelector('.adobe-stage-line') ||
      (() => {
        const el = document.createElement('div');
        el.className = 'adobe-stage-line';
        loader.appendChild(el);
        return el;
      })();
    const map = {
      import: {
        active: 'Importing media…',
        done: 'Import complete',
        error: 'Import failed',
        cancelled: 'Import cancelled'
      },
      bins: {
        active: 'Creating bins…',
        done: 'Bins created',
        error: 'Bins failed',
        cancelled: 'Bins cancelled'
      },
      proxies: {
        active: 'Generating proxies…',
        done: 'Proxies complete',
        error: 'Proxies failed',
        cancelled: 'Proxies cancelled'
      },
      attach: {
        active: 'Attaching proxies…',
        done: 'Attach complete',
        error: 'Attach failed',
        cancelled: 'Attach cancelled'
      },
      complete: {
        active: 'Adobe Automate…',
        done: 'Adobe Automate complete',
        error: 'Adobe Automate failed',
        cancelled: 'Adobe Automate cancelled'
      }
    };
    const s = (state || 'active').toLowerCase();
    line.textContent =
      (map[stage] && (map[stage][s] || map[stage].active)) || 'Working…';
    const list = document.getElementById('cep-task-list');
    if (list) list.style.display = 'none'; // never show legacy list
  }

  // progress events from queue
  ipc?.on('queue-job-progress', (_e, payload) => {
    if (payload.panel !== 'adobe-utilities') return;

    const jobKey = currentJobKeyFrom(null, payload);

    // 🔒 Ignore any further progress once this job is finalized
    if (__adobeJobCompleted || wasFinalized(jobKey)) {
      __adobeJobCompleted = true;
      return;
    }

    currentJobStage = payload.stage;
    state.currentJobStage = currentJobStage;

    // When the very first stage begins, clear completion latch (robust to backend restarts)
    if ((payload.stage === 'copy' && ((payload.overall ?? payload.percent ?? 0) <= 1)) || payload.stage === 'validate') {
      clearFinalized(jobKey);
      __adobeJobCompleted = false;
    }

    const bar = document.getElementById('adobe-progress');
    const cepStatus = document.getElementById('cep-job-status');
    const out = document.querySelector('output[for="adobe-progress"]');

    if (!bar || !cepStatus) return;

    const ensureHamsterVisible = () => {
      let hamsterDiv = cepStatus.querySelector('.wheel-and-hamster');
      if (!hamsterDiv) {
        hamsterDiv = document.createElement('div');
        hamsterDiv.className = 'wheel-and-hamster';
        cepStatus.appendChild(hamsterDiv);
      }
      ensureHamsterStructure(hamsterDiv);
      cepStatus.style.display = 'block';
    };

    // COPY ONLY — show real progress bar
    if (payload.stage === 'copy') {
      const base = (typeof payload.overall === 'number') ? payload.overall : payload.percent;
      const pct = Math.max(0, Math.min(100, Number(base) || 0));
      if (!cepStatus.dataset.jobActive) {
        clearStageFeed();
      }
      cepStatus.dataset.jobActive = 'true';

      ensureHamsterVisible();

      bar.value = pct;
      bar.style.display = pct >= 100 ? 'none' : 'block';
      if (out) {
        out.value = pct >= 100 ? '' : Math.round(pct);
      }

      if (pct >= 100) {
        bar.value = 100;
        bar.style.display = 'none';
        if (out) out.value = '';
        // ⏱ Instantly switch: progress bar → first post-copy stage text
        upsertStageFeed('import', 'active');
      }
      return;
    }

    // ✅ CEP STAGES — update sequential feed entries
    if (['bins', 'import', 'proxies', 'attach', 'complete'].includes(payload.stage)) {
      if (!cepStatus.dataset.jobActive) {
        clearStageFeed();
        cepStatus.dataset.jobActive = 'true';
      }

      ensureHamsterVisible();

      const statusRaw = (payload.status || '').toLowerCase();
      let normalized = 'active';
      if (['error', 'failed'].includes(statusRaw)) {
        normalized = 'error';
      } else if (['complete', 'done', 'success'].includes(statusRaw)) {
        normalized = 'done';
      } else if (payload.stage === 'complete' && Number(payload.overall ?? payload.percent) >= 100) {
        normalized = 'done';
      }

      if (normalized === 'active' && currentStageKey && currentStageKey !== payload.stage) {
        upsertStageFeed(currentStageKey, 'done');
      }

      if (normalized === 'active') {
        currentStageKey = payload.stage;
      } else if (normalized === 'done') {
        if (currentStageKey && currentStageKey !== payload.stage) {
          upsertStageFeed(currentStageKey, 'done');
        }
        currentStageKey = null;
      }

      upsertStageFeed(payload.stage, normalized);

      /**
       * 🧩 Fix — Do NOT finalize here.
       *  This "complete" often comes from import-only or AME init steps.
       *  Wait for the backend queue-job-complete event before resetting the panel.
       */
      if (payload.stage === 'complete' && normalized === 'done') {
        console.log('⚙️ Stage=complete progress received — deferring reset until backend complete.');
        __adobeJobCompleted = false;
      }
    }
  });

   // when complete
ipc?.on('queue-job-complete', (_e, job) => {
  if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;

  // OLD behavior: finalize immediately on completion (no origin/wantsProxies gating)
  markFinalized(currentJobKeyFrom(job));

  resetAdobeAutomatePanelUI();
  resetAdobeFields();

  currentJobId = null;
  currentJobStage = null;
  state.currentJobId = null;
  state.currentJobStage = null;

  if (el.cancelBtn) el.cancelBtn.disabled = true;

  if (Array.isArray(job?.result?.log) && job.result.log.length && el.jobPreviewBox) {
    el.jobPreviewBox.value =
      `✅ Job Completed — Log Summary...\n` +
      `──────────────────────────────\n${job.result.log.join('\n')}`;
    autoResize(el.jobPreviewBox);
    el.jobPreviewBox.dataset.joblogVisible = 'true';
  }
});

  ipc?.on('queue-job-failed', (_e, job) => {
    if (job.panel !== 'adobe-utilities') return;
    currentJobId = null;
    currentJobStage = null;
    state.currentJobId = currentJobId;
    state.currentJobStage = currentJobStage;
    if (el.cancelBtn) el.cancelBtn.disabled = true;
    currentStageKey = null;
    resetAdobeAutomatePanelUI();
    resetAdobeFields();

    const cepStatus = document.getElementById('cep-job-status');
    if (cepStatus) {
      delete cepStatus.dataset.jobActive;
      cepStatus.querySelector('.wheel-and-hamster')?.remove();
    }
    upsertStageFeed('complete', 'error');

    // ❌ Sticky log for failures
    if (Array.isArray(job.result?.log) && job.result.log.length && el.jobPreviewBox) {
      el.jobPreviewBox.value = `❌ Job Ended — Log Summary:\n──────────────────────────────\n${job.result.log.join('\n')}`;
      autoResize(el.jobPreviewBox);
      el.jobPreviewBox.dataset.joblogVisible = 'true';
    }
  });

  ipc?.on('queue-job-cancelled', (_e, job) => {
    if (job.panel !== 'adobe-utilities') return;
    currentJobId = null;
    currentJobStage = null;
    state.currentJobId = currentJobId;
    state.currentJobStage = currentJobStage;
    if (el.cancelBtn) el.cancelBtn.disabled = true;
    currentStageKey = null;
    resetAdobeAutomatePanelUI();
    resetAdobeFields();

    const cepStatus = document.getElementById('cep-job-status');
    if (cepStatus) {
      delete cepStatus.dataset.jobActive;
      cepStatus.querySelector('.wheel-and-hamster')?.remove();
    }
    upsertStageFeed('complete', 'cancelled');

    // 🛑 Sticky log for cancelled jobs
    if (Array.isArray(job.result?.log) && job.result.log.length && el.jobPreviewBox) {
      el.jobPreviewBox.value = `❌ Job Ended — Log Summary:\n──────────────────────────────\n${job.result.log.join('\n')}`;
      autoResize(el.jobPreviewBox);
      el.jobPreviewBox.dataset.joblogVisible = 'true';
    }
  });

  function sendProxyJob(config) {
    if (typeof ipc?.invoke !== 'function') {
      panelDebug('⚠️ Electron IPC unavailable — cannot queue Adobe job.');
      return;
    }

    ipc
      .invoke('queue-add-adobe', { config })
      .then(jobId => {
        panelDebug(
          `📤 queued Adobe job via Electron main${jobId ? ` (ID: ${jobId})` : ''}`
        );
      })
      .catch(err => {
        panelDebug(
          `⚠️ Failed to queue Adobe job via Electron main: ${err?.message || err}`
        );
      });
  }

  function onProxyPresetChange() {
    const value = el.proxyPreset?.value || '';
    debugLog(`Preset changed to: ${value}`);
    if (isMatchSourcePreset(value)) {
      debugLog('⚙️ Match Source (FFMPEG) selected — AME will be bypassed.');
    }
    updateJobPreview();
  }

  async function loadProxyPresets() {
    try {
      electron.mkdir(proxyPresetDir);
      const files = electron.readdir(proxyPresetDir) || [];

      const hidden = document.getElementById('adobe-proxy-preset');
      if (!hidden) return;
      let current = hidden.value;
      if (isMatchSourcePreset(current)) {
        current = MATCH_SOURCE_SENTINEL;
        hidden.value = MATCH_SOURCE_SENTINEL;
      }

      const opts = files
        .filter(f => f.endsWith('.epr'))
        .map(f => ({
          value: electron.joinPath(proxyPresetDir, f),
          label: `🎬 ${f.replace(/\.epr$/i, '')}`
        }));
      // Prepend the virtual Match Source option (hidden defaults live under presets/Adobe/defaults).
      opts.unshift({ value: MATCH_SOURCE_SENTINEL, label: 'Match Source (FFMPEG)' });

      if (
        current &&
        current.toLowerCase().endsWith('.epr') &&
        !opts.some(o => o.value === current)
      ) {
        const f = current.split(/[\\/]/).pop();
        opts.unshift({ value: current, label: `🎬 ${f.replace(/\.epr$/i, '')}` });
      }

      setupStyledDropdown('adobe-proxy-preset', opts);
      const nextValue = current || MATCH_SOURCE_SENTINEL;
      setDropdownValue('adobe-proxy-preset', nextValue);
      hidden.value = nextValue;
      triggerPreviewUpdate();
      window.translatePage?.();

      if (!hidden.dataset.proxyChangeBound) {
        hidden.addEventListener('change', onProxyPresetChange);
        hidden.dataset.proxyChangeBound = 'true';
      }

      const tooltip = document.getElementById('proxy-settings-tooltip');
      if (tooltip) {
        tooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">Proxy Preset Details</div>
      <div class="tooltip-section">
        <span class="tooltip-subtitle">Preset Folder</span>
        <div class="tooltip-path">${proxyPresetDir}</div>
      </div>
      <div class="tooltip-section">
        <span class="tooltip-subtitle">Attachment Rules</span>
        <ul class="tooltip-list">
          <li>Container must match (<strong>mov/mp4</strong>)</li>
          <li>Resolution / frame size must match source</li>
          <li>Frame rate must match source</li>
          <li>Audio must be <strong>discrete-layout parity</strong> with source (per stream): Stereo↔Stereo, Dual-Mono↔Dual-Mono, NxMono↔NxMono</li>
        </ul>
      </div>
    </div>
  `;
      }
    } catch (err) {
      console.error('❌ Could not load Adobe Media Encoder presets:', err);
    }
  }

  document
    .getElementById('refresh-proxy-presets')
    ?.addEventListener('click', loadProxyPresets);

  if (document.readyState !== 'loading') {
    loadProxyPresets();
  } else {
    document.addEventListener('DOMContentLoaded', loadProxyPresets);
  }

  // 🔄 Auto-load presets when Adobe Automate panel is opened
  document
    .querySelector('[data-panel="adobe-utilities"]')
    ?.addEventListener('click', () => {
      loadProxyPresets();
    });

  // 🔄 Re-initialize Adobe Automate preset dropdown when its toolbar is activated
  document.addEventListener('toolbar-updated', e => {
    if (e.detail?.panelId === 'adobe-utilities') {
      // Small delay ensures elements are re-attached first
      setTimeout(() => {
        refreshPresetDropdown();
      }, 150);
    }
  });

  // ✅ Auto-refresh preset dropdown when presets are saved or deleted
  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('preset-saved', (_e, panelId) => {
      if (panelId === 'adobe-utilities') refreshPresetDropdown();
    });
    ipc.on('preset-deleted', (_e, panelId) => {
      if (panelId === 'adobe-utilities') refreshPresetDropdown();
    });
  }

  window.connectToLeadAE = connectToLeadAE;
  window.sendProxyJob = sendProxyJob;

  // ───────────────────────────────────────────────────────────────
  // 🧹 Sticky Log Lifecycle: clear when user changes settings or leaves panel
  // ───────────────────────────────────────────────────────────────
  const adobePanelEl = document.getElementById('adobe-utilities');
  ['input', 'change'].forEach(evt => {
    adobePanelEl?.addEventListener(evt, e => {
      if (!el.jobPreviewBox?.dataset.joblogVisible) return;
      if (e.target === el.jobPreviewBox) return; // ignore typing/scrolling inside the preview
      // Any setting change clears sticky log and fully resets the panel
      delete el.jobPreviewBox.dataset.joblogVisible;
      resetAdobeFields();
    }, { capture: true });
  });

  document.addEventListener('toolbar-updated', e => {
    if (e.detail?.panelId !== 'adobe-utilities') {
      if (el.jobPreviewBox?.dataset.joblogVisible) {
        delete el.jobPreviewBox.dataset.joblogVisible;
        resetAdobeFields();
      }
    }
  });

})();
