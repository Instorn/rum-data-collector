/**services/export/autoExportService.js
Сервис авто-выгрузки по расписанию (alarm).
fix-8: расписание берётся из resolved-конфига (settings.json / fileBasedSettings →
managed storage → built-in defaults) и описывается блоком autoExport с массивом
schedules. Каждое расписание может задавать cleanupAfterExport: после УСПЕШНОЙ
выгрузки этого расписания удаляются только накопленные RUM-записи старше 1 часа.
Legacy managed-ключи autoExportEnabled / autoExportTimes поддержаны как fallback
(cleanupAfterExport всегда false).
Выгружает ZIP-архив "Все отчёты" через runRoleBundleExport() из services/export/roleBundleExport.js.
Частичная очистка выполняется глобальной pruneRumDataOlderThan() из background.js. */

const AUTO_EXPORT_ALARM_PREFIX = 'auto-export-';
// Built-in fallback — используется ТОЛЬКО если ни settings.json/fileBasedSettings,
// ни managed storage не дали конфига. Сохраняет прежнее поведение: 10:00 и 17:00
// без очистки (cleanupAfterExport=false).
const AUTO_EXPORT_DEFAULT_SCHEDULES = [
  { time: '10:00', cleanupAfterExport: false },
  { time: '17:00', cleanupAfterExport: false }
];

const _AE_KEEP_MS = 60 * 60 * 1000; // окно "последнего часа", которое post-export prune НЕ трогает

// module-scope cache соответствия alarmName → schedule. Не единственный source of
// truth: runAutoExport() перечитывает settings после SW wake, а cache — лишь ускорение.
let _aeScheduleCache = new Map();
// lock, чтобы два alarm'а не запустили параллельные runRoleBundleExport()
let _aeExportInProgress = false;

// ─── Валидация одного времени HH:MM (00:00–23:59) ─────────────────────

const _AE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function _ae_isValidTime(t) {
  return typeof t === 'string' && _AE_TIME_RE.test(t);
}

// ─── Чтение resolved-конфига (тот же pipeline, что и pre-pilot runtime) ─

/**
 * Читает fileBasedSettings (если активен file-based режим) → managed → defaults.
 * Возвращает "сырой" объект настроек (может содержать autoExport и/или legacy keys),
 * плюс метку источника.
 * @returns {Promise<{ raw: Object, source: 'fileBasedSettings'|'managed'|'defaults' }>}
 */
function _ae_readResolvedSettings() {
  return new Promise(resolve => {
    const readManaged = () => new Promise(res => {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, r => res(chrome.runtime.lastError ? {} : (r || {})));
      } else {
        res({});
      }
    });
    const readFileBased = () => new Promise(res => {
      if (chrome.storage && chrome.storage.local) {
        const key = (typeof FILE_SETTINGS_KEY === 'string') ? FILE_SETTINGS_KEY : 'fileBasedSettings';
        chrome.storage.local.get(key, r => res((!chrome.runtime.lastError && r && r[key]) ? r[key] : null));
      } else {
        res(null);
      }
    });

    readManaged().then(managed => {
      // shouldUseSettingsFile() приходит из services/prepilot.js (общий SW-scope).
      const useFile = (typeof shouldUseSettingsFile === 'function')
        ? shouldUseSettingsFile(managed)
        : (!managed || Object.keys(managed).length === 0);

      if (useFile) {
        readFileBased().then(fileSettings => {
          if (fileSettings && typeof fileSettings === 'object') {
            resolve({ raw: fileSettings, source: 'fileBasedSettings' });
          } else if (managed && Object.keys(managed).length > 0) {
            resolve({ raw: managed, source: 'managed' });
          } else {
            resolve({ raw: {}, source: 'defaults' });
          }
        });
      } else {
        resolve({ raw: managed, source: 'managed' });
      }
    });
  });
}

// ─── Нормализация schedules ───────────────────────────────────────────

/**
 * managed storage / реестр отдаёт сложные значения как JSON-строку (REG_SZ,
 * как siteConfig_N). Приводим значение к объекту/массиву: объект возвращаем как
 * есть, строку пытаемся распарсить, иначе null (при ошибке — warning).
 * @param {*} value
 * @param {string} label для сообщения об ошибке
 * @returns {Object|Array|null}
 */
