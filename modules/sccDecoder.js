'use strict';

const fs = require('fs');
const path = require('path');
const { parseTime: parseTimeMs, isDropFrameRate } = require('../utils/timeUtils');
const { extendedGlyphMap } = require('./sccGlyphMap');

// Reverse lookup for CEA-608 two-byte glyph pairs (parity-stripped 7-bit bytes).
// Key: (hi7 << 8) | lo7  -> unicode glyph
const _TWO_BYTE_GLYPH_BY_WORD = (() => {
  const m = new Map();
  try {
    for (const [glyph, spec] of Object.entries(extendedGlyphMap || {})) {
      const hiCh1 = Number(spec?.hiCh1);
      const hiCh2 = Number(spec?.hiCh2);
      const lo = Number(spec?.lo);
      if (Number.isFinite(lo)) {
        if (Number.isFinite(hiCh1)) m.set(((hiCh1 & 0x7f) << 8) | (lo & 0x7f), glyph);
        if (Number.isFinite(hiCh2)) m.set(((hiCh2 & 0x7f) << 8) | (lo & 0x7f), glyph);
      }
    }
  } catch {
    // Defensive: decoding should still work for plain ASCII if map is missing.
  }
  return m;
})();

// CEA-608 single-byte (printable) exceptions — NOT ASCII.
// Must mirror the encoder's table.
const _CEA608_SINGLE_BYTE_EXCEPTIONS = {
  0x2A: 'á',
  0x5C: 'é',
  0x5E: 'í',
  0x5F: 'ó',
  0x60: 'ú',
  0x7B: 'ç',
  0x7C: '÷',
  0x7D: 'Ñ',
  0x7E: 'ñ',
  0x7F: '█'
};

// Mid-row style tags (parity-stripped).
// We emit the encoder's tag format so the editor can round-trip styling.
const _MIDROW_TAG_BY_LO = {
  0x20: 'Wh',
  0x21: 'WhU',
  0x22: 'Gr',
  0x23: 'GrU',
  0x24: 'Bl',
  0x25: 'BlU',
  0x26: 'Cy',
  0x27: 'CyU',
  0x28: 'R',
  0x29: 'RU',
  0x2A: 'Y',
  0x2B: 'YU',
  0x2C: 'Ma',
  0x2D: 'MaU',
  0x2E: 'I',
  // CTA-608 also defines italics+underline as 0x2F.
  // The encoder represents this as {IU} (expanded during encode).
  0x2F: 'IU'
};

function stripSccComments(raw) {
  let s = String(raw || '').replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
  const out = [];
  for (const line of s.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim(); // line comments
    if (!cleaned) continue;
    if (/^Scenarist_SCC\b/i.test(cleaned)) continue;    // header
    out.push(cleaned);
  }
  return out.join('\n');
}

function detectSccDropFrame(lines = []) {
  // SCC differentiates DF vs NDF by the *last* separator in the timecode:
  //   HH:MM:SS;FF  -> drop-frame
  //   HH:MM:SS:FF  -> non-drop-frame
  // Requested rule: if ANY timecode uses ';' => DF, else if timecodes use ':' => NDF.
  let sawTimecode = false;
  let sawSemicolon = false;
  let sawColon = false;

  for (const line of lines) {
    const m = /^(\d{2}:\d{2}:\d{2})([:;])(\d{2})\b/.exec(String(line || '').trim());
    if (!m) continue;
    sawTimecode = true;
    if (m[2] === ';') sawSemicolon = true;
    else if (m[2] === ':') sawColon = true;
  }

  if (sawSemicolon) return { dropFrame: true, mixed: sawColon };
  if (sawTimecode && sawColon) return { dropFrame: false, mixed: false };
  return { dropFrame: null, mixed: false };
}

function normalizeSccTimecodeDelimiter(tcLabel, dropFrame) {
  const raw = String(tcLabel || '').trim();
  const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
  if (!m) return raw;
  const sep = dropFrame ? ';' : ':';
  return `${m[1]}${sep}${m[2]}`;
}

