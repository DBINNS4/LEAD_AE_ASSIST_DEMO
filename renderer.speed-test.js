// =====================================================
// ⚡ renderer.speed-test.js – Connected to Backend
// =====================================================
console.log("⚡ Speed Test Panel Loaded");

(function initSpeedTest() {
  const start = () => {
    const ipc = window.electron;

    // ─── Speed Test: panel overview tooltip ─────────────────────────────────
    const overviewTooltip = document.getElementById("speed-test-overview-tooltip");
    if (overviewTooltip && !overviewTooltip.dataset.bound) {
      overviewTooltip.innerHTML = `
        <div class="tooltip-content">
          <div class="tooltip-header">SPEED TEST PANEL OVERVIEW</div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">What this panel is for</span>
            <ul class="tooltip-list">
              <li>Run quick network tests against the automation backend.</li>
              <li>Measure sequential and random read/write performance of local or shared drives.</li>
              <li>Validate whether a storage volume is fast enough for your workflows.</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">Quick workflow</span>
            <ul class="tooltip-list">
              <li><strong>Network test</strong> - click <em>Run Network Test</em> to probe latency and throughput.</li>
              <li><strong>Pick drives</strong> - choose one or two volumes under Drive Tests.</li>
              <li><strong>Configure mode</strong> - pick sequential vs random tests and a test size.</li>
              <li><strong>Run</strong> - start the tests and read the results (and hamster) to judge performance.</li>
            </ul>
          </div>
        </div>
      `;
      overviewTooltip.dataset.bound = "true";
    }

    // 🧩 Drive Test Tooltip (identical to Adobe Automate)
    const speedTooltip = document.getElementById("speedtest-info-tooltip");
    if (speedTooltip) {
      speedTooltip.innerHTML = `
        <div class="tooltip-content">
          <div class="tooltip-header">Drive Test Info</div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">Mode</span>
            <ul class="tooltip-list">
              <li><strong>Sequential:</strong> Measures sustained read/write speed for large, continuous files (e.g., video exports).</li>
              <li><strong>Random:</strong> Tests many small reads/writes across the drive — shows responsiveness for cache and metadata.</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">Test Size</span>
            <ul class="tooltip-list">
              <li><strong>Small (256-512 MB):</strong> Quick cache-level test — often optimistic.</li>
              <li><strong>Medium (1 GB):</strong> Balanced real-world performance for file transfers.</li>
              <li><strong>Large (2 GB):</strong> Measures sustained throughput for long-duration exports or proxy generation.</li>
            </ul>
          </div>
        </div>
      `;
    }

    const netBtn = document.getElementById("start-network-test");
    const netResults = document.getElementById("network-test-results");
    const driveResults = document.getElementById("drive-test-results");
    const summary = document.getElementById("speedtest-summary");
    // Inline loader elements (new)
    const inlineProgress = document.getElementById("speedtest-progress");
    const inlineOutput = document.getElementById("speedtest-progress-output");

    // 🐹 Hamster helpers (same structure used elsewhere)
    function ensureHamsterStructure(root) {
      if (!root) return;
      if (root.querySelector('.wheel')) return;
      root.innerHTML = `
        <div class="wheel"></div>
        <div class="hamster">
          <div class="hamster__body">
            <div class="hamster__head">
              <div class="hamster__ear"></div>
              <div class="hamster__eye"></div>
              <div class="hamster__nose"></div>
            </div>
            <div class="hamster__limb hamster__limb--fr"></div>
            <div class="hamster__limb hamster__limb--fl"></div>
            <div class="hamster__limb hamster__limb--br"></div>
            <div class="hamster__limb hamster__limb--bl"></div>
            <div class="hamster__tail"></div>
          </div>
        </div>
        <div class="spoke"></div>
      `;
    }

    function showSpeedtestHamster() {
      const status = document.getElementById('speedtest-job-status');
      if (!status) return;
      let wheel = status.querySelector('.wheel-and-hamster');
      if (!wheel) {
        wheel = document.createElement('div');
        wheel.className = 'wheel-and-hamster';
        status.appendChild(wheel);
      }
      ensureHamsterStructure(wheel);
      status.style.display = 'block';
      status.dataset.jobActive = 'true';
    }

    function hideSpeedtestHamster() {
      const status = document.getElementById('speedtest-job-status');
      if (!status) return;
      delete status.dataset.jobActive;
      status.style.display = 'none';
      status.querySelector('.wheel-and-hamster')?.remove();
    }

    // 🌐 Network Test
    netBtn?.addEventListener("click", async () => {
      if (inlineProgress) inlineProgress.value = 0;
      if (inlineOutput) inlineOutput.value = '';
      showSpeedtestHamster();
      netResults.textContent = "⏳ Running network speed test...";
      const res = await ipc.invoke("run-network-test");
      if (res.success) {
        netResults.textContent =
          `Download: ${res.download} Mbps\nUpload: ${res.upload} Mbps\nPing: ${res.ping} ms`;
      } else {
        netResults.textContent = `❌ ${res.error}`;
      }
      hideSpeedtestHamster();
    });

    // 💽 Drive Tests
    const drivePathsDisplay = document.getElementById("selected-drive-paths");
    const testSelectedDrivesBtn = document.getElementById("test-selected-drives");
    const testSizeSelect = document.getElementById("test-size");
    const modeSelect = document.getElementById("io-mode");

    // 🧩 Populate dropdowns using the same utility as other panels
    function populateDropdown(selectId, values, defaultValue) {
      // Preferred path: shared dropdown helper provided by utils/dropdown.js
      if (typeof window.setupStyledDropdown === "function") {
        window.setupStyledDropdown(selectId, values);
        if (typeof window.setDropdownValue === "function" && defaultValue != null) {
          window.setDropdownValue(selectId, String(defaultValue));
        }
        return;
      }
      // Fallback path (dev): minimal inline wiring so the dropdown still works
      const hidden = document.getElementById(selectId);
      if (!hidden) return;
      const wrapper = hidden.closest(".dropdown-wrapper");
      const chosen = wrapper?.querySelector(".chosen-value");
      const list = wrapper?.querySelector(".value-list");
      if (!wrapper || !list || !chosen) return;
      list.innerHTML = "";
      values.forEach(v => {
        const li = document.createElement("li");
        li.textContent = v.label;
        li.dataset.value = String(v.value);
        li.addEventListener("click", () => {
          hidden.value = String(v.value);
          chosen.value = v.label;
          list.classList.remove("open");
          chosen.classList.remove("open");
          wrapper.classList.remove("open");
        });
        list.appendChild(li);
      });
      chosen.addEventListener("click", () => {
        const isOpen = list.classList.toggle("open");
        chosen.classList.toggle("open", isOpen);
        wrapper.classList.toggle("open", isOpen);
      });
      if (defaultValue != null) {
        const def = values.find(v => String(v.value) === String(defaultValue)) || values[0];
        if (def) {
          hidden.value = String(def.value);
          chosen.value = def.label;
        }
      }
    }

    // Test size options in MB
    populateDropdown("test-size", [
      { label: "256 MB", value: 256 },
      { label: "512 MB", value: 512 },
      { label: "1 GB", value: 1024 },
      { label: "2 GB", value: 2048 }
    ], 1024);

    // Mode options
    populateDropdown("io-mode", [
      { label: "Sequential", value: "sequential" },
      { label: "Random", value: "random" }
    ], "sequential");

    // (Defaults are applied by populateDropdown above)
    const selectedDrivePaths = ["", "", ""];
    const ITERATIONS = 5; // main process also uses 5; first is warm-up
    let totalRuns = 0;
    let completedRuns = 0;

    function updateDrivePathsDisplay() {
      const text = selectedDrivePaths
        .map((p, idx) => (p ? `Drive ${idx + 1}: ${p}` : `Drive ${idx + 1}: (none)`))
        .join("\n");
      drivePathsDisplay.textContent = text || "No drives selected";
    }

    [1, 2, 3].forEach(i => {
      const selectBtn = document.getElementById(`select-drive-${i}`);
      selectBtn?.addEventListener("click", async () => {
        const folder = await ipc.invoke("select-folder");
        if (folder) {
          selectedDrivePaths[i - 1] = folder;
          updateDrivePathsDisplay();
        }
      });
    });

    testSelectedDrivesBtn?.addEventListener("click", async () => {
      const paths = selectedDrivePaths.filter(Boolean);
      if (!paths.length) return;

      driveResults.textContent = "";
      const testSize = Number(testSizeSelect?.value || 1024);
      const mode = modeSelect?.value || "sequential";
      const handler = mode === "random" ? "run-drive-test-random" : "run-drive-test";

      totalRuns = paths.length * ITERATIONS;
      completedRuns = 0;

      // ✅ Make sure we don't double-bind progress
      ipc.removeAllListeners?.("drive-test-progress");
      ipc.on("drive-test-progress", () => {
        completedRuns++;
        const pct = Math.floor((completedRuns / totalRuns) * 100);
        if (inlineProgress) inlineProgress.value = pct;
        if (inlineOutput) inlineOutput.value = pct >= 100 ? '' : pct;
      });

      // reset inline loader + show hamster
      if (inlineProgress) inlineProgress.value = 0;
      if (inlineOutput) inlineOutput.value = 0;
      showSpeedtestHamster();

      const summaries = [];
      for (let i = 0; i < selectedDrivePaths.length; i++) {
        const path = selectedDrivePaths[i];
        if (!path) continue;
        driveResults.textContent += `\n⏳ Testing Drive ${i + 1} at ${path}...`;
        const res = await ipc.invoke(handler, path, testSize);
        if (res.success) {
          driveResults.textContent += `\nDrive ${i + 1} Results:\n   🔹 Write: ${res.write} MB/s (min: ${res.writeMin}, max: ${res.writeMax})\n   🔹 Read:  ${res.read} MB/s (min: ${res.readMin}, max: ${res.readMax})\n`;
          summaries.push(
            `Drive ${i + 1} (${path}): ${res.read} MB/s Read / ${res.write} MB/s Write (${testSize} MB, ${ITERATIONS - 1} runs avg)`
          );
        } else {
          driveResults.textContent += `\n❌ Drive ${i + 1}: ${res.error}\n`;
        }
      }
      summary.textContent = summaries.join("\n");
      if (inlineOutput) inlineOutput.value = '';
      hideSpeedtestHamster();
    });

    // 🛑 Reset
    document.getElementById("reset-speedtest")?.addEventListener("click", () => {
      netResults.textContent = "📡 No results yet.";
      driveResults.textContent = "💾 No results yet.";
      summary.textContent = "⚡ Ready to test.";
      if (inlineProgress) inlineProgress.value = 0;
      if (inlineOutput) inlineOutput.value = '';
      hideSpeedtestHamster();
      selectedDrivePaths.fill("");
      updateDrivePathsDisplay();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
