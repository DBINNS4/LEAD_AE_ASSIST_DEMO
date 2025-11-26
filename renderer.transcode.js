// renderer.transcode.js — DEMO-ONLY VERSION
// --- PURE FRONTEND ---
// No Electron, no IPC, no Codex, no watch mode, no hamsters.
// ONLY dropdown population + tooltip text.

(() => {

  // Run when DOM is ready
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  // Safe wrapper around styled dropdowns used by Ingest/Speed Test
  function dd(id, options, defaultValue) {
    if (typeof window.setupStyledDropdown !== "function") return;
    if (typeof window.setDropdownValue !== "function") return;
    window.setupStyledDropdown(id, options);
    if (defaultValue != null) window.setDropdownValue(id, defaultValue);
  }

  // ---------------------------------------------------------------
  //  EXACT OPTIONS as defined in your REAL production app
  // ---------------------------------------------------------------

  const OUTPUT_FORMATS = [
    { value: "prores_422",        label: "ProRes 422" },
    { value: "prores_422hq",      label: "ProRes 422 HQ" },
    { value: "prores_4444",       label: "ProRes 4444" },
    { value: "prores_4444xq",     label: "ProRes 4444 XQ" },
    { value: "prores_lt",         label: "ProRes LT" },
    { value: "prores_proxy",      label: "ProRes Proxy" },
    { value: "jpeg2000",          label: "JPEG 2000" },
    { value: "av1",               label: "AV1" },
    { value: "h264",              label: "H.264" },
    { value: "h264_auto_gpu",     label: "H.264 (Auto GPU)" },
    { value: "h265",              label: "H.265 / HEVC" },
    { value: "vp9",               label: "VP9" },
    { value: "ffv1",              label: "FFV1" },
    { value: "mjpeg",             label: "Motion JPEG" },
    { value: "uncompressed_rgb",  label: "Uncompressed RGB" },
    { value: "uncompressed_yuv",  label: "Uncompressed YUV" },
    { value: "exr_sequence",      label: "EXR Sequence" },
    { value: "image_sequence",    label: "Image Sequence" },
    { value: "png_sequence",      label: "PNG Sequence" },
    { value: "tga_sequence",      label: "TGA Sequence" },
    { value: "tiff_sequence",     label: "TIFF Sequence" }
  ];

  const CONTAINERS = [
    { value: "mov",  label: "QuickTime (.mov)" },
    { value: "mp4",  label: "MP4 (.mp4)" },
    { value: "mxf",  label: "MXF" },
    { value: "webm", label: "WebM" },
    { value: "avi",  label: "AVI" },
    { value: "image_sequence", label: "Image Sequence" }
  ];

  const RESOLUTIONS = [
    { value: "720x480",   label: "720×480 (SD)" },
    { value: "1280x720",  label: "1280×720 (720p)" },
    { value: "1920x1080", label: "1920×1080 (HD)" },
    { value: "3840x2160", label: "3840×2160 (UHD)" },
    { value: "4096x2160", label: "4096×2160 (4K DCI)" }
  ];

  const FRAME_RATES = [
    { value: "23.976",  label: "23.976" },
    { value: "24",      label: "24.000" },
    { value: "25",      label: "25.000" },
    { value: "29.97",   label: "29.97" },
    { value: "29.97df", label: "29.97 DF" },
    { value: "30",      label: "30.000" },
    { value: "50",      label: "50.000" },
    { value: "59.94",   label: "59.94" },
    { value: "59.94df", label: "59.94 DF" },
    { value: "60",      label: "60.000" }
  ];

  const PIXEL_FORMATS = [
    { value: "yuv420p",     label: "YUV 4:2:0 8-bit" },
    { value: "yuv422p",     label: "YUV 4:2:2 8-bit" },
    { value: "yuv422p10",   label: "YUV 4:2:2 10-bit" },
    { value: "yuv420p10le", label: "YUV 4:2:0 10-bit" },
    { value: "yuv444p10le", label: "YUV 4:4:4 10-bit" }
  ];

  const COLOR_RANGES = [
    { value: "limited", label: "Video (16–235)" },
    { value: "full",    label: "Full (0–255)" }
  ];

  const FIELD_ORDER = [
    { value: "progressive", label: "Progressive" },
    { value: "upper",       label: "Interlaced – Upper Field First" },
    { value: "lower",       label: "Interlaced – Lower Field First" }
  ];

  const AUDIO_CODECS = [
    { value: "copy",       label: "Copy (no reencode)" },
    { value: "pcm_s16le",  label: "PCM 16-bit (WAV)" },
    { value: "aac",        label: "AAC" },
    { value: "ac3",        label: "Dolby Digital (AC-3)" },
    { value: "mp3",        label: "MP3" }
  ];

  const CHANNELS = [
    { value: "preserve", label: "Preserve Original" },
    { value: "1", label: "Mono (1.0)" },
    { value: "2", label: "Stereo (2.0)" },
    { value: "6", label: "5.1" },
    { value: "8", label: "7.1" }
  ];

  const SAMPLE_RATES = [
    { value: "44100", label: "44.1 kHz" },
    { value: "48000", label: "48 kHz" },
    { value: "96000", label: "96 kHz" }
  ];

  const AUDIO_BITRATES = [
    { value: "96k",  label: "96 kbps" },
    { value: "128k", label: "128 kbps" },
    { value: "192k", label: "192 kbps" },
    { value: "256k", label: "256 kbps" },
    { value: "320k", label: "320 kbps" }
  ];

  const VERIFICATION = [
    { value: "metadata",  label: "Duration / Frame" },
    { value: "ssim_psnr", label: "SSIM / PSNR" }
  ];

  // ---------------------------------------------------------------
  //  Populate ALL Transcode dropdowns
  // ---------------------------------------------------------------

  ready(() => {

    // If panel isn't present, do nothing
    if (!document.getElementById("transcode")) return;

    dd("outputFormat", OUTPUT_FORMATS, "prores_422");
    dd("containerFormat", CONTAINERS, "mov");
    dd("resolution", RESOLUTIONS, "1920x1080");
    dd("frameRate", FRAME_RATES, "23.976");
    dd("pixelFormat", PIXEL_FORMATS, "yuv422p10");
    dd("colorRange", COLOR_RANGES, "limited");
    dd("fieldOrder", FIELD_ORDER, "progressive");

    dd("audioCodec", AUDIO_CODECS, "pcm_s16le");
    dd("channels", CHANNELS, "preserve");
    dd("sampleRate", SAMPLE_RATES, "48000");
    dd("audioBitrate", AUDIO_BITRATES, "192k");

    dd("transcode-verification-method", VERIFICATION, "metadata");

  });

})();
