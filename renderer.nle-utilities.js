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

avidDeleteDbBtn?.addEventListener('click', () => {
  // DEMO: button is visual-only (hover/press); no Avid DB deletion logic.
});

const avidRebuildDbBtn = document.getElementById('avid-rebuild-db');

avidRebuildDbBtn?.addEventListener('click', () => {
  // DEMO: visual-only; no rebuild logic.
});

avid.selectBtn?.addEventListener('click', () => {
  // DEMO: visual-only; no folder picker / summary changes.
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

avidResetSiteBtn?.addEventListener('click', () => {
  // DEMO: Reset Site Settings is visual-only; no files are touched.
});

// ===============================
// 🔧 Avid: User Settings Reset
// ===============================
const avidResetUserBtn = document.getElementById('avid-reset-user');
const avidBackupCheckbox = document.getElementById('avid-backup-settings');

avidResetUserBtn?.addEventListener('click', () => {
  // DEMO: Reset User Settings is visual-only; no files or prefs are modified.
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
adobe.clearCache?.addEventListener('click', () => {
  // DEMO: visual-only; no cache deletion.
});

// ===============================
// 🗑 Adobe: Delete Autosave Logic
// ===============================
adobe.deleteAutosaves?.addEventListener('click', () => {
  // DEMO: visual-only; no autosave deletion.
});

// ===============================
// 🗑 Adobe: Remove Preview Files Logic
// ===============================
adobe.removePreviews?.addEventListener('click', () => {
  // DEMO: visual-only; no preview file deletion.
});

adobe.selectFolderBtn?.addEventListener('click', () => {
  // DEMO: visual-only; no folder selection, no summary updates.
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

  saveBtn?.addEventListener('click', () => {
    // DEMO: visual-only; no preset saving.
  });

  loadBtn?.addEventListener('click', () => {
    // DEMO: visual-only; no preset loading.
  });

// ===============================
  // 🔁 NLE Utilities: Full Panel Reset
  // ===============================
  document.getElementById('reset-nle-utilities')?.addEventListener('click', () => {
    // DEMO: visual-only; no reset logic.
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
