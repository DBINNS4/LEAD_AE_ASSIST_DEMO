(() => {

const electron = window.electron ?? {};
const ipc = window.ipc ?? electron;
const PANEL_ID = 'project-organizer';

// Renderer-safe snapshot helper: no require, no Node API.
function snapshotOrganizerJobState(state) {
  const payload = {
    selectedFolders: state.selectedFolders,
    folderOrder: state.folderOrder,
    customFolders: state.customFolders,
    folderAssets: state.folderAssets
  };

  if (typeof structuredClone === 'function') {
    return structuredClone(payload);
  }

  return JSON.parse(JSON.stringify(payload));
}

const organizerState = {
  currentJobId: null
};

const el = {
  folderList: document.getElementById('folder-list'),
  addCustomFolder: document.getElementById('add-custom-folder'),
  addSubfolder: document.getElementById('organizer-add-subfolder'),
  customFolderName: document.getElementById('custom-folder-name'),
  resetButton: document.getElementById('reset-project-organizer'),
  generateButton: document.getElementById('generate-project-folders'),
  cancelButton: document.getElementById('cancel-project-organizer'),
  summary: document.getElementById('project-summary'),
  outputPath: document.getElementById('output-location-path'),
  outputBtn: document.getElementById('select-output-location'),
  rootName: document.getElementById('root-folder-name'),
  prependNumbers: document.getElementById('prepend-numbers'),
  presetSelect: document.getElementById('organizer-preset'),
  saveConfig: document.getElementById('organizer-save-config'),
  loadConfig: document.getElementById('organizer-load-config'),
  status: document.getElementById('project-organizer-job-status'),
  wheel: document.querySelector('#project-organizer-job-status .wheel-and-hamster')
};

if (el.cancelButton) el.cancelButton.disabled = true;

function ensureHamster(root) {
  if (!root || root.querySelector('.wheel')) return;
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
      <div class="spoke"></div>`;
}

function showOrganizerHamster() {
  if (!el.status) return;
  el.status.style.display = 'block';
  ensureHamster(el.wheel);
}

function hideOrganizerHamster() {
  if (el.status) el.status.style.display = 'none';
  if (el.wheel) el.wheel.innerHTML = '';
}

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

ipc?.on?.('queue-job-start', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  organizerState.currentJobId = job.id;
  if (el.cancelButton) el.cancelButton.disabled = false;
  showOrganizerHamster();
  if (el.summary) {
    el.summary.textContent = '⏳ Project organizer started...';
  }
});

ipc?.on?.('queue-job-progress', (_event, payload) => {
  if (payload.panel !== PANEL_ID) return;
  showOrganizerHamster();
});

ipc?.on?.('queue-job-complete', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  hideOrganizerHamster();
  if (el.summary) {
    const message =
      job.result?.logText ||
      job.result?.summary ||
      '✅ Project structure created.';
    el.summary.textContent = message;
  }
});

ipc?.on?.('queue-job-failed', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  hideOrganizerHamster();
  if (el.summary) {
    el.summary.textContent = job.error || '❌ Project organizer failed.';
  }
});

ipc?.on?.('queue-job-cancelled', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  hideOrganizerHamster();
  if (el.summary) {
    el.summary.textContent = '⚠️ Project organizer cancelled.';
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
      let files = [];
      try {
        files = await ipc.selectFiles?.();
      } catch (err) {
        const msg = `❌ File picker failed: ${err?.message || err}`;
        logOrganizer(msg, { isError: true });
        if (el.summary) el.summary.textContent = msg;
        return;
      }
      if (!files?.length) return;

      // 🔧 Normalize if raw filePaths were returned instead of { path }
      if (typeof files[0] === 'string') {
        files = files.map(p => ({ path: p }));
      }

      const targetId = li.dataset.id;
      const paths = files.map(f => f.path).filter(Boolean);
      if (!paths.length) return;

      if (!folderAssets[targetId]) folderAssets[targetId] = [];
      folderAssets[targetId].push(...paths);

      logOrganizer(
        `📎 Attached ${paths.length} file(s) to "${targetId}".`,
        { detail: paths.join('\n') }
      );

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
        const removed = folderAssets[targetId].slice();
        delete folderAssets[targetId];
        updateSummary();
        updateAttachmentIndicators();

        logOrganizer(
          `🧹 Cleared ${removed.length} attached file(s) from ${targetId}.`,
          { detail: removed.join('\n') }
        );
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

          logOrganizer(
            `🗑️ Removed folder ${targetId} and ${Math.max(idsToRemove.length - 1, 0)} subfolder(s).`,
            { detail: idsToRemove.join(', ') }
          );

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

  // If nothing is explicitly selected, treat all visible folders as included
  // so the generator always reflects the current structure unless the user
  // removes folders entirely.
  if (selectedFolders.length === 0) {
    selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item')]
      .map(li => li.dataset.id);
  }
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
    const errMsg = '❌ Please select exactly one folder to nest under.';
    logOrganizer(errMsg, { isError: true });
    alert(errMsg);
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
    logOrganizer(`📂 Added subfolder "${fullPath}".`);
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
    logOrganizer(`📂 Added custom root folder "${name}".`);
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
  try {
    const folder = await ipc?.selectFolder?.();
    if (folder) {
      el.outputPath.value = folder;
      logOrganizer(`📁 Output path set to: ${folder}`, { fileId: folder });
      updateSummary();
    }
  } catch (err) {
    const msg = `❌ Folder picker failed: ${err?.message || err}`;
    logOrganizer(msg, { isError: true });
    if (el.summary) el.summary.textContent = msg;
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

// 🧠 Generate Folder Structure
el.generateButton?.addEventListener('click', async () => {
  updateFolderAssetPaths();

  const rootName = (el.rootName?.value || '').trim();
  const outputPath = (el.outputPath?.value || '').trim();

  if (el.rootName) el.rootName.value = rootName;
  if (el.outputPath) el.outputPath.value = outputPath;

  if (!rootName) {
    const errMsg = '❌ Please enter a Root Folder Name before generating.';
    logOrganizer(errMsg, { isError: true });
    if (el.summary) el.summary.textContent = errMsg;
    return;
  }

  if (!outputPath) {
    const errMsg = '❌ Please set an Output Path before generating.';
    logOrganizer(errMsg, { isError: true });
    if (el.summary) el.summary.textContent = errMsg;
    return;
  }

  const genMsg = '⚙️ Generating structure...';
  logOrganizer(genMsg);
  el.summary.textContent = genMsg;

  // 🔥 Make sure the hamster shows up immediately
  showOrganizerHamster();

  const snapshot = snapshotOrganizerJobState({
    selectedFolders,
    folderOrder,
    customFolders,
    folderAssets
  });

  const config = {
    rootName,
    prependNumbers: el.prependNumbers.checked,
    outputPath,
    ...snapshot
  };

  try {
    const jobId = await ipc.invoke('queue-add-project-organizer', config);
    organizerState.currentJobId = jobId;
    await ipc.invoke('queue-start');
    logOrganizer(`✅ Project organizer queued (Job ID: ${jobId})`);
    el.summary.textContent = '⏳ Job queued in background...';
  } catch (err) {
    const errMsg = `❌ Organizer job failed to queue: ${err.message}`;
    logOrganizer(errMsg, { isError: true });
    el.summary.textContent = errMsg;
    return;
  }
});

el.cancelButton?.addEventListener('click', async () => {
  if (!organizerState.currentJobId) {
    const noJobMsg = '⚠️ No organizer job to cancel.';
    logOrganizer(noJobMsg);
    if (el.summary) el.summary.textContent = noJobMsg;
    return;
  }

  const cancelMsg = '⛔ Cancel requested...';
  logOrganizer(cancelMsg);
  if (el.summary) el.summary.textContent = cancelMsg;
  el.cancelButton.disabled = true;

  try {
    await ipc.invoke('queue-cancel-job', organizerState.currentJobId);
  } catch (err) {
    const errMsg = `❌ Cancel error: ${err.message}`;
    logOrganizer(errMsg, { isError: true });
    if (el.summary) el.summary.textContent = errMsg;
    if (organizerState.currentJobId) el.cancelButton.disabled = false;
  }
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

function toStringArray(value, label, errors) {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push(`${label} must be an array of strings`);
    return [];
  }

  const cleaned = value.filter(v => typeof v === 'string' && v.trim() !== '');
  if (cleaned.length !== value.length) {
    errors.push(`${label} contained non-string entries that were removed`);
  }
  return cleaned;
}

function sanitizeFolderAssets(rawAssets, errors) {
  if (!rawAssets || typeof rawAssets !== 'object') {
    if (rawAssets !== undefined) errors.push('folderAssets must be an object');
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(rawAssets)) {
    if (typeof key !== 'string' || !key.trim()) {
      errors.push('folderAssets contains a non-string key and was skipped');
      continue;
    }

    const paths = toStringArray(value, `folderAssets[${key}]`, errors);
    if (paths.length > 0) sanitized[key] = paths;
  }
  return sanitized;
}

function validateOrganizerPreset(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['Preset file is not a valid JSON object'] };
  }

  const sanitized = {
    rootName: typeof data.rootName === 'string' ? data.rootName : '',
    prependNumbers: !!data.prependNumbers,
    outputPath: typeof data.outputPath === 'string' ? data.outputPath : ''
  };

  sanitized.folderOrder = toStringArray(data.folderOrder, 'folderOrder', errors);
  sanitized.selectedFolders = toStringArray(
    data.selectedFolders,
    'selectedFolders',
    errors
  );

  if (Array.isArray(data.customFolders)) {
    sanitized.customFolders = data.customFolders
      .filter(
        f =>
          f &&
          typeof f === 'object' &&
          typeof f.id === 'string' &&
          typeof f.label === 'string' &&
          typeof f.groupId === 'string'
      )
      .map(f => ({ id: f.id, label: f.label, groupId: f.groupId }));

    if (sanitized.customFolders.length !== data.customFolders.length) {
      errors.push('customFolders contained invalid entries that were removed');
    }
  } else {
    sanitized.customFolders = [];
    if (data.customFolders !== undefined)
      errors.push('customFolders must be an array of objects');
  }

  sanitized.folderAssets = sanitizeFolderAssets(data.folderAssets, errors);

  return { ok: true, sanitized, errors };
}

function applyOrganizerPreset(rawData, sourceLabel = 'preset') {
  const validation = validateOrganizerPreset(rawData);
  if (!validation.ok) {
    const errMsg = `❌ Unable to apply organizer ${sourceLabel}: ${validation.errors.join(', ')}`;
    logOrganizer(errMsg, { isError: true });
    alert(errMsg);
    return;
  }

  if (validation.errors.length) {
    const warnMsg = `⚠️ Organizer ${sourceLabel} contained invalid data that was ignored: ${validation.errors.join(', ')}`;
    logOrganizer(warnMsg, { isError: true });
  }

  const data = validation.sanitized;

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
    logOrganizer(`❌ Failed to read organizer presets: ${err.message}`, {
      isError: true
    });
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
    const fullPath = electron.joinPath(presetDir, file);
    const raw = electron.readTextFile(fullPath);
    const data = JSON.parse(raw);
    applyOrganizerPreset(data, `preset "${file}"`);
    logOrganizer(`📚 Applied organizer preset "${file}".`, { fileId: fullPath });
  } catch (err) {
    console.error('Failed to load preset', err);
    const errMsg = `❌ Failed to load preset "${file}": ${err.message}`;
    logOrganizer(errMsg, { isError: true });
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
    const msg = `💾 Organizer config saved to "${file}".`;
    logOrganizer(msg, { fileId: file });
    alert('Config saved.');
  }
});

el.loadConfig?.addEventListener('click', async () => {
  const file = await ipc.openFile({ title: 'Load Preset' });
  if (!file) return;
  try {
    const raw = ipc.readTextFile(file);
    const data = JSON.parse(raw);
    applyOrganizerPreset(data, `config "${file}"`);
    logOrganizer(`📥 Loaded organizer config from "${file}".`, {
      fileId: file
    });
  } catch (err) {
    const errMsg = `❌ Failed to load config from "${file}": ${err.message}`;
    logOrganizer(errMsg, { isError: true });
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
      <div class="tooltip-header">PROJECT ORGANIZER — Technical Overview</div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Core capabilities</span>
        <ul class="tooltip-list">
          <li>Defines a reusable project folder tree for shows, clients, or facilities.</li>
          <li>Combines built‑in template folders with arbitrary custom folders and nested subfolders.</li>
          <li>Optionally prefixes top-level folders with numeric ordering tokens.</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Inputs / outputs</span>
        <ul class="tooltip-list">
          <li>Inputs: template selection, custom folder definitions, root folder name, and output path.</li>
          <li>Outputs: a deterministic folder tree created on disk plus a text summary of the structure.</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">Under the hood</span>
        <ul class="tooltip-list">
          <li>Uses a simple ordered list of IDs and paths to generate folder trees for presets and jobs.</li>
          <li>Organizer presets snapshot the current structure so shows can share the same layout.</li>
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
