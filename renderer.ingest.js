(() => {

const watchUtils = window.watchUtils;
const presetDir = window.electron.resolvePath('config', 'presets', 'ingest');

let currentJobId = null;
const ingestPreviewEl = document.getElementById('ingest-job-preview-box');

// Build the hamster DOM structure if missing (same structure used in Adobe Automate)
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

function showIngestHamster() {
  const status = document.getElementById('ingest-job-status');
  if (!status) return;
  let wheel = status.querySelector('.wheel-and-hamster');
  if (!wheel) {
    wheel = document.createElement('div');
    wheel.className = 'wheel-and-hamster';
    status.appendChild(wheel);
  }
  ensureHamsterStructure(wheel);
  status.style.display = 'block';
  status.dataset.jobActive = 'true';
}

function hideIngestHamster() {
  const status = document.getElementById('ingest-job-status');
  if (!status) return;
  delete status.dataset.jobActive;
  status.style.display = 'none';
  status.querySelector('.wheel-and-hamster')?.remove();
}

function ensureEtaInline() {
  const host = document.getElementById('ingest-loader-inline');
  if (!host) return null;
  let eta = document.getElementById('ingest-eta-inline');
  if (!eta) {
    eta = document.createElement('span');
    eta.id = 'ingest-eta-inline';
    eta.className = 'eta-inline';
    host.appendChild(eta);
  }
  return eta;
}

function resetIngestProgressUI() {
  const bar = document.getElementById('ingest-progress');
  const out = document.getElementById('ingest-progress-output');
  if (bar) { bar.value = 0; bar.style.display = 'none'; }
  if (out) out.value = '';
  const eta = document.getElementById('ingest-eta-inline');
  if (eta) eta.textContent = '';
  hideIngestHamster();
}

async function calculateIngestBytes(cfg) {
  const res = await (window.ipc ?? window.electron).invoke('calculate-ingest-bytes', cfg);
  return {
    total: res?.total ?? 0,
    map: {},
    fileCount: res?.fileCount ?? 0,
    folderCount: res?.folderCount ?? 0
  };
}

function autoResizeTextArea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`; // ✅ allow full natural growth
}

function prettyBytes(b) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(b) || 0;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

async function updateIngestJobPreview() {
  if (!ingestPreviewEl) return;

  const cfg = gatherIngestConfig();

  // Only show a preview if we actually have a source folder or source files
  const hasSourcePath = !!(cfg.source && cfg.source.trim());
  const hasSourceFiles = Array.isArray(cfg.sourceFiles) && cfg.sourceFiles.length > 0;

  if (!hasSourcePath && !hasSourceFiles) {
    ingestPreviewEl.value = '';
    autoResizeTextArea(ingestPreviewEl);
    return;
  }

  const lines = [];

  const mode = cfg.cloneMode ? 'Clone' : 'Ingest';
  lines.push(`🧾 ${mode} Job Preview`);
  lines.push('──────────────────────────────');

  // reuse hasSourceFiles from above
  lines.push(`Source: ${cfg.source || (hasSourceFiles ? '(multiple files)' : '(not set)')}`);

  lines.push(`Destination: ${cfg.destination || '(not set)'}`);
  if (cfg.dualCopy) lines.push(`Backup: ${cfg.backupPath || '(not set)'}`);

  if (!cfg.cloneMode) {
    lines.push(`Flatten: ${cfg.flattenStructure ? 'on' : 'off'}`);
    lines.push(`Auto-folder: ${cfg.autoFolder ? 'on' : 'off'}`);
  } else {
    // no per-line folder summary; totals handled below
  }

  const method = (cfg.verification?.method || cfg.checksumMethod || 'none').toLowerCase();
  lines.push(`Verification: ${method}`);
  lines.push(`Skip duplicates: ${cfg.verification?.skipDuplicates ? 'on' : 'off'}`);

  lines.push(`Include: ${cfg.filters?.include || cfg.includeExtensions || '(none)'}`);
  lines.push(`Exclude: ${cfg.filters?.exclude || cfg.excludeExtensions || '(none)'}`);

  const threads = cfg.enableThreads
    ? (cfg.autoThreads ? 'Auto' : String(cfg.maxThreads || 1))
    : (cfg.maxThreads ?? 'Auto');
  lines.push(`Threads: ${threads}`);
  lines.push(`Retry failures: ${cfg.retryFailures ? 'on' : 'off'}`);

  lines.push(`Watch mode: ${document.getElementById('enable-watch-mode')?.checked ? 'on' : 'off'}`);
  lines.push(`n8n webhook: ${cfg.enableN8N ? (cfg.n8nUrl || '(no URL)') : 'off'}`);
  if (cfg.notes?.trim()) lines.push(`Notes: ${cfg.notes.trim()}`);

  try {
    if (cfg.cloneMode && window.cloneUtils?.calculateCloneBytes) {
      const res = await window.cloneUtils.calculateCloneBytes(cfg);
      const files = res?.fileCount ?? res?.count ?? 0;
      const folders = res?.folderCount ?? 0;
      lines.push(`Items: ${files} files, ${folders} folders`);
    } else if (typeof calculateIngestBytes === 'function') {
      const { fileCount = 0, folderCount = 0 } = await calculateIngestBytes(cfg);
      lines.push(`Items: ${fileCount} files, ${folderCount} folders`); // Removed size line for cleaner UI
    }
  } catch {}

  ingestPreviewEl.value = lines.join('\n');
  autoResizeTextArea(ingestPreviewEl);
}

function bindIngestPreviewAutoUpdate() {
  const ids = [
    'select-source','select-destination','select-backup',
    'source-path','destination-path','backup-path',
    'filter-include','filter-exclude',
    'flattenStructure','autoFolder','dualCopy',
    'checksum-method','skip-duplicates',
    'ingest-parallel','ingest-auto-threads','ingest-retry-failures',
    'concurrency-slider',
    'enable-n8n','n8n-url','n8n-log',
    'enable-watch-mode','notes',
    'enable-clone','clone-folder-filter','clone-select-all-folders','clone-show-file-count'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.previewBound) return;
    const ev = (() => {
      if (el.tagName === 'TEXTAREA') return 'input';
      if (el.tagName === 'INPUT') {
        if (['text', 'search', 'url', 'tel', 'password'].includes(el.type)) return 'input';
        if (el.type === 'range') return 'input';
        return 'change';
      }
      return 'change';
    })();
    el.addEventListener(ev, () => updateIngestJobPreview());
    el.dataset.previewBound = 'true';
  });

  const tree = document.getElementById('clone-folder-tree');
  if (tree && !tree.dataset.previewBoundTree) {
    // small debounce to avoid spamming IPC
    let t;
    const schedule = () => { clearTimeout(t); t = setTimeout(updateIngestJobPreview, 50); };
    // any checkbox in the tree
    tree.addEventListener('change', e => {
      if (e.target?.matches?.('.tree-row input[type="checkbox"]')) schedule();
    });
    // expand/collapse can change per-row count badge
    tree.addEventListener('click', e => {
      if (e.target?.classList?.contains('tree-toggle')) schedule();
    });
    // custom signal from clone tree
    tree.addEventListener('clone-selection-changed', schedule);
    tree.dataset.previewBoundTree = 'true';
  }
}


// 🧼 Collapse all <details> sections on load
  document.querySelectorAll('#ingest details').forEach(section => {
    section.open = false;
  });

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}

// ===============================
// 📋 DOM References
// ===============================
const ingestElements = {
  sourceBtn: document.getElementById('select-source'),
  destBtn: document.getElementById('select-destination'),
  backupBtn: document.getElementById('select-backup'),
  startBtn: document.getElementById('start-ingest'),
  logOutput: document.getElementById('log-output'),
  cancelBtn: document.getElementById('cancel-ingest'),

  filterInclude: document.getElementById('filter-include'),
  filterExclude: document.getElementById('filter-exclude'),

  sourcePath: document.getElementById('source-path'),
  destPath: document.getElementById('destination-path'),
  backupPath: document.getElementById('backup-path'),

  dualCopy: document.getElementById('dualCopy'),
  flattenStructure: document.getElementById('flattenStructure'),
  autoFolder: document.getElementById('autoFolder'),

  enableClone: document.getElementById('enable-clone'),
  cloneOptions: document.getElementById('clone-options'),

  checksumMethod: document.getElementById('checksum-method'),
  skipDuplicates: document.getElementById('skip-duplicates'),

  saveLog: document.getElementById('saveLog'),
  notes: document.getElementById('notes'),

  enableN8N: document.getElementById('enable-n8n'),
  n8nUrl: document.getElementById('n8n-url'),
  n8nLog: document.getElementById('n8n-log'),

  watchModeToggle: document.getElementById('enable-watch-mode'),
  watchBackupWarning: document.getElementById('watch-backup-warning'),

  enableThreads: document.getElementById('ingest-parallel'),
  autoThreads: document.getElementById('ingest-auto-threads'),
  retryFailures: document.getElementById('ingest-retry-failures'), 
  
  concurrencySlider: document.getElementById('concurrency-slider'),
  concurrencyValue: document.getElementById('concurrency-value'),
  presetSelect: document.getElementById('ingest-preset'),
  saveConfigBtn: document.getElementById('ingest-save-config'),
  loadConfigBtn: document.getElementById('ingest-load-config'),
};

function logIngest(msg, opts = {}) {
  window.logPanel?.log('ingest', msg, opts);
}

ingestElements.enableClone?.addEventListener('change', async () => {
  const enabled = ingestElements.enableClone.checked;
  document.getElementById('ingest').classList.toggle('clone-mode', enabled);
  if (ingestElements.watchModeToggle) {
    if (enabled) {
      ingestElements.watchModeToggle.checked = false;
      ingestElements.watchModeToggle.disabled = true;
      ingestElements.watchModeToggle.dispatchEvent(new Event('change'));
    } else {
      ingestElements.watchModeToggle.disabled = false;
    }
  }
  if (enabled && ingestElements.sourcePath.value) {
    const src = ingestElements.sourcePath.value;
    const result = await ipc.invoke('get-folder-tree', src);
    if (result.success) {
      const container = document.getElementById('clone-folder-tree');
      container.innerHTML = '';
      window.cloneUtils.renderFolderTree(result.tree, container);
      window.cloneUtils.updateCountsUI?.();
    }
  }
  updateIngestJobPreview();
});

// --- Select All (Clone) ---
const selectAll = document.getElementById('clone-select-all-folders');
if (selectAll) {
  selectAll.addEventListener('change', () => {
    const tree = document.getElementById('clone-folder-tree');
    if (!tree) return;
    tree.querySelectorAll('.tree-row input[type="checkbox"]').forEach(cb => {
      cb.indeterminate = false;
      cb.classList.remove('partial');
      cb.checked = selectAll.checked;
      // mark as programmatic bulk change so clone-utils will honor it
      cb.dataset.bulk = '1';
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// --- Filter folders live ---
const folderFilter = document.getElementById('clone-folder-filter');
if (folderFilter) {
  folderFilter.addEventListener('input', () => {
    const tree = document.getElementById('clone-folder-tree');
    if (!tree) return;
    const query = folderFilter.value.toLowerCase().trim();
    tree.querySelectorAll('.tree-row').forEach(row => {
      const labelText = row.querySelector('.tree-label')?.textContent?.toLowerCase() || '';
      const directMatch = !query || labelText.includes(query);
      const siblingContainer = row.nextElementSibling;
      let descendantMatch = false;
      if (!directMatch && siblingContainer?.classList.contains('tree-children')) {
        descendantMatch = Array.from(
          siblingContainer.querySelectorAll('.tree-row .tree-label')
        ).some(lbl => (lbl.textContent || '').toLowerCase().includes(query));
      }
      const shouldShow = directMatch || descendantMatch;
      row.style.display = shouldShow ? '' : 'none';
      if (siblingContainer?.classList.contains('tree-children')) {
        siblingContainer.style.display = shouldShow ? '' : 'none';
      }
    });
  });
}

// --- Show file count (Clone) ---
const showCount = document.getElementById('clone-show-file-count');
if (showCount) {
  showCount.addEventListener('change', async () => {
    window.cloneUtils.updateCountsUI?.();
    if (!showCount.checked) {
      updateIngestJobPreview();
      return;
    }

    try {
      const cfg = gatherIngestConfig();
      if (!cfg || !cfg.cloneMode) {
        updateIngestJobPreview();
        return;
      }
      if (!window.cloneUtils?.calculateCloneBytes) {
        updateIngestJobPreview();
        return;
      }
      await window.cloneUtils.calculateCloneBytes(cfg);
      updateIngestJobPreview();
    } catch (err) {
      console.error('Failed to calculate clone bytes', err);
      updateIngestJobPreview();
    }
  });
}

ingestElements.filterInclude?.addEventListener('input', () => {
  window.cloneUtils.updateCountsUI?.();
});

ingestElements.filterExclude?.addEventListener('input', () => {
  window.cloneUtils.updateCountsUI?.();
});

function enforceDataLocks() {
  document.querySelectorAll('#ingest [data-locked]').forEach(el => {
    if (el.dataset.locked === 'true') {
      el.disabled = true;
    }
  });
}

const ingestLockWrapper = document.getElementById('ingest-lock-wrapper');
const ingestLockControls = document.getElementById('ingest-lock-controls');

function setIngestControlsDisabled(state) {
  document.querySelectorAll(
    '#ingest-lock-wrapper input, #ingest-lock-wrapper select, #ingest-lock-wrapper textarea, #ingest-lock-wrapper button, #ingest-lock-controls button, #ingest-lock-concurrency input'
  ).forEach(el => {
    if (el.id === 'cancel-ingest') return;
    el.disabled = state;
  });

  document.getElementById('start-ingest').disabled = state;
  document.getElementById('reset-ingest-fields').disabled = state;

  if (state) {
    ingestLockWrapper?.classList.add('locked');
    ingestLockControls?.classList.add('locked');
  } else {
    ingestLockWrapper?.classList.remove('locked');
    ingestLockControls?.classList.remove('locked');
  }
}

function sendIngestLog(msg, isError = false) {
  logIngest(msg, { isError });
  if (!ingestElements.logOutput) return;
  if (isError || msg.includes('❌') || msg.includes('⚠️')) {
    ingestElements.logOutput.textContent += `\n${msg}`;
  }
}

// ===============================
// 🔁 Reset Logic
// ===============================
function resetIngestFields() {
  ingestElements.sourcePath.value = '';
  ingestElements.sourcePath.dataset.fileList = '[]';
  ingestElements.destPath.value = '';
  ingestElements.backupPath.value = '';

  ingestElements.dualCopy.checked = false;
  ingestElements.flattenStructure.checked = false;
  ingestElements.autoFolder.checked = false;

  ingestElements.checksumMethod.value = 'none';
  if (typeof setDropdownValue === 'function') {
    setDropdownValue('checksum-method', ingestElements.checksumMethod.value);
  }
  ingestElements.skipDuplicates.checked = false;

  ingestElements.saveLog.checked = false;

  ingestElements.enableN8N.checked = false;
  ingestElements.n8nLog.checked = false;

  ingestElements.enableThreads.checked = false;
  ingestElements.autoThreads.checked = false;
  ingestElements.retryFailures.checked = false;

  if (ingestElements.showQueueJobs) {
    ingestElements.showQueueJobs.checked = false;
  }

  ingestElements.notes.value = '';
  ingestElements.n8nUrl.value = '';

  ingestElements.concurrencySlider.value = 1;
  ingestElements.concurrencySlider.disabled = true;
  ingestElements.concurrencyValue.textContent = '1';

  // 🚫 Disable Clone Mode and clear related UI
  if (ingestElements.enableClone) {
    ingestElements.enableClone.checked = false;
  }
  const ingestPanel = document.getElementById('ingest');
  ingestPanel?.classList.remove('clone-mode');
  const cloneFilter = document.getElementById('clone-folder-filter');
  if (cloneFilter) cloneFilter.value = '';
  const cloneSelectAll = document.getElementById('clone-select-all-folders');
  if (cloneSelectAll) cloneSelectAll.checked = false;
  const cloneShowCount = document.getElementById('clone-show-file-count');
  if (cloneShowCount) cloneShowCount.checked = false;
  const cloneTreeEl = document.getElementById('clone-folder-tree');
  if (cloneTreeEl) cloneTreeEl.textContent = '📂 Folder tree will appear here...';

  if (ingestElements.logOutput) {
    ingestElements.logOutput.textContent = '';
    const span = document.createElement('span');
    span.style.color = '#6b7280';
    span.textContent = '🔄 Fields reset.';
    ingestElements.logOutput.appendChild(span);
    ingestElements.logOutput.scrollTop = ingestElements.logOutput.scrollHeight;
  }
  logIngest('🔄 Fields reset.');
  resetIngestProgressUI();
  const watchEnabled = ingestElements.watchModeToggle?.checked;
  ingestElements.cancelBtn.disabled = !watchEnabled;
  updateIngestJobPreview();
  const box = document.getElementById('ingest-job-preview-box');
  if (box) {
    box.value = '';
    box.style.height = 'auto';
  }
}

// ===============================
// 🔁 Reset Button Handler
// ===============================
document.getElementById('reset-ingest-fields')?.addEventListener('click', resetIngestFields);

// ===============================
// 📁 Folder Picker Events
// ===============================
ingestElements.sourceBtn?.addEventListener('click', async () => {
  const paths = await window.electron.selectFolderOrFiles?.();
  if (!Array.isArray(paths) || !paths.length) return;
  const stat = window.electron.statSync?.(paths[0]);
  const isDir = stat && typeof stat.isDirectory === 'function'
    ? stat.isDirectory()
    : stat?.isDirectory;
  if (paths.length === 1 && isDir) {
    ingestElements.sourcePath.value = paths[0];
    ingestElements.sourcePath.dataset.fileList = '[]';
    if (ingestElements.enableClone?.checked) {
      const src = paths[0];
      const result = await ipc.invoke('get-folder-tree', src);
      if (result.success) {
        const container = document.getElementById('clone-folder-tree');
        container.innerHTML = '';
        window.cloneUtils.renderFolderTree(result.tree, container);
        window.cloneUtils.updateCountsUI?.();
      }
    }
  } else {
    const files = paths.filter(p => {
      try {
        return !window.electron.statSync?.(p)?.isDirectory();
      } catch {
        return true;
      }
    });
    ingestElements.sourcePath.dataset.fileList = JSON.stringify(files);
    ingestElements.sourcePath.value = files.length === 1 ? files[0] : `${files.length} items selected`;
  }
  updateIngestJobPreview();
});

ingestElements.destBtn?.addEventListener('click', async () => {
  const folder = await window.electron.selectFolder?.();
  if (folder) {
    ingestElements.destPath.value = folder;
    updateIngestJobPreview();
  }
});

ingestElements.backupBtn?.addEventListener('click', async () => {
  const folder = await window.electron.selectFolder?.();
  if (folder) {
    ingestElements.backupPath.value = folder;
    if (ingestElements.dualCopy && !ingestElements.dualCopy.checked) {
      ingestElements.dualCopy.checked = true;
      ingestElements.dualCopy.dispatchEvent(new Event('change', { bubbles: true }));
    }
    updateIngestJobPreview();
  }
});

// ===============================
// ▶️ Start Ingest Task
// ===============================
ingestElements.startBtn?.addEventListener('click', async () => {
  const isWatch = document.getElementById('enable-watch-mode')?.checked;

  const cfg = gatherIngestConfig();
  logIngest(`Final clone config selectedFolders: ${cfg.selectedFolders}`);
  logIngest(`Final clone config foldersOnly: ${cfg.foldersOnly || []}`);
  if (cfg.cloneMode && (!Array.isArray(cfg.selectedFolders) || cfg.selectedFolders.length === 0)) {
    const warn = '⚠️ Select at least one folder to clone.';
    logIngest(warn, { isError: true });
    if (ingestElements.logOutput) ingestElements.logOutput.textContent = warn;
    return;
  }

  const panelLabel = cfg.cloneMode ? 'Clone' : 'Ingest';
  let total = 0;
  let map = {};
  if (cfg.cloneMode) {
    const stats = await window.cloneUtils.calculateCloneBytes(cfg);
    total = stats.total;
  } else {
    ({ total, map } = await calculateIngestBytes(cfg));
  }
  const panel = cfg.cloneMode ? 'clone' : 'ingest';
  const job = {
    config: cfg,
    expectedCopyBytes: total,
    expectedBackupBytes: cfg.dualCopy ? total : 0,
    fileSizeMap: cfg.cloneMode ? {} : map
  };

  if (isWatch) {
    const result = await watchUtils.startWatch(panel, cfg);
    sendIngestLog?.(result);
    setIngestControlsDisabled(true);
    ingestElements.cancelBtn.disabled = false;
    return;
  }

  const queueMsg = `🚀 Queuing ${panelLabel.toLowerCase()} job...`;
  logIngest(queueMsg);
  if (ingestElements.logOutput) {
    ingestElements.logOutput.textContent = queueMsg;
  }
  setIngestControlsDisabled(true);
  try {
    currentJobId = await ipc.invoke('queue-add-ingest', job);
    // 🔧 Start processing immediately (no UI lag)
    await ipc.invoke('queue-start');
    const queuedMsg = `🗳️ ${panelLabel} job queued.`;
    logIngest(queuedMsg);
    if (ingestElements.logOutput) {
      ingestElements.logOutput.textContent = queuedMsg;
    }
  } catch (err) {
    const errMsg = `❌ Queue error: ${err.message}`;
    logIngest(errMsg, { isError: true });
    if (ingestElements.logOutput) {
      ingestElements.logOutput.textContent = errMsg;
    }
  }

  ingestElements.cancelBtn.disabled = false;
});


// ===============================
// 🤖 Backend Triggered Field Sync
// ===============================
if (ipc?.on) {
  ipc.on('toggle-fields', (_event, changes) => {
    let summary = '⚙️ Backend updated fields:\n';

    for (const [fieldId, value] of Object.entries(changes)) {
      const field = document.getElementById(fieldId);

      if (field && typeof field.checked !== 'undefined') {
        field.checked = value;
        summary += `✔️ ${fieldId} set to ${value}\n`;
      } else if (field && typeof field.value === 'string') {
        field.value = value;
        summary += `📝 ${fieldId} set to "${value}"\n`;
      }
    }

    logIngest(summary);
    if (ingestElements.logOutput) {
        ingestElements.logOutput.textContent += '\n' + summary;
      }
    updateIngestJobPreview();
  });
}

ingestElements.cancelBtn?.addEventListener('click', async () => {
  if (ingestElements.cancelBtn.textContent.includes('Stop Watching')) {
    const panel = ingestElements.enableClone?.checked ? 'clone' : 'ingest';
    await watchUtils.stopWatch(panel);
    const result = await window.electron.cancelIngest?.();
    sendIngestLog(`🛑 Watch Mode stopped and ${panel} cancelled.`);
    if (result) sendIngestLog(result);

    setIngestControlsDisabled(false);
    ingestElements.startBtn.disabled = false;
    ingestElements.cancelBtn.disabled = true;
    ingestElements.startBtn.textContent = 'Start';
    ingestElements.cancelBtn.textContent = 'Cancel';
    ingestElements.watchModeToggle.checked = false;
    ingestElements.watchModeToggle.dispatchEvent(new Event('change'));
    return;
  }

  const confirmCancel = window.confirm("⚠️ Are you sure you want to cancel the ingest?");
  if (!confirmCancel) return;

  logIngest('🛑 Cancel requested...');
  if (ingestElements.logOutput) {
    ingestElements.logOutput.textContent += '\n🛑 Cancel requested...';
  }
  try {
    await ipc.invoke('queue-cancel-job', currentJobId);
    currentJobId = null;
    resetIngestFields();
  } catch (err) {
    const errMsg = `❌ Cancel error: ${err.message}`;
    logIngest(errMsg, { isError: true });
    if (ingestElements.logOutput) {
      ingestElements.logOutput.textContent += `\n❌ Cancel error: ${err.message}`;
    }
  }
});


// ✅ Run immediately — DOM is already loaded at this point
const slider = document.getElementById('concurrency-slider');
const label = document.getElementById('concurrency-value');
const enableThreads = document.getElementById('ingest-parallel');
const autoThreads = document.getElementById('ingest-auto-threads');

let updateControls = () => {};

if (slider && label) {
  updateControls = () => {
    const enabled = enableThreads?.checked;
    const auto = autoThreads?.checked;
    if (slider) slider.disabled = !enabled || auto;
    if (!enabled) {
      if (slider) slider.value = '1';
      label.textContent = '1';
    } else if (auto) {
      label.textContent = 'Auto';
    } else {
      label.textContent = slider.value;
    }
  };

  slider.addEventListener('input', () => {
    if (!autoThreads?.checked) label.textContent = slider.value;
  });
  enableThreads?.addEventListener('change', updateControls);
  autoThreads?.addEventListener('change', updateControls);  
  
// Set initial value
  updateControls();
}

function initIngestPanel(resetDefaults = false) {
  enforceDataLocks();
  if (!ingestElements.checksumMethod.value || resetDefaults) {
    ingestElements.checksumMethod.value = 'none';
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
    setupStyledDropdown('checksum-method', checksumOptions);
    ingestElements.checksumMethod.value = 'none';
    if (typeof setDropdownValue === 'function') {
      setDropdownValue('checksum-method', ingestElements.checksumMethod.value);
    }
  }

  // Match Adobe Automate tooltip text exactly
  const ingestTooltip = document.querySelector('#ingest #verification-logging-tooltip');
  if (ingestTooltip) {
    ingestTooltip.innerHTML = `
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

  // Cancel should start disabled until an ingest is running
  ingestElements.cancelBtn.disabled = true;

  watchUtils.initWatchToggle({
    checkboxId: 'enable-watch-mode',
    startBtnId: 'start-ingest',
    cancelBtnId: 'cancel-ingest',
    onToggle: isWatch => {
      // ... existing watch toggle logic ...
      if (ingestElements.sourceBtn) {
        ingestElements.sourceBtn.textContent = isWatch ? 'Select Watch Folder' : 'Select Source';
      }
      if (ingestElements.backupBtn) {
        ingestElements.backupBtn.disabled = isWatch;
      }
      if (ingestElements.backupPath) {
        if (isWatch) {
          ingestElements.backupPath.dataset.prev = ingestElements.backupPath.value;
          ingestElements.backupPath.value = '';
        } else if (ingestElements.backupPath.dataset.prev) {
          ingestElements.backupPath.value = ingestElements.backupPath.dataset.prev;
        }
        ingestElements.backupPath.disabled = isWatch;
      }
      if (ingestElements.watchBackupWarning) {
        ingestElements.watchBackupWarning.style.display = isWatch ? '' : 'none';
      }
      if (ingestElements.dualCopy) {
        if (isWatch) {
          ingestElements.dualCopy.dataset.prev = ingestElements.dualCopy.checked ? 'true' : 'false';
          ingestElements.dualCopy.checked = false;
        } else if (ingestElements.dualCopy.dataset.prev) {
          ingestElements.dualCopy.checked = ingestElements.dualCopy.dataset.prev === 'true';
        }
        ingestElements.dualCopy.disabled = isWatch;
      }
      if (enableThreads && autoThreads) {
        if (isWatch) {
          enableThreads.dataset.prev = enableThreads.checked ? 'true' : 'false';
          autoThreads.dataset.prev = autoThreads.checked ? 'true' : 'false';
          enableThreads.checked = false;
          autoThreads.checked = false;
          enableThreads.disabled = true;
          autoThreads.disabled = true;
        } else {
          if (!enableThreads.dataset.locked) enableThreads.disabled = false;
          if (!autoThreads.dataset.locked) autoThreads.disabled = false;
          if (enableThreads.dataset.prev)
            enableThreads.checked = enableThreads.dataset.prev === 'true';
          if (autoThreads.dataset.prev)
            autoThreads.checked = autoThreads.dataset.prev === 'true';
        }
        updateControls();
      }
    }
  });

  // Clone Mode tooltip – matches Ingest panel tooltip behavior
  const cloneModeTooltip = document.querySelector('#ingest #clone-mode-tooltip');
  if (cloneModeTooltip && !cloneModeTooltip.dataset.bound) {
    cloneModeTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">CLONE MODE OVERVIEW</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What Clone Mode does</span>
          <ul class="tooltip-list">
            <li>Treats the source as a folder tree instead of a flat file list.</li>
            <li>Only copies the folders you select in the Clone tree.</li>
            <li>Preserves original folder structure at the destination.</li>
            <li>Still respects your include/exclude extension filters and verification settings.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Controls in this row</span>
          <ul class="tooltip-list">
            <li><strong>Filter</strong> - type text to narrow the folder tree by name.</li>
            <li><strong>Select All</strong> - select/deselect every folder in the tree.</li>
            <li><strong>Show File Count</strong> - show per-folder file counts (slower on huge trees).</li>
          </ul>
        </div>
      </div>
    `;
    cloneModeTooltip.dataset.bound = 'true';
  }

  // Top-right Ingest overview tooltip (matches Adobe Automate style)
  const ingestOverviewTooltip = document.querySelector('#ingest #ingest-overview-tooltip');
  if (ingestOverviewTooltip && !ingestOverviewTooltip.dataset.bound) {
    ingestOverviewTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">INGEST PANEL OVERVIEW</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What this panel is for</span>
          <ul class="tooltip-list">
            <li>Securely copy camera cards or source folders to your main project volume.</li>
            <li>Optionally send a second copy to a backup volume.</li>
            <li>Filter which files or folders are included in the ingest.</li>
            <li>Control verification and logging for every ingest job.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Quick workflow</span>
          <ul class="tooltip-list">
            <li><strong>Input</strong> - choose the card, drive, or watch folder you want to ingest.</li>
            <li><strong>Output</strong> - set the destination and (optionally) a backup path.</li>
            <li><strong>File Handling</strong> - configure includes/excludes, clone filters, and threading.</li>
            <li><strong>Verification & Logging</strong> - pick a verification method and enable log files.</li>
            <li><strong>Automation</strong> - toggle webhooks/log forwarding if you're wiring into n8n/ops.</li>
            <li><strong>Run</strong> - click <em>Start Ingest</em> and watch the Job Preview + status log.</li>
          </ul>
        </div>
      </div>
    `;
    ingestOverviewTooltip.dataset.bound = 'true';
  }

  refreshPresetDropdown();
  // ⛔ Do not auto-populate the job preview on first load
  bindIngestPreviewAutoUpdate();
}

if (document.readyState !== 'loading') {
  initIngestPanel(false);
} else {
  // Listen on both window and document so tests can dispatch the event
  const handler = () => initIngestPanel(true);
  document.addEventListener('DOMContentLoaded', handler);
  window.addEventListener?.('DOMContentLoaded', handler);
  // Fallback for test environments where DOMContentLoaded may not fire
  initIngestPanel(true);
}

// 💾 Save and Load Preset
function gatherIngestConfig() {
  const selectedMethod = ingestElements.checksumMethod?.value || 'none';
  const skipDuplicates = ingestElements.skipDuplicates?.checked;

  const enableThreads = ingestElements.enableThreads?.checked;
  const autoThreads = ingestElements.autoThreads?.checked;
  let maxThreads;
  if (!enableThreads) maxThreads = 1;
  else if (autoThreads) maxThreads = null;
  else maxThreads = parseInt(ingestElements.concurrencySlider.value, 10);

  let sourceFiles = [];
  try {
    sourceFiles = JSON.parse(ingestElements.sourcePath.dataset.fileList || '[]');
  } catch {
    sourceFiles = [];
  }

  const cfg = {
    source: ingestElements.sourcePath.value,
    sourceFiles,
    destination: ingestElements.destPath.value,
    backup: ingestElements.dualCopy.checked,
    backupPath: ingestElements.backupPath.value,
    dualCopy: ingestElements.dualCopy.checked,
    flattenStructure: ingestElements.flattenStructure.checked,
    autoFolder: ingestElements.autoFolder.checked,
    saveLog: ingestElements.saveLog.checked,
    verbose: false,
    notes: ingestElements.notes.value,
    enableN8N: ingestElements.enableN8N.checked,
    n8nUrl: ingestElements.n8nUrl.value,
    n8nLog: ingestElements.n8nLog.checked,
    watchFolder: ingestElements.sourcePath.value,
    verification: {
      useChecksum: !['none', 'bytecompare'].includes(selectedMethod),
      method: selectedMethod,
      skipDuplicates,
      compareByte: selectedMethod === 'bytecompare',
      useSha256: selectedMethod === 'sha256',
      useMd5: selectedMethod === 'md5',
      useBlake3: selectedMethod === 'blake3',
      useXxhash64: selectedMethod === 'xxhash64'
    },
    filters: {
      include: ingestElements.filterInclude.value,
      exclude: ingestElements.filterExclude.value
    },
    enableThreads,
    autoThreads,
    maxThreads,
    retryFailures: ingestElements.retryFailures.checked,
    useDoneFlag: document.getElementById('enable-watch-mode')?.checked
  };

  if (ingestElements.enableClone?.checked) {
    const { selectedFolders, foldersOnly, excludedFolders, includeSourceRoot } =
      window.cloneUtils.getSelectedFolders(cfg.source);
    cfg.cloneMode = true;
    cfg.selectedFolders = selectedFolders;
    cfg.foldersOnly = foldersOnly;
    cfg.excludedFolders = excludedFolders; // <- new: tell backend what to skip
    cfg.includeSourceRoot = includeSourceRoot;
    cfg.excludeExtensions = ingestElements.filterExclude.value;
    cfg.includeExtensions = ingestElements.filterInclude.value;
    cfg.flatten = cfg.flattenStructure;
    cfg.skipExisting = skipDuplicates;
    cfg.checksum = !['none', 'bytecompare'].includes(selectedMethod);
    cfg.checksumMethod = selectedMethod;
    cfg.byteCompare = selectedMethod === 'bytecompare';
    cfg.useDoneFlag = false;
  }

  return cfg;
}

function applyIngestPreset(data) {
  if (ingestElements.sourcePath) {
    ingestElements.sourcePath.value = data.source || '';
    if (Array.isArray(data.sourceFiles)) {
      ingestElements.sourcePath.dataset.fileList = JSON.stringify(data.sourceFiles);
      ingestElements.sourcePath.value = data.sourceFiles.length === 1 ? data.sourceFiles[0] : `${data.sourceFiles.length} items selected`;
    } else {
      ingestElements.sourcePath.dataset.fileList = '[]';
    }
  }
  if (ingestElements.destPath) ingestElements.destPath.value = data.destination || '';
  if (ingestElements.backupPath) ingestElements.backupPath.value = data.backupPath || '';
  if (ingestElements.dualCopy) ingestElements.dualCopy.checked = !!data.dualCopy;
  if (ingestElements.flattenStructure) ingestElements.flattenStructure.checked = !!data.flattenStructure;
  if (ingestElements.autoFolder) ingestElements.autoFolder.checked = !!data.autoFolder;
  if (ingestElements.checksumMethod) {
    let method = data.verification?.method || 'none';
    if (data.verification?.compareByte) method = 'bytecompare';
    ingestElements.checksumMethod.value = method;
    if (typeof setDropdownValue === 'function') {
      setDropdownValue('checksum-method', method);
    }
  }
  if (ingestElements.skipDuplicates) ingestElements.skipDuplicates.checked = !!data.verification?.skipDuplicates;
  if (ingestElements.saveLog) ingestElements.saveLog.checked = !!data.saveLog;
  if (ingestElements.notes) ingestElements.notes.value = data.notes || '';
  if (ingestElements.filterInclude) ingestElements.filterInclude.value = data.filters?.include || '';
  if (ingestElements.filterExclude) ingestElements.filterExclude.value = data.filters?.exclude || '';
  if (ingestElements.enableN8N) ingestElements.enableN8N.checked = !!data.enableN8N;
  if (ingestElements.n8nUrl) ingestElements.n8nUrl.value = data.n8nUrl || '';
  if (ingestElements.n8nLog) ingestElements.n8nLog.checked = !!data.n8nLog;
  if (ingestElements.enableThreads) ingestElements.enableThreads.checked = !!data.enableThreads;
  if (ingestElements.autoThreads) ingestElements.autoThreads.checked = !!data.autoThreads;
  if (ingestElements.concurrencySlider)
    ingestElements.concurrencySlider.value = data.maxThreads ?? '1';
  if (ingestElements.retryFailures) ingestElements.retryFailures.checked = !!data.retryFailures;
  if (ingestElements.concurrencySlider)
    ingestElements.concurrencySlider.disabled =
      !ingestElements.enableThreads?.checked || ingestElements.autoThreads?.checked;
  if (ingestElements.concurrencyValue)
    ingestElements.concurrencyValue.textContent = ingestElements.autoThreads?.checked
      ? 'Auto'
      : ingestElements.concurrencySlider?.value;

  if (ingestElements.enableClone) {
    ingestElements.enableClone.checked = !!data.cloneMode;
    document.getElementById('ingest').classList.toggle('clone-mode', !!data.cloneMode);
    if (ingestElements.watchModeToggle) {
      if (data.cloneMode) {
        ingestElements.watchModeToggle.checked = false;
        ingestElements.watchModeToggle.disabled = true;
      } else {
        ingestElements.watchModeToggle.disabled = false;
      }
    }
    if (data.cloneMode) {
      if (ingestElements.filterExclude) {
        ingestElements.filterExclude.value =
          data.excludeExtensions || data.filters?.exclude || '';
      }
    }
  }
  updateIngestJobPreview();
}

function isWatchConfigValid(cfg) {
  if (!cfg) return 'No ingest config found.';
  const missing = [];
  if (cfg.dualCopy && !cfg.backupPath) missing.push('Backup Path');
  if (!cfg.verification?.method) missing.push('Checksum Method');
  if (!cfg.filters) missing.push('Filters');
  if (cfg.enableThreads && !cfg.autoThreads && !cfg.maxThreads) missing.push('Thread Count');
  return missing.length ? `Missing: ${missing.join(', ')}` : true;
}

if (window.watchValidators) {
  window.watchValidators.ingest = isWatchConfigValid;
}

function refreshPresetDropdown() {
  const hidden = ingestElements.presetSelect;
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
  setupStyledDropdown('ingest-preset', opts);
  setDropdownValue('ingest-preset', hidden.value || '');
  window.translatePage?.();
}

// ✅ Auto-refresh preset dropdown when presets are saved or deleted
if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('preset-saved', (_e, panelId) => {
    if (panelId === 'ingest') refreshPresetDropdown();
  });
  ipc.on('preset-deleted', (_e, panelId) => {
    if (panelId === 'ingest') refreshPresetDropdown();
  });
}

