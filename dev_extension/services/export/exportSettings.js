/** services/export/exportSettings.js
 JSON-экспорт снимка конфигурации расширения на конкретном ПК.
Назначение: отладка, аудит GPO-политик, поддержка пользователей.
Автономный модуль — не зависит от других export-модулей.
Подключается через importScripts в background.js.
Имя файла: {pc}_{YYYY-MM-DD}_settings.json */

// ─── Утилиты 

function _st_sanitizePcName(pcName) {
  if (!pcName || typeof pcName !== 'string' || pcName.trim() === '') return 'none';
  return pcName.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function _st_buildFileName(pcName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return `${_st_sanitizePcName(pcName)}_${dateStr}_settings.json`;
}

// ─── Чтение данных 

function _st_readManagedStorage() {
  return new Promise(resolve => {
    if (!chrome.storage || !chrome.storage.managed) {
      resolve({});
      return;
    }
    chrome.storage.managed.get(null, result => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function _st_readSyncStorage() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['rumEnabled', 'serverUrl'], result => {
      resolve(result || {});
    });
  });
}

function _st_readLocalStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get('pcIdentifier', result => {
      resolve(result.pcIdentifier || null);
    });
  });
}

// fix-8: читаем fileBasedSettings, чтобы показать resolved autoExport из того же
// источника, что использует runtime (settings.json → managed → defaults).
function _st_readFileBasedSettings() {
  return new Promise(resolve => {
    const key = (typeof FILE_SETTINGS_KEY === 'string') ? FILE_SETTINGS_KEY : 'fileBasedSettings';
    chrome.storage.local.get(key, result => {
      resolve((!chrome.runtime.lastError && result && result[key]) ? result[key] : null);
    });
  });
}

/**
 * fix-8: собирает resolved-снимок авто-выгрузки для аудита настроек.
 * Приоритет источника: fileBasedSettings → managed → defaults, тот же, что в runtime.
 * @returns {{ enabled, source, schedules } | null}
 */
function _st_resolveAutoExport(managed, fileBasedSettings) {
  // Определяем "сырой" источник по правилам prepilot: file-based выигрывает,
  // когда managed пустой или выставлен useSettingsFile.
  const useFile = (typeof shouldUseSettingsFile === 'function')
    ? shouldUseSettingsFile(managed)
    : (!managed || Object.keys(managed).length === 0);

  let raw, source;
  if (useFile && fileBasedSettings && typeof fileBasedSettings === 'object') {
    raw = fileBasedSettings; source = 'fileBasedSettings';
  } else if (managed && Object.keys(managed).length > 0) {
    raw = managed; source = 'managed';
  } else {
    raw = {}; source = 'defaults';
  }

  if (typeof _ae_normalizeConfig === 'function') {
    try { return _ae_normalizeConfig(raw, source); }
    catch (_) { /* fall through to raw echo */ }
  }
  // Fallback, если нормализатор недоступен: отдаём минимальный срез.
  // autoExport может быть объектом или JSON-строкой (реестр); enabled строго === true.
  let ae = raw && raw.autoExport;
  if (typeof ae === 'string') { try { ae = JSON.parse(ae); } catch (_) { ae = null; } }
  return { enabled: (ae && typeof ae === 'object') ? (ae.enabled === true) : false, source, schedules: [] };
}

// ─── Определение settingsSource  

/**
 * Возвращает источник значения поля.
 * managed > hardcoded > sync
 * @param {string}  field
 * @param {Object}  managed
 * @param {Object}  sync
 * @param {boolean} isHardcoded - поле задано константой в коде
 * @returns {'managed'|'hardcoded'|'sync'|'default'}
 */
function _st_fieldSource(field, managed, sync, isHardcoded) {
  if (managed[field] !== undefined) return 'managed';
  if (isHardcoded)                  return 'hardcoded';
  if (sync[field]   !== undefined)  return 'sync';
  return 'default';
}

// ─── Построение объекта настроек  

function _st_buildSettingsObject(managed, sync, pcIdentifier, autoExportResolved) {
  const manifest = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest()
    : {};

  // Определяем источники ключевых полей.
  // serverUrl: политика > адрес, вшитый в серверную сборку. В обычной сборке модуля
  // отправки нет (RumSend не определён) — адрес из политики показываем, но не используем.
  const rumSend = globalThis.RumSend || null;
  const buildServerUrl = rumSend ? rumSend.buildServerUrl : '';
  const serverUrlSource = managed.serverUrl !== undefined ? 'managed'
    : (buildServerUrl ? 'build' : 'none');
  const rumEnabledSource = _st_fieldSource('rumEnabled', managed, sync, false);

  return {
    exportedAt:       new Date().toISOString(),
    extensionVersion: manifest.version || 'unknown',
    extensionVersionName: manifest.version_name || null,

    // Настройки сбора
    rumEnabled:              managed.rumEnabled              ?? sync.rumEnabled ?? true,
    sendModule:              rumSend ? 'included' : 'absent',
    serverUrl:               managed.serverUrl               ?? buildServerUrl,

    // Корпоративные поля
    organizationName: managed.organizationName ?? null,
    department:       managed.department       ?? null,
    location:         managed.location         ?? null,

    // Источник настроек (для аудита)
    settingsSource: {
      serverUrl:  serverUrlSource,
      rumEnabled: rumEnabledSource
    },

    // Расширенные политики
    disabledMetrics:    managed.disabledMetrics    ?? [],
    siteConfigs:        managed.siteConfigs        ?? [],

    // fix-8: resolved авто-выгрузка (source + нормализованные schedules с
    // cleanupAfterExport). Приоритет источника совпадает с runtime.
    autoExport: autoExportResolved || null,

    // Legacy-ключи оставлены для аудита managed-окружений без блока autoExport.
    autoExportEnabled:  managed.autoExportEnabled  ?? true,
    autoExportTimes:    managed.autoExportTimes    ?? ['10:00', '17:00'],

    // Идентификатор ПК (compact fix-3: без сведений об устройстве)
    pcIdentifier: pcIdentifier ? {
      pcName:      pcIdentifier.pcName      || null,
      generatedAt: pcIdentifier.generatedAt || null
    } : null
  };
}

// ─── Публичная функция  

/**
 * Генерирует и скачивает снимок конфигурации расширения в формате JSON.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function exportSettings() {
  let managed, sync, pcIdentifier, fileBasedSettings;

  try {
    [managed, sync, pcIdentifier, fileBasedSettings] = await Promise.all([
      _st_readManagedStorage(),
      _st_readSyncStorage(),
      _st_readLocalStorage(),
      _st_readFileBasedSettings()
    ]);
  } catch (e) {
    console.warn('[RUM] exportSettings: ошибка чтения storage:', e.message);
    return { ok: false, error: String(e) };
  }

  const autoExportResolved = _st_resolveAutoExport(managed, fileBasedSettings);
  const settingsObj = _st_buildSettingsObject(managed, sync, pcIdentifier, autoExportResolved);
  const filename    = _st_buildFileName(pcIdentifier?.pcName);

  let dataUrl;
  try {
    const json = JSON.stringify(settingsObj, null, 2);
    dataUrl = 'data:application/json;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(json)));
  } catch (e) {
    console.warn('[RUM] exportSettings: ошибка сериализации:', e.message);
    return { ok: false, error: String(e) };
  }

  try {
    await _dl_download({ url: dataUrl, filename });
    return { ok: true };
  } catch (e) {
    console.warn('[RUM] exportSettings: ошибка chrome.downloads:', e.message);
    return { ok: false, error: chrome.runtime.lastError?.message || String(e) };
  }
}
