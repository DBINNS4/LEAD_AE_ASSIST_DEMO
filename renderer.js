// =====================================================
// 📂 renderer.js – Manages Tab Switching and Panel Logic
// =====================================================

// Defer license logs until preload finishes and object is available
function logLicenseStatus() {
  if (window.license) {
    // License tier and feature info available in debug mode
  } else {
    console.warn("⚠️ License API unavailable – running outside Electron?");
  }
}

// 🌐 Declare global ipc once for all panels
window.ipc = window.electron;
const ipc = window.ipc ?? window.electron;

// Prevent unintended form submissions that cause beeps
document.addEventListener('submit', e => {
  e.preventDefault();
  console.warn('⚠️ Prevented unintended form submit');
});

// Shared styled dropdown helper so demo panels don't depend on the full app bundle
if (typeof window.setupStyledDropdown !== 'function') {
  window.setupStyledDropdown = function setupStyledDropdown(hiddenId, values) {
    const hidden = document.getElementById(hiddenId);
    if (!hidden) return;

    const wrapper = hidden.closest('.dropdown-wrapper');
    const chosen = wrapper?.querySelector('.chosen-value');
    const list   = wrapper?.querySelector('.value-list');

    if (!wrapper || !list || !chosen) return;

    // Clear any existing items and rebuild from the provided values
    list.innerHTML = '';
    values.forEach(v => {
      const li = document.createElement('li');
      li.textContent = v.label;
      li.dataset.value = String(v.value);

      li.addEventListener('click', () => {
        hidden.value = String(v.value);
        chosen.value = v.label;

        list.classList.remove('open');
        chosen.classList.remove('open');
        wrapper.classList.remove('open');

        const ev = new Event('change', { bubbles: true });
        hidden.dispatchEvent(ev);
      });

      list.appendChild(li);
    });
  };
}

if (typeof window.setDropdownValue !== 'function') {
  window.setDropdownValue = function setDropdownValue(hiddenId, value) {
    const hidden = document.getElementById(hiddenId);
    if (!hidden) return;

    const wrapper = hidden.closest('.dropdown-wrapper');
    const chosen = wrapper?.querySelector('.chosen-value');
    const list   = wrapper?.querySelector('.value-list');

    if (!wrapper || !list || !chosen) return;

    const match = Array.from(list.children).find(
      li => li.dataset.value === String(value)
    );
    if (!match) return;

    hidden.value = match.dataset.value;
    chosen.value = match.textContent;

    const ev = new Event('change', { bubbles: true });
    hidden.dispatchEvent(ev);
  };
}


// 🌐 Shared Watch Mode configs for panels
const PANEL_PRESET_EXTENSIONS = ['.json'];

// Central mapping of per-panel job UI (summary + progress)
const PANEL_JOB_UI = {
  transcode: {
    progressId: 'transcode-progress',
    summaryId: 'transcode-progress-output',
  },
  transcribe: {
    progressId: null,
    summaryId: 'transcribe-summary',
  },
  'adobe-utilities': {
    progressId: 'adobe-progress',
    summaryId: 'job-preview-box',
  },
};

window.watchConfigs = {
  ingest: null,
  transcode: null,
  transcribe: null
};

// Validation helpers for each panel's watch config
window.watchValidators = {};

if (ipc?.on) {
  ipc.on('auto-connect-leadae', () => {
    console.log('🔌 Auto-connect trigger from main');
    if (typeof window.connectToLeadAE === 'function') {
      window.connectToLeadAE(true);
    }
  });

  ipc.on('transcribe-open-reconcile', (_e, discrepancies) => {
    const start = () => window.reconcileDiscrepancies(discrepancies);
    if (typeof window.reconcileDiscrepancies === 'function') {
      start();
    } else {
      loadPanelScript('reconcile');
      window.addEventListener('reconcile-ready', start, { once: true });
    }
  });

}

// Track loaded panel scripts to avoid duplicate event handlers
const loadedPanels = new Set();

// Name of the home panel (no active home panel currently)
const HOME_PANEL = 'home';