ingestElements.presetSelect?.addEventListener('change', () => {
  const file = ingestElements.presetSelect.value;
  if (!file) return;
  try {
    const raw = window.electron.readTextFile(window.electron.joinPath(presetDir, file));
    const data = JSON.parse(raw);
    applyIngestPreset(data);
  } catch (err) {
    console.error('Failed to load preset', err);
  }
});

// expose for testing and external access
if (typeof globalThis !== 'undefined') {
  globalThis.gatherIngestConfig = gatherIngestConfig;
  globalThis.initIngestPanel = initIngestPanel;
  globalThis.applyIngestPreset = applyIngestPreset; // expose for tests
  globalThis.refreshPresetDropdown = refreshPresetDropdown;
}

ingestElements.saveConfigBtn?.addEventListener('click', async () => {
  const cfg = gatherIngestConfig();
  const file = await ipc.saveFile({
    title: 'Save Preset',
    defaultPath: window.electron.joinPath(presetDir, 'ingest-config.json')
  });
  if (file) {
    ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
    ipc.send('preset-saved', 'ingest');
    refreshPresetDropdown();
    alert('Config saved.');
  }
});

ingestElements.loadConfigBtn?.addEventListener('click', async () => {
  const file = await ipc.openFile({ title: 'Load Preset' });
  if (!file) return;
  try {
    const data = JSON.parse(ipc.readTextFile(file));
    applyIngestPreset(data);
  } catch (err) {
    alert('Failed to load config: ' + err.message);
  }
});

