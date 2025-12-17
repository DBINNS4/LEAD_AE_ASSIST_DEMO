const ProgressManager = require('../utils/progressManager');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { dialog, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const checkDiskSpace = require('check-disk-space').default;
const { runClone } = require('./clone');

// Reference to the main application window, falling back to the first window
const getMainWindow = () => global.mainWindow || BrowserWindow.getAllWindows()[0];

const { getHashes, xxhashReady, getBlake3Hash } = require('./hashUtils');
const {
  copyFileWithProgress,
  getAllItemsRecursively,
  runWithConcurrencyLimit,
  preloadFileSizes
} = require('./fileUtils');
const { queueBackup, setConcurrency } = require('./backupQueue');


const { estimateDiskWriteSpeed } = require('./speedUtils');
const { sendLogMessage, writeLogToFile, archiveLog, createJobLogger, writeJobLogToFile } = require('./logUtils');
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
const { compareFilesByteByByte } = require('../utils/compare');

const { filterOutDestination } = require('./workflowUtils');

// Debug flag for detailed hash logging
const DEBUG_HASH = process.env.DEBUG_HASH === 'true';

// ✅ Cancel helpers
const { cancelIngest, createCancelToken } = require('./cancelUtils');

const {
  loadCache,
  saveCache,
  updateCacheEntry,
  isDuplicate
} = require('../utils/hashCache');

// 🗂️ Load persistent hash cache
const hashCache = loadCache();
// ✅ Hash cache loaded: silently handled for production

function isPrivateHostname(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (host.endsWith('.local')) return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (ipVersion === 6) {
    const normalized = host.split('%')[0];
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl) {
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return { valid: false, message: '❌ Please provide an n8n URL when webhook logging is enabled.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, message: '❌ Invalid n8n URL. Please use a full http/https address.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: '❌ n8n URL must start with http:// or https://.' };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return { valid: false, message: '❌ n8n URL cannot target localhost or private networks.' };
  }

  return { valid: true, url: trimmed };
}

function resolvePathSafe(p) {
  try {
    return path.resolve(String(p));
  } catch {
    return null;
  }
}

function isPathInside(base, candidate) {
  if (!base || !candidate) return false;
  const relative = path.relative(base, candidate);
  if (!relative || relative === '.') return true;
  if (relative.startsWith('..')) return false;
  return !path.isAbsolute(relative);
}

function collectSourceRoots(config) {
  const roots = new Set();
  const resolvedSource = resolvePathSafe(config.source);
  if (resolvedSource) roots.add(resolvedSource);

  if (Array.isArray(config.sourceFiles)) {
    for (const entry of config.sourceFiles) {
      const resolvedEntry = resolvePathSafe(entry);
      if (!resolvedEntry) continue;
      try {
        const stat = fs.statSync(resolvedEntry);
        const root = stat.isDirectory() ? resolvedEntry : path.dirname(resolvedEntry);
        roots.add(root);
      } catch {
        roots.add(path.dirname(resolvedEntry));
      }
    }
  }

  return Array.from(roots);
}


// ================================
// ⏱️ ETA Calculation
// ================================

async function getFreeDiskSpace(targetPath) {
  if (process.platform === 'win32') {
    try {
      const { free } = await checkDiskSpace(path.parse(targetPath).root);
      return free;
    } catch {
      return null;
    }
  }

  try {
    const sanitizedPath = path.resolve(String(targetPath));
    const output = execFileSync('df', ['-k', sanitizedPath], { encoding: 'utf-8' });
    const lines = output.trim().split(/\n/);
    if (lines.length > 1) {
      const parts = lines[1].trim().split(/\s+/);
      const freeKb = parseInt(parts[3], 10);
      if (!Number.isNaN(freeKb)) return freeKb * 1024;
    }
  } catch {
    return null;
  }
  return null;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}


/**
 * ⌛ Estimates time remaining based on average time per file.
 *
 * @param {number} processed - Number of files processed
 * @param {number} total - Total number of files
 * @returns {string} - Estimated time remaining as a string (e.g. "42s")
 */

async function runIngest(config) {
  if (config.cloneMode) {
    return runClone(config);
  }
  if (!config.signal) config.signal = createCancelToken();

  if (!config.jobId) {
    config.jobId = `ingest-${Date.now()}`;
  }

  await xxhashReady;

  const structuredLog = [];
  const jobLogger = createJobLogger({
    panel: 'ingest',
    jobId: config.jobId,
    stage: 'init',
    collector: structuredLog
  });

  const log = [];
  const origPush = log.push.bind(log);
  log.push = (msg, detail = '', isError = false, fileId = '') => {
    const meta = {};
    if (detail) meta.detail = detail;
    if (fileId) meta.fileId = fileId;
    jobLogger[isError ? 'error' : 'info'](msg, meta);
    return origPush(msg);
  };
  const window = getMainWindow();

  let archivePath = null;
  let structuredPath = null;

  let progressManager;

  try {
    const counters = { success: 0, skipped: 0, failed: 0 };
    const skippedFiles = [];
    const failedFiles = [];
    const destPaths = [];

    const {
      source,
      destination,
      backup,
      backupPath,
      flattenStructure,
      autoFolder,
      saveLog,
      autoEject,
      notes,
      enableN8N,
      n8nUrl,
      n8nLog,
      watchMode,
      verification,
      useDoneFlag
    } = config;

    const filters = {
      include: config.filters?.include?.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) || [],
      exclude: config.filters?.exclude?.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) || []
    };

    const n8nValidation = enableN8N ? validateN8nUrl(n8nUrl) : { valid: false };

    if (Array.isArray(config.sourceFiles) && config.sourceFiles.length > 0) {
      const beforeCount = config.sourceFiles.length;
      const filtered = filterOutDestination(config.sourceFiles, config.destination);
      const afterCount = filtered.length;
      if (afterCount < beforeCount) {
        const resolvedDest = path.resolve(config.destination || '');
        log.push(`⚠️ Skipped destination folder passed as source: ${resolvedDest}`);
      }
      config.sourceFiles = filtered;

      log.push(`🚀 Ingest triggered for ${afterCount} file(s)`);
    } else if (config.retryFiles?.length) {
      log.push(`🔁 Retry Mode ingest triggered for ${config.retryFiles.length} file(s)`);
    } else {
      log.push(`🚀 Starting ingest from: ${source}`);
    }

    // ==========================================
    // 📁 Gather file and directory lists for ingest
    // ==========================================

let files = [];
let directories = [];

if (Array.isArray(config.sourceFiles) && config.sourceFiles.length > 0) {
  for (const fp of config.sourceFiles) {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      if (!flattenStructure) {
        directories.push({ fullPath: fp, relativePath: path.basename(fp) });
      }
      const allItems = await getAllItemsRecursively(fp, fp);
      for (const item of allItems) {
        if (item.isDirectory) {
          if (!flattenStructure) {
            directories.push({
              fullPath: item.fullPath,
              relativePath: path.join(path.basename(fp), item.relativePath)
            });
          }
        } else {
          files.push({
            fullPath: item.fullPath,
            relativePath: flattenStructure
              ? path.basename(item.fullPath)
              : path.join(path.basename(fp), item.relativePath)
          });
        }
      }
    } else {
      files.push({
        fullPath: fp,
        relativePath: path.basename(fp)
      });
    }
  }
  // Watch mode details are logged via structured summary
} else if (config.retryFiles && Array.isArray(config.retryFiles)) {
  files = config.retryFiles.map(relPath => ({
    fullPath: path.join(config.source, relPath),
    relativePath: relPath
  }));
  directories = Array.from(new Set(config.retryFiles.map(p => path.dirname(p))))
    .filter(p => p !== '.')
    .map(rel => ({ relativePath: rel }));
} else {
  const base = config.source || '.';
  const allItems = fs.existsSync(base) ? await getAllItemsRecursively(base) : [];
  directories = allItems.filter(i => i.isDirectory);
  files = allItems.filter(i => !i.isDirectory);
}

