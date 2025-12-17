// modules/sccEncoder.js
'use strict';

const {
  parseTime: parseTimeMs,
  formatTimecode,
  isDropFrameRate,
  secondsToFrames,
  framesToSeconds,
  framesFromTimecodeLabel,
  assertLegalDropFrameLabel
} = require('../utils/timeUtils');
// NOTE: SCC timing policy added: sccOptions.timeSource ∈ 'auto'|'start'|'df-string'
// NEW: sccOptions.allowNdf (default: false) permits 29.97 NDF SCC

// ------------------------ Small text wrappers
function wrapText(text, maxChars, opts = {}) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  const limit = Math.max(1, Number(maxChars) || 32);
  const measure = (opts && typeof opts.measure === 'function')
    ? opts.measure
    : (s => String(s || '').length);
  let current = '';
  for (const word of words) {
    const candidate = current ? (current + ' ' + word) : word;
    if (measure(candidate) > limit) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapTextAndClamp(text, maxChars, maxLines, opts = {}) {
  // Normalize: strip HTML-like tags, condense spaces, map smart quotes -> plain
  const clean = _normalizeForCea608(String(text || ''));
  const limitChars = Math.max(1, Number(maxChars) || 32);
  const limitLines = (maxLines == null) ? null : Math.max(1, Number(maxLines) || 2);
  const overflowPolicyRaw = (opts && typeof opts.overflowPolicy === 'string') ? opts.overflowPolicy : 'truncate';
  const overflowPolicy = String(overflowPolicyRaw || '').trim().toLowerCase() || 'truncate';
  const cueIndex = (opts && Number.isFinite(opts.cueIndex)) ? Number(opts.cueIndex) : null;

  const cueLabel = cueIndex ? `Cue ${cueIndex}` : 'Cue';

  const wrapped = wrapText(clean, limitChars, { measure: (s) => _visible608Length(s) });
  const lineTooLong = wrapped.find(ln => _visible608Length(ln) > limitChars);
  if (lineTooLong && overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitChars} chars/line. Split the cue or reduce text.`);
  }

  if (!limitLines || wrapped.length <= limitLines) return wrapped.slice(0, limitLines || wrapped.length);

  if (overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitLines} lines at ${limitChars} chars/line. Split the cue or reduce text.`);
  }
  return wrapped.slice(0, limitLines);
}

// Duplicate helper for SCC redundancy
function maybeDup(word, repeat) {
  return repeat ? [word, word] : [word];
}

// Map a desired start column (0..31) to a legal 608 indent nibble (0..7)
function _colToIndentNibble(col) {
  const c = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
  return Math.min(7, Math.floor(c / 4));
}

function _normalizeAlignment(align) {
  let a = String(align || '').trim().toLowerCase();
  if (a === 'centre') a = 'center';
  if (a !== 'left' && a !== 'center' && a !== 'right') return '';
  return a;
}

// Broadcast/title-safe defaults.
// Most NLEs (Premiere included) render 608 "col 0" flush to the edge.
// A 2-col inset on both sides gives a 28-col safe width (≈ 90% title safe).
function _normalizeSafeMargins(safe) {
  // Allow explicit opt-out: safeMargins === false → legacy full-width behavior.
  if (safe === false) return { left: 0, right: 0, width: 32 };

  // Accept already-normalized objects ({left,right,width}) without recomputing.
  if (safe && typeof safe === 'object' && Number.isFinite(safe.left) && Number.isFinite(safe.right) && Number.isFinite(safe.width)) {
    return safe;
  }

  let left = 0;
  let right = 0;
  if (safe && typeof safe === 'object') {
    if (Number.isFinite(safe.left)) left = safe.left;
    if (Number.isFinite(safe.right)) right = safe.right;
  }

  left = Math.max(0, Math.min(31, Math.floor(Number(left) || 0)));
  right = Math.max(0, Math.min(31, Math.floor(Number(right) || 0)));

  // Keep at least 1 usable column (and avoid negative widths).
  if ((left + right) > 31) {
    // Prefer reducing the right margin first.
    const over = (left + right) - 31;
    right = Math.max(0, right - over);
    if ((left + right) > 31) {
      left = Math.max(0, left - ((left + right) - 31));
    }
  }

  const width = Math.max(1, 32 - left - right);
  return { left, right, width };
}

function _startColForAlignment(text, align, safeMargins) {
  const a = _normalizeAlignment(align) || 'left';
  const len = _visible608Length(text);
  const safe = _normalizeSafeMargins(safeMargins);
  const usable = Math.max(1, Math.min(32, safe.width));
  const free = Math.max(0, usable - len);

  let startCol = (a === 'center') ? (safe.left + Math.floor(free / 2))
    : (a === 'right') ? (safe.left + free)
    : safe.left;

  // Clamp so we never run past the right safe edge.
  const maxStart = Math.max(0, 32 - safe.right - len);
  startCol = Math.max(0, Math.min(maxStart, startCol));

  return Math.max(0, Math.min(31, startCol));
}

function _splitIndentAndTab(col) {
  const c = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
  const indentNibble = Math.min(7, Math.floor(c / 4));
  const tabRemainder = c - (indentNibble * 4);
  return { indentNibble, tabRemainder };
}

// Pull optional placement tags like {col:12} {row:15} from the start of a line
function _pullPlacementTags(s) {
  let text = String(s || '');
  let row = null, col = null;
  // Allow multiple tags in any order at the beginning of the line
  while (true) {
    const m = text.match(/^\{\s*(row|col)\s*:\s*([0-9]{1,2})\s*\}\s*/i);
    if (!m) break;
    if (m[1].toLowerCase() === 'row') row = Number(m[2]);
    else                               col = Number(m[2]);
    text = text.slice(m[0].length);
  }
  return { text, row, col };
}

// ------------------------ Parity + text encoding (CEA-608)
//
// CEA-608 is *not* ASCII. Some printable ASCII codepoints map to accented
// letters/symbols in 608 (e.g. 0x2A displays "á", not "*").
// We must encode characters using the CEA-608 tables.

function _isSecond608Channel(channel) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  return ch === 2 || ch === 4;
}

// Single-byte CEA-608 "exceptions" (bytes that do NOT match ASCII)
const CEA608_ASCII_EXCEPTION_BYTES = new Set([0x2A, 0x5C, 0x5E, 0x5F, 0x60, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F]);
const CEA608_SINGLE_BYTE_UNICODE = {
  'á': 0x2A,
  'é': 0x5C,
  'í': 0x5E,
  'ó': 0x5F,
  'ú': 0x60,
  'ç': 0x7B,
  '÷': 0x7C,
  'Ñ': 0x7D,
  'ñ': 0x7E,
  '█': 0x7F
};

