/* global loadPanelScript, setupStyledDropdown, setDropdownValue */
(() => {
  // ──────────────────────────────────────────────────────────────
  // Transcribe panel: format-scoped Scripted mini-panel wiring
  // Safe wrapper: don't let missing elements crash dropdown.js
  // ──────────────────────────────────────────────────────────────
  function safeSetupDropdown(id, options = [], defaultValue) {
    const el = document.getElementById(id);
    if (!el) {
      console.info(`[dropdown] '#${id}' not found — skipping init`);
      return false;
    }
    try {
      setupStyledDropdown(id, options);
      let nextValue = defaultValue;
      if (nextValue !== undefined && Array.isArray(options) && options.length) {
        const match = options.find(o => o?.value === nextValue);
        if (!match) nextValue = options[0]?.value;
      }
      if (nextValue !== undefined) setDropdownValue(id, nextValue);
      return true;
    } catch (e) {
      console.error(`[dropdown] init failed for #${id}:`, e);
      return false;
    }
  }

window.logPanel?.log('transcribe', '✅ renderer.transcribe.js loaded');
// Phase 3 UI polish: EDM-on-EOC toggle for SCC

// 🔒 Purge stale SCC keys to prevent "mystery" centering/row changes
['scc-row-policy','edm-on-eoc','rollup-boundary-edm']
  .forEach(k => { try { localStorage.removeItem(k); } catch {} });

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

function logTranscribe(msg, opts = {}) {
  window.logPanel?.log('transcribe', msg, opts);
}

// 🐹 Hamster helpers (same structure used elsewhere)
function ensureHamsterStructure(root) {
  if (!root) return;
  if (root.querySelector('.wheel')) return; // already built
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

// REPLACE your existing toggleTranscribing with this version
function toggleTranscribing(show) {
  if (el.loaderInline) el.loaderInline.style.display = show ? 'flex' : 'none';
  if (el.statusText)   el.statusText.textContent = show ? 'transcribing...' : '';

  const status = el.jobStatus || document.getElementById('transcribe-job-status');
  if (!status) return;

  if (show) {
    // Ensure there is a .wheel-and-hamster container and that it has inner parts
    let wheel = status.querySelector('.wheel-and-hamster');
    if (!wheel) {
      wheel = document.createElement('div');
      wheel.className = 'wheel-and-hamster';
      status.appendChild(wheel);
    }
    ensureHamsterStructure(wheel);
    status.style.display = 'flex';
    status.dataset.jobActive = 'true';
  } else {
    delete status.dataset.jobActive;
    status.style.display = 'none';
    // optional: remove markup so animation resets next time
    status.querySelector('.wheel-and-hamster')?.remove();
  }
}

let currentJobId = null;

const presetDir = window.electron.resolvePath('config', 'presets', 'transcribe');

// Late-load safe init (matches Speed Test / Transcode pattern)
function initTranscribeDropdowns() {
  const engineOpts = [
    { value: 'whisperx', label: 'WhisperX' },
    { value: 'whisper', label: 'WhisperAPI' },
    { value: 'lead', label: 'Lead AI' }
  ];
  const savedModel = localStorage.getItem('preferred-ai-model') || 'lead';
  safeSetupDropdown('transcribe-engine', engineOpts, savedModel);

  const languageOpts = [
    { value: 'en', label: 'English (EN)' },
    { value: 'es', label: 'Spanish (ES)' },
    { value: 'fr', label: 'French (FR)' },
    { value: 'de', label: 'German (DE)' },
    { value: 'ja', label: 'Japanese (JA)' },
    { value: 'zh', label: 'Chinese (ZH)' }
  ];
  const savedLang = localStorage.getItem('preferred-transcribe-language') || 'en';
  safeSetupDropdown('transcribe-language', languageOpts, savedLang);

  const accuracyOpts = [
    { value: 'fast', label: 'Fast' },
    { value: 'auto', label: 'Auto' },
    { value: 'accurate', label: 'Accurate' }
  ];
  const savedAccuracy = localStorage.getItem('preferred-accuracy-mode') || 'auto';
  const accuracyDefault = (accuracyOpts.find(o => o.value === savedAccuracy)?.value)
    || (accuracyOpts[1]?.value ?? accuracyOpts[0]?.value);
  safeSetupDropdown('transcribe-accuracy-mode', accuracyOpts, accuracyDefault);

  const confidenceOpts = [
    { value: '50', label: '50%' },
    { value: '60', label: '60%' },
    { value: '70', label: '70%' },
    { value: '80', label: '80%' },
    { value: '90', label: '90%' },
    { value: '95', label: '95%' },
    { value: '99', label: '99%' }
  ];
  safeSetupDropdown('transcribe-confidence', confidenceOpts);
  let savedConf = '90';
  try {
    const prefsPath = window.electron.resolvePath('config', 'state.json');
    const raw = window.electron.readTextFile(prefsPath);
    const prefs = JSON.parse(raw);
    if (prefs?.preferences?.confidenceThreshold) {
      savedConf = String(prefs.preferences.confidenceThreshold);
    }
  } catch (err) {
    console.warn('⚠️ Failed to load confidence threshold from preferences:', err);
  }
  const confValue = (confidenceOpts.find(o => o.value === savedConf)?.value)
    || (confidenceOpts[4]?.value ?? confidenceOpts[0]?.value);
  setDropdownValue('transcribe-confidence', confValue);

  const translateOpts = [
    { value: 'en', label: 'English (EN)' },
    { value: 'es', label: 'Spanish (ES)' },
    { value: 'fr', label: 'French (FR)' },
    { value: 'de', label: 'German (DE)' },
    { value: 'ja', label: 'Japanese (JA)' },
    { value: 'zh', label: 'Chinese (ZH)' }
  ];
  const savedTarget = localStorage.getItem('preferred-translate-target') || 'en';
  safeSetupDropdown('translate-target', translateOpts, savedTarget);

  safeSetupDropdown('transcribe-timecode-style', [
    { value: 'ndf', label: 'NDF — HH:MM:SS:FF' },
    { value: 'df',  label: 'DF — HH:MM:SS;FF' },
    { value: 'ms',  label: 'ms — HH:MM:SS,mmm' }
  ], 'ndf');


  // ──────────────────────────────────────────────────────────────
  // TXT (format‑scoped) controls — Option B
  // ──────────────────────────────────────────────────────────────
  // Timecode format (NDF / DF / ms) for TXT
  safeSetupDropdown('fmt-txt-timecode-format', [
    { value: 'ndf', label: 'NDF — HH:MM:SS:FF' },
    { value: 'df',  label: 'DF — HH:MM:SS;FF' },
    { value: 'ms',  label: 'ms — HH:MM:SS,mmm' }
  ], 'ndf');

  // Timestamp placement (TXT)
  safeSetupDropdown('fmt-txt-timestamp-placement', [
    { value: 'start_end',  label: 'Start–End' },
    { value: 'start',      label: 'Start only' },
    { value: 'every_line', label: 'Every line' },
    { value: 'none',       label: 'None' }
  ], 'start_end');

  // Speaker label style (TXT)
  safeSetupDropdown('fmt-txt-speaker-style', [
    { value: 'title', label: 'Title Case' },
    { value: 'caps',  label: 'ALL CAPS' },
    { value: 'raw',   label: 'Raw' }
  ], 'title');

  // Speaker label style (SRT) – same choices, no timecode nonsense
  safeSetupDropdown('fmt-srt-speaker-style', [
    { value: 'title', label: 'Title Case' },
    { value: 'caps',  label: 'ALL CAPS' },
    { value: 'raw',   label: 'Raw' }
  ], 'title');

  // Speaker label style (VTT) – same options
  safeSetupDropdown('fmt-vtt-speaker-style', [
    { value: 'title', label: 'Title Case' },
    { value: 'caps',  label: 'ALL CAPS' },
    { value: 'raw',   label: 'Raw' }
  ], 'title');

  // Final JSON timecode format
  safeSetupDropdown('fmt-finaljson-timecode-format', [
    { value: 'ndf', label: 'NDF — HH:MM:SS:FF' },
    { value: 'df',  label: 'DF — HH:MM:SS;FF' },
    { value: 'ms',  label: 'ms — HH:MM:SS,mmm' }
  ], 'ndf');
  // SCRIPT (format‑scoped) controls
  safeSetupDropdown('fmt-script-export', [
    { value: 'csv',  label: 'CSV (FCP7-style)' },
    { value: 'docx', label: 'DOCX (Word)' }
  ], 'csv');
  safeSetupDropdown('fmt-script-timestamp-placement', [
    { value: 'start_end',  label: 'Start–End' },
    { value: 'start',      label: 'Start only' },
    { value: 'every_line', label: 'Every line' },
    { value: 'none',       label: 'None' }
  ], 'start_end');
  safeSetupDropdown('fmt-script-speaker-style', [
    { value: 'title', label: 'Title Case' },
    { value: 'caps',  label: 'ALL CAPS' },
    { value: 'raw',   label: 'Raw' }
  ], 'title');
  safeSetupDropdown('fmt-script-timecode-format', [
    { value: 'ndf', label: 'NDF — HH:MM:SS:FF' },
    { value: 'df',  label: 'DF — HH:MM:SS;FF' },
    { value: 'ms',  label: 'ms — HH:MM:SS,mmm' }
  ], 'ndf');

  const formatOpts = [
    { value: 'txt',       label: 'Plain Text (.txt)' },
    { value: 'srt',       label: 'SubRip (.srt)' },
    { value: 'vtt',       label: 'WebVTT (.vtt)' },
    { value: 'scc',       label: 'Scenarist CC (.scc)' },
    { value: 'script',    label: 'Scripted (CSV/DOCX)' },
    { value: 'xml',       label: 'XML' },
    { value: 'finalJson', label: 'Final JSON (wrapped)' },
    { value: 'burnIn',    label: 'Burn-in MP4' }
  ];

  // --- SAFETY: Wait for the multi-select wrapper before initializing ---
  const fmtEl = document.getElementById('transcribe-output-formats');
  if (!fmtEl) {
    console.warn('⚠️ Output Format dropdown not yet in DOM — retrying...');
    return setTimeout(initTranscribeDropdowns, 50);  // retry after DOM settles
  }

  safeSetupDropdown('transcribe-output-formats', formatOpts, 'txt');
  // If a legacy preset or saved value was "markers", force a sane default.
  if (fmtEl && fmtEl.value === 'markers') {
    setDropdownValue('transcribe-output-formats', 'txt');
    fmtEl.value = 'txt';
  }

  // === SCC alignment ===
  const alignOpts = [
    { value: 'left',   label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right',  label: 'Right' }
  ];
  const savedAlign = (localStorage.getItem('scc-alignment') || 'center');
  const alignDefault = (alignOpts.find(o => o.value === savedAlign)?.value)
    || (alignOpts.find(o => o.value === 'center')?.value)
    || alignOpts[0]?.value;
  safeSetupDropdown('scc-alignment', alignOpts, alignDefault);
  document.getElementById('scc-alignment')?.addEventListener('change', e => {
    try { localStorage.setItem('scc-alignment', e.target.value); } catch {}
  });

  // === SCC channel ===
  const channelOpts = [
    { value: 'CC1', label: 'CC1' },
    { value: 'CC2', label: 'CC2' },
    { value: 'CC3', label: 'CC3' },
    { value: 'CC4', label: 'CC4' }
  ];
  const savedChan = (localStorage.getItem('scc-channel') || 'CC1');
  const channelDefault = (channelOpts.find(o => o.value === savedChan)?.value)
    || (channelOpts.find(o => o.value === 'CC1')?.value)
    || channelOpts[0]?.value;
  safeSetupDropdown('scc-channel', channelOpts, channelDefault);
  document.getElementById('scc-channel')?.addEventListener('change', e => {
    try { localStorage.setItem('scc-channel', e.target.value); } catch {}
  });

  // (Removed: legacy SCC control hider – those nodes no longer exist in the DOM)

  updateSccUiRows();
}

// Run now if the DOM is already parsed (common when scripts are loaded on tab click)
if (document.readyState !== 'loading') {
  initTranscribeDropdowns();
} else {
  document.addEventListener('DOMContentLoaded', initTranscribeDropdowns, { once: true });
}

  const el = {
    selectFiles: document.getElementById('transcribe-select-files'),
    files: document.getElementById('transcribe-files'),
    outputSelect: document.getElementById('transcribe-output-select'),
    outputPath: document.getElementById('transcribe-output-path'),
    startBtn: document.getElementById('start-transcribe'),
    resetBtn: document.getElementById('reset-transcribe'),
    summary: document.getElementById('transcribe-summary'),
    liveOutput: document.getElementById('live-transcript-output'),
    allowFallback: document.getElementById('transcribe-allow-fallback'),
    saveConfig: document.getElementById('transcribe-save-config'),
    loadConfig: document.getElementById('transcribe-load-config'),

    enableN8N: document.getElementById('transcribe-enable-n8n'),
    n8nUrl: document.getElementById('transcribe-n8n-url'),
    n8nLog: document.getElementById('transcribe-n8n-log'),
    watchMode: document.getElementById('transcribe-watch-mode'),
    cancelBtn: document.getElementById('cancel-transcribe'),
    presetSelect: document.getElementById('transcribe-preset'),
    notes: document.getElementById('transcribe-notes'),
    loaderInline: document.getElementById('transcribe-loader-inline'),
    jobStatus: document.getElementById('transcribe-job-status'),
    statusText: document.getElementById('transcribe-status-text')
  };

  autoResize(el.files);

  const transcribeLockWrapper = document.getElementById('transcribe-lock-wrapper');

  function _attachSubtitlePopoutButton() {
    const openEditorBtn = document.getElementById('open-subtitle-editor');
    if (!openEditorBtn || openEditorBtn.dataset.subtitlePopoutAttached === '1') return;
    openEditorBtn.dataset.subtitlePopoutAttached = '1';

    // Make the pop-out open instantly; user can choose files inside the editor
    openEditorBtn.addEventListener('click', async () => {
      try {
        await window.subtitleEditor?.open({});
      } catch (e) {
        console.error('Pop-out failed:', e);
      }
    });
  }

  const openEditorBtn = document.getElementById('open-subtitle-editor');
  if (openEditorBtn) _attachSubtitlePopoutButton();

  const engineInput = document.getElementById('transcribe-engine');
  const languageInput = document.getElementById('transcribe-language');
  const accuracyInput = document.getElementById('transcribe-accuracy-mode');
  const confidenceInput = document.getElementById('transcribe-confidence');
  const translateTargetInput = document.getElementById('translate-target');

  engineInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-ai-model', e.target.value);
    updateDisabledOutputFormats();
  });

  languageInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-transcribe-language', e.target.value);
  });

  accuracyInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-accuracy-mode', e.target.value);
  });

  confidenceInput?.addEventListener('change', e => {
    try {
      const prefsPath = window.electron.resolvePath('config', 'state.json');
      let prefs = {};
      if (window.electron.fileExists(prefsPath)) {
        prefs = JSON.parse(window.electron.readTextFile(prefsPath));
      }
      prefs.preferences = prefs.preferences || {};
      prefs.preferences.confidenceThreshold = e.target.value;
      window.electron.writeTextFile(prefsPath, JSON.stringify(prefs, null, 2));
    } catch (err) {
      console.error('❌ Failed to save confidence threshold:', err);
    }
  });

  translateTargetInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-translate-target', e.target.value);
  });

  function updateSccUiRows() {
    const fmtSel = document.getElementById('transcribe-output-formats');
    const show = fmtSel?.value === 'scc';
    const wrap = document.getElementById('scc-alignchan-wrap');
    if (wrap) wrap.style.display = show ? 'grid' : 'none';
    // Keep inner items visible when wrapper is shown (defensive)
    const alignRow = document.getElementById('scc-align-row');
    const channelRow = document.getElementById('scc-channel-row');
    if (alignRow) alignRow.style.display = show ? 'flex' : 'none';
    if (channelRow) channelRow.style.display = show ? 'flex' : 'none';
  }

  function updateDisabledOutputFormats() {
    const engine = document.getElementById('transcribe-engine')?.value;
    const select = document.getElementById('transcribe-output-formats');
    if (!select) return;

    const fpsOverrideRaw =
      (document.getElementById('fmt-txt-fps')?.value) ??
      (document.getElementById('transcribe-fps')?.value) ??
      '';
    const fpsOverride = parseFloat(fpsOverrideRaw);
    const fps = Number.isFinite(fpsOverride) ? fpsOverride : null;

    const tcEnabled = !!(
      (document.getElementById('fmt-txt-include-timecodes')?.checked) ??
      (document.getElementById('out-timecodes')?.checked)
    );
    const style =
      document.getElementById('fmt-txt-timecode-format')?.value ||
      document.getElementById('transcribe-timecode-style')?.value ||
      'ndf';
    const dfEnabled = style === 'df';                                                // drop-frame on?
    const isDfRate =
      fps == null ? false : (Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 59.94) < 0.05);
    const is30ish = fps == null ? false : Math.abs(fps - 30.0) < 0.05;
    let allowNdf = false;
    try { allowNdf = (localStorage.getItem('scc-allow-ndf') === 'true'); } catch {}
    // SCC allowed when:
    //  • DF path: timecodes on + DF on + DF-capable rate, OR
    //  • NDF path: timecodes on + NDF style + fps≈30.00 + (feature flag enabled)
    const sccAllowed = !!tcEnabled && (
      (dfEnabled && isDfRate) ||
      (allowNdf && style === 'ndf' && is30ish && !dfEnabled)
    );
    select.dataset.sccAllowed = sccAllowed ? 'true' : 'false';

    // Engine-specific disables go here. Keep arrays empty by default;
    // flip them on per engine as needed without touching UI code.
    // Example (disabled): { whisper: ['burnIn'] }
    const impossibleFormats = {
      lead: [],
      whisper: [],
      whisperx: []
    };

    const list = select.closest('.dropdown-wrapper')?.querySelector('.value-list');
    const disableList = impossibleFormats[engine] || [];

    // Styled dropdown: disable via the rendered <li> items (hidden field is not a <select>)
    if (list) {
      [...list.children].forEach(li => {
        const liDisabled = disableList.includes(li.dataset.value);
        if (liDisabled) {
          li.classList.add('disabled');
          li.classList.remove('selected');
        } else {
          li.classList.remove('disabled');
        }
      });
    }

    // Keep current selection unless it's explicitly disabled. Fallback to first enabled <li>.
    if (disableList.includes(select.value)) {
      const fallback = list
        ? ([...list.children].find(li => !li.classList.contains('disabled'))?.dataset.value || 'txt')
        : 'txt';
      setDropdownValue('transcribe-output-formats', fallback);
      select.value = fallback;
    } else {
      setDropdownValue('transcribe-output-formats', select.value || 'txt');
    }

    updateSccUiRows();
  }

  // ===== Format-scoped UI visibility (hard-coded map) =====
  const FORMAT_UI = {
    txt:              { subs:false, review:false },
    tokenAlignedTxt:  { subs:false, review:false },
    script:           { subs:false, review:false },
    srt:              { subs:false, review:true  },
    vtt:              { subs:true,  review:true  },
    scc:              { subs:true,  review:true  },
    burnIn:           { subs:true,  review:true  },
    xml:              { subs:false, review:false },
    json:             { subs:false, review:false },
    finalJson:        { subs:false, review:false }
  };

  function _setDisplay(selector, on, onDisplay = '') {
    document.querySelectorAll(selector).forEach(el => {
      el.style.display = on ? onDisplay : 'none';
    });
  }

  function applyCurrentFormatScope() {
    const select = document.getElementById('transcribe-output-formats');
    const fmt = select?.value || 'txt';
    const cfg = FORMAT_UI[fmt] || {};

    const panelRoot = document.getElementById('transcribe');
    if (panelRoot) {
      panelRoot.dataset.formatScope = fmt;
    }

    _setDisplay('#subtitle-options', !!cfg.subs,   'block');
    _setDisplay('#subtitle-review',  !!cfg.review, 'block');

    updateSccUiRows();
  }

  // Recompute allowed formats and show/hide SCC rows on selection
  // NOTE: we keep only the smart handler below (which also auto-enables SCC prereqs)
  // and remove the bare one that immediately forces a fallback before prereqs are set.

  // Keep UI reactive to settings that affect SCC allowance
  document.getElementById('out-timecodes')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('transcribe-timecode-style')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('transcribe-fps')?.addEventListener('input', updateDisabledOutputFormats);
  document.getElementById('fmt-txt-include-timecodes')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('fmt-txt-timecode-format')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('fmt-txt-fps')?.addEventListener('input', updateDisabledOutputFormats);

  // Smart handler: when SCC is chosen, auto-enable prerequisites, then re-evaluate UI.
  document.getElementById('transcribe-output-formats')?.addEventListener('change', () => {
    const select = document.getElementById('transcribe-output-formats');
    const isScc = select?.value === 'scc';

    // Auto-enable prerequisites when SCC is chosen
    if (isScc) {
      const tc = document.getElementById('fmt-txt-include-timecodes') ||
        document.getElementById('out-timecodes');
      const fpsEl = document.getElementById('fmt-txt-fps') ||
        document.getElementById('transcribe-fps');
      const styleEl = document.getElementById('fmt-txt-timecode-format') ||
        document.getElementById('transcribe-timecode-style');
      const styleControlId = styleEl?.id;
      let allowNdf = false;
      try { allowNdf = (localStorage.getItem('scc-allow-ndf') === 'true'); } catch {}
      const style = styleEl?.value || 'ndf';
      const fpsVal = parseFloat(fpsEl?.value || '');
      const isDfRate = Number.isFinite(fpsVal) && (Math.abs(fpsVal - 29.97) < 0.05 || Math.abs(fpsVal - 59.94) < 0.05);
      const is30ish = Number.isFinite(fpsVal) && Math.abs(fpsVal - 30.0) < 0.05;
      const preferNdf = allowNdf && style === 'ndf';

      if (tc && !tc.checked) { tc.checked = true; tc.dispatchEvent(new Event('change')); }
      if (preferNdf) {
        if (styleEl && styleEl.value !== 'ndf') {
          if (styleControlId) setDropdownValue(styleControlId, 'ndf');
          styleEl.value = 'ndf';
          styleEl.dispatchEvent(new Event('change'));
        }
        if (fpsEl && (!Number.isFinite(fpsVal) || !is30ish)) {
          fpsEl.value = '30.00';
          fpsEl.dispatchEvent(new Event('input'));
        }
      } else {
        if (styleEl && styleEl.value !== 'df') {
          if (styleControlId) setDropdownValue(styleControlId, 'df');
          styleEl.value = 'df';
          styleEl.dispatchEvent(new Event('change'));
        }
        if (fpsEl && (!Number.isFinite(fpsVal) || !isDfRate)) {
          fpsEl.value = '29.97';
          fpsEl.dispatchEvent(new Event('input'));
        }
      }
    }

    // Show/hide SCC rows (kept from your function)
    updateDisabledOutputFormats();
    applyCurrentFormatScope();
  });

  function initSubtitleOptionsToggle() {
    // Visibility now controlled by applyCurrentFormatScope()
  }

  function initTextOptionsToggle() {
    // Visibility now controlled by applyCurrentFormatScope()
  }

  function initFormatLocks() {
    // Legacy global format locks (TXT/XML/SRT/VTT) have been removed.
    // Format-scoped mini-panels now own all option state. This is kept
    // as a no-op so existing initialization calls remain valid.
  }

  function toggleTimecodeFields() {
    // Global timecode controls are no longer user-facing. Mini-panels own the
    // configuration, so this function remains for backward compatibility only.
  }


  function initSamplePreview() {
    const sample = document.getElementById('sample-preview');
    if (!sample) return;

    const update = () => {
      const format = document.getElementById('transcribe-output-formats')?.value || '';

      const config = gatherConfig(); // includes legacy txtOptions + new formats.txt

      const baseSegment = [{
        start: 1.0,
        end: 5.0,
        msStart: 1000,
        msEnd: 5000,
        speaker: 'SPEAKER',
        text: 'Welcome to Lead AI. I am here to help with your needs.',
        tokens: []
      }];

      // Prefer the new format-scoped values for preview math
      const txtFmt = (config.formats && config.formats.txt) || {};
      const finalJsonFmt = (config.formats && config.formats.finalJson) || {};

      // Base FPS selection for preview
      let fpsForPreview =
        Number(txtFmt.frameRateOverride) ||
        (config.system && Number(config.system.fps)) ||
        30;

      // DF is selected when TXT timecodeFormat is 'df'
      const dropPref = (txtFmt.timecodeFormat === 'df');

      // PREVIEW-ONLY RULE:
      // The Timecode Format dropdown is the *only* authority for DF vs NDF.
      // As soon as the user picks DF, force a canonical 29.97 DF preview,
      // ignoring any frame-rate override or source metadata.
      if (dropPref) {
        fpsForPreview = 29.97;
      }

      // Map TXT timecodeFormat → engine style
      const tcStyleFromTxt =
        (txtFmt.timecodeFormat === 'ms')
          ? 'ms'
          : (txtFmt.timecodeFormat === 'df' ? 'df' : 'colon');

      // Hand the preview a minimal system block so DF renders with semicolons when applicable
      const previewJson = {
        segments: baseSegment,
        system: {
          fps: fpsForPreview,
          dropFramePreferred: dropPref
        }
      };

      try {
        let output = '';

        if (format === 'txt') {
          // Merge new formats.txt values over legacy txtOptions (legacy stays as a shim)
          const mappedFromFormats = {
            includeSpeakers:   txtFmt.includeSpeakers,
            includeTimecodes:  txtFmt.includeTimecodes,
            timestampStyle:    txtFmt.timestampPlacement,
            speakerStyle:      txtFmt.speakerLabelStyle,
            groupBySpeaker:    txtFmt.groupBySpeaker
          };
          output = window.transcribeEngine.generatePlainText(
            previewJson,
            {
              ...(config.txtOptions || {}),
              ...(mappedFromFormats || {}),
              timecodeStyle: tcStyleFromTxt,
              fps: fpsForPreview
            }
          );
        } else if (format === 'srt') {
          output = window.transcribeEngine.generateSRT(baseSegment, config);
        } else if (format === 'vtt') {
          output = window.transcribeEngine.generateVTT(baseSegment, config);
        } else if (format === 'script') {
          // Preview Scripted as CSV; DOCX is binary so we show an informative stub.
          const scriptFmt = (config.formats && config.formats.script) || {};
          const exportKind = String(scriptFmt.exportFormat || 'csv').toLowerCase();
          // decide preview fps/timecode style
          let fpsForPreview =
            Number(scriptFmt.frameRateOverride) ||
            (config.system && Number(config.system.fps)) ||
            30;
          const dropPreferred = (scriptFmt.timecodeFormat === 'df');

          // PREVIEW-ONLY:
          // Scripted preview follows the Scripted Timecode Format dropdown only.
          // DF selection forces 29.97 DF for the sample, regardless of overrides.
          if (dropPreferred) {
            fpsForPreview = 29.97;
          }
          if (exportKind === 'csv') {
            const scriptPreviewOptions = {
              fps: fpsForPreview,
              timecodeFormat:
                scriptFmt.timecodeFormat ||
                config.timecodeStyle ||
                'ndf',
              startTimecodeOffset:
                scriptFmt.startTimecodeOffset ||
                config.startTC ||
                null,
              includeSpeakers:
                scriptFmt.includeSpeakers ?? true,
              includeTimecodes:
                scriptFmt.includeTimecodes ?? true,
              groupBySpeaker: !!scriptFmt.groupBySpeaker,
              speakerStyle: scriptFmt.speakerLabelStyle || 'title',
              timestampStyle: scriptFmt.timestampPlacement || 'start-end'
            };

            output = window.transcribeEngine.generateSyncableScriptCSV(
              { segments: baseSegment },
              scriptPreviewOptions
            );
          } else {
            output = [
              '📄 DOCX export selected.',
              'A .docx file will be generated on run; in-panel preview shows CSV only.'
            ].join('\n');
          }
        } else if (format === 'finalJson') {
          let fpsForFinal =
            Number(finalJsonFmt.frameRateOverride) ||
            (config.system && Number(config.system.fps)) ||
            fpsForPreview;
          const dropPrefFinal =
            (typeof finalJsonFmt.dropFrame === 'boolean')
              ? finalJsonFmt.dropFrame
              : (finalJsonFmt.timecodeFormat === 'df');
          const pretty = !!document.getElementById('fmt-finaljson-pretty')?.checked;
          const stub = {
            system: { fps: fpsForFinal, dropFramePreferred: dropPrefFinal },
            segments: baseSegment
          };
          output = JSON.stringify(stub, null, pretty ? 2 : 0);
        } else if (format === 'xml') {
          output = window.transcribeEngine.generateXML(baseSegment, config.timecodeStyle);
        } else if (format === 'scc') {
          const txt = (config.txtOptions?.includeSpeakers ? 'SPEAKER: ' : '') + baseSegment[0].text;
          // Locked left alignment → indent 0
          output = `Scenarist_SCC V1.0\n00:00:01;00  [PAC row=14 indent=0] ${txt}\n... (preview only)`;
        } else {
          output = 'Select an output format to preview';
        }

        sample.textContent = output.trim();
      } catch (err) {
        console.warn('⚠️ Sample preview error:', err);
        sample.textContent = '[Error rendering preview]';
      }
    };

    [
      'transcribe-output-formats',
      'out-speaker-names',
      'out-timecodes',
      'txt-timestamp-style',
      'txt-speaker-style',
      'txt-group-by-speaker',
      'transcribe-fps',
      'transcribe-timecode-style',
      // Format-scoped TXT controls
      'fmt-txt-include-timecodes',
      'fmt-txt-timecode-format',
      'fmt-txt-fps',
      'fmt-txt-tc-start',
      'fmt-txt-timestamp-placement',
      'fmt-txt-speaker-style',
      'fmt-txt-group-by-speaker',
      'fmt-txt-include-speaker-names',
      // Format-scoped SRT controls
      'fmt-srt-include-speaker-names',
      'fmt-srt-speaker-style',
      // Format-scoped VTT controls
      'fmt-vtt-include-speaker-names',
      'fmt-vtt-speaker-style',
      'fmt-vtt-include-style',
      // SCC mini-panel (refresh preview when user tweaks these)
      'fmt-scc-max-chars',
      'fmt-scc-max-lines',
      'fmt-scc-max-duration',
      'fmt-scc-font-name',
      'fmt-scc-font-size',
      // Format-scoped Scripted controls
      'fmt-script-export',
      'fmt-script-include-speaker-names',
      'fmt-script-group-by-speaker',
      'fmt-script-speaker-style',
      'fmt-script-timestamp-placement',
      'fmt-script-include-timecodes',
      'fmt-script-timecode-format',
      'fmt-script-fps',
      'fmt-script-tc-start',
      // Final JSON controls
      'fmt-finaljson-timecode-format',
      'fmt-finaljson-fps',
      'fmt-finaljson-tc-start',
      'fmt-finaljson-pretty'
    ].forEach(id => document.getElementById(id)?.addEventListener('change', update));

    update();
  }

  if (document.readyState !== 'loading') {
    initSubtitleOptionsToggle();
    initTextOptionsToggle();
    initFormatLocks();
    refreshPresetDropdown();
    updateDisabledOutputFormats();
    applyCurrentFormatScope();
    initSamplePreview();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      initSubtitleOptionsToggle();
      initTextOptionsToggle();
      initFormatLocks();
      refreshPresetDropdown();
      updateDisabledOutputFormats();
      applyCurrentFormatScope();
      initSamplePreview();
    });
  }

  // Cancel starts disabled until a transcription is running
  el.cancelBtn.disabled = true;

  function setTranscribeControlsDisabled(state) {
    document.querySelectorAll('#transcribe input,#transcribe select,#transcribe textarea,#transcribe button').forEach(elem => {
      if (elem.id === 'transcribe-watch-mode') return;
      if (elem.id === 'cancel-transcribe') return;
      elem.disabled = state;
    });
    el.startBtn.disabled = state;
    el.resetBtn.disabled = state;

    if (state) {
      transcribeLockWrapper?.classList.add('locked');
    } else {
      transcribeLockWrapper?.classList.remove('locked');
    }
  }

  function appendLiveTranscript(line) {
    if (!el.liveOutput) return;
    el.liveOutput.textContent += line + '\n';
    el.liveOutput.scrollTop = el.liveOutput.scrollHeight;
  }
