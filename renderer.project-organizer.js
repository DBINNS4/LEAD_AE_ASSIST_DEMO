(() => {

const electron = window.electron ?? {};
const ipc = window.ipc ?? electron;

const el = {
  folderList: document.getElementById('folder-list'),
  addCustomFolder: document.getElementById('add-custom-folder'),
  addSubfolder: document.getElementById('organizer-add-subfolder'),
  customFolderName: document.getElementById('custom-folder-name'),
  resetButton: document.getElementById('reset-project-organizer'),
  generateButton: document.getElementById('generate-project-folders'),
  summary: document.getElementById('project-summary'),
  outputPath: document.getElementById('output-location-path'),
  outputBtn: document.getElementById('select-output-location'),
  rootName: document.getElementById('root-folder-name'),
  prependNumbers: document.getElementById('prepend-numbers'),
  presetSelect: document.getElementById('organizer-preset'),
  saveConfig: document.getElementById('organizer-save-config'),
  loadConfig: document.getElementById('organizer-load-config'),
};

function logOrganizer(msg, opts = {}) {
  window.logPanel?.log('organizer', msg, opts);
}

// Prevent default browser behavior when files are dragged over the document
// or dropped outside of explicit targets. This ensures the app doesn't
// inadvertently navigate away or open files in the browser context.
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types?.includes?.('Files')) {
    event.preventDefault();
  }
});

document.addEventListener('drop', event => {
  if (event.dataTransfer?.types?.includes?.('Files')) {
    event.preventDefault();
  }
});


function updateFolderAssetPaths() {
  const newAssets = {};

  function recurse(parent, parentPath = '') {
    const items = parent.querySelectorAll(':scope > li.draggable-item');
    const possibleOldKeys = Object.keys(folderAssets);

    items.forEach(li => {
      const id = li.dataset.id;
      const localId = id.split('/').pop();
      const currentPath = parentPath ? `${parentPath}/${localId}` : id;

      const subList = li.querySelector('ul');
      if (subList) {
        recurse(subList, currentPath);
      }

      // Match only exact folder IDs
      for (const oldKey of possibleOldKeys) {
        if (oldKey === id || oldKey === currentPath) {
          if (!newAssets[currentPath]) newAssets[currentPath] = [];
          newAssets[currentPath].push(...folderAssets[oldKey]);
          break;
        }
      }
    });
  }

  recurse(el.folderList);

  // Replace old mapping
  Object.keys(folderAssets).forEach(key => delete folderAssets[key]);
  Object.assign(folderAssets, newAssets);
}


let selectedFolders = [];
let customFolders = [];
const folderAssets = {}; // key = folder ID, value = array of file paths
let draggedChildren = [];

const defaultFolders = [
  { id: 'PROJECT', label: 'Project files', groupId: 'PROJECT' },
  { id: 'MEDIA', label: 'Media: camera, audio, stills', groupId: 'MEDIA' },
  { id: 'EDITOR', label: 'Editor workspace', groupId: 'EDITOR' },
  { id: 'ASSIST', label: 'Assistant editor materials', groupId: 'ASSIST' },
  { id: 'GFX', label: 'Graphics / VFX', groupId: 'GFX' },
  { id: 'MUSIC', label: 'Music', groupId: 'MUSIC' },
  { id: 'SFX', label: 'Sound FX', groupId: 'SFX' },
  { id: 'MIX', label: 'Mix / Stems', groupId: 'MIX' },
  { id: 'COLOR', label: 'Color', groupId: 'COLOR' },
  { id: 'ONLINE', label: 'Online / Conform', groupId: 'ONLINE' },
  { id: 'QC', label: 'QC notes', groupId: 'QC' },
  { id: 'EXPORTS', label: 'Exports / Deliverables', groupId: 'EXPORTS' }
];

// Preserve pristine list for full reset capability
const originalDefaultFolders = JSON.parse(JSON.stringify(defaultFolders));

// Track current order of folders. Start with the default order.
let folderOrder = defaultFolders.map(f => f.id);

