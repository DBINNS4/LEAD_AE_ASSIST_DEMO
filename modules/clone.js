const ProgressManager = require('../utils/progressManager');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { BrowserWindow } = require('electron');
// Helper to always target the main window, even when DevTools has focus
const getMainWindow = () => global.mainWindow || BrowserWindow.getAllWindows()[0];
const { sendLogMessage, writeLogToFile, archiveLog } = require('./logUtils');
const { getBlake3Hash } = require('./hashUtils');
const { ensureUserDataSubdir } = require('../utils/appPaths');

function getJobFilePath() {
  return path.join(ensureUserDataSubdir('logs'), 'job-queue.json');
}

function removeJobFile() {
  const jobFile = getJobFilePath();
  try {
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
  } catch {
    // ignore cleanup errors
  }
}
const sendCloneLog = (msg, isError = false, detail = '', fileId = '') => {
  sendLogMessage('clone', msg, detail, isError, fileId);
};

const {
  copyFileWithProgress,       // ✅ Add this
  copyFileWithVerification,
  runWithConcurrencyLimit
} = require('./fileUtils');
const { cancelIngest, createCancelToken } = require('./cancelUtils');
const { estimateDiskWriteSpeed } = require('./speedUtils');
const { compareFilesByteByByte } = require('../utils/compare');

// 🛑 Allows user to cancel the clone operation
function cancelClone(id) {
  cancelIngest(id);
  sendCloneLog('🛑 Clone cancel requested...');
}


const toForwardSlash = (value) => (typeof value === 'string' ? value.replace(/\\/g, '/') : '');

const safeResolvePath = (input) => {
  if (typeof input !== 'string' || input.length === 0) return null;
  try {
    return path.resolve(input);
  } catch {
    return null;
  }
};

function normalizePathForCompare(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function parseExtension(name = '') {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function normalizeExtensions(extString = '') {
  return String(extString)
    .split(',')
    .map(str => str.trim().toLowerCase().replace(/^\*/, ''))
    .filter(Boolean)
    .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));
}

function buildSelection(config) {
  const norm = (arr) => {
    const out = new Set();
    for (const p of Array.isArray(arr) ? arr : []) {
      const n = normalizePathForCompare(p);
      if (n) out.add(n);
    }
    return out;
  };
  // Keep nested selections; traversal rules in the planner rely on them.
  const blue = norm(config.selectedFolders);
  const red = norm(config.foldersOnly);
  const off = norm(config.excludedFolders);
  return { blue, red, off };
}

function filterSelectionByRoot(selection, rootPath) {
  const normalizedRoot = normalizePathForCompare(rootPath);
  const filterSet = (set = new Set()) => {
    const next = new Set();
    for (const value of set) {
      const normalized = normalizePathForCompare(value);
      if (!normalized) continue;
      if (!normalizedRoot) {
        next.add(normalized);
      } else if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) {
        next.add(normalized);
      }
    }
    return next;
  };

  return {
    blue: filterSet(selection?.blue),
    red: filterSet(selection?.red),
    off: filterSet(selection?.off)
  };
}

function isExcluded(pathNorm, offSet) {
  if (!pathNorm) return false;
  if (offSet.has(pathNorm)) return true;
  let cur = pathNorm;
  while (true) {
    const idx = cur.lastIndexOf('/');
    if (idx < 0) return false;
    cur = cur.slice(0, idx);
    if (offSet.has(cur)) return true;
  }
}