function getFileMetadata(filePath) {
  return window.electron.ffprobeJson(filePath).then(data => {
    if (!data) {
      return Promise.reject('❌ FFprobe returned no data');
    }
    if (data.error) {
      return Promise.reject(`❌ FFprobe error: ${data.error}`);
    }
    return data;
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

// ─── Container + audio helpers (match other panels) ─────────────────────────
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

async function summarizeTranscribeFile(filePath) {
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

    const line1 = `🎧 ${name}`;
    const line2 = `  ${container}  ${res}${fps ? `  ${fps}` : ''}`;
    const line3 = `  ${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}${vc ? ` • 🎬 ${vc}` : ''} • ${dur}`;
    return [line1, line2, line3].join('\n');
  } catch (err) {
    return `❌ ${name} — ${String(err)}`;
  }
}

async function updateFileInfoDisplay(filePath) {
  const infoBox = prepareFileInfoGrid('transcribe');
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
        <div style=\"grid-column: span 5;\">❌ ${err}</div>
      </div>`;
    infoBox.insertAdjacentHTML('beforeend', row);
  }

  setupResizableGrid(infoBox, 'gridCols-transcribe');
}

  function gatherConfig() {
    const v = document.getElementById('transcribe-output-formats')?.value || '';
    const selected = v ? [v, v.replace(/^\./, '')] : [];
    const outputFormats = {
      txt: false,
      srt: false,
      vtt: false,
      scc: false,
      script: false,
      xml: false,
      finalJson: false,
      burnIn: false
    };
    selected.forEach(val => {
      if (Object.prototype.hasOwnProperty.call(outputFormats, val)) {
        outputFormats[val] = true;
      }
    });
    // Optional debug to surface what will actually be written
    console.log('Output format selection:', outputFormats);

    let apiKey = '';
    // Prefer TXT-scoped speaker toggle if present; fall back to global
    const includeSpeakers =
      (document.getElementById('fmt-txt-include-speaker-names')?.checked) ??
      (document.getElementById('out-speaker-names')?.checked);
    try {
      const prefsPath = window.electron.resolvePath('config', 'state.json');
      const raw = window.electron.readTextFile(prefsPath);
      const prefs = JSON.parse(raw);
      apiKey = prefs?.preferences?.apiKey || '';
    } catch (err) {
      console.warn('⚠️ Failed to load API key from preferences:', err);
    }

    const sccAlignment = document.getElementById('scc-alignment')?.value || 'center';
    const sccChannelRaw = document.getElementById('scc-channel')?.value || 'CC1';
    const sccRowPolicy = 'bottom2';
    const sccMode = 'pop-on';
    // hidden power-user override via localStorage: scc-time-source = 'auto'|'start'|'df-string'|'ms'
    let sccTimeSource = 'ms';
    try { sccTimeSource = localStorage.getItem('scc-time-source') || 'ms'; } catch {}

    const globalTimecodeStyle = document.getElementById('transcribe-timecode-style')?.value || 'ndf';
    const globalFpsValue = (() => {
      const raw = document.getElementById('transcribe-fps')?.value ?? '';
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();
    const globalStartTc = document.getElementById('transcribe-tc-start')?.value?.trim() || null;

    const txtFormat = {
      includeTimecodes:
        (document.getElementById('fmt-txt-include-timecodes')?.checked) ??
        document.getElementById('out-timecodes')?.checked,
      includeSpeakers,
      groupBySpeaker:
        (document.getElementById('fmt-txt-group-by-speaker')?.checked),
      timestampPlacement: (() => {
        const v =
          (document.getElementById('fmt-txt-timestamp-placement')?.value) ??
          'start_end';
        return String(v).replace(/_/g, '-');
      })(),
      speakerLabelStyle:
        (document.getElementById('fmt-txt-speaker-style')?.value) ??
        'title',
      timecodeFormat:
        (document.getElementById('fmt-txt-timecode-format')?.value) ??
        (document.getElementById('transcribe-timecode-style')?.value) ??
        'ndf',
      dropFrame: (() => {
        const fmtStyle = document.getElementById('fmt-txt-timecode-format')?.value;
        if (fmtStyle) return fmtStyle === 'df';
        const global = document.getElementById('transcribe-timecode-style')?.value;
        return global === 'df';
      })(),
      frameRateOverride: (function(){
        const raw =
          (document.getElementById('fmt-txt-fps')?.value) ??
          (document.getElementById('transcribe-fps')?.value) ??
          '';
        const v = parseFloat(raw);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      startTimecodeOffset:
        (document.getElementById('fmt-txt-tc-start')?.value?.trim()) ??
        (document.getElementById('transcribe-tc-start')?.value?.trim()) ??
        null
    };

    const finalJsonFormat = {
      timecodeFormat:
        (document.getElementById('fmt-finaljson-timecode-format')?.value) ??
        (document.getElementById('transcribe-timecode-style')?.value) ??
        'ndf',
      dropFrame: (() => {
        const v = document.getElementById('fmt-finaljson-timecode-format')?.value;
        if (v) return v === 'df';
        return (document.getElementById('transcribe-timecode-style')?.value) === 'df';
      })(),
      frameRateOverride: (function(){
        const raw =
          (document.getElementById('fmt-finaljson-fps')?.value) ??
          (document.getElementById('transcribe-fps')?.value) ?? '';
        const v = parseFloat(raw);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      startTimecodeOffset:
        (document.getElementById('fmt-finaljson-tc-start')?.value?.trim()) ??
        (document.getElementById('transcribe-tc-start')?.value?.trim()) ?? null,
      pretty: (document.getElementById('fmt-finaljson-pretty')?.checked) ?? true
    };

    const scriptFormat = {
      exportFormat:
        (document.getElementById('fmt-script-export')?.value) || 'csv',
      includeSpeakers:
        (document.getElementById('fmt-script-include-speaker-names')?.checked) ??
        includeSpeakers,
      groupBySpeaker:
        (document.getElementById('fmt-script-group-by-speaker')?.checked) ?? false,
      speakerLabelStyle:
        (document.getElementById('fmt-script-speaker-style')?.value) ?? 'title',
      timestampPlacement: (() => {
        const v =
          (document.getElementById('fmt-script-timestamp-placement')?.value) ??
          'start_end';
        return String(v).replace(/_/g, '-');
      })(),
      includeTimecodes:
        (document.getElementById('fmt-script-include-timecodes')?.checked) ?? true,
      timecodeFormat:
        (document.getElementById('fmt-script-timecode-format')?.value) ?? 'ndf',
      frameRateOverride: (function(){
        const raw =
          (document.getElementById('fmt-script-fps')?.value) ?? '';
        const v = parseFloat(raw);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      startTimecodeOffset:
        (document.getElementById('fmt-script-tc-start')?.value?.trim()) ?? null
    };

    const srtFormat = {
      includeSpeakers:
        (document.getElementById('fmt-srt-include-speaker-names')?.checked) ??
        includeSpeakers,
      speakerLabelStyle:
        (document.getElementById('fmt-srt-speaker-style')?.value) ??
        (document.getElementById('txt-speaker-style')?.value) ??
        'title'
    };

    const vttFormat = {
      includeSpeakers:
        (document.getElementById('fmt-vtt-include-speaker-names')?.checked) ??
        includeSpeakers,
      speakerLabelStyle:
        (document.getElementById('fmt-vtt-speaker-style')?.value) ??
        (document.getElementById('txt-speaker-style')?.value) ??
        'title',
      includeStyleMetadata:
        (document.getElementById('fmt-vtt-include-style')?.checked) ??
        (document.getElementById('sub-include-style')?.checked)
    };

    const formats = {
      txt: txtFormat,
      finalJson: finalJsonFormat,
      script: scriptFormat,
      srt: srtFormat,
      vtt: vttFormat
    };

    const txtOptions = {
      includeSpeakers: txtFormat.includeSpeakers,
      includeTimecodes: txtFormat.includeTimecodes,
      timestampStyle: txtFormat.timestampPlacement,
      speakerStyle: txtFormat.speakerLabelStyle,
      groupBySpeaker: txtFormat.groupBySpeaker,
      frameRateOverride: txtFormat.frameRateOverride
    };

    const scriptOptions = {
      timestampStyle: scriptFormat.timestampPlacement,
      speakerStyle: scriptFormat.speakerLabelStyle,
      groupBySpeaker: scriptFormat.groupBySpeaker,
      exportFormat: scriptFormat.exportFormat
    };

    const derivedTimecodeFormat = txtFormat.timecodeFormat || globalTimecodeStyle || 'ndf';
    const derivedDropFrame =
      typeof txtFormat.dropFrame === 'boolean'
        ? txtFormat.dropFrame
        : (derivedTimecodeFormat === 'df');
    const derivedFpsOverride =
      (txtFormat.frameRateOverride != null)
        ? txtFormat.frameRateOverride
        : globalFpsValue;
    const derivedStartTc = txtFormat.startTimecodeOffset || globalStartTc;

    const cfg = {
      files: el.files.value.split('\n').filter(Boolean),
      outputPath: el.outputPath.value,
      language: document.getElementById('transcribe-language')?.value,
      multiSpeaker: includeSpeakers,
      useAltTracks: document.getElementById('transcribe-use-tracks')?.checked,
      engine: document.getElementById('transcribe-engine')?.value,
      offlineOnly: document.getElementById('transcribe-offline')?.checked,
      accuracyMode: document.getElementById('transcribe-accuracy-mode')?.value,
      confidenceThreshold: document.getElementById('transcribe-confidence')?.value,
      allowFallback: el.allowFallback?.checked,
      outputFormats,
      extras: {
        syncableScript: document.getElementById('out-syncable')?.checked,
        speakerNames: includeSpeakers,
        timecodes: !!txtFormat.includeTimecodes,
      },
      dropFrame: derivedDropFrame,
      fpsOverride: derivedFpsOverride ?? null,
      startTC: derivedStartTc,
      filterNonSpeech: document.getElementById('transcribe-filter-nonspeech')?.checked,
      removeFillers: document.getElementById('transcribe-remove-fillers')?.checked,
      fileNameTemplate: document.getElementById('transcribe-naming-template')?.value?.trim(),
      // Store the raw dropdown selection (ndf | df | ms)
      timecodeStyle: derivedTimecodeFormat,
      sccOptions: {
        alignment: sccAlignment,                            // 'left' | 'center' | 'right'
        channel: parseInt(String(sccChannelRaw).replace(/\D/g,''), 10) || 1,  // 1..4
        rowPolicy: sccRowPolicy,
        mode: sccMode,
        // new:
        timeSource: sccTimeSource,
        appendEOFAt: 'afterLast',
        eofOp: 'edm',
        // Header font comment → composed from SCC panel if present
        fontComment: (() => {
          const name = document.getElementById('fmt-scc-font-name')?.value?.trim();
          const size = parseInt(document.getElementById('fmt-scc-font-size')?.value || '', 10);
          if (name && Number.isFinite(size)) return `${name} ${size} px`;
          if (name) return name;
          const legacy = document.getElementById('scc-font-comment')?.value?.trim();
          return legacy || '';
        })(),
        // NEW power-user toggles
        allowNdf: (() => {
          try { return localStorage.getItem('scc-allow-ndf') === 'true'; } catch { return false; }
        })(),
        padEven: (() => {
          try { return localStorage.getItem('scc-pad-even') === 'true'; } catch { return false; }
        })(),
        prefixWords: (() => {
          try {
            const s = localStorage.getItem('scc-prefix-words') || '';
            return s.split(/[\,\s]+/).map(t => t.trim()).filter(Boolean);
          } catch { return []; }
        })()
      },
      maxCharsPerLine: (() => {
        const isScc = outputFormats.scc === true;
        const v = parseInt(document.getElementById('fmt-scc-max-chars')?.value || '', 10);
        if (isScc && Number.isFinite(v)) return v;
        return parseInt(document.getElementById('sub-max-chars')?.value || '42', 10);
      })(),
      maxLinesPerBlock: (() => {
        const isScc = outputFormats.scc === true;
        const v = parseInt(document.getElementById('fmt-scc-max-lines')?.value || '', 10);
        if (isScc && Number.isFinite(v)) return v;
        return parseInt(document.getElementById('sub-max-lines')?.value || '2', 10);
      })(),
      verboseQcLogs: document.getElementById('verbose-qc-logs')?.checked === true,
      maxDurationSeconds: (() => {
        const isScc = outputFormats.scc === true;
        const v = parseFloat(document.getElementById('fmt-scc-max-duration')?.value || '');
        if (isScc && Number.isFinite(v)) return v;
        return parseFloat(document.getElementById('sub-max-duration')?.value || '6.0');
      })(),
      includeSpeakerNames: includeSpeakers,
      enhancements: {
        boostAudio: document.getElementById('acc-boost')?.checked,
        autoPunctuate: document.getElementById('acc-auto-punct')?.checked,
        smartCaps: document.getElementById('acc-smart-cap')?.checked,
        spellcheck: document.getElementById('acc-spellcheck')?.checked,
        redact: document.getElementById('acc-redact')?.checked,
      },
      // Legacy txtOptions remains for backward compatibility in engines
      txtOptions,
      // ─────────────────────────────────────────────────────────────
      // NEW: Format‑scoped config (Option B) — additive, not breaking
      // ─────────────────────────────────────────────────────────────
      formats,
      // Keep legacy scriptOptions for backward compatibility with engines/presets
      scriptOptions,
      vttOptions: {
        maxCharsPerLine: parseInt(document.getElementById('sub-max-chars')?.value || '42'),
        maxLinesPerBlock: parseInt(document.getElementById('sub-max-lines')?.value || '2'),
        maxDurationSeconds: parseFloat(document.getElementById('sub-max-duration')?.value || '6.0'),
        includeStyle:
          (document.getElementById('fmt-vtt-include-style')?.checked) ??
          document.getElementById('sub-include-style')?.checked
      },
      translation: {
        enabled: document.getElementById('translate-enable')?.checked,
        target: document.getElementById('translate-target')?.value,
        sideBySide: document.getElementById('translate-side-by-side')?.checked,
      },
      fileHandling: {
        rename: document.getElementById('transcribe-rename')?.checked,
        embedMetadata: document.getElementById('transcribe-embed')?.checked,
      },
      postActions: {
        sendToSubtitle: document.getElementById('transcribe-send-subtitle')?.checked,
      },
      enableN8N: el.enableN8N?.checked,
      n8nUrl: el.n8nUrl?.value,
      n8nLog: el.n8nLog?.checked,
      notes: el.notes?.value || '',
      watchMode: el.watchMode?.checked,
      localSpeakerDetection: includeSpeakers,
      detectSpeakers: includeSpeakers,
      apiKey
    };

    // Ensure SCC time source defaults to milliseconds unless explicitly overridden
    cfg.sccOptions.timeSource = 'ms';

    // If Scripted is the active format, prefer its time settings globally so
    // downstream writers have consistent fps/style without reaching into formats.*
    try {
      const sel = document.getElementById('transcribe-output-formats')?.value || '';
      if (sel === 'script') {
        const sf = cfg.formats?.script || {};
        if (sf.timecodeFormat) {
          cfg.timecodeStyle = sf.timecodeFormat;   // 'ndf'|'df'|'ms'
          cfg.dropFrame = sf.timecodeFormat === 'df';
        }
        if (sf.frameRateOverride != null) {
          const ov = Number(sf.frameRateOverride);
          cfg.fpsOverride = Number.isFinite(ov) ? ov : null;
        }
        if (sf.startTimecodeOffset) cfg.startTC = sf.startTimecodeOffset;
      }
    } catch {}

    // Do not second-guess DF at the UI. If user selects DF, keep it.
    // Backend will validate using resolved fps (wrapped.system.fps).
    const ov = Number(cfg.fpsOverride);
    if (cfg.dropFrame && cfg.fpsOverride !== null && Number.isFinite(ov)) {
      const isDf = Math.abs(ov - 29.97) < 0.05 || Math.abs(ov - 59.94) < 0.10;
      if (!isDf) cfg.dropFrame = false;
    }

    return cfg;
  }

  function applyTranscribePreset(data) {
    const langEl = document.getElementById('transcribe-language');
    if (langEl) langEl.value = data.language || 'en';
    const engineEl = document.getElementById('transcribe-engine');
    if (engineEl) engineEl.value = data.engine || 'lead';
    const accuracyEl = document.getElementById('transcribe-accuracy-mode');
    if (accuracyEl) accuracyEl.value = data.accuracyMode || 'auto';
    const confEl = document.getElementById('transcribe-confidence');
    if (confEl) confEl.value = data.confidenceThreshold || '90';
    const offlineEl = document.getElementById('transcribe-offline');
    if (offlineEl) offlineEl.checked = !!data.offlineOnly;
    if (el.allowFallback) el.allowFallback.checked = !!data.allowFallback;

    const select = document.getElementById('transcribe-output-formats');
    if (select) {
      let selectedFormat = 'txt';
      if (data.outputFormats) {
        let firstEnabled = Object.keys(data.outputFormats).find(k => data.outputFormats[k]);
        // Legacy preset guard: replace "mcc" with "scc" (or "txt" if SCC isn't enabled)
        if (firstEnabled === 'mcc') {
          firstEnabled = (data.outputFormats.scc ? 'scc' : 'txt');
        }
        // Legacy: normalize removed "markers" to a safe default
        if (firstEnabled === 'markers') {
          firstEnabled = 'txt';
        }
        if (firstEnabled) selectedFormat = firstEnabled;
      } else if (select.value) {
        selectedFormat = select.value;
      }
      setDropdownValue('transcribe-output-formats', selectedFormat);
      select.value = selectedFormat;
      select.dispatchEvent(new Event('change'));
    }
    // Ignore SCC alignment/channel in presets; writer locks them.
    const renameEl = document.getElementById('transcribe-rename');
    if (renameEl) renameEl.checked = !!data.fileHandling?.rename;
    const embedEl = document.getElementById('transcribe-embed');
    if (embedEl) embedEl.checked = !!data.fileHandling?.embedMetadata;
    const fpsEl = document.getElementById('transcribe-fps');
    if (fpsEl) fpsEl.value = data.fpsOverride || '';
    const tcStartEl = document.getElementById('transcribe-tc-start');
    if (tcStartEl) tcStartEl.value = data.startTC || '';
    const filterNS = document.getElementById('transcribe-filter-nonspeech');
    if (filterNS) filterNS.checked = !!data.filterNonSpeech;
    const removeFill = document.getElementById('transcribe-remove-fillers');
    if (removeFill) removeFill.checked = !!data.removeFillers;
    const nameTpl = document.getElementById('transcribe-naming-template');
    if (nameTpl) nameTpl.value = data.fileNameTemplate || '';
    const tcStyle = document.getElementById('transcribe-timecode-style');
    if (tcStyle) {
      const uiStyle =
        (data.timecodeStyle === 'ms') ? 'ms' :
        (data.dropFrame ? 'df' : 'ndf');
      setDropdownValue('transcribe-timecode-style', uiStyle);
      tcStyle.value = uiStyle;
      tcStyle.dispatchEvent(new Event('change')); // keeps DF checkbox aligned
    }
    const subChars = document.getElementById('sub-max-chars');
    if (subChars) subChars.value = data.maxCharsPerLine ?? 42;
    const subLines = document.getElementById('sub-max-lines');
    if (subLines) subLines.value = data.maxLinesPerBlock ?? 2;
    const subDur = document.getElementById('sub-max-duration');
    if (subDur) subDur.value = data.maxDurationSeconds ?? 6.0;
    const subStyle = document.getElementById('sub-include-style');
    if (subStyle) subStyle.checked = !!data.vttOptions?.includeStyle;
    const txtTS = document.getElementById('txt-timestamp-style');
    if (txtTS) txtTS.value = data.txtOptions?.timestampStyle || 'start-end';
    const txtSpk = document.getElementById('txt-speaker-style');
    if (txtSpk) txtSpk.value = data.txtOptions?.speakerStyle || 'title';
    const txtGroup = document.getElementById('txt-group-by-speaker');
    if (txtGroup) txtGroup.checked = !!data.txtOptions?.groupBySpeaker;
    const txtFps = document.getElementById('transcribe-fps');
    if (txtFps) txtFps.value = data.txtOptions?.frameRateOverride || '';
    // Populate new Scripted format-scoped controls
    const scriptData = (data.formats && data.formats.script) || {};
    const so = data.scriptOptions || {};
    const scriptExport = document.getElementById('fmt-script-export');
    if (scriptExport) setDropdownValue('fmt-script-export', scriptData.exportFormat || so.exportFormat || 'csv');
    const spkNames = document.getElementById('fmt-script-include-speaker-names');
    if (spkNames) spkNames.checked = !!(scriptData.includeSpeakers ?? so.includeSpeakers ?? data.includeSpeakerNames);
    const grpSpk = document.getElementById('fmt-script-group-by-speaker');
    if (grpSpk) grpSpk.checked = !!(scriptData.groupBySpeaker ?? so.groupBySpeaker);
    const spkStyle = document.getElementById('fmt-script-speaker-style');
    if (spkStyle) setDropdownValue('fmt-script-speaker-style', scriptData.speakerLabelStyle || so.speakerStyle || 'title');
    const tsPlace = document.getElementById('fmt-script-timestamp-placement');
    if (tsPlace) setDropdownValue('fmt-script-timestamp-placement', (scriptData.timestampPlacement || so.timestampStyle || 'start-end').replace(/-/g,'_'));
    const incTc = document.getElementById('fmt-script-include-timecodes');
    if (incTc) incTc.checked = !!(scriptData.includeTimecodes ?? true);
    const tcFmt = document.getElementById('fmt-script-timecode-format');
    if (tcFmt) setDropdownValue('fmt-script-timecode-format', scriptData.timecodeFormat || 'ndf');
    const fpsEl2 = document.getElementById('fmt-script-fps');
    if (fpsEl2) fpsEl2.value = scriptData.frameRateOverride || '';
    const tcStart2 = document.getElementById('fmt-script-tc-start');
    if (tcStart2) tcStart2.value = scriptData.startTimecodeOffset || '01:00:00:00';
    const notesEl = document.getElementById('transcribe-notes');
    if (notesEl) notesEl.value = data.notes || '';
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
      console.error('Failed to read presets:', err);
    }

    setupStyledDropdown('transcribe-preset', opts);
    setDropdownValue('transcribe-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const raw = window.electron.readTextFile(
            window.electron.joinPath(presetDir, file)
          );
          const data = JSON.parse(raw);
          applyTranscribePreset(data);
        } catch (err) {
          console.error('Failed to load preset', err);
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  function isWatchConfigValid(cfg) {
    if (!cfg) return 'No transcribe config found.';
    const missing = [];
    if (!cfg.files?.length) missing.push('Files');
    if (!cfg.outputPath) missing.push('Output Path');
    if (!Object.values(cfg.outputFormats || {}).some(v => v)) missing.push('Output Format Selection');
    return missing.length ? `Missing: ${missing.join(', ')}` : true;
  }

  if (window.watchValidators) {
    window.watchValidators.transcribe = isWatchConfigValid;
  }

    const startBtn = el.startBtn;
  const cancelBtn = el.cancelBtn;
  const selectBtn = el.selectFiles;
  watchUtils?.initWatchToggle({
    checkboxId: 'transcribe-watch-mode',
    startBtnId: startBtn?.id || 'start-transcribe',
    cancelBtnId: cancelBtn?.id || 'cancel-transcribe',
    onToggle: isWatch => {
      if (selectBtn) {
        selectBtn.textContent = isWatch ? 'Select Watch Folder' : 'Select Source';
      }
    }
  });

  el.selectFiles?.addEventListener('click', async () => {
    const files = await ipc.selectFiles?.();
    if (files && files.length) {
      el.files.value = files.join('\n');
      autoResize(el.files);
      const selMsg = `${files.length} file(s) selected.`;
      logTranscribe(selMsg);
      el.summary.textContent = selMsg;

      const grid = prepareFileInfoGrid('transcribe');
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

      setupResizableGrid(grid, 'gridCols-transcribe');
    } else {
      el.files.value = '';
      autoResize(el.files);
      resetFileInfoGrid('transcribe', 'gridCols-transcribe');
    }
  });

  el.outputSelect?.addEventListener('click', async () => {
    const folder = await ipc.selectFolder?.();
    if (folder) el.outputPath.value = folder;
  });

el.startBtn?.addEventListener('click', async () => {
  const config = gatherConfig();
  const isWatchMode = document.getElementById('transcribe-watch-mode')?.checked;
  if (isWatchMode) {
    await watchUtils.startWatch('transcribe', config);
    setTranscribeControlsDisabled(true);
    el.cancelBtn.disabled = false;
    return;
  }

  if (!config.files.length) {
    alert('Please select file(s) to transcribe.');
    return;
  }
  if (!config.outputPath) {
    alert('Please select an output folder.');
    return;
  }
  if (!Object.values(config.outputFormats).some(v => v)) {
    alert('Please select at least one output format.');
    return;
  }
  if (config.outputFormats.burnIn && config.fileHandling.embedMetadata) {
    const proceed = confirm('Burn-in and Embed Metadata selected together may conflict. Continue?');
    if (!proceed) return;
  }

  const summary = `Engine: ${config.engine}\nLanguage: ${config.language}\nOutputs: ${Object.keys(config.outputFormats).filter(k=>config.outputFormats[k]).join(', ')}\nFiles: ${config.files.length}`;  const confirmRun = confirm(summary + '\n\nStart transcription?');
  if (!confirmRun) return;

  setTranscribeControlsDisabled(true);
  el.cancelBtn.disabled = false;

  const queueMsg = '🚀 Queuing transcription...';
  logTranscribe(queueMsg);
  el.summary.textContent = queueMsg;
  if (el.liveOutput) el.liveOutput.textContent = '';

  try {
    currentJobId = await ipc.invoke('queue-add-transcribe', { config });
    const queuedMsg = '🗳️ Transcription job queued.';
    logTranscribe(queuedMsg);
    el.summary.textContent = queuedMsg;
  } catch (err) {
    const errMsg = `❌ Queue error: ${err.message}`;
    logTranscribe(errMsg, { isError: true });
    el.summary.textContent = errMsg;
  }
});



  function resetTranscribeFields() {
    // 1) Clear text inputs & checkboxes, but don't smash styled selects.
    document.querySelectorAll('#transcribe input, #transcribe textarea').forEach(elem => {
      if (elem.type === 'checkbox') elem.checked = false;
      else elem.value = '';
    });

    // 2) Restore single dropdowns to saved defaults (same logic as init)
    const savedModel  = localStorage.getItem('preferred-ai-model') || 'lead';
    const savedLang   = localStorage.getItem('preferred-transcribe-language') || 'en';
    const savedAcc    = localStorage.getItem('preferred-accuracy-mode') || 'auto';
    let savedConf     = '90';
    try {
      const prefsPath = window.electron.resolvePath('config', 'state.json');
      const raw = window.electron.readTextFile(prefsPath);
      const prefs = JSON.parse(raw);
      if (prefs?.preferences?.confidenceThreshold) {
        savedConf = String(prefs.preferences.confidenceThreshold);
      }
    } catch {}

    setDropdownValue('transcribe-engine', savedModel);
    setDropdownValue('transcribe-language', savedLang);
    setDropdownValue('transcribe-accuracy-mode', savedAcc);
    setDropdownValue('transcribe-confidence', savedConf);
    setDropdownValue('translate-target', localStorage.getItem('preferred-translate-target') || 'en');
    setDropdownValue('transcribe-timecode-style', 'ndf');
    const tcSel = document.getElementById('transcribe-timecode-style');
    if (tcSel) tcSel.dispatchEvent(new Event('change'));

    // 3) Reset single format selector
    setDropdownValue('transcribe-output-formats', 'txt');
    const formatSel = document.getElementById('transcribe-output-formats');
    if (formatSel) {
      formatSel.value = 'txt';
      formatSel.dispatchEvent(new Event('change'));
    }

    // 4) Reset file list UI & progress text
    autoResize(el.files);
    const noFileMsg = 'No file loaded.';
    logTranscribe(noFileMsg, { isError: true });
    el.summary.textContent = noFileMsg;
    resetFileInfoGrid('transcribe', 'gridCols-transcribe');
    el.cancelBtn.disabled = true;

    // 5) Clear logs and inline status
    logTranscribe('', { detail: 'clear' });
    const summary = document.getElementById('transcribe-summary');
    if (summary) summary.textContent = '';
    toggleTranscribing(false);

    // 6) Make sure engine-specific disables and timecode dependencies are up-to-date
    updateDisabledOutputFormats();

    // 7) Refresh the sample preview with clean state
    // (initSamplePreview has internal guards; calling it is safe)
    try { initSamplePreview(); } catch {}
  }

  el.resetBtn?.addEventListener('click', resetTranscribeFields);

  el.saveConfig?.addEventListener('click', async () => {
    const cfg = gatherConfig();
    delete cfg.files;
    const file = await ipc.saveFile({
      title: 'Save Preset',
      defaultPath: window.electron.joinPath(presetDir, 'transcribe-config.json')
    });
    if (file) {
      ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
      ipc.send('preset-saved', 'transcribe');
      refreshPresetDropdown();
      alert('Config saved.');
    }
  });

  el.loadConfig?.addEventListener('click', async () => {
    const file = await ipc.openFile({ title: 'Load Preset' });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      applyTranscribePreset(data);
    } catch (err) {
      alert('Failed to load config: ' + err.message);
    }
  });

  el.cancelBtn?.addEventListener('click', async () => {
    if (el.cancelBtn.textContent.includes('Stop Watching')) {
      await watchUtils.stopWatch('transcribe');
      const stopMsg = '🛑 Watch Mode stopped.';
      logTranscribe(stopMsg);
      el.summary.textContent = stopMsg;
      el.startBtn.disabled = false;
      el.cancelBtn.disabled = true;
      el.startBtn.textContent = 'Start';
      el.cancelBtn.textContent = 'Cancel';
      el.watchMode.checked = false;
      setTranscribeControlsDisabled(false);
      return;
    }

    const cancelMsg = '⛔ Cancel requested...';
    logTranscribe(cancelMsg);
    el.summary.textContent = cancelMsg;
    try {
      await ipc.invoke('queue-cancel-job', currentJobId);
      currentJobId = null;
      resetTranscribeFields();
    } catch (err) {
      const cancelErr = `❌ Cancel error: ${err.message}`;
      logTranscribe(cancelErr, { isError: true });
      el.summary.textContent = cancelErr;
    }
    el.cancelBtn.disabled = true;
  });

  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('queue-job-start', (_e, job) => {
      if (job.panel !== 'transcribe') return;
      toggleTranscribing(true);
    });
    // Route logs only to the Log Viewer; do NOT print them in the live transcript box.
    ipc.on('watch-log', (_e, msg) => {
      logTranscribe(msg);
    });
    ipc.on('transcribe-log-message', (_e, { msg }) => {
      logTranscribe(msg);
    });
    ipc.on('live-transcript-line', (_e, line) => {
      appendLiveTranscript(line);
    });
    ipc.on('queue-job-progress', (_e, payload) => {
      if (payload.panel !== 'transcribe') return;
      const panel = document.getElementById('transcribe');
      if (!panel || panel.classList.contains('hidden')) return;
      // Indeterminate progress: keep inline loader visible
      toggleTranscribing(true);
    });
    ipc.on('queue-job-complete', async (_e, job) => {
      if (job.panel !== 'transcribe') return;
      currentJobId = null;
      if (!el.watchMode?.checked) {
        setTranscribeControlsDisabled(false);
      }
      toggleTranscribing(false);
      resetTranscribeFields();
      const auto = document.getElementById('transcribe-send-subtitle')?.checked;
      if (!auto) return;

      try {
        const payload = {
          outputPath: job?.config?.outputPath,
          baseName: job?.config?.fileNameTemplate,
          mediaPath: Array.isArray(job?.config?.files) ? job.config.files[0] : undefined
        };
        const guess = typeof ipc.invoke === 'function'
          ? await ipc.invoke('subtitle-editor-find-latest', payload)
          : null;
        if (!guess) return;

        if (typeof guess === 'string') {
          await window.subtitleEditor?.open({ sourcePath: guess, mediaPath: payload.mediaPath });
        } else if (guess?.sourcePath) {
          const extra = { mediaPath: payload.mediaPath };
          // Proper object spread keeps guess fields intact while adding media context
          await window.subtitleEditor?.open({ ...guess, ...extra });
        }
      } catch (err) {
        console.error('Failed to auto-open subtitle editor window:', err);
      }
    });
    ipc.on('queue-job-failed', (_e, job) => {
      if (job.panel !== 'transcribe') return;
      currentJobId = null;
      if (!el.watchMode?.checked) {
        setTranscribeControlsDisabled(false);
      }
      toggleTranscribing(false);
    });
    ipc.on('queue-job-cancelled', (_e, job) => {
      if (job.panel !== 'transcribe') return;
      currentJobId = null;
      if (!el.watchMode?.checked) {
        setTranscribeControlsDisabled(false);
      }
      toggleTranscribing(false);
      resetTranscribeFields();
    });
    ipc.on('transcribe-discrepancies', (_e, discrepancies) => {
      const start = () => window.reconcileDiscrepancies(discrepancies);
      if (typeof window.reconcileDiscrepancies === 'function') {
        start();
      } else {
        loadPanelScript('reconcile');
        window.addEventListener('reconcile-ready', start, { once: true });
      }
    });
    // Preview updates are now appended directly to the live output
  }

document.addEventListener('DOMContentLoaded', () => {
  try { _attachSubtitlePopoutButton(); } catch {}
});

// ─── Transcribe: engine settings tooltip ───────────────────────────────────
const engineSettingsTooltip = document.querySelector('#transcribe #transcribe-engine-tooltip');
if (engineSettingsTooltip && !engineSettingsTooltip.dataset.bound) {
  engineSettingsTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">ENGINE SETTINGS</div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li><strong>WhisperX</strong> - Intended for detailed timings and stable output.</li>
          <li><strong>WhisperAPI</strong> - Intended for workflows built around an external API/service for transcription and translation, so you can reuse an existing ASR provider.</li>
          <li><strong>Lead AI</strong> - Lead AE's built-in engine; very fast and the backup default.</li>
        </ul>
      </div>
    </div>
  `;
  engineSettingsTooltip.dataset.bound = 'true';
}

// ─── Transcribe: panel overview tooltip ───────────────────────────────────
const transcribeOverview = document.querySelector('#transcribe #transcribe-overview-tooltip');
if (transcribeOverview && !transcribeOverview.dataset.bound) {
  transcribeOverview.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">TRANSCRIBE PANEL OVERVIEW</div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">What this panel is for</span>
        <ul class="tooltip-list">
          <li>Batch-transcribe audio and video files into text.</li>
          <li>Create transcripts or caption files in multiple formats.</li>
          <li>Send results into the Subtitle Editor for cleanup or review.</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Quick workflow</span>
        <ul class="tooltip-list">
          <li><strong>Input</strong> - choose the media files to transcribe.</li>
          <li><strong>Engine & Language</strong> - pick the engine and the language you want to force.</li>
          <li><strong>Output format</strong> - select captions/transcript formats and adjust per-format options.</li>
          <li><strong>Run</strong> - start the job and optionally open the results in the Subtitle Editor.</li>
        </ul>
      </div>
    </div>
  `;
  transcribeOverview.dataset.bound = 'true';
}

if (typeof module !== 'undefined') {
  module.exports = { gatherConfig, isWatchConfigValid, applyTranscribePreset, refreshPresetDropdown };
}

})();