// Dynamically loads a JavaScript file for a given panel
function loadPanelScript(panelName) {
  if (loadedPanels.has(panelName)) {
    return;
  }
  const scriptId = `panel-script-${panelName}`;

  // 📥 Create and load new script element
  const script = document.createElement("script");
  script.id = scriptId;
  // In file:// pages, absolute filesystem paths in <script src> won't resolve.
  // Always load panel scripts relative to index.html.
  const preferDev = !!window.electron?.DEBUG_UI; /* exposed in preload */
  const forcePlainScript = panelName === 'subtitleEditor';
  const useObfuscated = !preferDev && !forcePlainScript;
  const primarySrc = useObfuscated
    ? `./dist-obfuscated/renderer.${panelName}.js`
    : `./renderer.${panelName}.js`;
  const fallbackSrc = useObfuscated
    ? `./renderer.${panelName}.js`
    : (forcePlainScript ? null : `./dist-obfuscated/renderer.${panelName}.js`);
  script.src = primarySrc;
  script.onerror = () => {
    if (!fallbackSrc || fallbackSrc === primarySrc) {
      console.error(`❌ Failed to load panel script ${primarySrc}`);
      return;
    }
    const fallback = document.createElement('script');
    fallback.id = `${scriptId}-fallback`;
    fallback.src = fallbackSrc;
    fallback.onerror = () => {
      console.error(`❌ Failed to load fallback renderer.${panelName}.js`);
    };
    document.body.appendChild(fallback);
  };
  script.onload = () => {};
  document.body.appendChild(script);
  loadedPanels.add(panelName);  
}

window.addEventListener('reconcile-complete', e => {
  ipc?.send('transcribe-final-words', e.detail);
});

function updateToolbar(panelId) {
  const detail = { panelId: panelId ?? null };
  document.dispatchEvent(new CustomEvent('toolbar-updated', { detail }));
}

