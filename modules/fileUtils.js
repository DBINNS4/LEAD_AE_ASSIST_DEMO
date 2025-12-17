const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { generateChecksum } = require('./hashUtils');

/**
 * 📂 Recursively gathers all files **and** directories from a directory
 * @param {string} dir
 * @returns {Array<{ fullPath: string, relativePath: string, isDirectory: boolean }>}
 */
async function getAllItemsRecursively(dir, base = dir) {
  let results = [];

  let list;
  try {
    list = await fsp.readdir(dir);
  } catch {
    // Skip unreadable system folders like .Spotlight-V100
    return results;
  }

  for (const entry of list) {
    if (entry.startsWith('.')) continue; // Skip hidden/system files and folders

    const fullPath = path.join(dir, entry);
    let stat;

    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue; // Skip items that throw errors
    }

    if (stat.isDirectory()) {
      results.push({
        fullPath,
        relativePath: path.relative(base, fullPath),
        isDirectory: true
      });
      const sub = await getAllItemsRecursively(fullPath, base);
      results = results.concat(sub);
    } else {
      results.push({
        fullPath,
        relativePath: path.relative(base, fullPath),
        isDirectory: false
      });
    }
  }

  return results;
}

/**
 * 📂 Recursively gathers files and directories, separated into lists
 * @param {string} dir
 * @param {string} [base=dir]
 * @returns {{ files: Array<{fullPath: string, relativePath: string}>, dirs: Array<{fullPath: string, relativePath: string}> }}
 */
async function getAllFilesRecursively(dir, base = dir) {
  const items = await getAllItemsRecursively(dir, base);
  return {
    files: items
      .filter(i => !i.isDirectory)
      .map(({ fullPath, relativePath }) => ({ fullPath, relativePath })),
    dirs: items
      .filter(i => i.isDirectory)
      .map(({ fullPath, relativePath }) => ({ fullPath, relativePath }))
  };
}

/**
 * 🧪 Copy a file and optionally verify checksum
 * @param {string} src - Source file
 * @param {string} dest - Destination path
 * @param {string} method - Checksum method
 * @returns {Promise<void>}
 */
async function copyFileWithVerification(src, dest, method = 'sha256') {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);

  const [srcHash, destHash] = await Promise.all([
    generateChecksum(src, method),
    generateChecksum(dest, method)
  ]);

  if (srcHash !== destHash) {
    await fsp.unlink(dest); // Remove bad copy
    throw new Error(`Checksum mismatch for ${path.basename(src)}`);
  }
}

/**
 * 🚀 Copy a file with progress callback
 * @param {string} src - Source file
 * @param {string} dest - Destination path
 * @param {function} progressCallback - (percent) => void
 * @param {string} id - optional file id
 * @returns {Promise<void>}
 */
async function copyFileWithProgress(src, dest, progressCallback, signal) {
  const { size: totalSize } = await fsp.stat(src);
  let transferred = 0;

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
    const write = fs.createWriteStream(dest);
    const abortHandler = () => {
      clearInterval(interval);
      read.destroy();
      write.destroy();
      fsp.unlink(dest).catch(() => {});
      reject(new Error('Copy canceled by user'));
    };
    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let interval;
    const sendProgress = () => {
      const percent = Math.floor((transferred / totalSize) * 1000) / 10;
      progressCallback(percent, 0); // 0 = no new chunk, just interval emit
    };

    read.on('data', chunk => {
      transferred += chunk.length;
      const percent = Math.floor((transferred / totalSize) * 1000) / 10;

      progressCallback(percent, chunk.length);
    });

    read.on('error', err => {
      clearInterval(interval);
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(err);
    });

    write.on('error', err => {
      clearInterval(interval);
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(err);
    });

    write.on('finish', () => {
      clearInterval(interval);
      if (signal) signal.removeEventListener('abort', abortHandler);
      progressCallback(100, 0); // Final update
      resolve();
    });

    // 🕒 Periodic fallback to reassure user during long reads
    interval = setInterval(sendProgress, 500);

    read.pipe(write);
  });
}