async function planCloneEntries(config) {
  const sourceRoot = normalizePathForCompare(config.source);
  if (!sourceRoot) return { files: [], dirs: [] };

  const includeExts = normalizeExtensions(config.includeExtensions || config.filters?.include || '');
  const excludeExts = normalizeExtensions(config.excludeExtensions || config.filters?.exclude || '');
  const excludePatternsInput = Array.isArray(config.excludePatterns)
    ? config.excludePatterns
    : String(config.excludePatterns || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
  const excludePatterns = excludePatternsInput.map(s => String(s || '').toLowerCase());

  const shouldIncludeFile = (name) => {
    const ext = parseExtension(name);
    if (includeExts.length && !includeExts.includes(ext)) return false;
    if (excludeExts.includes(ext)) return false;
    const lower = name.toLowerCase();
    if (excludePatterns.some(p => lower.includes(p))) return false;
    if (name.startsWith('.') || lower === '.ds_store') return false;
    return true;
  };

  const selection = config.selection || buildSelection(config);
  const { blue, red, off } = selection;

  const toPosix = p => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const hasSelectedDescendant = (dir) => {
    const base = toPosix(dir);
    const prefix = base.endsWith('/') ? base : `${base}/`;
    for (const s of blue) {
      const ss = toPosix(s);
      if (ss !== base && ss.startsWith(prefix)) return true;
    }
    for (const s of red) {
      const ss = toPosix(s);
      if (ss !== base && ss.startsWith(prefix)) return true;
    }
    return false;
  };

  const roots = Array.from(new Set([...blue, ...red]));

  const files = [];
  const dirSet = new Set();

  const normalizedRootsSet = new Set();

  for (const node of roots) {
    const normalizedNode = normalizePathForCompare(node);
    if (!normalizedNode) continue;
    if (!(normalizedNode === sourceRoot || normalizedNode.startsWith(`${sourceRoot}/`))) continue;
    normalizedRootsSet.add(normalizedNode);
  }

  const normalizedRoots = Array.from(normalizedRootsSet).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  const visited = new Set();

  async function walk(dirNorm, mode) {
    if (!dirNorm) return;
    if (visited.has(dirNorm)) return;
    if (isExcluded(dirNorm, off)) return;
    visited.add(dirNorm);

    let entries;
    try {
      entries = await fsp.readdir(dirNorm, { withFileTypes: true });
    } catch {
      return;
    }

    const relDir = dirNorm.slice(sourceRoot.length).replace(/^[\\/]/, '');
    if (relDir) dirSet.add(relDir);

    if (mode === 'blue') {
      for (const entry of entries) {
        if (entry.isFile() && shouldIncludeFile(entry.name)) {
          const fullPath = `${dirNorm}/${entry.name}`.replace(/[\\/]+/g, '/');
          files.push({
            fullPath,
            relativePath: relDir ? `${relDir}/${entry.name}` : entry.name
          });
        }
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childNorm = normalizePathForCompare(`${dirNorm}/${entry.name}`);
      if (isExcluded(childNorm, off)) continue;

      let shouldDescend = false;
      let nextMode = 'red';

      if (red.has(childNorm)) {
        shouldDescend = true;
        nextMode = 'red';
      } else if (blue.has(childNorm)) {
        shouldDescend = true;
        nextMode = 'blue';
      } else if (mode === 'red') {
        shouldDescend = true;
        nextMode = 'red';
      } else if (hasSelectedDescendant(childNorm)) {
        shouldDescend = true;
        nextMode = 'red';
      }

      if (shouldDescend) {
        await walk(childNorm, nextMode);
      }
    }
  }

  for (const root of normalizedRoots) {
    if (visited.has(root)) continue;
    if (isExcluded(root, off)) continue;
    const mode = blue.has(root) ? 'blue' : 'red';
    await walk(root, mode);
  }

  const filesSorted = files.slice().sort((a, b) => {
    const relA = a?.relativePath ?? '';
    const relB = b?.relativePath ?? '';
    return relA.localeCompare(relB);
  });

  return {
    files: filesSorted,
    dirs: Array.from(dirSet).sort()
  };
}


// 🚀 Main clone function
async function runClone(config) {
  const log = [];
  const origPush = log.push.bind(log);
  log.push = (msg) => {
    sendLogMessage('clone', msg, '', /❌|error/i.test(msg));
    return origPush(msg);
  };
  try {
    removeJobFile();
  } catch {}
  if (!config.signal) config.signal = createCancelToken();
  const {
    source,
    destination,
    createIfMissing,
    skipExisting,
    checksum,
    checksumMethod,
    verbose,
    maxThreads = 3,
    saveLog,
    enableN8N,
    n8nUrl,
    n8nLog,
    notes
  } = config;
  
  const cloneSourceRoot = source; // ✅ Anchor point for relative paths

  const allowedMethods = ['blake3', 'sha256', 'md5', 'xxhash64'];
  if (checksum && !allowedMethods.includes(checksumMethod)) {
    const msg = `❌ Unsupported checksum method: ${checksumMethod}`;
    sendCloneLog(msg, true);
    return { success: false, log: [msg] };
  }

  if (!fs.existsSync(source)) {
    const msg = `❌ Source folder does not exist: ${source}`;
    sendCloneLog(msg, true);
    return { success: false, log: [msg] };
  }

  if (!fs.existsSync(destination)) {
    if (createIfMissing) {
      fs.mkdirSync(destination, { recursive: true });
      log.push(`📁 Created destination folder: ${destination}`);
    } else {
      const msg = `❌ Destination folder does not exist: ${destination}`;
      sendCloneLog(msg, true);
      return { success: false, log: [msg] };
    }
  }

  const rootName = path.basename(cloneSourceRoot);
  const destRoot = path.join(destination, rootName);
  fs.mkdirSync(destRoot, { recursive: true });
  log.push(`📁 Ensured root folder: ${destRoot}`);

  let backupRoot = null;
  if (config.backup && config.backupPath) {
    backupRoot = path.join(config.backupPath, rootName);
    fs.mkdirSync(backupRoot, { recursive: true });
    log.push(`📁 Ensured backup root folder: ${backupRoot}`);
  }

  const resolvedSourceRoot = safeResolvePath(cloneSourceRoot) || cloneSourceRoot;
  const normalizedSourceRoot = normalizePathForCompare(resolvedSourceRoot);
  const selection = filterSelectionByRoot(buildSelection(config), resolvedSourceRoot);
  const selectedNodes = new Set([...selection.blue, ...selection.red]);

  const selectionEntriesMap = new Map();
  for (const value of selection.blue) {
    const normalized = normalizePathForCompare(value);
    if (!normalized) continue;
    selectionEntriesMap.set(normalized, { path: normalized, isRed: false });
  }
  for (const value of selection.red) {
    const normalized = normalizePathForCompare(value);
    if (!normalized) continue;
    selectionEntriesMap.set(normalized, { path: normalized, isRed: true });
  }

  const selectionEntries = Array.from(selectionEntriesMap.values())
    .sort((a, b) => b.path.length - a.path.length);

  const deepestSelected = (absPath) => {
    const normalized = normalizePathForCompare(absPath);
    if (!normalized) return null;
    for (const entry of selectionEntries) {
      if (normalized === entry.path || normalized.startsWith(`${entry.path}/`)) {
        return entry;
      }
    }
    return null;
  };

  const toRelativeFromSource = (absPath) => {
    const normalized = normalizePathForCompare(absPath);
    if (!normalizedSourceRoot || !normalized) return '';
    if (normalized === normalizedSourceRoot) return '';
    if (!normalized.startsWith(`${normalizedSourceRoot}/`)) return '';
    return normalized.slice(normalizedSourceRoot.length + 1);
  };

  if (!selectedNodes.size) {
    const msg = `⚠️ No folders selected. Please select at least one.`;
    sendCloneLog(msg, true);
    return { success: false, log: [msg] };
  }

  const includeExts = normalizeExtensions(config.includeExtensions || config.filters?.include || '');
  const excludeExts = normalizeExtensions(config.excludeExtensions || config.filters?.exclude || '');
  const rawExcludePatterns = Array.isArray(config.excludePatterns)
    ? config.excludePatterns
    : String(config.excludePatterns || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
  const excludePatterns = rawExcludePatterns.map(p => p.toLowerCase());

  const selectedList = Array.from(selectedNodes).map(toForwardSlash).sort();
  log.push(`🔍 Selected nodes: ${JSON.stringify(selectedList)}`);
  if (selection.red.size) {
    const foldersOnly = Array.from(selection.red).map(toForwardSlash).sort();
    log.push(`📁 Folders-only: ${JSON.stringify(foldersOnly)}`);
  }
  if (selection.off.size) {
    const excluded = Array.from(selection.off).map(toForwardSlash).sort();
    log.push(`🚫 Excluded folders: ${JSON.stringify(excluded)}`);
  }

  const plannerConfig = {
    ...config,
    source: resolvedSourceRoot,
    selection,
    excludePatterns: rawExcludePatterns
  };
  const { files: plannedFiles } = await planCloneEntries(plannerConfig);

  const mappedFiles = plannedFiles
    .map(item => {
      if (!item || !item.fullPath) return null;
      const fullPath = item.fullPath;
      const relativePath = config.flatten
        ? path.basename(fullPath)
        : item.relativePath;
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
      }
      return { fullPath, relativePath };
    })
    .filter(Boolean);

  const files = mappedFiles.filter(({ fullPath }) => {
    const abs = normalizePathForCompare(fullPath);
    if (!abs) return false;
    if (isExcluded(abs, selection.off)) return false;

    const anc = deepestSelected(abs);
    if (!anc) return false;

    const parentDir = normalizePathForCompare(path.dirname(fullPath));

    if (anc.isRed && parentDir === anc.path) return false;
    if (!anc.isRed && parentDir !== anc.path) return false;

    return true;
  });

  const dirSet = new Set();

  for (const entry of selectionEntries) {
    const rel = toRelativeFromSource(entry.path);
    if (rel && rel !== '.' && !rel.startsWith('..')) dirSet.add(rel);
  }

  for (const file of files) {
    const relDir = path.posix.dirname(file.relativePath);
    if (relDir && relDir !== '.' && !relDir.startsWith('..')) dirSet.add(relDir);
  }

  const dirsToCreate = Array.from(dirSet).sort();

  for (const rel of dirsToCreate) {
    try {
      fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
      log.push(`📁 Ensured folder: ${rel}`);
    } catch (err) {
      log.push(`⚠️ Failed to create folder ${rel}: ${err.message}`);
    }
    if (backupRoot) {
      try {
        fs.mkdirSync(path.join(backupRoot, rel), { recursive: true });
      } catch (err) {
        log.push(`⚠️ Failed to create backup folder ${rel}: ${err.message}`);
      }
    }
  }

  log.push(`📂 Selected folders:`);
  selectedList.forEach(f => log.push(`  • ${f}`));
  log.push(`✅ Include extensions: ${includeExts.join(', ') || 'All'}`);
  log.push(`🚫 Exclude extensions: ${excludeExts.join(', ') || 'None'}`);
  log.push(`🚫 Exclude patterns: ${excludePatterns.join(', ') || 'None'}`);

  const copiedFiles = [];
  const skippedFiles = [];
  const failedFiles = [];

  let totalBytes = 0;
  files.forEach(({ fullPath }) => {
    try {
      const size = fs.statSync(fullPath).size;
      totalBytes += backupRoot ? size * 2 : size;
    } catch {}
  });

  const progressManager = new ProgressManager(totalBytes, 250, 'bytes');
  progressManager.setTotalFiles(files.length);

  log.push(`📦 Found ${files.length} file(s) to clone.`);
  sendCloneLog(`📦 Found ${files.length} file(s) to clone.`);

  if (!files.length) {
    const notice = '⚠️ No files to copy based on current selection.';
    sendCloneLog(notice);
    log.push(notice);
    progressManager.finishAll?.();
    progressManager.dispose?.();
    if (global.queue) {
      global.queue.emit('job-complete', {
        id: config.jobId,
        panel: 'clone',
        result: { success: true }
      });
    }
    return { success: true, log };
  }


  progressManager.on('stream-progress', payload => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
  // Progress routed solely through the queue manager
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      file: payload.file,
      percent: payload.overall,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles,
      streamId: payload.streamId
    });
  }
});