// =====================================
// 🚀 Initialize Tabs & AI on Page Load
// =====================================
document.addEventListener("DOMContentLoaded", () => {
  // If this is the subtitle-editor pop-out, bootstrap only what it needs.
  const params = new URLSearchParams(location.search);
  if (params.get('win') === 'subtitle-editor') {
    document.body.classList.add('subtitle-editor-window');
    loadPanelScript('subtitleEditor');
    return; // Skip tabs/toolbars/etc. in the pop-out
  }

  // Start button handler (unchanged wiring to build cfg)
  // window.electron.invoke('queue-add-clone', cfg);
  const licenseAvailable = typeof window.license !== "undefined";
  logLicenseStatus();

  window.translatePage?.();

  if ("Notification" in window && Notification.permission !== "granted") {
    Notification.requestPermission();
  }
  const tabs = document.querySelectorAll(".tab");

  // ✅ License check for tab visibility (async‑safe)
  if (licenseAvailable && window.license?.isFeatureEnabled) {
    tabs.forEach(tab => {
      const panel = tab.getAttribute("data-panel");
      Promise
        .resolve(window.license.isFeatureEnabled(panel))
        .then(isEnabled => { if (!isEnabled) tab.style.display = 'none'; })
        .catch(() => { /* fail open in dev */ });
    });
  }
  
  const panels = document.querySelectorAll(".panel-section");
  const app = document.getElementById("app");
  const mainPanel = document.querySelector('.main-panel');
  let activePanel = null;

  const getCloneProgressElements = () => ({
    bar: document.getElementById('clone-progress-bar')
      ?? document.getElementById('clone-progress')
      ?? document.getElementById('progressBar'),
    eta: document.getElementById('clone-progress-eta')
      ?? document.getElementById('clone-eta')
      ?? document.getElementById('eta'),
    status: document.getElementById('clone-progress-status')
      ?? document.getElementById('clone-status')
      ?? document.getElementById('status')
  });

  const updateCloneStatus = text => {
    const { status } = getCloneProgressElements();
    if (status) {
      status.textContent = text;
    } else if (text) {
      console.log(text);
    }
  };

  if (ipc?.on) {
    ipc.on('clone:progress', (_evt, p) => {
      const { bar, eta, status } = getCloneProgressElements();
      if (p?.phase === 'scan') {
        updateCloneStatus('Scanning selection…');
        return;
      }
      if (p?.phase === 'start') {
        updateCloneStatus(`Copying ${p.files ?? 0} file(s)…`);
        if (bar) {
          bar.max = p.totalBytes || 1;
          bar.value = 0;
        }
        if (eta) {
          eta.textContent = '';
        }
        return;
      }
      if (p?.phase === 'copy') {
        if (bar) {
          bar.value = p.copiedBytes ?? bar.value ?? 0;
        }
        updateCloneStatus(p?.file ? `Copying: ${p.file}` : 'Copying…');
        if (eta && p.totalBytes) {
          const pct = Math.floor(((p.copiedBytes ?? 0) / p.totalBytes) * 100);
          eta.textContent = `${pct}%`;
        }
        return;
      }
      if (p?.phase === 'done') {
        if (bar) {
          bar.value = p.totalBytes ?? bar.max ?? bar.value ?? 0;
        }
        updateCloneStatus('Done.');
        if (eta) {
          eta.textContent = '100%';
        }
        return;
      }

      if (!status) {
        console.log('clone:progress', p);
      }
    });

    ipc.on('clone:done', (_evt, msg) => {
      if (!msg) return;
      if (msg.ok) {
        updateCloneStatus('Clone complete.');
      } else {
        updateCloneStatus(`Clone failed: ${msg.error}`);
      }
    });
  }

  // Load Project Organizer logic but keep panel hidden
  loadPanelScript('project-organizer');
  document.getElementById('project-organizer')?.classList.add('hidden');

  // Load Speed Test logic but keep panel hidden
  loadPanelScript('speed-test');
  document.getElementById('speed-test')?.classList.add('hidden');

  // 🔧 Load Preferences logic early so webhook visibility matches saved state
  loadPanelScript('preferences');
  document.getElementById('preferences')?.classList.add('hidden');

  // Hide all panels initially
  panels.forEach(p => p.classList.add("hidden"));
  document.body.classList.add('home-active');
  mainPanel?.classList.remove('hidden');

  updateToolbar('ingest');

  document.querySelectorAll('.delete-preset-btn').forEach(btn => {
    const panel = btn.dataset.panel;
    const hiddenInput = document.getElementById(`${panel}-preset`);
    const dropdownInput = hiddenInput?.previousElementSibling?.previousElementSibling;

    hiddenInput?.addEventListener('change', () => {
      btn.disabled = !hiddenInput.value;
    });

    dropdownInput?.addEventListener('input', () => {
      if (!dropdownInput.value) {
        hiddenInput.value = '';
        btn.disabled = true;
      }
    });

    btn.addEventListener('click', async () => {
      const presetFile = hiddenInput?.value;
      const presetName =
        dropdownInput?.value ||
        hiddenInput?.value?.replace(/\.json$/i, '') ||
        '(unknown)';
      if (panel !== 'leadae' && !presetFile) return;

      const confirmed = await ipc.invoke(
        'show-confirm-dialog',
        `Are you sure you want to delete the preset "${presetName}"?`
      );
      if (!confirmed) return;

      try {
        let success;
        if (panel === 'leadae') {
          success = await ipc.invoke('delete-leadae-preset', { presetName });
        } else {
          success = await ipc.invoke('delete-panel-preset', {
            panel,
            presetName: presetFile
          });
        }

        if (success) {
          console.log(`🗑️ Deleted preset: ${presetName}`);
          ipc.send('preset-deleted', panel);
          hiddenInput.value = '';
          dropdownInput.value = '';
          btn.disabled = true;

          // 🔄 Force dropdown rebuild for the current panel
          if (typeof window.refreshPanelPresets === 'function') {
            await window.refreshPanelPresets(panel);
          }

          const listEl = hiddenInput?.previousElementSibling;
          if (listEl) {
            listEl.innerHTML = '';
            const presets =
              panel === 'leadae'
                ? await ipc.invoke('list-leadae-presets')
                : await ipc.invoke('list-panel-presets', panel);
            presets.forEach(p => {
              const li = document.createElement('li');
              li.textContent = p.name;
              li.addEventListener('click', () => {
                dropdownInput.value = p.name;
                hiddenInput.value = panel === 'leadae' ? p.name : p.file;
                hiddenInput.dispatchEvent(new Event('change'));
              });
              listEl.appendChild(li);
            });
          }

          alert(`✅ Preset "${presetName}" deleted successfully.`);
        } else {
          alert(`❌ Could not delete preset "${presetName}".`);
        }
      } catch (err) {
        console.error('❌ Failed to delete preset:', err);
      }
    });
  });

  // === Handle Tab Clicks ===
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetPanel = tab.getAttribute("data-panel");
      const isActive = tab.classList.contains("active");

      // === CLOSE CURRENT PANEL ===
      if (isActive) {
        tab.classList.remove("active");
        panels.forEach(p => {
          p.classList.add("content-hidden");
          p.classList.add("hidden");
        });
        app.classList.remove("panel-open");
        ipc?.send?.("ui:set-collapsed", true);
        activePanel = null;
        document.body.classList.add("home-active");
        updateToolbar(null);
        return;
      }

      // === SWITCH TO ANOTHER PANEL ===
      const wasCollapsed = !app.classList.contains("panel-open");

      tabs.forEach(t => t.classList.remove("active"));
      panels.forEach(p => p.classList.add("hidden"));

      tab.classList.add("active");
      const selectedPanel = document.getElementById(targetPanel);
      selectedPanel?.classList.remove("hidden");

      // If the app was collapsed, hide content during expansion
      if (wasCollapsed) {
        selectedPanel?.classList.add("content-hidden");
        ipc?.send?.("ui:set-collapsed", false);
        // reveal after expansion only once
        setTimeout(() => {
          selectedPanel?.classList.remove("content-hidden");
        }, 250);
      } else {
        // Instantly show contents when switching panels
        selectedPanel?.classList.remove("content-hidden");
        ipc?.send?.("ui:set-collapsed", false);
      }

      mainPanel?.classList.remove("hidden");
      app.classList.add("panel-open");
      activePanel = targetPanel;
      document.body.classList.toggle("home-active", targetPanel === HOME_PANEL);
      updateToolbar(targetPanel);
      
      // 🧼 Clear all progress bars and summaries across panels
      Object.values(PANEL_JOB_UI).forEach(cfg => {
        const fill = cfg.progressId
          ? document.getElementById(cfg.progressId)
          : null;
        const summaryEl = cfg.summaryId
          ? document.getElementById(cfg.summaryId)
          : null;

        if (fill) {
          if (fill.tagName === 'PROGRESS') {
            fill.value = 0;
          } else {
            fill.style.width = '0%';
          }
        }

        if (summaryEl) {
          if ('value' in summaryEl) {
            summaryEl.value = '';
          } else {
            summaryEl.textContent = '';
          }
        }
      });

      loadPanelScript(targetPanel);
      
      if (targetPanel === 'adobe-utilities') {
        console.log('⚡ Adobe Automate tab clicked — scheduling Lead AE connect');
        setTimeout(() => {
          if (typeof window.connectToLeadAE === 'function') {
            window.connectToLeadAE(true);
          } else {
            console.warn('⚠️ connectToLeadAE not yet available');
          }
        }, 500); // small delay to ensure script load
      }
    });
  });
  
  
  // 🤖 AI Assistant
  const runAiButton = document.getElementById("run-ai");
  const aiPrompt = document.getElementById("ai-prompt");
  const aiResponse = document.getElementById("ai-response");

  runAiButton?.addEventListener("click", () => {
    const prompt = aiPrompt.value.trim();
    if (!prompt) return;

    aiResponse.textContent = "Thinking...";
    setTimeout(() => {
      aiResponse.textContent = `🧠 Applied to "${activePanel}" panel: "${prompt}"`;
    }, 800);
  });

  function updatePanelSummary(panel, text) {
    const cfg = PANEL_JOB_UI[panel];
    if (!cfg || !cfg.summaryId) return;
    const el = document.getElementById(cfg.summaryId);
    if (!el) return;

    if ('value' in el) {
      // textarea / input / output with value
      el.value = text;
    } else {
      // div/span/etc.
      el.textContent = text;
    }
  }

  function getCancelButton(panel) {
    const map = {
      ingest: 'cancel-ingest',
      transcode: 'cancelTranscode',
      transcribe: 'cancel-transcribe',
      'adobe-utilities': 'cancel-adobe-utilities'
    };
    return document.getElementById(map[panel]);
  }

  ipc?.on('queue-job-added', (_e, job) => {
    updatePanelSummary(job.panel, `🗳️ ${job.panel} job queued.`);
  });

  ipc?.on('queue-job-start', (_e, job) => {
    updatePanelSummary(job.panel, `🚀 ${job.panel} job started.`);
    const btn = getCancelButton(job.panel);
    if (btn) btn.disabled = false;

    const fillMap = {
      ingest: 'ingest-progress',
      transcode: 'transcode-progress',
      transcribe: 'transcribe-progress-fill',
      'adobe-utilities': 'adobe-progress'
    };
    const fillId = fillMap[job.panel];
    const fill = document.getElementById(fillId);
    if (fill) {
      if (fill.tagName === 'PROGRESS') {
        fill.value = 0;
      } else {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth;
        fill.style.transition = '';
      }
    }
  });

  ipc?.on('queue-job-complete', (_e, job) => {
    updatePanelSummary(job.panel, `✅ ${job.panel} job complete.`);
    const btn = getCancelButton(job.panel);
    if (btn) btn.disabled = true;
  });

  ipc?.on('queue-job-failed', (_e, job) => {
    updatePanelSummary(job.panel, `❌ ${job.panel} job failed.`);
    const btn = getCancelButton(job.panel);
    if (btn) btn.disabled = true;
  });

  ipc?.on('queue-job-cancelled', (_e, job) => {
    updatePanelSummary(job.panel, `🛑 ${job.panel} job cancelled.`);
    const btn = getCancelButton(job.panel);
    if (btn) btn.disabled = true;
  });

});

