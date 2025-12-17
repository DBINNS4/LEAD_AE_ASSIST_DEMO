const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sendLogMessage, createJobLogger, writeJobLogToFile, archiveLog } = require('./logUtils');
const { ensureFolder } = require('../utils/path');
/**
 * Create the folder structure based on config from renderer
 * with unified, job-based logging.
 */
async function createProjectStructure(config = {}) {
  const log = [];
  const structuredLog = [];

  let structuredLogPath = null;
  let archivePath = null;

  const jobLogger = createJobLogger({
    panel: 'organizer',
    jobId: config?.jobId,
    stage: 'init',
    collector: structuredLog
  });

  const pushLog = (msg, detail = '', isError = false, fileId = '') => {
    // Live UI log
    sendLogMessage('organizer', msg, detail, isError, fileId);

    // Structured job log
    if (jobLogger) {
      const meta = {};
      if (detail) meta.detail = detail;
      if (fileId) meta.fileId = fileId;
      jobLogger[isError ? 'error' : 'info'](msg, meta);
    }

    log.push(msg);
  };

  const {
    rootName,
    selectedFolders,
    prependNumbers,
    uppercase,
    appendDate,
    outputPath,
    folderAssets,
    signal
  } = config || {};

  const createAbortError = () => {
    const err = new Error('Project organizer job cancelled');
    err.name = 'AbortError';
    return err;
  };

  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  // Optional: richer config debug
  if (process.env.DEBUG_LOGS && jobLogger) {
    try {
      const assetSummary = Object.fromEntries(
        Object.entries(folderAssets || {}).map(([k, v]) => [k, (v || []).length])
      );
      jobLogger.debug('Project organizer config received', {
        rootName,
        selectedCount: Array.isArray(selectedFolders) ? selectedFolders.length : 0,
        outputPath,
        assetSummary
      });
    } catch {
      // Never let debug logging crash the job
    }
  }

  // Basic validation
  if (!outputPath || !Array.isArray(selectedFolders) || selectedFolders.length === 0) {
    const errMsg = '❌ Output path or folder selection is missing.';
    pushLog(errMsg, '', true);
    jobLogger?.setStage('error');
    jobLogger?.error('Project organizer validation failed', {
      reason: 'missing-output-or-selection'
    });

    structuredLogPath = writeJobLogToFile(
      'organizer',
      config?.jobId,
      jobLogger?.getEntries() || structuredLog
    );

    archivePath = archiveLog(log, 'organizer');

    return {
      success: false,
      log,
      logText: log.join('\n'),
      structuredLogPath,
      archivePath,
      jobId: config?.jobId
    };
  }

  const sanitizedSegments = new Map();

  const sanitizeSegment = (segment, { allowEmpty = false } = {}) => {
    const trimmed = (segment || '').trim();
    if (!trimmed && !allowEmpty) {
      throw new Error('Folder names cannot be empty.');
    }
    if (/[/\\]/.test(trimmed)) {
      throw new Error('Folder names cannot contain path separators.');
    }
    if (trimmed.includes('..')) {
      throw new Error('Folder names cannot contain "..".');
    }
    if (/[<>:"|?*\x00-\x1F]/.test(trimmed)) {
      throw new Error('Folder names contain illegal characters.');
    }

    return trimmed;
  };

  const sanitizeEntry = (entry) => {
    if (typeof entry !== 'string') {
      throw new Error('Folder entries must be strings.');
    }

    if (path.isAbsolute(entry)) {
      throw new Error('Absolute paths are not allowed.');
    }

    const normalized = path
      .normalize(entry.replace(/\\/g, '/'))
      .split('/')
      .filter(Boolean);

    if (!normalized.length) {
      throw new Error('Folder entries cannot be empty.');
    }

    return normalized.map((seg) => sanitizeSegment(seg));
  };

  const ensureWithinRoot = (target, root) => {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Resolved path escapes the output root.');
    }
  };

  const failValidation = (message, reason = 'invalid-input') => {
    const errMsg = `❌ ${message}`;
    pushLog(errMsg, '', true);
    jobLogger?.setStage('error');
    jobLogger?.error('Project organizer validation failed', {
      reason
    });

    structuredLogPath = writeJobLogToFile(
      'organizer',
      config?.jobId,
      jobLogger?.getEntries() || structuredLog
    );

    return {
      success: false,
      log,
      logText: log.join('\n'),
      structuredLogPath,
      jobId: config?.jobId
    };
  };

  let finalRootSegment;
  try {
    if (rootName) {
      try {
        finalRootSegment = sanitizeSegment(rootName);
      } catch (err) {
        return failValidation(`Invalid root folder name: ${err.message}`);
      }
    }

    for (const rawName of selectedFolders) {
      try {
        sanitizedSegments.set(rawName, sanitizeEntry(rawName));
      } catch (err) {
        return failValidation(`Invalid folder selection "${rawName}": ${err.message}`);
      }
    }
  } catch (err) {
    return failValidation(err.message);
  }

  const pickUniqueDestPath = async (dest) => {
    try {
      await fsp.access(dest);
    } catch {
      return dest; // doesn't exist
    }

    const dir = path.dirname(dest);
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);

    for (let i = 1; i <= 999; i++) {
      const candidate = path.join(dir, `${base}_${i}${ext}`);
      try {
        await fsp.access(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error(`Too many filename collisions for ${path.basename(dest)}`);
  };
  
  const copyAssetWithSignal = async (src, dest) => {
    throwIfCancelled();
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    return new Promise((resolve, reject) => {
      const dir = path.dirname(dest);
      const tmpFile = path.join(
        dir,
        `.__leadai_assetcopy_${process.pid}_${Date.now()}_${Math.random()
          .toString(16)
          .slice(2)}.tmp`
      );
      let finished = false;
      const abortError = createAbortError();
      const read = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
      const write = fs.createWriteStream(tmpFile, { flags: 'wx' });
      let tick = null;

      function fail(err) {
        if (finished) return;
        finished = true;
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
        fsp.unlink(tmpFile).catch(() => {});
        reject(err);
      }

      async function succeed() {
        if (finished) return;
        finished = true;
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }

      function onAbort() {
        fail(abortError);
      }

      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      tick = setInterval(() => {
        if (signal?.aborted) onAbort();
      }, 200);

      read.on('data', () => {
        if (signal?.aborted) onAbort();
      });

      read.on('error', fail);
      write.on('error', fail);
      write.on('finish', async () => {
        if (finished) return;
        if (signal?.aborted) return onAbort();
        try {
          const finalDest = await pickUniqueDestPath(dest);
          await fsp.rename(tmpFile, finalDest);
          await succeed();
        } catch (err) {
          fail(err);
        }
      });

      read.pipe(write);
    });
  };

  try {
    // Final root folder name
    const baseRoot = typeof finalRootSegment === 'string' ? finalRootSegment : 'New_Project';
    let finalRoot = baseRoot;
    if (appendDate) {
      const today = new Date().toISOString().split('T')[0];
      finalRoot += `_${today}`;
    }

    const outputRoot = path.resolve(outputPath);
    const rootFolder = path.resolve(outputRoot, finalRoot);
    ensureWithinRoot(rootFolder, outputRoot);

    // Prevent accidental merges into existing populated folders
    if (fs.existsSync(rootFolder)) {
      const st = fs.statSync(rootFolder);
      if (!st.isDirectory()) {
        return failValidation(`Root path exists and is not a folder: ${rootFolder}`, 'root-not-directory');
      }
      const entries = fs.readdirSync(rootFolder);
      if (entries.length > 0) {
        return failValidation(
          `Root folder already exists and is not empty: ${rootFolder}`,
          'root-exists'
        );
      }
    } else {
      ensureFolder(rootFolder);
    }
    pushLog(`📁 Root created: ${rootFolder}`);

    const rootRenameMap = {};
    let rootCounter = 1;
    let folderCount = 0;
    let assetCount = 0;

    // 🔢 Progress accounting: folders + attached assets
    const totalFolders = Array.isArray(selectedFolders) ? selectedFolders.length : 0;
    let totalAssets = 0;
    if (folderAssets && Array.isArray(selectedFolders)) {
      for (const rawName of selectedFolders) {
        const list = folderAssets[rawName];
        if (Array.isArray(list)) {
          totalAssets += list.length;
        }
      }
    }

    const totalSteps = Math.max(1, totalFolders + totalAssets);
    let completedSteps = 0;

    const emitProgress = () => {
      if (!global.queue || !config?.jobId) return;
      const percent = Math.min(100, (completedSteps / totalSteps) * 100);
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'project-organizer',
        completed: completedSteps,
        total: totalSteps,
        percent
      });
    };

    // Initial 0% update
    emitProgress();

    for (const rawName of selectedFolders) {
      throwIfCancelled();

      const originalSegments = sanitizedSegments.get(rawName);
      const root = originalSegments[0];
      const isRootLevel = originalSegments.length === 1;

      // Build rename map for root folders
      if (isRootLevel) {
        const prefix = prependNumbers
          ? `${String(rootCounter).padStart(2, '0')}_`
          : '';
        const newName = prefix + (uppercase ? root.toUpperCase() : root);
        rootRenameMap[root] = newName;
        rootCounter += 1;
      }

      // Apply renaming to all paths that share this root
      const segments = [...originalSegments];
      if (rootRenameMap[root]) {
        segments[0] = rootRenameMap[root];
      }

      let current = rootFolder;
      for (const seg of segments) {
        throwIfCancelled();

        current = path.resolve(current, seg);
        ensureWithinRoot(current, rootFolder);
        ensureFolder(current);
      }

      folderCount += 1;
      pushLog(`📂 ${segments.join('/')}`);

      completedSteps += 1;
      emitProgress();

      // Copy attached assets
      const assetKey = rawName;
      if (folderAssets && folderAssets[assetKey]) {
        for (const asset of folderAssets[assetKey]) {
          try {
            throwIfCancelled();

            const fileName = path.basename(asset);
            let destPath = path.resolve(current, fileName);
            ensureWithinRoot(destPath, rootFolder);
            // copyAssetWithSignal will pick a unique name if needed
            await copyAssetWithSignal(asset, destPath);
            assetCount += 1;
            pushLog(`  📎 Copied ${fileName}`);
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            pushLog(`  ❌ Failed to copy ${asset}: ${err.message}`, '', true);
          } finally {
            // Count each attempted asset as progress, success or fail
            completedSteps += 1;
            emitProgress();
          }
        }
      }
    }

    // Safety: ensure we report 100% done
    completedSteps = totalSteps;
    emitProgress();

    pushLog(
      `✅ Project structure created. Folders: ${folderCount}, assets copied: ${assetCount}`
    );

    jobLogger?.setStage('complete');
    jobLogger?.info('Project organizer job completed', { folderCount, assetCount });

    structuredLogPath = writeJobLogToFile(
      'organizer',
      config?.jobId,
      jobLogger?.getEntries() || structuredLog
    );

    archivePath = archiveLog(log, 'organizer');

    return {
      success: true,
      log,
      logText: log.join('\n'),
      structuredLogPath,
      archivePath,
      jobId: config?.jobId
    };
  } catch (err) {
    const isCancelled = err?.name === 'AbortError';
    const errMsg = isCancelled
      ? '🛑 Project organizer cancelled during folder creation or asset copy.'
      : `❌ Error while creating project structure: ${err.message}`;
    // eslint-disable-next-line no-console
    console.error('[createProjectStructure] Uncaught error:', err);
    pushLog(errMsg, '', !isCancelled);

    if (isCancelled) {
      jobLogger?.setStage('cancelled');
      jobLogger?.info('Project organizer job cancelled');
    } else {
      jobLogger?.setStage('error');
      jobLogger?.error('Project organizer job failed', {
        error: err?.message || String(err),
        stack: err?.stack
      });
    }

    structuredLogPath = writeJobLogToFile(
      'organizer',
      config?.jobId,
      jobLogger?.getEntries() || structuredLog
    );

    archivePath = archiveLog(log, 'organizer');

    return {
      success: false,
      cancelled: isCancelled,
      log,
      logText: log.join('\n'),
      structuredLogPath,
      archivePath,
      jobId: config?.jobId
    };
  }
}

module.exports = { createProjectStructure };