// 🧹 Skip hidden/system files like .DS_Store
files = files.filter(({ fullPath }) => {
  const name = path.basename(fullPath).toLowerCase();
  if (name.endsWith('.done')) return false;
  return !name.startsWith('.') && name !== '.ds_store';
});

const fileSizeMap = await preloadFileSizes(files, msg => log.push(msg));
let filesToCopy = [];
let totalBytesToCopy = 0;
let destBytesToCopy = 0;
let backupBytesToCopy = 0;


// ==========================================
// 🔍 Verification Options Unpacking
// ==========================================

const {
  useChecksum: verify = false,        // Global on/off toggle
  method: checksumMethod = 'sha256',  // Default hash type
  compareByte: byteMatch = false,     // Byte-level shortcut check
  skipDuplicates,                     // Skip if file already exists
} = verification || {};

// ==========================================
// ✅ Step 1: Validate Source Directory
// ==========================================

if ((!Array.isArray(config.sourceFiles) || config.sourceFiles.length === 0) && !fs.existsSync(source)) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'error',
    title: 'Source Not Found',
    message: `The source folder does not exist:\n\n${source}\n\nCancel ingest?`,
    buttons: ['Cancel', 'Continue Anyway'],
    defaultId: 0,
    cancelId: 0
  });

  if (response === 0) {
    return { success: false, log: ['❌ Ingest cancelled: Source folder not found.'], logText: '❌ Ingest cancelled: Source folder not found.' };
  }

  log.push('⚠️ Continuing ingest even though source path does not exist.');
}