function _tcToSeconds(tc, fps) {
  // IMPORTANT: SCC explicitly differentiates DF vs NDF using the delimiter.
  //  - ';' => DF
  //  - ':' => NDF
  // Do NOT pass a DF hint that could coerce ':' into DF.
  const ms = parseTimeMs(tc, fps, null);
  return (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
}

// After parity stripping, all CTA‑608 control/PAC bytes are 0x10–0x1F.
function _isCtrl608(hi7) {
  return hi7 >= 0x10 && hi7 <= 0x1f;
}
function _isMidRow(hi7, lo7) { return (hi7 === 0x11 || hi7 === 0x19) && lo7 >= 0x20 && lo7 <= 0x2f; }
// TO1/TO2/TO3 tab offsets: 0x17/0x1F, 0x21..0x23
function _isTabOffset(hi7, lo7) {
  return (hi7 === 0x17 || hi7 === 0x1f) && lo7 >= 0x21 && lo7 <= 0x23;
}

// Decode a CEA‑608 PAC (F1/F2) into a 1‑based row and 0‑based column.
// This is the inverse of modules/sccEncoder.js: pacForRow().
function _decodePacRowCol(hi7, lo7) {
  // Only PAC / extended-address pairs live in this range after parity strip.
  if (hi7 < 0x10 || hi7 > 0x1f) return null;
  if (lo7 < 0x40 || lo7 > 0x7f) return null;

  // Row lookup tables for data channel 1 and 2 (CTA‑608 Table 53).
  const rowsLowCh1 = {
    0x11: 1, 0x12: 3, 0x15: 5, 0x16: 7, 0x17: 9,
    0x10: 11,
    0x13: 12,
    0x14: 14,
  };
  const rowsHighCh1 = {
    0x11: 2, 0x12: 4, 0x15: 6, 0x16: 8, 0x17: 10,
    0x13: 13,
    0x14: 15,
  };
  const rowsLowCh2 = {
    0x19: 1, 0x1a: 3, 0x1d: 5, 0x1e: 7, 0x1f: 9,
    0x18: 11,
    0x1b: 12,
    0x1c: 14,
  };
  const rowsHighCh2 = {
    0x19: 2, 0x1a: 4, 0x1d: 6, 0x1e: 8, 0x1f: 10,
    0x1b: 13,
    0x1c: 15,
  };

  const isCh1 = hi7 <= 0x17;
  const isLow = lo7 <= 0x5f; // 0x40–0x5F vs 0x60–0x7F

  const rows = isCh1
    ? (isLow ? rowsLowCh1 : rowsHighCh1)
    : (isLow ? rowsLowCh2 : rowsHighCh2);

  const row = rows[hi7];
  if (!row) return null;

  // Invert the encoder’s PAC indent logic:
  //   pacIndex = secondByte - 0x40 (or -0x60)
  //   indentNibble = floor((pacIndex - 0x10) / 2)
  //   col = indentNibble * 4
  let pacIndex = lo7 > 0x5f ? lo7 - 0x60 : lo7 - 0x40;
  let col = 0;
  if (pacIndex >= 0x10) {
    const indentNibble = Math.floor((pacIndex - 0x10) / 2);
    col = indentNibble * 4;
  }

  return { row, col };
}

function _byteTo608Char(b7) {
  // CTA-608 is *not* ASCII. Several byte values map to accented glyphs.
  // We must mirror the encoder table or round-tripping breaks.
  const ex = _CEA608_SINGLE_BYTE_EXCEPTIONS[b7];
  if (ex) return ex;
  if (b7 >= 0x20 && b7 <= 0x7e) return String.fromCharCode(b7);
  return '';
}

function _decodeTwoByteGlyph(hi7, lo7) {
  const key = ((hi7 & 0x7f) << 8) | (lo7 & 0x7f);
  return _TWO_BYTE_GLYPH_BY_WORD.get(key) || null;
}

function _decodeMidRowTag(hi7, lo7) {
  if (!_isMidRow(hi7, lo7)) return null;
  const tok = _MIDROW_TAG_BY_LO[lo7];
  return tok ? `{${tok}}` : null;
}

function _overwriteLastCharCell(lineStr, glyph) {
  const arr = Array.from(String(lineStr || ''));
  if (!arr.length) return String(glyph || '');
  arr[arr.length - 1] = String(glyph || '');
  return arr.join('');
}

function decodeScc(rawInput, opts = {}) {
  const cleaned = stripSccComments(rawInput);
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const fps = Number(opts.fps || 29.97) || 29.97;
  // DF/NDF detection (SCC rule):
  //   If ANY timecode uses ';' -> DF
  //   Else if timecodes use ':' -> NDF
  // This must override any caller-provided hint because SCC encodes DF/NDF in the delimiter.
  const det = detectSccDropFrame(lines);
  let dropFrame = (det.dropFrame != null)
    ? det.dropFrame
    : ((opts.dropFrame == null) ? true : !!opts.dropFrame);

  const EOC = 0x2f;
  const EDM = 0x2c;
  const CR = 0x2d;

  const cues = [];
  let buffered = [];
  let curLine = -1;
  // Track PAC rows seen in current block to map to top/bottom lines by order.
  let seenRows = [];
  let lastEocSec = null;
  let pacForLine = [null, null];
  // Track earliest timecode label in the file. Used as the "media start TC" offset so
  // SCC captions can be previewed against 0-based media time in the editor.
  let timecodeBaseSec = null;
  let timecodeBaseLabel = null;

  const ensureCurrentLine = () => {
    if (buffered.length === 0) buffered.push('');
    if (buffered.length < 2) buffered.push('');
    if (curLine < 0) curLine = 0;
    if (typeof buffered[curLine] !== 'string') buffered[curLine] = '';
  };

  const pushOpenCueIfAny = (sec) => {
    // Keep row/col aligned to the actual non-empty lines.
    const pairs = buffered.slice(0, 2).map((s, i) => ({
      // SCC: preserve leading spaces (they matter for centering), strip trailing only
      text: String(s || '').replace(/\s+$/g, ''),
      pl: pacForLine[i] || null
    }));
    // Keep lines that contain any non-space character
    const compact = pairs.filter(p => /[^\s]/.test(p.text || ''));
    if (!compact.length) return;
    const lines = compact.map(p => p.text);

    // Make sccPlacement an array indexed like `lines`
    const sccPlacement = new Array(lines.length).fill(null);
    compact.forEach((p, i) => {
      if (p.pl) sccPlacement[i] = p.pl;
    });

    const text = lines.join('\n');
    cues.push({ start: sec, end: null, text, lines, sccPlacement });
  };

  for (const line of lines) {
    if (!line) continue;
    if (/^Scenarist_SCC/i.test(line)) continue;
    if (/^\/\//.test(line)) continue;

    const m = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(.+)$/.exec(line);
    if (!m) continue;
    const tc = m[1];
    const sec = _tcToSeconds(tc, fps);

    if (timecodeBaseSec == null || sec < timecodeBaseSec) {
      timecodeBaseSec = sec;
      timecodeBaseLabel = normalizeSccTimecodeDelimiter(tc, dropFrame);
    }

    const words = m[2].trim().split(/\s+/).filter(w => /^[0-9A-Fa-f]{4}$/.test(w));
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const wordSec = sec + (wi / fps);
      const word = parseInt(w, 16) & 0xffff;
      const hi = (word >> 8) & 0xff;
      const lo = word & 0xff;
      const hi7 = hi & 0x7f;
      const lo7 = lo & 0x7f;

      if (_isCtrl608(hi7)) {
        // SCC/608 redundancy: control/PAC/TO words are often repeated back-to-back.
        // Treat an immediate duplicate as the redundant copy (apply once, skip next).
        const nextHex = words[wi + 1];
        if (nextHex) {
          const nextWord = parseInt(nextHex, 16) & 0xffff;
          const nextHi7 = (nextWord >> 8) & 0x7f;
          const nextLo7 = nextWord & 0x7f;
          if (nextHi7 === hi7 && nextLo7 === lo7) {
            wi += 1;
          }
        }

        if (lo7 === EOC) {
          if (cues.length && cues[cues.length - 1].end == null) {
            cues[cues.length - 1].end = wordSec;
          }
          pushOpenCueIfAny(wordSec);
          buffered = [];
          curLine = -1;
          seenRows = [];
          pacForLine = [null, null];
          lastEocSec = wordSec;
          continue;
        }
        if (lo7 === EDM) {
          if (cues.length && cues[cues.length - 1].end == null) {
            cues[cues.length - 1].end = wordSec;
          }
          buffered = [];
          curLine = -1;
          seenRows = [];
          pacForLine = [null, null];
          continue;
        }
        if (lo7 === CR) {
          if (buffered.length === 0) buffered.push('');
          if (buffered.length < 2) buffered.push('');
          curLine = Math.min(buffered.length - 1, 1);
          continue;
        }

        // TO1/TO2/TO3 tab offsets – bump current line's column by 1–3 cells.
        if (_isTabOffset(hi7, lo7)) {
          const n = (lo7 & 0x7f) - 0x20; // 1..3

          if (curLine >= 0 && pacForLine[curLine]) {
            const cur = pacForLine[curLine];
            const baseCol = Number(cur.col) || 0;
            const col = Math.max(0, Math.min(31, baseCol + n));
            pacForLine[curLine] = { ...cur, col };
          }
          continue;
        }

        // 0x11/0x19 0x39 is "transparent space". Many encoders emit it as a placeholder
        // before sending a two-byte glyph, which overwrites the previous character cell.
        // We materialize it as a regular space so the following overwrite works.
        if ((hi7 === 0x11 || hi7 === 0x19) && lo7 === 0x39) {
          ensureCurrentLine();
          buffered[curLine] += ' ';
          continue;
        }

        // Special/extended two-byte glyph pairs (®½¿…)
        const glyph = _decodeTwoByteGlyph(hi7, lo7);
        if (glyph) {
          ensureCurrentLine();
          buffered[curLine] = _overwriteLastCharCell(buffered[curLine], glyph);
          continue;
        }

        // Mid-row styling codes: preserve as encoder tags so the editor can round-trip.
        const midTag = _decodeMidRowTag(hi7, lo7);
        if (midTag) {
          ensureCurrentLine();
          buffered[curLine] += midTag;
          continue;
        }

        const pac = _decodePacRowCol(hi7, lo7);
        if (pac) {
          if (buffered.length === 0) buffered.push('');
          if (buffered.length < 2) buffered.push('');

          // Stable mapping: [top, bottom] (unchanged)
          if (!seenRows.includes(pac.row)) {
            if (seenRows.length === 0) {
              seenRows = [pac.row];
            } else if (seenRows.length === 1) {
              const first = seenRows[0];
              const top = Math.min(first, pac.row);
              const bottom = Math.max(first, pac.row);
              // If we wrote the bottom first, move it from slot 0 → slot 1
              if (first === bottom) {
                buffered[1] = buffered[0] || '';
                buffered[0] = '';
                pacForLine[1] = pacForLine[0];
                pacForLine[0] = null;
              }
              seenRows = [top, bottom];
            }
          }

          // If only one PAC row has been seen, choose the visual line
          // by the actual row number: row 15 → bottom (index 1), else top (index 0).
          // With two rows, keep stable [top, bottom] mapping.
          const lineIdx = (seenRows.length === 2)
            ? (pac.row === seenRows[1] ? 1 : 0)
            : (pac.row >= 15 ? 1 : 0);

          pacForLine[lineIdx] = pac;
          curLine = lineIdx;
          continue;
        }
        continue;
      }

      if (hi7 >= 0x20) {
        ensureCurrentLine();
        buffered[curLine] += _byteTo608Char(hi7);
        buffered[curLine] += _byteTo608Char(lo7);
      }
    }
  }

  if (cues.length && cues[cues.length - 1].end == null) {
    const start = cues[cues.length - 1].start;
    const tail = Math.max(1 / (Number(fps) || 30), 0.5);
    const base = (typeof lastEocSec === 'number') ? lastEocSec : start;
    cues[cues.length - 1].end = (typeof base === 'number' ? base + 2 : start + tail);
  }

  // Normalize SCC cues for editor:
  // - numeric start/end (seconds)
  // - sorted by start
  // - enforce monotonic start and non-zero duration
  cues.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const frame = 1 / (Number(fps) || 30);
  const minTail = Math.max(frame, 0.5);
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let s = Number(cue.start);
    if (!Number.isFinite(s)) s = 0;
    let e = Number(cue.end);

    // If we don't have a usable end, or it's collapsed onto the start,
    // try to extend to the first *later* cue start; fall back to a small tail.
    if (!Number.isFinite(e) || e <= s) {
      let nextStart = NaN;
      for (let j = i + 1; j < cues.length; j++) {
        const ns = Number(cues[j].start);
        if (Number.isFinite(ns) && ns > s) {
          nextStart = ns;
          break;
        }
      }
      if (Number.isFinite(nextStart)) {
        e = nextStart;
      } else {
        e = s + minTail;
      }
    }

    // Keep starts monotonic to avoid overlaps in the editor.
    if (i > 0) {
      const prevEnd = Number(cues[i - 1].end);
      if (Number.isFinite(prevEnd) && s < prevEnd) {
        s = prevEnd;
        if (e <= s) e = s + minTail;
      }
    }

    cue.start = s;
    cue.end = e;
  }

  const dropFrameOut = !!dropFrame && isDropFrameRate(fps);
  const baseSecOut = (typeof timecodeBaseSec === 'number' && Number.isFinite(timecodeBaseSec))
    ? timecodeBaseSec
    : 0;
  const baseLabelOut =
    (typeof timecodeBaseLabel === 'string' && timecodeBaseLabel.trim())
      ? normalizeSccTimecodeDelimiter(timecodeBaseLabel, dropFrameOut)
      : null;

  return {
    cues,
    fps,
    dropFrame: dropFrameOut,
    timecodeBaseSec: baseSecOut,
    timecodeBaseLabel: baseLabelOut,
    timecodeMixed: !!det.mixed
  };
}

function decodeSccFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const decoded = decodeScc(raw, opts);

  // SCC timecodes are typically authored in "program time" (often starting at 01:00:00;00).
  // For editing/preview against 0-based media time, we shift the decoded cues so that the
  // earliest SCC timecode becomes t=0, and store that base label as doc.startTc.
  const baseSec = (typeof decoded.timecodeBaseSec === 'number' && Number.isFinite(decoded.timecodeBaseSec))
    ? decoded.timecodeBaseSec
    : 0;
  const baseLabel = (typeof decoded.timecodeBaseLabel === 'string' && decoded.timecodeBaseLabel.trim())
    ? decoded.timecodeBaseLabel.trim()
    : null;

  const keepAbsoluteTimecode =
    opts.keepAbsoluteTimecode === true ||
    opts.shiftToZero === false;

  const shiftSec = (!keepAbsoluteTimecode && baseSec > 0) ? baseSec : 0;
  const startTc = (!keepAbsoluteTimecode && baseLabel) ? baseLabel : null;

  const cues = (decoded.cues || []).map((c, idx) => {
    const lines = Array.isArray(c.lines) && c.lines.length
      ? c.lines
      : String(c.text || '').split(/\r?\n/).slice(0, 2);
    return {
      id: c.id ?? idx,
      start: Math.max(0, (Number(c.start) || 0) - shiftSec),
      end: Math.max(0, (Number(c.end) || 0) - shiftSec),
      text: c.text,
      speaker: c.speaker || null,
      lines,
      sccPlacement: Array.isArray(c.sccPlacement) ? c.sccPlacement : null
    };
  });

  // If we imported an NDF SCC, allow round-trip export without forcing the user
  // through hidden feature flags. The file itself is the explicit request.
  const sccOptions = { ...(opts.sccOptions || {}) };
  if (decoded.dropFrame === false) sccOptions.allowNdf = true;

  return {
    sourcePath: filePath,
    displayName: path.basename(filePath),
    fps: decoded.fps,
    dropFrame: decoded.dropFrame,
    startTc,
    timecodeBaseSec: baseSec,
    timecodeBaseLabel: baseLabel,
    timecodeMixed: !!decoded.timecodeMixed,
    keepAbsoluteTimecode,
    mediaPath: opts.mediaPath || null,
    cues,
    sccOptions
  };
}

module.exports = {
  decodeScc,
  decodeSccFile
};
