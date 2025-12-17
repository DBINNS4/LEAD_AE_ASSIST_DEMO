(() => {

  // 🧼 Collapse all <details> on load
  document.querySelectorAll('#nle-utilities details').forEach(section => {
    section.open = false;
  });

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}


const fs = {
  readdirSync: ipc.readdir,
  unlinkSync: ipc.unlink,
  mkdirSync: ipc.mkdir,
  copyFileSync: ipc.copyFile,
  writeFileSync: ipc.writeTextFile,
  existsSync: ipc.fileExists,
  statSync: ipc.statSync  // ✅ Add this line
};

  const path = {
    join: ipc.joinPath,
    resolve: ipc.resolvePath,
    basename: ipc.basename,
    extname: ipc.extname
  };

  const presetDir = ipc.resolvePath('config', 'presets', 'nle-utilities');

  // Helper to verify standard Avid MediaFiles path
  const isAvidMxfPath = (dir) => {
    const normalized = dir.replace(/\\/g, '/');
    return /\/Avid MediaFiles\/MXF\//i.test(normalized);
  };

  // ===============================
// 🔁 Helper: Recursively collect all files
// ===============================
function readdirRecursive(baseDir) {
  const results = [];
  const walk = (dir) => {
    const entries = ipc.readdirWithTypes(dir);
    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      let isDir = false;

      if (typeof entry.isDirectory === 'function') {
        isDir = entry.isDirectory();
      } else {
        try {
          const stats = ipc.statSync(fullPath);
          isDir = typeof stats?.isDirectory === 'function' ? stats.isDirectory() : false;
        } catch (err) {
          console.warn('⚠️ Failed to stat path during recursive scan:', fullPath, err);
          isDir = false;
        }
      }
      if (isDir) {
        walk(fullPath);
      } else {
        results.push(fullPath);
      }
    });
  };
  walk(baseDir);
  return results;
}

  // ===============================
  // 📁 Avid: MXF Folder Picker
  // ===============================

const avid = {
  selectBtn: document.getElementById('avid-select-folder'),
  pathField: document.getElementById('avid-folder-path'),
  summary: document.getElementById('avid-summary'),
  userSelect: document.getElementById('avid-user-select')
};

const getLocalizedText = (key, fallback = '', options = {}) => {
  if (window.i18n?.t) {
    return window.i18n.t(key, options);
  }
  return fallback;
};

const setAvidUserPlaceholder = () => {
  if (!avid.userSelect) return;
  avid.userSelect.innerHTML = '';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = getLocalizedText('selectUser', 'Select user');
  avid.userSelect.appendChild(placeholderOption);
};

function logNLE(msg, opts = {}) {
  window.logPanel?.log('nle-utilities', msg, opts);
}

  function collectAvidSubfolders(baseFolder, includeSubfolders) {
    const foldersToScan = [baseFolder];

    if (!includeSubfolders) return foldersToScan;

    const collectSubfolders = (dir) => {
      const entries = ipc.readdirWithTypes(dir);
      entries.forEach(entry => {
        const isDir = typeof entry.isDirectory === 'function'
          ? entry.isDirectory()
          : entry && entry.name && !entry.name.includes('.') && !entry.name.startsWith('.');
        if (isDir) {
          const fullPath = path.join(dir, entry.name);
          foldersToScan.push(fullPath);
          collectSubfolders(fullPath);
        }
      });
    };

    collectSubfolders(baseFolder);
    return foldersToScan;
  }

  function buildAvidCountSummary(baseFolder, options = {}) {
    const {
      showCounts = false,
      scanSubfolders = false
    } = options;

    if (!showCounts) return '';

    try {
      const foldersToScan = collectAvidSubfolders(baseFolder, scanSubfolders);
      let totalMXF = 0, totalMDB = 0, totalPMR = 0;

      foldersToScan.forEach(dir => {
        const files = ipc.readdir(dir);
        totalMXF += files.filter(f => f.toLowerCase().endsWith('.mxf')).length;
        totalMDB += files.filter(f => f.toLowerCase().endsWith('.mdb')).length;
        totalPMR += files.filter(f => f.toLowerCase().endsWith('.pmr')).length;
      });

      return `\n📊 File Counts — ${foldersToScan.length} folder(s)\n• MXF: ${totalMXF} | MDB: ${totalMDB} | PMR: ${totalPMR} ✅`;
    } catch (err) {
      return `\n❌ Failed to count files: ${err.message}`;
    }
  }

  // ===============================
  // 🤝 NLE Utilities: AI Assistants
  // ===============================

  const nleAssistButtons = document.querySelectorAll('#nle-utilities .nle-assist-button');

  async function apiKeyIsValid() {
    try {
      const key = await ipc.invoke('secure-store:get-ai-api-key');
      return typeof key === 'string' && key.trim().length > 0;
    } catch (err) {
      console.warn('⚠️ Unable to verify API key state for assistants:', err);
      return false;
    }
  }

  async function updateAssistButtonState(validOverride) {
    const valid = typeof validOverride === 'boolean' ? validOverride : await apiKeyIsValid();
    nleAssistButtons.forEach((btn) => {
      if (!valid) {
        btn.classList.add('disabled');
      } else {
        btn.classList.remove('disabled');
      }
    });
  }

  nleAssistButtons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const hasKey = await apiKeyIsValid();
      if (!hasKey) {
        e.preventDefault();
        e.stopPropagation();
        alert('Enter a valid API key in Preferences to use the NLE assistants.');
      }
    });
  });

  updateAssistButtonState();