// ==========================================
// 📂 Step 2: Validate Destination Directory
// ==========================================

const sourceRoots = collectSourceRoots(config);
const resolvedDestination = resolvePathSafe(destination);

if (!destination || !destination.trim()) {
  log.push('❌ Ingest cancelled: No valid destination path provided.', '', true);
  return { success: false, log, logText: '❌ Ingest cancelled: No valid destination path provided.' };
}

if (resolvedDestination && sourceRoots.some(root => isPathInside(root, resolvedDestination))) {
  const overlapMessage = '❌ Ingest cancelled: Destination cannot be the same as the source or inside the source folder.';
  log.push(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (!fs.existsSync(destination)) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Destination Not Found',
    message: `The destination folder does not exist:\n\n${destination}\n\nWould you like to create it?`,
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1
  });

  if (response === 0) {
    try {
      fs.mkdirSync(destination, { recursive: true });
      log.push(`📁 Created destination: ${destination}`);
    } catch (err) {
      log.push(`❌ Failed to create destination: ${err.message}`, '', true);
      return { success: false, log, logText: `❌ Failed to create destination: ${err.message}` };
    }
  } else {
    return { success: false, log: ['❌ Ingest cancelled: Destination folder not created.'], logText: '❌ Ingest cancelled: Destination folder not created.' };
  }
}

// ==========================================
// 📝 Step 2.5: Log User Notes (Optional)
// ==========================================

if (notes && notes.trim()) {
  log.push(`📝 Notes: ${notes.trim()}`);
}

// ==========================================
// 💾 Step 3: Validate/Create Backup Directory (if enabled)
// ==========================================

const resolvedBackupPath = resolvePathSafe(backupPath);

if (backup && resolvedBackupPath && sourceRoots.some(root => isPathInside(root, resolvedBackupPath))) {
  const overlapMessage = '❌ Ingest cancelled: Backup path cannot be the same as the source or inside the source folder.';
  log.push(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (backup && backupPath && !fs.existsSync(backupPath)) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Backup Path Not Found',
    message: `The backup path does not exist:\n\n${backupPath}\n\nCreate it?`,
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1
  });

  if (response === 0) {
    try {
      fs.mkdirSync(backupPath, { recursive: true });
      log.push(`📁 Created backup path: ${backupPath}`);
    } catch (err) {
      log.push(`❌ Failed to create backup path: ${err.message}`, '', true);
    }
  } else {
    log.push('⚠️ Backup skipped: Path not created.');
  }
} // ✅

// ==========================================
// 🗂️ Step 4: Apply Auto-Folder Logic (Optional)
// ==========================================

let baseDestFolder = destination;