// ======================================================
// 💾 UNIVERSAL PANEL PRESET DROPDOWN
// ======================================================

/**
 * Refresh the panel preset dropdown for a given panel.
 * Handles reading .json files and rebuilding dropdown contents dynamically.
 */
async function refreshPanelPresets(panelId) {
  if (!panelId) return;

  // Panels that have preset dropdowns in the UI
  const panelsWithPresets = [
    'adobe-utilities',
    'ingest',
    'transcode',
    'transcribe',
    'nle-utilities',
    'preferences'
  ];

  if (!panelsWithPresets.includes(panelId)) return;

  const hiddenId = `${panelId}-preset`;
  const hidden = document.getElementById(hiddenId);
  if (!hidden) return;

  try {
    // 🔍 Ask the main process for the preset list
    const presets = await ipc.invoke('list-panel-presets', panelId);

    // Format options for setupStyledDropdown
    const opts = (Array.isArray(presets) ? presets : [])
      .filter(
        p =>
          typeof p?.file === 'string' &&
          PANEL_PRESET_EXTENSIONS.some(ext => p.file.toLowerCase().endsWith(ext))
      )
      .map(p => ({
        value: p.file,
        label: p.name || p.file.replace(/\.json$/i, '')
      }));

    // 🪄 Rebuild dropdown options and restore selection
    if (typeof window.setupStyledDropdown === 'function') {
      window.setupStyledDropdown(hiddenId, opts);
      window.setDropdownValue(hiddenId, hidden.value || '');
    }

    console.log(`✅ Presets refreshed for "${panelId}" (${opts.length} items)`);
  } catch (err) {
    console.error(`❌ Failed to refresh presets for "${panelId}"`, err);
  }
}