function _ae_coerceJson(value, label) {
  if (value && typeof value === 'object') return value; // native object/array (settings.json / ADMX)
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      console.warn(`[RUM:AutoExport] Не удалось распарсить ${label} из реестра (REG_SZ), значение проигнорировано:`, e && e.message);
      return null;
    }
  }
  return null;
}

/**
 * Строит нормализованную модель авто-выгрузки из resolved-конфига.
 * Приоритет: блок autoExport → legacy autoExportEnabled/autoExportTimes → defaults.
 * autoExport и autoExportTimes могут прийти из реестра как JSON-строка (REG_SZ).
 * @param {Object} raw    resolved-настройки
 * @param {string} source метка источника
 * @returns {{ enabled: boolean, source: string, schedules: Array<{alarmName,time,cleanupAfterExport}> }}
 */
function _ae_normalizeConfig(raw, source) {
  raw = (raw && typeof raw === 'object') ? raw : {};

  let enabled;
  let rawSchedules; // массив { time, cleanupAfterExport? }

  // autoExport может быть объектом (settings.json / ADMX) или JSON-строкой (реестр REG_SZ).
  const autoExportObj = _ae_coerceJson(raw.autoExport, 'autoExport');

  if (autoExportObj && !Array.isArray(autoExportObj)) {
    // Новая модель. ТЗ: если autoExport.enabled !== true, alarms не создаются —
    // поэтому отсутствующий/не-true enabled трактуем как выключено.
    enabled = (autoExportObj.enabled === true);
    const list = Array.isArray(autoExportObj.schedules) ? autoExportObj.schedules : [];
    rawSchedules = list.map(s => (s && typeof s === 'object') ? {
      time: s.time,
      cleanupAfterExport: s.cleanupAfterExport === true
    } : { time: s, cleanupAfterExport: false });
  } else if (raw.autoExportEnabled !== undefined || raw.autoExportTimes !== undefined) {
    // Legacy-модель: cleanupAfterExport всегда false.
    // autoExportTimes может прийти из реестра как JSON-строка ("[\"10:00\",\"17:00\"]").
    enabled = (typeof raw.autoExportEnabled === 'boolean') ? raw.autoExportEnabled : true;
    const timesRaw = _ae_coerceJson(raw.autoExportTimes, 'autoExportTimes');
    const times = Array.isArray(timesRaw) ? timesRaw : (Array.isArray(raw.autoExportTimes) ? raw.autoExportTimes : []);
    rawSchedules = times.map(t => ({ time: t, cleanupAfterExport: false }));
    if (rawSchedules.length === 0) {
      // legacy включён, но времена не заданы — берём built-in времена (без cleanup)
      rawSchedules = AUTO_EXPORT_DEFAULT_SCHEDULES.map(s => ({ ...s }));
    }
  } else {
    // Built-in defaults (оба источника без auto-export конфига)
    enabled = true;
    rawSchedules = AUTO_EXPORT_DEFAULT_SCHEDULES.map(s => ({ ...s }));
    source = 'defaults';
  }

  // Валидация + дедупликация по времени
  const seen = new Map(); // time → cleanupAfterExport (для лога конфликтов)
  const normalized = [];
  for (const s of rawSchedules) {
    if (!_ae_isValidTime(s.time)) {
      console.warn('[RUM:AutoExport] Invalid schedule time skipped:', s && s.time);
      continue;
    }
    const cleanup = s.cleanupAfterExport === true;
    if (seen.has(s.time)) {
      const prev = seen.get(s.time);
      console.warn(`[RUM:AutoExport] Duplicate schedule time de-duplicated: ${s.time} (kept cleanupAfterExport=${prev}, dropped ${cleanup})`);
      continue;
    }
    seen.set(s.time, cleanup);
    normalized.push({
      alarmName: AUTO_EXPORT_ALARM_PREFIX + normalized.length,
      time: s.time,
      cleanupAfterExport: cleanup
    });
  }

  return { enabled, source, schedules: normalized };
}

