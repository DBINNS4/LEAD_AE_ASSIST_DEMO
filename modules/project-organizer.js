const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sendLogMessage } = require('./logUtils');
const { ensureFolder } = require('../utils/path');
/**
 * Create the folder structure based on config from renderer
 */
async function createProjectStructure(config) {
  const log = [];
  const pushLog = (msg, detail = '', isError = false, fileId = '') => {
    sendLogMessage('organizer', msg, detail, isError, fileId);
    log.push(msg);
  };
  if (process.env.DEBUG_LOGS) {
    // Received folder assets logged only in debug mode
  }
  const {
    rootName,
    selectedFolders,
    prependNumbers,
    uppercase,
    appendDate,
    outputPath,
    folderAssets
  } = config;

  if (!outputPath || !selectedFolders || selectedFolders.length === 0) {
    return { success: false, log: ['❌ Output path or folder selection is missing.'] };
  }

  // Final root folder name
  let finalRoot = rootName.trim() || 'New_Project';
  if (appendDate) {
    const today = new Date().toISOString().split('T')[0];
    finalRoot += `_${today}`;
  }

  const rootFolder = path.join(outputPath, finalRoot);
  ensureFolder(rootFolder);
  pushLog(`📁 Root created: ${rootFolder}`);

const rootRenameMap = {};
let rootCounter = 1;

for (const rawName of selectedFolders) {
  const originalSegments = rawName.split('/');
  const root = originalSegments[0];
  const isRootLevel = originalSegments.length === 1;

  // Build rename map for root folders
  if (isRootLevel) {
    const prefix = prependNumbers ? `${String(rootCounter).padStart(2, '0')}_` : '';
    const newName = prefix + (uppercase ? root.toUpperCase() : root);
    rootRenameMap[root] = newName;
    rootCounter++; 
  }

  // Apply renaming to all paths that share this root
  const segments = [...originalSegments];
  if (rootRenameMap[root]) {
    segments[0] = rootRenameMap[root];
  }

  let current = path.join(outputPath, finalRoot);
  for (const seg of segments) {
    current = path.join(current, seg);
    ensureFolder(current);
  }

  pushLog(`📂 ${segments.join('/')}`);

  // Copy attached assets
  const assetKey = rawName;
  if (folderAssets && folderAssets[assetKey]) {
    for (const asset of folderAssets[assetKey]) {
      try {
        const fileName = path.basename(asset);
        const destPath = path.join(current, fileName);
        await fsp.copyFile(asset, destPath);
        pushLog(`  📎 Copied ${fileName}`);
      } catch (err) {
        pushLog(`  ❌ Failed to copy ${asset}: ${err.message}`);
      }
    }
  }
}

  return { success: true, log };
}

module.exports = { createProjectStructure };
