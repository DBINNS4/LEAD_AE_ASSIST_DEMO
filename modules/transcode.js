const ProgressManager = require('../utils/progressManager');
const { spawn, execFile } = require('child_process');
const electron = require('electron');
const { bindProgressManager } = require('../progressBridge');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BrowserWindow = electron.BrowserWindow || {};
const app = electron.app || null;
const isPackaged = app?.isPackaged ?? false;

const { ffmpegPath, ffprobePath } = require('../utils/ffmpeg');

const { detectBestGPUEncoder } = require('../utils/gpuEncoder');

const { sendLogMessage, writeLogToFile, archiveLog, createJobLogger, writeJobLogToFile } = require('./logUtils');
const { runWithConcurrencyLimit } = require('./fileUtils');
const { ensureUserDataSubdir } = require('../utils/appPaths');
const { runSsimPsNrCheck } = require('../src/ff/qualityCheck');
const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';

function getJobFilePath() {
  return path.join(ensureUserDataSubdir('logs'), 'job-queue.json');
}

function removeJobFile() {
  const jobFile = getJobFilePath();
  try {
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
  } catch {
    // ignore cleanup errors
  }
}

const estimatedSizeRatioMap = {
  // ProRes family
  'prores_proxy': 0.7,
  'prores_lt': 0.85,
  'prores_422': 1.2,
  'prores_422hq': 1.4,
  'prores_4444': 1.6,
  'prores_4444xq': 1.8,


  // Web + Delivery
  'h264_auto_gpu': 0.4,
  'h264': 0.4,
  'h265': 0.3,
  'vp9': 0.35,
  'av1': 0.3,

  // Broadcast / Mastering
  'xdcam_hd35': 0.9,
  'xdcam_hd50': 1.1,
  'xavc_l_1080p': 1.2,
  'xavc_i_4k': 1.5,
  'xavc_s': 0.5,
  'jpeg2000': 2.0,

  // Archival / Legacy
  'ffv1': 1.0,
  'mjpeg': 1.5,
  'qtrle': 2.0,
  'uncompressed_yuv': 2.2,
  'uncompressed_rgb': 2.5,

  // Image Sequences
  'png_sequence': 1.2,
  'tiff_sequence': 1.4,
  'exr_sequence': 2.0,
  'tga_sequence': 1.3,
  'image_sequence': 1.3
};

let transcodeJobLogger = null;
const sendTranscodeLog = (msg, isError = false, detail = '', fileId = '') => {
  sendLogMessage('transcode', msg, detail, isError, fileId);
  if (transcodeJobLogger) {
    const meta = {};
    if (detail) meta.detail = detail;
    if (fileId) meta.fileId = fileId;
    transcodeJobLogger[isError ? 'error' : 'info'](msg, meta);
  }
};

const getFFprobeData = async (filePath) => {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames,nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath
    ], (err, stdout) => {
      if (err) {
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout.toString());
        const stream = data.streams && data.streams[0] ? data.streams[0] : {};
        const frames = parseInt(stream.nb_read_frames || stream.nb_frames || 0, 10);
        const duration = parseFloat(data.format?.duration || 0);
        const width = parseInt(stream.width || 0, 10);
        const height = parseInt(stream.height || 0, 10);
        resolve({ frames, duration, width, height });
      } catch {
        resolve(null);
      }
    });
  });
};

function buildOutputName(inputPath, index, opts) {
  const { containerFormat, appendSeq = false, isBatch } = opts;
  const base = path.basename(inputPath, path.extname(inputPath));
  const safeName = base.replace(/[^\w\d_-]+/g, '_');
  const seq = String(index).padStart(3, '0');
  const useSeq = appendSeq || isBatch;
  const ext = containerFormat === 'image_sequence' ? '' : `.${containerFormat}`;
  return useSeq ? `${safeName}_${seq}${ext}` : `${safeName}${ext}`;
}

// ✅ Import cancel helpers
const { cancelIngest, createCancelToken } = require('./cancelUtils');

// 🛑 Track all running FFmpeg processes
const currentProcesses = new Set();