/**
 * Полная нормализованная модель авто-выгрузки после чтения resolved-настроек.
 * @returns {Promise<{ enabled, source, schedules }>}
 */
async function _ae_resolveConfig() {
  const { raw, source } = await _ae_readResolvedSettings();
  return _ae_normalizeConfig(raw, source);
}

// ─── Создание одного аларма ───────────────────────────────────────────

function _ae_scheduleAlarm(alarmName, timeStr) {
  const [hourStr, minuteStr] = timeStr.split(':');
  const hour   = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  const now    = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  chrome.alarms.create(alarmName, {
    when: target.getTime(),
    periodInMinutes: 24 * 60
  });
}

// ─── Удаление старых авто-экспортных алармов ──────────────────────────

function _ae_clearAutoAlarms() {
  return new Promise(resolve => {
    chrome.alarms.getAll(alarms => {
      const autoAlarms = alarms.filter(a => a.name.startsWith(AUTO_EXPORT_ALARM_PREFIX));
      if (autoAlarms.length === 0) { resolve(); return; }
      let remaining = autoAlarms.length;
      autoAlarms.forEach(a => {
        chrome.alarms.clear(a.name, () => {
          remaining--;
          if (remaining === 0) resolve();
        });
      });
    });
  });
}

// ─── Публичные функции ────────────────────────────────────────────────

/**
 * Читает resolved-настройки и (пере)создаёт авто-алармы.
 * Self-contained: не зависит от порядка вызова initPrepilotSettings().
 * Вызывается при onInstalled, onStartup, изменении настроек и RELOAD_SETTINGS.
 */
async function scheduleAutoAlarms() {
  const config = await _ae_resolveConfig();

  // Всегда чистим старые алармы перед пересозданием (снимает дубли и снятые schedules)
  await _ae_clearAutoAlarms();

  // Обновляем cache соответствия alarmName → schedule
  _aeScheduleCache = new Map(config.schedules.map(s => [s.alarmName, s]));

  if (config.enabled !== true) {
    console.log(`[RUM:AutoExport] Авто-выгрузка отключена (source=${config.source})`);
    return;
  }

  if (config.schedules.length === 0) {
    console.warn('[RUM:AutoExport] Нет валидных schedules — auto-export alarms не созданы');
    return;
  }

  config.schedules.forEach(s => {
    _ae_scheduleAlarm(s.alarmName, s.time);
    console.log(`[RUM:AutoExport] Alarm ${s.alarmName} -> ${s.time}, cleanupAfterExport=${s.cleanupAfterExport}`);
  });
}

/**
 * Проверяет, принадлежит ли аларм авто-экспорту.
 * @param {string} alarmName
 * @returns {boolean}
 */
function isAutoExportAlarm(alarmName) {
  return typeof alarmName === 'string' && alarmName.startsWith(AUTO_EXPORT_ALARM_PREFIX);
}

/**
 * Находит schedule по имени alarm: сначала cache, затем повторный resolve
 * (cache может быть пустым после холодного wake service worker).
 * @param {string} alarmName
 * @returns {Promise<{alarmName,time,cleanupAfterExport}|null>}
 */
async function _ae_findSchedule(alarmName) {
  if (_aeScheduleCache.has(alarmName)) return _aeScheduleCache.get(alarmName);
  const config = await _ae_resolveConfig();
  _aeScheduleCache = new Map(config.schedules.map(s => [s.alarmName, s]));
  return _aeScheduleCache.get(alarmName) || null;
}

/**
 * Запускает авто-выгрузку по расписанию:
 *   ZIP-архив "Все отчёты" через runRoleBundleExport().
 * После УСПЕШНОЙ выгрузки, если schedule.cleanupAfterExport === true, удаляет
 * только накопленные RUM-записи старше 1 часа через pruneRumDataOlderThan().
 * Вызывается из alarm-хендлера в background.js как runAutoExport({ alarmName }).
 * @param {{ alarmName?: string }} options
 */
