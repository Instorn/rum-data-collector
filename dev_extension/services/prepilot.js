// [prepilot] Временный модуль для пре-пилота.
// Загружает settings.json как альтернативу реестру/managed storage.
//





// Ключ в chrome.storage.local для хранения загруженного конфига файла
const FILE_SETTINGS_KEY = 'fileBasedSettings';

/**
 * Читает settings.json из корня расширения, парсит, валидирует структуру
 * и сохраняет в chrome.storage.local['fileBasedSettings'].
 *
 * Атомарность: storage обновляется ТОЛЬКО при успешном parse + validate.
 * При любой ошибке текущий fileBasedSettings в storage остаётся нетронутым.
 *
 * @returns {Promise<{ ok: boolean, settings: Object|null, error: string|null }>}
 */
async function loadFileBasedSettings() { // [prepilot]
  // 1. Fetch
  let response;
  try {
    const url = chrome.runtime.getURL('settings.json');
    response = await fetch(url);
  } catch (e) {
    const msg = '[RUM][prepilot] settings.json: ошибка сети: ' + e.message;
    console.log(msg);
    return { ok: false, settings: null, error: _t('errSettingsUnavailable', [e.message]) };
  }

  if (!response.ok) {
    const msg = '[RUM][prepilot] settings.json не найден: HTTP ' + response.status;
    console.log(msg);
    return { ok: false, settings: null, error: _t('errSettingsNotFound', [String(response.status)]) };
  }

  // 2. Parse JSON — отдельный try, чтобы различать сетевую ошибку и parse-ошибку
  let settings;
  try {
    settings = await response.json();
  } catch (e) {
    const msg = '[RUM][prepilot] settings.json: ошибка JSON.parse: ' + e.message;
    console.log(msg);
    return { ok: false, settings: null, error: _t('errSettingsInvalidJson', [e.message]) };
  }

  // 3. Структурная валидация: минимально необходимая
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    const msg = '[RUM][prepilot] settings.json: корень должен быть объектом';
    console.log(msg);
    return { ok: false, settings: null, error: _t('errSettingsRootNotObject', [typeof settings]) };
  }

  // Валидируем siteConfig_N ключи: каждый должен быть объектом с непустым domain
  const siteConfigKeys = Object.keys(settings).filter(k => /^siteConfig_\d+$/.test(k));
  for (const key of siteConfigKeys) {
    const sc = settings[key];
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
      const msg = '[RUM][prepilot] settings.json: ' + key + ' должен быть объектом';
      console.log(msg);
      return { ok: false, settings: null, error: _t('errSettingsKeyNotObject', [key]) };
    }
    if (typeof sc.domain !== 'string' || sc.domain.trim() === '') {
      const msg = '[RUM][prepilot] settings.json: ' + key + '.domain отсутствует или пуст';
      console.log(msg);
      return { ok: false, settings: null, error: _t('errSettingsKeyNoDomain', [key]) };
    }
  }

  // Валидируем siteConfigs-массив (альтернативный формат): каждый элемент должен быть объектом с непустым domain
  if (settings.siteConfigs !== undefined) {
    if (!Array.isArray(settings.siteConfigs)) {
      const msg = '[RUM][prepilot] settings.json: siteConfigs должен быть массивом';
      console.log(msg);
      return { ok: false, settings: null, error: _t('errSettingsSiteConfigsNotArray') };
    }
    for (let i = 0; i < settings.siteConfigs.length; i++) {
      const sc = settings.siteConfigs[i];
      if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
        const msg = '[RUM][prepilot] settings.json: siteConfigs[' + i + '] должен быть объектом';
        console.log(msg);
        return { ok: false, settings: null, error: _t('errSettingsKeyNotObject', ['siteConfigs[' + i + ']']) };
      }
      if (typeof sc.domain !== 'string' || sc.domain.trim() === '') {
        const msg = '[RUM][prepilot] settings.json: siteConfigs[' + i + '].domain отсутствует или пуст';
        console.log(msg);
        return { ok: false, settings: null, error: _t('errSettingsKeyNoDomain', ['siteConfigs[' + i + ']']) };
      }
    }
  }

  // 4. Commit в storage только после успешной валидации
  try {
    await chrome.storage.local.set({ [FILE_SETTINGS_KEY]: settings });
  } catch (e) {
    const msg = '[RUM][prepilot] settings.json: не удалось сохранить в storage: ' + e.message;
    console.log(msg);
    return { ok: false, settings: null, error: _t('errSettingsSaveFailed', [e.message]) };
  }

  console.log('[RUM][prepilot] settings.json загружен и сохранён в storage.local');
  return { ok: true, settings, error: null };
}

