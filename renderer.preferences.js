/* global setupStyledDropdown */
(() => {

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  const preferencesPath = window.electron.resolvePath("config", "state.json");

  const presetDir = window.electron.resolvePath('config', 'presets', 'preferences');

  const defaultPreferences = {
    systemNotifications: false,
    offlineMode: false,
    theme: "light",
    language: "en",
    apiKey: "",
    confidenceThreshold: "90",
    webhookUrl: "",
    webhookLogging: false,
    webhookOnlyFail: false
  };

  // Utility: Read and Write Preferences
  function loadPreferences() {
    if (window.electron.fileExists(preferencesPath)) {
      try {
        return JSON.parse(window.electron.readTextFile(preferencesPath));
      } catch (err) {
        console.error("❌ Failed to parse preferences:", err);
      }
    }
    return {};
  }

  function savePreferences(data) {
    try {
      window.electron.writeTextFile(
        preferencesPath,
        JSON.stringify(data, null, 2)
      );

    } catch (err) {
      console.error("❌ Failed to save preferences:", err);
    }
  }

  const el = {
    notifications: document.getElementById("system-notifications"),
    offlineMode: document.getElementById("offline-mode"),
    language: document.getElementById("language-select"),
    apiKeyInput: document.getElementById("ai-api-key"),
    webhookUrl: document.getElementById("webhook-url"),
    webhookLog: document.getElementById("webhook-logging"),
    webhookFailOnly: document.getElementById("webhook-only-fail"),
    resetButton: document.getElementById("reset-preferences"),
    appVersion: document.getElementById("app-version"),
    presetSelect: document.getElementById('prefs-preset'),
    saveConfigBtn: document.getElementById('prefs-save-config'),
    loadConfigBtn: document.getElementById('prefs-load-config'),
    themeSelect: document.getElementById('theme-select')
  };

  const webhookSections = Array.from(document.querySelectorAll('[data-webhook-section]'));

  function setDropdownValue(hiddenId, value) {
    const hidden = document.getElementById(hiddenId);
    const wrapper = hidden?.closest('.dropdown-wrapper');
    const input = wrapper?.querySelector('.chosen-value');
    const list = wrapper?.querySelector('.value-list');
    const li = [...(list?.children || [])].find(l => l.dataset.value === value);
    if (li && input && hidden) {
      input.value = li.textContent;
      hidden.value = value;
    } else if (input && hidden) {
      input.value = '';
      hidden.value = value;
    }
  }

  setupStyledDropdown('prefs-preset', []);
  setupStyledDropdown('theme-select', [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ]);
  setupStyledDropdown('language-select', [
    { value: 'en', label: 'English (EN)' },
    { value: 'es', label: 'Spanish (ES)' },
    { value: 'fr', label: 'French (FR)' },
    { value: 'de', label: 'German (DE)' },
    { value: 'ja', label: 'Japanese (JA)' },
    { value: 'zh', label: 'Chinese (ZH)' }
  ]);
  const toastEl = document.getElementById("prefs-toast");

  function updateWebhookVisibility() {
    const visible = !!el.webhookLog?.checked;
    webhookSections.forEach(section => {
      if (!section) return;
      if (visible) {
        section.removeAttribute('hidden');
        section.removeAttribute('aria-hidden');
      } else {
        section.setAttribute('hidden', '');
        section.setAttribute('aria-hidden', 'true');
      }
    });
    document.body?.classList.toggle('webhook-disabled', !visible);
  }

  function mirrorWebhookSettings() {
    const url = el.webhookUrl?.value.trim() || '';
    const logging = !!el.webhookLog?.checked;
    const onlyFail = !!el.webhookFailOnly?.checked;
    const enabled = url && (logging || onlyFail);
    const mappings = [
      { enable: 'adobe-enable-n8n', url: 'adobe-n8n-url', log: 'adobe-n8n-log' },
      { enable: 'enable-n8n', url: 'n8n-url', log: 'n8n-log' },
      { enable: 'transcode-enable-n8n', url: 'transcode-n8n-url', log: 'transcode-n8n-log' }
    ];
    mappings.forEach(m => {
      const en = document.getElementById(m.enable);
      const ur = document.getElementById(m.url);
      const lg = document.getElementById(m.log);
      if (en) en.checked = !!enabled;
      if (ur) ur.value = url;
      if (lg) lg.checked = logging;
    });

    updateWebhookVisibility();
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2000);
  }

  function applyTheme(theme) {
    localStorage.setItem('theme', theme);
    document.body.classList.toggle('dark-mode', theme === 'dark');
  }
  
  const prefs = loadPreferences();

  try {
    const pkgPath = window.electron.joinPath(
      window.electron.appDir ?? '',
      'package.json'
    );
    const pkgRaw = window.electron.readTextFile(pkgPath);
    const pkg = JSON.parse(pkgRaw);
    if (el.appVersion) {
      el.appVersion.textContent = `Version ${pkg.version}`;
    }
  } catch (err) {
    console.error('Failed to load app version:', err);
  }

  function populateFields(p = defaultPreferences) {
    if (el.notifications) el.notifications.checked = p.systemNotifications || false;
    if (el.offlineMode) el.offlineMode.checked = !!p.offlineMode;
    setDropdownValue('language-select', p.language || 'en');
    if (window.i18n) {
      window.i18n.changeLanguage(p.language || 'en').then(() => window.translatePage?.());
    }

    if (el.themeSelect) {
      const theme = localStorage.getItem('theme') || p.theme || 'light';
      setDropdownValue('theme-select', theme);
      applyTheme(theme);
    }

    if (el.apiKeyInput) el.apiKeyInput.value = p.apiKey || '';

    if (el.webhookUrl) el.webhookUrl.value = p.webhookUrl || '';
    if (el.webhookLog) el.webhookLog.checked = p.webhookLogging || false;
    if (el.webhookFailOnly) el.webhookFailOnly.checked = p.webhookOnlyFail || false;

    mirrorWebhookSettings();
  }

  if (prefs.preferences) {
    populateFields(prefs.preferences);
  } else {
    prefs.preferences = { ...defaultPreferences };
    populateFields(defaultPreferences);
  }

  function attachSaveEvents() {
    const save = () => {
      mirrorWebhookSettings();
      const updated = {
        ...prefs,
        preferences: {
          systemNotifications: !!el.notifications?.checked,
          offlineMode: !!el.offlineMode?.checked,
          theme: el.themeSelect?.value || "light",
          language: el.language?.value || 'en',

          apiKey: el.apiKeyInput?.value || '',
          confidenceThreshold: prefs.preferences?.confidenceThreshold || '90',
          
          webhookUrl: el.webhookUrl?.value || '',
          webhookLogging: !!el.webhookLog?.checked,
          webhookOnlyFail: !!el.webhookFailOnly?.checked
        }
      };

      savePreferences(updated);
      showToast(window.i18n.t('preferencesSaved'));
      applyTheme(updated.preferences.theme);
    };

    Object.values(el).forEach(input => {
      if (!input) return;
      input.addEventListener("change", save);
      input.addEventListener("blur", save);
    });
  }

  attachSaveEvents();

  el.language?.removeAttribute?.('disabled');
  el.language?.addEventListener('change', async () => {
    const newLang = el.language.value;
    prefs.preferences.language = newLang;
    savePreferences(prefs);
    await window.i18n?.changeLanguage(newLang);
    window.translatePage?.();
  });



  // ===============================
  // 💾 Preset Handling
  // ===============================
  function gatherPreferencesConfig() {
    return {
      systemNotifications: !!el.notifications?.checked,
      offlineMode: !!el.offlineMode?.checked,
      theme: el.themeSelect?.value || 'light',
      language: el.language?.value || 'en',
      apiKey: el.apiKeyInput?.value || '',
      confidenceThreshold: prefs.preferences?.confidenceThreshold || '90',
      webhookUrl: el.webhookUrl?.value || '',
      webhookLogging: !!el.webhookLog?.checked,
      webhookOnlyFail: !!el.webhookFailOnly?.checked
    };
  }

  function applyPreferencesPreset(data) {
    populateFields(data);
    prefs.preferences = { ...prefs.preferences, ...data };
    savePreferences(prefs);

    mirrorWebhookSettings();

    const theme = data.theme || 'light';
    localStorage.setItem('theme', theme);
    applyTheme(theme);
  }

  function refreshPresetDropdown() {
    const sel = el.presetSelect;
    if (!sel) return;
    try {
      window.electron.mkdir(presetDir);
      const files = window.electron.readdir(presetDir) || [];
      const opts = files
        .filter(f => f.endsWith('.json'))
        .map(f => ({ value: f, label: f.replace(/\.json$/, '') }));
      setupStyledDropdown('prefs-preset', opts);
      setDropdownValue('prefs-preset', sel.value || '');
    } catch (err) {
      console.error('Failed to read presets:', err);
    }
    window.translatePage?.();
  }

  // ✅ Auto-refresh preset dropdown when presets are saved or deleted
  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('preset-saved', (_e, panelId) => {
      if (panelId === 'preferences') refreshPresetDropdown();
    });
    ipc.on('preset-deleted', (_e, panelId) => {
      if (panelId === 'preferences') refreshPresetDropdown();
    });
  }

  refreshPresetDropdown();

  el.presetSelect?.addEventListener('change', () => {
    const file = el.presetSelect?.value;
    if (!file) return;
    try {
      const raw = window.electron.readTextFile(
        window.electron.joinPath(presetDir, file)
      );
      const data = JSON.parse(raw);
      applyPreferencesPreset(data);
    } catch (err) {
      console.error('Failed to load preset', err);
    }
  });

  el.saveConfigBtn?.addEventListener('click', async () => {
    const cfg = gatherPreferencesConfig();
    const file = await ipc.saveFile({
      title: 'Save Preset',
      defaultPath: window.electron.joinPath(presetDir, 'preferences.json')
    });
    if (file) {
      ipc.writeTextFile(file, JSON.stringify(cfg, null, 2));
      ipc.send('preset-saved', 'preferences');
      refreshPresetDropdown();
      showToast(window.i18n.t('preferencesSaved'));
    }
  });

  el.loadConfigBtn?.addEventListener('click', async () => {
    const file = await ipc.openFile({ title: 'Load Preset' });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      applyPreferencesPreset(data);
    } catch (err) {
      alert('Failed to load config: ' + err.message);
    }
  });


  el.resetButton?.addEventListener("click", () => {
    prefs.preferences = { ...defaultPreferences };
    populateFields(prefs.preferences);
    mirrorWebhookSettings();
    savePreferences(prefs);
    showToast(window.i18n.t('preferencesReset'));
  });

  // =====================================
  // 🌙 Sync Topbar Toggle with Preferences Dropdown (runs immediately)
  // =====================================
  (function wireThemeSync() {
    const themeToggle = document.getElementById('theme-toggle');
    const themeSelect = el.themeSelect;
    if (!themeToggle || !themeSelect) return;

    // Initial sync from persisted value
    const savedTheme = localStorage.getItem('theme') || prefs.preferences.theme || 'light';
    themeToggle.checked = savedTheme === 'light';
    setDropdownValue('theme-select', savedTheme);
    applyTheme(savedTheme);

    // Dropdown → Toggle (+ persist)
    themeSelect.addEventListener('change', () => {
      const newTheme = themeSelect.value;
      localStorage.setItem('theme', newTheme);
      themeToggle.checked = newTheme === 'light';
      applyTheme(newTheme);
      prefs.preferences.theme = newTheme;
      savePreferences(prefs);
      // notify other listeners (optional)
      document.dispatchEvent(new CustomEvent('theme-toggle-updated', { detail: { theme: newTheme } }));
    });

    // Toggle → Dropdown (+ persist)
    themeToggle.addEventListener('change', () => {
      const isLight = themeToggle.checked;
      const newTheme = isLight ? 'light' : 'dark';
      localStorage.setItem('theme', newTheme);
      setDropdownValue('theme-select', newTheme);
      applyTheme(newTheme);
      prefs.preferences.theme = newTheme;
      savePreferences(prefs);
    });

    // Respond to broadcasts from renderer.js
    document.addEventListener('theme-toggle-updated', (e) => {
      const theme = e.detail?.theme;
      if (!theme) return;
      setDropdownValue('theme-select', theme);
      themeToggle.checked = theme === 'light';
      applyTheme(theme);
      prefs.preferences.theme = theme;
      savePreferences(prefs);
    });
  })();

  // ─── Preferences: panel overview tooltip ──────────────────────────────────
  const prefsOverview = document.querySelector('#preferences #preferences-overview-tooltip');
  if (prefsOverview && !prefsOverview.dataset.bound) {
    prefsOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">PREFERENCES PANEL OVERVIEW</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">What this panel is for</span>
          <ul class="tooltip-list">
            <li>Control global behaviour of the Lead AE Assist app.</li>
            <li>Configure notifications, offline mode, theme, and language.</li>
            <li>Set up automation hooks (webhooks, logging options, API keys).</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Quick workflow</span>
          <ul class="tooltip-list">
            <li><strong>Load or pick a preset</strong> - so different shows/machines can share settings.</li>
            <li><strong>Adjust general options</strong> - notifications, offline mode, and appearance.</li>
            <li><strong>Configure automation</strong> - webhook URL, when to fire it, and what to log.</li>
          </ul>
        </div>
      </div>
    `;
    prefsOverview.dataset.bound = 'true';
  }
})();