async function runTranscode(config) {
  if (!config.jobId) {
    config.jobId = `transcode-${Date.now()}`;
  }

  if (process.env.NODE_ENV === 'test') {
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId || 1,
        panel: 'transcode',
        percent: 100,
        completed: config.inputFiles?.length || 1,
        total: config.inputFiles?.length || 1
      });
    }
    const msg = `🚀 Watch Mode transcode triggered for ${config.inputFiles?.length || 0} file(s)`;
  return Promise.resolve({ success: true, cancelled: false, log: [msg], logText: msg });
 }

  return new Promise((resolve) => {
    (async () => {
      if (!config.signal) config.signal = createCancelToken();
      const structuredLog = [];
      transcodeJobLogger = createJobLogger({
        panel: 'transcode',
        jobId: config.jobId,
        stage: 'init',
        collector: structuredLog
      });
      let archivePath = null;
      let structuredPath = null;
    const {
      inputFiles,
      outputFormat,
      containerFormat,
      outputFolder,
      resolution,
      frameRate,
      audioCodec,
      channels,
      pixelFormat,
      colorRange,
      fieldOrder,
      lutPath,
      crf,
      sampleRate,
      audioBitrate,
      normalizeAudio,
      audioDelay,
      verification,

      enableN8N,
      n8nUrl,
      watchMode,
      appendSeq = false,
      audioOnly = false
    } = config;

    const durationMap = new Map();
    let totalDuration = 0;
    await Promise.all(inputFiles.map(async file => {
      const meta = await getFFprobeData(file);
      const durSec = meta?.duration ? parseFloat(meta.duration) : 0;
      const durMs = Math.floor(durSec * 1000);
      durationMap.set(file, durMs);
      totalDuration += durMs;
    }));

    const progressManager = new ProgressManager(totalDuration, 250, 'time');
    progressManager.setTotalFiles(inputFiles.length);

    // 🔗 Canonical progress wiring (overall/file/eta) → single contract
    const unbindProgress = bindProgressManager(
      progressManager, { id: config.jobId, panel: 'transcode', stage: 'transcode' }
    );

    // ✅ Add this:
    const audioChannelMap = {
      mono: '1',
      stereo: '2',
      '5.1': '6',
      '7.1': '8'
    };
     const channelCount = audioChannelMap[channels];

    const logs = [];

    transcodeJobLogger.setStage('transcode');

    if (enableN8N) {
      logs.push(`🌐 Webhook enabled${n8nUrl ? ` → ${n8nUrl}` : ''}`);
      sendTranscodeLog(`🌐 Webhook enabled${n8nUrl ? ` → ${n8nUrl}` : ''}`);
    }

    const isWatch = watchMode || !!config.watchFolder;
    if (isWatch) {
      const msg = `🚀 Watch Mode transcode triggered for ${inputFiles.length} file(s)`;
      logs.push(msg);
      sendTranscodeLog(msg);
    } else {
      const msg = `🚀 Transcoding ${inputFiles.length} file(s)`;
      logs.push(msg);
      sendTranscodeLog(msg);
    }
    const threadCount = 1;

    const isBatch = inputFiles.length > 1;

    let completed = 0;
    let failed = 0;
    let total = inputFiles.length;

    function buildCommand(inputPath, outputPath, progressFile) {
      const progressPath = process.platform === 'win32'
        ? 'file:' + progressFile.replace(/\\/g, '/')
        : progressFile;
      const args = ['-nostats', '-loglevel', 'verbose', '-progress', progressPath, '-y', '-i', inputPath];

      function escapeForFfmpegFilter(p) {
        let s = String(p).replace(/\\/g, '/').replace(/'/g, "\\'");
        if (process.platform === 'win32') s = s.replace(/^([A-Za-z]):/, '$1\\:');
        return s;
      }

      const delayMs = audioDelay != null ? parseFloat(audioDelay) : NaN;

      if (!audioOnly) {
        // Video options
        if (resolution && resolution !== 'match') args.push('-s', resolution);
        if (colorRange) { const r = colorRange === 'full' ? 'pc' : colorRange === 'limited' ? 'tv' : colorRange; args.push('-color_range', r); }
        if (frameRate && frameRate !== 'match') args.push('-r', frameRate);
        if (pixelFormat && pixelFormat !== 'default') args.push('-pix_fmt', pixelFormat);
        if (fieldOrder && fieldOrder !== 'progressive') {
          args.push('-flags', '+ilme');
          const topFieldMap = {
            interlaced_tff: '1',
            interlaced_bff: '0',
            tff: '1',
            bff: '0'
          };
          args.push('-top', topFieldMap[fieldOrder] || '1');
        }
        if (crf) args.push('-crf', crf);
      } else {
        args.push('-vn');
      }

      // Audio options
      const audioEncoder = audioCodec?.trim() || 'aac'; // Default to AAC if blank
      const audioEncoderLower = audioEncoder.toLowerCase();
      if (audioEncoderLower !== 'copy') args.push('-c:a', audioEncoder);

      if (channels && channels !== 'preserve') {
        args.push('-ac', channelCount || '2');
      }
      if (sampleRate && sampleRate !== 'default') args.push('-ar', sampleRate);
      if (audioBitrate && audioEncoderLower !== 'copy' && !audioEncoderLower.startsWith('pcm_')) {
        args.push('-b:a', `${audioBitrate}k`);
      }
      const audioFilters = [];
      if (normalizeAudio && audioEncoderLower !== 'copy') {
        audioFilters.push('loudnorm');
      }

      if (!Number.isNaN(delayMs) && Number.isFinite(delayMs) && delayMs !== 0) {
        if (delayMs < 0) {
          logs.push('⚠️ Negative audio delay values are not supported; ignoring.');
          sendTranscodeLog('⚠️ Negative audio delay values are not supported; ignoring.');
        } else {
          const safeDelay = Math.round(delayMs);
          if (safeDelay > 0) {
            if (audioEncoderLower === 'copy') {
              logs.push('⚠️ Audio delay requested but audio codec is set to copy; ignoring delay.');
              sendTranscodeLog('⚠️ Audio delay requested but audio codec is set to copy; ignoring delay.');
            } else {
              audioFilters.push(`adelay=${safeDelay}|${safeDelay}:all=1`);
            }
          }
        }
      }

      if (audioFilters.length > 0) {
        args.push('-af', audioFilters.join(','));
      }

      // Format-specific
      if (!audioOnly && outputFormat.startsWith('prores')) {
        args.push('-c:v', 'prores_ks'); // ✅ Compatible encoder
  const profileMap = {
    prores_proxy: '0',
    prores_lt: '1',
    prores_422: '2',
    prores_422hq: '3',
    prores_4444: '4',
    prores_4444xq: '5'
  };
  args.push('-profile:v', profileMap[outputFormat] || '3'); // default to HQ
}

      else if (!audioOnly && outputFormat === 'h264_auto_gpu') {
        const enc = global.gpuEncoders?.h264 || detectBestGPUEncoder('h264', ffmpegPath);
        if (process.env.DEBUG_GPU) {
          // Selected encoder logged only in debug mode
        }
        args.push('-c:v', enc);
      }
      else if (!audioOnly && outputFormat === 'h264') {
        const enc = global.gpuEncoders?.h264 || detectBestGPUEncoder('h264', ffmpegPath);
        if (process.env.DEBUG_GPU) {
          // Selected encoder logged only in debug mode
        }
        args.push('-c:v', enc);
      }
      else if (!audioOnly && outputFormat === 'h265') {
        const enc = global.gpuEncoders?.hevc || detectBestGPUEncoder('hevc', ffmpegPath);
        if (process.env.DEBUG_GPU) {
          // Selected encoder logged only in debug mode
        }
        args.push('-c:v', enc);
      }
      else if (!audioOnly && outputFormat === 'vp9') args.push('-c:v', 'libvpx-vp9');
      else if (!audioOnly && outputFormat === 'av1') args.push('-c:v', 'libaom-av1');
      else if (!audioOnly && outputFormat.startsWith('xdcam')) args.push('-c:v', 'mpeg2video');
      else if (!audioOnly && outputFormat.startsWith('xavc')) args.push('-c:v', 'libx264');
      else if (!audioOnly && outputFormat === 'jpeg2000') args.push('-c:v', 'jpeg2000');
      else if (!audioOnly && outputFormat === 'ffv1') args.push('-c:v', 'ffv1');
      else if (!audioOnly && outputFormat === 'mjpeg') args.push('-c:v', 'mjpeg');
      else if (!audioOnly && outputFormat === 'qtrle') args.push('-c:v', 'qtrle');
      else if (!audioOnly && (outputFormat === 'uncompressed_yuv' || outputFormat === 'uncompressed_rgb')) args.push('-c:v', 'rawvideo');
      else if (!audioOnly && outputFormat.endsWith('_sequence')) {
        const codecMap = {
          png_sequence: 'png',
          tiff_sequence: 'tiff',
          exr_sequence: 'exr',
          tga_sequence: 'targa'
        };
        args.push('-c:v', codecMap[outputFormat] || 'png');
      }

      // Container-specific (for image sequences or overrides)
      const isImageSeq = containerFormat === 'image_sequence' || containerFormat === 'image2';
      if (isImageSeq) {
        const extMap = {
          png_sequence: '.png',
          tiff_sequence: '.tiff',
          exr_sequence: '.exr',
          tga_sequence: '.tga'
        };
        const ext = extMap[outputFormat] || '.png';
        outputPath = outputPath.replace(path.extname(outputPath), `_%03d${ext}`);
      }

      if (!audioOnly) {
        const vf = [];

        const vfIdx = args.indexOf('-vf');
        if (vfIdx !== -1 && args[vfIdx + 1]) {
          vf.push(args[vfIdx + 1]);
          args.splice(vfIdx, 2);
        }

        if (lutPath) {
          if (fs.existsSync(lutPath)) {
            vf.push(`lut3d=file='${escapeForFfmpegFilter(lutPath)}'`);
          } else {
            logs.push(`⚠️ LUT not found: ${lutPath} (skipping)`);
            sendTranscodeLog(`⚠️ LUT not found: ${lutPath} (skipping)`);
          }
        }

        vf.push('scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2');

        args.push('-vf', vf.join(','));
      }

      const hasThreads = args.includes('-threads');
      if (!hasThreads) {
        args.push('-threads', '1');
      }

      args.push(outputPath);

      return args;
    }

    function runOne(inputPath, index, streamId = index) {
      return new Promise((resolveOne) => {
        const progressFile = path.join(os.tmpdir(), `ffmpeg-progress-${Date.now()}-${streamId}.txt`);
        const outName = buildOutputName(inputPath, index, {
          containerFormat,
          appendSeq,
          isBatch
        });
        const finalOutPath = path.join(outputFolder, outName);
        const ext = path.extname(finalOutPath);
        const base = ext ? finalOutPath.slice(0, -ext.length) : finalOutPath;
        const tempOutPath = `${base}.__encoding__${ext}`;

        try {
          if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath);
        } catch {
          // best-effort
        }

        const statusMap = {
          transcoded: false,
          verified: false,
          outputFile: outName,
          finalOutputPath: finalOutPath,
          tempOutputPath: tempOutPath
        };
        let qualityResult = { status: 'skipped', reason: 'not requested' };
        const args = buildCommand(inputPath, tempOutPath, progressFile); // write to temp path first

        logs.push(`🛠 FFmpeg args: ${args.join(' ')}`);
        sendTranscodeLog(`🛠 FFmpeg args: ${args.join(' ')}`);

        logs.push(`🎬 Starting: ${path.basename(inputPath)}`);
        sendTranscodeLog(`🎬 Starting: ${path.basename(inputPath)}`);

        const fileSize = fs.statSync(inputPath).size;
        logs.push(`📂 File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        sendTranscodeLog(`📂 File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

        const ratio = estimatedSizeRatioMap[outputFormat] || 0.8;
        const estSizeMB = (fileSize / 1024 / 1024) * ratio;
        logs.push(`📦 Estimated output size: ~${estSizeMB.toFixed(1)} MB`);
        sendTranscodeLog(`📦 Estimated output size: ~${estSizeMB.toFixed(1)} MB`);

        let shouldDelete = false;

        if (isPackaged) {
          console.log('[DEBUG - packaged]', ffmpegPath, args);
        }
        console.log('[LeadAE Transcode]', ffmpegPath, args);

        const proc = spawn(ffmpegPath, args);
        proc.on('error', err => console.error('[FFmpeg Spawn Error]', err));
        proc.stderr.on('data', d => {
          const msg = d.toString();
          console.error('[FFmpeg stderr]', msg);
          sendTranscodeLog(msg.trim(), true);
        });
        proc.on('close', code => console.log('[FFmpeg exited]', code));

        currentProcesses.add(proc);

        // Terminate FFmpeg immediately if the job's signal is aborted
        if (config.signal) {
          const onAbort = () => {
            if (proc && typeof proc.kill === 'function') {
              proc.kill('SIGINT');
            }
          };

          if (config.signal.aborted) {
            onAbort();
          } else {
            config.signal.addEventListener('abort', onAbort, { once: true });
          }

          proc.on('close', () => {
            config.signal.removeEventListener('abort', onAbort);
          });
        }

        const notifyWin = BrowserWindow.getFocusedWindow();
        if (notifyWin && !notifyWin.isDestroyed()) {
          notifyWin.webContents.send('ffmpeg-progress-started', {
            jobId: streamId,
            progressFile
          });
        }

        let watchInterval;
        let finished = false;
        let progressStopped = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolveOne();
        };
        const stopProgress = () => {
          if (watchInterval) {
            clearInterval(watchInterval);
            watchInterval = null;
          }
          if (!progressStopped && notifyWin && !notifyWin.isDestroyed()) {
            notifyWin.webContents.send('ffmpeg-progress-stopped', { jobId: streamId, progressFile });
          }
          progressStopped = true;
        };

        proc.on('error', err => {
          const msg = `❌ Failed to start FFmpeg: ${err.message}`;
          logs.push(msg);
          sendTranscodeLog(msg, true);
          stopProgress();
          try { fs.unlinkSync(progressFile); } catch {}
          currentProcesses.delete(proc);
          finish();
        });

        const durationMs = durationMap.get(inputPath) || 0;
        let lastTime = 0;
        let started = false;
        watchInterval = setInterval(() => {
          try {
            const raw = fs.readFileSync(progressFile, 'utf8');
            const lines = raw.trim().split('\n');
            const getVal = (key) => {
              for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].startsWith(key)) {
                  return lines[i].split('=')[1];
                }
              }
              return null;
            };
            const outMsStr = getVal('out_time_ms');
            const prog = getVal('progress');

            const outMs = parseInt(outMsStr, 10) / 1000;
            if (!isNaN(outMs)) {
              if (!started) {
                progressManager.startFile(streamId, inputPath, durationMs);
                started = true;
              }
              const delta = outMs - lastTime;
              if (delta >= 0) {
                lastTime = outMs;
                const payload = {
                  ...progressManager.update(streamId, delta),
                  streamId
                };
                if (global.queue) {
                  global.queue.emit('job-progress', {
                    id: config.jobId,
                    panel: 'transcode',
                    file: payload.file,
                    percent: payload.overall,
                    filePercent: payload.percent,
                    eta: payload.eta,
                    completed: payload.completedFiles,
                    total: payload.totalFiles,
                    streamId: payload.streamId
                  });
                }
              }
            }

            if (prog === 'end') {
              stopProgress();
            }
          } catch {
            // ignore read errors
          }
        }, 1000);

proc.on('exit', (code, signal) => {
  logs.push(`🚪 FFmpeg exited (code ${code}, signal ${signal || 'none'})`);
  sendTranscodeLog(`🚪 FFmpeg exited (code ${code}, signal ${signal || 'none'})`);
});

        proc.on('close', async (code) => {
          stopProgress();
          try { fs.unlinkSync(progressFile); } catch {}

          statusMap.transcoded = code === 0;

          if (code !== 0) {
            logs.push(`❌ Failed: ${path.basename(finalOutPath)} (code ${code})`);
            sendTranscodeLog(`❌ Failed: ${path.basename(finalOutPath)} (code ${code})`, true);
            qualityResult = { status: 'skipped', reason: 'transcode failed' };
          }

  try {
    if (fs.existsSync(tempOutPath) && fs.statSync(tempOutPath).size > 0) {
      const okMsg = `📄 Output exists: ${path.basename(finalOutPath)}`;
      logs.push(okMsg);
      sendTranscodeLog(okMsg);

      try {
        const codec = await new Promise(res => {
          execFile(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            tempOutPath
          ], { encoding: 'utf-8' }, (err, stdout) => {
            if (err) return res('');
            res(stdout.toString().trim());
          });
        });
        if (codec) {
          const encMsg = `🧪 Video stream codec: ${codec}`;
          logs.push(encMsg);
          sendTranscodeLog(encMsg);
          if (/_videotoolbox|nvenc|qsv|amf/i.test(codec)) {
            const gpuMsg = '✅ Confirmed: GPU encoder was used.';
            logs.push(gpuMsg);
            sendTranscodeLog(gpuMsg);
        } else if (process.env.DEBUG_GPU) {
            const warnMsg = '❌ GPU encoder not detected in final file.';
            logs.push(warnMsg);
            sendTranscodeLog(warnMsg, true);
          }
        } else {
          const fallbackMsg = '⚠️ Could not detect video codec using ffprobe.';
          logs.push(fallbackMsg);
          sendTranscodeLog(fallbackMsg);
        }
      } catch (err) {
        const warn = `⚠️ Failed to inspect output encoder: ${err.message}`;
        logs.push(warn);
        sendTranscodeLog(warn, true);
      }


      const inMeta = await getFFprobeData(inputPath);
      const outMeta = await getFFprobeData(tempOutPath);
      let resDiff = false;
      let rateDiff = false;
      if (inMeta && outMeta) {
        const inFps = inMeta?.frames && inMeta?.duration ? (inMeta.frames / inMeta.duration) : 0;
        const outFps = outMeta?.frames && outMeta?.duration ? (outMeta.frames / outMeta.duration) : 0;
        const hasScaleArg = Array.isArray(args) && args.includes('-s');
        resDiff =
          inMeta?.width !== outMeta?.width ||
          inMeta?.height !== outMeta?.height ||
          hasScaleArg;
        rateDiff = frameRate && Math.abs(outFps - inFps) > 0.5;

        // 🧩 Auto-fallback: skip SSIM when resolution, frame rate, or explicit -s scaling differ
        if (verification?.method === 'ssim_psnr' && (resDiff || rateDiff)) {
          const reason = resDiff
            ? 'resolution change detected'
            : 'frame-rate change detected';
          sendTranscodeLog(`ℹ️ Auto-switched to Metadata verification (${reason}).`);
          logs.push(`ℹ️ Auto-switched to Metadata verification (${reason}).`);
          verification.method = 'metadata';
        }

        const metaMsg = `🔍 Frames ${inMeta.frames}/${outMeta.frames} • Duration ${inMeta.duration.toFixed(2)}/${outMeta.duration.toFixed(2)}`;
        logs.push(metaMsg);
        sendTranscodeLog(metaMsg);
        if (inMeta.frames !== outMeta.frames) {
          const changedFps = !!frameRate && frameRate !== 'match';
          const msg = changedFps
            ? 'ℹ️ Frame count differs due to frame rate change'
            : '⚠️ Frame mismatch';
          logs.push(msg);
          sendTranscodeLog(msg);
        }
        if (Math.abs(inMeta.duration - outMeta.duration) > 0.1) {
          const warn = `⚠️ Duration mismatch`;
          logs.push(warn);
          sendTranscodeLog(warn, true);
        }

        // 🛑 Flag for possible deletion if metadata differs significantly
        const frameGap = Math.abs(inMeta.frames - outMeta.frames);
        const durationGap = Math.abs(inMeta.duration - outMeta.duration);

        logs.push(`🎚️ Frame rate in: ${(inMeta.frames / inMeta.duration).toFixed(2)} fps, out: ${(outMeta.frames / outMeta.duration).toFixed(2)} fps`);
        sendTranscodeLog(`🎚️ Frame rate in: ${(inMeta.frames / inMeta.duration).toFixed(2)} fps, out: ${(outMeta.frames / outMeta.duration).toFixed(2)} fps`);

        // 🧩 Adjust deletion heuristic when frame rate or resolution changes
        const frameRatio = outMeta.frames / inMeta.frames;
        const fpsDelta = Math.abs(outFps - inFps);

        if (fpsDelta > 0.5) {
          // Allow larger frame differences when retimed
          shouldDelete = false;
        } else {
          shouldDelete = (
            frameRatio < 0.5 ||
            frameRatio > 2.0 ||
            frameGap > 1000 ||
            durationGap > 1.0
          );
        }
        if (resDiff) {
          // Allow large frame deltas when scaled
          shouldDelete = false;
        }
        if (shouldDelete) {
          const warnDel = `❌ Incomplete transcode: expected ${inMeta.frames} frames, got ${outMeta.frames}`;
          logs.push(warnDel);
          sendTranscodeLog(warnDel, true);
        }
      }

      if (verification?.method === 'metadata') {
        if (resDiff || rateDiff) {
          logs.push('🧪 SSIM/PSNR verification auto-skipped (scaled output detected).');
          sendTranscodeLog('ℹ️ SSIM/PSNR skipped due to geometry change.');
        }
        const verificationMsg = shouldDelete
          ? '⚠️ Metadata verification flagged potential issues.'
          : '✅ Metadata verification passed.';
        logs.push(verificationMsg);
        sendTranscodeLog(verificationMsg);
        statusMap.verified = !shouldDelete;
        qualityResult = { status: 'skipped', reason: 'metadata verification only' };
      } else if (verification?.method === 'ssim_psnr') {
        if (containerFormat === 'image_sequence' || containerFormat === 'image2') {
          const msg = 'ℹ️ SSIM/PSNR skipped for image sequences.';
          logs.push(msg);
          sendTranscodeLog(msg);
          qualityResult = { status: 'skipped', reason: 'image sequence output' };
        } else {
          try {
            // If the job specified a frameRate (e.g. retime to 23.976), pass it through.
            // Otherwise, runSsimPsNrCheck will auto-read output FPS via ffprobe.
            const targetRetimeFps = frameRate && frameRate !== 'match'
              ? Number(String(frameRate).replace('df', ''))   // strip DF label if present
              : undefined;

            qualityResult = await runSsimPsNrCheck({
              ffmpegPath,
              ffprobePath,
              src: inputPath,
              out: tempOutPath,
              timeoutMs: 3 * 60 * 1000,
              retimeFps: targetRetimeFps
            });
          } catch (qcErr) {
            qualityResult = { status: 'error', reason: qcErr.message };
          }

          if (qualityResult.status === 'ok') {
            const { ssim, psnr } = qualityResult;
            const hasSsim = typeof ssim === 'number' && Number.isFinite(ssim);
            const hasPsnr = typeof psnr === 'number' && Number.isFinite(psnr);
            const summary = `🧪 Quality: SSIM ${hasSsim ? ssim.toFixed(4) : 'n/a'} | PSNR ${
              hasPsnr ? `${psnr.toFixed(2)} dB` : 'n/a'
            }`;
            logs.push(summary);
            sendTranscodeLog(summary);

            const degraded = (hasSsim && ssim < 0.95) || (hasPsnr && psnr < 35);
            const verdict = degraded ? '⚠️ Quality below threshold' : '✅ SSIM/PSNR verification passed.';
            logs.push(verdict);
            sendTranscodeLog(verdict);
            statusMap.verified = !degraded;
          } else if (qualityResult.status === 'skipped') {
            const skipMsg = `🧪 Quality: skipped (${qualityResult.reason})`;
            logs.push(skipMsg);
            sendTranscodeLog(skipMsg);
          } else if (qualityResult.status === 'error') {
            const errMsg = `🧪 Quality: error (${qualityResult.reason})`;
            logs.push(errMsg);
            sendTranscodeLog(errMsg, true);
          }
        }
      }

      if (shouldDelete) {
        try {
          fs.unlinkSync(tempOutPath);
          const delMsg = `🧹 Deleted incomplete file: ${path.basename(finalOutPath)}`;
          logs.push(delMsg);
          sendTranscodeLog(delMsg);
        } catch (err) {
          const failDel = `⚠️ Failed to delete partial file: ${err.message}`;
          logs.push(failDel);
          sendTranscodeLog(failDel);
        }
      }

    } else {
      const errMsg = `❌ Output missing or empty: ${path.basename(finalOutPath)}`;
      logs.push(errMsg);
      sendTranscodeLog(errMsg, true);
      qualityResult = { status: 'skipped', reason: 'output missing' };
    }
  } catch (verErr) {
    const errMsg = `⚠️ Verification error: ${verErr.message}`;
    logs.push(errMsg);
    sendTranscodeLog(errMsg, true);
    if (!qualityResult || qualityResult.status === 'skipped') {
      qualityResult = { status: 'error', reason: verErr.message };
    }
  }


          const canFinalize =
            statusMap.transcoded &&
            !shouldDelete &&
            fs.existsSync(tempOutPath);

          if (canFinalize) {
            try {
              fs.renameSync(tempOutPath, finalOutPath);
            } catch (err) {
              const msg = `❌ Failed to finalize output file: ${err.message}`;
              logs.push(msg);
              sendTranscodeLog(msg, true);
              statusMap.transcoded = false;
            }
          } else {
            // Best-effort: don’t leave stray partials around
            try {
              if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath);
            } catch {
              /* ignore */
            }
          }

          if (statusMap.transcoded) {
            logs.push(`✅ Done: ${path.basename(finalOutPath)}`);
            sendTranscodeLog(`✅ Done: ${path.basename(finalOutPath)}`);
          }

          statusMap.quality = qualityResult;

          progressManager.finishFile(streamId, statusMap);
          if (progressManager.completedFiles >= progressManager.totalFiles) {
            try {
              progressManager.complete(config.jobId);
            } catch {}
          }
          if (global.queue) {
            global.queue.emit('job-progress', {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(inputPath),
              status: { ...statusMap }
            });
          }

          currentProcesses.delete(proc);

          completed++;
          if (!statusMap.transcoded) failed++;

          if (global.queue) {
            const statusText = statusMap.transcoded
              ? `✅ Done: ${path.basename(finalOutPath)}`
              : `❌ Failed: ${path.basename(finalOutPath)}`;

            const donePayload = {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(finalOutPath),
              status: statusText,
              percent: 100,
              filePercent: 100,
              completed,
              total,
              eta: '0s'
            };
            global.queue.emit('job-progress', donePayload);
          }

          if (completed === total && !config.signal?.aborted) {
            sendTranscodeLog('✅ Transcode job complete.');
          }

          finish();
        });

      });
    }

    // Chain all jobs sequentially
    const tasks = inputFiles.map((file, idx) => async (workerId) => {
      if (config.signal?.aborted) return;
      await runOne(file, idx + 1, workerId);
    });

    // Run all transcode tasks then finalize
    (async () => {
      const taskResults = await runWithConcurrencyLimit(tasks, threadCount);
      const taskFailures = (taskResults || []).filter(r => r && r.success === false);
      if (taskFailures.length) {
        const msg = `❌ ${taskFailures.length} internal transcode task(s) crashed before FFmpeg could run.`;
        logs.push(msg);
        sendTranscodeLog(msg, true);
        taskFailures.slice(0, 5).forEach((f) => {
          if (f?.error) {
            const em = `   • ${f.error}`;
            logs.push(em);
            sendTranscodeLog(em, true);
          }
        });
      }

      if (verification?.saveLog) {
        const logFile = path.join(outputFolder, `TranscodeLog_${Date.now()}.txt`);
        writeLogToFile(logs, logFile);
        logs.push(`📄 Log saved to: ${logFile}`);
        sendTranscodeLog(`📄 Log saved to: ${logFile}`);
      }

      logs.push(`📄 Files processed: ${completed} of ${total}${failed ? ` (failed: ${failed})` : ''}`);
 
      archivePath = archiveLog(logs, 'transcode');
      logs.push(`📂 Log archived to: ${archivePath}`);
      sendTranscodeLog(`📂 Log archived to: ${archivePath}`);

      const wasCanceled = config.signal?.aborted;
      if (wasCanceled) {
        logs.push('🚫 Transcode cancelled by user.');
        sendTranscodeLog('🚫 Transcode cancelled by user.');
      }

      const finalLogs = logs;

      try {
        removeJobFile();
      } catch {
        // ignore errors cleaning up job file
      }

      if (progressManager?.complete) {
        progressManager.complete(config.jobId);
      } else if (progressManager?.dispose) {
        progressManager.dispose();
      }

      try { unbindProgress?.(); } catch {}

      const jobSucceeded = !wasCanceled && failed === 0 && taskFailures.length === 0 && completed === total;

      transcodeJobLogger.setStage(jobSucceeded ? 'complete' : 'error');
      transcodeJobLogger.info(
        wasCanceled ? 'Transcode job cancelled' : (jobSucceeded ? 'Transcode job completed' : 'Transcode job failed')
      );
      structuredPath = writeJobLogToFile('transcode', config.jobId, transcodeJobLogger.getEntries());

      resolve({
        success: jobSucceeded,
        cancelled: wasCanceled,
        log: finalLogs,
        logText: finalLogs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      transcodeJobLogger = null;
    })();

    })();
    
  });
}

function cancelTranscode(id) {
  for (const proc of currentProcesses) {
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGINT');
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore if SIGKILL isn't supported
          }
        }
      }, 1000);
    }
  }
  currentProcesses.clear();
  cancelIngest(id);
}

module.exports = { runTranscode, cancelTranscode, buildOutputName, currentProcesses };
