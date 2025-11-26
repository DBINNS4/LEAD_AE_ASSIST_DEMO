// ✅ Shared scope for testing
let el = {};
let logs = [];
let expanded = false;
let userInteracted = false;

function initLogViewer() {
  console.log("✅ renderer.log-viewer.js loaded");

  // ─── Log Viewer: panel overview tooltip ───────────────────────────────────
  const overviewTooltip = document.getElementById('log-viewer-overview-tooltip');
  if (overviewTooltip && !overviewTooltip.dataset.bound) {
    overviewTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">LOG VIEWER OVERVIEW</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What this panel is for</span>
          <ul class="tooltip-list">
            <li>Inspect the history of ingest, transcode, automation, and utility jobs.</li>
            <li>Filter logs by date range, tool, and severity level.</li>
            <li>Export logs for support, documentation, or archival.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Quick workflow</span>
          <ul class="tooltip-list">
            <li><strong>Filter</strong> – set date range, tool, and optionally “errors only”.</li>
            <li><strong>Search</strong> – type keywords to match filenames, jobs, or messages.</li>
            <li><strong>Export</strong> – use the export controls to save TXT/JSON/CSV for hand‑off.</li>
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
    { value: 'today', label: 'Today' },
    { value: '7days', label: 'Last 7 Days' },
    { value: 'custom', label: 'Custom Range' }
  ];
  setupStyledDropdown('view-by-date', dateOpts);
  setDropdownValue('view-by-date', el.dateFilter?.value || 'today');

  const toolOpts = [
    { value: 'all', label: 'All' },
    { value: 'ingest', label: 'Ingest' },
    { value: 'transcode', label: 'Transcode' },
    { value: 'clone', label: 'Clone' },
    { value: 'organizer', label: 'Organizer' },
    { value: 'transcribe', label: 'Transcribe' },
    { value: 'adobe-utilities', label: 'Adobe Utilities' },
    { value: 'nle-utilities', label: 'NLE Utilities' }
  ];
  setupStyledDropdown('view-by-tool', toolOpts);
  setDropdownValue('view-by-tool', el.toolFilter?.value || 'all');

  const exportOpts = [
    { value: 'txt', label: 'TXT' },
    { value: 'json', label: 'JSON' },
    { value: 'csv', label: 'CSV' }
  ];
  setupStyledDropdown('export-format', exportOpts);
  setDropdownValue('export-format', el.exportFormat?.value || 'txt');


  function loadLogsFromDisk() {
    try {
      const logDir = window.electron.resolvePath('logs');
      const past = window.electron.readLogFiles(logDir);
      if (Array.isArray(past)) logs = past;
    } catch (err) {
      console.error("❌ Failed to load archived logs:", err);
    }
  }

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    setTimeout(() => el.toast.classList.remove("show"), 2000);
  }

  function showInitMessage() {
    if (!el.logView) return;
    el.logView.textContent = '';
    const initP = document.createElement('p');
    initP.style.color = 'green';
    initP.textContent = '🧪 Log Viewer Initialized';
    el.logView.appendChild(initP);
  }

  showInitMessage();

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }


  function renderLogs() {
    console.log("🔁 renderLogs called");

    const container = el.logView || document.getElementById('live-log-view');
    if (!container) return;

    const tool = el.toolFilter.value;
    const showErrorsOnly = el.errorOnly.checked;
    const searchText = el.searchInput.value.toLowerCase();
    const includeSystem = el.systemLogs.checked;
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

    let filtered = logs.filter(log => {
      if (tool !== "all" && log.type !== tool) return false;
      if (showErrorsOnly && log.status !== "error" && log.status !== "warning") return false;
      if (!includeSystem && log.type === "system") return false;

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
      const searchFiltered = filtered.filter(log => {
        return JSON.stringify(log).toLowerCase().includes(searchText);
      });
      if (searchFiltered.length > 0) {
        filtered = searchFiltered;
      }
    }

    container.textContent = '';
    if (filtered.length) {
      const frag = document.createDocumentFragment();
      filtered.forEach(log => {
        frag.appendChild(createLogLineElement(log));
      });
      container.appendChild(frag);
    } else {
      container.textContent = '📭 No logs found.';
    }
  }

  function formatLogLine(log) {
    const date = new Date(log.timestamp).toLocaleString();
    const typeStr = log.type ? log.type.toUpperCase() : 'UNKNOWN';
    const summary = `[${date}] [${typeStr}] ${log.message ?? ''}`;
    if (expanded && log.detail) {
      return `${summary}<br>→ ${log.detail}`;
    }
    return summary;
  }

  function createLogLineElement(log) {
    const lineEl = document.createElement('div');
    const date = new Date(log.timestamp).toLocaleString();
    const typeStr = log.type ? log.type.toUpperCase() : 'UNKNOWN';
    const summary = `[${date}] [${typeStr}] ${log.message ?? ''}`;
    lineEl.textContent = summary;
    if (expanded && log.detail) {
      lineEl.appendChild(document.createElement('br'));
      const detailEl = document.createElement('span');
      detailEl.textContent = '→ ' + log.detail;
      lineEl.appendChild(detailEl);
    }
    return lineEl;
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
      alert('Please select export folder');
      return;
    }

    const format = el.exportFormat.value;
    let fileName = 'logs.' + format;
    let contentLines = [];

    if (format === 'json') {
      contentLines = [JSON.stringify(logs, null, 2)];
    } else if (format === 'csv') {
      const header = 'timestamp,type,message,detail,status,file';
      const csvLines = logs.map(l => [
        l.timestamp,
        l.type,
        l.message,
        l.detail || '',
        l.status || '',
        l.file || ''
      ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
      contentLines = [header, ...csvLines];
    } else {
      // txt
      contentLines = logs.map(l => formatLogLine(l).replace(/<br>/g, '\n'));
      fileName = 'logs.txt';
    }

    const fullPath = window.electron.joinPath(exportDir, fileName);
    if (writeLogToFile(contentLines, fullPath)) {
      showToast('Log exported');
    } else {
      alert('Failed to export log');
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

  // Clear display
  showInitMessage();
}

  // DEMO: Export Logs button is visual-only (hover/press).
  el.exportBtn?.addEventListener('click', () => {
    // no-op
  });
  el.resetBtn?.addEventListener('click', resetLogViewer);

  function initIpcLogs() {
    if (!ipc?.on) return;
    const panels = [
      'ingest',
      'transcode',
      'clone',
      'organizer',
      'transcribe',
      'adobe-utilities',
      'nle-utilities',
    ];
    panels.forEach(type => {
      ipc.on(`${type}-log-message`, (_e, data) => {
        logs.push({
          timestamp: Date.now(),
          type,
          message: data.msg ?? data.message ?? '',
          detail: data.detail ?? '',
          status: data.isError ? 'error' : 'info',
          file: data.fileId || ''
        });
        if (userInteracted) renderLogs();
      });
    });
  }

  el.selectExportBtn?.addEventListener("click", () => {
    // DEMO: no-op
  });

  // Repurpose: Wrap/Unwrap long lines in-place (no I/O, no re-render needed)
  if (el.expandBtn && el.logView) {
    // Optional: set a clearer label on boot
    if (!el.expandBtn.textContent?.trim()) {
      el.expandBtn.textContent = "Wrap Lines";
    }
    el.expandBtn.addEventListener("click", () => {
      const on = el.logView.classList.toggle("wrap-lines");
      el.expandBtn.setAttribute("aria-pressed", String(on));
      // Optional live label swap; keep your i18n key if you prefer
      const btnText = on ? "Unwrap Lines" : "Wrap Lines";
      if (!el.expandBtn.hasAttribute("data-i18n")) {
        el.expandBtn.textContent = btnText;
      }
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
      resetLogViewer,
      __setLogs: (mockLogs) => { logs = mockLogs; },
      __setExpanded: (val) => { expanded = val; },
      __setUserInteracted: (val) => { userInteracted = val; }
    };
  }
}

if (document.readyState !== 'loading') {
  initLogViewer();
} else {
  document.addEventListener('DOMContentLoaded', initLogViewer);
  window.addEventListener?.('DOMContentLoaded', initLogViewer);
}
