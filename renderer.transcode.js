// renderer.transcode.js — DEMO ONLY
// No Codex, no IPC, no queue. Just populate dropdowns + tooltips.

(() => {
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function hasDropdownHelpers() {
    return typeof window.setupStyledDropdown === "function" &&
           typeof window.setDropdownValue === "function";
  }

  function fillTranscodeDropdowns() {
    if (!hasDropdownHelpers()) {
      console.warn("Transcode demo: dropdown helpers not found.");
      return;
    }

    const panel = document.getElementById("transcode");
    if (!panel) return;

    // 🔹 Preset dropdown
    window.setupStyledDropdown("transcode-preset", [
      { value: "none",           label: "No Preset" },
      { value: "prores_1080p",   label: "ProRes 422 LT — 1080p" },
      { value: "prores_4k",      label: "ProRes 422 HQ — 4K UHD" },
      { value: "h264_proxy_1080",label: "H.264 Proxies — 1080p" }
    ]);
    window.setDropdownValue("transcode-preset", "none");

    // 🔹 Output Format
    window.setupStyledDropdown("outputFormat", [
      { value: "prores_422",    label: "Apple ProRes 422" },
      { value: "prores_422_lt", label: "Apple ProRes 422 LT" },
      { value: "prores_422_hq", label: "Apple ProRes 422 HQ" },
      { value: "prores_4444",   label: "Apple ProRes 4444" },
      { value: "h264",          label: "H.264" },
      { value: "h265",          label: "H.265 / HEVC" },
      { value: "dnxhd",         label: "Avid DNxHD / DNxHR" },
      { value: "proxy",         label: "Lightweight Proxy" }
    ]);
    window.setDropdownValue("outputFormat", "prores_422_lt");

    // 🔹 Container
    window.setupStyledDropdown("containerFormat", [
      { value: "mov",            label: "QuickTime (.mov)" },
      { value: "mp4",            label: "MP4 (.mp4)" },
      { value: "mxf",            label: "MXF" },
      { value: "webm",           label: "WebM" },
      { value: "image_sequence", label: "Image Sequence" }
    ]);
    window.setDropdownValue("containerFormat", "mov");

    // 🔹 Resolution
    window.setupStyledDropdown("resolution", [
      { value: "1280x720",  label: "1280×720 (720p)" },
      { value: "1920x1080", label: "1920×1080 (HD)" },
      { value: "2048x1080", label: "2048×1080 (2K DCI)" },
      { value: "3840x2160", label: "3840×2160 (UHD)" },
      { value: "4096x2160", label: "4096×2160 (4K DCI)" }
    ]);
    window.setDropdownValue("resolution", "1920x1080");

    // 🔹 Frame Rate
    window.setupStyledDropdown("frameRate", [
      { value: "23.976",  label: "23.976" },
      { value: "24",      label: "24.000" },
      { value: "25",      label: "25.000" },
      { value: "29.97",   label: "29.97" },
      { value: "30",      label: "30.000" },
      { value: "50",      label: "50.000" },
      { value: "59.94",   label: "59.94" },
      { value: "60",      label: "60.000" }
    ]);
    window.setDropdownValue("frameRate", "23.976");

    // 🔹 Pixel Format
    window.setupStyledDropdown("pixelFormat", [
      { value: "yuv420p",     label: "YUV 4:2:0 8-bit (yuv420p)" },
      { value: "yuv422p",     label: "YUV 4:2:2 8-bit (yuv422p)" },
      { value: "yuv422p10",   label: "YUV 4:2:2 10-bit (yuv422p10)" },
      { value: "yuv420p10le", label: "YUV 4:2:0 10-bit (yuv420p10le)" },
      { value: "yuv444p10le", label: "YUV 4:4:4 10-bit (yuv444p10le)" }
    ]);
    window.setDropdownValue("pixelFormat", "yuv422p10");

    // 🔹 Color Range
    window.setupStyledDropdown("colorRange", [
      { value: "limited", label: "Video (16–235)" },
      { value: "full",    label: "Full (0–255)" }
    ]);
    window.setDropdownValue("colorRange", "limited");

    // 🔹 Field Order
    window.setupStyledDropdown("fieldOrder", [
      { value: "progressive", label: "Progressive" },
      { value: "upper",       label: "Interlaced – Upper Field First" },
      { value: "lower",       label: "Interlaced – Lower Field First" }
    ]);
    window.setDropdownValue("fieldOrder", "progressive");

    // 🔹 Audio Codec
    window.setupStyledDropdown("audioCodec", [
      { value: "copy",       label: "Preserve Source (copy)" },
      { value: "pcm_s16le",  label: "PCM 16-bit (WAV)" },
      { value: "aac",        label: "AAC" },
      { value: "ac3",        label: "Dolby Digital (AC-3)" },
      { value: "mp3",        label: "MP3" }
    ]);
    window.setDropdownValue("audioCodec", "pcm_s16le");

    // 🔹 Channels
    window.setupStyledDropdown("channels", [
      { value: "preserve", label: "Preserve Original" },
      { value: "1",        label: "Mono (1.0)" },
      { value: "2",        label: "Stereo (2.0)" },
      { value: "6",        label: "5.1" },
      { value: "8",        label: "7.1" }
    ]);
    window.setDropdownValue("channels", "preserve");

    // 🔹 Sample Rate
    window.setupStyledDropdown("sampleRate", [
      { value: "44100", label: "44.1 kHz" },
      { value: "48000", label: "48 kHz" },
      { value: "96000", label: "96 kHz" }
    ]);
    window.setDropdownValue("sampleRate", "48000");

    // 🔹 Audio Bitrate
    window.setupStyledDropdown("audioBitrate", [
      { value: "96k",  label: "96 kbps" },
      { value: "128k", label: "128 kbps" },
      { value: "192k", label: "192 kbps" },
      { value: "256k", label: "256 kbps" },
      { value: "320k", label: "320 kbps" }
    ]);
    window.setDropdownValue("audioBitrate", "192k");

    // 🔹 Verification Method
    window.setupStyledDropdown("transcode-verification-method", [
      { value: "metadata",  label: "Duration / Frame" },
      { value: "ssim_psnr", label: "SSIM / PSNR" }
    ]);
    window.setDropdownValue("transcode-verification-method", "metadata");
  }

  function fillTranscodeTooltips() {
    const top = document.getElementById("transcode-overview-tooltip");
    if (top && !top.innerHTML.trim()) {
      top.innerHTML = `
        <div class="tooltip-content">
          <div class="tooltip-header">TRANSCODE PANEL OVERVIEW</div>
          <div class="tooltip-section">
            <span class="tooltip-subtitle">What this panel is for</span>
            <ul class="tooltip-list">
              <li>Convert camera masters or intermediates into delivery or proxy formats.</li>
              <li>Normalize resolution, frame rate, pixel format, and color range.</li>
              <li>Standardize audio codec, channels, and bitrate.</li>
            </ul>
          </div>
        </div>
      `;
    }

    const ver = document.getElementById("transcode-verification-tooltip");
    if (ver && !ver.innerHTML.trim()) {
      ver.innerHTML = `
        <div class="tooltip-content">
          <div class="tooltip-header">VERIFICATION METHODS</div>
          <div class="tooltip-section">
            <ul class="tooltip-list">
              <li><strong>Duration / Frame</strong> – Compare runtimes and frame counts.</li>
              <li><strong>SSIM / PSNR</strong> – Perceptual and signal-based quality checks.</li>
            </ul>
          </div>
        </div>
      `;
    }
  }

  onReady(() => {
    // Only touch Transcode; leave other panels alone
    if (!document.getElementById("transcode")) return;
    try {
      fillTranscodeDropdowns();
      fillTranscodeTooltips();
    } catch (err) {
      console.error("Transcode demo init failed:", err);
    }
  });
})();