function _normalizeForCea608(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(/\r\n?/g, '\n');
  // SCC/608 cannot carry HTML tags. Also, _visible608Length() already ignores <...>
  // for layout, so leaving tags here causes layout != encoded output.
  s = s.replace(/<[^>]*>/g, '');
  s = s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/`/g, "'")
    .replace(/~/g, '∼');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function _cea608SingleByteForChar(glyph) {
  if (!glyph) return null;
  const direct = CEA608_SINGLE_BYTE_UNICODE[glyph];
  if (direct != null) return direct;
  if (glyph.length !== 1) return null;
  const code = glyph.charCodeAt(0);
  if (code < 0x20 || code > 0x7F) return null;
  if (CEA608_ASCII_EXCEPTION_BYTES.has(code)) return null;
  return code & 0x7F;
}

function _cea608TwoByteSpecForChar(glyph, extendedGlyphMap) {
  if (!glyph || !extendedGlyphMap) return null;
  return extendedGlyphMap[glyph] || null;
}

function _fallbackBaseGlyphForTwoByteGlyph(glyph) {
  const base = String(glyph || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  if (base && base.length === 1) return base;
  return ' ';
}

const MIDROW_MAP = {
  Wh: 0x20, WhU: 0x21,
  Gr: 0x22, GrU: 0x23,
  Bl: 0x24, BlU: 0x25,
  Cy: 0x26, CyU: 0x27,
  R:  0x28, RU:  0x29,
  Y:  0x2A, YU:  0x2B,
  Ma: 0x2C, MaU: 0x2D,
  I:  0x2E, // italics on
  // CTA-608 defines italics+underline as a *single* mid-row attribute: 0x2F.
  // Encode this as one code so SCC round-trips cleanly (no expansion).
  IU: 0x2F
};

function midRowWordsForToken(token, channel = 1) {
  const lo = MIDROW_MAP[token];
  if (lo == null) return [];
  const hiData = _isSecond608Channel(channel) ? 0x19 : 0x11; // F1 vs F2
  const { hi, lo: loP } = ensureOddParityPair(hiData, lo & 0x7f);
  const word = ((hi << 8) | loP).toString(16).padStart(4, '0');
  return [word];
}

function setOddParity7(byte) {
  const d = byte & 0x7f;
  let bits = d;
  bits = bits - ((bits >>> 1) & 0x55);
  bits = (bits & 0x33) + ((bits >>> 2) & 0x33);
  bits = (bits + (bits >>> 4)) & 0x0f;
  const ones = bits;
  const parityBit = (ones % 2 === 0) ? 0x80 : 0x00; // make total odd
  return d | parityBit;
}
function ensureOddParityPair(a, b) {
  return { hi: setOddParity7(a), lo: setOddParity7(b) };
}

function encode608Line(line, channel = 1, extendedGlyphMap, { strict = true, padByte = 0x20 } = {}) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  const isSecond = _isSecond608Channel(ch);
  const s = _normalizeForCea608(line);
  if (!s) return [];

  const words = [];
  let pending = null;
  let col = 0;
  const invalid = new Set();

  const pushWord = (a7, b7) => {
    const { hi, lo } = ensureOddParityPair(a7 & 0x7F, b7 & 0x7F);
    words.push(((hi << 8) | lo).toString(16).padStart(4, '0'));
  };

  const pushSingle = (b7) => {
    if (pending == null) pending = (b7 & 0x7F);
    else {
      pushWord(pending, b7);
      pending = null;
    }
  };

  for (const glyph of s) {
    const twoByteSpec = _cea608TwoByteSpecForChar(glyph, extendedGlyphMap);
    if (twoByteSpec) {
      // Two-byte CEA-608 glyphs (Special NA + Extended WE) are transmitted as a control pair.
      // Many decoders implement these by overwriting the *previous* character cell.
      //
      // To prevent accidental spacing shifts, we ensure the byte immediately before the glyph
      // code is exactly ONE placeholder character:
      //  • If we have an unpaired printable byte (`pending`), we pair it with a normal space (0x20)
      //    and let the glyph overwrite that space.
      //  • If we're word-aligned (`pending` is null), we emit a "transparent space" first
      //    (0x11/0x19, 0x39) as the placeholder, then the glyph code.
      //
      // Net result: extended glyphs occupy 1 column, and centering/alignment stays stable.
      const hiData = isSecond ? (twoByteSpec.hiCh2 ?? twoByteSpec.hiF2) : (twoByteSpec.hiCh1 ?? twoByteSpec.hiF1);
      const loData = twoByteSpec.lo;
      if (hiData == null || loData == null) {
        invalid.add(glyph);
        if (strict) continue;
      }

      // Place a single overwriteable placeholder immediately before the glyph code.
      if (pending != null) {
        // Second byte of this word becomes the placeholder.
        pushWord(pending, 0x20);
        pending = null;
      } else {
        // "Transparent space" (Special NA 0x39) used internally for padding/placeholder.
        const hiTS = isSecond ? 0x19 : 0x11;
        pushWord(hiTS, 0x39);
      }

      // Extended glyph code word
      pushWord(hiData, loData);
      col += 1;
      continue;
    }

    const b7 = _cea608SingleByteForChar(glyph);
    if (b7 == null) {
      invalid.add(glyph);
      if (strict) continue;
      pushSingle(0x20);
    } else {
      pushSingle(b7);
    }
    col += 1;
  }

  // SCC words are 2 bytes. If a chunk ends on an odd byte, we must pad.
  // Default padding is a visible space (0x20). For intermediate chunks in
  // styled lines, callers can request a non-printing filler (typically NUL / 0x00)
  // to avoid inserting visible spaces into the rendered caption.
  if (pending != null) pushWord(pending, padByte & 0x7F);

  if (strict && invalid.size) {
    const bad = Array.from(invalid).map(c => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(', ');
    throw new Error(`[CEA-608] Unsupported character(s): ${bad}`);
  }

  return words;
}

// Encode a line that may contain {Wh}/{GrU}/.../{I}/{IU} mid-row tags
function encode608StyledLine(line, channel = 1, extendedGlyphMap, encodeOpts) {
  const parts = String(line || '').split(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    if (i % 2 === 1) {
      const repeat = !!(encodeOpts && encodeOpts.repeatControlCodes);
      const midWords = midRowWordsForToken(piece, channel);
      for (const w of midWords) out.push(...maybeDup(w, repeat));
    } else if (piece) {
      // When splitting a line around mid-row attribute tokens, any odd-byte padding
      // inside intermediate chunks must NOT insert a visible space. Use a non-printing
      // filler (commonly NUL / 0x00) for these intermediate chunks so word alignment
      // stays stable without altering displayed text.
      const isIntermediateChunk = i < (parts.length - 1);
      const opts = {
        ...(encodeOpts || {}),
        padByte: isIntermediateChunk ? 0x00 : ((encodeOpts && encodeOpts.padByte) ?? 0x20)
      };
      out.push(...encode608Line(piece, channel, extendedGlyphMap, opts));
    }
  }
  return out;
}

// ------------------------ Control/PAC builders
function ctrl(suffix /* '20','ae','2f',... */, channel = 1) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  // CC1: 0x14  CC2: 0x1C  CC3: 0x15  CC4: 0x1D
  const isField2 = (ch === 3 || ch === 4);
  const isSecond = _isSecond608Channel(ch);
  const hiData = (isField2 ? 0x15 : 0x14) + (isSecond ? 0x08 : 0x00);
  const loData = (parseInt(String(suffix), 16) & 0x7f) >>> 0;
  const { hi, lo } = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function tabOffsetWord(amount = 1, channel = 1) {
  const n = Math.max(1, Math.min(3, amount | 0));
  const hiData = _isSecond608Channel(channel) ? 0x1f : 0x17; // TOx for data channel 1 vs 2
  const loData = 0x20 + n; // 0x21..0x23
  const { hi, lo } = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function pacForRow(rowIndex = 15, indentNibble = 0, channel = 1, style = {}) {
  const row = Math.max(1, Math.min(15, Number(rowIndex) || 15));
  const indent = Math.max(0, Math.min(7, Math.floor(indentNibble || 0)));
  const underline = !!style.underline;

  // CTA-608 Table 53: first byte for each row (data channel 1)
  const FIRST_DC1 = {
    1: 0x11, 2: 0x11,
    3: 0x12, 4: 0x12,
    5: 0x15, 6: 0x15,
    7: 0x16, 8: 0x16,
    9: 0x17, 10: 0x17,
    11: 0x10,
    12: 0x13, 13: 0x13,
    14: 0x14, 15: 0x14,
  };

  // Channel mapping: CC2/CC4 uses +0x08 on the first byte.
  const firstBase = FIRST_DC1[row] ?? 0x14;
  const first = (firstBase + (_isSecond608Channel(channel) ? 0x08 : 0x00)) & 0x7f;

  // PAC second byte is NOT "0x40 | indent".
  // It is row-dependent base + (indent * 2) + underline-bit.
  //
  // IMPORTANT (Rev/MaxCaption-grade behavior):
  // Always emit *indent-style* PACs so indentation round-trips on *all* rows.
  //
  // Decoder indentation parsing uses pacIndex >= 0x10, which corresponds to the
  // 0x50–0x5F ("low" row group) and 0x70–0x7F ("high" row group) ranges.
  // If we use 0x40/0x60 for upper rows, indentation is silently lost.
  //
  // "Low/high" is determined by the row mapping (CTA-608 Table 53):
  //   Low rows:  1,3,5,7,9,11,12,14
  //   High rows: 2,4,6,8,10,13,15
  const isLowRowGroup = (row === 11) || (row <= 10 ? (row % 2 === 1) : (row % 2 === 0));
  const base = isLowRowGroup ? 0x50 : 0x70;

  const second = (base + (2 * indent) + (underline ? 1 : 0)) & 0x7f;
  const { hi, lo } = ensureOddParityPair(first, second);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function _visible608Length(t) {
  // Visible-cell length on the 32-column CEA-608 grid.
  //
  // Important details for "broadcast-QC" correctness:
  //  • Placement tags ({row:x}{col:y}{pac:...}) and {NOP} are not rendered.
  //  • Mid-row attributes ({WhU}, {I}, etc.) occupy one cell on decoders
  //    (they appear as a styled blank). Count them as 1 visible column.
  let s = String(t || '').replace(/<[^>]+>/g, '');
  // Strip known non-visible tags
  s = s.replace(/\{\s*(row|col|pac)\s*:\s*[^}]+\}\s*/gi, '');
  s = s.replace(/\{\s*NOP\s*\}\s*/gi, '');
  // Mid-row attribute tokens are 1 visible cell
  s = s.replace(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g, ' ');
  // Defensive: strip any other brace-wrapped tokens (non-visible)
  s = s.replace(/\{[^}]+\}/g, '');
  return s.length;
}
function _indentForAlignment(text, align) {
  const startCol = _startColForAlignment(text, align);
  return _splitIndentAndTab(startCol).indentNibble;
}

// ------------------------ Placement audit (for QC)
function computeCea608PlacementAudit(segments, {
  maxCharsPerLine = 32,
  maxLinesPerBlock = 2,
  includeSpeakerNames = false,
  sccOptions = {}
} = {}) {
  const alignment = _normalizeAlignment(sccOptions.alignment) || 'left';
  const policy = sccOptions.rowPolicy || 'bottom2';
  const safe = _normalizeSafeMargins(sccOptions.safeMargins);
  const effectiveMaxChars = Math.min(Math.max(1, Number(maxCharsPerLine) || 32), safe.width);
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];

  const out = [];
  for (const seg of (segments || [])) {
    if (!seg) { out.push(null); continue; }
    let text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) { out.push(null); continue; }
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${text}`;

    const lines = wrapTextAndClamp(text, effectiveMaxChars, maxLinesPerBlock);
    const isSingle = lines.length === 1;
    const linesAudit = [];
    lines.forEach((line, idx) => {
      const startCol = _startColForAlignment(line, alignment, safe);
      const indentNibble = _splitIndentAndTab(startCol).indentNibble;
      // IMPORTANT: match the encoder's default behavior so placement previews/editing
      // don't drift on single-line captions.
      //  • two-line blocks → rowPair[0], rowPair[1]
      //  • single-line blocks → bottom row of the pair by default
      const row = isSingle
        ? (rowPair[1] || rowPair[0] || 15)
        : (rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14);
      linesAudit.push({
        index: idx,
        text: line,
        row,
        indentNibble,
        columnStart: startCol
      });
    });
    out.push({ start: seg.start, end: seg.end, timecodes: seg.timecodes, lines: linesAudit });
  }
  return out;
}