function populateAvidUsers(baseFolder, preselectedUser) {
  if (!avid.userSelect) return;

  setAvidUserPlaceholder();
  if (!baseFolder) return;

    const usersDir = path.join(baseFolder, 'Users');

    let entries = [];
    try {
      entries = ipc.readdirWithTypes(usersDir);
    } catch (err) {
      avid.summary.textContent += `\n❌ Unable to load users from ${usersDir}: ${err.message}`;
      return;
    }

    const userNames = entries
      .filter(entry => {
        if (typeof entry.isDirectory === 'function') {
          return entry.isDirectory();
        }
        try {
          const stats = ipc.statSync(path.join(usersDir, entry.name));
          return typeof stats?.isDirectory === 'function' ? stats.isDirectory() : false;
        } catch (err) {
          console.warn('⚠️ Failed to stat user entry', entry.name, err);
          return false;
        }
      })
      .map(entry => entry.name)
      .filter(Boolean);

    if (userNames.length === 0) {
      avid.summary.textContent += `\n⚠️ No user folders found in ${usersDir}.`;
      return;
    }

    userNames.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (preselectedUser && preselectedUser === name) {
        option.selected = true;
      }
      avid.userSelect.appendChild(option);
    });

    if (preselectedUser && !userNames.includes(preselectedUser)) {
      avid.summary.textContent += `\n⚠️ Saved user “${preselectedUser}” not found in ${usersDir}.`;
    }
}

const avidDeleteDbBtn = document.getElementById('avid-delete-db');
const avidScanSubfolders = document.getElementById('avid-scan-subfolders');

avidDeleteDbBtn?.addEventListener('click', async () => {
  const folder = avid.pathField.value;
  if (!folder) {
    const errMsg = '❌ Please select a MXF folder first.';
    logNLE(errMsg, { isError: true });
    avid.summary.textContent += `\n${errMsg}`;
    return;
  }

  const confirmed = await ipc.showConfirm?.(
    "This will permanently delete all .pmr and .mdb database files in the selected folder(s).\n\nThese files will be rebuilt automatically by Media Composer.\n\nDo you want to continue?"

  );
  if (!confirmed) {
    const cancelMsg = '⛔ DB deletion canceled by user.';
    logNLE(cancelMsg);
    avid.summary.textContent += `\n${cancelMsg}`;
    return;
  }

  const mxfFolders = [];

  const recurseFolders = (dir) => {
    const entries = ipc.readdirWithTypes(dir);
    mxfFolders.push(dir); // Include all folders, not just those with MXFs

const scanMsg = `🔍 Scanning folder: ${dir}`;
logNLE(scanMsg);
avid.summary.textContent += `\n${scanMsg}`;

const showCounts = document.getElementById('avid-show-counts')?.checked;
if (showCounts) {
  try {
    const allFiles = ipc.readdir(dir);
    const mxfCount = allFiles.filter(f => f.toLowerCase().endsWith('.mxf')).length;
    const mdbCount = allFiles.filter(f => f.toLowerCase().endsWith('.mdb')).length;
    const pmrCount = allFiles.filter(f => f.toLowerCase().endsWith('.pmr')).length;

    const countMsg = ` [MXF: ${mxfCount} | MDB: ${mdbCount} | PMR: ${pmrCount}]`;
    logNLE(countMsg);
    avid.summary.textContent += countMsg;
  } catch (err) {
    const countErr = `❌ Failed to count files in ${dir}: ${err.message}`;
    logNLE(countErr, { isError: true });
    avid.summary.textContent += `\n${countErr}`;
  }
}

    if (avidScanSubfolders?.checked) {
entries.forEach(entry => {
  const isDir = typeof entry.isDirectory === 'function'
    ? entry.isDirectory()
    : entry && entry.name && !entry.name.includes('.') && !entry.name.startsWith('.');

  if (isDir) {
    recurseFolders(path.join(dir, entry.name));
  }
});

    }
  };

  recurseFolders(folder);

  let totalDeleted = 0;

  mxfFolders.forEach(sub => {
  if (!isAvidMxfPath(sub)) {
    avid.summary.textContent += `\n⚠️ ${sub} may be skipped by Media Composer (non-standard path)`;
  }
    const dbFiles = ipc.readdir(sub).filter(f =>
  f.toLowerCase().endsWith('.pmr') || f.toLowerCase().endsWith('.mdb')
  );

if (dbFiles.length === 0) {
  avid.summary.textContent += `\n📭 No .pmr or .mdb files found in: ${sub}`;
} else {
  avid.summary.textContent += `\n📂 Found ${dbFiles.length} db file(s) in ${sub}`;
}

dbFiles.forEach(file => {
  const filePath = path.join(sub, file);
  avid.summary.textContent += `\n🧾 Found file: ${filePath}`;
  try {
    fs.unlinkSync(filePath);
    avid.summary.textContent += `\n🧹 Deleted: ${filePath}`;
    totalDeleted++;
  } catch (err) {
    console.error(`❌ Failed to delete ${filePath}: ${err.message}`);
    avid.summary.textContent += `\n❌ Failed to delete ${filePath}: ${err.message}`;
  }
});


  });

  if (totalDeleted === 0) {
    avid.summary.textContent += `\n✅ No .mdb or .pmr files found to delete.`;
  } else {
    avid.summary.textContent += `\n✅ Deleted ${totalDeleted} database file(s).`;
  }

  // ✅ Optionally trigger rebuild
// ✅ Optionally trigger rebuild
const autoRebuild = document.getElementById('avid-auto-rebuild');
if (autoRebuild?.checked && mxfFolders.length > 0) {
  try {
    logNLE('⚙️ Auto-rebuild trigger enabled for selected MXF folders.');

    mxfFolders.forEach(sub => {
      const dummyFile = path.join(sub, `REBUILD_TRIGGER_${Date.now()}.mxf`);
      fs.writeFileSync(dummyFile, 'Avid Rebuild Trigger');
      setTimeout(() => {
        if (fs.existsSync(dummyFile)) fs.unlinkSync(dummyFile); // Clean up after trigger
      }, 1000);
    });
    avid.summary.textContent += `\n⚙️ Auto-rebuild triggered in ${mxfFolders.length} folder(s).`;
    logNLE(`✅ Auto-rebuild triggered in ${mxfFolders.length} folder(s).`);
  } catch (err) {
    avid.summary.textContent += `\n❌ Auto-rebuild failed: ${err.message}`;
    logNLE(`❌ Auto-rebuild failed: ${err.message}`, { isError: true });
  }
}

});