if (autoFolder) {
  const now = new Date();
  const localTimestamp = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}`;
  baseDestFolder = path.join(destination, `Ingest_${localTimestamp}`);

  if (!fs.existsSync(baseDestFolder)) {
    fs.mkdirSync(baseDestFolder, { recursive: true });
    log.push(`📁 Auto-created folder: ${baseDestFolder}`);
  }
}

// Create directory structure before copying files
if (!flattenStructure) {
  const uniqueDirs = Array.from(new Set(directories.map(d => d.relativePath)));
  uniqueDirs.sort();
  for (const rel of uniqueDirs) {
    const destDir = path.join(baseDestFolder, rel);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* ignore */ }
    if (backup && backupPath) {
      try { fs.mkdirSync(path.join(backupPath, rel), { recursive: true }); } catch { /* ignore */ }
    }
  }
}

// ==========================================
// 🧼 Step 5: Filter by Include/Exclude Extensions
// ==========================================

const rawCount = files.length;
files = files.filter(({ fullPath }) => {
  if (path.basename(fullPath).toLowerCase().endsWith('.done')) return false;
  const ext = path.extname(fullPath).toLowerCase();
  if (filters.include.length && !filters.include.includes(ext)) return false;
  if (filters.exclude.includes(ext)) return false;
  return true;
});
const filteredCount = files.length;
log.push(`📂 Files before filter: ${rawCount}, after filter: ${filteredCount}`);
if (filteredCount === 0) {
  log.push(`⚠️ No files found to ingest after filters.`);
}

filesToCopy = files.filter(file => {
  const relPath = flattenStructure ? path.basename(file.fullPath) : file.relativePath;
  const destPath = path.join(baseDestFolder, relPath);
  if (skipDuplicates && fs.existsSync(destPath)) {
    log.push(`⚠️ Skipped duplicate file: ${relPath}`);
    counters.skipped++;
    skippedFiles.push(relPath);
    return false;
  }
  if (byteMatch && fs.existsSync(destPath)) {
    const srcStats = fs.statSync(file.fullPath);
    const destStats = fs.statSync(destPath);
    const sameSize = srcStats.size === destStats.size;
    const sameMTime = Math.abs(srcStats.mtimeMs - destStats.mtimeMs) < 1000;
    if (sameSize && sameMTime) {
      log.push(`⚠️ Skipped byte-identical file: ${relPath}`);
      counters.skipped++;
      skippedFiles.push(relPath);
      return false;
    }
  }
  return true;
});

// ==========================================
// 📊 Progress Manager Setup (after filesToCopy populated)
// ==========================================

for (const file of filesToCopy) {
  try {
    const size = fileSizeMap.get(file.fullPath) || 0;
    destBytesToCopy += size;
    if (backup && backupPath) backupBytesToCopy += size;
  } catch {
    continue;
  }
}

totalBytesToCopy = destBytesToCopy + backupBytesToCopy;

progressManager = new ProgressManager(totalBytesToCopy, 250, 'bytes');
progressManager.setTotalFiles(filesToCopy.length);

// ==========================================
// 🗄️ Step 5.5: Validate Available Disk Space
// ==========================================

const destFree = await getFreeDiskSpace(baseDestFolder);
if (destFree !== null && destFree < destBytesToCopy) {
  const msg = `Not enough space on destination drive. Required ${formatBytes(destBytesToCopy)}, available ${formatBytes(destFree)}`;
  log.push(`❌ ${msg}`, '', true);
  await dialog.showMessageBox(window, {
    type: 'error',
    title: 'Insufficient Disk Space',
    message: msg
  });
  return { success: false, log, logText: log.join('\n') };
}

if (backup && backupPath) {
  const backupFree = await getFreeDiskSpace(backupPath);
  if (backupFree !== null && backupFree < backupBytesToCopy) {
    const msg = `Not enough space on backup drive. Required ${formatBytes(backupBytesToCopy)}, available ${formatBytes(backupFree)}`;
    log.push(`❌ ${msg}`, '', true);
    await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Insufficient Backup Space',
      message: msg
    });
    return { success: false, log, logText: log.join('\n') };
  }
}

progressManager.on('stream-progress', payload => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  // Progress updates are routed exclusively through the queue manager
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'ingest',
      file: payload.file,
      percent: payload.overall,
      filePercent: payload.percent,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles,
      streamId: payload.streamId
    });
  }
});

progressManager.on('overall-progress', payload => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  // Deprecated: 'ingest-progress' event removed; use 'job-progress' instead
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'ingest',
      file: payload.overall === 100 ? '' : '',
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
      panel: 'ingest',
      file: payload.file,
      status: { ...payload.statusMap },
      streamId: payload.streamId
    });
  }
});

// ==========================================
// 🛠 Step 6: Build File Copy Tasks
// ==========================================

const tasks = [];

function buildCopyTask(file) {
  file.statusMap = {
    copied: false,
    backedUp: false,
    checksummed: false,
    cached: false
  };
  return async (streamId) => {
    if (config.signal?.aborted) {
      log.push(`🛑 Ingest cancelled by user during: ${file.relativePath}`);
      return;
    }

    const { fullPath: srcPath, relativePath } = file;

    const relPath = flattenStructure
      ? path.basename(srcPath)
      : relativePath;

    const finalDestPath = path.join(baseDestFolder, relPath);
    const tempDestPath = `${finalDestPath}.partial`;
    const finalBackupPath = backup && backupPath
      ? path.join(backupPath, relPath)
      : null;
    const originalSize = fileSizeMap.get(srcPath) || fs.statSync(srcPath).size;

    // 🔍 Compute hash early to detect duplicates if file is big enough
    let computedHash;
    if (originalSize > 10 * 1024) {
      try {
        ({ hash: computedHash } = await getBlake3Hash(srcPath));
      } catch {
        computedHash = null;
      }
    } else {
      computedHash = null;
    }

    let srcHash = null;
    if (verify && checksumMethod !== 'none') {
      try {
        if (checksumMethod === 'blake3') {
          if (computedHash) {
            srcHash = computedHash;
          } else {
            ({ hash: srcHash } = await getBlake3Hash(srcPath));
          }
        } else {
          const srcHashes = await getHashes(srcPath, {
            useSha256: checksumMethod === 'sha256',
            useMd5: checksumMethod === 'md5',
            useBlake3: checksumMethod === 'blake3',
            useXxhash64: checksumMethod === 'xxhash64'
          });
          srcHash = srcHashes[checksumMethod]?.hash || null;
        }
      } catch {
        srcHash = null;
      }
    }

    if (DEBUG_HASH && computedHash) {
      const seenBefore = isDuplicate(hashCache, computedHash);
      log.push(`🔍 Hash ${computedHash} previously seen: ${seenBefore}`);
    }

    if (skipDuplicates && computedHash && isDuplicate(hashCache, computedHash)) {
      log.push(`⚠️ Duplicate hash skipped: ${relPath}`);
      counters.skipped++;
      skippedFiles.push(relPath);
      progressManager.adjustTotal(-originalSize);
      if (finalBackupPath) progressManager.adjustTotal(-originalSize);
      return;
    }

    if (skipDuplicates && fs.existsSync(finalDestPath)) {
      log.push(`⚠️ Skipped duplicate file: ${relPath}`);
      counters.skipped++;
      skippedFiles.push(relPath);
      progressManager.adjustTotal(-originalSize);
      if (finalBackupPath) progressManager.adjustTotal(-originalSize);
      return;
    }

    if (byteMatch && fs.existsSync(finalDestPath)) {
      const srcStats = fs.statSync(srcPath);
      const destStats = fs.statSync(finalDestPath);
      const sameSize = srcStats.size === destStats.size;
      const sameMTime = Math.abs(srcStats.mtimeMs - destStats.mtimeMs) < 1000;

      if (sameSize && sameMTime) {
        log.push(`⚠️ Skipped byte-identical file: ${relPath}`);
        counters.skipped++;
        skippedFiles.push(relPath);
        progressManager.adjustTotal(-originalSize);
        if (finalBackupPath) progressManager.adjustTotal(-originalSize);
        return;
      }
    }

    try {
      progressManager.startFile(streamId, srcPath, originalSize);

      try {
        await copyFileWithProgress(
          srcPath,
          tempDestPath,
          (_percent, chunkSize) => {
            if (config.signal?.aborted) throw new Error('🛑 Cancelled during file copy');
            progressManager.updateStream(streamId, chunkSize);
          },
          config.signal
        );

        try {
          const fd = await fs.promises.open(tempDestPath, 'r');
          await fd.sync();
          await fd.close();
        } catch {
          /* best effort */
        }

        try {
          await fs.promises.rename(tempDestPath, finalDestPath);
        } catch (renameErr) {
          if (renameErr.code === 'EXDEV') {
            await fs.promises.copyFile(tempDestPath, finalDestPath);
            await fs.promises.unlink(tempDestPath).catch(() => {});
          } else {
            await fs.promises.unlink(tempDestPath).catch(() => {});
            throw renameErr;
          }
        }
      } catch (copyErr) {
        await fs.promises.unlink(tempDestPath).catch(() => {});
        throw copyErr;
      }

      file.statusMap.copied = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'ingest',
          file: relPath,
          status: { ...file.statusMap }
        });
      }

      log.push(`✅ Ingested: ${relPath}`);
      counters.success++;

      if (byteMatch) {
        const isIdentical = await compareFilesByteByByte(srcPath, finalDestPath);
        if (!isIdentical) {
          fs.unlinkSync(finalDestPath);
          throw new Error('Byte-level mismatch');
        }
        log.push(`✅ Byte-level match: ${relPath}`);
      }
    } catch (err) {
      log.push(`❌ Error ingesting ${relPath}: ${err.message}`, '', true);
      counters.failed++;
      failedFiles.push(relPath);
      return;
    }

  if (finalBackupPath) {
    try {
      await queueBackup(file, async () => {
        const tempBackupPath = `${finalBackupPath}.partial`;

        try {
          await copyFileWithProgress(
            finalDestPath,
            tempBackupPath,
            (_percent, chunkSize) => {
              if (config.signal?.aborted) throw new Error('🛑 Cancelled during backup copy');
              progressManager.updateStream(streamId, chunkSize);
            },
            config.signal
          );

          try {
            const fd = await fs.promises.open(tempBackupPath, 'r');
            await fd.sync();
            await fd.close();
          } catch {
            /* best effort */
          }

          try {
            await fs.promises.rename(tempBackupPath, finalBackupPath);
          } catch (renameErr) {
            if (renameErr.code === 'EXDEV') {
              await fs.promises.copyFile(tempBackupPath, finalBackupPath);
              await fs.promises.unlink(tempBackupPath).catch(() => {});
            } else {
              await fs.promises.unlink(tempBackupPath).catch(() => {});
              throw renameErr;
            }
          }
        } catch (copyErr) {
          await fs.promises.unlink(tempBackupPath).catch(() => {});
          throw copyErr;
        }
      });

    log.push(`📦 Backed up: ${relPath}`);
    file.statusMap.backedUp = true;
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'ingest',
        file: relPath,
        status: { ...file.statusMap }
      });
    }

    // Renderer updates handled via queue manager
  } catch (err) {
    log.push(`⚠️ Backup failed for ${relPath}: ${err.message}`);
  }
  }

  if (!verify || checksumMethod === 'none') {
    log.push(`⚠️ Checksum verification skipped (disabled or method: none)`);
  }

  if (verify && checksumMethod !== 'none') {
    if (config.signal?.aborted) throw new Error('🛑 Cancelled before checksum');
    try {
      log.push(`🧪 Running checksum: ${checksumMethod}`);

    let destHash = null;
    let hashMethodDetails = null;

    if (checksumMethod === 'blake3') {
      const { hash, method } = await getBlake3Hash(finalDestPath);
      destHash = hash;
      hashMethodDetails = method;
    } else {
      const hashResults = await getHashes(finalDestPath, {
        useSha256: checksumMethod === 'sha256',
        useMd5: checksumMethod === 'md5',
        useBlake3: checksumMethod === 'blake3',
        useXxhash64: checksumMethod === 'xxhash64'
      });

      const result = hashResults[checksumMethod] || {};
      destHash = result.hash || null;
      hashMethodDetails = result.method;
    }

    if (destHash) {
      log.push(`🧬 ${checksumMethod}: ${destHash}`);
      if (hashMethodDetails) {
        log.push(`🔍 ${checksumMethod} method: ${hashMethodDetails}`);
      }
    } else {
      log.push(`⚠️ Checksum failed: ${checksumMethod} returned no result`);
    }

    if (srcHash && destHash && srcHash !== destHash) {
      await fs.promises.unlink(finalDestPath).catch(() => {});
      throw new Error('Checksum mismatch (src vs dest)');
    }

    if (srcHash && destHash) {
      log.push('✅ Checksum match between source and destination');
    } else if (!srcHash) {
      log.push('⚠️ Source checksum unavailable for comparison');
    }
    } catch (err) {
      log.push(`⚠️ Checksum failed: ${err.message}`);
    }
  }

  file.statusMap.checksummed = true;
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'ingest',
      file: relPath,
      status: { ...file.statusMap }
    });
  }

  if (computedHash && originalSize > 10 * 1024) {
      updateCacheEntry(hashCache, computedHash, relPath);
      const { saveCache } = require('../utils/hashCache');
      saveCache(hashCache);
      log.push(`🧠 Cached hash: ${computedHash} → ${relPath}`);
      file.statusMap.cached = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'ingest',
          file: relPath,
          status: { ...file.statusMap }
        });
      }
    }

    destPaths.push(finalDestPath);
    progressManager.finishFile(streamId, file.statusMap);
    if (global.queue && finalBackupPath) {
      // ensure latest status for original row after backup finishes
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'ingest',
        file: relPath,
        status: { ...file.statusMap }
      });
    }

    if (useDoneFlag) {
      try {
        const flagPath = `${srcPath}.doneflag`;
        fs.writeFileSync(flagPath, 'done', 'utf-8');
        log.push(`🚩 Wrote done flag: ${path.basename(flagPath)}`);
      } catch (err) {
        log.push(`⚠️ Failed to write done flag: ${err.message}`);
      }
    }
  };
}

for (const file of filesToCopy) {
  tasks.push(buildCopyTask(file));
}

// ==========================================
// 🧠 Step 12: Estimate Disk Speed → Choose Thread Count
// ==========================================

let threadCount;

// ⚡ Auto-tune threading if not set
if (!config.maxThreads || isNaN(config.maxThreads)) {
  try {
    const speed = await estimateDiskWriteSpeed(baseDestFolder);
    log.push(`⚡ Estimated write speed: ${speed} MiB/s`);

    threadCount =
      speed < 50  ? 2 :
      speed < 100 ? 3 :
      speed < 200 ? 4 :
                    5;

    log.push(`🧵 Auto-selected thread count: ${threadCount}`);
  } catch (err) {
    threadCount = 3;
    log.push(
      `⚠️ Disk speed check failed (${err.message}), defaulting to ${threadCount} threads`
    );
  }
} else {
  threadCount = parseInt(config.maxThreads, 10);
  if (isNaN(threadCount) || threadCount < 1) threadCount = 1;
  log.push(`🧵 Using user-defined thread count: ${threadCount}`);
}

  // Sync backup queue concurrency with ingest threads
  setConcurrency(threadCount);

if (threadCount === 1) {
   log.push('🧵 Running ingest single-threaded');
 }

// ==========================================
// 🚀 Step 13: Run Tasks with Concurrency
// ==========================================

await runWithConcurrencyLimit(tasks, threadCount);

if (config.signal?.aborted) {
  log.push('🛑 Ingest cancelled by user.');
  if (progressManager?.dispose) progressManager.dispose();
  removeJobFile();
  return {
    success: false,
    log,
    logText: log.join('\n'),
    cancelled: true
  };
}

// 🔁 Retry failed files if enabled
if (config.retryFailures && failedFiles.length > 0) {
  const finalFailedFiles = [...failedFiles];
  failedFiles.length = 0;

  log.push(`🔁 Retrying ${finalFailedFiles.length} failed file(s)...`);

  const retryTasks = files
    .filter(f => finalFailedFiles.includes(f.relativePath))
    .map(buildCopyTask);

  await runWithConcurrencyLimit(retryTasks, threadCount);
  if (config.signal?.aborted) {
    log.push('🛑 Ingest cancelled by user.');
    if (progressManager?.dispose) progressManager.dispose();
    removeJobFile();
    return {
      success: false,
      log,
      logText: log.join('\n'),
      cancelled: true
    };
  }
  log.push(`🔁 Retry complete. ${failedFiles.length} file(s) failed again.`);
}

// ==========================================
// 📄 Step 14: Save Ingest Log
// ==========================================

if (saveLog && !watchMode) {
  const logFileName = `IngestLog_${Date.now()}.txt`;
  const logPath = path.join(baseDestFolder, logFileName);

  writeLogToFile(log, logPath);
  log.push(`📄 Log saved to: ${logPath}`);

// ✅ Optionally save log to backup folder
  if (backup && backupPath) {
    const backupLogPath = path.join(backupPath, logFileName);

    try {
    log.push(`📁 Log also saved to backup: ${backupLogPath}`);
    writeLogToFile(log, backupLogPath);

    } catch (err) {
      log.push(`⚠️ Failed to write backup log: ${err.message}`);
    }
  }

  // 🗂 Step 15: Write Skipped/Failed File Summary (if any)
  if (skippedFiles.length || failedFiles.length) {
    const failureLogPath = path.join(baseDestFolder, `IngestFailures_${Date.now()}.txt`);
    const failureLog = [];

    if (skippedFiles.length) {
      failureLog.push('⚠️ Skipped Files:\n' + skippedFiles.join('\n') + '\n');
    }
    if (failedFiles.length) {
      failureLog.push('❌ Failed Files:\n' + failedFiles.join('\n') + '\n');
    }

    fs.writeFileSync(failureLogPath, failureLog.join('\n'));
    log.push(`📄 Skipped/failed files saved to: ${failureLogPath}`);
  }

  // 📝 Step 16: Generate Retry List (if any failures)
  if (failedFiles.length) {
    const retryListPath = path.join(baseDestFolder, `RetryList_${Date.now()}.txt`);
    fs.writeFileSync(retryListPath, failedFiles.join('\n'));
    log.push(`📂 Retry list created: ${retryListPath}`);
  }
}

if (!watchMode) {
  archivePath = archiveLog(log, 'ingest');
  log.push(`📂 Log archived to: ${archivePath}`);
}

// ==========================================
// 💿 Step 17: Auto-Eject (Not Implemented Yet)
// ==========================================

if (autoEject) {
  log.push('⚠️ Auto-eject requested (not implemented)');
}

// ==========================================
// ✅ Step 18: Final Ingest Summary
// ==========================================

log.push(`\n✅ Ingest complete`);
log.push(`   • Successful: ${counters.success}`);
log.push(`   • Skipped: ${counters.skipped}`);
log.push(`   • Failed: ${counters.failed}`);

if (counters.success === 0 && counters.skipped > 0) {
  log.push('⚠️ All files skipped. Check filters or skipDuplicate settings.');
}

// 🧩 Final push to renderer to mark all files 100%
// Renderer table updates are handled via the queue manager

// Progress updates are now handled exclusively via the queue manager

// ==========================================
// 🛑 Step 19: Show Alert if Any Files Failed
// ==========================================

if (counters.failed > 0) {
  await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Ingest Finished with Errors',
    message: `${counters.failed} file(s) failed to ingest.\nCheck the log for details.`,
    buttons: ['OK']
  });
}

// ==========================================
// 🛰️ Step 20: Optional n8n Webhook Trigger
// ==========================================

    if (enableN8N && n8nValidation.valid) {
      const payload = n8nLog
        ? { log }
        : {
            status: 'complete',
            notes,
            success: true,
            skipped: skippedFiles.length,
            failed: failedFiles.length
          };

      log.push('🛰️ Preparing to send data to validated n8n webhook');
      log.push(`📦 Payload preview:\n${JSON.stringify(payload, null, 2)}`);

      try {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        await fetch(n8nValidation.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        log.push('🌐 n8n webhook triggered');
      } catch (err) {
        log.push(`⚠️ Failed to trigger n8n webhook: ${err.message}`);
      }
    } else if (enableN8N && !n8nValidation.valid) {
      log.push(`⚠️ Skipping n8n webhook: ${n8nValidation.message.replace(/^❌\s*/, '')}`);
    }

       // ==========================================
    // 🏁 Step 21: Return Summary
    // ==========================================
if (progressManager?.dispose) progressManager.dispose();
removeJobFile();

// 💾 Persist hash cache
saveCache(hashCache);
log.push(`🧠 Hash cache updated (${Object.keys(hashCache).length} entries)`);
config.sources = destPaths;
jobLogger.setStage('complete');
jobLogger.info('Ingest job completed');
structuredPath = writeJobLogToFile('ingest', config.jobId, jobLogger.getEntries());
return {
  success: true,
  config,
  archivePath,
  structuredLogPath: structuredPath,
  log,
  logText: log.join('\n'),
  jobId: config.jobId
};

  } catch (err) {
    const errorMsg = `❌ Unhandled ingest error: ${err.message}`;
    console.error('[runIngest] Uncaught error:', err);
    log.push(errorMsg);
    jobLogger.setStage('error');
    jobLogger.error('Ingest job failed', { error: err?.message || String(err), stack: err?.stack });
    if (progressManager?.dispose) progressManager.dispose();
    removeJobFile();
    structuredPath = writeJobLogToFile('ingest', config.jobId, jobLogger.getEntries());
    return {
  success: false,
  log,
  logText: log.join('\n'),
  cancelled: true,
  archivePath,
  structuredLogPath: structuredPath,
  jobId: config.jobId
};

  }
}

// ==========================================
// 📦 Exports
// ==========================================

module.exports = {
  runIngest,
  cancelIngest,
  filterOutDestination
};
