const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { ensureUserDataSubdir } = require('../utils/appPaths');

function getRootLogDir() {
  return ensureUserDataSubdir('logs');
}

/**
 * Resolve the application version (best-effort).
 * This is useful to pin logs to a specific build.
 */
function getAppVersion() {
  try {
    // In the main Electron process, app is available globally
    // Fallback to env if running in atypical test harness
    const { app } = require('electron');
    return app?.getVersion?.() || process.env.APP_VERSION || '0.0.0';
  } catch {
    return process.env.APP_VERSION || '0.0.0';
  }
}
// Get the primary application window, ignoring DevTools focus
// Helper to get the primary application window in both main and test envs
const getMainWindow = () => {
  if (global.mainWindow) return global.mainWindow;
  if (typeof BrowserWindow.getFocusedWindow === 'function') {
    const win = BrowserWindow.getFocusedWindow();
    if (win) return win;
  }
  return typeof BrowserWindow.getAllWindows === 'function'
    ? BrowserWindow.getAllWindows()[0]
    : undefined;
};

function dispatchLogToRenderer(panel, payload) {
  const win = getMainWindow();
  if (win && win.webContents) {
    win.webContents.send(`${panel}-log-message`, payload);
  }
}

function sendLogMessage(type, message, detail = '', isError = false, fileId = '', level = null) {
  const resolvedLevel = level || (isError ? 'error' : 'info');
  const isWarning = resolvedLevel === 'warn';
  const isErr = resolvedLevel === 'error' || isError;

  sendLogToRenderer(message, isErr, false, fileId, type, detail, resolvedLevel, isWarning);
}

function sendComparisonLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('comparison', message, detail, isError, fileId);
}

function sendResolutionLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('resolution', message, detail, isError, fileId);
}

/**
 * @typedef {Object} JobLogEntry
 * @property {string} timestamp ISO timestamp
 * @property {string} level    'debug' | 'info' | 'warn' | 'error'
 * @property {string} appVersion
 * @property {string} panel
 * @property {string} jobId
 * @property {string} stage
 * @property {string} message
 * @property {Object} [meta]
 */

/**
 * Create a job-scoped logger that:
 * - emits structured entries
 * - mirrors to the renderer for live UI
 */
function createJobLogger({ panel, jobId, stage = 'init', collector = null } = {}) {
  const appVersion = getAppVersion();
  /** @type {JobLogEntry[]} */
  const entries = [];

  const push = (level, message, meta = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      appVersion,
      panel,
      jobId: jobId || '',
      stage,
      message,
      meta
    };

    entries.push(entry);
    if (collector) collector.push(entry);

    // Text channel for existing UI listeners
    const prefix = `[${panel}]${jobId ? ` [${jobId}]` : ''}${stage ? ` [${stage}]` : ''}`;
    const line = `${prefix} ${message}`;
    const isError = level === 'error';

    // Maintain existing renderer integration (single payload per log)
    sendLogMessage(panel, line, JSON.stringify(meta || {}), isError, jobId || '', level);
  };

  return {
    info: (msg, meta) => push('info', msg, meta),
    warn: (msg, meta) => push('warn', msg, meta),
    error: (msg, meta) => push('error', msg, meta),
    debug: (msg, meta) => push('debug', msg, meta),
    setStage(newStage) {
      stage = newStage || stage;
    },
    getEntries() {
      return entries.slice();
    }
  };
}

/**
 * 📤 Sends a message to the renderer (UI)
 *
 * @param {string} message - Message to display
 * @param {boolean} [isError=false] - Whether the message is an error
 * @param {boolean} [overwrite=false] - Whether to replace existing log line
 * @param {string|null} [fileId=null] - Optional ID to tag message to file
 */