// ------------------------ Word builders (POP-ON only)
function build608WordsForPopOn(lines, alignment = 'left', opts = {}) {
  const ch = Math.max(1, Math.min(4, Number(opts.channel) || 1));
  const repeatCtrl = opts.repeatControlCodes !== false;      // default on
  const repeatPac  = opts.repeatPreambleCodes !== false;     // default on
  const words = [];
  // Optional misc preface (behind flags)
  if (opts.misc && Array.isArray(opts.misc.prefix) && opts.misc.prefix.length) {
    for (const word of opts.misc.prefix) words.push(word);
  }
  // RCL + ENM (duplicated when enabled)
  words.push(...maybeDup(ctrl('20', ch), repeatCtrl)); // RCL
  words.push(...maybeDup(ctrl('2e', ch), repeatCtrl)); // ENM (94AE)
  const policy = opts.rowPolicy || 'bottom2';
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];
  const normalizedAlign = _normalizeAlignment(alignment) || 'left';
  const safe = _normalizeSafeMargins(opts.safeMargins);
  const placements = lines.map(line => _pullPlacementTags(line));
  const plainLines = placements.map(p => p.text);
  const nonEmpty = plainLines.filter(l => l && l.trim()).length;
  const isSingle = nonEmpty === 1;

  placements.forEach((ovr, idx) => {
    const encoded = encode608StyledLine(
      ovr.text,
      ch,
      opts.extendedGlyphMap,
      { strict: opts.strictCharacterEncoding !== false }
    );
    if (!encoded.length) return;
    // Default row: honor explicit tags; otherwise:
    //  • two-line blocks → rowPair[0], rowPair[1]
    //  • single-line blocks → bottom of the pair by default
    const rowDefault = isSingle
      ? (rowPair[1] || rowPair[0] || 15)
      : (rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14);
    // IMPORTANT:
    // Row placement tags {row:N} must be allowed across the full CEA-608 grid (1..15),
    // not hard-clamped to the title-safe default band (12..15). Title-safe behavior is
    // a *policy/UI default* (rowPolicy), not a file-format limitation.
    const row = Number.isFinite(ovr.row)
      ? Math.max(1, Math.min(15, ovr.row))
      : rowDefault;
    // Column selection order: explicit callback → {col:N} tag → alignment rule
    let indent = null;
    let tabRemainder = 0;
    let startCol = null;
    if (typeof opts.getColumnStart === 'function') {
      const col = opts.getColumnStart({ text: ovr.text, index: idx, row, lines: plainLines, channel: ch });
      if (Number.isFinite(col)) {
        const split = _splitIndentAndTab(col);
        indent = split.indentNibble;
        tabRemainder = split.tabRemainder;
        startCol = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
      }
    }
    if (indent == null && Number.isFinite(ovr.col)) {
      const split = _splitIndentAndTab(ovr.col);
      indent = split.indentNibble;
      tabRemainder = split.tabRemainder;
      startCol = Math.max(0, Math.min(31, Math.floor(Number(ovr.col) || 0)));
    }
    if (indent == null) {
      startCol = _startColForAlignment(ovr.text, normalizedAlign, safe);
      const split = _splitIndentAndTab(startCol);
      indent = split.indentNibble;
      tabRemainder = split.tabRemainder;
    }
    if (indent == null) { indent = 0; }
    if (startCol == null) { startCol = 0; }
    // PAC (duplicated when enabled)
    // NOTE: pacForRow takes INDENT NIBBLE (0..7), not raw columns.
    words.push(...maybeDup(pacForRow(row, indent, ch), repeatPac));
    if (tabRemainder > 0) words.push(...maybeDup(tabOffsetWord(tabRemainder, ch), repeatCtrl));
    words.push(...encoded);
  });

  // EOC (duplicated)
  words.push(...maybeDup(ctrl('2f', ch), repeatCtrl)); // EOC
  if (opts.padEven === true && (words.length % 2) !== 0) {
    const pad = words[words.length - 1] || ctrl('ae', ch); // duplicate EOC/ENM
    words.push(pad);
  }
  return words;
}

