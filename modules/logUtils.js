const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { ensureUserDataSubdir } = require('../utils/appPaths');

function getRootLogDir() {
  return ensureUserDataSubdir('logs');
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

function sendLogMessage(type, message, detail = '', isError = false, fileId = '') {
  const win = getMainWindow();
  if (win && win.webContents) {
    win.webContents.send(`${type}-log-message`, {
      msg: message,
      detail,
      isError,
      fileId
    });
  }
}

function sendComparisonLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('comparison', message, detail, isError, fileId);
}

function sendResolutionLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('resolution', message, detail, isError, fileId);
}

/**
 * 📤 Sends a message to the renderer (UI)
 *
 * @param {string} message - Message to display
 * @param {boolean} [isError=false] - Whether the message is an error
 * @param {boolean} [overwrite=false] - Whether to replace existing log line
 * @param {string|null} [fileId=null] - Optional ID to tag message to file
 */
function sendLogToRenderer(message, isError = false, overwrite = false, fileId = null, panel = 'ingest') {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;

  const channel = `${panel}-log-message`;

  window.webContents.send(channel, {
    msg: message,
    isError,
    overwrite,
    fileId
  });
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
 * 📖 Reads log files recursively and returns parsed entries
 *
 * @param {string} dir - Folder containing log files or subfolders
 * @param {RegExp} [pattern=/\.txt$/] - Filename pattern to match
 * @returns {Array<{timestamp:number,type:string,message:string,detail:string,status:string,file:string}>}
 */
function readLogFiles(dir, pattern = /\.txt$/) {
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
      } catch (err) {
        console.error('❌ Failed to read log file:', itemPath, err.message);
      }
    }
  });

  return entries;
}

module.exports = {
  sendLogMessage,
  sendLogToRenderer,
  writeLogToFile,
  readLogFiles,
  archiveLog,
  sendComparisonLog,
  sendResolutionLog
};
