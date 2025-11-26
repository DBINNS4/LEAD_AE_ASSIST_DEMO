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
      const isDir = typeof entry.isDirectory === 'function'
        ? entry.isDirectory()
        : entry && !entry.name.includes('.') && !entry.name.startsWith('.');
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
  summary: document.getElementById('avid-summary')
};

function logNLE(msg, opts = {}) {
  window.logPanel?.log('nle-utilities', msg, opts);
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
    mxfFolders.forEach(sub => {
      const dummyFile = path.join(sub, `REBUILD_TRIGGER_${Date.now()}.mxf`);
      fs.writeFileSync(dummyFile, 'Avid Rebuild Trigger');
      setTimeout(() => {
        if (fs.existsSync(dummyFile)) fs.unlinkSync(dummyFile); // Clean up after trigger
      }, 1000);
    });
    avid.summary.textContent += `\n⚙️ Auto-rebuild triggered in ${mxfFolders.length} folder(s).`;
  } catch (err) {
    avid.summary.textContent += `\n❌ Auto-rebuild failed: ${err.message}`;
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
    return;
  }

  let triggered = 0;

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
    }
  });

  if (triggered === 0) {
    avid.summary.textContent += `\n⚠️ No dummy files created.`;
  } else {
    avid.summary.textContent += `\n✅ Dummy files created in ${triggered} folder(s).`;
  }
});

avid.selectBtn?.addEventListener('click', async () => {
  const folder = await ipc.selectFolder?.();
  if (folder) {
    avid.pathField.value = folder;
    avid.summary.textContent = `📂 Selected Avid folder:\n${folder}`;
  } else {
    avid.summary.textContent = `⚠️ Folder selection canceled.`;
    return;
  }

  const showCounts = document.getElementById('avid-show-counts')?.checked;

  if (showCounts) {
    try {
      const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
      let foldersToScan = [folder];

      if (scanSubfolders) {
        const collectSubfolders = (dir) => {
          const entries = ipc.readdirWithTypes(dir);
          entries.forEach(entry => {
            const isDir = typeof entry.isDirectory === 'function'
              ? entry.isDirectory()
              : entry && entry.name && !entry.name.includes('.') && !entry.name.startsWith('.');
            if (isDir) {
              const fullPath = path.join(dir, entry.name);
              foldersToScan.push(fullPath);
              collectSubfolders(fullPath); // recurse
            }
          });
        };
        collectSubfolders(folder);
      }

      let totalMXF = 0, totalMDB = 0, totalPMR = 0;

      foldersToScan.forEach(dir => {
        const files = ipc.readdir(dir);
        totalMXF += files.filter(f => f.toLowerCase().endsWith('.mxf')).length;
        totalMDB += files.filter(f => f.toLowerCase().endsWith('.mdb')).length;
        totalPMR += files.filter(f => f.toLowerCase().endsWith('.pmr')).length;
      });

      avid.summary.textContent += `\n📊 File Counts — ${foldersToScan.length} folder(s)\n• MXF: ${totalMXF} | MDB: ${totalMDB} | PMR: ${totalPMR} ✅`;

    } catch (err) {
      avid.summary.textContent += `\n❌ Failed to count files: ${err.message}`;
    }
  } // ✅ this was missing
});

document.getElementById('avid-show-counts')?.addEventListener('change', () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  avid.summary.textContent = `📂 Selected: ${folder}`;

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;

  if (showCounts) {
    try {
      let foldersToScan = [folder];

      if (scanSubfolders) {
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
        collectSubfolders(folder);
      }

      let totalMXF = 0, totalMDB = 0, totalPMR = 0;

      foldersToScan.forEach(dir => {
        const files = ipc.readdir(dir);
        totalMXF += files.filter(f => f.toLowerCase().endsWith('.mxf')).length;
        totalMDB += files.filter(f => f.toLowerCase().endsWith('.mdb')).length;
        totalPMR += files.filter(f => f.toLowerCase().endsWith('.pmr')).length;
      });

      avid.summary.textContent += `\n📊 File Counts — ${foldersToScan.length} folder(s)\n• MXF: ${totalMXF} | MDB: ${totalMDB} | PMR: ${totalPMR} ✅`;

    } catch (err) {
      avid.summary.textContent += `\n❌ Failed to count files: ${err.message}`;
    }
  }
});

