'use strict';

const { normalizeTranscriptionStructure } = require('./normalizeTranscription');
const { wrapToProfessionalFormat } = require('./whisperFormatter');

/**
 * Unified transcription prep pipeline.
 * @param {object} jsonData
 * @param {string} filePath
 * @param {object} config
 * @param {object} opts
 * @returns {object}
 */
async function prepareTranscription(jsonData, filePath, config, opts = {}) {
  const diarized = Array.isArray(opts.diarized) ? opts.diarized : [];

  if (!Array.isArray(jsonData?.segments)) {
    const clone = JSON.parse(JSON.stringify(jsonData || {}));
    normalizeTranscriptionStructure(clone, Number(config?.fps) || 30, !!config?.dropFrame);
    jsonData = clone;
  }
  if (!Array.isArray(jsonData?.segments)) {
    jsonData.segments = [];
  }

  const missingSpeakers = jsonData.segments.every(seg => !seg || !seg.speaker);
  if (missingSpeakers && diarized.length) {
    for (const seg of jsonData.segments) {
      if (!seg || typeof seg.start !== 'number') continue;
      const match = diarized.find(d => seg.start >= d.start && seg.start < d.end);
      if (match?.speaker) {
        seg.speaker = match.speaker;
      }
    }
  }

  const wrapped = wrapToProfessionalFormat(jsonData, config, filePath);
  return wrapped;
}

module.exports = { prepareTranscription };
