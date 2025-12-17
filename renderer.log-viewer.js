// ✅ Shared scope for testing
let el = {};
let logs = [];
const LOG_RENDER_LIMIT = Number.parseInt(window.LOG_VIEWER_RENDER_LIMIT ?? 500, 10) || 500;
// Keep an in-memory retention cap to avoid unbounded log growth, independent of render cap.
const DEFAULT_RETENTION_LIMIT = 5000;
const rawRetention = window.LOG_VIEWER_RETENTION_LIMIT ?? DEFAULT_RETENTION_LIMIT;
const parsedRetention = Number.parseInt(rawRetention, 10);
const LOG_RETENTION_LIMIT = Number.isFinite(parsedRetention) && parsedRetention > 0
  ? parsedRetention
  : Infinity; // Allow unlimited retention via 0/negative/NaN.
let expanded = false;
let userInteracted = false;
let logViewerInitialized = false;
let renderTimeout = null;
let wrapLinesPreferred = false;
let syncExpandUi = () => {};
let isLoadingLogs = false;
let hasLoadedLogs = false;
let loadLogsPromise = null;

function initLogViewer() {
  if (logViewerInitialized) return;
  logViewerInitialized = true;

  console.log("✅ renderer.log-viewer.js loaded");

  const ipcBridge = typeof ipc === 'undefined' ? window.ipc ?? window.electron : ipc;

  const translate = (key, fallback) => {
    const t = window.i18n?.t;
    if (typeof t === "function") {
      const translated = t(key);
      if (translated) return translated;
    }
    return fallback;
  };

  const withLimit = (text) => (typeof text === 'string'
    ? text.replace(/{{limit}}/g, LOG_RENDER_LIMIT)
    : text);

  // ─── Log Viewer: panel overview tooltip ───────────────────────────────────
  const overviewTooltip = document.getElementById('log-viewer-overview-tooltip');
  if (overviewTooltip && !overviewTooltip.dataset.bound) {
    overviewTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">LOG VIEWER — Technical Overview</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Core capabilities</span>
          <ul class="tooltip-list">
            <li>Aggregates ingest, transcode, automation, NLE utility, and system logs in one place.</li>
            <li>Filters by date range, tool, severity, and free-text search.</li>
            <li>Exports filtered views to TXT/JSON/CSV for support, QC, or documentation.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Inputs / outputs</span>
          <ul class="tooltip-list">
            <li>Inputs: rolling log files emitted by the Assist backend and panels.</li>
            <li>Outputs: on-screen filtered view plus optional export files on disk.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Under the hood</span>
          <ul class="tooltip-list">
            <li>Reads log files from the app’s log directory and keeps an in-memory retention window.</li>
            <li>Normalizes messages by panel / type so filters behave consistently across tools.</li>
            <li>Export uses the same filtered set that is rendered, not the entire archive.</li>
          </ul>
        </div>
      </div>
    `;
    overviewTooltip.dataset.bound = 'true';
  }

  el = {
    dateFilter: document.getElementById("view-by-date"),
    startDate: document.getElementById("log-start-date"),
    endDate: document.getElementById("log-end-date"),
    toolFilter: document.getElementById("view-by-tool"),
    errorOnly: document.getElementById("show-errors-only"),
    systemLogs: document.getElementById("include-system-logs"),
    searchInput: document.getElementById("log-search"),
    expandBtn: document.getElementById("expand-task-details"),
    logView: document.getElementById("live-log-view"),
    exportFormat: document.getElementById("export-format"),
    exportBtn: document.getElementById("export-log-btn"),
    exportPathInput: document.getElementById("export-folder-path"),
    selectExportBtn: document.getElementById("select-export-folder"),
    toast: document.getElementById("log-toast"),
    resetBtn: document.getElementById("reset-log-viewer")
  };

  const dateOpts = [
    { value: 'today', label: translate('logViewerDateToday', 'Today') },
    { value: '7days', label: translate('logViewerDateLast7Days', 'Last 7 Days') },
    { value: 'custom', label: translate('logViewerDateCustomRange', 'Custom Range') }
  ];
  setupStyledDropdown('view-by-date', dateOpts);
  setDropdownValue('view-by-date', el.dateFilter?.value || 'today');

  const toolOpts = [
    { value: 'all', label: translate('logViewerToolAll', 'All') },
    { value: 'ingest', label: translate('logViewerToolIngest', 'Ingest') },
    { value: 'transcode', label: translate('logViewerToolTranscode', 'Transcode') },
    { value: 'clone', label: translate('logViewerToolClone', 'Clone') },
    { value: 'organizer', label: translate('logViewerToolOrganizer', 'Organizer') },
    { value: 'transcribe', label: translate('logViewerToolTranscribe', 'Transcribe') },
    { value: 'adobe-utilities', label: translate('logViewerToolAdobeUtilities', 'Adobe Utilities') },
    { value: 'nle-utilities', label: translate('logViewerToolNleUtilities', 'NLE Utilities') },
    { value: 'comparison', label: translate('logViewerToolComparison', 'Comparison') },
    { value: 'resolution', label: translate('logViewerToolResolution', 'Resolution') },
    { value: 'system', label: translate('logViewerToolSystem', 'System') }
  ];
  setupStyledDropdown('view-by-tool', toolOpts);
  setDropdownValue('view-by-tool', el.toolFilter?.value || 'all');

  const exportOpts = [
    { value: 'txt', label: translate('logViewerExportTxt', 'TXT') },
    { value: 'json', label: translate('logViewerExportJson', 'JSON') },
    { value: 'csv', label: translate('logViewerExportCsv', 'CSV') }
  ];
  setupStyledDropdown('export-format', exportOpts);
  setDropdownValue('export-format', el.exportFormat?.value || 'txt');


  async function loadLogsFromDisk() {
    if (isLoadingLogs && loadLogsPromise) return loadLogsPromise;

    isLoadingLogs = true;
    renderLogs();

    try {
      const logDir = window.electron.resolvePath('logs');
      const loader = ipcBridge?.invoke
        ? ipcBridge.invoke('log-viewer:read-log-files', logDir)
        : Promise.resolve(window.electron.readLogFiles(logDir));

      loadLogsPromise = loader;
      const past = await loader;
      logs = Array.isArray(past) ? past : [];
      enforceRetentionLimit();
      hasLoadedLogs = true;
    } catch (err) {
      console.error("❌ Failed to load archived logs:", err);
    } finally {
      isLoadingLogs = false;
      loadLogsPromise = null;
      renderLogs();
    }

    return logs;
  }

  function enforceRetentionLimit() {
    if (!Number.isFinite(LOG_RETENTION_LIMIT)) return;
    const excess = logs.length - LOG_RETENTION_LIMIT;
    if (excess > 0) {
      sortLogsByTimestamp();
      logs.splice(LOG_RETENTION_LIMIT);
    }
  }

  function sortLogsByTimestamp() {
    logs.sort((a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0));
  }

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    setTimeout(() => el.toast.classList.remove("show"), 2000);
  }

  const debugUiEnabled = Boolean(window.DEBUG_UI || window.electron?.DEBUG_UI);

  function showInitMessage() {
    if (!el.logView) return;
    el.logView.textContent = '';
    const initP = document.createElement('p');
    initP.style.color = 'green';
    initP.textContent = '🧪 Log Viewer Initialized';
    el.logView.appendChild(initP);
  }

  if (debugUiEnabled) {
    showInitMessage();
  }

  loadLogsFromDisk();


  function getFilteredLogs() {
    const tool = el.toolFilter.value;
    const showErrorsOnly = el.errorOnly.checked;
    const searchText = el.searchInput.value.toLowerCase();
    const includeSystem = el.systemLogs.checked || tool === 'system';
    const dateRange = el.dateFilter.value;
    const now = Date.now();
    const startDateVal = el.startDate?.value;
    const endDateVal = el.endDate?.value;
    const parseDate = (d, end) => {
      const ts = Date.parse(d + (end ? 'T23:59:59.999' : 'T00:00:00'));
      return Number.isNaN(ts) ? null : ts;
    };
    const startDate = startDateVal ? parseDate(startDateVal, false) : null;
    const endDate = endDateVal ? parseDate(endDateVal, true) : null;

    sortLogsByTimestamp();
    let filtered = logs.filter(log => {
      if (!includeSystem && log.type === 'system' && tool !== 'system') return false;
      if (tool !== "all" && log.type !== tool) return false;
      if (showErrorsOnly && log.status !== "error" && log.status !== "warning") return false;

      if (dateRange === 'today') {
        const logDate = new Date(log.timestamp);
        if (logDate.toDateString() !== new Date().toDateString()) return false;
      } else if (dateRange === '7days') {
        if (now - log.timestamp > 7 * 24 * 60 * 60 * 1000) return false;
      } else if (dateRange === 'custom') {
        if (startDate && log.timestamp < startDate) return false;
        if (endDate && log.timestamp > endDate) return false;
      }

      return true;
    });

    if (searchText) {
      filtered = filtered.filter(log =>
        JSON.stringify(log).toLowerCase().includes(searchText)
      );
    }

    sortLogsByTimestamp();
    return filtered;
  }

  function renderLogs() {
    console.log("🔁 renderLogs called");

    const container = el.logView || document.getElementById('live-log-view');
    if (!container) return;

    if (isLoadingLogs) {
      container.textContent = translate('logViewerLoading', '⏳ Loading logs…');
      return;
    }

    if (!hasLoadedLogs && logs.length === 0) {
      container.textContent = translate('logViewerEmpty', '📭 No logs yet.');
      return;
    }

    const filtered = getFilteredLogs();
    const renderLimited = LOG_RENDER_LIMIT > 0 ? filtered.slice(0, LOG_RENDER_LIMIT) : filtered;

    container.textContent = '';
    if (renderLimited.length) {
      const frag = document.createDocumentFragment();
      renderLimited.forEach(log => {
        frag.appendChild(createLogLineElement(log));
      });
      container.appendChild(frag);
      if (filtered.length > renderLimited.length) {
        const notice = document.createElement('div');
        notice.className = 'log-entry log-info';
        const limitText = translate(
          'logViewerRenderLimited',
          `Showing first ${LOG_RENDER_LIMIT} results on screen. Export uses your full filtered set.`
        );
        notice.textContent = withLimit(limitText);
        container.appendChild(notice);
      }
    } else {
      container.textContent = translate('logViewerNoResults', '📭 No logs found.');
    }
  }

  function formatLogLine(log) {
    const date = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';

    if (log.status && log.file) {
      const typeStr = log.type ? log.type.toUpperCase() : 'UNKNOWN';
      const summary = `[${date}] [${typeStr}] ${log.message ?? ''}`;
      if (expanded && log.detail) {
        return `${summary}<br>→ ${log.detail}`;
      }
      return summary;
    }

    const level = (log.level || 'info').toUpperCase();
    const parts = [date, log.panel || log.type || '', log.jobId || '', log.stage || '', level]
      .filter(Boolean)
      .map(p => `[${p}]`);
    const summary = `${parts.join(' ')} ${log.message ?? ''}`;
    if (expanded && (log.detail || log.meta)) {
      const metaStr = log.detail || JSON.stringify(log.meta || {});
      return `${summary}<br>→ ${metaStr}`;
    }
    return summary;
  }

  function createLogLineElement(log) {
    const lineEl = document.createElement('div');

    if (log.status && log.file) {
      const date = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';
      const typeStr = log.type ? log.type.toUpperCase() : 'UNKNOWN';
      lineEl.className = `log-entry log-${log.status || 'info'}`;
      lineEl.textContent = `[${date}] [${typeStr}] ${log.message ?? ''}`;
      if (expanded && log.detail) {
        lineEl.appendChild(document.createElement('br'));
        const detailEl = document.createElement('span');
        detailEl.textContent = '→ ' + log.detail;
        lineEl.appendChild(detailEl);
      }
      return lineEl;
    }

    const level = (log.level || 'info').toLowerCase();
    const date = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';
    const parts = [date, log.panel || log.type || '', log.jobId || '', log.stage || '', level.toUpperCase()]
      .filter(Boolean)
      .map(p => `[${p}]`);
    lineEl.className = `log-entry log-${level}`;
    lineEl.textContent = `${parts.join(' ')} ${log.message ?? ''}`;
    if (expanded && (log.detail || log.meta)) {
      lineEl.appendChild(document.createElement('br'));
      const detailEl = document.createElement('span');
      detailEl.textContent = '→ ' + (log.detail || JSON.stringify(log.meta || {}));
      lineEl.appendChild(detailEl);
    }
    return lineEl;
  }

  function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
      renderTimeout = null;
      renderLogs();
    }, 100);
  }

  function writeLogToFile(lines, targetPath) {
    try {
      window.electron.writeTextFile(targetPath, lines.join('\n'));
      return true;
    } catch (err) {
      console.error('❌ Failed to write log file', err);
      return false;
    }
  }

  function exportLog() {
    const exportDir = el.exportPathInput.value;
    if (!exportDir) {
      alert(translate('logViewerSelectExportFolder', 'Please select export folder'));
      return;
    }

    const format = el.exportFormat.value;
    let fileName = 'logs.' + format;
    let contentLines = [];
    const filtered = getFilteredLogs();

    if (format === 'json') {
      contentLines = [JSON.stringify(filtered, null, 2)];
    } else if (format === 'csv') {
      const csvHeader = [
        'timestamp',
        'panel',
        'type',
        'level',
        'jobId',
        'stage',
        'message',
        'detail',
        'meta',
        'status',
        'file'
      ];

      const csvLines = filtered.map(l => {
        const values = [
          l.timestamp,
          l.panel || l.type || '',
          l.type || l.panel || '',
          l.level || '',
          l.jobId || '',
          l.stage || '',
          l.message,
          l.detail || '',
          typeof l.meta === 'string' ? l.meta : (l.meta ? JSON.stringify(l.meta) : ''),
          l.status || '',
          l.file || ''
        ];

        return values
          .map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"')
          .join(',');
      });

      contentLines = [csvHeader.join(','), ...csvLines];
    } else {
      // txt
      contentLines = filtered.map(l => formatLogLine(l).replace(/<br>/g, '\n'));
      fileName = 'logs.txt';
    }

    const fullPath = window.electron.joinPath(exportDir, fileName);
    if (writeLogToFile(contentLines, fullPath)) {
      showToast(translate('logViewerExportSuccess', 'Log exported'));
    } else {
      alert(translate('logViewerExportFailure', 'Failed to export log'));
    }
  }

function resetLogViewer() {
  // Clear logs and UI
  logs.length = 0;
  expanded = false;

  userInteracted = false;
  if (el.dateFilter) {
    el.dateFilter.value = 'today';
    setDropdownValue('view-by-date', 'today');
  }
  if (el.startDate) el.startDate.value = '';
  if (el.endDate) el.endDate.value = '';
  updateDateVisibility();
  if (el.toolFilter) {
    el.toolFilter.value = 'all';
    setDropdownValue('view-by-tool', 'all');
  }
  if (el.errorOnly) el.errorOnly.checked = false;
  if (el.systemLogs) el.systemLogs.checked = false;
  if (el.searchInput) el.searchInput.value = '';
  if (el.exportFormat) {
    el.exportFormat.value = 'txt';
    setDropdownValue('export-format', 'txt');
  }
  if (el.exportPathInput) el.exportPathInput.value = '';

  syncExpandUi();
  loadLogsFromDisk();
  renderLogs();
}

  el.exportBtn?.addEventListener('click', exportLog);
  el.resetBtn?.addEventListener('click', resetLogViewer);

  function initIpcLogs() {
    if (!ipcBridge?.on) return;
    const panels = [
      'ingest',
      'transcode',
      'clone',
      'organizer',
      'transcribe',
      'adobe-utilities',
      'nle-utilities',
      'comparison',
      'resolution',
      'system'
    ];
    panels.forEach(type => {
      ipcBridge.on(`${type}-log-message`, (_e, data) => {
        const level = data.level || (data.isWarning ? 'warn' : data.isError ? 'error' : 'info');
        const status =
          level === 'error' || data.isError
            ? 'error'
            : level === 'warn' || data.isWarning
              ? 'warning'
              : 'info';
        logs.push({
          timestamp: Date.now(),
          type,
          message: data.msg ?? data.message ?? '',
          detail: data.detail ?? '',
          status,
          level,
          file: data.fileId || ''
        });
        enforceRetentionLimit();
        scheduleRender();
      });
    });
  }

  el.selectExportBtn?.addEventListener("click", async () => {
    if (!ipcBridge?.selectFolder) {
      showToast(translate('logViewerFolderPickerUnavailable', 'Folder selection unavailable in this environment'));
      return;
    }
    const folder = await ipcBridge?.selectFolder?.();
    if (folder) el.exportPathInput.value = folder;
  });

  if (el.expandBtn && el.logView) {
    wrapLinesPreferred = el.logView.classList.contains("wrap-lines");
    syncExpandUi = () => {
      if (!el.expandBtn || !el.logView) return;
      el.expandBtn.setAttribute("aria-pressed", String(expanded));
      const labelKey = expanded ? "collapseTaskDetails" : "expandTaskDetails";
      el.expandBtn.setAttribute("data-i18n", labelKey);
      el.expandBtn.textContent = translate(
        labelKey,
        expanded ? "Collapse Task Details" : "Expand Task Details"
      );
      el.logView.classList.toggle("wrap-lines", expanded || wrapLinesPreferred);
    };

    syncExpandUi();

    el.expandBtn.addEventListener("click", () => {
      expanded = !expanded;
      syncExpandUi();
      renderLogs();
    });
  }

  [el.dateFilter, el.toolFilter, el.errorOnly, el.searchInput, el.systemLogs, el.startDate, el.endDate].forEach(control => {
    control?.addEventListener("change", () => {
      if (logs.length === 0) {
        loadLogsFromDisk();
      }
      userInteracted = true;
      renderLogs();
    });

    control?.addEventListener("input", () => {
      if (logs.length === 0) {
        loadLogsFromDisk();
      }
      userInteracted = true;
      renderLogs();
    });
  });

  function updateDateVisibility() {
    const isCustom = el.dateFilter.value === 'custom';
    if (el.startDate) el.startDate.classList.toggle('hidden', !isCustom);
    if (el.endDate) el.endDate.classList.toggle('hidden', !isCustom);
  }

  el.dateFilter?.addEventListener('change', () => {
    updateDateVisibility();
  });
  // ensure initial visibility state without triggering other change handlers
  updateDateVisibility();

  initIpcLogs();

  // Export inner functions after they're defined
  if (typeof module !== 'undefined') {
    module.exports = {
      el,
      renderLogs,
      formatLogLine,
      exportLog,
      getFilteredLogs,
      resetLogViewer,
      __setLogs: (mockLogs) => { logs = mockLogs; enforceRetentionLimit(); },
      __setExpanded: (val) => { expanded = val; },
      __setUserInteracted: (val) => { userInteracted = val; }
    };
  }
}

if (document.readyState !== 'loading') {
  initLogViewer();
} else {
  document.addEventListener('DOMContentLoaded', initLogViewer);
}
