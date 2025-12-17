/* global setupStyledDropdown */
(() => {

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  const PANEL_ID = 'preferences';

  const preferencesPath = window.electron.resolvePath("config", "state.json");

  const secureStore = window.electron?.secureStore;
  const secretKeys = { apiKey: 'aiApiKey' };

  let cachedApiKey = '';

  const defaultPreferences = {
    systemNotifications: false,
    offlineMode: false,
    theme: "light",
    language: "en",
    apiKeyStored: false,
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

  function loadSecretValue(key) {
    try {
      return secureStore?.loadSecret?.(key) || '';
    } catch (err) {
      console.error('❌ Failed to load secret from secure store:', err);
      return '';
    }
  }

  function persistSecretValue(key, value) {
    try {
      if (!value) {
        secureStore?.deleteSecret?.(key);
        return '';
      }
      secureStore?.saveSecret?.(key, value);
      return value;
    } catch (err) {
      console.error('❌ Failed to persist secret:', err);
      return '';
    }
  }

  function migrateLegacyApiKey(prefState) {
    const legacy = prefState?.preferences?.apiKey;
    if (legacy && typeof legacy === 'string') {
      cachedApiKey = persistSecretValue(secretKeys.apiKey, legacy.trim());
      delete prefState.preferences.apiKey;
      prefState.preferences.apiKeyStored = !!cachedApiKey;
      savePreferences(prefState);
    }
  }

  const el = {
    notifications: document.getElementById("system-notifications"),
    offlineMode: document.getElementById("offline-mode"),
    language: document.getElementById("language-select"),
    apiKeyInput: document.getElementById("ai-api-key"),
    webhookUrl: document.getElementById("webhook-url"),
    webhookUrlError: document.getElementById("webhook-url-error"),
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

  function translate(key, fallback) {
    return window.i18n?.t?.(key) || fallback;
  }

  function validateWebhookUrl(value) {
    const url = value?.trim?.() || '';
    if (!url) {
      return { url, configured: false, valid: true, message: '' };
    }

    try {
      // eslint-disable-next-line no-new
      new URL(url);
      return { url, configured: true, valid: true, message: '' };
    } catch (err) {
      return {
        url,
        configured: true,
        valid: false,
        message: translate('webhookUrlInvalid', 'Please enter a valid webhook URL (https://...)')
      };
    }
  }

  function updateWebhookValidationUI() {
    const validation = validateWebhookUrl(el.webhookUrl?.value);
    const invalid = validation.configured && !validation.valid;
    const disabled = !validation.configured || invalid;
    [el.webhookLog, el.webhookFailOnly].forEach(ctrl => {
      if (!ctrl) return;
      ctrl.disabled = disabled;
      if (disabled) ctrl.checked = false;
    });

    if (el.webhookUrlError) {
      el.webhookUrlError.textContent = invalid ? validation.message : '';
      el.webhookUrlError.hidden = !invalid;
    }

    document.body?.classList.toggle('webhook-invalid', invalid);
    return validation;
  }

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
    const visible = !!(el.webhookLog?.checked || el.webhookFailOnly?.checked);
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
    const validation = updateWebhookValidationUI();
    const url = validation.valid && validation.configured ? validation.url : '';
    const logging = !!el.webhookLog?.checked && !!url;
    const onlyFail = !!el.webhookFailOnly?.checked && !!url;
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
  migrateLegacyApiKey(prefs);
  cachedApiKey = loadSecretValue(secretKeys.apiKey);

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
    cachedApiKey = loadSecretValue(secretKeys.apiKey);
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

    if (el.apiKeyInput) el.apiKeyInput.value = cachedApiKey || '';

    if (el.webhookUrl) el.webhookUrl.value = p.webhookUrl || '';
    if (el.webhookLog) el.webhookLog.checked = p.webhookLogging || false;
    if (el.webhookFailOnly) el.webhookFailOnly.checked = p.webhookOnlyFail || false;

    updateWebhookValidationUI();
    mirrorWebhookSettings();
  }

  if (prefs.preferences) {
    prefs.preferences.apiKeyStored = prefs.preferences.apiKeyStored || !!cachedApiKey;
    populateFields(prefs.preferences);
  } else {
    prefs.preferences = { ...defaultPreferences, apiKeyStored: !!cachedApiKey };
    populateFields(prefs.preferences);
  }

  function attachSaveEvents() {
    const save = () => {
      const webhookValidation = updateWebhookValidationUI();
      mirrorWebhookSettings();
      if (!webhookValidation.valid && webhookValidation.url) {
        showToast(translate('webhookUrlInvalidToast', 'Enter a valid webhook URL before saving.'));
        return;
      }
      const apiKeyValue = el.apiKeyInput?.value?.trim?.() || '';
      cachedApiKey = persistSecretValue(secretKeys.apiKey, apiKeyValue);

      const updated = {
        ...prefs,
        preferences: {
          systemNotifications: !!el.notifications?.checked,
          offlineMode: !!el.offlineMode?.checked,
          theme: el.themeSelect?.value || "light",
          language: el.language?.value || 'en',

          apiKeyStored: !!cachedApiKey,
          confidenceThreshold: prefs.preferences?.confidenceThreshold || '90',

          webhookUrl: webhookValidation.valid ? webhookValidation.url : '',
          webhookLogging: webhookValidation.valid && !!el.webhookLog?.checked,
          webhookOnlyFail: webhookValidation.valid && !!el.webhookFailOnly?.checked
        }
      };

      prefs.preferences = updated.preferences;
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

  el.webhookUrl?.addEventListener('input', () => {
    updateWebhookValidationUI();
    updateWebhookVisibility();
  });

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
    const hasApiKey = (cachedApiKey || loadSecretValue(secretKeys.apiKey))?.trim?.().length > 0;
    const webhookValidation = updateWebhookValidationUI();
    return {
      systemNotifications: !!el.notifications?.checked,
      offlineMode: !!el.offlineMode?.checked,
      theme: el.themeSelect?.value || 'light',
      language: el.language?.value || 'en',
      apiKeyStored: hasApiKey,
      confidenceThreshold: prefs.preferences?.confidenceThreshold || '90',
      webhookUrl: webhookValidation.valid ? webhookValidation.url : '',
      webhookLogging: webhookValidation.valid && !!el.webhookLog?.checked,
      webhookOnlyFail: webhookValidation.valid && !!el.webhookFailOnly?.checked
    };
  }

  function applyPreferencesPreset(data) {
    const sanitized = { ...data };
    if ('apiKey' in sanitized) delete sanitized.apiKey;
    if (typeof sanitized.apiKeyStored !== 'boolean') {
      sanitized.apiKeyStored = prefs.preferences.apiKeyStored || !!cachedApiKey;
    }

    prefs.preferences = { ...prefs.preferences, ...sanitized };
    populateFields(prefs.preferences);
    savePreferences(prefs);

    mirrorWebhookSettings();

    const theme = prefs.preferences.theme || 'light';
    localStorage.setItem('theme', theme);
    applyTheme(theme);
  }

  async function refreshPresetDropdown() {
    const sel = el.presetSelect;
    if (!sel || !ipc?.invoke) return;
    try {
      const presets = await ipc.invoke('list-panel-presets', PANEL_ID);
      const opts = (Array.isArray(presets) ? presets : [])
        .filter(p => typeof p?.file === 'string' && p.file.toLowerCase().endsWith('.json'))
        .map(p => ({ value: p.file, label: p.name || p.file.replace(/\.json$/i, '') }));
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

  el.presetSelect?.addEventListener('change', async () => {
    const file = el.presetSelect?.value;
    if (!file) return;
    try {
      const raw = await ipc.invoke('read-panel-preset', { panel: PANEL_ID, presetName: file });
      if (!raw) throw new Error('Preset not found');
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      await applyPreferencesPreset(data);
    } catch (err) {
      console.error('Failed to load preset', err);
      alert('Failed to load preset: ' + (err?.message || err));
    }
  });

  el.saveConfigBtn?.addEventListener('click', async () => {
    const cfg = gatherPreferencesConfig();
    const suggestedName = (el.presetSelect?.value || 'preferences').replace(/\.json$/i, '') || 'preferences';
    const presetName = window.prompt('Save preset as', suggestedName);
    if (!presetName) return;

    try {
      const savedPath = await ipc.invoke('write-panel-preset', {
        panel: PANEL_ID,
        presetName,
        contents: cfg
      });

      if (!savedPath) throw new Error('Unable to save preset');

      const savedFile = window.electron.basename?.(savedPath) || `${presetName}.json`;
      ipc.send('preset-saved', PANEL_ID);
      await refreshPresetDropdown();
      setDropdownValue('prefs-preset', savedFile);
      showToast(window.i18n.t('preferencesSaved'));
    } catch (err) {
      alert('Failed to save preset: ' + (err?.message || err));
    }
  });

  el.loadConfigBtn?.addEventListener('click', async () => {
    const selected = el.presetSelect?.value;

    // Prefer loading from the managed preset folder so packaged builds work reliably
    if (selected) {
      try {
        const raw = await ipc.invoke('read-panel-preset', { panel: PANEL_ID, presetName: selected });
        if (!raw) throw new Error('Preset not found');
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        applyPreferencesPreset(data);
        return;
      } catch (err) {
        console.error('Failed to load preset via managed folder:', err);
      }
    }

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
    cachedApiKey = persistSecretValue(secretKeys.apiKey, '');
    if (el.apiKeyInput) el.apiKeyInput.value = '';
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

  if (typeof window !== 'undefined' && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
    window.__prefsTestHooks = {
      updateWebhookVisibility,
      webhookSections,
      controls: el
    };
  }

  // ─── Preferences: panel overview tooltip ──────────────────────────────────
  const prefsOverview = document.querySelector('#preferences #preferences-overview-tooltip');
  if (prefsOverview && !prefsOverview.dataset.bound) {
    prefsOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">PREFERENCES — Technical Overview</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Core capabilities</span>
          <ul class="tooltip-list">
            <li>Controls global behaviour of the app: notifications, offline mode, theme, and language.</li>
            <li>Stores the AI API key in the secure store instead of plain config.</li>
            <li>Defines global webhook URL and logging policy for automation hooks.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Under the hood</span>
          <ul class="tooltip-list">
            <li>Persists settings in <code>config/state.json</code> plus the OS-level secure store for secrets.</li>
            <li>Broadcasts theme changes to the top-bar toggle and other panels.</li>
            <li>Mirrors webhook settings into Ingest, Transcode, and Adobe Automate panels.</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">Operational notes</span>
          <ul class="tooltip-list">
            <li>Resetting preferences clears local API keys and webhook settings; presets can be used to restore known configs.</li>
          </ul>
        </div>
      </div>
    `;
    prefsOverview.dataset.bound = 'true';
  }
})();