progressManager.on('overall-progress', payload => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  // Legacy 'clone-progress' event removed; queue manager handles updates
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      percent: payload.overall,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles
    });
  }
});

progressManager.on('file-status', payload => {
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      file: payload.file,
      status: { ...payload.statusMap },
      streamId: payload.streamId
    });
  }
});

// 🧵 Prepare file copy tasks
  const tasks = files.map(({ fullPath, relativePath }) => async (streamId) => {
    const statusMap = { copied: false, checksummed: false };
    if (verbose) sendCloneLog(`📁 Starting copy: ${relativePath}`);

    if (config.signal?.aborted) {
      const msg = `🛑 Clone canceled during: ${relativePath}`;
      log.push(msg);
      failedFiles.push(relativePath);
      return;
    }

    const destPath = path.join(destRoot, relativePath);
    const destDir = path.dirname(destPath);
    let finalDest = destPath;

    try {
      fs.mkdirSync(destDir, { recursive: true });

      const exists = fs.existsSync(finalDest);
      if (exists) {
        if (skipExisting) {
          if (verbose) log.push(`⚠️ Skipped (exists): ${relativePath}`);
          skippedFiles.push(relativePath);
          return;
        }

        else {
  log.push(`🔍 Overwriting existing file: ${relativePath}`);
}
      }

// ✅ Step 1: Copy the file
const fileSize = fs.statSync(fullPath).size;


progressManager.startFile(streamId, fullPath, fileSize);

    await copyFileWithProgress(
      fullPath,
      finalDest,
      (_percent, chunkSize) => {
        progressManager.updateStream(streamId, chunkSize);
      },
      config.signal
    );

    statusMap.copied = true;
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'clone',
        file: relativePath,
        status: { ...statusMap }
      });
    }

    // ✅ Immediately notify UI of successful copy
    if (verbose) sendCloneLog(`✅ Copied: ${relativePath}`);

    if (backupRoot) {
      const rel = relativePath;
      const finalBackupPath = path.join(backupRoot, rel);
      fs.mkdirSync(path.dirname(finalBackupPath), { recursive: true });
      await copyFileWithProgress(
        finalDest,
        finalBackupPath,
        (_percent, chunkSize) => progressManager.updateStream(streamId, chunkSize),
        config.signal
      );
      log.push(`📦 Backed up: ${rel}`);
    }

    // ✅ Step 2: Run verification (if enabled)
    if (checksum) {
      if (verbose) sendCloneLog(`🔍 Verifying: ${relativePath}`);

  if (checksumMethod === 'blake3') {
    const src = await getBlake3Hash(fullPath);
    const dest = await getBlake3Hash(finalDest);

    log.push(`🧪 Verifying ${relativePath} with BLAKE3`);
    log.push(`🔍 Source hash (${src.method}): ${src.hash}`);
    log.push(`🔍 Dest hash   (${dest.method}): ${dest.hash}`);

    if (src.hash !== dest.hash) {
      fs.unlinkSync(finalDest);
      throw new Error(`BLAKE3 mismatch`);
    }
  } else {
    log.push(`🧪 Verifying ${relativePath} with ${checksumMethod.toUpperCase()}`);
    await copyFileWithVerification(fullPath, finalDest, checksumMethod);
    log.push(`✅ Verified with ${checksumMethod.toUpperCase()}`);
  }
    statusMap.checksummed = true;
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'clone',
        file: relativePath,
        status: { ...statusMap }
      });
    }
  }