// ======================================================
// 🔄 1. Reload presets when the active panel changes
// ======================================================
document.addEventListener('toolbar-updated', e => {
  const panelId = e.detail?.panelId;
  refreshPanelPresets(panelId);
});

// ======================================================
// 🚀 2. Load presets once on app startup
// ======================================================
window.addEventListener('DOMContentLoaded', async () => {
  const defaultPanels = [
    'adobe-utilities',
    'ingest',
    'transcode',
    'transcribe',
    'nle-utilities',
    'preferences'
  ];

  for (const id of defaultPanels) {
    await refreshPanelPresets(id);
  }
});

// ======================================================
// 🧩 3. Auto-refresh after Save or Delete
// ======================================================

// Triggered by renderer processes after preset save
ipc?.on?.('preset-saved', (_e, panelId) => {
  console.log(`💾 Preset saved for ${panelId}, refreshing list`);
  refreshPanelPresets(panelId);
});

// Triggered by renderer processes after preset delete
ipc?.on?.('preset-deleted', (_e, panelId) => {
  console.log(`🗑️ Preset deleted for ${panelId}, refreshing list`);
  refreshPanelPresets(panelId);
});

// ======================================================
// 🎉 4. Optional visual feedback (Toast notifications)
// ======================================================
function showPresetToast(message) {
  let toast = document.getElementById('preset-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'preset-toast';
    toast.style.position = 'fixed';
    toast.style.top = '12px';
    toast.style.right = '20px';
    toast.style.padding = '10px 18px';
    toast.style.background = '#00b894';
    toast.style.color = '#fff';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    toast.style.fontFamily = 'system-ui, sans-serif';
    toast.style.fontSize = '13px';
    toast.style.zIndex = '9999';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transition = 'opacity 0.4s ease';
  setTimeout(() => (toast.style.opacity = '0'), 2000);
}

// Listen for save/delete events for visual feedback
ipc?.on?.('preset-saved', (_e, panelId) => {
  showPresetToast(`✅ Preset saved for ${panelId}`);
});
ipc?.on?.('preset-deleted', (_e, panelId) => {
  showPresetToast(`🗑️ Preset deleted from ${panelId}`);
});

// ===================================
// 💡 Global Theme Toggle Control (Light = On)
// ===================================
document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  // ✅ Checked means LIGHT MODE
  const savedTheme = localStorage.getItem('theme') || 'light';
  const isLight = savedTheme === 'light';
  document.body.classList.toggle('dark-mode', !isLight);
  themeToggle.checked = isLight;

  const broadcast = (theme) => {
    document.dispatchEvent(
      new CustomEvent('theme-toggle-updated', { detail: { theme } })
    );
  };

  themeToggle.addEventListener('change', () => {
    const isLightNow = themeToggle.checked;
    const newTheme = isLightNow ? 'light' : 'dark';
    document.body.classList.toggle('dark-mode', !isLightNow);
    localStorage.setItem('theme', newTheme);
    broadcast(newTheme);
  });
});