// 🧩 Build folder checkboxes
function renderFolderList() {
  el.folderList.innerHTML = '';

  const all = [...defaultFolders, ...customFolders];
  const map = new Map(all.map(f => [f.id, f]));

  if (folderOrder.length === 0) {
    folderOrder = all.map(f => f.id).sort((a, b) => a.localeCompare(b));
  } else {
    folderOrder = folderOrder.filter(id => map.has(id));
    all.forEach(f => {
      if (!folderOrder.includes(f.id)) folderOrder.push(f.id);
    });
  }

  folderOrder.forEach(id => {
    const folder = map.get(id);
    if (!folder) return;

    const li = document.createElement('li');
    li.className = 'draggable-item';
    li.dataset.id = folder.id;
    // Group ID always reflects the top-most root folder
    li.dataset.groupId = folder.id.split('/')[0];

    const depth = folder.id.split('/').length - 1;

    const container = document.createElement('div');
    container.className = 'folder-row';
    // Adobe Automate behavior: indent the ENTIRE <li> by depth,
    // while the row itself stays compact & right-aligned via CSS.
    li.style.marginLeft = `${depth * 40}px`;

    const labelSpan = document.createElement('span');

    if (depth > 0) {
      li.classList.add('subfolder');
      li.dataset.root = 'false';
      li.draggable = false; // 🔒 Disable dragging for subfolders
      container.classList.add('subfolder');
      labelSpan.textContent = '↳ ' + folder.id.split('/').pop();
    } else {
      li.draggable = true;
      li.dataset.root = 'true';
      li.addEventListener('dragstart', handleDragStart);
      labelSpan.textContent = folder.id;
    }

    if (folder.label) labelSpan.title = folder.label;

    const actions = document.createElement('div');
    actions.className = 'folder-actions';

    container.appendChild(labelSpan);
    container.appendChild(actions);
    li.appendChild(container);

    // Allow dropping files directly onto this folder node
    li.addEventListener('dragover', ev => {
      if (ev.dataTransfer?.types?.includes?.('Files')) {
        ev.preventDefault();
      }
    });

    li.addEventListener('drop', ev => {
      if (ev.dataTransfer?.types?.includes?.('Files')) {
        ev.preventDefault();
        const files = [...(ev.dataTransfer.files || [])];
        const targetId = li.dataset.id;
        if (!folderAssets[targetId]) folderAssets[targetId] = [];
        folderAssets[targetId].push(
          ...files.map(f => f.path).filter(Boolean)
        );
        updateSummary();
        updateAttachmentIndicators();
      }
    });

    // ➕ Add files button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-files-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add files';
    addBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      let files = await ipc.selectFiles?.();
      if (!files?.length) return;

      // 🔧 Normalize if raw filePaths were returned instead of { path }
      if (typeof files[0] === 'string') {
        files = files.map(p => ({ path: p }));
      }

      const targetId = li.dataset.id;
      if (!folderAssets[targetId]) folderAssets[targetId] = [];
      folderAssets[targetId].push(...files.map(f => f.path).filter(Boolean));
      updateSummary();
      updateAttachmentIndicators();
    });

    actions.appendChild(addBtn);

    const folderId = folder.id;

    // ➖ Remove files button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-files-btn';
    removeBtn.textContent = '-';
    removeBtn.title = folderAssets[folderId]?.length > 0
     ? 'Remove attached files'
     : (folder.id.includes('/') ? 'Remove this subfolder' : 'No files to remove');

    removeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const targetId = li.dataset.id;
      const hasFiles = folderAssets[targetId]?.length > 0;

      if (hasFiles) {
        delete folderAssets[targetId];
        updateSummary();
        updateAttachmentIndicators();
      } else {
        // 🧹 Handle root folder and all nested subfolders
        const idsToRemove = folderOrder.filter(
          id => id === targetId || id.startsWith(`${targetId}/`)
        );

        li.style.transition = 'opacity 0.3s ease';
        li.style.opacity = '0';

        setTimeout(() => {
          idsToRemove.forEach(id => {
            customFolders = customFolders.filter(f => f.id !== id);
            const defaultIdx = defaultFolders.findIndex(f => f.id === id);
            if (defaultIdx !== -1) defaultFolders.splice(defaultIdx, 1);
            folderOrder = folderOrder.filter(f => f !== id);
            delete folderAssets[id];
          });

          renderFolderList();
          updateSelectedFolders();
        }, 300);
      }
    });

    actions.appendChild(removeBtn);
    
    // 📎 Paperclip goes to the LEFT of the buttons inside .folder-actions
    if (folderAssets[folderId]?.length) {
      const clip = document.createElement('span');
      clip.className = 'attachment-indicator';
      clip.textContent = '📎';
      clip.title = `${folderAssets[folderId].length} attached file(s)`;
      actions.insertBefore(clip, actions.firstChild);
    }
    