if (config.byteCompare) {
  if (verbose) sendCloneLog(`🔍 Byte-level comparing: ${relativePath}`);
  const isIdentical = await compareFilesByteByByte(fullPath, finalDest);
  if (!isIdentical) {
    fs.unlinkSync(finalDest);
    throw new Error('Byte-level mismatch');
  }
  if (verbose) log.push(`✅ Byte-level match: ${relativePath}`);
}

if (verbose) log.push(`✅ Copied: ${relativePath}`);
copiedFiles.push(relativePath);

    progressManager.finishFile(streamId, statusMap);
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'clone',
        file: relativePath,
        status: { ...statusMap }
      });
    }

} catch (err) {
      if (config.signal?.aborted) {
        const msg = `🛑 Canceled during: ${relativePath}`;
        log.push(msg);
        failedFiles.push(relativePath);
        return;
      }
      const msg = `❌ Failed: ${relativePath} → ${err.message}`;
      log.push(msg);
      failedFiles.push(relativePath);
    }
  });

  let threadCount = maxThreads;

  if (!threadCount || isNaN(threadCount)) {
    try {
      const speed = await estimateDiskWriteSpeed(destination);
      log.push(`⚡ Estimated write speed: ${speed} MiB/s`);
      threadCount =
        speed < 50  ? 2 :
        speed < 100 ? 3 :
        speed < 200 ? 4 :
        speed < 400 ? 5 :
                      6;
      log.push(`🧵 Auto-selected thread count: ${threadCount}`);
    } catch (err) {
      threadCount = 3;
      log.push(`⚠️ Disk speed check failed (${err.message}), defaulting to ${threadCount} threads`);
    }
  } else {
    log.push(`🧵 Using user-defined thread count: ${threadCount}`);
  }

  const results = await runWithConcurrencyLimit(tasks, threadCount);
  let retryResults = [];