// ------------------------ The encoder (CEA‑608 .scc)
function generateSCC(
  segments,
  { 
    fps = 29.97,
    dropFrame = true,
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    includeSpeakerNames = false,
    sccOptions = {},
    // Optional Start TC offset (e.g., "01:00:00;00"). Applied only when
    // timing is derived from numeric start/msStart (not when anchoring to df-string labels).
    startTc = null,
    startTC = null,
    returnStats = false
  } = {}
) {
  // new: timing policy + eof placement
  const timeSource = (sccOptions && sccOptions.timeSource) || 'auto'; // 'auto'|'start'|'ms'|'df-string'

  // NEW: optional start-of-program reset/clear line.
  // Some pipelines want an initial clear to avoid "ghost captions" on ingest devices.
  // Supported values for sccOptions.startResetAt:
  //   - false / 'off' / 'none' : disabled
  //   - 'zero'                 : emit reset at 00:00:00;00 (or :00 for NDF)
  //   - 'startTc'              : emit reset at Start TC (if provided)
  //   - 'both'                 : emit both (when Start TC exists)
  // Operation controlled by sccOptions.startResetOp: 'edm' (default) or 'rdc'.

  // Start TC offset: used to shift the SCC timeline so the first cue can start at
  // program TC (common broadcast requirement). We keep it opt-in.
  const baseStartTc =
    (typeof startTc === 'string' && startTc.trim())
      ? startTc.trim()
      : (typeof startTC === 'string' && startTC.trim())
        ? startTC.trim()
        : (typeof sccOptions?.startTc === 'string' && sccOptions.startTc.trim())
          ? sccOptions.startTc.trim()
          : (typeof sccOptions?.startTC === 'string' && sccOptions.startTC.trim())
            ? sccOptions.startTC.trim()
            : null;

  const _normalizeStartTc = (tcLabel) => {
    const raw = String(tcLabel || '').trim();
    const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
    if (!m) return raw;
    // SCC delimiter reflects DF vs NDF
    const sep = dropFrame ? ';' : ':';
    return `${m[1]}${sep}${m[2]}`;
  };

  const baseStartTcNorm = baseStartTc ? _normalizeStartTc(baseStartTc) : null;
  let baseOffsetSec = 0;
  if (baseStartTcNorm && timeSource !== 'df-string') {
    // If DF, reject illegal DF positions early.
    if (dropFrame && /;/.test(baseStartTcNorm)) {
      assertLegalDropFrameLabel(baseStartTcNorm, fps);
    }
    baseOffsetSec = parseTimeMs(baseStartTcNorm, fps, /* auto */ null) / 1000;
    if (!Number.isFinite(baseOffsetSec)) baseOffsetSec = 0;
  }

  if (!Array.isArray(segments)) return 'Scenarist_SCC V1.0\n';

  const allowNdf = !!(sccOptions && sccOptions.allowNdf);
  // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
  // We keep DF as the default, and only allow NDF when explicitly requested.
  const is2997 = Math.abs((Number(fps) || 0) - 29.97) < 0.05;
  const dfOk = is2997 && dropFrame === true;
  const ndfOk = is2997 && allowNdf && dropFrame === false;
  if (!dfOk && !ndfOk) {
    throw new Error('SCC timing must be 29.97 DF or (opt-in) 29.97 NDF');
  }

  const header = 'Scenarist_SCC V1.0';
  const lines = [header];
  const events = [];

  const alignment = _normalizeAlignment(sccOptions.alignment) || 'left';
  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  const safe = _normalizeSafeMargins(sccOptions.safeMargins);
  const effectiveMaxChars = Math.min(Math.max(1, Number(maxCharsPerLine) || 32), safe.width);
  // For broadcast deliverables, silent truncation is not acceptable. Default to
  // hard errors unless a caller explicitly opts into truncation.
  const overflowPolicyRaw = (sccOptions && sccOptions.overflowPolicy) ?? null;
  const overflowPolicy = (typeof overflowPolicyRaw === 'string')
    ? overflowPolicyRaw.trim().toLowerCase()
    : 'error';
  // 🔒 hard-lock to pop-on for simplicity & parity with UI
  const ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));

  // Optional program-start reset (EDM/RDC) to prevent ingest devices from
  // displaying stale/"ghost" captions. This is independent of the EOF clear.
  const startResetAtRaw = (sccOptions && sccOptions.startResetAt) ?? null;
  const startResetAt = (typeof startResetAtRaw === 'string')
    ? startResetAtRaw.trim().toLowerCase()
    : (startResetAtRaw ? 'starttc' : 'off');
  const startResetOp = (String(sccOptions?.startResetOp || 'edm').toLowerCase() === 'rdc')
    ? '29'  // RDC
    : '2c'; // EDM
  const startResetOpWord = ctrl(startResetOp, ch);
  // A real "reset" for pop-on workflows clears BOTH displayed and non-displayed memory.
  // Emit OP OP ENM ENM (OP = EDM by default, or RDC if explicitly requested).
  const startResetWords = [
    startResetOpWord,
    startResetOpWord,
    ctrl('2e', ch), // ENM
    ctrl('2e', ch)  // ENM
  ];

  // Compute reset time(s)
  const resetTimes = [];
  const wantZero  = (startResetAt === 'zero' || startResetAt === 'both');
  const wantStart = (
    startResetAt === 'starttc' ||
    startResetAt === 'start' ||
    startResetAt === 'program' ||
    startResetAt === 'both'
  );

  if (wantZero) {
    resetTimes.push({ sec: 0, label: formatTimecode(0, dropFrame, fps, 'colon') });
  }

  if (wantStart && baseStartTcNorm) {
    let sec = 0;
    try {
      sec = (parseTimeMs(baseStartTcNorm, fps, null) / 1000) || 0;
    } catch {
      sec = 0;
    }
    resetTimes.push({ sec, label: baseStartTcNorm });
  }

  // De-dupe by label and keep deterministic ordering
  const seenReset = new Set();
  resetTimes
    .filter(r => r && typeof r.label === 'string' && r.label.trim())
    .sort((a, b) => (a.sec || 0) - (b.sec || 0))
    .forEach(r => {
      const key = r.label.trim();
      if (seenReset.has(key)) return;
      seenReset.add(key);
      if (startResetAt !== 'off' && startResetAt !== 'none' && startResetAt !== 'false') {
        events.push({
          kind: 'startReset',
          startFrame: secondsToFrames(r.sec, fps),
          label: key,
          words: startResetWords
        });
      }
    });
  // Default redundancy ON unless explicitly disabled
  const repeatControlCodes  = sccOptions.repeatControlCodes !== false;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  const frame = 1 / fps;
  const prepared = [];
  let txCursorSec = 0;
  const eocWord = ctrl('2f', ch);
  const edmWord = ctrl('2c', ch);

  let lastStartSec = -Infinity;
  let lastEndSec = -Infinity;
  const metrics = { captionsCount: 0, longestLineChars: 0, durations: [], avgDurationSec: 0, lateEocCount: 0, maxLateEocSec: 0, totalLateEocSec: 0, mitigatedCount: 0, maxMitigationSavedSec: 0, warnings: [] };

  for (const [segIndex, seg] of segments.entries()) {
    if (!seg) continue;
    const rawText = String(seg.text || '').replace(/\r\n?/g, '\n');
    let text = rawText.trim();
    const skipPrefix = /\{NOP\}/i.test(text);
    if (skipPrefix) {
      text = text.replace(/\{NOP\}/ig, ' ').replace(/\s+/g, ' ').trim();
    }
    // Remove leading dash bullets like "- Hello" / "— Hi" / "– Yo"
    if (sccOptions?.stripLeadingDashes) {
      text = text.replace(/^\s*[-–—]{1,2}\s+/, '');
    }
    if (!text) continue;
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${text}`;

    // IMPORTANT: preserve explicit line breaks or per-line placement tags so the
    // downstream placement parser can spot them before wrapping.
    const hasExplicit = text.includes('\n') || /\{\s*(row|col)\s*:\s*\d+\s*\}/i.test(text);
    const overflowCtx = { overflowPolicy, cueIndex: segIndex + 1 };
    const wrapped = hasExplicit
      ? (() => {
          const explicitLines = text
            .split('\n')
            .map(s => s.replace(/\s+/g, ' ').trim())
            .map((ln) => {
              const pulled = _pullPlacementTags(ln);
              const clamped = wrapTextAndClamp(pulled.text, effectiveMaxChars, 1, overflowCtx)[0] || '';
              if (!clamped) return '';
              const rowTag = Number.isFinite(pulled.row) ? `{row:${pulled.row}}` : '';
              const colTag = Number.isFinite(pulled.col) ? `{col:${pulled.col}}` : '';
              return `${rowTag}${colTag}${clamped}`.trim();
            })
            .filter(Boolean);

          if (maxLinesPerBlock && explicitLines.length > maxLinesPerBlock) {
            if (overflowPolicy === 'error') {
              throw new Error(
                `Cue ${segIndex + 1} exceeds ${maxLinesPerBlock} lines at ${effectiveMaxChars} chars/line. ` +
                `Split the cue or reduce text.`
              );
            }
            return explicitLines.slice(0, maxLinesPerBlock);
          }
          return explicitLines;
        })()
      : wrapTextAndClamp(text, effectiveMaxChars, maxLinesPerBlock, overflowCtx);
    if (!wrapped.length) continue;

    metrics.captionsCount += 1;
    const localMax = Math.max(...wrapped.map(_visible608Length));
    if (localMax > metrics.longestLineChars) metrics.longestLineChars = localMax;
    if (typeof seg.start === 'number' && typeof seg.end === 'number') {
      metrics.durations.push(Math.max(0, seg.end - seg.start));
    }

    let words;
    try {
      words = build608WordsForPopOn(wrapped, alignment, {
        safeMargins: safe,
        padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
        repeatControlCodes, repeatPreambleCodes, extendedGlyphMap: sccOptions.extendedGlyphMap,
        strictCharacterEncoding: sccOptions.strictCharacterEncoding
      });
    } catch (err) {
      const where = `seg#${segIndex} @ ${formatTimecode(Number.isFinite(seg.start) ? (seg.start + baseOffsetSec) : seg.start, dropFrame, fps, 'colon')}`;
      const snippet = String(seg.text || '').slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`[SCC] Encoding failed (${where}): ${err.message}. Text="${snippet}"`);
    }
    // Optional caption prefix words (skippable with {NOP})
    if (!skipPrefix && Array.isArray(sccOptions.prefixWords) && sccOptions.prefixWords.length) {
      words = [...sccOptions.prefixWords, ...words];
    }

    // --- choose a source label/seconds from simplified JSON
    const pickJsonLabel = (segment, dropFrameFlag, frameRate) => {
      const t = segment?.timecodes;
      if (!t) return null;
      const preferred = dropFrameFlag
        ? (t.df && t.df.start)
        : (t.ndf && t.ndf.start);
      if (typeof preferred === 'string' && preferred) return preferred;
      const msStart = t.ms?.start;
      if (Number.isFinite(msStart)) {
        return formatTimecode(msStart / 1000, dropFrameFlag, frameRate, 'colon');
      }
      return null;
    };
    const srcTc = pickJsonLabel(seg, dropFrame, fps);
    // If we're anchoring to the DF label string, reject illegal DF positions early.
    if (timeSource === 'df-string' && dropFrame && typeof srcTc === 'string' && /;/.test(srcTc)) {
      assertLegalDropFrameLabel(srcTc, fps);
    }

    let startSecRaw;
    let startWasTcLabel = false;

    if (timeSource === 'ms' && Number.isFinite(seg.msStart)) {
      startSecRaw = seg.msStart / 1000;
    } else if (timeSource === 'start' && Number.isFinite(seg.start)) {
      startSecRaw = seg.start;
    } else if (timeSource === 'df-string' && srcTc) {
      // We will echo the label directly below; still compute seconds for EOF bookkeeping
      startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
      startWasTcLabel = true;
    } else {
      // 'auto' → prefer numeric start, then msStart, then parse tc string
      if (Number.isFinite(seg.start)) {
        startSecRaw = seg.start;
      } else if (Number.isFinite(seg.msStart)) {
        startSecRaw = seg.msStart / 1000;
      } else if (srcTc) {
        startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
        startWasTcLabel = true;
      } else {
        startSecRaw = 0;
      }
    }

    let startSec = Number.isFinite(startSecRaw) ? startSecRaw : 0;
    let endSec = null;
    if (timeSource === 'ms') {
      endSec = Number.isFinite(seg.msEnd)
        ? (seg.msEnd / 1000)
        : Number.isFinite(seg.end)
          ? seg.end
          : null;
    } else {
      endSec = Number.isFinite(seg.end)
        ? seg.end
        : Number.isFinite(seg.msEnd)
          ? seg.msEnd / 1000
          : null;
    }

    // Apply Start TC offset only when we're using numeric timing (not df-string labels).
    if (baseOffsetSec && !startWasTcLabel) {
      startSec += baseOffsetSec;
      if (endSec != null) endSec += baseOffsetSec;
    }

    if (startSec <= lastEndSec) {
      startSec = lastEndSec + frame; // monotonic clamp
    }

    if (endSec == null && Number.isFinite(seg.duration)) {
      endSec = startSec + Number(seg.duration);
    } else if (endSec == null && Number.isFinite(seg.msDuration)) {
      endSec = startSec + (seg.msDuration / 1000);
    }
    if (endSec != null && endSec <= startSec) {
      endSec = startSec + frame;
    }

    lastStartSec = Math.max(lastStartSec, startSec);
    if (Number.isFinite(endSec)) {
      if (endSec > lastEndSec) lastEndSec = endSec;
    } else if (startSec > lastEndSec) {
      lastEndSec = startSec;
    }

    const tcFromSec = formatTimecode(startSec, dropFrame, fps, 'colon');
    if (timeSource === 'df-string' && srcTc && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(srcTc)) {
      const match = srcTc.match(/^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/);
      if (match) {
        const [, h, m, s, f] = match;
        const labeledTc = `${h}:${m}:${s}${dropFrame ? ';' : ':'}${f}`;
        if (labeledTc !== tcFromSec) {
          console.warn(`[SCC] df-string mismatch @ ${labeledTc} vs ${tcFromSec}`);
        }
      }
    }

    // ── Late-EOC auto-mitigation (Phase E) ───────────────────────────────
    // If we can't pre-transmit enough words before the intended cue start
    // (due to txCursorSec overlap), we try to *shrink the payload* so the
    // ideal transmit start moves later and EOC can land on-time.
    const mit = (sccOptions && typeof sccOptions === 'object' && sccOptions.lateEocMitigation)
      ? sccOptions.lateEocMitigation
      : null;
    const mitEnabled = !!(mit && mit.enabled !== false);
    if (mitEnabled) {
      // Default thresholds: only bother when we're meaningfully late.
      const maxLateSec = Number.isFinite(Number(mit.maxLateSec)) ? Number(mit.maxLateSec) : (1 / fps);
      const allowDisableRedundancy = mit.allowDisableRedundancy !== false;
      const allowDropPrefixWords = mit.allowDropPrefixWords !== false;
      const allowDropSpeakerPrefix = mit.allowDropSpeakerPrefix !== false;
      const allowTruncate = mit.allowTruncate === true;

      // We only know we're late when txCursorSec is already after the ideal pre-roll.
      // But we can *reduce leadWords* so the ideal pre-roll shifts later.
      const maxLeadWordsAllowed = Math.floor((startSec - txCursorSec) / frame);

      // If there's no room at all, mitigation can't help.
      if (maxLeadWordsAllowed >= 0) {
        const baseLead = Math.max(0, words.indexOf(eocWord));
        const baseIdeal = Math.max(0, startSec - (baseLead * frame));
        const baseLate = Math.max(0, txCursorSec - baseIdeal);

        if (baseLate > maxLateSec) {
          // Attempt progressively more aggressive variants until leadWords fit.
          const variants = [];
          variants.push({ name: 'baseline', repeatControlCodes, repeatPreambleCodes, includePrefix: true, dropSpeaker: false });

          if (allowDropPrefixWords) {
            variants.push({ name: 'drop-prefixWords', repeatControlCodes, repeatPreambleCodes, includePrefix: false, dropSpeaker: false });
          }
          if (allowDropSpeakerPrefix && includeSpeakerNames && seg.speaker) {
            variants.push({ name: 'drop-speaker', repeatControlCodes, repeatPreambleCodes, includePrefix: true, dropSpeaker: true });
            if (allowDropPrefixWords) variants.push({ name: 'drop-speaker+prefixWords', repeatControlCodes, repeatPreambleCodes, includePrefix: false, dropSpeaker: true });
          }
          if (allowDisableRedundancy) {
            variants.push({ name: 'no-redundancy', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: true, dropSpeaker: false });
            if (allowDropPrefixWords) variants.push({ name: 'no-redundancy+drop-prefixWords', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: false, dropSpeaker: false });
            if (allowDropSpeakerPrefix && includeSpeakerNames && seg.speaker) {
              variants.push({ name: 'no-redundancy+drop-speaker', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: true, dropSpeaker: true });
              if (allowDropPrefixWords) variants.push({ name: 'no-redundancy+drop-speaker+prefixWords', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: false, dropSpeaker: true });
            }
          }

          const buildWordsVariant = (v) => {
            // Rebuild visible text when we drop speaker labels (treat as optional prefix).
            let segForVariant = seg;
            if (v.dropSpeaker && includeSpeakerNames && seg && seg.speaker) {
              // Preserve original segment data, but avoid the speaker prefix.
              segForVariant = { ...seg, speaker: null };
            }

            // Re-wrap using the already computed 'wrapped' lines so placement stays stable.
            // NOTE: we are not changing line wraps here; we are changing *encoding overhead*
            // (redundancy + optional prefixes). If truncation is enabled, we do a final cut below.
            let w = build608WordsForPopOn(wrapped, alignment, {
              safeMargins: safe,
              padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
              repeatControlCodes: v.repeatControlCodes, repeatPreambleCodes: v.repeatPreambleCodes,
              extendedGlyphMap: sccOptions.extendedGlyphMap,
              strictCharacterEncoding: sccOptions.strictCharacterEncoding
            });

            if (v.includePrefix && !skipPrefix && Array.isArray(sccOptions.prefixWords) && sccOptions.prefixWords.length) {
              w = [...sccOptions.prefixWords, ...w];
            }

            // If we dropped speaker, also remove any already-baked speaker prefix (rare, but possible).
            // This is best-effort: we can't reliably detect the text bytes, so we only removed the metadata above.

            return w;
          };

          let best = { words, lead: baseLead, name: 'baseline' };

          for (const v of variants) {
            let candWords;
            try {
              candWords = buildWordsVariant(v);
            } catch {
              continue;
            }
            const lead = Math.max(0, candWords.indexOf(eocWord));
            if (lead < best.lead) best = { words: candWords, lead, name: v.name };
            if (lead <= maxLeadWordsAllowed) {
              best = { words: candWords, lead, name: v.name };
              break;
            }
          }

          // Last-resort: truncate by stripping trailing words (pre-EOC) until leadWords fit.
          // This *will* change the displayed caption, so it's opt-in.
          if (allowTruncate && best.lead > maxLeadWordsAllowed) {
            const eocIdx = Math.max(0, best.words.indexOf(eocWord));
            if (eocIdx > 0) {
              const targetLead = Math.max(0, maxLeadWordsAllowed);
              const keepPre = best.words.slice(0, targetLead);
              // Keep EOC and everything after it (EDM out-time etc) intact.
              const rest = best.words.slice(eocIdx);
              best = { words: [...keepPre, ...rest], lead: targetLead, name: best.name + '+truncate' };
            }
          }

          if (best.words !== words) {
            const oldLead = baseLead;
            const newLead = best.lead;
            const oldIdeal = Math.max(0, startSec - (oldLead * frame));
            const newIdeal = Math.max(0, startSec - (newLead * frame));
            const saved = Math.max(0, newIdeal - oldIdeal);
            metrics.mitigatedCount += 1;
            if (saved > metrics.maxMitigationSavedSec) metrics.maxMitigationSavedSec = saved;

            const note = `[SCC] Late-EOC mitigation applied (cue #${segIndex + 1}): ${best.name} reduced leadWords ${oldLead} → ${newLead} (saved ${saved.toFixed(3)}s pre-roll)`;
            console.warn(note);
            if (metrics.warnings.length < 25) metrics.warnings.push(note);

            words = best.words;
          }
        }
      }
    }

    const leadWords = Math.max(0, words.indexOf(eocWord));
    const idealTxStart = Math.max(0, startSec - (leadWords * frame));
    // ── Broadcast safety clamp ─────────────────────────────────────
    // Do not emit SCC lines earlier than the program Start TC.
    // Some ingest/QC pipelines reject SCC that starts before the base TC.
    let clampedIdealTxStart = idealTxStart;
    if (baseOffsetSec > 0 && idealTxStart < baseOffsetSec) {
      const delta = baseOffsetSec - idealTxStart;
      clampedIdealTxStart = baseOffsetSec;

      const warn = `[SCC] Pre-transmit clamped at program start TC; first caption delayed by ${delta.toFixed(3)}s`;
      console.warn(warn);
      if (metrics.warnings.length < 25) metrics.warnings.push(warn);
    }

    const txStart = Math.max(clampedIdealTxStart, txCursorSec);
    const txEnd = txStart + (words.length * frame);
    const lateSec = Math.max(0, txStart - idealTxStart);
    if (lateSec > frame) {
      metrics.lateEocCount += 1;
      metrics.totalLateEocSec += lateSec;
      if (lateSec > metrics.maxLateEocSec) metrics.maxLateEocSec = lateSec;

      const msg = `[SCC] Not enough transmit room before cue #${segIndex + 1}; EOC may be late by ${lateSec.toFixed(3)}s`;
      // Keep console noise, but also capture a small warning list for returnStats callers.
      console.warn(msg);
      if (metrics.warnings.length < 25) metrics.warnings.push(msg);
    }
    prepared.push({ segIndex, startSec, endSec, txStart, txEnd, words });
    txCursorSec = txEnd;
  }

  // --- Frame-based scheduler so we can interleave EDM with next-cue preload ---
  const secToFrame = (sec) => secondsToFrames(sec, fps);
  const frameToSec = (fr) => framesToSeconds(fr, fps);

  const cues = prepared.map((p, idx) => {
    const startFrame = secToFrame(p.startSec);
    const endFrame = Number.isFinite(p.endSec) ? secToFrame(p.endSec) : null;
    const txStartFrame = secToFrame(p.txStart);
    const leadWords = Math.max(0, p.words.indexOf(eocWord));
    return {
      idx,
      ...p,
      startFrame,
      endFrame,
      leadWords,
      txSegments: [{ startFrame: txStartFrame, words: p.words.slice() }]
    };
  });

  const cueTxEndFrame = (cue) => {
    const last = cue.txSegments[cue.txSegments.length - 1];
    return last.startFrame + last.words.length;
  };
  const shiftCue = (cue, deltaFrames) => {
    if (!deltaFrames) return;
    for (const seg of cue.txSegments) seg.startFrame += deltaFrames;
  };

  // Enforce a hard floor at the start TC for non df-string exports,
  // and also avoid colliding with a start-reset line emitted at that same time.
  const baseOffsetFrame = (baseOffsetSec && timeSource !== 'df-string') ? secToFrame(baseOffsetSec) : 0;
  let txFloorFrame = baseOffsetFrame;
  for (const ev of events) {
    if (ev.kind === 'startReset' && ev.startFrame === txFloorFrame) {
      txFloorFrame = Math.max(txFloorFrame, ev.startFrame + (ev.words?.length || 0));
    }
  }

  // Ensure sequential transmit windows (frame-aligned) and obey the floor.
  let cursorFrame = txFloorFrame;
  for (const cue of cues) {
    const start0 = cue.txSegments[0].startFrame;
    if (start0 < cursorFrame) shiftCue(cue, cursorFrame - start0);
    cursorFrame = cueTxEndFrame(cue);
  }

  const safeSplitIndex = (words, idx) => {
    let split = Math.floor(Number(idx) || 0);
    if (split < 0) split = 0;
    if (split > words.length) split = words.length;
    // Avoid splitting inside duplicated control code pairs (same word repeated).
    while (split > 0 && split < words.length && words[split - 1] === words[split]) split -= 1;
    return split;
  };

  const edmEvents = [];
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i];
    if (cur.endFrame == null) continue;
    const next = cues[i + 1] || null;
    const nextStartFrame = next ? next.startFrame : Infinity;

    // Only insert EDM if there's at least 2 frames before the next caption starts (need EDM EDM).
    if (cur.endFrame + 2 > nextStartFrame) continue;

    edmEvents.push({
      kind: 'edm',
      startFrame: cur.endFrame,
      words: [edmWord, edmWord]
    });

    if (!next) continue;

    const edmStart = cur.endFrame;
    const edmEnd = edmStart + 2;

    // If the next cue's preload overlaps the EDM window, split its transmit into two SCC lines.
    const overlapsEdm = (seg) => seg.startFrame < edmEnd && (seg.startFrame + seg.words.length) > edmStart;
    let segIdx = next.txSegments.findIndex(overlapsEdm);
    if (segIdx === -1) continue;

    // Try to compensate the 2-frame pause by shifting the next cue earlier,
    // but never past the end of the previous cue's transmit window or the global base offset.
    const prevTxEnd = cueTxEndFrame(cur);
    const slack = next.txSegments[0].startFrame - prevTxEnd;
    const floorSlack = next.txSegments[0].startFrame - baseOffsetFrame;
    const shiftEarlier = Math.max(0, Math.min(2, slack, floorSlack));
    if (shiftEarlier > 0) shiftCue(next, -shiftEarlier);

    // Re-locate the overlapping segment after the shift.
    segIdx = next.txSegments.findIndex(overlapsEdm);
    if (segIdx === -1) continue;

    const seg = next.txSegments[segIdx];
    const rel = edmStart - seg.startFrame;
    const splitIdx = safeSplitIndex(seg.words, rel);
    const preWords = seg.words.slice(0, splitIdx);
    const postWords = seg.words.slice(splitIdx);

    const newSegs = [];
    if (preWords.length) newSegs.push({ startFrame: seg.startFrame, words: preWords });
    if (postWords.length) newSegs.push({ startFrame: edmEnd, words: postWords });
    if (!newSegs.length && seg.words.length) {
      // Worst case: move everything after EDM.
      newSegs.push({ startFrame: edmEnd, words: seg.words.slice() });
    }
    next.txSegments.splice(segIdx, 1, ...newSegs);

    // Enforce non-overlap inside this cue after inserting the EDM gap.
    for (let s = 1; s < next.txSegments.length; s++) {
      const prev = next.txSegments[s - 1];
      const prevEnd = prev.startFrame + prev.words.length;
      if (next.txSegments[s].startFrame < prevEnd) next.txSegments[s].startFrame = prevEnd;
    }

    // Propagate any delays to later cues so nothing overlaps.
    for (let k = i + 1; k < cues.length; k++) {
      const prev = cues[k - 1];
      const thisCue = cues[k];
      const minStart = cueTxEndFrame(prev);
      const curStart = thisCue.txSegments[0].startFrame;
      if (curStart < minStart) shiftCue(thisCue, minStart - curStart);
    }
  }

  // Recompute late-EOC metrics after interleaving.
  metrics.lateEocCount = 0;
  metrics.totalLateEocSec = 0;
  metrics.maxLateEocSec = 0;
  for (const cue of cues) {
    let idx = Math.max(0, cue.leadWords);
    let eocFrame = cue.txSegments[0]?.startFrame || 0;
    for (const seg of cue.txSegments) {
      if (idx < seg.words.length) { eocFrame = seg.startFrame + idx; break; }
      idx -= seg.words.length;
    }
    const lateFrames = Math.max(0, eocFrame - cue.startFrame);
    const lateSec = lateFrames * frame;
    if (lateSec > frame) {
      metrics.lateEocCount++;
      metrics.totalLateEocSec += lateSec;
      metrics.maxLateEocSec = Math.max(metrics.maxLateEocSec, lateSec);
    }
  }

  // Flatten scheduled events: startReset + cue segments + EDM + optional EOF, then sort by time.
  const scheduled = [];
  for (const ev of events) scheduled.push(ev);
  for (const cue of cues) {
    for (const seg of cue.txSegments) {
      if (!seg.words || !seg.words.length) continue;
      scheduled.push({ kind: 'tx', startFrame: seg.startFrame, words: seg.words });
    }
  }
  for (const ev of edmEvents) scheduled.push(ev);

  const hasEOFPolicy = (sccOptions.eofPolicy || '').toLowerCase();
  if (hasEOFPolicy && hasEOFPolicy !== 'off') {
    const minTail = 0.5;
    const eofTimeSec = (hasEOFPolicy === 'atstart')
      ? baseOffsetSec
      : Math.max(lastEndSec + minTail, lastStartSec + 1.0);
    const eofFrame = secToFrame(eofTimeSec);
    const op = (sccOptions.eofOp === 'rdc') ? '29' : '2c'; // RDC or EDM
    const eofWord = ctrl(op, ch);
    scheduled.push({ kind: 'eof', startFrame: eofFrame, words: [eofWord, eofWord] });
  }

  scheduled.sort((a, b) => {
    const af = a.startFrame ?? 0;
    const bf = b.startFrame ?? 0;
    if (af !== bf) return af - bf;
    // Stable-ish tiebreaker: keep resets before tx before edm/eof when times match.
    const prio = { startReset: 0, tx: 1, edm: 2, eof: 3 };
    return (prio[a.kind] ?? 9) - (prio[b.kind] ?? 9);
  });

  for (const ev of scheduled) {
    if (!ev.words || !ev.words.length) continue;
    const tc = ev.label || formatTimecode(frameToSec(ev.startFrame), dropFrame, fps, 'colon');
    lines.push(`${tc}\t${ev.words.map(w => String(w).toUpperCase()).join(' ')}`);
  }

  const text = lines.join('\n') + '\n';
  if (metrics.durations.length) {
    metrics.avgDurationSec = metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length;
  }
  const avgLateEocSec = metrics.lateEocCount ? (metrics.totalLateEocSec / metrics.lateEocCount) : 0;

  return returnStats ? { scc: text, stats: {
    captionsCount: metrics.captionsCount,
    longestLineChars: metrics.longestLineChars,
    avgDurationSec: metrics.avgDurationSec,
    lateEocCount: metrics.lateEocCount,
    mitigatedCount: metrics.mitigatedCount,
    maxMitigationSavedSec: metrics.maxMitigationSavedSec,
    maxLateEocSec: metrics.maxLateEocSec,
    avgLateEocSec,
    warnings: metrics.warnings
  } } : text;
}