if (typeof ipc !== 'undefined' && ipc.on) {
  ['ingest', 'clone'].forEach(type => {
    ipc.on(`${type}-log-message`, (_e, { msg, isError }) => {
      if (!isError) return;
      if (ingestElements.logOutput) {
        const br = document.createElement('br');
        const span = document.createElement('span');
        span.style.color = 'red';
        span.textContent = `❌ ${msg}`;
        ingestElements.logOutput.appendChild(br);
        ingestElements.logOutput.appendChild(span);
      }
    });
  });

  ipc.on('watch-log', (_event, msg) => {
    logIngest(msg);
    if (ingestElements.logOutput) {
        ingestElements.logOutput.textContent += `\n${msg}`;
        ingestElements.logOutput.scrollTop = ingestElements.logOutput.scrollHeight;
      }
    });

  ipc.on('queue-job-start', (_e, job) => {
    if (job.panel !== 'ingest') return;
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (bar) { bar.value = 0; bar.style.display = 'block'; }
    if (out) out.value = '';
    ensureEtaInline();
    showIngestHamster();
  });

  ipc.on('queue-job-progress', (_event, payload) => {
    if (payload.panel !== 'ingest') return;
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (!bar || !out) return;

    if (typeof payload.percent === 'number') {
      const isWatchMode = ingestElements.watchModeToggle?.checked;
      const pct = isWatchMode && typeof payload.filePercent === 'number'
        ? payload.filePercent
        : payload.percent;

      bar.style.display = pct >= 100 ? 'none' : 'block';
      bar.value = Math.max(0, Math.min(100, pct));
      out.value = pct >= 100 ? '' : Math.round(pct);

      const etaEl = ensureEtaInline();
      if (etaEl) {
        const showEta = !isWatchMode && pct < 100 && payload.eta;
        etaEl.textContent = showEta ? ` • ETA ${payload.eta}` : '';
      }

    }

    showIngestHamster();

    if (payload.file && payload.status?.copied) {
      logIngest(`✅ Copied ${payload.file}`);
    }
  });
  ipc.on('queue-job-complete', (_e, job) => {
    if (job.panel !== 'ingest') return;
    currentJobId = null;
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (bar) { bar.value = 100; bar.style.display = 'none'; }
    if (out) out.value = '';
    const eta = document.getElementById('ingest-eta-inline');
    if (eta) eta.textContent = '';
    hideIngestHamster();
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    if (!isWatchMode) {
      setIngestControlsDisabled(false);
    } else {
      ingestElements.cancelBtn.disabled = false;
    }
  });
  ipc.on('queue-job-failed', (_e, job) => {
    if (job.panel !== 'ingest') return;
    currentJobId = null;
    resetIngestProgressUI();
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    if (!isWatchMode) {
      setIngestControlsDisabled(false);
    } else {
      ingestElements.cancelBtn.disabled = false;
    }
  });
  ipc.on('queue-job-cancelled', (_e, job) => {
    if (job.panel !== 'ingest') return;
    currentJobId = null;
    resetIngestProgressUI();
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    if (!isWatchMode) {
      setIngestControlsDisabled(false);
    } else {
      ingestElements.cancelBtn.disabled = false;
    }
    resetIngestFields();
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    gatherIngestConfig: globalThis.gatherIngestConfig,
    isWatchConfigValid,
    initIngestPanel: globalThis.initIngestPanel,
    applyIngestPreset,
    refreshPresetDropdown
  };
}

})();
