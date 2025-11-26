const fs = require('fs');
const path = require('path');

/**
 * ⚡ Estimates disk write speed by writing a temporary file
 * @param {string} destFolder - Destination directory to test
 * @param {number} sizeInMB - Size of the test file in megabytes
 * @returns {Promise<number>} - Estimated speed in MB/s
 */
function estimateDiskWriteSpeed(destFolder, sizeInMB = 25) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(sizeInMB * 1024 * 1024, 0x0);
    const tempPath = path.join(destFolder, `.__speedtest_${Date.now()}`);

    const start = Date.now();

    fs.writeFile(tempPath, buffer, (err) => {
      const end = Date.now();
      const elapsedSeconds = (end - start) / 1000;

      // Cleanup the test file
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }

      if (err) return reject(err);
      if (elapsedSeconds === 0) return resolve(9999); // absurd speed fallback

        const speedMBps = sizeInMB / elapsedSeconds;
        resolve(Math.floor(speedMBps));
    });
  });
}

module.exports = {
  estimateDiskWriteSpeed
};