async function runAutoExport(options = {}) {
  const alarmName = options && options.alarmName;

  // Определяем schedule и флаг очистки по имени alarm
  let schedule = null;
  if (typeof alarmName === 'string') {
    schedule = await _ae_findSchedule(alarmName);
  }
  const cleanupAfterExport = !!(schedule && schedule.cleanupAfterExport === true);
  const timeLabel = schedule ? schedule.time : 'unknown';

  if (typeof alarmName === 'string' && !schedule) {
    console.warn(`[RUM:AutoExport] Alarm schedule not found, cleanup disabled: ${alarmName}`);
  }

  // Lock охватывает ВЕСЬ цикл: выгрузка + post-export prune. Второй auto-export-*
  // не должен стартовать, пока идёт очистка первого запуска (иначе два прохода
  // конкурируют за одни и те же данные). Снимаем lock только в общем finally.
  if (_aeExportInProgress) {
    console.warn(`[RUM:AutoExport] Auto-export уже выполняется, пропускаем: alarm=${alarmName}`);
    return;
  }
  _aeExportInProgress = true;

  console.log(`[RUM:AutoExport] Запуск auto-export alarm=${alarmName} time=${timeLabel} cleanupAfterExport=${cleanupAfterExport}`);

  try {
    // fix-9: перед выгрузкой storage обязан догнать память SW (throttle-планировщик
    // мог отложить последние записи). runRoleBundleExport флашит и сам, этот вызов —
    // belt-and-suspenders по плану fix-9. Guard — по паттерну importScripts-порядка.
    if (typeof _bgFlushPersistAsync === 'function') {
      try {
        await _bgFlushPersistAsync();
      } catch (e) {
        console.warn('[RUM:AutoExport] flush persist перед выгрузкой не удался:', e && e.message);
      }
    } else {
      console.warn('[RUM:AutoExport] _bgFlushPersistAsync недоступна — pre-export flush пропущен');
    }

    let result = null;
    try {
      result = await runRoleBundleExport({ downloadStandalone04Json: true });
    } catch (e) {
      console.warn('[RUM:AutoExport] Role bundle exception, prune skipped:', e && e.message);
      return;
    }

    const std04 = result && result.standalone04;
    const std04Ok = !!(std04 && std04.success === true);
    const zipDownloaded = !!(result && (result.zipDownloaded === true || (result.success === true && result.downloaded > 0)));
    const exportOk = !!(result && result.success === true && result.downloaded > 0 && std04Ok);
    if (!exportOk) {
      const reason = (result && result.error) ? result.error
        : (!std04Ok ? 'standalone 04 json не подтверждён' : 'success!=true или downloaded<=0');
      console.warn(`[RUM:AutoExport] Scheduled export incomplete (zipDownloaded=${zipDownloaded}, std04Ok=${std04Ok}), prune skipped:`, reason);
      return;
    }

    console.log(`[RUM:AutoExport] Scheduled export OK: ZIP files=${result.downloaded}, standalone 04 json=${std04.filename}`);

    if (!cleanupAfterExport) {
      return; // выгрузка успешна, но для этого расписания очистка не требуется
    }

    // Cutoff считаем ПОСЛЕ завершения успешной выгрузки.
    const exportFinishedAt = Date.now();
    const cutoffTs = exportFinishedAt - _AE_KEEP_MS;

    if (typeof pruneRumDataOlderThan !== 'function') {
      console.warn('[RUM:AutoExport] pruneRumDataOlderThan недоступна — prune пропущен');
      return;
    }

    try {
      console.log(`[RUM:AutoExport] Post-export prune started, cutoffTs=${cutoffTs}, keepLastHours=1`);
      const counters = await pruneRumDataOlderThan(cutoffTs, 'auto-export-prune');
      console.log(`[RUM:AutoExport] Post-export prune OK, removed=${counters.removed}, kept=${counters.kept}` +
        (counters.missingTimestamp ? `, missingTimestamp=${counters.missingTimestamp}` : ''));
    } catch (e) {
      console.warn('[RUM:AutoExport] Post-export prune error:', e && e.message);
    }
  } finally {
    // Lock освобождаем ВСЕГДА после export+prune. Сам prune из finally НЕ вызываем.
    _aeExportInProgress = false;
  }
}