// ------------------------ Verifier (odd parity + token sanity)
function _stripSccComments(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const line of s.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    if (/^Scenarist_SCC\b/i.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out.join('\n');
}

function _firstMeaningfulSccLineInfo(raw) {
  // Used to enforce SCC header presence.
  let s = String(raw || '').replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i].replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    return { line: i + 1, text: cleaned };
  }
  return { line: 0, text: '' };
}
const _isTimecodeToken = tok => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tok);
const _isHexWord = tok => /^[0-9a-fA-F]{4}$/.test(tok);
function _onesCount(b) { let x = b & 0xff, c = 0; for (let i=0;i<8;i++){ c += x & 1; x >>= 1; } return c; }
function _isOddParity(byte) { return (_onesCount(byte) % 2) === 1; }

function verifySCC(fileOrText, { maxErrors = 50, fps = 29.97, checkTimecode = true, checkOverlap = true, checkMonotonic = true, checkDropFrameLabels = true, requireHeader = true } = {}) {
  const fs = require('fs');
  const path = require('path');

  let source = fileOrText || '';
  let filePath = null;
  try {
    if (typeof source === 'string' && fs.existsSync(source)) {
      filePath = path.resolve(source);
      source = fs.readFileSync(filePath, 'utf8');
    }
  } catch { /* fall through */ }

  const text = _stripSccComments(source);
  const lines = text.split('\n');

  fps = Number(fps) || 29.97;

  let totalWords = 0, checkedBytes = 0, invalidTokens = 0, parityErrors = 0;
  let headerErrors = 0;
  let timecodeErrors = 0, overlapErrors = 0, monotonicErrors = 0;
  let sawSemicolon = false, sawColon = false;
  let prevStartFrame = null;
  let prevLastFrame = null;
  const errors = [];
  let parsedLines = 0;

  // Enforce SCC header presence (first non-empty, non-comment line).
  if (requireHeader) {
    const first = _firstMeaningfulSccLineInfo(source);
    const headerOk = /^Scenarist_SCC\s+V1\.0\b/i.test(String(first.text || '').trim());
    if (!headerOk) {
      headerErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: first.line || 1,
          timecode: '',
          type: 'header',
          message: 'Missing required SCC header "Scenarist_SCC V1.0" on the first non-comment line.'
        });
      }
    }
  }

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    if (!tokens.length) return;

    const timecode = tokens[0];
    if (!_isTimecodeToken(timecode)) return;

    parsedLines += 1;

    if (timecode.includes(';')) sawSemicolon = true;
    else if (timecode.includes(':')) sawColon = true;

    let startFrame = null;
    if (checkTimecode) {
      try {
        if (checkDropFrameLabels && /;/.test(timecode)) {
          assertLegalDropFrameLabel(timecode, fps);
        }
        startFrame = framesFromTimecodeLabel(timecode, fps);
        if (!Number.isFinite(startFrame)) throw new Error('Unable to parse timecode');
      } catch (e) {
        timecodeErrors += 1;
        if (errors.length < maxErrors) {
          errors.push({
            line: idx + 1,
            timecode,
            type: 'timecode',
            message: e?.message || String(e)
          });
        }
      }
    }

    const words = tokens.slice(1);
    const validWordCount = words.filter(_isHexWord).length;

    if (checkMonotonic && Number.isFinite(startFrame) && prevStartFrame != null && startFrame < prevStartFrame) {
      monotonicErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: idx + 1,
          timecode,
          type: 'monotonic',
          message: `Timecode is earlier than previous line (${startFrame} < ${prevStartFrame})`
        });
      }
    }

    if (checkOverlap && Number.isFinite(startFrame) && prevLastFrame != null && startFrame <= prevLastFrame) {
      overlapErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: idx + 1,
          timecode,
          type: 'overlap',
          message: `Line starts at frame ${startFrame} but previous line occupies through frame ${prevLastFrame}`
        });
      }
    }

    if (Number.isFinite(startFrame)) {
      prevStartFrame = startFrame;
      // Each SCC hex word is transmitted on its own frame; last occupied frame is start + (N-1).
      prevLastFrame = startFrame + Math.max(0, validWordCount) - 1;
    }

    for (let w = 0; w < words.length; w++) {
      const tok = words[w];
      if (!_isHexWord(tok)) { invalidTokens += 1; continue; }
      const word = parseInt(tok, 16) & 0xffff;
      const hi = (word >> 8) & 0xff;
      const lo = word & 0xff;

      const hiOk = _isOddParity(hi) && setOddParity7(hi & 0x7f) === hi;
      const loOk = _isOddParity(lo) && setOddParity7(lo & 0x7f) === lo;

      totalWords += 1;
      checkedBytes += 2;

      if (!hiOk || !loOk) {
        parityErrors += (!hiOk ? 1 : 0) + (!loOk ? 1 : 0);
        if (errors.length < maxErrors) {
          if (!hiOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'HI', byte: hi });
          if (!loOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'LO', byte: lo });
        }
      }
    }
  });

  const mixedDelimiter = sawSemicolon && sawColon;
  if (mixedDelimiter) {
    // Not strictly a parity issue, but broadcast workflows typically expect SCC to be consistently DF (";") or NDF (":").
    timecodeErrors += 1;
    if (errors.length < maxErrors) {
      errors.push({
        line: 0,
        timecode: '',
        type: 'mixed-delimiter',
        message: 'File contains both DF (";") and NDF (":") timecode delimiters'
      });
    }
  }

  const ok =
    (parityErrors === 0) &&
    (invalidTokens === 0) &&
    (headerErrors === 0) &&
    (timecodeErrors === 0) &&
    (monotonicErrors === 0) &&
    (overlapErrors === 0);

  const summary = ok
    ? `OK — ${totalWords} words (${checkedBytes} bytes) • 0 parity errors • 0 invalid tokens • 0 header errors • 0 timecode issues`
    : `FAIL — ${totalWords} words (${checkedBytes} bytes) • ${parityErrors} parity error(s) • ${invalidTokens} invalid tokens • ${headerErrors} header error(s) • ${timecodeErrors} timecode issue(s) • ${monotonicErrors} monotonic issue(s) • ${overlapErrors} overlap issue(s)`;

  return {
    ok,
    file: filePath || undefined,
    totalLines: lines.length,
    parsedLines,
    fps,
    totalWords, checkedBytes,
    invalidTokens, parityErrors, headerErrors, timecodeErrors, monotonicErrors, overlapErrors,
    mixedDelimiter,
    errors, summary
  };
}