li.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) return;

  // 🛠 Make root folders draggable again on click
  if (li.dataset.root === 'true') {
    li.setAttribute('draggable', 'true');
  } else {
    li.removeAttribute('draggable');
  }

  // 🧹 Deselect all
  el.folderList.querySelectorAll('li.draggable-item').forEach(item => {
    item.classList.remove('selected');
  });

  // ✅ Select the clicked item
  li.classList.add('selected');

  // 🔁 Update selection tracking
  updateSelectedFolders();
});

// 🧲 Drag end only on root folders
if (depth === 0) {
  li.addEventListener('dragend', handleDragEnd);
}

    el.folderList.appendChild(li);
  }); // ✅ <- This was missing

  updateAttachmentIndicators();
}

function handleDragStart(e) {
  const li = e.target.closest('li.draggable-item');
  if (!li || li.dataset.root !== 'true') {
    e.preventDefault();
    return;
  }

  const groupId = li.dataset.groupId;
  li.classList.add('dragging');

  // Collect ALL nested subfolders under this root, preserving order
const rootPrefix = groupId + '/';
const allItems = [...el.folderList.querySelectorAll('li.draggable-item')];
draggedChildren = allItems.filter(item =>
  item.dataset.id.startsWith(rootPrefix) && item.dataset.id !== li.dataset.id
 );
}

async function handleDragEnd() {
  const dragging = el.folderList.querySelector('.dragging');
  if (dragging) dragging.classList.remove('dragging');
  draggedChildren = [];

  folderOrder = [...el.folderList.querySelectorAll('li.draggable-item')].map(li => li.dataset.id);  

  updateSelectedFolders();
  updateFolderAssetPaths();

  const allItems = [...el.folderList.querySelectorAll('li.draggable-item')];
  folderOrder = allItems.map(li => li.dataset.id);

  const idMap = Object.fromEntries(customFolders.map(f => [f.id, f]));
  customFolders = await Promise.all(folderOrder.map(async id => {
    const folder = idMap[id];
    if (!folder) return null;
    const li = allItems.find(li => li.dataset.id === folder.id);
    if (!li) return folder;

    // Compute depth from the folder path (PROJECT/Child/Subchild => depth 0/1/2)
    const depth = li.dataset.id.split('/').length - 1;
    const isRootLevel = depth === 0;
    const isNested = folder.id.includes('/');

    if (isRootLevel && isNested) {
      const parent = folder.id.split('/')[0];
      const name = folder.id.split('/').pop();

      const choice = confirm(`The folder "${folder.id}" is no longer nested under "${parent}".\n\nPress OK to move "${name}" to root level, or Cancel to remove it.`);

      if (choice) {
        return { id: name, label: folder.label, groupId: name }; // Flatten to root
      } else {
        return null; // Remove from list
      }
    }

    return folder;
  }));

  // Remove any null entries
  customFolders = customFolders.filter(f => f);
  renderFolderList();
  folderOrder = [...el.folderList.querySelectorAll('li.draggable-item')].map(
    li => li.dataset.id
  );
}

