(() => {
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
  // WebVTT/TextTrack preview path removed. Custom 608 overlay is authoritative.

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
          <button type="button" id="subtitle-editor-close">Close</button>
        </div>
        <div class="toolbar-toggles">
          <label class="checkbox-label">
            <input type="checkbox" id="toggle-guides" checked />
            Show safe‑title guides (rows 12–15)
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
    const openSubBtn = overlay.querySelector('#subtitle-editor-open-sub');
    const openMediaBtn = overlay.querySelector('#subtitle-editor-open-media');
    const guidesToggle = overlay.querySelector('#toggle-guides');
    const inspToggle = overlay.querySelector('#toggle-inspector');
    const clickPlaceToggle = overlay.querySelector('#toggle-click-place');

    closeBtn?.addEventListener('click', () => hideEditor());
    openSubBtn?.addEventListener('click', () => pickSubtitleAndLoad());
    openMediaBtn?.addEventListener('click', () => pickMediaAndLoad());

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
      window.__editorSafe?.enable(!!e.target.checked);
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
      window.__editorSafe?.enable(!!guidesToggle?.checked);
      window.__editorSafe?.toggleInspector?.(!!inspToggle?.checked);
      window.__editorSafe?.setPlacementEnabled?.(!!clickPlaceToggle?.checked);
    } catch {}
  }

  // --- helpers --------------------------------------------------------------
  function autoSizeTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 40)}px`;
  }

  function renderActiveCue608() {
    const cue = state.doc?.cues?.[state.activeCue] || null;
    try { window.__editorSafe?.render608?.(cue); } catch {}
  }

  function setStatus(message, isError = false) {
    if (!statusEl) return;
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

    toolbar.prepend(
      mkBtn('subtitle-editor-export-scc', 'Export SCC', async () => { try { await exportSccDoc(); } catch{} }),
      mkBtn('subtitle-editor-burnin', 'Burn‑in', async () => { try { await burnInDoc(); } catch{} }),
      mkBtn('subtitle-editor-export', 'Export Corrections', async () => { try { await exportDoc(); } catch{} })
    );
  }

  async function pickSubtitleAndLoad() {
    if (typeof ipc?.openFile !== 'function') {
      setStatus('File picker unavailable in this build.', true);
      return;
    }
    const picked = await ipc.openFile({
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
    if (typeof ipc?.openFile === 'function') {
      const resp = await ipc.openFile({
        title: 'Select video for preview',
        filters: [{ name: 'Video', extensions: ['mp4','mov','m4v','mkv','webm'] }]
      });
      const file = typeof resp === 'string' ? resp : resp?.filePaths?.[0];
      if (!file) return;
      state.doc = state.doc || {};
      state.doc.mediaPath = file;
      await loadMediaIntoPlayer(file);
      return;
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
    let pendingLineIndex = 0;
    let lastActiveCue = -1;

    // Centralized guide layout (always runs when asked, can be forced on create)
    function layoutGuides(heightPx) {
      if (!overlayEl) return;
      const h = Math.max(0, heightPx || 0);
      const toY = (row) => Math.round((row / 20) * h); // rows 1…20 vertically
      overlayEl.querySelectorAll('.row-guide').forEach((el) => {
        const row = Number(el.dataset.row);
        const y = toY(row);
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
      grid.style.display = placementEnabled ? 'grid' : 'none';
      return grid;
    }

    function ensureCaptionCSS() {
      if (document.getElementById('cc608-style')) return;
      const s = document.createElement('style');
      s.id = 'cc608-style';
      s.textContent = `
        .cc608-layer { position:absolute; inset:0; pointer-events:none; }
        .cc608-line { position:absolute; font-family: Menlo, Consolas, monospace;
          font-weight: 600; text-shadow: 0 0 3px #000, 0 0 6px #000;
          white-space: pre; transform: translateY(-50%); }
      `;
      document.head.appendChild(s);
    }

    function ensureCaptionLayer() {
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
      // Map 608 rows (1..15) to overlayEl height using same basis as row guides (20-tick scale).
      const rect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };
      const y = Math.round((row / 20) * rect.height);
      const x = Math.round((col / 32) * rect.width);
      const cellW = rect.width / 32;
      return { x, y, cellW };
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
      // Build 608-correct lines using the shared helper (writer parity)
      const baseText = String(cue.text || '').replace(/\\n/g, '\n');
      const raw = Array.isArray(cue.lines) && cue.lines.length
        ? cue.lines
        : (window.transcribeEngine?.wrap608
            ? window.transcribeEngine.wrap608(baseText, 32, 2)
            : baseText.split(/\r?\n|\s*\|\s*/g));
      const pairs = raw
        .map((s, i) => ({ text: String(s || '').trim(), pl: cue.sccPlacement?.[i] || null }))
        .filter(p => p.text)
        .slice(0, 2);
      const lines = pairs.map(p => p.text);

      // default pair: bottom two rows; single-line sits on row 15
      const defaultRows = (lines.length === 1) ? [15] : [14, 15];
      const rows = [];
      const cols = [];
      for (let i = 0; i < lines.length; i++) {
        const pl = pairs[i]?.pl || {};
        const rowVal = Number(pl.row);
        const colVal = Number(pl.col);
        rows[i] = Math.max(12, Math.min(15, Number.isFinite(rowVal) ? rowVal : (defaultRows[i] ?? 15)));
        cols[i] = Math.max(0, Math.min(31, Number.isFinite(colVal) ? colVal : 0));
      }
      // If two lines collapsed onto the same row (common after a single click), separate them.
      if (lines.length === 2 && rows[0] === rows[1]) {
        if (cue.sccPlacement?.[0] && !cue.sccPlacement?.[1]) rows[1] = Math.min(15, rows[0] + 1);
        else if (!cue.sccPlacement?.[0] && cue.sccPlacement?.[1]) rows[0] = Math.max(12, rows[1] - 1);
        else { rows[0] = 14; rows[1] = 15; }
      }
      // Enforce visual order: the first text line must render on the TOP row.
      // If rows are inverted (e.g., [15,14]), swap BOTH placement AND the text,
      // so "line 1" remains the top line.
      if (lines.length === 2 && rows[0] > rows[1]) {
        [rows[0], rows[1]] = [rows[1], rows[0]];
        [cols[0], cols[1]] = [cols[1], cols[0]];
        [lines[0], lines[1]] = [lines[1], lines[0]];
      }
      for (let i = 0; i < lines.length; i++) {
        const row = rows[i];
        const col = cols[i];
        const { x, y, cellW } = toXY(row, col);
        const el = document.createElement('div');
        el.className = 'cc608-line';
        // Word-safe clamp to cell width (don’t cut mid-word)
        const maxCols = Math.max(0, 32 - col);
        const rawText = lines[i] || '';
        const clamped = rawText.length > maxCols
          ? rawText.slice(0, maxCols).replace(/\s+\S*$/, '').trim() || rawText.slice(0, maxCols)
          : rawText;
        el.textContent = clamped;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.lineHeight = '1';
        el.style.fontSize = `${Math.max(12, Math.round((overlayEl.getBoundingClientRect().height / 20) * 0.9))}px`;
        el.style.maxWidth = `${Math.max(0, (32 - col) * cellW)}px`;
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
      const width = overlayRect.width || 1;
      const x = ((col + 0.5) / 32) * width;
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
        if (row < 12 || row > 15) continue;
        const gy = g.getBoundingClientRect().top;
        const d = Math.abs(yPx - gy);
        if (d < best.dist) best = { row, dist: d };
      }
      // Proper clamp to the legal range (12–15), don’t force >=14.
      return Math.min(15, Math.max(12, best.row));
    }

    function setPlacementEnabled(v) {
      placementEnabled = !!v;
      pendingLineIndex = 0;
      const grid = ensureGrid();
      if (grid) grid.style.display = placementEnabled ? 'grid' : 'none';
      if (!placementEnabled) {
        hidePlacementMarker();
      } else {
        api.refreshInspector();
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
            ? Math.min(15, Math.max(12, row + 1))
            : Math.max(12, row - 1);
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
      enable(v = true) {
        enabled = !!v;
        if (!enabled) {
          api.destroy();
        } else {
          // Reset cached size so guides are laid out even if dimensions didn’t change.
          lastSize = { w: 0, h: 0 };
          api.rebuild();
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
        if (!enabled || !preview) return api.destroy();
        // Use the video box if available so rows map to the actual picture height
        const rect = (video || preview).getBoundingClientRect();
        if (!overlayEl) {
          overlayEl = document.createElement('div');
          overlayEl.className = 'safe-title-overlay';
          overlayEl.innerHTML = `
            <div class="row-guide" data-row="12"><span class="row-label">12</span></div>
            <div class="row-guide" data-row="13"><span class="row-label">13</span></div>
            <div class="row-guide" data-row="14"><span class="row-label">14</span></div>
            <div class="row-guide" data-row="15"><span class="row-label">15</span></div>
          `;
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
          const row = Math.min(15, 11 + lines.length);
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

  function formatSeconds(seconds = 0) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) seconds = 0;
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = String(totalMs % 1000).padStart(3, '0');
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
  }

  function parseSeconds(value, fallback = 0) {
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
      .map(s => s.trim())
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
      nudgeCue(activeIndex, 0.05, 'end');
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && (event.key === ',' || event.key === '<')) {
      nudgeCue(activeIndex, -0.05, 'start');
      event.preventDefault();
    }
  }

  async function openEditor(options = {}) {
    buildUI();
    // Make the window usable immediately; status will update below
    showEditor();
    setStatus('Load a subtitle (.json, .srt, .vtt)…');
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
    toolbarTitle.textContent = doc.displayName || (doc.sourcePath ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath : 'Subtitle Document');
    const metaParts = [];
    if (doc.fps) metaParts.push(`${doc.fps} fps`);
    if (doc.dropFrame) metaParts.push('DF');
    if (doc.cues) metaParts.push(`${doc.cues.length} cues`);
    toolbarMeta.textContent = metaParts.join(' • ');

    // Try to play doc.mediaPath even if we can't stat it (no preload).
    const canStat = typeof window.electron?.fileExists === 'function';
    if (doc.mediaPath && (!canStat || window.electron.fileExists(doc.mediaPath))) {
      await loadMediaIntoPlayer(doc.mediaPath);
    } else {
      await promptForMedia();
    }

    // Normalize `lines` and fix legacy placements so the first line renders on top.
    if (Array.isArray(doc.cues)) {
      doc.cues.forEach((c) => {
        if (!Array.isArray(c.lines) || !c.lines.length) {
          const base = String(c.text || '').replace(/\\n/g, '\n');
          c.lines = base
            .split(/\r?\n|\s*\|\s*/g)
            .map(s => String(s || '').trim())
            .filter(Boolean)
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

  async function exportSccDoc() {
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
      const result = typeof ipc?.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-export-scc', payload)
        : null;
      if (result?.error) {
        setStatus(result.error, true);
        return;
      }
      if (result?.output) {
        const nextExports = { ...(state.lastExport || {}), scc: result.output };
        state.lastExport = nextExports;
        if (state.doc) {
          state.doc.lastExport = nextExports;
        }
      }
      setStatus(result?.message || 'SCC exported.');
    } catch (err) {
      console.error('SCC export failed', err);
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