// 🔁 Retry failed files if enabled
if (config.retryFailures && failedFiles.length > 0) {
  const finalFailedFiles = [...failedFiles]; // ✅ Preserve original failures
  failedFiles.length = 0; // ✅ Clear for retry tracking

  log.push(`🔁 Retrying ${finalFailedFiles.length} failed file(s)...`);
  sendCloneLog(`🔁 Retrying ${finalFailedFiles.length} failed file(s)...`);

  const retryTasks = files.filter(f =>
    finalFailedFiles.includes(f.relativePath)
  ).map(({ fullPath, relativePath }) => async (streamId) => {
    const statusMap = { copied: false, checksummed: false };
    try {
      const destPath = path.join(destRoot, relativePath);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });

      progressManager.startFile(streamId, fullPath, fs.statSync(fullPath).size);
      await copyFileWithProgress(
        fullPath,
        destPath,
        (_p, c) => {
          progressManager.updateStream(streamId, c);
        },
        config.signal
      );

      statusMap.copied = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'clone',
          file: relativePath,
          status: { ...statusMap }
        });
      }

      if (backupRoot) {
        const rel = relativePath;
        const finalBackupPath = path.join(backupRoot, rel);
        fs.mkdirSync(path.dirname(finalBackupPath), { recursive: true });
        await copyFileWithProgress(
          destPath,
          finalBackupPath,
          (_percent, chunkSize) => progressManager.updateStream(streamId, chunkSize),
          config.signal
        );
        log.push(`📦 Backed up: ${rel}`);
      }

      if (checksum) {
        if (checksumMethod === 'blake3') {
          const src = await getBlake3Hash(fullPath);
          const dest = await getBlake3Hash(destPath);
          if (src.hash !== dest.hash) throw new Error('BLAKE3 mismatch');
        } else {
          await copyFileWithVerification(fullPath, destPath, checksumMethod);
        }
      }

      statusMap.checksummed = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'clone',
          file: relativePath,
          status: { ...statusMap }
        });
      }

      if (config.byteCompare) {
        const isIdentical = await compareFilesByteByByte(fullPath, destPath);
        if (!isIdentical) throw new Error('Byte-level mismatch');
      }

      copiedFiles.push(relativePath);
      log.push(`✅ Retried & copied: ${relativePath}`);
      progressManager.finishFile(streamId, statusMap);
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'clone',
          file: relativePath,
          status: { ...statusMap }
        });
      }
    } catch (err) {
      log.push(`❌ Retry failed: ${relativePath} → ${err.message}`);
      failedFiles.push(relativePath); // ✅ Track persistent failures
    }
  });

  retryResults = await runWithConcurrencyLimit(retryTasks, threadCount);
}

  const allTaskResults = [...results, ...retryResults];
  if (progressManager?.dispose) {
    progressManager.finishAll?.();
    progressManager.dispose();
  } else if (progressManager?.finishAll) {
    progressManager.finishAll();
  }

  if (global.queue) {
    const overallSuccess =
      allTaskResults.length === 0
        ? failedFiles.length === 0
        : allTaskResults.every(result => !result || result.success !== false);
    global.queue.emit('job-complete', {
      id: config.jobId,
      panel: 'clone',
      result: {
        success: overallSuccess && failedFiles.length === 0,
        files: copiedFiles.length,
        skipped: skippedFiles.length,
        failed: failedFiles.length
      }
    });
  }

  // ✅ Log summary
  log.push(`\n✅ Clone complete.`);
  log.push(`   • Copied: ${copiedFiles.length}`);
  log.push(`   • Skipped: ${skippedFiles.length}`);
  log.push(`   • Failed: ${failedFiles.length}`);

  sendCloneLog(`✅ Clone complete. Copied: ${copiedFiles.length}, Skipped: ${skippedFiles.length}, Failed: ${failedFiles.length}`);
  
  if (enableN8N && n8nUrl) {
    const payload = n8nLog
      ? { log }
      : {
          status: 'complete',
          notes,
          success: true,
          skipped: skippedFiles.length,
          failed: failedFiles.length
        };

    log.push(`🛰️ Preparing to send data to: ${n8nUrl}`);
    log.push(`📦 Payload preview:\n${JSON.stringify(payload, null, 2)}`);

    try {
      const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
      await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      log.push('🌐 n8n webhook triggered');
    } catch (err) {
      log.push(`⚠️ Failed to trigger n8n webhook: ${err.message}`);
    }
  }

  if (saveLog) {
    const logPath = path.join(destination, `clone-log-${Date.now()}.txt`);
    writeLogToFile(log, logPath);
    log.push(`📝 Log saved to: ${logPath}`);
  }

  const archivePath = archiveLog(log, 'clone');
  log.push(`📂 Log archived to: ${archivePath}`);

  // 🧹 Optionally remove empty folders