function updateSelectedFolders() {
  selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item.selected')]
    .map(li => li.dataset.id);
  updateSummary();
}

// ✅ Patched dragover handler
el.folderList.addEventListener('dragover', e => {
  e.preventDefault();
  const after = getDragAfterElement(e.clientY);
  const dragging = el.folderList.querySelector('.dragging');
  if (!dragging) return;

  // 🧱 Only allow drop before/after other root folders
  const isAfterRoot = after?.dataset?.root === 'true';
  if (after && !isAfterRoot) return;

  if (after == null) {
    el.folderList.appendChild(dragging);
  } else {
    after.parentElement.insertBefore(dragging, after);
  }

if (draggedChildren.length) {
  const insertAfter = dragging;
  const parent = insertAfter.parentElement;

  // Preserve visual order by reversing before insert
  [...draggedChildren].reverse().forEach(child => {
    parent.insertBefore(child, insertAfter.nextSibling);
  });
}

});

function getDragAfterElement(y) {
  const items = [...el.folderList.querySelectorAll('.draggable-item:not(.dragging)')]
    .filter(i => !draggedChildren.includes(i));
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

el.addSubfolder?.addEventListener('click', () => {
  const name = el.customFolderName.value.trim();
  if (!name) return;

  const selected = el.folderList.querySelectorAll('li.draggable-item.selected');
  if (selected.length !== 1) {
    alert('Please select exactly one folder to nest under.');
    return;
  }

  const base = selected[0].dataset.id;
  const fullPath = `${base}/${name}`;

  if (!customFolders.some(f => f.id === fullPath)) {
    customFolders.push({ id: fullPath, label: '(Custom)', groupId: base.split('/')[0] });
    const idx = folderOrder.indexOf(base);
    if (idx >= 0) {
      folderOrder.splice(idx + 1, 0, fullPath);
    } else {
      folderOrder.push(fullPath);
    }
  }

  el.customFolderName.value = '';
  renderFolderList();

  // ✅ Select newly added subfolder
  const fullPathSelector = `[data-id="${CSS.escape(fullPath)}"]`;
  const newItem = el.folderList.querySelector(fullPathSelector);
  if (newItem) {
    el.folderList.querySelectorAll('li.draggable-item').forEach(item =>
      item.classList.remove('selected')
    );
    newItem.classList.add('selected');
    updateSelectedFolders();
  }
});

// ➕ Add regular (root-level) custom folder
el.addCustomFolder?.addEventListener('click', () => {
  const name = el.customFolderName.value.trim();
  if (!name) return;

  if (!customFolders.some(f => f.id === name)) {
    customFolders.push({ id: name, label: '(Custom)', groupId: name });
    folderOrder.push(name);
  }

  el.customFolderName.value = '';
  renderFolderList();

  // ✅ Select newly added folder
  const newItem = el.folderList.querySelector(`[data-id="${CSS.escape(name)}"]`);
  if (newItem) {
    el.folderList.querySelectorAll('li.draggable-item').forEach(item =>
      item.classList.remove('selected')
    );
    newItem.classList.add('selected');
    updateSelectedFolders();
  }
});

// 📍 Output path selector
el.outputBtn?.addEventListener('click', async () => {
  const folder = await ipc?.selectFolder?.();
  if (folder) {
    el.outputPath.value = folder;
    updateSummary();
  }
});


// 🏷️ Update summary when numbering option changes
el.prependNumbers?.addEventListener('change', updateSummary);
el.rootName?.addEventListener('input', updateSummary);

// 🧹 Reset
el.resetButton?.addEventListener('click', () => {
  selectedFolders = [];
  customFolders = [];
  for (const key in folderAssets) delete folderAssets[key];

  // 🔁 Restore original default folders
  defaultFolders.length = 0;
  defaultFolders.push(
    ...JSON.parse(JSON.stringify(originalDefaultFolders))
  );

  folderOrder = defaultFolders.map(f => f.id);

  // 🧹 Clear all input fields
  el.customFolderName.value = '';
  el.outputPath.value = '';
  const resetMsg = 'No structure defined yet.';
  logOrganizer(resetMsg);
  el.summary.textContent = resetMsg;
  el.rootName.value = '';

    // 🖼️ Rerender list
  renderFolderList();
});

// 📊 Summary Update
function updateSummary() {
  selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item')]
    .map(li => li.dataset.id);

  const rootIds = [
    ...el.folderList.querySelectorAll('li.draggable-item[data-root="true"]')
  ].map(li => li.dataset.id);
  const renameMap = {};

  rootIds.forEach((id, idx) => {
    const prefix = el.prependNumbers.checked
      ? `${String(idx + 1).padStart(2, '0')}_`
      : '';
    renameMap[id] = prefix + id;
  });

  const numbered = selectedFolders.map(name => {
    const parts = name.split('/');
    const root = parts[0];
    if (renameMap[root]) {
      parts[0] = renameMap[root];
    }
    return parts.join('/');
  });

  const root = el.rootName.value || '[No Name]';
  const output = el.outputPath.value || '[No Path]';
  const summaryLines = [
    `Root Folder: ${root}`,
    `Selected Folders: ${numbered.join(', ') || 'None'}`,
    `Output Path: ${output}`
  ];

  numbered.forEach((name, idx) => {
    const id = selectedFolders[idx];
    if (folderAssets[id]?.length > 0) {
      const files = folderAssets[id].map(p => electron.basename(p));
      summaryLines.push(`\uD83D\uDCCE ${name}: ${files.join(', ')}`);
    }
  });

  const summaryMsg = summaryLines.join('\n');
  logOrganizer(summaryMsg);
  el.summary.textContent = summaryMsg;
}

function updateAttachmentIndicators() {
  [...el.folderList.querySelectorAll('.draggable-item')].forEach(li => {
    const id = li.dataset.id;
    const actions = li.querySelector('.folder-actions');
    if (!actions) return;
    let clip = actions.querySelector('.attachment-indicator');
    const count = folderAssets[id]?.length || 0;
    if (count > 0) {
      if (!clip) {
        clip = document.createElement('span');
        clip.className = 'attachment-indicator';
        actions.insertBefore(clip, actions.firstChild);
      }
      clip.textContent = '📎';
      clip.title = `${count} attached file(s)`;
    } else if (clip) {
      clip.remove();
    }
  });
}

// 🧠 Generate Folder Structure (demo: disabled click)
el.generateButton?.addEventListener('click', () => {
  // In the interactive demo, this button is visual-only.
  // Hover and press states are styled via CSS; no logic runs here.
});

// 💾 Save and Load Preset
function gatherOrganizerConfig() {
  return {
    rootName: el.rootName.value,
    prependNumbers: el.prependNumbers.checked,
    outputPath: el.outputPath.value,
    customFolders,
    folderOrder,
    selectedFolders,
    folderAssets
  };
}

function applyOrganizerPreset(data) {
  if (el.rootName) el.rootName.value = data.rootName || '';
  if (el.prependNumbers) el.prependNumbers.checked = !!data.prependNumbers;
  if (el.outputPath) el.outputPath.value = data.outputPath || '';

  const rootIds = new Set();
  (data.folderOrder || []).forEach(id => rootIds.add(id.split('/')[0]));
  (data.customFolders || []).forEach(f => rootIds.add(f.id.split('/')[0]));

  defaultFolders.length = 0;
  defaultFolders.push(
    ...originalDefaultFolders.filter(f => rootIds.has(f.id))
  );

  customFolders = (data.customFolders || []).map(f => ({
    ...f,
    groupId: f.id.split('/')[0]
  }));

  folderOrder = data.folderOrder || defaultFolders.map(f => f.id);
  selectedFolders = data.selectedFolders || [];

  for (const k in folderAssets) delete folderAssets[k];
  Object.assign(folderAssets, data.folderAssets || {});

  renderFolderList();
  updateSelectedFolders();
  updateSummary();
}

const presetDir = electron.resolvePath('config', 'presets', 'project-organizer');

function refreshPresetDropdown() {
  const hidden = el.presetSelect;
  if (!hidden) return;
  let opts = [];
  try {
    electron.mkdir(presetDir);
    const files = electron.readdir(presetDir) || [];
    opts = files
      .filter(f => f.endsWith('.json'))
      .map(f => ({ value: f, label: f.replace(/\.json$/, '') }));
  } catch (err) {
    console.error('Failed to read presets:', err);
  }
  setupStyledDropdown('organizer-preset', opts);
  setDropdownValue('organizer-preset', hidden.value || '');
  window.translatePage?.();
}

// ✅ Auto-refresh preset dropdown when presets are saved or deleted
if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('preset-saved', (_e, panelId) => {
    if (panelId === 'project-organizer') refreshPresetDropdown();
  });
  ipc.on('preset-deleted', (_e, panelId) => {
    if (panelId === 'project-organizer') refreshPresetDropdown();
  });
}