document.getElementById('avid-scan-subfolders')?.addEventListener('change', () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;

  if (showCounts) {
    try {
      let foldersToScan = [folder];

      if (scanSubfolders) {
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
        collectSubfolders(folder);
      }

      let totalMXF = 0, totalMDB = 0, totalPMR = 0;

      foldersToScan.forEach(dir => {
        const files = ipc.readdir(dir);
        totalMXF += files.filter(f => f.toLowerCase().endsWith('.mxf')).length;
        totalMDB += files.filter(f => f.toLowerCase().endsWith('.mdb')).length;
        totalPMR += files.filter(f => f.toLowerCase().endsWith('.pmr')).length;
      });

      avid.summary.textContent += `\n📊 File Counts — ${foldersToScan.length} folder(s)\n• MXF: ${totalMXF} | MDB: ${totalMDB} | PMR: ${totalPMR} ✅`;

    } catch (err) {
      avid.summary.textContent += `\n❌ Failed to count files: ${err.message}`;
    }
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

  try {
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
      const files = fs.readdirSync(siteFolder).filter(f => f.toLowerCase().endsWith(ext));
      files.forEach(file => {
        const filePath = path.join(siteFolder, file);
        fs.unlinkSync(filePath);
        deleted.push(file);
      });
    });

    if (deleted.length) {
      avid.summary.textContent += `\n🧹 Deleted site setting files:\n${deleted.join(', ')}`;
    } else {
      avid.summary.textContent += `\n✅ No .xml/.pref/.set files found to delete.`;
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Error resetting site settings: ${err.message}`;
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
  if (await ipc.isMediaComposerRunning?.()) {
    avid.summary.textContent += `\n⚠️ Media Composer is currently running. Quit it before resetting.`;
    return;
  }  
  const folder = path.join(baseFolder, 'Users', 'EditorName');
  
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
    } else {
      avid.summary.textContent += `\n✅ No .avs/.xml/.pref files found to delete.`;
    }
  } catch (err) {
    avid.summary.textContent += `\n❌ Error: ${err.message}`;
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

  const mediaCacheList = mediaCacheExtensions.map(ext => `• ${ext}`).join('\n');
  const confirmed = await ipc.showConfirm?.(
    `This will permanently delete Adobe media cache files:\n\n${mediaCacheList}\n\nDo you want to continue?`
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
    const allFiles = readdirRecursive(folder);
    const now = Date.now();

    allFiles.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      if (!mediaCacheExtensions.includes(ext)) return;

      const filePath = path.join(folder, file);
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
        adobe.summary.textContent += `\n❌ Failed to delete ${file}: ${err.message}`;
      }
    });

    adobe.summary.textContent += `\n🧹 Deleted ${deleted} media cache file(s).`;
    if (skipped > 0) {
      adobe.summary.textContent += `\n⏩ Skipped ${skipped} file(s) due to filters.`;
    }

    if (deleted === 0 && skipped === 0) {
      adobe.summary.textContent += `\n✅ No media cache files found.`;
    }

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error clearing cache: ${err.message}`;
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

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error deleting autosaves: ${err.message}`;
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

  } catch (err) {
    adobe.summary.textContent += `\n❌ Error deleting preview files: ${err.message}`;
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
    return {
      avidFolder: document.getElementById('avid-folder-path').value,
      scanSubfolders: document.getElementById('avid-scan-subfolders').checked,
      backupSettings: document.getElementById('avid-backup-settings').checked,
      adobeFolder: document.getElementById('adobe-folder-path').value,
        adobeSkipRecent: document.getElementById('adobe-skip-recent').checked,
        adobeAgeDays: document.getElementById('adobe-age-days').value
      };
    }

  function applyPreset(data) {
    document.getElementById('avid-folder-path').value = data.avidFolder || '';
    document.getElementById('avid-scan-subfolders').checked = !!data.scanSubfolders;
    document.getElementById('avid-backup-settings').checked = !!data.backupSettings;
    document.getElementById('adobe-folder-path').value = data.adobeFolder || '';
      document.getElementById('adobe-skip-recent').checked = !!data.adobeSkipRecent;
      document.getElementById('adobe-age-days').value = data.adobeAgeDays || '';
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
      alert('Config saved.');
    }
  });

  loadBtn?.addEventListener('click', async () => {
    const file = await ipc.openFile({ title: 'Load Preset' });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      applyPreset(data);
    } catch (err) {
      alert('Failed to load config: ' + err.message);
    }
  });

// ===============================
  // 🔁 NLE Utilities: Full Panel Reset
  // ===============================
  document.getElementById('reset-nle-utilities')?.addEventListener('click', () => {
    // 🔹 Avid Fields
    document.getElementById('avid-folder-path').value = '';
    document.getElementById('avid-scan-subfolders').checked = false;
    document.getElementById('avid-backup-settings').checked = false;
    document.getElementById('avid-summary').textContent = '📊 Avid summary will appear here.';

    // 🔹 Adobe Fields
    document.getElementById('adobe-folder-path').value = '';
      document.getElementById('adobe-skip-recent').checked = false;
      document.getElementById('adobe-age-days').value = '';
    document.getElementById('adobe-summary').textContent = '📊 Adobe cleanup summary will appear here.';

    // Reset any dynamic elements, tooltips, or logs if needed

  });

  // ─── NLE Utilities: panel overview tooltip ────────────────────────────────
  const nleOverview = document.querySelector('#nle-utilities #nle-overview-tooltip');
  if (nleOverview && !nleOverview.dataset.bound) {
    nleOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">NLE UTILITIES OVERVIEW</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What this panel is for</span>
          <ul class="tooltip-list">
            <li>Clean up and repair Avid media databases and site/user settings.</li>
            <li>Clean Adobe/Premiere caches, autosaves, and preview files.</li>
            <li>Run “last‑resort” maintenance on NLE systems that are misbehaving.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Quick workflow</span>
          <ul class="tooltip-list">
            <li><strong>Select a toolset</strong> – expand the Avid or Adobe section that matches the problem.</li>
            <li><strong>Target a folder</strong> – point at the specific media/cache/project folder you want to affect.</li>
            <li><strong>Review options</strong> – decide on subfolder scanning, backups, and which items to touch.</li>
            <li><strong>Run the action</strong> – execute and read the summary to see exactly what changed.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Important safety notes</span>
          <ul class="tooltip-list">
            <li><strong>Many actions permanently delete files</strong> (Avid .mdb/.pmr, caches, autosaves, preview media, etc.).</li>
            <li>Deleted items are not sent to the OS trash and cannot be auto‑restored from this tool.</li>
            <li>Double‑check the selected path before running and avoid pointing at entire volumes or home directories.</li>
            <li>Ideally test on a non‑critical project or make a backup first.</li>
          </ul>
        </div>
      </div>
    `;
    nleOverview.dataset.bound = 'true';
  }

})();
