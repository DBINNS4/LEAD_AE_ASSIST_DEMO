'use strict';

// Minimal CTA-708 builder focused on: one bottom-anchored window (id=0),
// pop-on semantics, and service-1 DTVCC packets.
//
// Command codes + arities follow CTA-708 (C1/C0/G0) basics:
//   CWx(0x80-0x87), CLW(0x88)+mask, DSW(0x89)+mask, HDW(0x8A)+mask, DLW(0x8C)+mask
//   SPA(0x90)+3, SPC(0x91)+4, SPL(0x92)+2, SWA(0x97)+4, DFx(0x98-0x9F)+6, CR(0x0D), ETX(0x03)

const C0 = { ETX: 0x03, CR: 0x0d };
const C1 = {
  CW0: 0x80, CLW: 0x88, DSW: 0x89, HDW: 0x8a, DLW: 0x8c,
  SPA: 0x90, SPC: 0x91, SPL: 0x92, SWA: 0x97, DF0: 0x98
};

function _sanitize708(text) {
  // Keep it simple/ASCII for parity with 608 path; you can widen later.
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    out += (cp >= 0x20 && cp <= 0x7e) ? ch : ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function encodeG0(text) {
  const t = _sanitize708(text);
  const bytes = [];
  for (const ch of t) {
    const c = ch.codePointAt(0);
    // Map ASCII printable to G0; squash DEL
    bytes.push((c >= 0x20 && c <= 0x7e) ? c : 0x20);
  }
  return bytes;
}

// ---- Window builders -------------------------------------------------------
// DefineWindow0 (DF0 0x98) + 6 bytes (see CTA-708)
function buildDefineWindow0({ rowCount = 2, colCount = 32, rel = true, anchorV = 90, anchorH = 50 } = {}) {
  const PRIOR = 4;     // mid priority (0..7)
  const C = 1, R = 1;  // lock cols/rows for stable behavior
  const V = 0;         // not visible at create
  const b1 = ((V & 1) << 5) | ((R & 1) << 4) | ((C & 1) << 3) | (PRIOR & 0x07);
  const P  = rel ? 1 : 0;
  const b2 = ((P & 1) << 7) | (Math.max(0, Math.min(rel ? 99 : 74, anchorV)) & 0x7f);
  const b3 = Math.max(0, Math.min(rel ? 99 : 209, anchorH)) & 0xff;
  const ANCHOR_ID = 7; // LOWER_CENTER
  const rowsNibble = Math.max(0, Math.min(15, (rowCount | 0) - 1));
  const b4 = ((ANCHOR_ID & 0x0f) << 4) | (rowsNibble & 0x0f);
  const cols6 = Math.max(1, Math.min(63, colCount | 0));
  const b5 = cols6 & 0x3f; // top two bits 00
  const WNSTY = 1, PNSTY = 1;
  const b6 = ((WNSTY & 0x07) << 3) | (PNSTY & 0x07);
  return [C1.DF0, b1, b2, b3, b4, b5, b6];
}

// SetWindowAttributes (justify + defaults). 4 param bytes after 0x97.
// Justify mapping for LTR: LEFT=0, RIGHT=1, CENTER=2, FULL=3
function buildSWA({ justify = 'left' } = {}) {
  const JST = (justify === 'center') ? 2 : (justify === 'right' ? 1 : 0);
  const FOP = 2; // translucent fill
  const F_R = 0, F_G = 0, F_B = 0; // black fill
  const BTP = 0; // border type: none
  const B_R = 0, B_G = 0, B_B = 0;
  const W = 0;   // wordwrap off (708E deprecates WW=1 use)
  const PRD = 0; // LTR
  const SCD = 2; // top-to-bottom
  const EFD = 0, DEF = 0, EFT_SPD = 0; // snap, no effect, no speed
  const b1 = ((FOP & 3) << 6) | ((F_R & 3) << 4) | ((F_G & 3) << 2) | (F_B & 3);
  const b2 = ((BTP & 3) << 6) | ((B_R & 3) << 4) | ((B_G & 3) << 2) | (B_B & 3);
  const b3 = ((W & 1) << 7) | (((BTP >> 2) & 1) << 6) | ((PRD & 3) << 4) | ((SCD & 3) << 2) | (JST & 3);
  const b4 = ((EFT_SPD & 3) << 6) | ((EFD & 3) << 4) | ((DEF & 3) << 2);
  return [C1.SWA, b1, b2, b3, b4];
}

// SetPenLocation(row, col)
function buildSPL(row, col) {
  const r = Math.max(0, Math.min(15, row | 0));
  const c = Math.max(0, Math.min(31, col | 0));
  return [C1.SPL, r & 0x0f, c & 0x1f];
}

// ---- Service block assembly ------------------------------------------------
function buildServiceBytesForLines(lines, { justify = 'left', colCount = 32 } = {}) {
  const rc = Math.max(1, Math.min(15, (lines?.length || 1)));
  const bytes = [];
  // Select window 0, hide/clear, (re)define, set attrs
  bytes.push(C1.CW0);
  bytes.push(C1.HDW, 0x01);
  bytes.push(C1.CLW, 0x01);
  bytes.push(...buildDefineWindow0({ rowCount: rc, colCount, rel: true, anchorV: 90, anchorH: 50 }));
  bytes.push(...buildSWA({ justify }));
  // Write text with CR between wrapped rows; ETX to flush.
  // (Pen location defaults to window origin; we rely on rowCount + CR.)
  const last = (lines || []).length - 1;
  (lines || []).forEach((line, i) => {
    bytes.push(...encodeG0(line || ''));
    if (i !== last) bytes.push(C0.CR);
  });
  bytes.push(C0.ETX);
  // Display -> pop-on effect for the freshly written hidden/cleared window
  bytes.push(C1.DSW, 0x01);
  return bytes;
}

// Split service data into <=31-byte service blocks, respecting command arities.
// We only emit a small subset of 708 commands; map them to their payload sizes.
function chunkToServiceBlocks(serviceBytes, serviceNumber = 1) {
  const out = [];
  let i = 0;
  while (i < serviceBytes.length) {
    const start = i;
    let size = 0;
    while (i < serviceBytes.length) {
      const b = serviceBytes[i];
      // Default = 1 (G0 text or ETX/CR)
      let tokLen = 1;
      if (b >= 0x80 && b <= 0x87) tokLen = 1;         // CWx
      else if (b === 0x88 || b === 0x89 || b === 0x8a || b === 0x8c) tokLen = 2; // CLW/DSW/HDW/DLW +1
      else if (b === 0x90 || b === 0x91) tokLen = 5;  // SPA/SPC +4
      else if (b === 0x92) tokLen = 3;                // SPL +2
      else if (b === 0x97) tokLen = 5;                // SWA +4
      else if (b >= 0x98 && b <= 0x9f) tokLen = 7;    // DFx +6
      // If adding this token would exceed 31, flush the block first.
      if (size + tokLen > 31) break;
      i += tokLen;
      size += tokLen;
      if (size === 31) break;
    }
    const block = serviceBytes.slice(start, start + size);
    const hdr = ((serviceNumber & 0x07) << 5) | (block.length & 0x1f);
    out.push([hdr, ...block]);
  }
  return out;
}

// Pack service blocks into DTVCC packets (seq: 0..3).
// To satisfy CDP’s 31-triplet cap, keep payload ≤ 62 bytes (31 * 2).
function packDTVCC(serviceBlocks) {
  const packets = [];
  let seq = 0;
  let cursor = [];
  let size = 0;
  const flush = () => {
    if (!cursor.length) return;
    const header = ((seq & 0x03) << 6) | (size & 0x3f);
    packets.push(Uint8Array.from([header, ...cursor]));
    cursor = []; size = 0; seq = (seq + 1) & 0x03;
  };
  for (const sb of serviceBlocks) {
    if ((size + sb.length) > 62) flush();
    cursor.push(...sb);
    size += sb.length;
  }
  flush();
  return packets;
}

// Build cc_data triplets for 708: one triplet per two payload bytes.
// cc_valid is bit 2; cc_type is bits 1..0. 2/3 = 708; 0/1 = 608.
function buildCcDataTriplets(dtvccBytes) {
  const data = Array.isArray(dtvccBytes)
    ? dtvccBytes.map(b => b & 0xff)
    : Array.from(dtvccBytes || [], b => b & 0xff);
  const triplets = [];
  for (let i = 0; i < data.length; i += 2) {
    const c1 = data[i] ?? 0x00;
    const c2 = data[i + 1] ?? 0x00;
    // 0xFE = 1111 1110b → cc_valid=1, cc_type=2 (CEA-708)
    triplets.push([0xFE, c1 & 0xff, c2 & 0xff]);
  }
  return triplets;
}

// Build cc_data triplets for 608 (field 1 by default) from 16-bit words (hex or number).
function buildCcDataTriplets608(words = [], field = 1) {
  const hdr = (field === 2) ? 0xFD : 0xFC; // 0xFC=608 F1, 0xFD=608 F2
  const out = [];
  for (const w of words) {
    const v = typeof w === 'string' ? parseInt(w, 16) : (w | 0);
    const hi = (v >> 8) & 0xff, lo = v & 0xff;
    out.push([hdr, hi, lo]);
  }
  return out;
}

function buildCdpForDtvcc({
  dtvccBytes = [],
  cc608WordsF1 = [],
  frameRateCode = 4,
  sequenceCounter = 0,       // use as a 16-bit seq counter for both header/footer
  timecode = null,           // e.g. [0x71, frameBCD, secBCD, minBCD, hourBCD, 0x00]
  includeChecksum = true,
  maxTriplets = 31
} = {}) {
  // CDP start + placeholder length
  const bytes = [0x96, 0x69, 0x00];

  // CDP header
  const cdpRateRes = ((frameRateCode & 0x0f) << 4) | 0x0f; // frame rate code + reserved bits set
  bytes.push(cdpRateRes);

  // Flags: ccdata_present=1, caption_service_active=1 (0x43 is widely accepted)
  bytes.push(0x43);

  // Header sequence counter (big-endian, 2 bytes)
  bytes.push((sequenceCounter >> 8) & 0xff, sequenceCounter & 0xff);

  // Optional SMPTE 12M timecode section (0x71 + 5 bytes). Your caller already builds it.
  if (Array.isArray(timecode) && timecode.length === 6 && timecode[0] === 0x71) {
    bytes.push(...timecode);
  }

  // ---- CC Data section ----
  // Mix in-band CEA-608 words (F1) first, then DTVCC (708) bytes; cap to 31 triplets.
  const t608 = buildCcDataTriplets608(cc608WordsF1, 1); // [ [hdr,hi,lo], ... ]
  const t708 = buildCcDataTriplets(dtvccBytes);         // [ [0xFE,b1,b2], ... ]
  const ccTriplets = [...t608, ...t708].slice(0, Math.min(maxTriplets, t608.length + t708.length));
  const ccCount = Math.min(0x1f, ccTriplets.length);

  bytes.push(0x72);                     // CC_DATA section id
  bytes.push(0xE0 | (ccCount & 0x1f));  // marker '111' + 5-bit count

  for (let i = 0; i < ccCount; i++) {
    const [b0, b1, b2] = ccTriplets[i];
    bytes.push(b0 & 0xff, b1 & 0xff, b2 & 0xff);
  }

  // Footer: 0x74 + footer sequence (big-endian, 2 bytes)
  bytes.push(0x74, (sequenceCounter >> 8) & 0xff, sequenceCounter & 0xff);

  // cdp_length is the number of bytes AFTER the length field (i.e., from cdpRateRes to checksum).
  // We assign it after we optionally append the checksum.
  if (includeChecksum) {
    // Two's complement so sum from 0x96 through checksum == 0 (mod 256)
    const sum = bytes.reduce((acc, b) => (acc + (b & 0xff)) & 0xff, 0);
    const checksum = (256 - sum) & 0xff;
    bytes.push(checksum);
  }

  const cdpLength = (bytes.length - 3) & 0xff;
  bytes[2] = cdpLength;

  return Uint8Array.from(bytes);
}

module.exports = {
  encodeG0,
  buildDefineWindow0,
  buildSWA,
  buildSPL,
  buildServiceBytesForLines,
  chunkToServiceBlocks,
  packDTVCC,
  buildCdpForDtvcc,
  buildCcDataTriplets,
  buildCcDataTriplets608
};

// Why these bit layouts and sizes? They follow the command table and field diagrams
// in CTA-708 (C1 command codes, SWA 4-byte parameter block, DFx 6-byte parameter block,
// SPL 2-byte row/col) and the service-block / packet header bit allocations.
