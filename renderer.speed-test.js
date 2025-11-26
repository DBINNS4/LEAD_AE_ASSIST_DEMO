// =====================================================
// ⚡ renderer.speed-test.js – Demo-only (no backend wiring)
// =====================================================
console.log("⚡ Speed Test Panel Loaded (demo mode)");

(function initSpeedTestDemo() {
  const start = () => {
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
              <li><strong>Run</strong> - read the results to judge performance.</li>
            </ul>
          </div>
        </div>
      `;
      overviewTooltip.dataset.bound = "true";
    }

    // 🧩 Drive Test Tooltip (UI-only)
    const speedTooltip = document.getElementById("speedtest-info-tooltip");
    if (speedTooltip && !speedTooltip.dataset.bound) {
      speedTooltip.innerHTML = `
        <div class="tooltip-content">
          <div class="tooltip-header">Drive Test Info</div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">Mode</span>
            <ul class="tooltip-list">
              <li><strong>Sequential:</strong> Measures sustained read/write speed for large, continuous files (e.g., video exports).</li>
              <li><strong>Random:</strong> Tests many small reads and writes across the drive — shows responsiveness for cache and metadata.</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">Test Size</span>
            <ul class="tooltip-list">
              <li><strong>Small (256–512 MB):</strong> Quick cache-level test — often optimistic.</li>
              <li><strong>Medium (1 GB):</strong> Balanced real-world performance for file transfers.</li>
              <li><strong>Large (2 GB):</strong> Measures sustained throughput for long-duration exports or proxy generation.</li>
            </ul>
          </div>
        </div>
      `;
      speedTooltip.dataset.bound = "true";
    }

    // 🧩 Dropdown helper (same behavior as before, minus any jobs)
    function populateDropdown(selectId, values, defaultValue) {
      // Preferred: shared dropdown helper
      if (typeof window.setupStyledDropdown === "function") {
        window.setupStyledDropdown(selectId, values);
        if (typeof window.setDropdownValue === "function" && defaultValue != null) {
          window.setDropdownValue(selectId, String(defaultValue));
        }
        return;
      }

      // Fallback: minimal inline wiring so the dropdown still works
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

    // Deliberately no event listeners here:
    // - Run Network Speed Test
    // - Select Drive 1/2/3
    // - Test Speed
    // - Reset
    // All still exist in the DOM and show hover/press via CSS, but do nothing.
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
