// =====================================================
// ⚡ renderer.speed-test.js – Connected to Backend
// =====================================================
console.log("⚡ Speed Test Panel Loaded");

(function initSpeedTest() {
  const start = () => {
    const ipc = window.electron;

    const translate = (key, fallback) => {
      const t = window.i18n?.t;
      if (typeof t === "function") {
        const translated = t(key);
        if (translated) return translated;
      }
      return fallback;
    };

    const translateTemplate = (key, fallback, replacements = {}) => {
      const template = translate(key, fallback);
      return Object.entries(replacements).reduce((str, [token, value]) => {
        const pattern = new RegExp(`{{${token}}}`, "g");
        return str.replace(pattern, () => String(value ?? ""));
      }, template);
    };

    const clampInt = (value, min, max) => {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) return min;
      return Math.min(max, Math.max(min, n));
    };

    const TOOLTIP_ALLOWED_TAGS = new Set(["DIV", "SPAN", "UL", "LI", "STRONG", "EM", "BR"]);
    const TOOLTIP_ALLOWED_ATTRS = new Set(["class"]);

    function sanitizeTooltipFragment(fragment) {
      const elements = [];
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        elements.push(walker.currentNode);
      }

      for (const el of elements) {
        if (!TOOLTIP_ALLOWED_TAGS.has(el.tagName)) {
          // Replace any disallowed element with its plain text
          el.replaceWith(document.createTextNode(el.textContent || ""));
          continue;
        }

        // Strip all attributes except a tiny allowlist (prevents on* handlers, style, href, etc.)
        for (const attr of Array.from(el.attributes)) {
          if (!TOOLTIP_ALLOWED_ATTRS.has(attr.name)) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }

    function setTooltipContentSafe(target, html) {
      if (!target) return;
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      sanitizeTooltipFragment(tpl.content);
      target.replaceChildren(tpl.content);
    }

    // ─── Speed Test: panel overview tooltip ─────────────────────────────────
    const overviewTooltip = document.getElementById("speed-test-overview-tooltip");
    if (overviewTooltip && !overviewTooltip.dataset.bound) {
      setTooltipContentSafe(overviewTooltip, `
        <div class="tooltip-content">
          <div class="tooltip-header">${translate("speedTestOverviewHeader", "SPEED TEST — Technical Overview")}</div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">${translate("speedTestOverviewPurposeTitle", "Core capabilities")}</span>
            <ul class="tooltip-list">
              <li>${translate("speedTestOverviewPurpose1", "Probe basic network latency and throughput against the automation backend.")}</li>
              <li>${translate("speedTestOverviewPurpose2", "Measure sequential and random read/write performance of local or shared drives.")}</li>
              <li>${translate("speedTestOverviewPurpose3", "Sanity-check whether a volume is appropriate for ingest, proxy, or export workloads.")}</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">${translate("speedTestOverviewWorkflowTitle", "Under the hood")}</span>
            <ul class="tooltip-list">
              <li>${translate("speedTestOverviewUnderTheHood1", "Network tests call a small backend service that reports round-trip time and effective transfer rates.")}</li>
              <li>${translate("speedTestOverviewUnderTheHood2", "Drive tests write and read temporary test files using either sequential or random access patterns.")}</li>
              <li>${translate("speedTestOverviewUnderTheHood3", "Progress and results are streamed back to the UI so you can compare drives or environments.")}</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">${translate("speedTestOverviewNotesTitle", "Operational notes")}</span>
            <ul class="tooltip-list">
              <li>${translate("speedTestOverviewNotes1", "Results are indicative, not a replacement for dedicated benchmarking tools.")}</li>
              <li>${translate("speedTestOverviewNotes2", "Short tests may be optimistic due to OS caching; larger sizes better approximate export workloads.")}</li>
            </ul>
          </div>
        </div>
      `);
      overviewTooltip.dataset.bound = "true";
    }

    // 🧩 Drive Test Tooltip (identical to Adobe Automate)
    const speedTooltip = document.getElementById("speedtest-info-tooltip");
    if (speedTooltip) {
      setTooltipContentSafe(speedTooltip, `
        <div class="tooltip-content">
          <div class="tooltip-header">${translate("driveTestInfoHeader", "Drive Test Info")}</div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">${translate("driveTestInfoModeTitle", "Mode")}</span>
            <ul class="tooltip-list">
              <li>${translate("driveTestInfoSequential", "<strong>Sequential:</strong> Measures sustained throughput for large, continuous files. Writes are flushed to disk; reads may be influenced by OS cache.")}</li>
              <li>${translate("driveTestInfoRandom", "<strong>Random:</strong> Tests many small reads/writes across the drive — highlights latency and metadata/cache behavior.")}</li>
            </ul>
          </div>

          <div class="tooltip-section">
            <span class="tooltip-subtitle">${translate("driveTestInfoSizeTitle", "Test Size")}</span>
            <ul class="tooltip-list">
              <li>${translate("driveTestInfoSizeSmall", "<strong>Small (256-512 MiB):</strong> Quick test — can be optimistic due to OS caching.")}</li>
              <li>${translate("driveTestInfoSizeMedium", "<strong>Medium (1 GiB):</strong> Better balance for real-world file transfers.")}</li>
              <li>${translate("driveTestInfoSizeLarge", "<strong>Large (2 GiB):</strong> Best for sustained throughput (exports/proxies) and reduced cache effects.")}</li>
            </ul>
          </div>
        </div>
      `);
    }

    const netBtn = document.getElementById("start-network-test");
    let networkTestActive = false;

    function setNetworkTestActive(active) {
      networkTestActive = active;
      if (!netBtn) return;
      netBtn.disabled = active;
      netBtn.classList.toggle("is-busy", active);
      if (active) {
        if (!netBtn.dataset.originalLabel) {
          netBtn.dataset.originalLabel = netBtn.textContent;
        }
        netBtn.textContent = translate("speedTestRunningLabel", "Running...");
      } else if (netBtn.dataset.originalLabel) {
        netBtn.textContent = netBtn.dataset.originalLabel;
        delete netBtn.dataset.originalLabel;
      }
    }

    const netResults = document.getElementById("network-test-results");
    const driveResults = document.getElementById("drive-test-results");
    const networkInlineStatus = document.getElementById("network-test-inline-status");
    // Inline loader elements (new)
    const inlineProgress = document.getElementById("speedtest-progress");
    const inlineOutput = document.getElementById("speedtest-progress-output");
    const liveStatus =
      document.getElementById("speedtest-live-status") ||
      (() => {
        const region = document.createElement("div");
        region.id = "speedtest-live-status";
        region.setAttribute("role", "status");
        region.setAttribute("aria-live", "polite");
        // Inline visually-hidden pattern to avoid layout shifts
        Object.assign(region.style, {
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0
        });
        driveResults?.parentElement?.appendChild(region);
        return region;
      })();

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

    // Drive-test hamster (bottom controls row)
    function showSpeedtestHamsterForDrives() {
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

    function hideSpeedtestHamsterForDrives() {
      const status = document.getElementById('speedtest-job-status');
      if (!status) return;
      delete status.dataset.jobActive;
      status.style.display = 'none';
      status.querySelector('.wheel-and-hamster')?.remove();
    }

    // Network-test hamster (on the Run Network Test row)
    function showSpeedtestHamsterForNetwork() {
      const status = document.getElementById('speedtest-network-job-status');
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

    function hideSpeedtestHamsterForNetwork() {
      const status = document.getElementById('speedtest-network-job-status');
      if (!status) return;
      delete status.dataset.jobActive;
      status.style.display = 'none';
      status.querySelector('.wheel-and-hamster')?.remove();
    }

    function setNetworkInlineStatus(message) {
      if (!networkInlineStatus) return;
      if (message) {
        networkInlineStatus.textContent = message;
        networkInlineStatus.style.visibility = "visible";
        networkInlineStatus.setAttribute("aria-hidden", "false");
      } else {
        networkInlineStatus.textContent = "";
        networkInlineStatus.style.visibility = "hidden";
        networkInlineStatus.setAttribute("aria-hidden", "true");
      }
    }

    // 🌐 Network Test
    netBtn?.addEventListener("click", async () => {
      if (networkTestActive) return;
      setNetworkTestActive(true);
      // Network test uses its own hamster; no shared progress bar
      showSpeedtestHamsterForNetwork();
      setNetworkInlineStatus(
        translate("runningNetworkTest", "⏳ Running network speed test...")
      );
      try {
        const res = await ipc.invoke("run-network-test");
        if (res.success) {
          netResults.textContent = translateTemplate(
            "networkTestResultSummary",
            "Download: {{download}} Mbps\\nUpload: {{upload}} Mbps\\nPing: {{ping}} ms",
            {
              download: res.download,
              upload: res.upload,
              ping: res.ping
            }
          );
        } else {
          netResults.textContent = translateTemplate("networkTestError", "❌ {{error}}", {
            error: res.error
          });
        }
      } catch (err) {
        netResults.textContent = translateTemplate(
          "networkTestFailure",
          "❌ Network test failed: {{error}}",
          {
            error: err?.message || "Unknown error."
          }
        );
      } finally {
        setNetworkTestActive(false);
        hideSpeedtestHamsterForNetwork();
        setNetworkInlineStatus("");
      }
    });

    // 💽 Drive Tests
    const drivePathsDisplay = document.getElementById("selected-drive-paths");
    const testSelectedDrivesBtn = document.getElementById("test-selected-drives");
    const testSizeSelect = document.getElementById("test-size");
    const modeSelect = document.getElementById("io-mode");
    const resetSpeedtestBtn = document.getElementById("reset-speedtest");
    const driveSelectionButtons = [
      document.getElementById("select-drive-1"),
      document.getElementById("select-drive-2"),
      document.getElementById("select-drive-3")
    ];
    let driveTestActive = false;
    let driveCancelRequested = false;

    function setResetSpeedtestButtonMode(mode) {
      if (!resetSpeedtestBtn) return;
      const key = mode === "cancel" ? "cancelSpeedTest" : "resetSpeedTest";
      resetSpeedtestBtn.dataset.mode = mode;
      resetSpeedtestBtn.setAttribute("data-i18n", key);
      const t = window.i18n?.t;
      resetSpeedtestBtn.textContent =
        typeof t === "function"
          ? t(key)
          : mode === "cancel"
            ? "Cancel"
            : "Reset";
    }

    function setDriveTestActive(active) {
      driveTestActive = active;
      const cursorTarget = document.body;
      if (cursorTarget) {
        cursorTarget.style.cursor = active ? "progress" : "";
      }
      if (testSelectedDrivesBtn) {
        testSelectedDrivesBtn.disabled = active;
        testSelectedDrivesBtn.dataset.running = active ? "true" : "false";
      }
      driveSelectionButtons.forEach(btn => {
        if (!btn) return;
        btn.disabled = active;
        if (active) {
          btn.dataset.running = "true";
        } else {
          delete btn.dataset.running;
        }
      });

      // Reset button becomes Cancel during drive tests
      if (resetSpeedtestBtn) {
        resetSpeedtestBtn.disabled = false;
        setResetSpeedtestButtonMode(active ? "cancel" : "reset");
      }

      if (liveStatus) {
        liveStatus.textContent = active
          ? translate("speedTestRunningStatus", "Speed test running. Controls are temporarily disabled.")
          : translate("speedTestIdleStatus", "Speed test idle. Controls are available.");
      }
    }

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

    // Test size options (MiB/GiB)
    populateDropdown("test-size", [
      { label: translate("speedTestSize256", "256 MiB"), value: 256 },
      { label: translate("speedTestSize512", "512 MiB"), value: 512 },
      { label: translate("speedTestSize1024", "1 GiB"), value: 1024 },
      { label: translate("speedTestSize2048", "2 GiB"), value: 2048 }
    ], 1024);

    // Mode options
    populateDropdown("io-mode", [
      { label: translate("sequential", "Sequential"), value: "sequential" },
      { label: translate("random", "Random"), value: "random" }
    ], "sequential");

    // (Defaults are applied by populateDropdown above)
    const selectedDrivePaths = ["", "", ""];
    const ITERATIONS = 5; // main process also uses 5; first is warm-up
    const BYTES_PER_MIB = 1024 * 1024;
    const PHASES_PER_ITERATION = 2; // write + read per iteration

    let totalBytes = 0;
    let completedBytes = 0;

    // Smooth progress animation state
    let displayedPct = 0;
    let targetPct = 0;
    let progressAnimFrame = null;

    function cancelSmoothProgress() {
      if (progressAnimFrame != null) {
        cancelAnimationFrame(progressAnimFrame);
        progressAnimFrame = null;
      }
    }

    function startSmoothProgress() {
      if (!inlineProgress) return;

      // Make sure bar + number are visible when animating
      inlineProgress.style.display = "";
      if (inlineOutput) inlineOutput.style.display = "";

      const duration = 300; // ms to ease toward each new target
      let lastTime = null;

      function step(timestamp) {
        if (!lastTime) lastTime = timestamp;
        const dt = timestamp - lastTime;
        lastTime = timestamp;

        const diff = targetPct - displayedPct;
        if (Math.abs(diff) < 0.1) {
          displayedPct = targetPct;
        } else {
          const factor = Math.min(dt / duration, 1);
          displayedPct += diff * factor;
        }

        // Clamp to [0, 100]
        if (displayedPct < 0) displayedPct = 0;
        if (displayedPct > 100) displayedPct = 100;

        inlineProgress.value = displayedPct;
        if (inlineOutput) {
          inlineOutput.value = displayedPct >= 100 ? "" : Math.round(displayedPct);
        }

        const stillAnimating =
          Math.abs(targetPct - displayedPct) >= 0.1 &&
          displayedPct < 100;

        if (stillAnimating) {
          progressAnimFrame = requestAnimationFrame(step);
        } else {
          progressAnimFrame = null;
        }
      }

      if (progressAnimFrame == null) {
        progressAnimFrame = requestAnimationFrame(step);
      }
    }

    function resetProgressUI() {
      cancelSmoothProgress();
      displayedPct = 0;
      targetPct = 0;
      totalBytes = 0;
      completedBytes = 0;
      if (inlineProgress) {
        inlineProgress.value = 0;
        inlineProgress.style.display = "";
      }
      if (inlineOutput) {
        inlineOutput.value = "";
        inlineOutput.style.display = "";
      }
    }

    function updateDrivePathsDisplay() {
      const text = selectedDrivePaths
        .map((p, idx) => (
          p
            ? translateTemplate("drivePathLabel", "Drive {{index}}: {{path}}", {
              index: idx + 1,
              path: p
            })
            : translateTemplate("drivePathNoneLabel", "Drive {{index}}: (none)", {
              index: idx + 1
            })
        ))
        .join("\n");
      drivePathsDisplay.textContent = text || translate("noDrivesSelected", "No drives selected");
    }

    [1, 2, 3].forEach(i => {
      const selectBtn = document.getElementById(`select-drive-${i}`);
      selectBtn?.addEventListener("click", async () => {
        if (driveTestActive) return;

        let folder = null;
        try {
          folder = typeof ipc?.selectFolder === "function"
            ? await ipc.selectFolder()
            : await ipc.invoke("select-folder");
        } catch (err) {
          console.error("❌ select-folder failed:", err);
          drivePathsDisplay.textContent = translateTemplate(
            "driveSelectFolderError",
            "❌ Failed to select drive folder: {{error}}",
            { error: err?.message || "Unknown error." }
          );
          return;
        }
        if (folder) {
          selectedDrivePaths[i - 1] = folder;
          updateDrivePathsDisplay();
        }
      });
    });

    testSelectedDrivesBtn?.addEventListener("click", async () => {
      if (driveTestActive) return;

      const paths = selectedDrivePaths.filter(Boolean);
      if (!paths.length) return;

      setDriveTestActive(true);

      driveCancelRequested = false;
      try {
        await ipc.invoke("reset-drive-test-cancel");
      } catch {
        // ignore if handler isn't wired yet
      }
      driveResults.setAttribute("aria-live", "polite");
      driveResults.setAttribute("role", "status");
      driveResults.textContent = "";
      const testSize = clampInt(testSizeSelect?.value || 1024, 1, 2048);
      const mode = modeSelect?.value || "sequential";
      const handler = mode === "random" ? "run-drive-test-random" : "run-drive-test";

      try {
        // Compute total bytes for this batch of tests
        const phasesPerIteration = PHASES_PER_ITERATION; // write + read
        const plannedTotalBytes = paths.length * ITERATIONS * phasesPerIteration * testSize * BYTES_PER_MIB;
        completedBytes = 0;
        displayedPct = 0;
        targetPct = 0;

        // ✅ Make sure we don't double-bind progress
        ipc.removeAllListeners?.("drive-test-progress");
        ipc.on("drive-test-progress", (_event, payload) => {
          if (driveCancelRequested) return;
          if (!payload || typeof payload.bytes !== "number" || totalBytes <= 0) {
            return;
          }
          const delta = Math.max(0, payload.bytes);
          completedBytes = Math.min(completedBytes + delta, totalBytes);
          const pct = (completedBytes / totalBytes) * 100;
          targetPct = pct > 100 ? 100 : pct;
          startSmoothProgress();
        });

        // reset inline loader + show hamster (drive tests only)
        resetProgressUI();
        totalBytes = plannedTotalBytes;
        showSpeedtestHamsterForDrives();

        for (let i = 0; i < selectedDrivePaths.length; i++) {
          if (driveCancelRequested) break;
          const path = selectedDrivePaths[i];
          if (!path) continue;
          driveResults.textContent += `\n${translateTemplate(
            "driveTestInProgress",
            "⏳ Testing Drive {{index}} at {{path}}...",
            { index: i + 1, path }
          )}`;
          const res = await ipc.invoke(handler, path, testSize);
          if (res?.cancelled) {
            driveCancelRequested = true;
            driveResults.textContent += `\n${translate("driveTestCancelled", "🛑 Drive test cancelled.")}\n`;
            break;
          }
          if (res.success) {
            driveResults.textContent += `\n${translateTemplate(
              "driveTestResultSummary",
              "Drive {{index}} Results:\\n   🔹 Write: {{write}} MiB/s (min: {{writeMin}}, max: {{writeMax}})\\n   🔹 Read:  {{read}} MiB/s (min: {{readMin}}, max: {{readMax}})\\n",
              {
                index: i + 1,
                write: res.write,
                writeMin: res.writeMin,
                writeMax: res.writeMax,
                read: res.read,
                readMin: res.readMin,
                readMax: res.readMax
              }
            )}`;
          } else {
            driveResults.textContent += `\n${translateTemplate(
              "driveTestError",
              "❌ Drive {{index}}: {{error}}\\n",
              {
                index: i + 1,
                error: res.error
              }
            )}`;
          }
        }
        // Force a clean glide to 100% when tests are complete
        if (!driveCancelRequested && inlineProgress) {
          targetPct = 100;
          startSmoothProgress();
        }

        if (!driveCancelRequested && inlineOutput) {
          // Clear the numeric label once we've hit 100
          inlineOutput.value = '';
        }
      } catch (err) {
        if (driveCancelRequested) {
          driveResults.textContent += `\n${translate("driveTestCancelled", "🛑 Drive test cancelled.")}\n`;
        } else {
          driveResults.textContent += `\n${translateTemplate(
            "driveTestFailure",
            "❌ Drive test failed: {{error}}",
            {
              error: err?.message || err || "Unknown error."
            }
          )}`;
        }
      } finally {
        const teardown = () => {
          if (inlineProgress) inlineProgress.style.display = "none";
          if (inlineOutput) inlineOutput.style.display = "none";
          hideSpeedtestHamsterForDrives();
          setDriveTestActive(false);
        };

        // 🔥 Hide progress bar and hamster together after a short delay
        // so the 100% state is actually visible.
        if (inlineProgress || inlineOutput) {
          setTimeout(teardown, 400);
        } else {
          teardown();
        }

        // After the test completes, reset drive selection back to "none"
        selectedDrivePaths.fill("");
        updateDrivePathsDisplay();
      }
    });

    // 🛑 Reset / Cancel
    resetSpeedtestBtn?.addEventListener("click", async () => {
      // If a drive test is in-flight, treat this as "Cancel"
      if (driveTestActive) {
        if (driveCancelRequested) return;
        driveCancelRequested = true;

        if (resetSpeedtestBtn) {
          resetSpeedtestBtn.disabled = true;
        }

        driveResults.textContent += `\n${translate("driveCancelRequested", "🛑 Cancel requested...")}`;
        try {
          await ipc.invoke("cancel-drive-test");
        } catch {
          // ignore if handler isn't wired yet
        }
        return;
      }

      netResults.textContent = translate("networkNoResults", "📡 No results yet.");
      driveResults.textContent = translate("driveNoResults", "💾 No results yet.");
      resetProgressUI();
      hideSpeedtestHamsterForDrives();
      hideSpeedtestHamsterForNetwork();
      selectedDrivePaths.fill("");
      updateDrivePathsDisplay();
      setDriveTestActive(false);

      try {
        await ipc.invoke("reset-drive-test-cancel");
      } catch {
        // ignore if handler isn't wired yet
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