el.presetSelect?.addEventListener('change', () => {
  const file = el.presetSelect.value;
  if (!file) return;
  try {
    const raw = electron.readTextFile(electron.joinPath(presetDir, file));
    const data = JSON.parse(raw);
    applyOrganizerPreset(data);
  } catch (err) {
    console.error('Failed to load preset', err);
  }
});

el.saveConfig?.addEventListener('click', async () => {
  const cfg = gatherOrganizerConfig();
  const file = await ipc.saveFile({
    title: 'Save Preset',
    defaultPath: electron.joinPath(presetDir, 'organizer-config.json')
  });
  if (file) {
    ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
    refreshPresetDropdown();
    alert('Config saved.');
  }
});

el.loadConfig?.addEventListener('click', async () => {
  const file = await ipc.openFile({ title: 'Load Preset' });
  if (!file) return;
  try {
    const data = JSON.parse(ipc.readTextFile(file));
    applyOrganizerPreset(data);
  } catch (err) {
    alert('Failed to load config: ' + err.message);
  }
});

// 🔁 Init
folderOrder = defaultFolders.map(f => f.id);
renderFolderList();
refreshPresetDropdown();

// ─── Project Organizer: panel overview tooltip ────────────────────────────
const organizerOverview = document.querySelector('#project-organizer #project-organizer-overview-tooltip');
if (organizerOverview && !organizerOverview.dataset.bound) {
  organizerOverview.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">PROJECT ORGANIZER OVERVIEW</div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">What this panel is for</span>
        <ul class="tooltip-list">
          <li>Design a reusable project folder tree for shows, clients, or teams.</li>
          <li>Mix built‑in template folders with your own custom folders and subfolders.</li>
          <li>Generate that structure into a chosen project root on disk.</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Quick workflow</span>
        <ul class="tooltip-list">
          <li><strong>Configure structure</strong> – drag folders to reorder, toggle them on/off, and add custom entries.</li>
          <li><strong>Name the root</strong> – set the root folder name and choose whether to prepend numbers.</li>
          <li><strong>Choose location</strong> – pick the project volume/path where folders should be created.</li>
          <li><strong>Generate</strong> – click <em>Generate Project Folders</em> and review the summary.</li>
        </ul>
      </div>
    </div>
  `;
  organizerOverview.dataset.bound = 'true';
}

if (typeof module !== 'undefined') {
  module.exports = {
    gatherOrganizerConfig,
    renderFolderList,
    get customFolders() { return customFolders; },
    set customFolders(val) { customFolders = val; },
    get folderOrder() { return folderOrder; },
    set folderOrder(val) { folderOrder = val; },
    get selectedFolders() { return selectedFolders; },
    set selectedFolders(val) { selectedFolders = val; },
    get folderAssets() { return folderAssets; },
    set folderAssets(val) {
      for (const key in folderAssets) delete folderAssets[key];
      Object.assign(folderAssets, val);
    },
    applyOrganizerPreset,
    refreshPresetDropdown
  };
}

})();
