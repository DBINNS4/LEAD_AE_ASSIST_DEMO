const { estimateSequentialWriteSpeedMiBps } = require('./diskBenchmark');

/**
 * ⚡ Estimates disk write speed by doing a small sequential write test (flushed to disk).
 * @param {string} destFolder - Destination directory to test
 * @param {number} sizeInMB - Size of the test file in MiB (binary "MB") for legacy reasons
 * @returns {Promise<number>} - Estimated speed in MiB/s (rounded down)
 */
async function estimateDiskWriteSpeed(destFolder, sizeInMB = 25) {
  const speed = await estimateSequentialWriteSpeedMiBps(destFolder, sizeInMB);
  return Math.floor(speed);
}

module.exports = {
  estimateDiskWriteSpeed
};