/**
 * Определяет, нужно ли использовать settings.json вместо реестра.
 * Вызывать после chrome.storage.managed.get.
 *
 * @param {Object} managedSettings - результат chrome.storage.managed.get(null)
 * @returns {boolean}
 */
function shouldUseSettingsFile(managedSettings) { // [TEMP:prepilot]
  if (managedSettings && managedSettings.useSettingsFile) return true;
  // Если managed storage полностью пустой → автоматически пробуем файл
  if (!managedSettings || Object.keys(managedSettings).length === 0) return true;
  return false;
}

// fix-8: безопасный вызов пересоздания auto-export alarms. scheduleAutoAlarms()
// живёт в services/export/autoExportService.js (общий SW-scope через importScripts).
// guard нужен, чтобы модуль не падал вне SW (например, при изолированных node-тестах).
function _prepilot_rescheduleAutoExport() {
  try {
    if (typeof scheduleAutoAlarms === 'function') {
      Promise.resolve(scheduleAutoAlarms()).catch(e =>
        console.warn('[RUM][prepilot] scheduleAutoAlarms error:', e && e.message));
    }
  } catch (e) {
    console.warn('[RUM][prepilot] reschedule auto-export error:', e && e.message);
  }
}

// Обработчик сообщения RELOAD_SETTINGS — перечитывает реестр или settings.json,
// обновляет chrome.storage.local['fileBasedSettings'].
// Вызывается из popup по кнопке "Перезагрузить настройки".
async function handleReloadSettings(sendResponse) { // [TEMP:prepilot]
  try {
    // Читаем managed storage целиком
    const managedSettings = await new Promise((resolve, reject) => {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, result => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(result || {});
        });
      } else {
        resolve({});
      }
    });

    if (shouldUseSettingsFile(managedSettings)) {
      const result = await loadFileBasedSettings();
      if (!result.ok) {
        // Невалидный settings.json — сообщаем ошибку, storage не тронут
        console.warn('[RUM][prepilot] RELOAD_SETTINGS: файл невалиден —', result.error);
        sendResponse({ success: false, source: 'file', error: result.error });
      } else {
        // fix-8: явно пересоздаём auto-export alarms. Если settings.json записался
        // тем же значением, chrome.storage.onChanged может не сработать, поэтому
        // не полагаемся только на onChanged-путь.
        _prepilot_rescheduleAutoExport();
        sendResponse({ success: true, source: 'file' });
      }
    } else {
      // Managed storage доступен и не пустой — просто очищаем файловый кеш
      await chrome.storage.local.remove(FILE_SETTINGS_KEY);
      // fix-8: конфиг мог поменяться (переход на managed) — пересоздаём alarms.
      _prepilot_rescheduleAutoExport();
      sendResponse({ success: true, source: 'registry' });
    }
  } catch (e) {
    console.warn('[RUM][prepilot] handleReloadSettings error:', e.message);
    sendResponse({ success: false, error: e.message });
  }
}

// Регистрируем обработчик RELOAD_SETTINGS в общем onMessage
chrome.runtime.onMessage.addListener(function(request, _sender, sendResponse) { // [prepilot]
  if (request.type === 'RELOAD_SETTINGS') {
    handleReloadSettings(sendResponse);
    return true; // async response
  }
});
