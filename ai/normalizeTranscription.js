const { resolveFps } = require('../utils/ffmpeg');
const { toFrame } = require('../utils/timeUtils');
// ✅ Use centralized timecode core
const {
  formatTimecode,
  isDropFrameRate,
  parseTime: parseTimeMs
} = require('../utils/timeUtils');

function normalizeTranscriptionStructure(
  jsonData,
  fps = resolveFps(jsonData.filePath, jsonData.fps),
  dropFrame = false
) {
  if (!jsonData || !Array.isArray(jsonData.transcription)) return;

  jsonData.segments = jsonData.transcription.map((entry, idx) => {
    const tokens = Array.isArray(entry.tokens)
      ? entry.tokens.filter(t => t?.text && !t.text.startsWith('[_'))
      : [];

    const firstToken = tokens[0] || {};
    const lastToken = tokens.at(-1) || {};

    const msStart = firstToken.msStart ?? firstToken.offsets?.from ?? 0;
    const msEnd = lastToken.msEnd ?? lastToken.offsets?.to ?? 0;

    const floatStart = msStart / 1000;
    const floatEnd = msEnd / 1000;

    return {
      id: idx,
      start: floatStart,
      end: floatEnd,
      msStart,
      msEnd,
      // Frame counters here are "real frames" at `fps` (no DF label math).
      // Suitable for math/comparison; not equivalent to ;FF timecode labels.
      frameStart: Math.floor(toFrame(floatStart, fps)),
      frameEnd: Math.floor(toFrame(floatEnd, fps)),
      timecodeStart: formatTimecode(floatStart, dropFrame, fps),
      timecodeEnd: formatTimecode(floatEnd, dropFrame, fps),
      text: entry.text,
      speaker: entry.speaker || 'SPEAKER',
      confidence: entry.confidence || null,
      tokens: entry.tokens || []
    };
  });

  delete jsonData.transcription;
}

function resolveSeconds(value, fps = 30, dropFrame = false) {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return 0;
    if (/^-?\d+(?:\.\d+)?$/.test(str)) {
      return parseFloat(str);
    }
    try {
      // parseTimeMs returns milliseconds (DF-aware); pass through here.
      const ms = parseTimeMs(str, fps, /* auto */ null);
      if (typeof ms === 'number' && !Number.isNaN(ms)) {
        return ms / 1000;
      }
    } catch {}
  }

  if (value && typeof value === 'object') {
    if (typeof value.ms === 'number') {
      return value.ms / 1000;
    }
    if (typeof value.from === 'number') {
      return value.from / 1000;
    }
    if (typeof value.start === 'number') {
      return value.start;
    }
  }

  return 0;
}

function segmentsToCueList(segments = [], fps = 30, dropFrame = false) {
  return segments.map((segment, idx) => {
    const start = resolveSeconds(
      segment.start ?? (typeof segment.msStart === 'number' ? segment.msStart / 1000 : segment.timecodeStart),
      fps,
      dropFrame
    );
    const end = resolveSeconds(
      segment.end ?? (typeof segment.msEnd === 'number' ? segment.msEnd / 1000 : segment.timecodeEnd),
      fps,
      dropFrame
    );
    const startMs = Math.round(Math.max(0, start) * 1000);
    const endMs = Math.round(Math.max(end, start) * 1000);
    const rawLines = Array.isArray(segment.lines)
      ? segment.lines.map(line => String(line || '')).filter(Boolean)
      : null;
    const textFromLines = rawLines && rawLines.length ? rawLines.join('\n') : null;
    return {
      id: segment.id ?? idx,
      start,
      end,
      startMs,
      endMs,
      text: segment.text ?? textFromLines ?? '',
      speaker: segment.speaker || segment.speakerLabel || null,
      lines: rawLines && rawLines.length ? rawLines : undefined,
      // preserve manual placements
      sccPlacement: segment.sccPlacement ? { ...segment.sccPlacement } : undefined
    };
  });
}

function cueListToSegments(cues = [], fps = 30, dropFrame = false) {
  return cues.map((cue, idx) => {
    const start = resolveSeconds(cue.start ?? cue.timecodeStart, fps, dropFrame);
    const end = resolveSeconds(cue.end ?? cue.timecodeEnd, fps, dropFrame);
    const safeStart = Math.max(0, start);
    const safeEnd = Math.max(end, safeStart);
    const rawLines = Array.isArray(cue.lines)
      ? cue.lines.map(line => String(line || '')).filter(Boolean)
      : null;
    const textFromLines = rawLines && rawLines.length ? rawLines.join('\n') : null;
    return {
      id: cue.id ?? idx,
      start: safeStart,
      end: safeEnd,
      msStart: Math.round(safeStart * 1000),
      msEnd: Math.round(safeEnd * 1000),
      // "Real frame" counters (see note above) — not DF label indices.
      frameStart: Math.floor(toFrame(safeStart, fps)),
      frameEnd: Math.floor(toFrame(safeEnd, fps)),
      text: cue.text ?? textFromLines ?? '',
      lines: rawLines && rawLines.length ? rawLines : undefined,
      speaker: cue.speaker || null,
      // carry placement hints back to segments
      sccPlacement: cue.sccPlacement ? { ...cue.sccPlacement } : undefined
    };
  });
}

module.exports = {
  normalizeTranscriptionStructure,
  segmentsToCueList,
  cueListToSegments,
  // Preserve public API while using canonical implementation
  formatTimecode: formatTimecode,
  isDropFrameRate
};
