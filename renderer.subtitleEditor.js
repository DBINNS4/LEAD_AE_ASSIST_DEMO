(() => {
  // Lightweight format detector for SCC-mode behaviors
  function isSccDoc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'scc' || kind === 'cea608' || kind === '608') return true;
    const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
    return src.endsWith('.scc');
  }

  function _getDocStartTimecodeLabel(doc) {
    if (!doc) return null;
    const raw =
      doc.startTc ||
      doc.startTC ||
      doc?.metadata?.startTimecode ||
      doc?.metadata?.startTc ||
      null;
    const s = (typeof raw === 'string') ? raw.trim() : '';
    return s || null;
  }

  function _getDocTimecodeOffsetSeconds(doc) {
    // Start TC is an offset that maps media time (t=0) to a SMPTE label (common for broadcast deliverables).
    // For SCC, we keep cues in 0-based seconds and store the base TC in doc.startTc so preview + export line up.
    if (!doc) return 0;
    if (doc.keepAbsoluteTimecode === true) return 0;
    const tc = _getDocStartTimecodeLabel(doc);
    if (!tc) return 0;

    const fps = Number(doc?.fps) || 30;
    const drop = !!doc?.dropFrame;

    try {
      const ms = window.transcribeEngine?.parseTime?.(tc, fps, drop ? true : null);
      const sec = (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
      return Number.isFinite(sec) ? sec : 0;
    } catch {
      return 0;
    }
  }

  // Decide if this document should use SMPTE timecode display (HH:MM:SS:FF)
  function usesSmpteTimecode(doc) {
    if (!doc) return false;
    if (isSccDoc(doc)) return true; // SCC is always SMPTE-style
    // Also use SMPTE if the doc carries an explicit Start TC offset (common for broadcast deliverables).
    return !!_getDocStartTimecodeLabel(doc);
  }

  // Keep the preview frame sized to the actual video so overlays stay aligned.
  function bindVideoAspectToFrame(videoEl, hostEl) {
    if (!videoEl || !hostEl) return;
    const apply = () => {
      const w = videoEl.videoWidth || 1920;
      const h = videoEl.videoHeight || 1080;
      hostEl.style.setProperty('--video-aspect', `${w} / ${h}`);
    };
    if (videoEl.readyState >= 1) apply();
    videoEl.addEventListener('loadedmetadata', apply, { once: true });
  }

  const overlayId = 'subtitle-editor-overlay';
  const isPopout = new URLSearchParams(location.search).get('win') === 'subtitle-editor';

  // In pop-out subtitle editor windows, ensure body class is applied even if the
  // transcribe renderer script fails to initialize in time.
  if (isPopout) {
    document.body.classList.add('subtitle-editor-window');
  }

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  // Always ensure the overlay exists so this module installs its API.
  let overlay = document.getElementById(overlayId);
  if (isPopout) {
    if (overlay && overlay.closest('#window-content')) {
      try {
        overlay.parentElement.removeChild(overlay);
        document.body.appendChild(overlay);
      } catch {}
    }
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'subtitle-editor hidden';
    // If pop-out, mount directly to body so it isn't hidden by #window-content styles
    const mount = (isPopout ? document.body : (document.getElementById('window-content') || document.body));
    mount.appendChild(overlay);
  }

  overlay.tabIndex = -1;

  const state = {
    doc: null,
    activeCue: -1,
    lastExport: null
  };

  let uiBuilt = false;
  let toolbarTitle;
  let toolbarMeta;
  let statusEl;
  let cuesContainer;
  let videoEl;
  let previewHostEl;
  let scrubEl;
  let durationEl;
  let currentTimeEl;
  let closeBtn;
  let insertCueBtn;
  let deleteCueBtn;
  // WebVTT/TextTrack preview path removed. Custom 608 overlay is authoritative.

  // ------------------------------------------------------------
  // SCC Glyph Picker (CEA-608 extended glyphs)
  // ------------------------------------------------------------
  let glyphModalEl = null;
  let glyphData = null; // { groups: {...} }

  function ensureGlyphPickerCSS() {
    if (document.getElementById('scc-glyph-picker-style')) return;
    const style = document.createElement('style');
    style.id = 'scc-glyph-picker-style';
    style.textContent = `
      .glyph-modal {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,.55);
        z-index: 9999;
      }
      .glyph-modal .panel {
        width: min(860px, calc(100vw - 40px));
        max-height: min(720px, calc(100vh - 40px));
        background: #1b1b1b;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        box-shadow: 0 18px 60px rgba(0,0,0,.55);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .glyph-modal .header {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,.10);
      }
      .glyph-modal .header strong { color: #fff; font-size: 14px; }
      .glyph-modal .header .spacer { flex: 1; }
      .glyph-modal input[type="search"] {
        width: 280px;
        max-width: 46vw;
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 10px;
        padding: 8px 10px;
        outline: none;
      }
      .glyph-modal .tabs {
        display: flex;
        gap: 8px;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255,255,255,.10);
        flex-wrap: wrap;
      }
      .glyph-modal .tab {
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 999px;
        padding: 6px 10px;
        cursor: pointer;
        user-select: none;
        font-size: 12px;
      }
      .glyph-modal .tab.active {
        background: rgba(255,255,255,.16);
      }
      .glyph-modal .body {
        padding: 12px 14px 14px;
        overflow: auto;
      }
      .glyph-modal .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
        gap: 10px;
      }
      .glyph-modal .glyph {
        height: 44px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        color: #fff;
        font-size: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .glyph-modal .glyph:hover {
        background: rgba(255,255,255,.12);
      }
      .glyph-modal .footer {
        padding: 10px 14px;
        border-top: 1px solid rgba(255,255,255,.10);
        display: flex;
        justify-content: space-between;
        color: rgba(255,255,255,.7);
        font-size: 12px;
      }
      .glyph-modal .close {
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 10px;
        padding: 7px 10px;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  async function fetchGlyphsIfNeeded() {
    if (glyphData) return glyphData;
    if (!ipc?.invoke) return null;
    try {
      const resp = await ipc.invoke('subtitle-editor-get-scc-glyphs');
      if (!resp || resp.error || resp.ok === false) {
        setStatus(resp?.error || 'Failed to load SCC glyphs.', true);
        return null;
      }
      glyphData = resp;
      return glyphData;
    } catch (err) {
      setStatus(`Failed to load SCC glyphs: ${err.message}`, true);
      return null;
    }
  }

  function findActiveCueTextarea() {
    // Prefer focused textarea, fallback to active row.
    const focused = document.activeElement;
    if (focused && focused.tagName === 'TEXTAREA') return focused;
    return overlay.querySelector('.cue.active textarea') || null;
  }

  function insertAtCaret(textarea, valueToInsert) {
    if (!textarea) return false;
    const v = String(textarea.value ?? '');
    const ins = String(valueToInsert ?? '');
    const start = Number(textarea.selectionStart ?? v.length);
    const end = Number(textarea.selectionEnd ?? v.length);
    const next = v.slice(0, start) + ins + v.slice(end);
    textarea.value = next;

    // Restore caret after insertion
    const caret = start + ins.length;
    try {
      textarea.setSelectionRange(caret, caret);
    } catch {}

    // Route through existing editor update pipeline:
    const row = textarea.closest('.cue');
    const idx = row ? parseInt(row.dataset.index || '-1', 10) : -1;
    if (Number.isInteger(idx) && idx >= 0) {
      try { autoSizeTextarea(textarea); } catch {}
      try { updateCueText(idx, textarea.value); } catch {}
      try { renderActiveCue608(); } catch {}
    }
    return true;
  }

  function closeGlyphPicker() {
    if (!glyphModalEl) return;
    try { glyphModalEl.remove(); } catch {}
    glyphModalEl = null;
  }

  function openGlyphPicker() {
    if (!isSccDoc(state.doc)) return;
    ensureGlyphPickerCSS();
    if (glyphModalEl) return;

    glyphModalEl = document.createElement('div');
    glyphModalEl.className = 'glyph-modal';
    glyphModalEl.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" aria-label="CEA-608 Glyph Picker">
        <div class="header">
          <strong>CEA-608 Glyphs</strong>
          <div class="spacer"></div>
          <input type="search" id="glyph-search" placeholder="Search glyph…" />
          <button type="button" class="close" id="glyph-close">Close</button>
        </div>
        <div class="tabs" id="glyph-tabs"></div>
        <div class="body">
          <div class="grid" id="glyph-grid"></div>
        </div>
        <div class="footer">
          <span id="glyph-count"></span>
          <span>Click a glyph to insert into the active caption line</span>
        </div>
      </div>
    `;

    // click outside closes
    glyphModalEl.addEventListener('mousedown', (e) => {
      if (e.target === glyphModalEl) closeGlyphPicker();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && glyphModalEl) {
        e.preventDefault();
        closeGlyphPicker();
        document.removeEventListener('keydown', onEsc, true);
      }
    }, true);

    document.body.appendChild(glyphModalEl);

    // Populate once we have glyph data
    (async () => {
      const data = await fetchGlyphsIfNeeded();
      if (!data?.groups) {
        closeGlyphPicker();
        return;
      }

      const tabsEl = glyphModalEl.querySelector('#glyph-tabs');
      const gridEl = glyphModalEl.querySelector('#glyph-grid');
      const searchEl = glyphModalEl.querySelector('#glyph-search');
      const closeEl = glyphModalEl.querySelector('#glyph-close');
      const countEl = glyphModalEl.querySelector('#glyph-count');

      closeEl?.addEventListener('click', () => closeGlyphPicker());

      const tabDefs = [
        { key: 'specialNorthAmerican', label: 'Special NA' },
        { key: 'extendedWesternEuropean1', label: 'Extended WE 1' },
        { key: 'extendedWesternEuropean2', label: 'Extended WE 2' },
        { key: 'other', label: 'Other' },
        { key: 'all', label: 'All' }
      ];

      let activeTab = 'all';
      let query = '';

      const render = () => {
        const groups = data.groups || {};
        let list = [];
        if (activeTab === 'all') {
          list = []
            .concat(groups.specialNorthAmerican || [])
            .concat(groups.extendedWesternEuropean1 || [])
            .concat(groups.extendedWesternEuropean2 || [])
            .concat(groups.other || []);
        } else {
          list = (groups[activeTab] || []).slice();
        }

        if (query) {
          const q = query.toLowerCase();
          list = list.filter(g => String(g).toLowerCase().includes(q));
        }

        // Tabs
        tabsEl.innerHTML = '';
        tabDefs.forEach(t => {
          const b = document.createElement('div');
          b.className = 'tab' + (t.key === activeTab ? ' active' : '');
          b.textContent = t.label;
          b.addEventListener('click', () => {
            activeTab = t.key;
            render();
          });
          tabsEl.appendChild(b);
        });

        // Grid
        gridEl.innerHTML = '';
        list.forEach(g => {
          const btn = document.createElement('div');
          btn.className = 'glyph';
          btn.title = `Insert "${g}"`;
          btn.textContent = g;
          btn.addEventListener('click', () => {
            const ta = findActiveCueTextarea();
            if (!ta) {
              setStatus('Click into a caption text field, then insert a glyph.', true);
              return;
            }
            insertAtCaret(ta, g);
            // Keep modal open for rapid insertion (pro workflow)
            try { ta.focus(); } catch {}
          });
          gridEl.appendChild(btn);
        });

        if (countEl) countEl.textContent = `${list.length} glyph${list.length === 1 ? '' : 's'}`;
      };

      searchEl?.addEventListener('input', () => {
        query = String(searchEl.value || '').trim();
        render();
      });

      // initial paint
      render();
      try { searchEl?.focus(); } catch {}
    })();
  }


  // ------------------------------------------------------------
  // Start TC modal (SMPTE timecode offset for SCC preview/export)
  // ------------------------------------------------------------
  let startTcModalEl = null;

  function ensureStartTcModalCSS() {
    if (document.getElementById('smpte-start-tc-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'smpte-start-tc-modal-style';
    style.textContent = `
      .tc-modal {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,.55);
        z-index: 9999;
      }
      .tc-modal .panel {
        width: min(560px, calc(100vw - 40px));
        background: #1b1b1b;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        box-shadow: 0 18px 60px rgba(0,0,0,.55);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .tc-modal .header {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,.10);
      }
      .tc-modal .header strong { color: #fff; font-size: 14px; }
      .tc-modal .header .spacer { flex: 1; }
      .tc-modal .close {
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 10px;
        padding: 7px 10px;
        cursor: pointer;
      }
      .tc-modal .body {
        padding: 14px;
        color: rgba(255,255,255,.86);
        font-size: 13px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .tc-modal .body p { margin: 0; line-height: 1.35; }
      .tc-modal .row {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 10px;
        align-items: center;
      }
      .tc-modal label { color: rgba(255,255,255,.8); font-size: 12px; }
      .tc-modal input[type="text"] {
        width: 100%;
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 10px;
        padding: 10px 12px;
        outline: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      .tc-modal .hint {
        color: rgba(255,255,255,.65);
        font-size: 12px;
      }
      .tc-modal .error {
        color: #ff6b6b;
        font-size: 12px;
      }
      .tc-modal .footer {
        padding: 12px 14px;
        border-top: 1px solid rgba(255,255,255,.10);
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      .tc-modal .btn {
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        color: #fff;
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
      }
      .tc-modal .btn.primary {
        background: rgba(255,255,255,.18);
      }
    `;
    document.head.appendChild(style);
  }

  function refreshToolbarMetaForDoc(doc) {
    if (!toolbarMeta || !doc) return;
    const scc = isSccDoc(doc);
    const metaParts = [];
    if (doc.fps) metaParts.push(`${doc.fps} fps`);
    if (typeof doc.dropFrame === 'boolean') metaParts.push(doc.dropFrame ? 'DF' : 'NDF');
    if (scc) metaParts.push('SCC');
    if (Array.isArray(doc.cues)) metaParts.push(`${doc.cues.length} ${scc ? 'blocks' : 'cues'}`);
    const startTcLabel = _getDocStartTimecodeLabel(doc);
    if (startTcLabel) metaParts.push(`Start TC ${startTcLabel}`);
    toolbarMeta.textContent = metaParts.join(' • ');
  }

  function closeStartTcModal() {
    if (!startTcModalEl) return;
    try { startTcModalEl.remove(); } catch {}
    startTcModalEl = null;
  }

  function openStartTcModal() {
    if (!state.doc) return;
    ensureStartTcModalCSS();
    if (startTcModalEl) return;

    const doc = state.doc;
    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;
    const sep = drop ? ';' : ':';
    const current = _getDocStartTimecodeLabel(doc) || (drop ? '01:00:00;00' : '01:00:00:00');
    const includeSpeakerNamesScc = !!doc?.sccOptions?.includeSpeakerNames;

    startTcModalEl = document.createElement('div');
    startTcModalEl.className = 'tc-modal';
    startTcModalEl.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" aria-label="Start Timecode">
        <div class="header">
          <strong>Start Timecode</strong>
          <div class="spacer"></div>
          <button type="button" class="close" id="tc-close">Close</button>
        </div>
        <div class="body">
          <p>
            This maps <strong>media time 0</strong> to a SMPTE timecode label. It affects the timecode you see in the editor
            and the timecodes written when exporting SCC. It does <em>not</em> move cues.
          </p>
          <div class="row">
            <label for="tc-input">Start TC</label>
            <input type="text" id="tc-input" placeholder="${drop ? '01:00:00;00' : '01:00:00:00'}" />
          </div>
          <div class="row">
            <label for="tc-include-speakers">Speakers</label>
            <div>
              <label class="checkbox-label" style="display:flex;align-items:center;gap:8px;">
                <input id="tc-include-speakers" type="checkbox" ${includeSpeakerNamesScc ? 'checked' : ''} />
                Include speaker names in SCC export (e.g., “JOHN: …”)
              </label>
              <div style="opacity:0.75;font-size:12px;margin-top:6px;">
                Off by default. Some QC specs reject speaker labels in 608 captions.
              </div>
            </div>
          </div>
          <div class="hint">Expected: HH:MM:SS${sep}FF • ${drop ? 'Drop-frame' : 'Non-drop-frame'} • ${fps} fps</div>
          <div class="error" id="tc-error" style="display:none"></div>
        </div>
        <div class="footer">
          <button type="button" class="btn" id="tc-cancel">Cancel</button>
          <button type="button" class="btn primary" id="tc-save">Save</button>
        </div>
      </div>
    `;

    // click outside closes
    startTcModalEl.addEventListener('mousedown', (e) => {
      if (e.target === startTcModalEl) closeStartTcModal();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && startTcModalEl) {
        e.preventDefault();
        closeStartTcModal();
        document.removeEventListener('keydown', onEsc, true);
      }
    }, true);

    document.body.appendChild(startTcModalEl);

    const inputEl = startTcModalEl.querySelector('#tc-input');
    const closeEl = startTcModalEl.querySelector('#tc-close');
    const cancelEl = startTcModalEl.querySelector('#tc-cancel');
    const saveEl = startTcModalEl.querySelector('#tc-save');
    const errorEl = startTcModalEl.querySelector('#tc-error');

    if (inputEl) inputEl.value = current;

    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.textContent = String(msg || 'Invalid timecode.');
      errorEl.style.display = '';
    };
    const clearError = () => {
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    };

    const onSave = () => {
      clearError();
      const raw = String(inputEl?.value || '').trim();
      const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
      if (!m) {
        showError(`Use HH:MM:SS${sep}FF (example: ${drop ? '01:00:00;00' : '01:00:00:00'}).`);
        return;
      }
      const normalized = `${m[1]}${sep}${m[2]}`;

      try {
        // Validate parseability with the engine parser (drop-frame legality included).
        const ms = window.transcribeEngine?.parseTime?.(normalized, fps, drop ? true : null);
        if (typeof ms !== 'number' || Number.isNaN(ms)) throw new Error('Invalid timecode');
      } catch (e) {
        showError(e?.message || 'Invalid timecode.');
        return;
      }

      doc.startTc = normalized;
      doc.startTC = normalized;
      // Persist SCC speaker label preference per document.
      const includeSpk = !!startTcModalEl?.querySelector('#tc-include-speakers')?.checked;
      doc.sccOptions = { ...(doc.sccOptions || {}), includeSpeakerNames: includeSpk };
      doc.metadata = doc.metadata || {};
      doc.metadata.startTimecode = normalized;

      // Keep SCC options in sync for export helpers.
      if (doc.sccOptions) {
        doc.sccOptions = { ...doc.sccOptions, startTc: normalized, startTC: normalized };
      } else if (isSccDoc(doc)) {
        doc.sccOptions = { startTc: normalized, startTC: normalized };
      }

      refreshToolbarMetaForDoc(doc);

      // Re-render times without reloading media.
      try { renderCues(doc.cues || []); } catch {}
      try {
        const t = Number(videoEl?.currentTime) || 0;
        if (currentTimeEl) currentTimeEl.textContent = formatSeconds(t);
        const dur = Number(videoEl?.duration);
        if (durationEl && Number.isFinite(dur) && !Number.isNaN(dur)) {
          durationEl.textContent = formatSeconds(dur);
        }
      } catch {}

      closeStartTcModal();
      setStatus('Start TC updated.');
    };

    closeEl?.addEventListener('click', () => closeStartTcModal());
    cancelEl?.addEventListener('click', () => closeStartTcModal());
    saveEl?.addEventListener('click', () => onSave());
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    });

    try { inputEl?.focus(); inputEl?.select?.(); } catch {}
  }

  function buildUI() {
    if (uiBuilt) return;
    overlay.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-info">
          <strong id="subtitle-editor-title"></strong>
          <span id="subtitle-editor-meta"></span>
        </div>
        <div class="toolbar-actions">
          <button type="button" id="subtitle-editor-open-sub">Open&nbsp;Subtitle…</button>
          <button type="button" id="subtitle-editor-open-media">Open&nbsp;Media…</button>
          <button type="button" id="subtitle-editor-insert-cue">Insert&nbsp;Caption</button>
          <button type="button" id="subtitle-editor-delete-cue">Delete&nbsp;Caption</button>
          <button type="button" id="subtitle-editor-close">Close</button>
        </div>
        <div class="toolbar-toggles">
          <label class="checkbox-label">
            <input type="checkbox" id="toggle-guides" checked />
            Show title-safe grid (rows 12–15)
          </label>
          <label class="checkbox-label" style="margin-left:.75rem;">
            <input type="checkbox" id="toggle-inspector" checked />
            Row/indent inspector
          </label>
          <label class="checkbox-label" style="margin-left:.75rem;">
            <input type="checkbox" id="toggle-click-place" />
            Click‑to‑place (rows/cols)
          </label>
        </div>
      </div>
      <div class="main">
        <div class="preview">
          <video id="subtitle-editor-video" controls></video>
          <input id="subtitle-editor-scrub" type="range" min="0" max="0" step="0.01" value="0" />
          <div class="time-display">
            <span id="subtitle-editor-current">00:00:00.000</span>
            <span> / </span>
            <span id="subtitle-editor-duration">00:00:00.000</span>
          </div>
        </div>
        <div class="cue-list" id="subtitle-editor-cue-list" tabindex="0"></div>
      </div>
      <div class="status-row">
        <span id="subtitle-editor-status"></span>
      </div>
    `;

    toolbarTitle = overlay.querySelector('#subtitle-editor-title');
    toolbarMeta = overlay.querySelector('#subtitle-editor-meta');
    statusEl = overlay.querySelector('#subtitle-editor-status');
    cuesContainer = overlay.querySelector('#subtitle-editor-cue-list');
    videoEl = overlay.querySelector('#subtitle-editor-video');
    scrubEl = overlay.querySelector('#subtitle-editor-scrub');
    durationEl = overlay.querySelector('#subtitle-editor-duration');
    currentTimeEl = overlay.querySelector('#subtitle-editor-current');
    closeBtn = overlay.querySelector('#subtitle-editor-close');
    insertCueBtn = overlay.querySelector('#subtitle-editor-insert-cue');
    deleteCueBtn = overlay.querySelector('#subtitle-editor-delete-cue');
    const openSubBtn = overlay.querySelector('#subtitle-editor-open-sub');
    const openMediaBtn = overlay.querySelector('#subtitle-editor-open-media');
    const guidesToggle = overlay.querySelector('#toggle-guides');
    const inspToggle = overlay.querySelector('#toggle-inspector');
    const clickPlaceToggle = overlay.querySelector('#toggle-click-place');

    closeBtn?.addEventListener('click', () => hideEditor());
    openSubBtn?.addEventListener('click', () => pickSubtitleAndLoad());
    openMediaBtn?.addEventListener('click', () => pickMediaAndLoad());
    insertCueBtn?.addEventListener('click', () => {
      if (!state.doc?.cues?.length) return;

      const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;
      const cues = state.doc.cues;
      if (!cues[activeIndex]) return;

      const time =
        (typeof videoEl?.currentTime === 'number')
          ? videoEl.currentTime
          : (Number(cues[activeIndex].start) || 0);

      splitCue(activeIndex, time);
    });

    deleteCueBtn?.addEventListener('click', () => {
      if (!state.doc?.cues?.length) return;
      const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;
      deleteCue(activeIndex);
    });

    videoEl?.addEventListener('timeupdate', () => {
      if (!videoEl?.duration || Number.isNaN(videoEl.duration)) return;
      const t = videoEl.currentTime || 0;
      currentTimeEl.textContent = formatSeconds(t);
      scrubEl.value = t.toFixed(2);
      highlightCueForTime(t);
      // Keep the custom 608 overlay in sync with playback
      renderActiveCue608();
    });

    videoEl?.addEventListener('loadedmetadata', () => {
      const duration = videoEl?.duration;
      if (typeof duration === 'number' && !Number.isNaN(duration)) {
        scrubEl.max = duration.toFixed(2);
        durationEl.textContent = formatSeconds(duration);
      }
      // Keep the safe-title grid in the right place after the video’s size is known.
      try { window.__editorSafe?.rebuild?.(); } catch {}
    });
    videoEl?.addEventListener('error', () => {
      setStatus('This media cannot be decoded by the browser. Use “Open Media…” or let the editor create a preview.');
    });

    scrubEl?.addEventListener('input', () => {
      if (!videoEl) return;
      const value = parseFloat(scrubEl.value || '0');
      if (!Number.isNaN(value)) {
        videoEl.currentTime = value;
      }
    });

    // Wire up toolbar toggles
    guidesToggle?.addEventListener('change', (e) => {
      window.__editorSafe?.setGuidesVisible?.(!!e.target.checked);
    });
    inspToggle?.addEventListener('change', (e) => {
      window.__editorSafe?.toggleInspector?.(!!e.target.checked);
    });
    clickPlaceToggle?.addEventListener('change', () => {
      window.__editorSafe?.setPlacementEnabled?.(!!clickPlaceToggle.checked);
    });

    overlay.addEventListener('keydown', handleHotkeys, true);
    cuesContainer?.addEventListener('click', onCueClick);

    uiBuilt = true;
    try { injectEditorToolbarButtons(); } catch {}
    try { installEditorSafeOverlay(); } catch {}

    // Apply initial toggle states to the controller
    try {
      window.__editorSafe?.setGuidesVisible?.(!!guidesToggle?.checked);
      window.__editorSafe?.toggleInspector?.(!!inspToggle?.checked);
      window.__editorSafe?.setPlacementEnabled?.(!!clickPlaceToggle?.checked);
    } catch {}
  }

  function updateFormatButtonsForDoc(doc) {
    const scc = isSccDoc(doc);
    const overlay = document.getElementById('subtitle-editor-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.btn-scc-only').forEach(b => { b.style.display = scc ? '' : 'none'; });
    overlay.querySelectorAll('.btn-nonscc-only').forEach(b => { b.style.display = scc ? 'none' : ''; });
    // In SCC mode the user’s mental model is “I am exporting SCC / burn-in”, not “corrections”.
  }

  // --- helpers --------------------------------------------------------------
  function autoSizeTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 40)}px`;
  }

  function renderActiveCue608() {
    const cues = state.doc?.cues;
    const idx  = state.activeCue;
    let cue    = (cues && idx != null && idx >= 0 && idx < cues.length)
      ? cues[idx]
      : null;

    // Non‑SCC: just render the cue as-is.
    if (!isSccDoc(state.doc) || !cue || !Array.isArray(cues)) {
      try { window.__editorSafe?.render608?.(cue || null); } catch {}
      return;
    }

    // SCC: reconstruct the full 608 pop‑on "block" by grouping cues that share
    // the same start/end (within ~1 frame). Many pipelines split each text row
    // into its own cue even though on-air it's one caption.
    const start = Number(cue.start) || 0;
    const end   = Number(cue.end)   || 0;
    const frameTol = 1 / 30; // ~33 ms tolerance

    const block = [cue];

    // Walk backwards for earlier rows with matching timing.
    for (let i = idx - 1; i >= 0; i--) {
      const c = cues[i];
      if (!c) break;
      const cs = Number(c.start) || 0;
      const ce = Number(c.end)   || 0;
      if (Math.abs(cs - start) <= frameTol && Math.abs(ce - end) <= frameTol) {
        block.unshift(c);
      } else if (ce < start - frameTol) {
        // Once we're clearly before this block, stop scanning.
        break;
      }
    }

    // Walk forwards for later rows with matching timing.
    for (let i = idx + 1; i < cues.length; i++) {
      const c = cues[i];
      if (!c) break;
      const cs = Number(c.start) || 0;
      const ce = Number(c.end)   || 0;
      if (Math.abs(cs - start) <= frameTol && Math.abs(ce - end) <= frameTol) {
        block.push(c);
      } else if (cs > end + frameTol) {
        // Once we're clearly after this block, stop scanning.
        break;
      }
    }

    // Build a virtual cue that contains up to two text rows plus row/col placement.
    if (block.length > 1) {
      const lines = [];
      const placements = [];

      for (const c of block) {
        const ln = Array.isArray(c.lines) && c.lines.length
          ? c.lines[0]
          : String(c.text || '');
        if (!ln) continue;

        lines.push(ln);
        let placement = null;
        const sp = c.sccPlacement;

        if (Array.isArray(sp)) {
          placement = sp[0] || null;
        } else if (sp && typeof sp === 'object') {
          // handle older object-style {0: {row, col}}
          placement = sp[0] || sp['0'] || null;
        }

        placements.push(placement);

        if (lines.length === 2) break; // 608 pop‑on is max 2 visible rows here
      }

      cue = {
        ...cue,
        lines,
        sccPlacement: placements
      };
    }

    try { window.__editorSafe?.render608?.(cue); } catch {}
  }

  function setStatus(message, isError = false) {
    if (!statusEl) {
      // Don’t silently eat errors; otherwise “nothing happens” when IPC fails.
      try {
        (isError ? console.error : console.log)(`[SubtitleEditor] ${message}`);
      } catch {}
      return;
    }
    statusEl.textContent = message || '';
    statusEl.classList.toggle('text-error', !!isError);
  }

  function hideEditor() {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    try {
      if (videoEl && !videoEl.paused) {
        videoEl.pause();
      }
    } catch {}
  }

  function showEditor() {
    overlay.classList.add('is-ready');
    overlay.classList.remove('hidden');
    overlay.removeAttribute('aria-hidden');
    overlay.focus({ preventScroll: true });
  }

  function injectEditorToolbarButtons() {
    const toolbar = overlay.querySelector('.toolbar .toolbar-actions');
    if (!toolbar || toolbar.__subtitleButtonsInjected) return;
    toolbar.__subtitleButtonsInjected = true;

    const mkBtn = (id, label, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.textContent = label;
      b.addEventListener('click', handler);
      return b;
    };

    const btnExportScc = mkBtn(
      'subtitle-editor-export-scc',
      'Export SCC',
      async () => { try { await exportSccDoc(); } catch {} }
    );
    btnExportScc.classList.add('btn-scc-only');

    const btnGlyphs = mkBtn(
      'subtitle-editor-glyphs',
      'Glyphs',
      async () => { try { openGlyphPicker(); } catch {} }
    );
    btnGlyphs.classList.add('btn-scc-only');

    const btnStartTc = mkBtn(
      'subtitle-editor-start-tc',
      'Start TC',
      () => { try { openStartTcModal(); } catch {} }
    );
    btnStartTc.classList.add('btn-scc-only');

    const btnBurnIn = mkBtn(
      'subtitle-editor-burnin',
      'Burn‑in',
      async () => { try { await burnInDoc(); } catch {} }
    );
    btnBurnIn.classList.add('btn-scc-only');

    const btnExportCorr = mkBtn(
      'subtitle-editor-export',
      'Export Corrections',
      async () => { try { await exportDoc(); } catch {} }
    );
    btnExportCorr.classList.add('btn-nonscc-only');

    toolbar.prepend(btnExportCorr);
    toolbar.prepend(btnBurnIn);
    toolbar.prepend(btnGlyphs);
    toolbar.prepend(btnStartTc);
    toolbar.prepend(btnExportScc);
  }

  async function pickSubtitleAndLoad() {
    if (typeof ipc?.invoke !== 'function') {
      setStatus('File picker unavailable in this build.', true);
      return;
    }
    const picked = await ipc.invoke('open-file-dialog', {
      title: 'Open subtitle',
      filters: [
        { name: 'Subtitles', extensions: ['json', 'srt', 'vtt', 'scc'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!picked) return;
    setStatus('Loading subtitle…');
    try {
      const response = await ipc.invoke('subtitle-editor-open', {
        sourcePath: picked,
        sessionId: state.doc?.sessionId || undefined
      });
      if (!response || response.error) {
        setStatus(response?.error || 'Failed to load subtitle.', true);
        return;
      }
      state.doc = { ...response };
      state.lastExport = response.lastExport || null;
      state.activeCue = 0;
      await populateDoc(state.doc);
      setStatus('Loaded subtitle.');
    } catch (err) {
      setStatus(`Failed to load subtitle: ${err.message}`, true);
    }
  }

  async function pickMediaAndLoad() {
    await promptForMedia();
  }

  async function promptForMedia() {
    // Electron path
    if (typeof ipc?.invoke === 'function') {
      const file = await ipc.invoke('open-file-dialog', {
        title: 'Select video for preview',
        filters: [{ name: 'Video', extensions: ['mp4','mov','m4v','mkv','webm'] }]
      });
      if (file) {
        state.doc = state.doc || {};
        state.doc.mediaPath = file;
        await loadMediaIntoPlayer(file);
        return;
      }
    }
    // Browser fallback
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: 'Video', accept: { 'video/*': ['.mp4','.mov','.m4v','.mkv','.webm'] } }]
        });
        const f = await h.getFile();
        const url = URL.createObjectURL(f);
        if (videoEl) {
          videoEl.src = url;
          videoEl.load();
        }
        setStatus('Loaded media (browser file picker).');
        return;
      } catch {}
    }
    setStatus('File picker unavailable in this build.', true);
  }

  function _toFileURL(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    return window.electron?.pathToFileURL?.(norm) || ('file://' + encodeURI(norm));
  }

  async function ensurePlayableUrl(file) {
    if (!file) return null;
    try {
      // ── Recursion guard: if it already looks like a preview, prefer to play it —
      // but if it was made with the old MPEG‑4 fallback, rebuild it now.
      const previewDir = window.electron.joinPath(window.electron.userDataPath, 'previews');
      const fileNorm = String(file).replace(/\\/g, '/');
      const prevNorm = String(previewDir).replace(/\\/g, '/');
      const looksLikePreview = fileNorm.includes(`${prevNorm}/`) || /\.preview\.[^\/\\]+$/i.test(fileNorm);
      if (looksLikePreview) {
        try {
          const info0 = await window.electron?.probeMedia?.(file);
          const v0 = (info0?.streams || []).find(s => s.codec_type === 'video');
          const badLegacy = v0 && /^(mpeg4|mp4v)/i.test(String(v0.codec_name || ''));
          if (!badLegacy) return _toFileURL(file);
          // fall through and rebuild a new preview from this legacy preview input
        } catch { /* fall through: try to rebuild */ }
      }

      const info = await window.electron?.probeMedia?.(file);
      const streams = info?.streams || [];
      const v = streams.find(s => s.codec_type === 'video');
      if (!v) {
        setStatus('Selected file has no video track. You will hear audio only.');
        return _toFileURL(file);
      }
      const codec = String(v.codec_name || '').toLowerCase();
      const pix   = String(v.pix_fmt || '').toLowerCase();

      // Browser capability sniff (Electron/Chromium build dependent)
      const canType = (mime) => {
        try {
          if (window.MediaSource && typeof window.MediaSource.isTypeSupported === 'function') {
            return !!window.MediaSource.isTypeSupported(mime);
          }
          const vid = document.createElement('video');
          return !!vid.canPlayType && vid.canPlayType(mime) !== '';
        } catch { return false; }
      };
      const canH264 = canType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      const canVP9  = canType('video/webm; codecs="vp9, opus"');

      // If the original is already known-playable to the browser, use it.
      const browserPlayable = (
        (codec === 'h264' && canH264) ||
        (codec === 'vp9'  && canVP9)  ||
        (codec === 'vp8'  && canType('video/webm; codecs="vp8, vorbis"')) ||
        (codec === 'av1'  && canType('video/mp4; codecs="av01.0.05M.08"')) // conservative av1 tag
      ) && (!pix || /^(yuv420p|nv12|p010)$/.test(pix));
      if (browserPlayable) return _toFileURL(file);

      // Fallback: create a lightweight H.264/AAC preview in userData/previews
      window.electron.mkdir(previewDir);
      // Strip any trailing ".preview" to avoid file.preview.preview.mp4
      const baseRaw = window.electron.basename(file, window.electron.extname(file));
      const base    = baseRaw.replace(/(\.preview)+$/i, '');
      let out       = window.electron.joinPath(previewDir, `${base}.preview.mp4`);
      setStatus(`Converting ${codec || 'video'} → browser‑playable preview…`);
      const ffmpegBin = window.electron.ffmpegPath();
      // Prefer H.264 hardware encoders; stay libx264‑free (LGPL compliance).
      let videoEnc = null; let useWebM = false;
      try {
        const { stdout: encodersOut = '' } =
          await window.electron.execFFmpeg(ffmpegBin, ['-hide_banner','-encoders']);
        const has = (name) => new RegExp(`(^|\\W)${name}(\\W|$)`).test(encodersOut);
        const hw = [
          'h264_videotoolbox', // macOS
          'h264_nvenc',        // NVIDIA
          'h264_qsv',          // Intel
          'h264_amf',          // AMD
          'h264_v4l2m2m',      // Linux SoCs
          'h264_omx'           // older ARM
        ].find(has);
        if (hw && canH264) {
          videoEnc = hw;
        } else if (has('libopenh264') && canH264) {
          videoEnc = 'libopenh264';
        } else if (has('libvpx-vp9') && canVP9) {
          useWebM = true;
        }
      } catch {}

      // Destination container + audio codec
      let vArgs = [];
      let aArgs = [];
      if (videoEnc) {
        // H.264 path (hardware or libopenh264)
        out = window.electron.joinPath(previewDir, `${base}.preview.mp4`);
        vArgs = ['-c:v', videoEnc, '-b:v','6M','-maxrate','6M','-bufsize','12M'];
        aArgs = ['-c:a','aac','-b:a','160k','-movflags','+faststart'];
      } else if (useWebM) {
        out = window.electron.joinPath(previewDir, `${base}.preview.webm`);
        vArgs = ['-c:v','libvpx-vp9','-b:v','2M','-row-mt','1','-deadline','good'];
        aArgs = ['-c:a','libopus','-b:a','128k'];
      } else {
        // As a last resort, don’t make something unplayable — hand back original with a warning.
        setStatus('Browser can’t decode this media and no compatible encoder was found. Showing original; use “Open Media…” for a different file.', true);
        return _toFileURL(file);
      }

      const args = [
        '-y','-i', file,
        '-map','0:v:0?','-map','0:a:0?',
        ...vArgs,
        '-pix_fmt','yuv420p',
        '-vf','scale=-2:1080',
        ...aArgs,
        out
      ];
      await window.electron.execFFmpeg(ffmpegBin, args);
      setStatus(`Using preview: ${window.electron.basename(out)}`);
      return _toFileURL(out);
    } catch (err) {
      console.error(err);
      setStatus(`Preview failed: ${err?.message || err}`);
      return _toFileURL(file);
    }
  }

  async function loadMediaIntoPlayer(file) {
    const url = await ensurePlayableUrl(file);
    if (!url) return;
    videoEl.src = url;
    videoEl.load();
    // Ensure the frame reflects the real video aspect so overlays/captions align.
    bindVideoAspectToFrame(videoEl, previewHostEl || videoEl?.parentElement);
  }

  function installEditorSafeOverlay() {
    const root = overlay || document.querySelector('.subtitle-editor');
    if (!root) return;

    function findVideoHost() {
      const video = root.querySelector('.preview video, video');
      if (!video) return { host: root.querySelector('.preview') || root, video: null };
      const parent = video.parentElement;
      if (parent && !parent.classList.contains('preview-video-host') && parent.children.length !== 1) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-video-host';
        wrap.style.position = 'relative';
        parent.insertBefore(wrap, video);
        wrap.appendChild(video);
        return { host: wrap, video };
      }
      if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      return { host: parent || root, video };
    }

    const { host, video } = findVideoHost();
    previewHostEl = host;
    bindVideoAspectToFrame(video, host);
    const preview = host;
    const statusRow = root.querySelector('.status-row') || (() => {
      const s = document.createElement('div');
      s.className = 'status-row';
      root.appendChild(s);
      return s;
    })();
    const cs = getComputedStyle(preview);
    if (cs.position === 'static') preview.style.position = 'relative';

    if (!window.__editorSafe) {
      window.__editorSafe = createEditorSafeController({ root, preview, statusRow, video });
    } else {
      window.__editorSafe.setHost?.(preview, video);
    }
    window.__editorSafe.rebuild();
    window.__editorSafe.refreshInspector();

    if (!root.__editorSafeOnEdit) {
      root.__editorSafeOnEdit = (e) => {
        if (e.target && e.target.closest && e.target.closest('.cue')) {
          window.__editorSafe.refreshInspector();
        }
      };
      root.addEventListener('input', root.__editorSafeOnEdit);
      root.addEventListener('click', root.__editorSafeOnEdit);
    }
    if (!window.__editorSafeResize) {
      window.__editorSafeResize = () => window.__editorSafe?.rebuild();
      window.addEventListener('resize', window.__editorSafeResize);
    }
    if (!preview.__editorSafeRO && typeof ResizeObserver === 'function') {
      preview.__editorSafeRO = new ResizeObserver(() => window.__editorSafe?.rebuild());
      preview.__editorSafeRO.observe(video || preview);
    }
  }

  function createEditorSafeController(ctx) {
    let { preview, statusRow, root, video } = ctx;
    let overlayEl = null;
    let captionLayer = null; // 608 render layer
    let enabled = true;
    let showInspector = true;
    let lastSize = { w: 0, h: 0 };
    let placementEnabled = false;
    let guidesVisible = true;
    let pendingLineIndex = 0;
    let lastActiveCue = -1;

    function rowToYPx(row, fullHeight) {
      const h = Math.max(0, fullHeight || 0);
      if (!h) return 0;
      // 608: 15 rows inside the inner 80% of the video height
      const safeH = h * 0.8;             // caption/title-safe height
      const safeTop = (h - safeH) / 2;   // 10% margin top and bottom
      const clampedRow = Math.min(15, Math.max(1, Number(row) || 15));
      const lineH = safeH / 15;          // height of one 608 row
      // Use the vertical centre of the row
      return Math.round(safeTop + lineH * (clampedRow - 0.5));
    }

    // Legacy name kept for back-compat; keep row mapping inside the safe band.
    function rowToYPxStrict(row, fullHeight) {
      return rowToYPx(row, fullHeight);
    }

    // Centralized guide layout (always runs when asked, can be forced on create)
    function layoutGuides(heightPx) {
      if (!overlayEl) return;
      const h = Math.max(0, heightPx || 0);
      overlayEl.querySelectorAll('.row-guide').forEach((el) => {
        const row = Number(el.dataset.row);
        const y = rowToYPx(row, h);
        el.style.top = `${y}px`;
        const label = el.querySelector('.row-label');
        if (label) label.style.top = '0';
      });
    }

    function ensureGrid() {
      if (!overlayEl) return null;
      let grid = overlayEl.querySelector('.col-grid');
      if (!grid) {
        grid = document.createElement('div');
        grid.className = 'col-grid';
        for (let i = 0; i < 32; i++) {
          const cell = document.createElement('div');
          cell.className = 'col-hit';
          cell.dataset.col = String(i);
          grid.appendChild(cell);
        }
        overlayEl.appendChild(grid);
      }

      // Keep the 32-column click grid aligned to the same 608 safe box used for rendering.
      // (In SCC mode this is a centered 4:3 aperture, not full 16:9 width.)
      try {
        const rect = overlayEl.getBoundingClientRect();
        const { safeLeft, safeWidth } = _calc608SafeBox(rect);
        grid.style.position = 'absolute';
        grid.style.top = '0';
        grid.style.bottom = '0';
        grid.style.left = `${safeLeft}px`;
        grid.style.width = `${safeWidth}px`;
        grid.style.gridTemplateColumns = 'repeat(32, 1fr)';
      } catch {}

      grid.style.display = (placementEnabled && guidesVisible) ? 'grid' : 'none';
      return grid;
    }

    function _calc608SafeBox(rect) {
      const r = rect || (overlayEl?.getBoundingClientRect() || { width: 1, height: 1 });

      // SCC/CEA-608 is historically a 4:3 caption aperture.
      // On HD (16:9) broadcasts, 608 is typically not stretched across the full width.
      // So in SCC mode, map the 32 columns into a centered 4:3 active region first.
      const scc = isSccDoc(state.doc);
      const activeW = scc ? Math.min(r.width, r.height * (4 / 3)) : r.width;
      const activeLeft = (r.width - activeW) / 2;

      // Caption/title safe box = inner 80% of the active region.
      const safeWidth = activeW * 0.8;
      const safeLeft  = activeLeft + (activeW - safeWidth) / 2;

      const cellW = safeWidth / 32;
      return { safeLeft, safeWidth, cellW };
    }

    function ensureCaptionCSS() {
      if (document.getElementById('cc608-style')) return;
      const s = document.createElement('style');
      s.id = 'cc608-style';
      s.textContent = `
        .cc608-layer {
          position: absolute;
          inset: 0;
          pointer-events: none;
          /* Make sure captions sit above grid / guides and never disappear
             behind other overlay chrome. */
          z-index: 3;
        }

        .cc608-line {
          position: absolute;
          left: 0;
          right: auto;
          font-family: "Courier New", Courier, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-weight: 700;
          font-variant-ligatures: none;
          font-kerning: none;
          color: #fff;
          text-shadow: 0 0 3px #000, 0 0 6px #000;
          transform: translateY(-50%);
          pointer-events: none;
          /* Prevent any global typography rules from turning captions into
             a ransom note (letter-spacing is inheritable). */
          letter-spacing: 0;
          display: flex;
          white-space: nowrap;
          text-align: left;
        }

        .cc608-cell {
          display: inline-flex;
          flex: 0 0 var(--cc-cellw);
          align-items: center;
          justify-content: center; /* “TV-ish” look; use flex-start if you prefer */
          width: var(--cc-cellw);
        }

        /* Mid-row attribute preview helpers (CEA-608)
           These are driven by {WhU},{I},{IU},... tokens in SCC text.
           Real decoders treat the token as a style change *and* a blank cell. */
        .cc608-cell.i { font-style: italic; }
        .cc608-cell.u { text-decoration: underline; }
        .cc608-cell.c-wh { color: #fff; }
        .cc608-cell.c-gr { color: #0f0; }
        .cc608-cell.c-bl { color: #3af; }
        .cc608-cell.c-cy { color: #0ff; }
        .cc608-cell.c-r  { color: #f33; }
        .cc608-cell.c-y  { color: #ff0; }
        .cc608-cell.c-ma { color: #f0f; }
      `;
      document.head.appendChild(s);
    }

    function ensureCaptionLayer() {
      // If render608 runs before the safe-title overlay exists, bootstrap it
      // so caption rendering never silently no-ops.
      if (!overlayEl && preview) {
        api.rebuild();
      }
      if (!overlayEl) return null;
      if (!captionLayer) {
        captionLayer = document.createElement('div');
        captionLayer.className = 'cc608-layer';
        overlayEl.appendChild(captionLayer);
      }
      captionLayer.style.display = enabled ? 'block' : 'none';
      return captionLayer;
    }

    function toXY(row, col) {
      // Map 608 rows (1..15) into the inner 80% caption/title-safe band,
      // and 32 equal-width columns across the inner 80% of the picture width.
      // This matches real CEA-608 decoders: caption-safe box is 80% wide.
      const rect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };

      const y = rowToYPx(row, rect.height);

      const { safeLeft, cellW } = _calc608SafeBox(rect);

      const x = Math.round(safeLeft + col * cellW);
      return { x, y, cellW };
    }

    // Legacy name kept for back-compat; 608 in HD should still respect the caption-safe aperture.
    function toXYStrict(row, col) {
      return toXY(row, col);
    }

    function clearCaption() {
      const layer = ensureCaptionLayer();
      if (!layer) return;
      while (layer.firstChild) layer.removeChild(layer.firstChild);
    }

    function render608(cue) {
      ensureCaptionCSS();
      const layer = ensureCaptionLayer();
      clearCaption();
      if (!enabled || !layer || !cue) return;

      const baseText = String(cue.text || '').replace(/\\n/g, '\n');
      const raw = Array.isArray(cue.lines) && cue.lines.length
        ? cue.lines
        : (window.transcribeEngine?.wrap608
            ? window.transcribeEngine.wrap608(baseText, 32, 2)
            : baseText.split(/\r?\n|\s*\|\s*/g));

      const sccMode = isSccDoc(state.doc);

      const pairs = raw
        .map((s, i) => {
          const pl = cue.sccPlacement?.[i] || null;
          const hasPac = !!pl;
          const textRaw = String(s ?? '').replace(/\s+$/g, '');
          const inferredCol = hasPac
            ? null
            : Math.max(0, Math.min(31, (textRaw.match(/^(\s*)/)?.[1] || '').length));
          const textDisplay = (sccMode || hasPac) ? textRaw : textRaw.replace(/^\s+/, '');
          return { text: textDisplay, pl, inferredCol, hasPac };
        })
        .filter(p => p.text && p.text.length)
        .slice(0, 2);

      const lines = pairs.map(p => p.text);

      const defaultRows = (lines.length === 1) ? [15] : [14, 15];
      const rows = [];
      const cols = [];

      for (let i = 0; i < lines.length; i++) {
        const pl = pairs[i]?.pl || {};
        const rowVal = Number(pl.row);
        const colVal = Number(pl.col);
        // IMPORTANT: allow full 608 row range (1..15). Title-safe (12..15) is a default,
        // not a hard restriction. SCC deliverables often reposition above lower-thirds.
        rows[i] = Math.max(1, Math.min(15, Number.isFinite(rowVal) ? rowVal : (defaultRows[i] ?? 15)));
        const fallbackCol = pairs[i]?.hasPac ? 0 : (pairs[i]?.inferredCol ?? 0);
        cols[i] = Math.max(0, Math.min(31, Number.isFinite(colVal) ? colVal : fallbackCol));
      }

      if (lines.length === 2 && rows[0] > rows[1]) {
        [rows[0], rows[1]] = [rows[1], rows[0]];
        [cols[0], cols[1]] = [cols[1], cols[0]];
        [lines[0], lines[1]] = [lines[1], lines[0]];
      }

      const overlayRect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };
      const cellHeightSafe = (overlayRect.height * 0.8) / 15;
      const cellHeightStrict = cellHeightSafe;
      // Use strict font sizing if ANY line is PAC-driven (so it matches strict y-mapping)
      const anyPac = pairs.some(p => p?.hasPac);
      const cellHeight = anyPac ? cellHeightStrict : cellHeightSafe;
      const fontPx = Math.floor(cellHeight * 1.0);

      // SCC mid-row attribute tokens ({WhU},{I},{IU},...) are control codes in real
      // CEA-608. Decoders treat them as a style change AND a blank cell (space).
      // The preview must emulate that or users will "fix" captions based on a
      // representation that no broadcast decoder will ever show.
      const MIDROW_SPLIT_RE = /\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g;
      const _applyMidRowToken = (prev, tok) => {
        const next = { ...(prev || { color: 'wh', underline: false, italic: false }) };
        const t = String(tok || '').trim();
        if (!t) return next;

        if (t === 'I' || t === 'IU') {
          next.color = 'wh';
          next.italic = true;
          next.underline = (t === 'IU');
          return next;
        }

        // Color/underline attributes reset italics in most decoders.
        next.italic = false;
        next.underline = /U$/.test(t);
        const base = t.replace(/U$/, '');
        const map = { Wh: 'wh', Gr: 'gr', Bl: 'bl', Cy: 'cy', R: 'r', Y: 'y', Ma: 'ma' };
        if (map[base]) next.color = map[base];
        return next;
      };
      const _parse608Cells = (text) => {
        const parts = String(text || '').split(MIDROW_SPLIT_RE);
        let style = { color: 'wh', underline: false, italic: false };
        const cells = [];
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (p % 2 === 1) {
            // Token: change style, and occupy 1 blank cell.
            style = _applyMidRowToken(style, part);
            cells.push({ ch: ' ', style: { ...style }, isToken: true });
          } else if (part) {
            // Text: one cell per character (codepoint).
            for (const ch of Array.from(part)) {
              cells.push({ ch, style: { ...style }, isToken: false });
            }
          }
        }
        return cells;
      };
      const _clampCells = (cells, max) => {
        const out = Array.isArray(cells) ? cells.slice(0, Math.max(0, max)) : [];
        // Trim trailing whitespace cells (matches earlier string-based clamp)
        while (out.length && String(out[out.length - 1]?.ch || '') === ' ') out.pop();
        return out;
      };

      for (let i = 0; i < lines.length; i++) {
        const row = rows[i];
        const col = cols[i];
        const hasPac = !!pairs[i]?.hasPac;
        const { x, y, cellW } = toXY(row, col);

        const el = document.createElement('div');
        el.className = 'cc608-line';

        const maxCols = Math.max(0, 32 - col);
        const rawText = lines[i] || '';
        const cells = _clampCells(_parse608Cells(rawText), maxCols);

        // Render as fixed 608 cells so PAC/col positioning is visually correct.
        el.style.setProperty('--cc-cellw', `${cellW}px`);
        while (el.firstChild) el.removeChild(el.firstChild);
        for (const c of cells) {
          const cell = document.createElement('span');
          cell.className = 'cc608-cell';
          const st = c?.style || {};
          if (st.italic) cell.classList.add('i');
          if (st.underline) cell.classList.add('u');
          if (st.color) cell.classList.add(`c-${st.color}`);
          cell.textContent = (c?.ch === ' ') ? '\u00A0' : String(c?.ch || '');
          el.appendChild(cell);
        }
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.lineHeight = '1';
        el.style.fontSize = `${fontPx}px`;
        el.style.width = `${cellW * Math.min(32 - col, cells.length)}px`;

        layer.appendChild(el);
      }
    }

    function hidePlacementMarker() {
      const mark = overlayEl?.querySelector('.placement-marker');
      if (mark) mark.style.display = 'none';
    }

    function placementPac(row, col) {
      try {
        const nib = Math.floor(Math.max(0, Math.min(31, col)) / 4);
        return window.transcribeEngine?.pacForRow?.(row, nib, 1) || '';
      } catch {
        return '';
      }
    }

    function updateMarker(row, col, opts = {}) {
      if (!overlayEl) return;
      let mark = overlayEl.querySelector('.placement-marker');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'placement-marker';
        overlayEl.appendChild(mark);
      }
      const overlayRect = overlayEl.getBoundingClientRect();

      const { safeLeft, cellW } = _calc608SafeBox(overlayRect);
      const x = safeLeft + (col + 0.5) * cellW;
      const rowGuide = overlayEl.querySelector(`.row-guide[data-row="${row}"]`);
      let y = overlayRect.height;
      if (rowGuide) {
        const guideRect = rowGuide.getBoundingClientRect();
        y = guideRect.top - overlayRect.top;
      }
      mark.style.left = `${x}px`;
      mark.style.top = `${y}px`;
      mark.style.display = placementEnabled ? 'block' : 'none';
      if (!opts?.silent && statusRow && placementEnabled && showInspector) {
        statusRow.textContent = `row ${row}, col ${col} → ${placementPac(row, col)}`;
      }
    }

    function nearestRow(yPx) {
      if (!overlayEl) return 15;
      const guides = Array.from(overlayEl.querySelectorAll('.row-guide'));
      let best = { row: 15, dist: Infinity };
      for (const g of guides) {
        const row = Number(g.dataset.row);
        if (row < 1 || row > 15) continue;
        const gy = g.getBoundingClientRect().top;
        const d = Math.abs(yPx - gy);
        if (d < best.dist) best = { row, dist: d };
      }
      // Clamp to legal CEA-608 range (1–15).
      return Math.min(15, Math.max(1, best.row));
    }

    function setPlacementEnabled(v) {
      placementEnabled = !!v;
      pendingLineIndex = 0;
      const grid = ensureGrid();
      if (grid) grid.style.display = (placementEnabled && guidesVisible) ? 'grid' : 'none';
      if (!placementEnabled) {
        hidePlacementMarker();
      } else {
        api.refreshInspector();
        // When the user is actively placing captions, show the full 608 grid (rows 1–15).
        // Otherwise, keep the UI in the familiar title-safe band (12–15).
        api.setGuidesVisible(guidesVisible);
      }
    }

    const onOverlayClick = (ev) => {
      if (!placementEnabled) return;
      const target = ev.target;
      if (!target || !target.classList?.contains('col-hit')) return;

      const col = Number(target.dataset.col || 0);
      const row = nearestRow(ev.clientY);

      const activeCueEl = root?.querySelector('.cue.active') || root?.querySelector('.cue:focus-within');
      if (!activeCueEl) return;
      const idx = Number(activeCueEl.dataset.index || -1);
      if (!Number.isInteger(idx) || idx < 0 || !state.doc?.cues?.[idx]) return;

      const cue = state.doc.cues[idx];
      cue.sccPlacement = cue.sccPlacement || {};
      const ta = root?.querySelector('.cue.active textarea');
      const count = ta ? ta.value.split(/\r?\n|\s*\|\s*/g).filter(Boolean).length : 1;

      // Map the clicked row to the logical line index for deterministic placement.
      const lineIdx = (count === 2) ? (row >= 15 ? 1 : 0) : pendingLineIndex;
      cue.sccPlacement[lineIdx] = { row, col };

      if (count === 2) {
        const other = lineIdx === 0 ? 1 : 0;
        const otherRow = Number(cue.sccPlacement[other]?.row);
        if (!Number.isFinite(otherRow)) {
          const adj = lineIdx === 0
            ? Math.min(15, Math.max(1, row + 1))
            : Math.max(1, row - 1);
          cue.sccPlacement[other] = { row: adj, col };
        }
        const r0 = Number(cue.sccPlacement[0]?.row);
        const r1 = Number(cue.sccPlacement[1]?.row);
        if (Number.isFinite(r0) && Number.isFinite(r1) && r0 > r1) {
          const tmp = cue.sccPlacement[0];
          cue.sccPlacement[0] = cue.sccPlacement[1];
          cue.sccPlacement[1] = tmp;
        }
        pendingLineIndex = lineIdx;
      } else {
        pendingLineIndex = pendingLineIndex === 0 ? 1 : 0;
      }

      updateMarker(row, col);
      try { renderActiveCue608(); } catch {}
      api.refreshInspector();
    };

    const api = {
      setHost(newPreview, newVideo) {
        preview = newPreview || preview;
        video = newVideo || video;
        overlayEl = null;
        captionLayer = null;
        // Force a fresh layout on next rebuild
        lastSize = { w: 0, h: 0 };
      },
      render608,
      setPlacementEnabled,
      setGuidesVisible(v = true) {
        guidesVisible = !!v;
        if (!overlayEl) return;
        // UI policy:
        //  - Normal mode: show only title-safe band (rows 12–15)
        //  - Click-to-place mode: show full 608 grid (rows 1–15) so the user can intentionally place higher
        overlayEl.querySelectorAll('.row-guide').forEach((el) => {
          const row = Number(el.dataset.row);
          const inTitleSafeBand = (row >= 12 && row <= 15);
          const showThisRow = guidesVisible && (placementEnabled ? true : inTitleSafeBand);
          el.style.display = showThisRow ? 'block' : 'none';
        });
        const grid = ensureGrid();
        if (grid) {
          grid.style.display = (placementEnabled && guidesVisible) ? 'grid' : 'none';
        }
      },
      enable(v = true) {
        enabled = !!v;
        if (!enabled) {
          // Keep captions & grid machinery alive; just hide overlays.
          if (overlayEl) {
            overlayEl.style.display = 'none';
          }
        } else {
          // Reset cached size so guides are laid out even if dimensions didn’t change.
          lastSize = { w: 0, h: 0 };
          api.rebuild();
          if (overlayEl) {
            overlayEl.style.display = 'block';
          }
        }
      },
      toggleInspector(v = true) {
        showInspector = !!v;
        if (!showInspector) {
          if (statusRow) { statusRow.textContent = ''; statusRow.style.display = 'none'; }
          if (overlayEl) overlayEl.querySelectorAll('.row-guide').forEach(el => el.classList.remove('highlight'));
        } else {
          if (statusRow) statusRow.style.display = 'flex';
          api.refreshInspector();
        }
      },
      rebuild() {
        if (!preview) return api.destroy();
        if (!enabled && overlayEl) return;
        // Use the video box if available so rows map to the actual picture height
        const rect = (video || preview).getBoundingClientRect();
        if (!overlayEl) {
          overlayEl = document.createElement('div');
          overlayEl.className = 'safe-title-overlay';
          // Build row guides for the full 608 grid (1..15).
          // Visibility is controlled by setGuidesVisible():
          //   - normal: show 12–15
          //   - click-to-place: show 1–15
          (() => {
            const frag = document.createDocumentFragment();
            for (let r = 1; r <= 15; r++) {
              const d = document.createElement('div');
              d.className = 'row-guide';
              d.dataset.row = String(r);
              // Only label the title-safe band to keep the UI clean in normal mode
              // (labels still exist for all rows when placement mode is enabled).
              const label = document.createElement('span');
              label.className = 'row-label';
              label.textContent = String(r);
              d.appendChild(label);
              frag.appendChild(d);
            }
            overlayEl.appendChild(frag);
          })();
          preview.appendChild(overlayEl);
          // Make the overlay fill its host explicitly (robust to external CSS)
          overlayEl.style.position = 'absolute';
          overlayEl.style.top = '0';
          overlayEl.style.left = '0';
          overlayEl.style.right = '0';
          overlayEl.style.bottom = '0';
          ensureGrid();
          if (!overlayEl.__clickPlaceBound) {
            overlayEl.addEventListener('click', onOverlayClick);
            overlayEl.__clickPlaceBound = true;
          }
          // Always lay out guides right after creation, even if size didn’t change
          layoutGuides(rect.height);
          ensureCaptionCSS();
          ensureCaptionLayer();
        }
        if (Math.abs(lastSize.w - rect.width) > 1 || Math.abs(lastSize.h - rect.height) > 1) {
          lastSize = { w: rect.width, h: rect.height };
          layoutGuides(rect.height);
          ensureCaptionLayer();
        }
        ensureGrid();
        ensureCaptionLayer();
        api.setGuidesVisible(guidesVisible);
        if (!placementEnabled) hidePlacementMarker();
      },
      refreshInspector() {
        if (!statusRow || !showInspector) return;
        statusRow.textContent = '';
        if (!root) return;
        const active = root.querySelector('.cue.active') || root.querySelector('.cue:focus-within');
        if (!active) return;
        const idx = Number(active.dataset?.index ?? -1);
        if (!Number.isInteger(idx) || idx < 0) return;
        if (idx !== lastActiveCue) {
          lastActiveCue = idx;
          pendingLineIndex = 0;
        }
        const ta = active.querySelector('textarea') || active.querySelector('input[type="text"]');
        if (!ta) return;
        const lines = (ta.value || '').split(/\r?\n/);
        const maxLen = Math.max(0, ...lines.map(l => l.length));
        const indent = /^(\s*)/.exec(lines[0] || '')?.[1]?.length ?? 0;
        const cue = state.doc?.cues?.[idx];
        const placements = (cue && cue.sccPlacement) ? cue.sccPlacement : null;
        const hints = [];
        if (placements) {
          for (const lineIdx of [0, 1]) {
            const pl = placements[lineIdx];
            if (!pl || !Number.isFinite(pl.row) || !Number.isFinite(pl.col)) continue;
            hints.push(`L${lineIdx + 1}: row ${pl.row}, col ${pl.col} → ${placementPac(pl.row, pl.col)}`);
          }
          if (placementEnabled) {
            const pref = placements[pendingLineIndex] || placements[0] || placements[1];
            if (pref && Number.isFinite(pref.row) && Number.isFinite(pref.col)) {
              updateMarker(pref.row, pref.col, { silent: true });
            } else {
              hidePlacementMarker();
            }
          }
        } else if (placementEnabled) {
          hidePlacementMarker();
        }
        const msg = `Lines: ${lines.length} | Max Len: ${maxLen} | Indent: ${indent}`;
        statusRow.textContent = hints.length ? `${msg} | ${hints.join(' | ')}` : msg;
        if (overlayEl) {
          overlayEl.querySelectorAll('.row-guide').forEach(el => el.classList.remove('highlight'));
          // Keep the old behavior of highlighting within the title-safe band by default:
          //  - 1 line highlights row 15
          //  - 2 lines highlights row 14
          const row = (lines.length <= 1) ? 15 : 14;
          const guide = overlayEl.querySelector(`.row-guide[data-row="${row}"]`);
          if (guide) guide.classList.add('highlight');
        }
      },
      destroy() {
        if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
        overlayEl = null;
        captionLayer = null;
        hidePlacementMarker();
      }
    };
    return api;
  }

  // ---- Timecode helpers ----------------------------------------------------

  function formatSecondsGeneric(seconds = 0) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) seconds = 0;
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = String(totalMs % 1000).padStart(3, '0');
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
  }

  function parseSecondsGeneric(value, fallback = 0) {
    if (typeof value === 'number') return value;
    const str = (value || '').trim();
    if (!str) return fallback;
    if (/^\d+(?:\.\d+)?$/.test(str)) return parseFloat(str);
    const match = str.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[\.,](\d{1,3}))?$/);
    if (match) {
      const h = parseInt(match[1], 10) || 0;
      const m = parseInt(match[2], 10) || 0;
      const s = parseInt(match[3], 10) || 0;
      const ms = parseInt((match[4] || '').padEnd(3, '0'), 10) || 0;
      return h * 3600 + m * 60 + s + ms / 1000;
    }
    return fallback;
  }

  function formatSecondsSmpte(seconds = 0, doc) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) seconds = 0;
    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;

    const offsetSec = _getDocTimecodeOffsetSeconds(doc);
    const displaySec = Math.max(0, seconds + offsetSec);

    // Use the same core formatter the SCC encoder/decoder uses so
    // labels here match SCC timecode exactly (including drop-frame).
    try {
      const fmt = window.transcribeEngine?.formatTimecode?.(displaySec, drop, fps, 'colon');
      if (fmt && typeof fmt === 'string') {
        return fmt;
      }
    } catch (err) {
      console.error('formatTimecode failed, falling back to simple SMPTE', err);
    }

    // Fallback: simple NDF-style frame math if the engine isn't available.
    const fpsInt = Math.round(fps || 30);
    const totalFrames = Math.max(0, Math.round(displaySec * fps));

    const framesPerHour = fpsInt * 3600;
    const framesPerMinute = fpsInt * 60;

    let f = totalFrames;
    const h = Math.floor(f / framesPerHour); f %= framesPerHour;
    const m = Math.floor(f / framesPerMinute); f %= framesPerMinute;
    const s = Math.floor(f / fpsInt);
    const ff = f % fpsInt;

    const sep = drop ? ';' : ':';
    return (
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + sep +
      String(ff).padStart(2, '0')
    );
  }

  function parseSecondsSmpte(value, doc, fallback = 0) {
    if (typeof value === 'number') return value;
    const str = (value || '').trim();
    if (!str) return fallback;

    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;
    const offsetSec = _getDocTimecodeOffsetSeconds(doc);

    // Prefer the same parser the writers use so SCC/MCC round-trip cleanly.
    try {
      const ms = window.transcribeEngine?.parseTime?.(str, fps, drop ? true : null);
      if (typeof ms === 'number' && !Number.isNaN(ms)) {
        return Math.max(0, (ms / 1000) - offsetSec);
      }
    } catch (err) {
      console.error('parseSecondsSmpte: engine parseTime failed, falling back', err);
    }

    // Fallback: basic SMPTE parse, with DF math when appropriate.
    const m = str.match(/^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})$/);
    if (!m) return parseSecondsGeneric(str, fallback);

    const h   = parseInt(m[1], 10) || 0;
    const min = parseInt(m[2], 10) || 0;
    const s   = parseInt(m[3], 10) || 0;
    const ff  = parseInt(m[5], 10) || 0;

    const minutesTotal = (h * 60) + min;
    const isDf = drop && Math.abs(fps - 29.97) < 0.05;

    if (isDf) {
      // Standard 29.97 DF formula: drop 2 frames per minute, except every 10th.
      const dropped = 2 * (minutesTotal - Math.floor(minutesTotal / 10));
      const frameNumber = ((h * 3600) + (min * 60) + s) * 30 + ff - dropped;
      return Math.max(0, (frameNumber / 29.97) - offsetSec);
    }

    const fpsInt = Math.round(fps || 30);
    const totalFrames = (((h * 3600) + (min * 60) + s) * fpsInt) + ff;
    return Math.max(0, (totalFrames / fps) - offsetSec);
  }

  // Public helpers used throughout this module
  function formatSeconds(seconds = 0) {
    if (usesSmpteTimecode(state.doc)) {
      return formatSecondsSmpte(seconds, state.doc);
    }
    return formatSecondsGeneric(seconds);
  }

  function parseSeconds(value, fallback = 0) {
    if (usesSmpteTimecode(state.doc)) {
      return parseSecondsSmpte(value, state.doc, fallback);
    }
    return parseSecondsGeneric(value, fallback);
  }

  function renderCues(cues) {
    if (!cuesContainer) return;
    cuesContainer.innerHTML = '';
    cues.forEach((cue, idx) => {
      const row = document.createElement('div');
      row.className = 'cue';
      row.dataset.index = String(idx);

      const startInput = document.createElement('input');
      startInput.type = 'text';
      startInput.value = formatSeconds(cue.start);
      startInput.addEventListener('change', () => updateCueTime(idx, 'start', startInput.value));

      const endInput = document.createElement('input');
      endInput.type = 'text';
      endInput.value = formatSeconds(cue.end);
      endInput.addEventListener('change', () => updateCueTime(idx, 'end', endInput.value));

      const textArea = document.createElement('textarea');
      const initialText = (Array.isArray(cue.lines) && cue.lines.length)
        ? cue.lines.join('\n')
        : (cue.text || '');
      textArea.value = initialText;
      textArea.rows = 2;
      // Ensure true multi-line editing and auto-height
      textArea.style.whiteSpace = 'pre-wrap';
      textArea.style.resize = 'vertical';
      autoSizeTextarea(textArea);
      textArea.addEventListener('input', () => {
        autoSizeTextarea(textArea);
        updateCueText(idx, textArea.value);
      });

      row.appendChild(startInput);
      row.appendChild(endInput);
      row.appendChild(textArea);
      cuesContainer.appendChild(row);
    });
    highlightCue(state.activeCue);
    // We render only the active cue on top of video using custom 608 renderer.
    renderActiveCue608();
  }

  function updateCueTime(index, field, value) {
    if (!state.doc?.cues?.[index]) return;
    const numeric = parseSeconds(value, state.doc.cues[index][field]);
    if (field === 'end') {
      state.doc.cues[index].end = Math.max(numeric, state.doc.cues[index].start + 0.01);
    } else {
      const currentEnd = state.doc.cues[index].end;
      state.doc.cues[index].start = Math.min(numeric, currentEnd - 0.01);
    }
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  function updateCueText(index, text) {
    if (!state.doc?.cues?.[index]) return;
    // Keep lines in sync with the editor text so the 608 overlay stays correct
    state.doc.cues[index].text = text;
    state.doc.cues[index].lines = String(text || '')
      .replace(/\\n/g, '\n')
      .split(/\r?\n|\s*\|\s*/g)   // treat \n and | as hard breaks
      .map(s => {
        const str = String(s || '');
        return isSccDoc(state.doc) ? str.replace(/\s+$/g, '') : str.trim();
      })
      .filter(Boolean)
      .slice(0, 2);
    state.activeCue = index;
    markDirty();
    // Custom 608 overlay is the preview; update it immediately
    renderActiveCue608();
  }

  function onCueClick(event) {
    const row = event.target.closest('.cue');
    if (!row) return;
    const idx = parseInt(row.dataset.index || '-1', 10);
    if (Number.isNaN(idx) || idx < 0) return;
    state.activeCue = idx;
    highlightCue(idx);
    if (videoEl && typeof videoEl.currentTime === 'number') {
      const cue = state.doc?.cues?.[idx];
      if (cue) videoEl.currentTime = cue.start;
    }
  }

  function highlightCue(index) {
    if (!cuesContainer) return;
    Array.from(cuesContainer.children).forEach((child, idx) => {
      child.classList.toggle('active', idx === index);
    });
    renderActiveCue608();
  }

  function highlightCueForTime(timeSec) {
    const cues = state.doc?.cues;
    if (!Array.isArray(cues) || !cues.length) return;

    const t = Number(timeSec) || 0;

    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;

    // Find the last cue whose start <= t (frame-aligned-ish)
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = Number(cues[mid].start) || 0;
      if (s <= t + 0.0005) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (idx !== -1 && idx !== state.activeCue) {
      state.activeCue = idx;
      highlightCue(idx);
      const target = cuesContainer?.children?.[idx];
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function splitCue(index, timeSec) {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    if (timeSec <= cue.start + 0.05 || timeSec >= cue.end - 0.05) return;
    const words = (cue.text || '').split(/\s+/);
    const mid = Math.max(1, Math.ceil(words.length / 2));
    const firstText = words.slice(0, mid).join(' ');
    const secondText = words.slice(mid).join(' ');

    const firstCue = { ...cue, end: timeSec, text: firstText };
    const secondCue = {
      ...cue,
      start: timeSec,
      text: secondText || cue.text,
      id: cue.id != null ? `${cue.id}-b` : undefined
    };

    state.doc.cues.splice(index, 1, firstCue, secondCue);
    markDirty();
    state.activeCue = index + 1;
    renderCues(state.doc.cues);
    highlightCue(index + 1);
  }

  function mergeCue(index) {
    if (!Array.isArray(state.doc?.cues)) return;
    const cue = state.doc.cues[index];
    const next = state.doc.cues[index + 1];
    if (!cue || !next) return;
    const merged = {
      ...cue,
      end: Math.max(cue.end, next.end),
      text: `${cue.text || ''} ${next.text || ''}`.trim()
    };
    state.doc.cues.splice(index, 2, merged);
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  function deleteCue(index) {
    if (!Array.isArray(state.doc?.cues)) return;
    const cues = state.doc.cues;
    if (!cues[index]) return;

    // Remove the cue
    cues.splice(index, 1);
    markDirty();

    if (!cues.length) {
      // Nothing left – clear selection and UI
      state.activeCue = -1;
      renderCues(cues);
      return;
    }

    // Pick a sane next selection: same index, or previous if we deleted the last one
    const nextIndex = Math.min(index, cues.length - 1);
    state.activeCue = nextIndex;
    renderCues(cues);
    highlightCue(nextIndex);
  }

  function nudgeCue(index, delta, target = 'start') {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    if (target === 'end') {
      cue.end = Math.max(cue.start + 0.01, cue.end + delta);
    } else {
      cue.start = Math.min(cue.end - 0.01, Math.max(0, cue.start + delta));
    }
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  function markDirty() {
    state.doc.updatedAt = Date.now();
    setStatus('Unsaved changes');
  }

  function handleHotkeys(event) {
    if (overlay.classList.contains('hidden')) return;

    if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === 'o') {
      event.preventDefault();
      pickSubtitleAndLoad();
      return;
    }

    if (!state.doc?.cues?.length) return;

    const target = event.target;
    const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;

    if (event.key === 'Escape') {
      event.preventDefault();
      hideEditor();
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') &&
        !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Don't eat Backspace/Delete while typing in fields
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      deleteCue(activeIndex);
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (target && target.tagName === 'TEXTAREA') return;
      const time = videoEl?.currentTime ?? state.doc.cues[activeIndex]?.start;
      splitCue(activeIndex, time);
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter' && event.shiftKey) {
      mergeCue(activeIndex);
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && (event.key === '.' || event.key === '>')) {
      const fps = Number(state.doc?.fps) || 30;
      const step = usesSmpteTimecode(state.doc) ? (1 / fps) : 0.05;
      nudgeCue(activeIndex, step, 'end');
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && (event.key === ',' || event.key === '<')) {
      const fps = Number(state.doc?.fps) || 30;
      const step = usesSmpteTimecode(state.doc) ? (1 / fps) : 0.05;
      nudgeCue(activeIndex, -step, 'start');
      event.preventDefault();
    }
  }

  async function openEditor(options = {}) {
    buildUI();
    // Make the window usable immediately; status will update below
    showEditor();
    setStatus('Load a subtitle (.json, .srt, .vtt, .scc)…');
    try {
      const payload = {
        sourcePath: options.sourcePath,
        mediaPath: options.mediaPath,
        sessionId: options.sessionId
      };
      const response = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-open', payload)
        : null;
      if (!response || response.error) {
        setStatus(response?.error || 'No subtitle document loaded. Use Open… to choose one.', true);
        return;
      }
      state.doc = {
        ...response,
        mediaPath: options.mediaPath || response.mediaPath || null
      };
      state.lastExport = response.lastExport || null;
      state.activeCue = 0;
      await populateDoc(state.doc);
      setStatus('Loaded subtitle document.');
    } catch (err) {
      console.error('Failed to open subtitle editor', err);
      setStatus(`Failed to open: ${err.message}`, true);
    }
  }

  async function populateDoc(doc) {
    if (!doc) return;
    const scc = isSccDoc(doc);

    toolbarTitle.textContent =
      doc.displayName ||
      (doc.sourcePath
        ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath
        : 'Subtitle Document');

    refreshToolbarMetaForDoc(doc);

    // Toggle Export SCC / Export Corrections visibility based on format
    updateFormatButtonsForDoc(doc);

    // Try to play doc.mediaPath even if we can't stat it (no preload).
    const canStat = typeof window.electron?.fileExists === 'function';
    if (doc.mediaPath && (!canStat || window.electron.fileExists(doc.mediaPath))) {
      await loadMediaIntoPlayer(doc.mediaPath);
    } else {
      await promptForMedia();
    }

    // Watch item: Warn loudly if NDF (":" timecodes).
    // We allow round-trip when source SCC is NDF for convenience, but many broadcast specs reject NDF.
    if (doc.format === 'scc' && doc.dropFrame === false) {
      setStatus(
        '⚠️ This SCC is NDF (":" timecodes). Many broadcasters/QC pipelines reject NDF. Export may be rejected unless your spec allows it.',
        true
      );
    }

    // Normalize `lines` and fix legacy placements so the first line renders on top.
    if (Array.isArray(doc.cues)) {
      doc.cues.forEach((c) => {
        if (!Array.isArray(c.lines) || !c.lines.length) {
          const base = String(c.text || '').replace(/\\n/g, '\n');
          c.lines = base
            .split(/\r?\n|\s*\|\s*/g)
            .map((s) => {
              const str = String(s || '');
              // SCC: preserve leading spaces, only strip trailing whitespace
              return scc ? str.replace(/\s+$/g, '') : str.trim();
            })
            // For SCC, keep lines that contain any non-space char (but preserve leading spaces)
            .filter((line) => (scc ? /[^\s]/.test(line) : Boolean(line)))
            .slice(0, 2);
        }
        if (Array.isArray(c.lines) && c.lines.length === 2 && c.sccPlacement) {
          const r0 = Number(c.sccPlacement[0]?.row);
          const r1 = Number(c.sccPlacement[1]?.row);
          if (Number.isFinite(r0) && Number.isFinite(r1) && r0 > r1) {
            // Normalize to [top, bottom] across both placement AND text.
            [c.sccPlacement[0], c.sccPlacement[1]] = [c.sccPlacement[1], c.sccPlacement[0]];
            [c.lines[0], c.lines[1]] = [c.lines[1], c.lines[0]];
            c.text = c.lines.join('\n');
          }
        }

        if (c.sccPlacement == null && scc) {
          // Build effective SCC options: prefer explicit doc.sccOptions,
          // but fall back to doc.alignment when present.
          const sccOpts = (() => {
            const base = { ...(doc.sccOptions || {}) };
            if (!base.alignment && doc.alignment) {
              const raw = String(doc.alignment || '').trim().toLowerCase();
              base.alignment = (raw === 'centre') ? 'center' : (raw || 'left');
            }
            return base;
          })();

          const audit = window.transcribeEngine?.computeCea608PlacementAudit?.(
            [{ text: c.lines.join('\n'), start: c.start, end: c.end }],
            {
              maxCharsPerLine: doc.maxCharsPerLine || 28,
              maxLinesPerBlock: doc.maxLinesPerBlock || 2,
              includeSpeakerNames: true,
              sccOptions: sccOpts
            }
          );

          const first = audit && audit[0];
          if (first && Array.isArray(first.lines) && first.lines.length) {
            // IMPORTANT: use the 608‑wrapped lines from the audit so the
            // text we render matches the placement we’re using.
            c.lines = first.lines.map(l => l.text);
            c.text = c.lines.join('\n');

            c.sccPlacement = first.lines.map(l => ({
              row: l.row,
              col: l.columnStart
            }));
          }
        }
      });
    }

    renderCues(doc.cues || []);
    highlightCue(0);
    if (Array.isArray(doc.cues) && doc.cues.length) {
      const last = doc.cues[doc.cues.length - 1];
      durationEl.textContent = formatSeconds(last.end);
      scrubEl.max = last.end.toFixed(2);
    } else {
      durationEl.textContent = '00:00:00.000';
      scrubEl.max = '0';
    }
  }

  async function pickExportDirectory(defaultDir) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus('Folder picker unavailable.', true);
      return null;
    }
    try {
      // Your IPC handler 'select-folder' takes no args. Options are ignored there.
      // Keep title/defaultPath local if you later enhance the handler.
      const dir = await ipc.invoke('select-folder');
      return dir || null;
    } catch (err) {
      setStatus(`Export cancelled: ${err.message}`, true);
      return null;
    }
  }

  // Minimal "Save As…" for SCC (Option A: use real IPC channel)
  function normalizeDialogPath(raw) {
    // Electron dialogs can return either:
    //  - string (file path)
    //  - object { filePath: string } (common pattern)
    //  - object { path: string } (defensive)
    //  - null/undefined (cancel)
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      const fp = raw.filePath || raw.path || raw.outPath || null;
      return (typeof fp === 'string' && fp.trim()) ? fp : null;
    }
    return null;
  }

  async function saveSccAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus('Save dialog unavailable.', true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: 'Export SCC',
      defaultPath: defaultName || 'subtitle.corrected.scc',
      filters: [{ name: 'Scenarist SCC', extensions: ['scc'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function exportDoc() {
    if (!state.doc) {
      setStatus('Nothing to export', true);
      return;
    }
    try {
      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport
      };
      const result = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-export', payload)
        : null;
      if (result?.outputs) {
        state.lastExport = result.outputs;
        if (result.outputs.directory) {
          state.doc.outputDir = result.outputs.directory;
        }
      }
      setStatus(result?.message || 'Corrections exported.');
    } catch (err) {
      console.error('Subtitle export failed', err);
      setStatus(`Export failed: ${err.message}`, true);
    }
  }

  function getSccPrefsFromLocalStorage() {
    const prefs = {};

    const getStr = (key, defVal = '') => {
      try {
        const v = localStorage.getItem(key);
        return (v == null) ? defVal : String(v);
      } catch { return defVal; }
    };

    const getBool = (key, defVal = false) => {
      const v = getStr(key, '');
      if (!v) return !!defVal;
      return v === 'true';
    };

    const getInt = (key, defVal = 0, min = null, max = null) => {
      const v = parseInt(getStr(key, ''), 10);
      let out = Number.isFinite(v) ? v : defVal;
      if (typeof min === 'number') out = Math.max(min, out);
      if (typeof max === 'number') out = Math.min(max, out);
      return out;
    };

    // Keep these aligned with renderer.transcribe.js localStorage keys
    prefs.safeMargins = {
      left: getInt('scc-safe-left', 0, 0, 15),
      right: getInt('scc-safe-right', 0, 0, 15)
    };

    prefs.allowNdf = getBool('scc-allow-ndf', false);

    const ts = getStr('scc-time-source', '').trim();
    if (ts) prefs.timeSource = ts;

    const sra = getStr('scc-start-reset-at', '').trim();
    if (sra) prefs.startResetAt = sra;

    const sro = getStr('scc-start-reset-op', '').trim();
    if (sro) prefs.startResetOp = sro;

    prefs.padEven = getBool('scc-pad-even', false);

    const pw = getStr('scc-prefix-words', '').trim();
    if (pw) prefs.prefixWords = pw.split(/[\,\s]+/).map(t => t.trim()).filter(Boolean);

    // Default true unless explicitly disabled
    prefs.repeatControlCodes = getStr('scc-repeat-control', '') !== 'false';
    prefs.repeatPreambleCodes = getStr('scc-repeat-preamble', '') !== 'false';
    prefs.stripLeadingDashes = getBool('scc-strip-leading-dashes', false);

    // Content-QC thresholds (stored here for consistency; writer enforces during export jobs)
    prefs.qc = {
      maxCps: (() => { const v = Number(getStr('scc-qc-max-cps', '')); return Number.isFinite(v) ? v : undefined; })(),
      maxWpm: (() => { const v = Number(getStr('scc-qc-max-wpm', '')); return Number.isFinite(v) ? v : undefined; })(),
      minDurationSec: (() => { const v = Number(getStr('scc-qc-min-duration', '')); return Number.isFinite(v) ? v : undefined; })(),
      minGapSec: (() => { const v = Number(getStr('scc-qc-min-gap', '')); return Number.isFinite(v) ? v : undefined; })(),
      maxLateEocSec: (() => { const v = Number(getStr('scc-qc-max-late-eoc', '')); return Number.isFinite(v) ? v : undefined; })(),
      maxLateEocCount: (() => { const v = parseInt(getStr('scc-qc-max-late-eoc-count', ''), 10); return Number.isFinite(v) ? v : undefined; })()
    };

    return prefs;
  }



  async function exportSccDoc() {
    if (!state.doc) {
      setStatus('Nothing to export', true);
      return;
    }
    try {
      // Merge global SCC prefs (UI/localStorage) as defaults; doc values win.
      try {
        const prefs = getSccPrefsFromLocalStorage();
        const doc = state.doc;
        const existing = doc.sccOptions || {};
        const mergedSafeMargins = { ...(prefs.safeMargins || {}), ...(existing.safeMargins || {}) };
        const mergedQc = { ...(prefs.qc || {}), ...(existing.qc || {}) };
        doc.sccOptions = { ...prefs, ...existing, safeMargins: mergedSafeMargins, qc: mergedQc };
      } catch {}

      // Save-as every time (simple, explicit, reliable)
      const base = state.doc.baseName
        || (state.doc.sourcePath ? (window.electron?.basename?.(state.doc.sourcePath) || 'subtitle') : 'subtitle');
      // Prefer a directory-based default so the dialog opens where users expect.
      // 1) doc.outputDir
      // 2) folder of the source subtitle
      // 3) fallback to just filename
      let defaultPath = `${base}.corrected.scc`;
      try {
        const dir =
          state.doc.outputDir ||
          (state.doc.sourcePath && window.electron?.dirname ? window.electron.dirname(state.doc.sourcePath) : null) ||
          null;
        if (dir && window.electron?.joinPath) {
          defaultPath = window.electron.joinPath(dir, `${base}.corrected.scc`);
        }
      } catch {}

      const outPath = await saveSccAs(defaultPath);
      if (!outPath) {
        setStatus('Export cancelled.');
        return;
      }

      // Persist dir for other exports if desired
      try { state.doc.outputDir = window.electron?.dirname ? window.electron.dirname(outPath) : state.doc.outputDir; } catch {}

      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport,
        outputPath: outPath
      };

      const result = await ipc.invoke('subtitle-editor-export-scc', payload);

      if (result?.error) {
        setStatus(result.error, true);
        return;
      }

      // IMPORTANT: backend may normalize/fallback and returns the actual path in result.output
      const saved = (typeof result?.output === 'string' && result.output) ? result.output : outPath;
      setStatus(result?.message || `SCC saved → ${saved}`);
    } catch (err) {
      console.error(err);
      setStatus(`SCC export failed: ${err.message}`, true);
    }
  }

  async function burnInDoc() {
    if (!state.doc) {
      setStatus('Nothing to burn in', true);
      return;
    }

    try {
      if (!state.lastExport || !state.lastExport.directory) {
        setStatus('Exporting corrections before burn-in…');
        await exportDoc();
        if (!state.lastExport || !state.lastExport.directory) {
          setStatus('Export failed: no output directory known', true);
          return;
        }
      }
      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport
      };
      const result = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-burnin', payload)
        : null;
      if (result?.output) {
        state.lastExport = { ...(state.lastExport || {}), burnIn: result.output };
      }
      setStatus(result?.message || 'Burn-in started.');
    } catch (err) {
      console.error('Subtitle burn-in failed', err);
      setStatus(`Burn-in failed: ${err.message}`, true);
    }
  }

  window.subtitleEditorExport = exportDoc;
  window.subtitleEditorBurnIn = burnInDoc;

  // Preferred: subscribe directly to the preload fan‑out for init payloads
  if (window.subtitleEditor && typeof window.subtitleEditor.onInit === 'function') {
    window.subtitleEditor.onInit((data) => openEditor(data || {}));
  }
  // Back‑compat: also accept a DOM event from any legacy forwarders
  window.openSubtitleEditorOverlay = (data) => openEditor(data || {});
  window.addEventListener('subtitle-editor:init', (e) => openEditor((e && e.detail) || {}), { once: true });

  window.dispatchEvent(new Event('subtitle-editor-ready'));
})();