const avidRebuildDbBtn = document.getElementById('avid-rebuild-db');

avidRebuildDbBtn?.addEventListener('click', () => {
  const folder = avid.pathField.value;
  if (!folder) {
    avid.summary.textContent += `\n❌ Please select a MXF folder first.`;
    return;
  }

  const scanSubfolders = avidScanSubfolders?.checked;
  const mxfFolders = [];

  const recurseFolders = (dir) => {
    try {
      const entries = ipc.readdirWithTypes(dir);
      mxfFolders.push(dir);
      if (scanSubfolders) {
        entries.forEach(entry => {
          const isDir = typeof entry.isDirectory === 'function'
            ? entry.isDirectory()
            : entry && entry.name && !entry.name.includes('.') && !entry.name.startsWith('.');
          if (isDir) {
            recurseFolders(path.join(dir, entry.name));
          }
        });
      }
    } catch (err) {
      avid.summary.textContent += `\n❌ Failed to scan ${dir}: ${err.message}`;
    }
  };

  recurseFolders(folder);

  if (mxfFolders.length === 0) {
    avid.summary.textContent += `\n⚠️ No folders found to trigger rebuild.`;
    logNLE('⚠️ Rebuild trigger skipped: no folders found.');
    return;
  }

  let triggered = 0;

  logNLE('⚙️ Triggering Avid rebuild in MXF folders…');

  mxfFolders.forEach(sub => {
    if (!isAvidMxfPath(sub)) {
      avid.summary.textContent += `\n⚠️ ${sub} may be skipped by Media Composer (non-standard path)`;
    }
    try {
      const dummyFile = path.join(sub, `REBUILD_TRIGGER_${Date.now()}.mxf`);
      fs.writeFileSync(dummyFile, 'Avid Rebuild Trigger');
      setTimeout(() => {
        if (fs.existsSync(dummyFile)) fs.unlinkSync(dummyFile);
      }, 1000);
      avid.summary.textContent += `\n⚙️ Rebuild triggered in: ${sub}`;
      triggered++;
    } catch (err) {
      avid.summary.textContent += `\n❌ Failed in ${sub}: ${err.message}`;
      logNLE(`❌ Rebuild trigger failed in ${sub}: ${err.message}`, { isError: true });
    }
  });

  if (triggered === 0) {
    avid.summary.textContent += `\n⚠️ No dummy files created.`;
    logNLE('⚠️ Rebuild trigger skipped: no dummy files created.');
  } else {
    avid.summary.textContent += `\n✅ Dummy files created in ${triggered} folder(s).`;
    logNLE(`✅ Rebuild triggered in ${triggered} folder(s).`);
  }
});

avid.selectBtn?.addEventListener('click', async () => {
  const folder = await ipc.selectFolder?.();
  if (folder) {
    avid.pathField.value = folder;
    avid.summary.textContent = `📂 Selected Avid folder:\n${folder}`;
    populateAvidUsers(folder, avid.userSelect?.value);
  } else {
    avid.summary.textContent = `⚠️ Folder selection canceled.`;
    return;
  }

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText) {
    avid.summary.textContent += summaryText;
  }
});