/**
 * 🧵 Run async tasks with concurrency limit
 * @param {Function[]} tasks - Array of async functions
 * @param {number} limit - Concurrency limit
 */
async function runWithConcurrencyLimit(tasks, limit = 3) {
  const results = [];
  let index = 0;

  async function worker(id) {
    while (index < tasks.length) {
      const current = index++;
      try {
        await tasks[current](id);
        results[current] = { success: true };
      } catch (err) {
        results[current] = { success: false, error: err.message };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);
  return results;
}

/**
 * 📂 Recursively gathers files, but only within allowed folders.
 * This version is safe for Clone panel without affecting Ingest.
 *
 * @param {string} dir
 * @param {string} base
 * @param {string[]} allowedFolders
 * @returns {Array<{ fullPath: string, relativePath: string }>}
 */
function getFilteredFilesRecursively(dir, base = dir, allowedFolders = []) {
  let results = [];

  const isAllowed = allowedFolders.some(p =>
    dir === p || dir.startsWith(p + path.sep)
  );

  if (!isAllowed) return results;

  let list;
  try {
    list = fs.readdirSync(dir);
  } catch {
    return results;
  }

  for (const file of list) {
    if (file.startsWith('.')) continue;

    const fullPath = path.join(dir, file);
    let stat;

    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results = results.concat(getFilteredFilesRecursively(fullPath, base, allowedFolders));
    } else {
      results.push({
        fullPath,
        relativePath: path.relative(base, fullPath),
      });
    }
  }

  return results;
}

/**
 * 📏 Preloads file sizes into a Map
 * @param {Array<{ fullPath: string }>} files
 * @returns {Map<string, number>}
 */
async function preloadFileSizes(files, logCallback) {
  const map = new Map();

  for (const file of files) {
    try {
      const { size } = await fsp.stat(file.fullPath);
      map.set(file.fullPath, size);
    } catch (err) {
      const msg = `⚠️ Failed to stat ${file.fullPath}: ${err.message}`;
      if (typeof logCallback === 'function') {
        logCallback(msg);
      } else {
        console.warn(msg);
      }
    }
  }

  return map;
}

/**
 * ⏳ Waits until a file's size and modified time stop changing.
 *
 * @param {string} filePath - Path to file.
 * @param {number} interval - Poll interval in ms.
 * @param {number} stableChecks - Number of matching checks before resolving.
 * @returns {Promise<boolean>} Resolves true if stable before retries run out.
 */
async function waitForStableFile(filePath, interval = 2000, stableChecks = 5) {
  if (process.env.DEBUG_LOGS) {
    // Checking file stability
  }
  let prevSize = -1;
  let prevMtime = -1;
  let consecutiveMatches = 0;

  try {
    const { size, mtimeMs } = await fs.promises.stat(filePath);
    prevSize = size;
    prevMtime = mtimeMs;
  } catch {
    prevSize = -1;
    prevMtime = -1;
  }

  while (consecutiveMatches < stableChecks) {
    await new Promise(res => setTimeout(res, interval));
    let currentSize;
    let currentMtime;
    try {
      const { size, mtimeMs } = await fs.promises.stat(filePath);
      currentSize = size;
      currentMtime = mtimeMs;
    } catch {
      currentSize = -1;
      currentMtime = -1;
    }

    if (currentSize === prevSize && currentMtime === prevMtime) {
      consecutiveMatches++;
    } else {
      consecutiveMatches = 0;
      prevSize = currentSize;
      prevMtime = currentMtime;
    }
  }

  if (process.env.DEBUG_LOGS) {
    // File confirmed stable
  }
  return true;
}

module.exports = {
  getAllFilesRecursively,
  getAllItemsRecursively,
  getFilteredFilesRecursively,
  copyFileWithProgress,
  copyFileWithVerification,
  runWithConcurrencyLimit,
  preloadFileSizes,
  waitForStableFile
};