function sendLogToRenderer(
  message,
  isError = false,
  overwrite = false,
  fileId = null,
  panel = 'ingest',
  detail = '',
  level = null,
  isWarning = false
) {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;

  const resolvedLevel = level || (isError ? 'error' : isWarning ? 'warn' : 'info');
  const resolvedIsError = resolvedLevel === 'error' || isError;
  const resolvedIsWarning = resolvedLevel === 'warn' || isWarning;

  const payload = {
    msg: message,
    detail,
    isError: resolvedIsError,
    isWarning: resolvedIsWarning,
    level: resolvedLevel,
    overwrite,
    fileId
  };

  dispatchLogToRenderer(panel, payload);
}
/**
 * 📝 Writes the full ingest log to a file
 *
 * @param {string[]} logLines - Array of strings (log content)
 * @param {string} targetPath - File path to write to
 */
function writeLogToFile(logLines, targetPath) {
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, logLines.join('\n'));
    return true;
  } catch (err) {
    console.error(`❌ Failed to write log file: ${targetPath}`, err.message);
    return false;
  }
}

function archiveLog(logLines, panel = 'system') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(getRootLogDir(), panel);
  const filePath = path.join(folder, `${timestamp}.txt`);
  writeLogToFile(logLines, filePath);
  return filePath;
}

/**
 * Writes a single job's structured log entries to a JSONL file.
 * Filename format: YYYY-MM-DDTHH-MM-SS-ms--<jobId>.jsonl
 *
 * @param {string} panel
 * @param {string} jobId
 * @param {JobLogEntry[]} entries
 * @returns {string} full path to log file
 */
function writeJobLogToFile(panel, jobId, entries) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(getRootLogDir(), panel || 'system');
  fs.mkdirSync(folder, { recursive: true });

  const safeJobId = jobId || 'unknown-job';
  const filename = `${timestamp}--${safeJobId}.jsonl`;
  const filePath = path.join(folder, filename);

  const lines = (entries || []).map(e => JSON.stringify(e));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * 📖 Reads log files recursively and returns parsed entries
 *
 * @param {string} dir - Folder containing log files or subfolders
 * @param {RegExp} [pattern=/\.(txt|jsonl)$/] - Filename pattern to match
 * @returns {Array<{timestamp:number,type:string,message:string,detail:string,status:string,file:string}>}
 */
function readLogFiles(dir, pattern = /\.(txt|jsonl)$/) {
  const entries = [];

  if (!fs.existsSync(dir)) return entries;

  const list = fs.readdirSync(dir, { withFileTypes: true });
  list.forEach(item => {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      const sub = readLogFiles(itemPath, pattern);
      sub.forEach(log => {
        if (!log.type) log.type = item.name;
        entries.push(log);
      });
    } else if (pattern.test(item.name)) {
      try {
        const stat = fs.statSync(itemPath);
        const type = path.basename(dir);
        const lines = fs.readFileSync(itemPath, 'utf-8').split(/\r?\n/);

        if (item.name.endsWith('.jsonl')) {
          lines.forEach(line => {
            if (!line.trim()) return;
            try {
              const parsed = JSON.parse(line);
              const parsedTs = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
              const ts = Number.isNaN(parsedTs) ? stat.mtimeMs : parsedTs;
              const level = parsed.level || 'info';
              const status = level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
              entries.push({
                ...parsed,
                timestamp: ts,
                type: parsed.panel || parsed.type || type,
                status,
                file: item.name
              });
            } catch (err) {
              console.error('❌ Failed to parse JSON log line:', itemPath, err.message);
            }
          });
        } else {
          lines.forEach(line => {
            if (!line.trim()) return;
            let status = 'info';
            if (/❌|error/i.test(line)) status = 'error';
            else if (/⚠️|warn/i.test(line)) status = 'warning';
            entries.push({
              timestamp: stat.mtimeMs,
              type,
              message: line,
              detail: '',
              status,
              file: item.name
            });
          });
        }
      } catch (err) {
        console.error('❌ Failed to read log file:', itemPath, err.message);
      }
    }
  });

  return entries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

module.exports = {
  sendLogMessage,
  sendLogToRenderer,
  writeLogToFile,
  readLogFiles,
  archiveLog,
  sendComparisonLog,
  sendResolutionLog,
  createJobLogger,
  writeJobLogToFile
};
