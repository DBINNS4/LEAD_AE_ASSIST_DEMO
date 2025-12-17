const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const fsp = fs.promises;

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * BYTES_PER_MIB; // 8 MiB

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore
  }
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function writeSequential(filePath, fileSizeBytes, { chunkSizeBytes = DEFAULT_CHUNK_SIZE, throwIfCancelled } = {}) {
  let fh;
  const chunkSize = Math.min(chunkSizeBytes, fileSizeBytes);
  const wbuf = Buffer.alloc(chunkSize, 0xaa);

  const start = performance.now();
  try {
    fh = await fsp.open(filePath, 'w');

    let offset = 0;
    while (offset < fileSizeBytes) {
      if ((offset % (64 * BYTES_PER_MIB)) === 0) throwIfCancelled?.();

      const remaining = fileSizeBytes - offset;
      const chunk = remaining < wbuf.length ? wbuf.subarray(0, remaining) : wbuf;
      const { bytesWritten } = await fh.write(chunk, 0, chunk.length, offset);
      if (bytesWritten <= 0) throw new Error('Write failed (0 bytes written)');
      offset += bytesWritten;
    }

    // ✅ Force bytes to stable storage (prevents page-cache / write-back illusions)
    if (typeof fh.datasync === 'function') await fh.datasync();
    else await fh.sync();
  } finally {
    try {
      await fh?.close();
    } catch {
      // ignore
    }
  }
  const end = performance.now();

  return (fileSizeBytes / BYTES_PER_MIB) / ((end - start) / 1000); // MiB/s
}

async function readSequential(filePath, fileSizeBytes, { chunkSizeBytes = DEFAULT_CHUNK_SIZE, throwIfCancelled } = {}) {
  let fh;
  const chunkSize = Math.min(chunkSizeBytes, fileSizeBytes);
  const rbuf = Buffer.alloc(chunkSize);

  const start = performance.now();
  try {
    fh = await fsp.open(filePath, 'r');

    let offset = 0;
    while (offset < fileSizeBytes) {
      if ((offset % (64 * BYTES_PER_MIB)) === 0) throwIfCancelled?.();

      const remaining = fileSizeBytes - offset;
      const toRead = Math.min(rbuf.length, remaining);
      const { bytesRead } = await fh.read(rbuf, 0, toRead, offset);
      if (bytesRead <= 0) throw new Error('Read failed/EOF before expected size');
      offset += bytesRead;
    }
  } finally {
    try {
      await fh?.close();
    } catch {
      // ignore
    }
  }
  const end = performance.now();

  return (fileSizeBytes / BYTES_PER_MIB) / ((end - start) / 1000); // MiB/s
}

/**
 * Runs a sequential write + read benchmark in a target folder.
 * Notes:
 *  - Writes are flushed to stable storage (datasync/sync).
 *  - Reads can still be influenced by OS cache; staggering reads helps avoid the worst-case "immediate cached read."
 */
async function runSequentialDriveTest({
  drivePath,
  testSizeMiB = 1024,
  iterations = 5,
  senderTag = '0',
  onProgressBytes,
  throwIfCancelled
} = {}) {
  if (!drivePath) throw new Error('Missing drivePath');

  const sizeMiB = clampInt(testSizeMiB, 1, 2048);
  const fileSizeBytes = sizeMiB * BYTES_PER_MIB;

  const tmpFiles = [
    path.join(drivePath, `lead_speedtest_${senderTag}_seq_a.tmp`),
    path.join(drivePath, `lead_speedtest_${senderTag}_seq_b.tmp`)
  ];

  const writeSpeeds = [];
  const readSpeeds = [];

  let prevFile = null;

  try {
    for (let run = 0; run < iterations; run++) {
      throwIfCancelled?.();

      const curFile = tmpFiles[run % tmpFiles.length];
      await safeUnlink(curFile);

      const w = await writeSequential(curFile, fileSizeBytes, { throwIfCancelled });
      writeSpeeds.push(w);
      onProgressBytes?.(fileSizeBytes);

      // Stagger reads: read the previous file after writing the next one
      if (prevFile) {
        const r = await readSequential(prevFile, fileSizeBytes, { throwIfCancelled });
        readSpeeds.push(r);
        onProgressBytes?.(fileSizeBytes);
        await safeUnlink(prevFile);
      }

      prevFile = curFile;
    }

    // Final read to balance phases
    if (prevFile) {
      const r = await readSequential(prevFile, fileSizeBytes, { throwIfCancelled });
      readSpeeds.push(r);
      onProgressBytes?.(fileSizeBytes);
      await safeUnlink(prevFile);
    }
  } finally {
    // Best-effort cleanup
    await Promise.all(tmpFiles.map(safeUnlink));
  }

  // Drop warm-up run (first measurement)
  writeSpeeds.shift();
  readSpeeds.shift();

  return {
    success: true,
    write: avg(writeSpeeds).toFixed(1),
    writeMin: Math.min(...writeSpeeds).toFixed(1),
    writeMax: Math.max(...writeSpeeds).toFixed(1),
    read: avg(readSpeeds).toFixed(1),
    readMin: Math.min(...readSpeeds).toFixed(1),
    readMax: Math.max(...readSpeeds).toFixed(1)
  };
}

async function estimateSequentialWriteSpeedMiBps(destFolder, sizeMiB = 25, { throwIfCancelled } = {}) {
  if (!destFolder) throw new Error('Missing destFolder');

  const testMiB = clampInt(sizeMiB, 1, 256);
  const fileSizeBytes = testMiB * BYTES_PER_MIB;
  const tmpFile = path.join(destFolder, `.__speedtest_${process.pid}_${Date.now()}.tmp`);

  try {
    return await writeSequential(tmpFile, fileSizeBytes, { throwIfCancelled });
  } finally {
    await safeUnlink(tmpFile);
  }
}

module.exports = {
  runSequentialDriveTest,
  estimateSequentialWriteSpeedMiBps
};