// --- MacCaption (.mcc) time code rate label (importer-friendly enumerations)
function _timeCodeRateLabel(fps = 29.97, dropFrame = true) {
  const f = Number(fps);
  // Canonical DF labels — avoids importers that misread 30DF/60DF as 30/60
  if (dropFrame && Math.abs(f - 29.97) < 0.05) return '29.97DF';
  if (dropFrame && Math.abs(f - 59.94) < 0.10) return '59.94DF';
  // Exact well-known NDF labels
  if (Math.abs(f - 23.976) < 0.06) return '23.976';
  if (Math.abs(f - 24.000) < 0.06) return '24';
  if (Math.abs(f - 25.000) < 0.06) return '25';
  if (Math.abs(f - 29.970) < 0.06) return '29.97';
  if (Math.abs(f - 30.000) < 0.06) return '30';
  if (Math.abs(f - 50.000) < 0.06) return '50';
  if (Math.abs(f - 59.940) < 0.06) return '59.94';
  if (Math.abs(f - 60.000) < 0.06) return '60';
  // Fallback: print the numeric fps
  return String(fps);
}

function _frameRateCode(fps) {
  // Map arbitrary fps to the nearest legal CDP frame-rate code (no 29.97 default).
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 4; // safe default if caller supplied nonsense
  const table = [
    { code: 1, fps: 23.976 },
    { code: 2, fps: 24.000 },
    { code: 3, fps: 25.000 },
    { code: 4, fps: 29.970 },
    { code: 5, fps: 30.000 },
    { code: 6, fps: 50.000 },
    { code: 7, fps: 59.940 },
    { code: 8, fps: 60.000 }
  ];
  let best = table[0], err = Math.abs(f - table[0].fps);
  for (let i = 1; i < table.length; i++) {
    const e = Math.abs(f - table[i].fps);
    if (e < err) { err = e; best = table[i]; }
  }
  return best.code;
}

