// ai/subtitleParsers.js
'use strict';

const fs = require('fs');
const path = require('path');
const { isDropFrameRate } = require('../utils/timeUtils');
const { decodeSccFile } = require('../modules/sccDecoder');

function parseSrtTimestamp(ts = '') {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return (+hh * 3600) + (+mm * 60) + (+ss) + (+ms / 1000);
}

function parseVttTimestamp(ts = '') {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return (+hh * 3600) + (+mm * 60) + (+ss) + (+ms / 1000);
}

function parseSrtFile(filePath, ctx = {}) {
  const { fps = 30, dropFrame = false, mediaPath = null } = ctx;
  const useDf = dropFrame && isDropFrameRate(fps);
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const blocks = raw.split(/\n\s*\n/);
  const cues = [];
  blocks.forEach(block => {
    const lines = block.trim().split(/\n/).filter(Boolean);
    if (!lines.length) return;
    let timeLine = lines[0];
    let textStartIdx = 1;
    if (!timeLine.includes('-->') && lines.length > 1) {
      timeLine = lines[1];
      textStartIdx = 2;
    }
    const m = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!m) return;
    const start = parseSrtTimestamp(m[1]);
    const end   = parseSrtTimestamp(m[2]);
    const text  = lines.slice(textStartIdx).join('\n');
    cues.push({
      id: cues.length,
      start, end, text, speaker: null
    });
  });

  return {
    sourcePath: filePath,
    displayName: path.basename(filePath),
    fps, dropFrame: useDf,
    mediaPath,
    cues
  };
}

function parseVttFile(filePath, ctx = {}) {
  const { fps = 30, dropFrame = false, mediaPath = null } = ctx;
  const useDf = dropFrame && isDropFrameRate(fps);
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const lines = raw.split(/\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('-->')) continue;
    const m = line.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;
    const start = parseVttTimestamp(m[1]);
    const end   = parseVttTimestamp(m[2]);
    const textLines = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '') {
      textLines.push(lines[j]); j++;
    }
    i = j;
    cues.push({
      id: cues.length,
      start, end, text: textLines.join('\n'), speaker: null
    });
  }

  return {
    sourcePath: filePath,
    displayName: path.basename(filePath),
    fps, dropFrame: useDf,
    mediaPath,
    cues
  };
}

function parseSccFile(filePath, opts = {}) {
  if (typeof decodeSccFile !== 'function') {
    throw new Error(
      'SCC decoder missing: decodeSccFile() is not exported from modules/sccDecoder.js'
    );
  }
  return decodeSccFile(filePath, { shiftToZero: true, ...opts });
}

module.exports = {
  parseSrtFile,
  parseVttFile,
  parseSccFile
};