if (config.removeEmptyFolders) {
  const removeEmptyDirs = dir => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        removeEmptyDirs(fullPath);
      }
    }
    const leftover = fs.readdirSync(dir);
    if (leftover.length === 0) {
      fs.rmdirSync(dir);
      log.push(`🗑 Removed empty folder: ${dir}`);
    }
  };

  removeEmptyDirs(destRoot);
}

if (skippedFiles.length) {
  log.push(`⚠️ Skipped files (${skippedFiles.length}):`);
  skippedFiles.forEach(f => log.push(`  • ${f}`));
}

if (failedFiles.length) {
  log.push(`❌ Failed files (${failedFiles.length}):`);
  failedFiles.forEach(f => log.push(`  • ${f}`));
}

  try {
    removeJobFile();
  } catch (err) {
    sendCloneLog(`Failed to remove job file: ${err.message}`, true);
  }
  const safeLog = log.map(entry => {
    if (typeof entry === 'string') return entry;
    try {
      return JSON.stringify(entry);
    } catch (err) {
      return String(entry);
    }
  });
  return { success: true, log: safeLog };
}

async function calculateCloneBytes(cfg = {}) {
  try {
    const resolvedSourceRoot = path.resolve(cfg.source ?? cfg.sourceRoot ?? cfg.root ?? '');
    const selection = filterSelectionByRoot(buildSelection(cfg), resolvedSourceRoot);
    const rawExcludePatterns = Array.isArray(cfg.excludePatterns)
      ? cfg.excludePatterns
      : String(cfg.excludePatterns || '')
          .split(',')
          .map(p => p.trim())
          .filter(Boolean);

    const { files } = await planCloneEntries({
      ...cfg,
      source: resolvedSourceRoot,
      selection,
      excludePatterns: rawExcludePatterns
    });

    let total = 0;
    let fileCount = 0;
    for (const file of files) {
      const full = file?.fullPath;
      if (!full) continue;
      try {
        const stats = await fsp.stat(full);
        const isFile = typeof stats.isFile === 'function' ? stats.isFile() : stats.isFile;
        if (isFile) {
          total += stats.size;
          fileCount += 1;
        }
      } catch {}
    }
    return { success: true, total, count: fileCount, fileCount };
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

module.exports = {
  runClone,
  cancelClone,
  calculateCloneBytes
};