document.getElementById('avid-show-counts')?.addEventListener('change', () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  avid.summary.textContent = `📂 Selected: ${folder}`;

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText) {
    avid.summary.textContent += summaryText;
  }
});

document.getElementById('avid-scan-subfolders')?.addEventListener('change', () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  avid.summary.textContent = `📂 Selected: ${folder}`;

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText) {
    avid.summary.textContent += summaryText;
  }
});

// ===============================
// 🧹 Avid: Site Settings Reset
// ===============================
const avidResetSiteBtn = document.getElementById('avid-reset-site');
const avidBackupSiteCheckbox = document.getElementById('avid-backup-settings');

avidResetSiteBtn?.addEventListener('click', async () => {
  const baseFolder = avid.pathField.value;
  if (!baseFolder) {
    avid.summary.textContent += `\n❌ Please select an Avid folder first.`;
    return;
  }
  if (await ipc.isMediaComposerRunning?.()) {
    avid.summary.textContent += `\n⚠️ Media Composer is currently running. Quit it before resetting.`;
    return;
  }
  const siteFolder = path.join(baseFolder, 'Site_Settings');

  const confirmed = await ipc.showConfirm?.(
    "This will permanently delete Avid site setting files:\n\n• .xml, .pref, .set, .txt\n\nDo you want to continue?"
  );
  if (!confirmed) {
    avid.summary.textContent += `\n⛔ Site settings reset canceled by user.`;
    return;
  }

  // 🔒 Check for lock files before deleting
  try {
    const lockFiles = fs.readdirSync(siteFolder).filter(f => f.toLowerCase().endsWith('.lck'));
    if (lockFiles.length) {
      avid.summary.textContent += `\n⚠️ Lock files detected in ${siteFolder}: ${lockFiles.join(', ')}. Close Media Composer and try again.`;
      return;
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Failed to scan for .lck files: ${err.message}`;
    return;
  }

  const extensions = ['.xml', '.pref', '.set', '.txt'];
  const deleted = [];
  const backedUp = [];
  const cleanupFolder = siteFolder;

  try {
    logNLE('🚀 Resetting Avid site settings…');

    if (avidBackupSiteCheckbox?.checked) {
      const today = new Date().toISOString().split('T')[0];
      const backupFolder = path.join(siteFolder, `Site_Backup_${today}`);
      fs.mkdirSync(backupFolder, { recursive: true });

      extensions.forEach(ext => {
        const files = fs.readdirSync(siteFolder).filter(f => f.toLowerCase().endsWith(ext));
        files.forEach(file => {
          const src = path.join(siteFolder, file);
          const dest = path.join(backupFolder, file);
          fs.copyFileSync(src, dest);
          backedUp.push(file);
        });
      });

      avid.summary.textContent += `\n📦 Backed up ${backedUp.length} file(s) to:\n${backupFolder}`;
    }

    extensions.forEach(ext => {
      const files = fs.readdirSync(cleanupFolder).filter(f => f.toLowerCase().endsWith(ext));
      files.forEach(file => {
        const filePath = path.join(cleanupFolder, file);
        fs.unlinkSync(filePath);
        deleted.push(file);
      });
    });

    if (deleted.length) {
      avid.summary.textContent += `\n🧹 Deleted site setting files:\n${deleted.join(', ')}`;
      logNLE(`✅ Site settings reset complete (${deleted.length} file(s) removed).`);
    } else {
      avid.summary.textContent += `\n✅ No .xml/.pref/.set files found to delete.`;
      logNLE('✅ Site settings reset complete (no files removed).');
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Error resetting site settings: ${err.message}`;
    logNLE(`❌ Error resetting site settings: ${err.message}`, { isError: true });
  }
});

// ===============================
// 🔧 Avid: User Settings Reset
// ===============================
const avidResetUserBtn = document.getElementById('avid-reset-user');
const avidBackupCheckbox = document.getElementById('avid-backup-settings');

avidResetUserBtn?.addEventListener('click', async () => {
  const baseFolder = avid.pathField.value;
  if (!baseFolder) {
    avid.summary.textContent += `\n❌ Please select an Avid folder first.`;
    return;
  }
  const selectedUser = avid.userSelect?.value;
  if (!selectedUser) {
    avid.summary.textContent += `\n❌ Please select an Avid user before resetting.`;
    return;
  }
  if (await ipc.isMediaComposerRunning?.()) {
    avid.summary.textContent += `\n⚠️ Media Composer is currently running. Quit it before resetting.`;
    return;
  }
  const folder = path.join(baseFolder, 'Users', selectedUser);

  if (!fs.existsSync(folder)) {
    avid.summary.textContent += `\n❌ The user folder ${folder} does not exist.`;
    return;
  }
  
  const confirmed = await ipc.showConfirm?.(
    "This will permanently delete Avid user setting files:\n\n• .avs (user prefs)\n• .xml (site/global prefs)\n• .pref (state/preferences)\n\nDo you want to continue?"
  );
  if (!confirmed) {
    avid.summary.textContent += `\n⛔ Deletion canceled by user.`;
    return;
  }

  // 🔒 Check for lock files before deleting
  try {
    const lockFiles = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.lck'));
    if (lockFiles.length) {
      avid.summary.textContent += `\n⚠️ Lock files detected in ${folder}: ${lockFiles.join(', ')}. Close Media Composer and try again.`;
      return;
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Failed to scan for .lck files: ${err.message}`;
    return;
  }

  const extensions = ['.avs', '.xml', '.pref'];
  const deleted = [];
  const backedUp = [];

  try {
    logNLE(`🚀 Resetting Avid user settings for “${selectedUser}”…`);

    // 🔒 Optional Backup
    if (avidBackupCheckbox.checked) {
      const today = new Date().toISOString().split('T')[0]; // → "2025-05-27"
      const backupFolder = path.join(folder, `User_Backup_${today}`);
      fs.mkdirSync(backupFolder, { recursive: true });

      extensions.forEach(ext => {
        const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith(ext));
        files.forEach(file => {
          const src = path.join(folder, file);
          const dest = path.join(backupFolder, file);
          fs.copyFileSync(src, dest);
          backedUp.push(file);
        });
      });

      avid.summary.textContent += `\n📦 Backed up ${backedUp.length} file(s) to:\n${backupFolder}`;
    }

    // 🧹 Delete settings
extensions.forEach(ext => {
  const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith(ext));
  files.forEach(file => {
    const filePath = path.join(folder, file);
    fs.unlinkSync(filePath);
    deleted.push(file);
  });
});

    if (deleted.length) {
      avid.summary.textContent += `\n🧹 Deleted user setting files:\n${deleted.join(', ')}`;
      logNLE(`✅ User settings reset complete for ${selectedUser} (${deleted.length} file(s) removed).`);
    } else {
      avid.summary.textContent += `\n✅ No .avs/.xml/.pref files found to delete.`;
      logNLE(`✅ User settings reset complete for ${selectedUser} (no files removed).`);
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Error: ${err.message}`;
    logNLE(`❌ Error resetting user settings for ${selectedUser}: ${err.message}`, { isError: true });
  }
});

// ===============================
// 🧼 Adobe: Folder Picker + Setup
// ===============================
const adobe = {
  selectFolderBtn: document.getElementById('adobe-select-folder'),
  pathField: document.getElementById('adobe-folder-path'),
  summary: document.getElementById('adobe-summary'),
  clearCache: document.getElementById('adobe-clear-cache'),
  deleteAutosaves: document.getElementById('adobe-delete-autosaves'),
  removePreviews: document.getElementById('adobe-remove-previews')
};

// File extensions used across Adobe cleanup actions
const mediaCacheExtensions = [
  '.pek',
  '.cfa',
  '.ims',
  '.mcdb',
  '.mxf',
  '.mpgindex',
  '.mxfindex',
  '.wav.cfa',
  '.prmdc2'
];

const previewExtensions = [
  '.mpg',
  '.mpeg',
  '.mp4',
  '.mov',
  '.avi',
  '.m4v',
  '.mxf'
];

// ===============================
// 🧹 Adobe: Clear Media Cache Logic
// ===============================
adobe.clearCache?.addEventListener('click', async () => {
  const folder = adobe.pathField.value;
  if (!folder) {
    adobe.summary.textContent += `\n❌ Please select an Adobe folder first.`;
    return;
  }

  const filterInput = document.getElementById('adobe-media-cache-filter')?.value?.trim() || '';
  const scopeInput = document.getElementById('adobe-media-cache-scope')?.value?.trim() || '';

  const parsedFilters = filterInput
    .split(/[,\s]+/)
    .map(f => f.trim())
    .filter(Boolean)
    .map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`);

  const extensionsToUse = parsedFilters.length > 0 ? parsedFilters : mediaCacheExtensions;

  if (parsedFilters.length > 0 && extensionsToUse.length === 0) {
    adobe.summary.textContent += `\n❌ Please provide at least one valid extension (e.g., .cfa, .pek).`;
    return;
  }

  const baseResolved = path.resolve(folder).replace(/\\/g, '/');
  let scanRoot = folder;

  if (scopeInput) {
    const scopedResolved = path.resolve(folder, scopeInput).replace(/\\/g, '/');
    const normalizedBase = baseResolved.endsWith('/') ? baseResolved : `${baseResolved}/`;

    if (scopedResolved !== baseResolved && !scopedResolved.startsWith(normalizedBase)) {
      adobe.summary.textContent += `\n❌ Scope must stay inside the selected Adobe folder.`;
      return;
    }

    try {
      const stats = ipc.statSync(scopedResolved);
      if (!stats?.isDirectory()) {
        adobe.summary.textContent += `\n❌ Scoped path is not a folder: ${scopedResolved}`;
        return;
      }
    } catch (err) {
      adobe.summary.textContent += `\n❌ Unable to read scoped path: ${err.message}`;
      return;
    }

    scanRoot = scopedResolved;
  }

  const mediaCacheList = extensionsToUse.map(ext => `• ${ext}`).join('\n');
  const scopeLine = scanRoot !== folder ? `Scope: ${scanRoot}\n` : '';

  const confirmed = await ipc.showConfirm?.(
    `This will permanently delete Adobe media cache files:\n\n${mediaCacheList}\n\n${scopeLine}Do you want to continue?`
  );
  if (!confirmed) {
    adobe.summary.textContent += `\n⛔ Cache clearing canceled by user.`;
    return;
  }

  const ageDays = parseInt(document.getElementById('adobe-age-days')?.value || "0");
  const skipRecent = document.getElementById('adobe-skip-recent')?.checked;
  const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;
  const sizeLimitMB = parseInt(document.getElementById('adobe-size-mb')?.value || "0");


  let deleted = 0;
  let skipped = 0;

  try {
    logNLE('🚀 Clearing Adobe media cache files…');

    const allFiles = readdirRecursive(scanRoot);
    const now = Date.now();

    allFiles.forEach(filePath => {
      const ext = path.extname(filePath).toLowerCase();
      if (!extensionsToUse.includes(ext)) return;

      const stats = ipc.statSync(filePath);
      const fileAgeDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      const fileSizeMB = stats.size / (1024 * 1024);

      // Apply filters
      if (skipRecent && fileAgeDays < ageDays) {
        skipped++;
        return;
      }

      if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
        skipped++;
        return;
      }

      try {
        fs.unlinkSync(filePath);
        deleted++;
      } catch (err) {
        adobe.summary.textContent += `\n❌ Failed to delete ${filePath}: ${err.message}`;
      }
    });

    const scopeLabel = scanRoot !== folder ? ` within scope ${scanRoot}` : '';
    adobe.summary.textContent += `\n🧹 Deleted ${deleted} media cache file(s)${scopeLabel}.`;
    adobe.summary.textContent += `\n🔍 Extensions targeted: ${extensionsToUse.join(', ')}`;
    if (skipped > 0) {
      adobe.summary.textContent += `\n⏩ Skipped ${skipped} file(s) due to filters.`;
    }

    if (deleted === 0 && skipped === 0) {
      adobe.summary.textContent += `\n✅ No media cache files found.`;
    }

    logNLE(`✅ Adobe media cache cleanup complete (${deleted} deleted, ${skipped} skipped).`);

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error clearing cache: ${err.message}`;
    logNLE(`❌ Error clearing Adobe media cache: ${err.message}`, { isError: true });
  }
});

// ===============================
// 🗑 Adobe: Delete Autosave Logic
// ===============================
adobe.deleteAutosaves?.addEventListener('click', async () => {
  const folder = adobe.pathField.value;
  if (!folder) {
    adobe.summary.textContent += `\n❌ Please select an Adobe folder first.`;
    return;
  }

  const confirmed = await ipc.showConfirm?.(
    "This will permanently delete Adobe autosave project files:\n\n• .prproj\n\nDo you want to continue?"
  );
  if (!confirmed) {
    adobe.summary.textContent += `\n⛔ Autosave deletion canceled by user.`;
    return;
  }

  const ageDays = parseInt(document.getElementById('adobe-age-days')?.value || "0");
  const skipRecent = document.getElementById('adobe-skip-recent')?.checked;
  const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;
  const sizeLimitMB = parseInt(document.getElementById('adobe-size-mb')?.value || "0");

  let deleted = 0;
  let skipped = 0;

  try {
    logNLE('🚀 Deleting Adobe autosave files…');

    const allFiles = readdirRecursive(folder);
    const now = Date.now();

    allFiles.forEach(file => {
      if (!file.toLowerCase().endsWith('.prproj')) return;
      const filePath = file; // `file` is the full path now
      const stats = ipc.statSync(filePath);
      const fileAgeDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      const fileSizeMB = stats.size / (1024 * 1024);

      if (skipRecent && fileAgeDays < ageDays) {
        skipped++;
        return;
      }

      if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
        skipped++;
        return;
      }

      try {
        fs.unlinkSync(filePath);
        deleted++;
      } catch (err) {
        adobe.summary.textContent += `\n❌ Failed to delete ${file}: ${err.message}`;
      }
    });

    adobe.summary.textContent += `\n🗑 Deleted ${deleted} autosave file(s).`;
    if (skipped > 0) {
      adobe.summary.textContent += `\n⏩ Skipped ${skipped} file(s) due to filters.`;
    }

    if (deleted === 0 && skipped === 0) {
      adobe.summary.textContent += `\n✅ No autosave files found.`;
    }

    logNLE(`✅ Adobe autosave cleanup complete (${deleted} deleted, ${skipped} skipped).`);

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error deleting autosaves: ${err.message}`;
    logNLE(`❌ Error deleting Adobe autosaves: ${err.message}`, { isError: true });
  }
});

// ===============================
// 🗑 Adobe: Remove Preview Files Logic
// ===============================
adobe.removePreviews?.addEventListener('click', async () => {
  const folder = adobe.pathField.value;
  if (!folder) {
    adobe.summary.textContent += `\n❌ Please select an Adobe folder first.`;
    return;
  }

  const previewList = previewExtensions.map(ext => `• ${ext}`).join('\n');
  const confirmed = await ipc.showConfirm?.(
    `This will permanently delete Adobe preview files:\n\n${previewList}\n\nDo you want to continue?`
  );
  if (!confirmed) {
    adobe.summary.textContent += `\n⛔ Preview deletion canceled by user.`;
    return;
  }

  const ageDays = parseInt(document.getElementById('adobe-age-days')?.value || "0");
  const skipRecent = document.getElementById('adobe-skip-recent')?.checked;
  const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;
  const sizeLimitMB = parseInt(document.getElementById('adobe-size-mb')?.value || "0");


  let deleted = 0;
  let skipped = 0;

  try {
    logNLE('🚀 Deleting Adobe preview files…');

    const allFiles = readdirRecursive(folder);
    const now = Date.now();

    allFiles.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      if (!previewExtensions.includes(ext)) return;

      const filePath = file;
      const stats = ipc.statSync(filePath);
      const fileAgeDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      const fileSizeMB = stats.size / (1024 * 1024);

      if (skipRecent && fileAgeDays < ageDays) {
        skipped++;
        return;
      }

      if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
        skipped++;
        return;
      }

      try {
        fs.unlinkSync(filePath);
        deleted++;
      } catch (err) {
        adobe.summary.textContent += `\n❌ Failed to delete ${path.basename(file)}: ${err.message}`;
      }
    });

    adobe.summary.textContent += `\n🗑 Deleted ${deleted} preview file(s).`;
    if (skipped > 0) {
      adobe.summary.textContent += `\n⏩ Skipped ${skipped} file(s) due to filters.`;
    }

    if (deleted === 0 && skipped === 0) {
      adobe.summary.textContent += `\n✅ No preview files found.`;
    }

    logNLE(`✅ Adobe preview cleanup complete (${deleted} deleted, ${skipped} skipped).`);

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error deleting preview files: ${err.message}`;
    logNLE(`❌ Error deleting Adobe preview files: ${err.message}`, { isError: true });
  }
});