function _bcd(n) {
  return ((Math.floor(n / 10) & 0x0f) << 4) | (n % 10);
}

function _encodeSmpte12M(seconds, fps, dropFrame) {
  const tc = formatTimecode(seconds, dropFrame, fps, 'colon');
  const match = /^([0-9]{2}):([0-9]{2}):([0-9]{2})[:;]([0-9]{2})$/.exec(tc) || [];
  const H = Number(match[1] || 0);
  const M = Number(match[2] || 0);
  const S = Number(match[3] || 0);
  const F = Number(match[4] || 0);
  const frameByte = (_bcd(F) & 0x3f) | (dropFrame ? 0x40 : 0x00);
  return [0x71, frameByte & 0xff, _bcd(S), _bcd(M), _bcd(H), 0x00];
}

function _mccHeader({ fps, dropFrame }) {
  // Slightly fuller header improves importer compatibility
  const rate = _timeCodeRateLabel(fps, dropFrame);
  const headerLines = [
    'File Format=MacCaption_MCC V1.0',
    `Time Code Rate=${rate}`,
    `Drop Frame=${dropFrame ? 'True' : 'False'}`,
    'Caption Service=1',
    'Language=eng'
  ];
  headerLines.push('');
  return headerLines.join('\r\n') + '\r\n';
}

// Wrap a CDP (0x96 0x69 … 0x74 … + CDP checksum) in a SMPTE-291 ANC packet
// DID=0x61, SDID=0x01, DC=<len>, then UDW bytes (CDP), then 8-bit ANC checksum
function _wrapANC291(userDataBytes) {
  const DID = 0x61, SDID = 0x01;
  const dc  = userDataBytes.length & 0xff;
  const payload = [DID, SDID, dc, ...userDataBytes];
  const sum = payload.reduce((a, b) => (a + (b & 0xff)) & 0xff, 0);
  const cks = (256 - sum) & 0xff;
  return Uint8Array.from([...payload, cks]);
}

function _compressMccLineHex(hexBytesUpperSpaced) {
  // Input: "61 01 2A 96 69 ..." (UPPER hex with spaces)
  const tokens = hexBytesUpperSpaced.trim().split(/\s+/).map(t => t.toUpperCase());

  const out = [];
  for (let i = 0; i < tokens.length; ) {
    // Multi-byte patterns first
    const next2 = tokens.slice(i, i + 2).join(' ');
    const next3 = tokens.slice(i, i + 3).join(' ');

    // Telestream common macros (observed in the wild)
    if (next2 === '61 01') { out.push('T'); i += 2; continue; }      // ANC DID+SDID
    if (next2 === '96 69') { out.push('S'); i += 2; continue; }      // CDP id

    if (next3 === 'FB 80 80') { out.push('P'); i += 3; continue; }   // 608 F2 blank
    if (next3 === 'FC 80 80') { out.push('Q'); i += 3; continue; }   // 608 F1 blank
    if (next3 === 'FD 80 80') { out.push('R'); i += 3; continue; }   // 608 F2 blank (alt)

    // Run-length for FA 00 00 → G..O (1..9). Advance greedily.
    if (tokens[i] === 'FA' && tokens[i + 1] === '00' && tokens[i + 2] === '00') {
      let n = 0;
      while (tokens[i + 3 * n] === 'FA' &&
             tokens[i + 3 * n + 1] === '00' &&
             tokens[i + 3 * n + 2] === '00' &&
             n < 9) n++;
      out.push(String.fromCharCode('G'.charCodeAt(0) + (n - 1))); // G..O
      i += 3 * n;
      continue;
    }

    // Single 00 → Z
    if (tokens[i] === '00') { out.push('Z'); i += 1; continue; }

    // Default: keep hex byte
    out.push(tokens[i]);
    i += 1;
  }
  return out.join(' ');
}

