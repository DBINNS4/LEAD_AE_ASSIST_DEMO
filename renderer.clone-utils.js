(function () {
  const ipc = window.ipc ?? window.electron;
  let cloneStatsCache = { count: 0, total: 0, fileCount: 0, folderCount: 0 };

  const folderStateMap = new Map(); // path -> 'none' | 'folders-only' | 'full'
  const pathToRow = new Map();

  const BLUE = 'blue';
  const RED = 'red';
  const OFF = 'off';

  const selection = {
    blue: new Set(),
    red: new Set(),
    off: new Set()
  };

  function syncSelectionGlobals() {
    if (typeof window === 'undefined') return;
    window.cloneSelectedFolders = Array.from(selection.blue);
    window.cloneFoldersOnly = Array.from(selection.red);
    window.cloneExcluded = Array.from(selection.off);
  }

  syncSelectionGlobals();

  function applyCheckboxVisual(path, state, checkboxEl) {
    const selector = `.folder-tree input[type="checkbox"][data-path="${CSS.escape(path)}"]`;
    const el = checkboxEl || document.querySelector(selector);
    if (!el) return;
    if (state === BLUE) {
      setRowUIFromState(el, 'full');
    } else if (state === RED) {
      setRowUIFromState(el, 'folders-only');
    } else {
      setRowUIFromState(el, 'none');
    }
  }

  function getState(path) {
    if (selection.blue.has(path)) return BLUE;
    if (selection.red.has(path)) return RED;
    if (selection.off.has(path)) return OFF;
    return OFF;
  }

  function updateMapsForState(path, state) {
    if (!path) return;
    if (state === BLUE) {
      folderStateMap.set(path, 'full');
    } else if (state === RED) {
      folderStateMap.set(path, 'folders-only');
    } else if (selection.off.has(path)) {
      folderStateMap.set(path, 'none');
    } else {
      folderStateMap.delete(path);
    }
  }

  function setState(path, state) {
    selection.blue.delete(path);
    selection.red.delete(path);
    selection.off.delete(path);
    if (state === BLUE) {
      selection.blue.add(path);
    } else if (state === RED) {
      selection.red.add(path);
    } else {
      selection.off.add(path);
    }
    updateMapsForState(path, state);
    applyCheckboxVisual(path, state);
  }

  function listAncestors(path) {
    if (!path) return [];
    const parts = path.split(/[\\/]+/);
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const ancestors = [];
    for (let i = parts.length - 1; i > 0; i--) {
      const slice = parts.slice(0, i);
      if (!slice.length) continue;
      let candidate = slice.join(sep);
      if (!candidate && !useBackslash && path.startsWith('/')) candidate = '/';
      if (candidate) ancestors.push(candidate);
    }
    return ancestors;
  }

  function listDescendants(path) {
    if (!path) return [];
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    const selector = `.folder-tree input[type="checkbox"][data-path^="${CSS.escape(prefix)}"]`;
    return Array.from(document.querySelectorAll(selector))
      .map(el => el.dataset.path)
      .filter(Boolean);
  }

  function hasSelectedDescendant(path) {
    if (!path) return false;
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    const check = candidate => candidate && candidate !== path && candidate.startsWith(prefix);
    for (const p of selection.blue) {
      if (check(p)) return true;
    }
    for (const p of selection.red) {
      if (check(p)) return true;
    }
    return false;
  }

  function handleFolderClick(path) {
    const current = getState(path);
    if (current === OFF) {
      // BLUE here (include this folder), make ancestors RED to keep the path,
      // but DO NOT force descendants OFF. We want BLUE to propagate down by default.
      setState(path, BLUE);
      for (const anc of listAncestors(path)) {
        if (getState(anc) === OFF) setState(anc, RED);
      }
      return;
    }
    if (current === RED) {
      // Promote RED→BLUE to include THIS folder’s files (still no descendants).
      const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
      if (hasDirectFiles(row)) setState(path, BLUE);
      return;
    }
    if (current === BLUE) {
      // Third click → OFF; also turn off descendants and prune ancestors with no selected descendants.
      setState(path, OFF);
      for (const kid of listDescendants(path)) setState(kid, OFF);
      for (const anc of listAncestors(path)) {
        if (!hasSelectedDescendant(anc)) setState(anc, OFF);
      }
    }
  }

  function restoreSelectionFromGlobals() {
    selection.blue.clear();
    selection.red.clear();
    selection.off.clear();
    const blue = Array.isArray(window.cloneSelectedFolders) ? window.cloneSelectedFolders : [];
    const red = Array.isArray(window.cloneFoldersOnly) ? window.cloneFoldersOnly : [];
    const off = Array.isArray(window.cloneExcluded) ? window.cloneExcluded : [];
    blue.forEach(p => selection.blue.add(p));
    red.forEach(p => selection.red.add(p));
    off.forEach(p => selection.off.add(p));
  }

  document.addEventListener('change', event => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.matches('.folder-tree input[type="checkbox"][data-path]')) return;
    const path = el.dataset.path;
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();

    if (el.dataset.bulk === '1') {
      delete el.dataset.bulk;
      const targetState = el.checked ? BLUE : OFF;
      setState(path, targetState);
    } else {
      handleFolderClick(path);
    }

    syncSelectionGlobals();
    notifySelectionChanged();
    updateCountsUI();
    if (typeof window.recomputeCloneBytes === 'function') {
      window.recomputeCloneBytes();
    }
  });

  function normalizePathForCompare(p) {
    return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  }

  function setRowUIFromState(cb, state) {
    if (!cb) return;
    if (state === 'folders-only') setTriState(cb, 'partial'); // 🔴 red
    else if (state === 'full') setTriState(cb, 'checked'); // 🔵 blue
    else setTriState(cb, 'unchecked'); // ☐ off
  }

  // 🔍 Helper: does this folder contain direct files (not subfolders)?
  function hasDirectFiles(row) {
    if (!row) return true;
    const info = folderCountCache.get(row.dataset?.path);
    if (info) return info.direct > 0;
    return true;
  }
  const folderCountCache = new Map();
  let lastRenderedTree = null;

  function parseExtension(name = '') {
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx).toLowerCase() : '';
  }

  function normalizeExtensions(extString = '') {
    return extString
      .split(',')
      .map(str => str.trim().toLowerCase().replace(/^\*/, ''))
      .filter(Boolean)
      .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));
  }

  function shouldCountFile(filename, includeExts, excludeExts) {
    const ext = parseExtension(filename);
    if (includeExts.length && !includeExts.includes(ext)) return false;
    if (excludeExts.includes(ext)) return false;
    return true;
  }

  function buildCountsIndex(node, includeExts, excludeExts) {
    if (!node || typeof node !== 'object') return { direct: 0, total: 0 };

    let direct = 0;
    let total = 0;
    const children = Array.isArray(node.children) ? node.children : [];

    for (const child of children) {
      const type = child?.type || (Array.isArray(child?.children) && child.children.length ? 'directory' : 'file');
      if (type === 'file') {
        if (shouldCountFile(child?.name || '', includeExts, excludeExts)) {
          direct += 1;
        }
      } else if (type === 'directory') {
        const subCounts = buildCountsIndex(child, includeExts, excludeExts);
        total += subCounts.total;
      }
    }

    total += direct;
    if (node.path) {
      folderCountCache.set(node.path, { direct, total });
    }

    return { direct, total };
  }

  function computeAllCounts(rootNode) {
    folderCountCache.clear();
    if (!rootNode) return;

    const cfg = (globalThis.gatherIngestConfig && globalThis.gatherIngestConfig()) || {};
    const includeExts = normalizeExtensions(cfg.includeExtensions || cfg.filters?.include || '');
    const excludeExts = normalizeExtensions(cfg.excludeExtensions || cfg.filters?.exclude || '');

    buildCountsIndex(rootNode, includeExts, excludeExts);
  }

  function ensureBadge(row) {
    if (!row) return null;
    let badge = row.querySelector('.tree-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tree-count';
      row.appendChild(badge);
    }
    return badge;
  }

  function setRowCountBadge(row, isOpen) {
    if (!row) return;
    const badge = ensureBadge(row);
    if (!badge) return;

    const showBadge = !!document.getElementById('clone-show-file-count')?.checked;
    badge.style.display = showBadge ? '' : 'none';
    if (!showBadge) {
      badge.textContent = '';
      return;
    }

    const counts = folderCountCache.get(row.dataset?.path);
    if (!counts) {
      badge.textContent = '';
      return;
    }

    const value = isOpen ? counts.direct : counts.total;
    badge.textContent = `(${value ?? 0})`;
  }

  function updateCountsUI() {
    const treeEl = document.getElementById('clone-folder-tree');
    if (!treeEl) return;

    if (!lastRenderedTree) {
      treeEl.querySelectorAll('.tree-row').forEach(row => {
        const badge = row.querySelector('.tree-count');
        if (badge) {
          badge.style.display = 'none';
          badge.textContent = '';
        }
      });
      return;
    }

    computeAllCounts(lastRenderedTree);

    treeEl.querySelectorAll('.tree-row').forEach(row => {
      const isOpen = !!getChildrenContainer(row)?.classList?.contains('open');
      setRowCountBadge(row, isOpen);
    });
  }

  function setTriState(cb, state) {
    if (!cb) return;
    // No indeterminate UI: "partial" = checked + .partial (red styling in CSS)
    cb.indeterminate = false;
    cb.classList.remove('partial');
    if (state === 'checked') {
      cb.checked = true;
    } else if (state === 'partial') {
      cb.checked = true;
      cb.classList.add('partial');
    } else {
      cb.checked = false;
    }
  }

  function renderFolderTree(node, container, depth = 0) {
    if (depth === 0) {
      folderStateMap.clear();
      lastRenderedTree = node;
      pathToRow.clear();
      restoreSelectionFromGlobals();
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const folderChildren = children.filter(ch => {
      const t = ch.type || (Array.isArray(ch.children) && ch.children.length ? 'directory' : 'file');
      return t === 'directory';
    });

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node?.path || '';
    if (node?.path) {
      pathToRow.set(node.path, row);
    }
    row.dataset.type = 'directory';

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = folderChildren.length ? '▶' : ' ';
    row.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = folderChildren.length ? '📂' : '📁';
    row.appendChild(icon);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.path = node?.path || '';
    row.appendChild(checkbox);

    const currentState = node?.path ? getState(node.path) : OFF;
    if (node?.path) {
      updateMapsForState(node.path, currentState);
    }
    applyCheckboxVisual(node?.path || '', currentState, checkbox);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);

    ensureBadge(row);

    container.appendChild(row);

    let childContainerEl;
    if (folderChildren.length) {
      childContainerEl = document.createElement('div');
      childContainerEl.className = 'tree-children';

      toggle.addEventListener('click', () => {
        const isOpen = childContainerEl.classList.toggle('open');
        toggle.textContent = isOpen ? '▼' : '▶';
        icon.textContent = isOpen ? '📁' : '📂';
        setRowCountBadge(row, isOpen);
      });

      folderChildren.forEach(child =>
        renderFolderTree(child, childContainerEl, depth + 1)
      );
      container.appendChild(childContainerEl);
    }

    row.dataset.hasChildren = !!folderChildren.length;

    const isOpen = !!getChildrenContainer(row)?.classList?.contains('open');
    setRowCountBadge(row, isOpen);
  }

  // Helper: find the actual children container for a row (or null)
  function getChildrenContainer(row) {
    const sib = row?.nextElementSibling;
    return sib && sib.classList && sib.classList.contains('tree-children') ? sib : null;
  }

  function notifySelectionChanged() {
    document.getElementById('clone-folder-tree')
      ?.dispatchEvent(new CustomEvent('clone-selection-changed', { bubbles: true }));
  }

  function getSelectedFolders() {
    const unique = arr => Array.from(new Set(arr));
    const denest = arr =>
      arr.filter((p, i) => !arr.some((q, j) =>
        j !== i && normalizePathForCompare(p).startsWith(normalizePathForCompare(q) + '/')
      ));

    const selectedFolders = unique(Array.from(selection.blue));
    const foldersOnly = unique(Array.from(selection.red));
    const excludedFolders = denest(Array.from(selection.off));

    return {
      selectedFolders,
      foldersOnly,
      excludedFolders,
      selectedFiles: [],
      includeSourceRoot: false
    };
  }

  const presetDir = window.electron.resolvePath('config', 'presets', 'clone');

  function refreshPresetDropdown() {
    const hidden = document.getElementById('clone-preset');
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
    setupStyledDropdown('clone-preset', opts);
    setDropdownValue('clone-preset', hidden.value || '');
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
          applyClonePreset(data);
        } catch (err) {
          console.error('Failed to load preset', err);
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  function applyClonePreset(data) {
    const srcEl = document.getElementById('clone-source-path');
    if (srcEl) srcEl.value = data.source || data.sourcePath || '';
    const destEl = document.getElementById('clone-dest-path');
    if (destEl) destEl.value = data.destination || data.destPath || '';
    const skip = document.getElementById('clone-skip-existing');
    if (skip) skip.checked = !!data.skipExisting;
    const flat = document.getElementById('clone-flatten');
    if (flat) flat.checked = !!data.flatten;
    const rem = document.getElementById('clone-remove-empty');
    if (rem) rem.checked = !!data.removeEmptyFolders;
    const chk = document.getElementById('clone-checksum');
    if (chk) chk.checked = !!data.checksum;
    const method = document.getElementById('clone-checksum-method');
    if (method) method.value = data.checksumMethod || 'blake3';
    const save = document.getElementById('clone-save-log');
    if (save) save.checked = !!data.saveLog;
    const byteCompare = document.getElementById('clone-byte-compare');
    if (byteCompare) byteCompare.checked = !!data.byteCompare;
    const retry = document.getElementById('clone-retry-failures');
    if (retry) retry.checked = !!data.retryFailures;
    const exclExt = document.getElementById('clone-exclude-ext');
    if (exclExt) exclExt.value = data.excludeExtensions || '';
    const exclPat = document.getElementById('clone-exclude-pattern');
    if (exclPat) exclPat.value = data.excludePatterns || '';
    const par = document.getElementById('clone-parallel');
    const auto = document.getElementById('clone-auto-threads');
    if (par) par.checked = data.maxThreads !== 1;
    if (auto) auto.checked = data.maxThreads == null;
    const threadSlider = document.getElementById('clone-max-threads');
    if (threadSlider) threadSlider.value = data.maxThreads || '3';
    const threadCount = document.getElementById('clone-thread-count');
    if (threadSlider && threadCount) {
      if (!par?.checked) threadCount.textContent = '1';
      else if (auto?.checked) threadCount.textContent = 'Auto';
      else threadCount.textContent = threadSlider.value;
    }
    const notesEl = document.getElementById('clone-notes');
    if (notesEl) notesEl.value = data.notes || '';
  }

  function buildCloneConfig(opts = {}) {
    const get = id => document.getElementById(id);
    const val = id => get(id)?.value;
    const checked = id => get(id)?.checked;
    const srcId = opts.sourceId || 'clone-source-path';
    const destId = opts.destId || 'clone-dest-path';
    const destPath = val(destId);
    if (!destPath || !window.electron.fileExists(destPath)) {
      // Abort if destination is missing or doesn't exist
      alert('❌ Please select a valid destination folder.');
      return null;
    }
    return {
      source: val(srcId),
      destination: destPath,
      createIfMissing: true,
      skipExisting: checked(opts.skipExistingId || 'clone-skip-existing'),
      flatten: checked(opts.flattenId || 'clone-flatten'),
      preserveTimestamps: true,
      removeEmptyFolders: checked(opts.removeEmptyId || 'clone-remove-empty'),
      checksum: checked(opts.checksumId || 'clone-checksum'),
      checksumMethod: val(opts.checksumMethodId || 'clone-checksum-method') || 'blake3',
      verbose: false,
      saveLog: checked(opts.saveLogId || 'clone-save-log'),
      maxThreads: get(opts.parallelId || 'clone-parallel')?.checked
        ? get(opts.autoThreadsId || 'clone-auto-threads')?.checked
          ? null
          : parseInt(val(opts.maxThreadsId || 'clone-max-threads') || '3', 10)
        : 1,
      byteCompare: checked(opts.byteCompareId || 'clone-byte-compare'),
      retryFailures: checked(opts.retryId || 'clone-retry-failures'),
      backup: document.getElementById('dualCopy')?.checked,
      backupPath: document.getElementById('backup-path')?.value,
      ...getSelectedFolders(val(srcId)),
      excludeExtensions: val(opts.excludeExtId || 'clone-exclude-ext'),
      excludePatterns: val(opts.excludePatternId || 'clone-exclude-pattern'),
      notes: val(opts.notesId || 'clone-notes'),
      cloneMode: true
    };
  }

  async function calculateCloneBytes(cfg) {
    try {
      const res = await ipc.invoke('calculate-clone-bytes', cfg);
      if (res?.success) {
        const total = res.total ?? 0;
        const fileCount = res.fileCount ?? res.count ?? 0;
        const folderCount = res.folderCount ?? 0;
        cloneStatsCache = { total, fileCount, folderCount, count: fileCount };
      }
    } catch {
      // ignore errors
    }
    return cloneStatsCache;
  }

  function getCachedCloneStats() {
    return cloneStatsCache;
  }

  async function queueCloneJob(opts = {}) {
    const config = buildCloneConfig(opts);
    const descriptor = {
      config,
      expectedCopyBytes: cloneStatsCache.total || 0,
      expectedBackupBytes: config.backup ? cloneStatsCache.total || 0 : 0,
      fileSizeMap: {}
    };
    const jobId = await ipc.invoke('queue-add-ingest', descriptor);
    await ipc.invoke('queue-start');
    return jobId;
  }

  function initClonePanel() {
    const checkbox = document.getElementById('clone-show-queue');
    const table = document.getElementById('clone-status-table');
    const header = document.getElementById('clone-queue-header');
    if (checkbox && table && header) {
      const update = () => {
        const show = checkbox.checked;
        table.style.display = show ? '' : 'none';
        header.style.display = show ? '' : 'none';
      };
      checkbox.addEventListener('change', update);
      update();
    }
    refreshPresetDropdown();
  }

  const api = {
    initClonePanel,
    buildCloneConfig,
    calculateCloneBytes,
    getCachedCloneStats,
    refreshPresetDropdown,
    applyClonePreset,
    getSelectedFolders,
    renderFolderTree,
    queueCloneJob,
    updateCountsUI
  };

  if (typeof window !== 'undefined') {
    window.cloneUtils = api;
  }
  if (typeof module !== 'undefined') {
    module.exports = api;
  }
})();