adobe.selectFolderBtn?.addEventListener('click', async () => {
  const folder = await ipc.selectFolder?.();
  if (folder) {
    adobe.pathField.value = folder;
    adobe.summary.textContent = `📂 Selected Adobe folder:\n${folder}`;
  } else {
    adobe.summary.textContent = `⚠️ Folder selection canceled.`;
  }
});

  // ===============================
  // 💾 Preset Handling
  // ===============================
  const saveBtn = document.getElementById('nle-save-config');
  const loadBtn = document.getElementById('nle-load-config');

  function gatherConfig() {
    const adobeSizeSkipToggle = document.getElementById('adobe-size-skip');
    const adobeSizeLimitField = document.getElementById('adobe-size-mb');
    const adobeCacheFilterField = document.getElementById('adobe-media-cache-filter');
    const adobeCacheScopeField = document.getElementById('adobe-media-cache-scope');

    return {
      avidFolder: document.getElementById('avid-folder-path').value,
      avidUser: document.getElementById('avid-user-select')?.value || '',
      scanSubfolders: document.getElementById('avid-scan-subfolders').checked,
      backupSettings: document.getElementById('avid-backup-settings').checked,
      adobeFolder: document.getElementById('adobe-folder-path').value,
      adobeSkipRecent: document.getElementById('adobe-skip-recent').checked,
      adobeAgeDays: document.getElementById('adobe-age-days').value,
      adobeSizeSkip: adobeSizeSkipToggle?.checked ?? false,
      adobeSizeLimitMB: adobeSizeLimitField?.value ?? '',
      adobeMediaCacheFilter: adobeCacheFilterField?.value ?? '',
      adobeMediaCacheScope: adobeCacheScopeField?.value ?? ''
    };
  }

  function applyPreset(data) {
    document.getElementById('avid-folder-path').value = data.avidFolder || '';
    populateAvidUsers(data.avidFolder || '', data.avidUser);
    if (avid.userSelect && data.avidUser) {
      avid.userSelect.value = data.avidUser;
    }
    document.getElementById('avid-scan-subfolders').checked = !!data.scanSubfolders;
    document.getElementById('avid-backup-settings').checked = !!data.backupSettings;
    document.getElementById('adobe-folder-path').value = data.adobeFolder || '';
    document.getElementById('adobe-skip-recent').checked = !!data.adobeSkipRecent;
    document.getElementById('adobe-age-days').value = data.adobeAgeDays || '';

    const adobeSizeSkipToggle = document.getElementById('adobe-size-skip');
    const adobeSizeLimitField = document.getElementById('adobe-size-mb');
    const adobeCacheFilterField = document.getElementById('adobe-media-cache-filter');
    const adobeCacheScopeField = document.getElementById('adobe-media-cache-scope');

    if (adobeSizeSkipToggle) {
      adobeSizeSkipToggle.checked = !!data.adobeSizeSkip;
    }

    if (adobeSizeLimitField) {
      adobeSizeLimitField.value = data.adobeSizeLimitMB ?? '';
    }

    if (adobeCacheFilterField && typeof data.adobeMediaCacheFilter !== 'undefined') {
      adobeCacheFilterField.value = data.adobeMediaCacheFilter;
    }

    if (adobeCacheScopeField && typeof data.adobeMediaCacheScope !== 'undefined') {
      adobeCacheScopeField.value = data.adobeMediaCacheScope;
    }
  }

  function refreshPresetDropdown() {
    const hidden = document.getElementById('nle-preset');
    if (!hidden) return;
    let opts = [];
    try {
      ipc.mkdir(presetDir);
      const files = ipc.readdir(presetDir) || [];
      opts = files
        .filter(f => f.endsWith('.json'))
        .map(f => ({ value: f, label: f.replace(/\.json$/, '') }));
    } catch (err) {
      console.error('Failed to read presets:', err);
    }

    setupStyledDropdown('nle-preset', opts);
    setDropdownValue('nle-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const raw = ipc.readTextFile(ipc.joinPath(presetDir, file));
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

  saveBtn?.addEventListener('click', async () => {
    const cfg = gatherConfig();
    const file = await ipc.saveFile({
      title: 'Save Preset',
      defaultPath: ipc.joinPath(presetDir, 'nle-utilities.json')
    });
    if (file) {
      ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
      ipc.send('preset-saved', 'nle-utilities');
      refreshPresetDropdown();
      alert(getLocalizedText('nleConfigSaved', 'Config saved.'));
    }
  });

  loadBtn?.addEventListener('click', async () => {
    const file = await ipc.openFile({ title: 'Load Preset' });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      applyPreset(data);
    } catch (err) {
      alert(getLocalizedText('nleConfigLoadFailed', `Failed to load config: ${err.message}`, { error: err.message }));
    }
  });

// ===============================
  // 🔁 NLE Utilities: Full Panel Reset
  // ===============================
  document.getElementById('reset-nle-utilities')?.addEventListener('click', () => {
    const avidSummaryEl = document.getElementById('avid-summary');
    const adobeSummaryEl = document.getElementById('adobe-summary');
    const avidSummaryDefault = getLocalizedText('avidSummary', avidSummaryEl?.textContent || '');
    const adobeSummaryDefault = getLocalizedText('adobeSummary', adobeSummaryEl?.textContent || '');

    // Reset all form controls within the NLE Utilities panel to their default states
    const nleUtilitiesPanel = document.getElementById('nle-utilities');
    if (nleUtilitiesPanel) {
      nleUtilitiesPanel.querySelectorAll('input, select, textarea').forEach((field) => {
        if (field.type === 'checkbox' || field.type === 'radio') {
          field.checked = field.defaultChecked;
        } else {
          field.value = field.defaultValue;
        }
      });

      const presetField = document.getElementById('nle-preset');
      if (presetField && typeof setDropdownValue === 'function') {
        setDropdownValue('nle-preset', presetField.defaultValue || '');
      }
    }

    // 🔹 Avid Fields
    if (avid.userSelect) {
      setAvidUserPlaceholder();
    }
    document.getElementById('avid-summary').textContent = avidSummaryDefault;

    // 🔹 Adobe Fields
    document.getElementById('adobe-summary').textContent = adobeSummaryDefault;

    // Reset any dynamic elements, tooltips, or logs if needed

  });

  // ─── NLE Utilities: panel overview tooltip ────────────────────────────────
  const nleOverview = document.querySelector('#nle-utilities #nle-overview-tooltip');
  if (nleOverview && !nleOverview.dataset.bound) {
    nleOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">NLE UTILITIES — Technical Overview</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Core capabilities</span>
          <ul class="tooltip-list">
            <li>Deletes and rebuilds Avid MXF database files to fix offline or stale media indexes.</li>
            <li>Resets Avid site / user settings with optional backups.</li>
            <li>Cleans Adobe/Premiere caches, autosaves, and preview media using path-scoped rules.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Under the hood</span>
          <ul class="tooltip-list">
            <li>Operates directly on filesystem targets you select (no hidden locations).</li>
            <li>Uses simple rules: match by extension, optional age/size filters, optional subfolder recursion.</li>
            <li>Writes a plain-text summary of folders touched and files deleted or backed up.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Operational notes</span>
          <ul class="tooltip-list">
            <li>Most actions are destructive and do <strong>not</strong> use the OS trash.</li>
            <li>Always confirm the target path; avoid entire volumes or home directories.</li>
          </ul>
        </div>
      </div>
    `;
    nleOverview.dataset.bound = 'true';
  }

})();