function generateMCC(
  segments,
  {
    fps = 29.97,
    dropFrame: dropFrameOption = true,
    maxCharsPerLine = 42,
    maxLinesPerBlock = 2,
    includeSpeakerNames = false,
    sccOptions = {}
  } = {}
) {
  // _cea708 is guaranteed by the static require below.
  fps = Number(fps) || 29.97;
  // Prefix speakers when requested (parity with SCC path)
  const segs = Array.isArray(segments) ? segments.map(s => {
    const text = includeSpeakerNames && s?.speaker ? `${s.speaker}: ${s.text || ''}` : (s?.text || '');
    return { ...s, text };
  }) : [];

  const isDfRate = isDropFrameRate(fps);
  const dropFrame = !!dropFrameOption && isDfRate;
  const timeSource = sccOptions.timeSource || 'df-string'; // 'df-string'|'start'|'auto'
  const align = _normalizeAlignment(sccOptions.alignment) || 'left';
  const ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));
  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  const repeatControlCodes = sccOptions.repeatControlCodes !== false;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  const include608 = (sccOptions.mccInclude608 !== false); // default: include 608 CC1
  const useTelestreamCompression = sccOptions?.mccCompress === true;
  const lines = [];
  const header = _mccHeader({
    fps,
    dropFrame
  });
  lines.push(header);

  const frameRateCode = _frameRateCode(fps);
  let frameIndex = 0;
  let cc608Queue = []; // remaining 608 words to mux into upcoming frames

  const secondsForFrame = (frame) => framesToSeconds(frame, fps);

  const buildTimecodeBlock = (frame) => _encodeSmpte12M(secondsForFrame(frame), fps, dropFrame);

  const writeCdpLine = (frame, dtvccChunk) => {
    const tcBlock = buildTimecodeBlock(frame);
    // Capacity for 608 in this frame = 31 - 708 triplets
    const n708Triplets = Math.ceil((dtvccChunk.length || 0) / 2);
    const roomFor608 = Math.max(0, 31 - n708Triplets);
    const cc608Now = cc608Queue.splice(0, roomFor608);
    const cdp = _cea708.buildCdpForDtvcc({
      dtvccBytes: dtvccChunk,
      frameRateCode,
      sequenceCounter: frame & 0xffff,
      timecode: tcBlock,
      cc608WordsF1: cc608Now
    });
    const anc = _wrapANC291(Array.from(cdp));
    const tcRaw = formatTimecode(secondsForFrame(frame), dropFrame, fps, 'colon');
    const tc = tcRaw;
    const hex = Array.from(anc).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const payload = useTelestreamCompression ? _compressMccLineHex(hex) : hex;
    lines.push(`${tc}\t${payload}\r\n`);
  };

  const writeEmptyCdp = (frame) => writeCdpLine(frame, []);

  const startSecondsForSegment = (seg) => {
    if (!seg) return 0;
    if (timeSource === 'df-string' && seg.timecodes) {
      const pref = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      if (pref) {
        if (dropFrame && /;/.test(pref)) assertLegalDropFrameLabel(pref, fps);
        return parseTimeMs(pref, fps, null) / 1000;
      }
    }
    if (Number.isFinite(seg.start)) return seg.start;
    if (Number.isFinite(seg.msStart)) return seg.msStart / 1000;
    const fallback = seg.timecodes?.df?.start || seg.timecodes?.ndf?.start;
    return fallback ? (parseTimeMs(fallback, fps, null) / 1000) : 0;
  };

  const endSecondsForSegment = (seg, startSeconds) => {
    if (!seg) return startSeconds;
    if (Number.isFinite(seg.end)) return seg.end;
    if (Number.isFinite(seg.msEnd)) return seg.msEnd / 1000;
    let label = null;
    if (seg.timecodes) {
      label = (timeSource === 'df-string')
        ? (dropFrame
          ? (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end)
          : (seg.timecodes?.ndf?.end || seg.timecodes?.df?.end))
        : (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end);
    }
    return label ? (parseTimeMs(label, fps, null) / 1000) : startSeconds;
  };

  for (const seg of segs) {
    if (!seg || !seg.text || !seg.text.trim()) continue;
    const wrapped = _wrapLines608Compat(seg.text, maxCharsPerLine, maxLinesPerBlock);
    if (!wrapped.length) continue;

    const colCount = Math.min(42, Math.max(...wrapped.map(l => Math.min(42, l.length || 0))) || 32);
    const svcBytes = _cea708.buildServiceBytesForLines(wrapped, { justify: align, colCount });
    const svcBlocks = _cea708.chunkToServiceBlocks(svcBytes, 1);
    const dtvccPackets = _cea708.packDTVCC(svcBlocks);

    // Build a matching 608 CC1 payload (pop-on) and queue it for this segment
    cc608Queue = [];
    if (include608 && ch === 1) {
      const words608 = build608WordsForPopOn(wrapped, align, {
        padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
        repeatControlCodes, repeatPreambleCodes, extendedGlyphMap: sccOptions.extendedGlyphMap
      });
      cc608Queue = words608.map(w => parseInt(w, 16) & 0xFFFF);
    }

    const startSeconds = startSecondsForSegment(seg);
    const endSeconds = endSecondsForSegment(seg, startSeconds);

    let startFrame;
    let endFrame;
    if (timeSource === 'df-string' && seg?.timecodes) {
      const labelStart = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      const labelEnd = dropFrame
        ? (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end)
        : (seg.timecodes?.ndf?.end || seg.timecodes?.df?.end);
      const hasStartLabel = typeof labelStart === 'string' && labelStart.length > 0;
      const hasEndLabel = typeof labelEnd === 'string' && labelEnd.length > 0;
      if (dropFrame) {
        if (hasStartLabel && /;/.test(labelStart)) assertLegalDropFrameLabel(labelStart, fps);
        if (hasEndLabel && /;/.test(labelEnd))   assertLegalDropFrameLabel(labelEnd,   fps);
      }
      startFrame = hasStartLabel
        ? Math.max(0, framesFromTimecodeLabel(labelStart, fps))
        : Math.max(0, secondsToFrames(startSeconds, fps));
      const endFrameLabel = hasEndLabel ? labelEnd : (hasStartLabel ? labelStart : null);
      endFrame = endFrameLabel
        ? Math.max(startFrame, framesFromTimecodeLabel(endFrameLabel, fps))
        : Math.max(startFrame, secondsToFrames(endSeconds, fps));
    } else {
      startFrame = Math.max(0, secondsToFrames(startSeconds, fps));
      endFrame = Math.max(startFrame, secondsToFrames(endSeconds, fps));
    }
    const targetStartFrame = Math.max(frameIndex, startFrame);

    while (frameIndex < targetStartFrame) {
      // Allow empty frames to carry pending 608 words so we don't drop any
      writeEmptyCdp(frameIndex++);
    }

    if (dtvccPackets.length) {
      // One DTVCC packet per CDP line; never break inside a packet.
      // packDTVCC() now guarantees payload ≤ 62 bytes (31 triplets).
      for (const pkt of dtvccPackets) {
        const payload = Array.from(pkt);
        if (Math.ceil(payload.length / 2) > 31) {
          let cursor = 0;
          const MAX = 62;
          while (cursor < payload.length) {
            writeCdpLine(frameIndex++, payload.slice(cursor, cursor + MAX));
            cursor += MAX;
          }
        } else {
          writeCdpLine(frameIndex++, payload);
        }
      }
    }

    const targetEndFrame = Math.max(endFrame, frameIndex);
    while (frameIndex < targetEndFrame) {
      writeEmptyCdp(frameIndex++);
    }
  }

  return lines.join('');
}

module.exports = {
  // Builders + QC
  wrapTextAndClamp,
  encode608Line, encode608StyledLine, pacForRow, ctrl,
  computeCea608PlacementAudit,
  // Encoders
  generateSCC,
  // Verifier
  verifySCC,
  // CTA-708 / MCC
  generateDTVCC, verifyDTVCC,
  generateMCC
};

// ------------------------ CTA-708 glue (service blocks + DTVCC)
// Use a static require so bundlers (esbuild/webpack) don't drop the module.
const _cea708 = require('./cea708Encoder');

function _wrapLines608Compat(text, maxCharsPerLine, maxLinesPerBlock) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return wrapTextAndClamp(clean, maxCharsPerLine || 32, maxLinesPerBlock || 2);
}

function generateDTVCC(
  segments,
  {
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    sccOptions = {},
    returnPackets = true   // true: return array of packets per segment; false: return Buffer of all packets
  } = {}
) {
  // _cea708 is guaranteed by the static require above.
  if (!Array.isArray(segments) || !segments.length) return returnPackets ? [] : Buffer.alloc(0);

  const align = _normalizeAlignment(sccOptions.alignment) || 'left';
  const packetsOut = [];

  for (const seg of segments) {
    if (!seg) continue;
    let text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const lines = _wrapLines608Compat(text, maxCharsPerLine, maxLinesPerBlock);
    if (!lines.length) continue;

    const colCount = Math.min(42, Math.max(...lines.map(l => Math.min(42, l.length || 0))) || 32);
    const svcBytes = _cea708.buildServiceBytesForLines(lines, { justify: align, colCount });
    const svcBlocks = _cea708.chunkToServiceBlocks(svcBytes, /* service 1 */ 1);
    const dtvccPackets = _cea708.packDTVCC(svcBlocks);

    if (returnPackets) {
      packetsOut.push({ start: seg.start, end: seg.end, packets: dtvccPackets });
    } else {
      packetsOut.push(...dtvccPackets);
    }
  }

  if (returnPackets) return packetsOut;
  // Concatenate raw packets into a single Buffer
  const flat = packetsOut.reduce((acc, arr) => acc.concat(Array.from(arr)), []);
  return Buffer.from(flat);
}

// Pragmatic verifier: sizes/headers and command arities we generate
function verifyDTVCC(input, { maxErrors = 100 } = {}) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Array.isArray(input)
      ? Buffer.from(input.flat ? input.flat() : input)
      : Buffer.from(input || []);

  const errors = [];
  let pos = 0;
  let packets = 0, serviceBlocks = 0;

  function err(msg, at) { if (errors.length < maxErrors) errors.push({ pos: at ?? pos, msg }); }

  while (pos < buf.length) {
    // DTVCC packet header: [ seq(2) | packet_size(6) ]
    const header = buf[pos++];
    if (header == null) { err('EOF before DTVCC header'); break; }
    const pktSize = header & 0x3f;
    const seq = (header >> 6) & 0x03;
    if (pktSize === 0) { err('Packet size = 0', pos - 1); break; }
    if ((pos + pktSize) > buf.length) { err('Packet size exceeds buffer', pos - 1); break; }
    const end = pos + pktSize;
    packets++;

    // Parse service blocks inside this payload
    while (pos < end) {
      const sbHdr = buf[pos++];
      if (sbHdr == null) { err('EOF in service block header', pos - 1); break; }
      let service = (sbHdr & 0xe0) >> 5;
      let blockLen = sbHdr & 0x1f;
      if (service === 7) { // extended
        const ext = buf[pos++];
        if (ext == null) { err('EOF in extended service number', pos - 1); break; }
        service = 7 + (ext & 0x3f);
      }
      if ((pos + blockLen) > end) { err('Service block length exceeds packet', pos - 1); break; }

      // Shallow command scan (only the ones we emit)
      const start = pos, stop = pos + blockLen;
      while (pos < stop) {
        const b = buf[pos++];
        if (b == null) { err('EOF inside service block', pos - 1); break; }
        if (b === 0x03 || b === 0x0d) continue; // ETX/CR
        if (b >= 0x20 && b <= 0x7e) continue;   // G0 text
        // Commands we emit and their arg sizes:
        if (b >= 0x80 && b <= 0x87) { /* CWx */ continue; }
        else if (b === 0x88 || b === 0x89 || b === 0x8a || b === 0x8c) { // CLW/DSW/HDW/DLW +1
          if ((pos + 1) > stop) { err('Truncated window-bitmap param', pos - 1); break; }
          pos += 1;
        } else if (b === 0x92) { // SPL +2
          if ((pos + 2) > stop) { err('Truncated SPL params', pos - 1); break; }
          pos += 2;
        } else if (b === 0x97) { // SWA +4
          if ((pos + 4) > stop) { err('Truncated SWA params', pos - 1); break; }
          pos += 4;
        } else if (b >= 0x98 && b <= 0x9f) { // DFx +6
          if ((pos + 6) > stop) { err('Truncated DFx params', pos - 1); break; }
          pos += 6;
        } else {
          err(`Unexpected/unsupported byte 0x${b.toString(16)}`, pos - 1);
          // bail to avoid loops
          break;
        }
      }
      serviceBlocks++;
    }
    pos = end;
  }

  return {
    ok: errors.length === 0,
    packets, serviceBlocks, errors,
    summary: errors.length
      ? `FAIL — ${packets} packet(s), ${serviceBlocks} service block(s), ${errors.length} error(s)`
      : `OK — ${packets} packet(s), ${serviceBlocks} service block(s) • 0 errors`
  };
}
