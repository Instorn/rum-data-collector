// Фоновый скрипт (Service Worker) для RUM Data Collector
// Обрабатывает агрегированные метрики

importScripts(
  'services/i18n.js',                             // _t(): строки интерфейса из _locales (compact fix-9, до всех слоёв)
  'services/siteConfig/match.js',                 // единый wildcard-matcher siteConfigs (до всех слоёв)
  'lib/fflate.umd.js',                            // vendored fflate@0.8.2 (UMD) для ZIP role bundle
  'metrics/registry.js',                          // единый реестр метрик (должен быть первым)
  'services/detection/freezeDetection.js',        // builder-хелперы freeze/blank-page событий
  'services/coords/coordModel.js',                // координатная модель v2 (compact fix-5: из background.js)
  'services/analysis/sanitizeText.js',            // RumSanitize в SW-контексте (до export-модулей)
  'services/export/exportSanitize.js',            // вспомогательный модуль экспорта (повторная санитизация + защита от формул)
  'services/export/exportWhitelistFilter.js',     // whitelist фильтр для всех export-модулей (до export-модулей)
  'services/export/downloadFile.js',              // имя файла выгрузки при чужих onDeterminingFilename (compact fix-7)
  'services/export/readAggregatedSnapshot.js',    // fix-9 Этап 2: единая точка чтения блоба из раскладки v2 (до export-модулей)
  'services/export/exportAjaxDetailsCsv.js',       // экспорт AJAX/fetch timing
  'services/export/exportAnomaliesCsv.js',
  'services/export/exportNavigationDetail.js',       // 04 CSV и JSON (bundle + standalone)
  'services/export/exportDiagnosticsCsv.js',         // 07: тренд длины очереди отправки (Р16)
  'services/export/exportSettings.js',
  'services/export/roleBundleExport.js',          // ZIP «Все отчёты» и 99 (compact fix-5: из background.js)
  'services/export/autoExportService.js',
  'services/migrations/storageWipes.js',          // одноразовые очистки хранилища (compact fix-5: из background.js)
  'services/prepilot.js'                          // модуль для пре-пилота
);

// Отправка на сервер — отдельный модуль server_addon/services/send/sendService.js, только в
// серверной сборке (build-extension-server.cmd). Он определяет globalThis.RumSend; в обычной
// сборке его нет, и вызовы globalThis.RumSend?.… ничего не делают.

const HEARTBEAT_TIMEOUT_MS = 15000; // порог тишины для определения зависания (мс)
const tabHeartbeats = new Map();    // tabId → { ts, url, beats, longTasksActive }

// ─── Сессия и идентификация ПК ────────────────────────────────────────

// session_id: единый идентификатор сессии сбора для SW-жизни.
// Генерируется сразу с заглушкой, уточняется после чтения pcIdentifier из storage.
// SESSION_START_TS теперь let — может быть восстановлен из chrome.storage.session.
let SESSION_START_TS = Date.now();
let sessionId = `session_${SESSION_START_TS}`;
//  sessionId восстановлен из session storage, не перезаписывать pcIdentifier-обогащением.
let _sessionIdRestored = false;
// chrome.runtime.onStartup сработал; _bg_restoreCoordState() не должна восстанавливать данные.
let _onStartupFired = false;

// стабильный идентификатор ПК, инициализируется при старте SW.
let _bgPcId = null;

// Строка браузера и timezone, полученные из runtime-контекста.
// _bgBrowser парсится один раз из navigator.userAgent по приоритету YaBrowser > Edge > Chrome.
// _bgTimezone обновляется при каждом REPORT_TIMEZONE от content.js; fallback — SW Intl.
let _bgBrowser  = (() => {
  try {
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
    const yab  = ua.match(/YaBrowser\/(\d+)/);
    if (yab) return `YaBrowser ${yab[1]}`;
    const edge = ua.match(/Edg\/(\d+)/);
    if (edge) return `Edge ${edge[1]}`;
    const chr  = ua.match(/Chrome\/(\d+)/);
    if (chr)  return `Chrome ${chr[1]}`;
  } catch { /* ignore */ }
  return '';
})();
let _bgTimezone = (() => {
  try {
    return (typeof Intl !== 'undefined')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : '';
  } catch { return ''; }
})();

/**
 * Возвращает стабильный идентификатор ПК.
 * Приоритет: имя из настроек (customPCName, его пишет content.js) > ранее сохранённый UUID > новый UUID.
 * Формат ключа: { pcName, generatedAt }.
 */
async function _bg_getPcIdentifier() {
  const data = await chrome.storage.local.get('pcIdentifier');
  if (data.pcIdentifier?.pcName) return data.pcIdentifier.pcName;
  if (typeof data.pcIdentifier === 'string' && data.pcIdentifier) return data.pcIdentifier;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ pcIdentifier: { pcName: id, generatedAt: new Date().toISOString() } });
  return id;
}

_bg_getPcIdentifier().then(id => {
  _bgPcId = id;
  if (!_sessionIdRestored) {
    sessionId = `${id}_${SESSION_START_TS}`;
  }
});

// ─── AJAX/Fetch Resource Timing — агрегация ───────────────────────────

// Лимит кольцевого буфера AJAX timing
const BG_AJAX_RAW_MAX       = 500; // максимум raw-событий

/**
 * Записать одно AJAX-событие в aggregatedData.ajaxTimings.
 */
function bgRecordAjaxTiming(tabId, event) {
  if (!event || !event.resourceDomain || !event.resourcePath) return;

  const ajax = aggregatedData.ajaxTimings;
  if (!ajax._raw)     ajax._raw     = [];

  // Кольцевой буфер raw-событий
  ajax._raw.push(event);
  if (ajax._raw.length > BG_AJAX_RAW_MAX) ajax._raw.shift();
}

// ─── единый persist-wrapper aggregatedRumData ───
// Все runtime-записи aggregatedRumData идут через _bgPersistAggregatedData(reason).
// Исключения — раскладка v2 при гидрации и одноразовые очистки ensure*Wipe().

// ─── fix-9 Этап 2: storage-раскладка v2 (разнос тяжёлых секций) ───────────
// Тяжёлые секции (actionClicks ~609 КБ, ajaxTimings._raw ~397 КБ) вынесены в
// отдельные storage-ключи, чтобы запись только изменившейся секции стоила
// единицы-десятки КБ вместо полного блоба ~1.3 МБ. В памяти структура
// aggregatedData НЕ меняется — меняется только сериализация в storage.
const RUM_STORAGE_KEY_CORE   = 'aggregatedRumData'; // лёгкий остаток (без тяжёлых секций)
const RUM_STORAGE_KEY_CLICKS = 'rumActionClicks';   // actionClicks[]
const RUM_STORAGE_KEY_AJAX   = 'rumAjaxRaw';         // ajaxTimings._raw[]
const RUM_STORAGE_LAYOUT_MARKER = 'rumStorageLayoutV2';

// dirty-флаги секций: точки мутации aggregatedData помечают свою секцию,
// _bgPersistAggregatedData пишет только помеченные ключи. Прямые вызовы,
// меняющие весь объект (clear/prune/hydrate/migrate), флаги не ставят —
// для них ниже включается безопасный fallback «пишем все три ключа».
const _rumDirty = { core: false, clicks: false, ajaxRaw: false };
function _rumMarkDirty(section) {
  if (section === 'clicks')       _rumDirty.clicks  = true;
  else if (section === 'ajaxRaw') _rumDirty.ajaxRaw = true;
  else                            _rumDirty.core    = true;
}

// core-view: копия aggregatedData без тяжёлых секций. actionClicks выкидываем
// полностью, ajaxTimings оставляем как объект, но с пустым _raw (прочие поля
// ajaxTimings живут в core).
function _rumCoreView() {
  const core = {};
  for (const k in aggregatedData) {
    if (k === 'actionClicks') continue;
    if (k === 'ajaxTimings') {
      const at = aggregatedData.ajaxTimings || {};
      const clone = {};
      for (const kk in at) { if (kk !== '_raw') clone[kk] = at[kk]; }
      clone._raw = []; // _raw хранится отдельным ключом
      core.ajaxTimings = clone;
      continue;
    }
    core[k] = aggregatedData[k];
  }
  return core;
}

// fix-9: возвращает Promise, резолвящийся после фактического завершения
// chrome.storage.local.set: Promise резолвится текстом ошибки записи или null, предупреждение
// в консоль пишет сама функция (compact fix-3, Р10). Существующие fire-and-forget
// вызовы промис игнорируют; prune и _bgFlushPersistAsync его await-ят.
// Этап 2: пишет только dirty-секции; при отсутствии dirty-флагов (прямой
// вызов, меняющий весь объект) пишет все три ключа целиком.
function _bgPersistAggregatedData(reason) {
  const r = (typeof reason === 'string' && reason) ? reason : 'unspecified';

  // Какие ключи писать. Нет ни одного dirty → безопасный fallback: пишем всё
  // (прямые вызовы clear/prune/hydrate/migrate обнуляют или переписывают весь
  // объект — полнота важнее экономии на этих редких путях).
  const anyDirty = _rumDirty.core || _rumDirty.clicks || _rumDirty.ajaxRaw;
  const payload = {};
  if (!anyDirty || _rumDirty.core) {
    payload[RUM_STORAGE_KEY_CORE] = _rumCoreView();
  }
  if (!anyDirty || _rumDirty.clicks) {
    payload[RUM_STORAGE_KEY_CLICKS] = Array.isArray(aggregatedData.actionClicks) ? aggregatedData.actionClicks : [];
  }
  if (!anyDirty || _rumDirty.ajaxRaw) {
    const at = aggregatedData.ajaxTimings || {};
    payload[RUM_STORAGE_KEY_AJAX] = Array.isArray(at._raw) ? at._raw : [];
  }
  // Сбрасываем флаги сразу: запись зафиксирует текущий payload; события,
  // пришедшие во время set, снова выставят dirty и уйдут следующим flush.
  _rumDirty.core = _rumDirty.clicks = _rumDirty.ajaxRaw = false;

  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(payload, () => {
        const err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message || chrome.runtime.lastError) : null;
        if (err) console.warn('[RUM] запись aggregatedRumData не удалась (' + r + '):', err);
        resolve(err);
      });
    } catch (e) {
      const err = String(e && e.message ? e.message : e);
      console.warn('[RUM] запись aggregatedRumData не удалась (' + r + '):', err);
      resolve(err);
    }
  });
}

// ─── fix-9: единый throttle-планировщик persist aggregatedRumData ─────────
// Корневая причина тормозов (00_diagnosis.md): каждый telemetry-контур писал
// весь блоб ~1.3 МБ напрямую — до 33-38 записей/мин, до 1243 мс на запись.
// Схема leading + trailing: первая запись после простоя >= окна уходит сразу
// (редкие события не задерживаются), поток внутри окна схлопывается в одну
// отложенную запись. События при этом кладутся в память SW синхронно —
// откладывается только запись в storage. Storage обязан догнать память:
// перед каждым чтением экспортёром (_bgFlushPersistAsync) и в onSuspend.

const _PERSIST_THROTTLE_MS = 10000;
let _persistThrottleTimer    = null;
let _persistLastWriteAt      = 0;
let _persistPendingReasons   = [];
let _persistLastWritePromise = null;

function _bgSchedulePersist(reason) {
  _persistPendingReasons.push((typeof reason === 'string' && reason) ? reason : 'unspecified');
  // fix-9 Этап 2: контуры action-click / ajax-timings помечают свою секцию явно
  // в точке мутации (_rumMarkDirty('clicks'/'ajaxRaw')). Все прочие reason'ы
  // трогают core-секции (blank-page, freeze, click-stats, rum-data, js-error,
  // coord-anomaly) — помечаем core здесь, чтобы ни один core-контур не забыть.
  if (reason !== 'action-click' && reason !== 'ajax-timings') _rumMarkDirty('core');
  const win = _PERSIST_THROTTLE_MS;
  const sinceLast = Date.now() - _persistLastWriteAt;
  if (sinceLast >= win && !_persistThrottleTimer) {
    _bgFlushPersist();                    // leading: первая запись в окне — сразу
    return;
  }
  if (!_persistThrottleTimer) {
    _persistThrottleTimer = setTimeout(_bgFlushPersist, Math.max(0, win - sinceLast));
  }
}

// Немедленная фактическая запись всего накопленного. Возвращает Promise
// завершения последнего chrome.storage.local.set (или resolved, если писать нечего).
function _bgFlushPersist() {
  if (_persistThrottleTimer) {
    clearTimeout(_persistThrottleTimer);
    _persistThrottleTimer = null;
  }
  if (!_persistPendingReasons.length) {
    return _persistLastWritePromise || Promise.resolve();
  }
  const n = _persistPendingReasons.length;
  const reason = _persistPendingReasons[n - 1] + (n > 1 ? `(+${n - 1})` : '');
  _persistPendingReasons = [];
  _persistLastWriteAt = Date.now();
  _persistLastWritePromise = _bgPersistAggregatedData(reason);
  return _persistLastWritePromise;
}

// awaited-вариант для экспортов: гарантирует, что storage догнал память
// (ждёт и отложенную trailing-запись, и уже летящий storage.local.set).
async function _bgFlushPersistAsync() {
  await _bgFlushPersist();
}

// ─── /AJAX/Fetch Resource Timing — агрегация ──────────────────────────

let aggregatedData = {
  webVitals: [],
  aggregatedMetrics: [],
  freezeEvents: [],       // зависания по heartbeat timeout
  blankPageEvents: [],    // пустые страницы (LCP timeout + abandoned)
  anomalies: [],          // координатные и прочие аномалии
  ajaxTimings: {},        // AJAX/fetch resource timing { _raw[] }
  actionClicks: [],       // подтверждённые action clicks для 04-navigation-detail.csv
  isCollecting: true
};

// единый source of truth для гидрации aggregatedData из storage + Promise-флаг готовности.
// Promise создаётся СИНХРОННО на top-level, до регистрации onMessage listener и до любых
// async-операций, чтобы listener могли безопасно `await _bgDataReady`.
let _bgDataReadyResolve;
const _bgDataReady = new Promise(r => { _bgDataReadyResolve = r; });

// ТЗ-2 C2: аномалии от UPDATE_COORDS могут прийти до hydrate telemetry state.
// Не трогаем пустой aggregatedData и не пишем storage до _bgDataReady; после
// hydrate переносим записи в core и используем общий throttle-persist fix-9.
let _bgDataHydrated = false;
const _bgPendingAnomalies = [];
const _BG_PENDING_ANOMALIES_MAX = 50;

_bgDataReady.then(() => {
  _bgDataHydrated = true;
  if (_bgPendingAnomalies.length === 0) return;
  aggregatedData.anomalies = aggregatedData.anomalies || [];
  aggregatedData.anomalies.push(..._bgPendingAnomalies);
  _bgPendingAnomalies.length = 0;
  if (aggregatedData.anomalies.length > 200) {
    aggregatedData.anomalies = aggregatedData.anomalies.slice(-100);
  }
  _bgSchedulePersist('coord-anomaly');
});

function _bg_applyAggregatedMigrationGuards(data) {
  data.isCollecting = true;
  data.webVitals              = data.webVitals              || [];
  data.freezeEvents           = data.freezeEvents           || [];
  data.blankPageEvents        = data.blankPageEvents        || [];
  data.anomalies              = data.anomalies              || [];
  data.ajaxTimings            = data.ajaxTimings            || {};
  data.actionClicks           = data.actionClicks           || [];
  // compact fix-1: секции удалённых discovery и трекера ошибок не возвращаются в блоб
  delete data.clickStats;
  delete data.discoveredNavSelectors;
  delete data.jsErrors;
  // compact fix-2: сводка ajaxTimings._summary не ведётся с fix-1 (2026-06-24), в блоб не возвращается
  if (data.ajaxTimings && typeof data.ajaxTimings === 'object') delete data.ajaxTimings._summary;
  // compact fix-3: Performance Monitor удалён, секция в блоб не возвращается
  delete data.performanceMetrics;
  return data;
}

function _bg_hydrateAggregatedDataFromStorage({ initial } = { initial: false }) {
  return new Promise((resolve) => {
    // fix-9 Этап 2: читаем core-блоб + отдельные ключи тяжёлых секций + маркер раскладки.
    const KEYS = [RUM_STORAGE_KEY_CORE, RUM_STORAGE_KEY_CLICKS, RUM_STORAGE_KEY_AJAX, RUM_STORAGE_LAYOUT_MARKER];
    chrome.storage.local.get(KEYS, (result) => {
      try {
        if (!chrome.runtime.lastError && result && result[RUM_STORAGE_KEY_CORE]) {
          aggregatedData = result[RUM_STORAGE_KEY_CORE];
          _bg_applyAggregatedMigrationGuards(aggregatedData);

          const migratedV2 = result[RUM_STORAGE_LAYOUT_MARKER] === '2';
          const oldClicks = Array.isArray(aggregatedData.actionClicks) ? aggregatedData.actionClicks : [];
          const oldAjaxRaw = (aggregatedData.ajaxTimings && Array.isArray(aggregatedData.ajaxTimings._raw))
            ? aggregatedData.ajaxTimings._raw : [];

          if (migratedV2) {
            // Раскладка v2 уже действует: тяжёлые секции живут отдельными ключами,
            // в core они пустые. Вклеиваем их обратно в in-memory структуру.
            aggregatedData.actionClicks = Array.isArray(result[RUM_STORAGE_KEY_CLICKS]) ? result[RUM_STORAGE_KEY_CLICKS] : [];
            if (!aggregatedData.ajaxTimings) aggregatedData.ajaxTimings = {};
            aggregatedData.ajaxTimings._raw = Array.isArray(result[RUM_STORAGE_KEY_AJAX]) ? result[RUM_STORAGE_KEY_AJAX] : [];
          }
          // Первый запуск v1.14.8 поверх старого блоба:
          // атомарно раскладываем всё по трём ключам + ставим маркер одним set.
          // Старые секции удаляются из core только в этом же set (без окна потери).
          if (!migratedV2) {
            const payload = {};
            payload[RUM_STORAGE_KEY_CORE]   = _rumCoreView();      // без actionClicks и с пустым _raw
            payload[RUM_STORAGE_KEY_CLICKS] = migratedV2 ? oldClicks : oldClicks;   // при !migratedV2 — из старого блоба
            payload[RUM_STORAGE_KEY_AJAX]   = migratedV2 ? aggregatedData.ajaxTimings._raw : oldAjaxRaw;
            payload[RUM_STORAGE_LAYOUT_MARKER] = '2';
            // fix-9: сознательное исключение из _bgPersistAggregatedData — one-shot
            // раскладка/миграция внутри гидрации, не runtime telemetry persist.
            chrome.storage.local.set(payload, () => {
              if (chrome.runtime.lastError) {
                console.warn('[RUM] fix-9: не удалось выполнить раскладку storage v2:', chrome.runtime.lastError.message);
              } else if (!migratedV2) {
                console.log('[RUM] fix-9: storage-раскладка v2 применена (actionClicks/ajaxRaw вынесены в отдельные ключи)');
              }
            });
          }
        }
      } finally {
        // Резолвим: пустой storage, lastError или успех — в любом случае разблокируем ждущих.
        if (initial && _bgDataReadyResolve) {
          _bgDataReadyResolve();
          _bgDataReadyResolve = null;
        }
        resolve(aggregatedData);
      }
    });
  });
}

// Промис загрузки settings.json (fileBasedSettings): выгрузка ждёт его на холодном
// старте SW, чтобы читать актуальные siteConfigs.
let _bgPrepilotReady = Promise.resolve();

// Инициализация файловых настроек при старте SW
async function initPrepilotSettings() { // [prepilot]
  try {
    const managedSettings = await new Promise(resolve => {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, r => resolve(chrome.runtime.lastError ? {} : (r || {})));
      } else {
        resolve({});
      }
    });
    if (shouldUseSettingsFile(managedSettings)) {
      await loadFileBasedSettings();
    }
  } catch (e) {
    console.log('[RUM][prepilot] initPrepilotSettings error:', e.message);
  }
}

// Инициализация при запуске расширения
chrome.runtime.onInstalled.addListener(function(details) {
  console.log('Optimized RUM Data Collector установлен');

  // Устанавливаем настройки по умолчанию
  chrome.storage.sync.set({
    'rumEnabled': true
  });

  scheduleAutoAlarms();
  _bgPrepilotReady = initPrepilotSettings(); // [prepilot]

  // Methodology wipe для Web Vitals: при install и update вычищаем накопленный
  // webVitals[] (старая методика несовместима с vendored web-vitals).
  // Сам helper ждёт _bgDataReady и не создаёт второго пути гидрации aggregatedData.
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    _bg_runStorageWipes();
  }
});

chrome.runtime.onStartup.addListener(() => {
  // новая браузерная сессия — сбрасываем координатное состояние.
  // (onStartup НЕ срабатывает при SW-рестарте или disable/enable расширения —
  //  только при открытии браузера после закрытия.)
  //
  // ставим флаг СИНХРОННО — _bg_restoreCoordState() проверяет его
  // после своего await и прерывает restore, если он выставлен.
  _onStartupFired = true;

  // Явный сброс in-memory состояния: на случай если _bg_restoreCoordState() успела
  // восстановить данные ещё до того, как этот handler отработал (race condition).
  tabCoords.clear();
  pathMapping.clear();
  // fix-14: метки прошлой сессии (id вкладок переиспользуются) удаляем, а метки вкладок,
  // восстановленных браузером при запуске, оставляем — их onCreated мог прийти раньше onStartup.
  for (const [id, ts] of tabCreatedTs) if (ts < _BG_SW_BOOT_TS) tabCreatedTs.delete(id);
  SESSION_START_TS = Date.now();
  sessionId = `session_${SESSION_START_TS}`;
  _sessionIdRestored = false;
  _bg_getPcIdentifier().then(id => {
    _bgPcId = id;
    sessionId = `${id}_${SESSION_START_TS}`;
  });

  chrome.storage.local.remove(['rumCoordState', 'rumSessionId', 'rumSessionStartTs']);
  // fix-14: remove выше стёр и метки вкладок этой сессии, уже записанные onCreated
  if (tabCreatedTs.size > 0) _bg_schedulePersist();

  scheduleAutoAlarms();
  _bgPrepilotReady = initPrepilotSettings(); // [prepilot]
});

// ─── Whitelist-gate на стороне background ───────────────────────────
// Эшелонированная защита: background фильтрует входящие telemetry-сообщения
// по актуальному siteConfigs независимо от runtime-контура content.js.
// Если регрессия в content.js пропустит данные — перехватим здесь.

let _bg_siteConfigsCache = [];

function _bg_parseFromStorageObject(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.siteConfigs)) return obj.siteConfigs;
  if (self.RumSiteMatch && RumSiteMatch.parseSiteConfigs) {
    try { return RumSiteMatch.parseSiteConfigs(obj) || []; } catch (_) {}
  }
  return [];
}

function _bg_refreshSiteConfigsCache() {
  try {
    chrome.storage.managed.get(null, (mg) => {
      let configs = _bg_parseFromStorageObject(mg);
      if (!configs || configs.length === 0) {
        chrome.storage.local.get(['fileBasedSettings'], (lc) => {
          const raw = lc && lc.fileBasedSettings;
          if (raw) _bg_siteConfigsCache = _bg_parseFromStorageObject(raw) || [];
          else _bg_siteConfigsCache = [];
        });
      } else {
        _bg_siteConfigsCache = configs;
      }
    });
  } catch (_) { _bg_siteConfigsCache = []; }
}
_bg_refreshSiteConfigsCache();

chrome.storage.onChanged.addListener((changes, area) => {
  // compact fix-8: любое изменение managed — список сайтов меняет и siteConfig_N (основной формат GPO).
  if (area === 'managed') _bg_refreshSiteConfigsCache();
  if (area === 'local'   && changes.fileBasedSettings) _bg_refreshSiteConfigsCache();
  // Изменение managed или fileBasedSettings: перечитать settings.json и пересоздать
  // alarms авто-выгрузки.
  if ((area === 'managed') || (area === 'local' && changes.fileBasedSettings)) {
    _bgPrepilotReady = initPrepilotSettings();
    // fix-8: пересоздаём auto-export alarms при изменении managed или
    // fileBasedSettings. scheduleAutoAlarms() self-contained — сам перечитывает
    // resolved-конфиг, поэтому гонки со старым config из initPrepilotSettings() нет.
    scheduleAutoAlarms();
  }
});

// Telemetry-сообщения требуют проверки домена отправителя. Экспорт/CLEAR/
// GET_AGGREGATED_DATA/GET_TAB_ID/REPORT_TIMEZONE и прочие управляющие — не фильтруем.
const _BG_TELEMETRY_TYPES = new Set([
  'RUM_DATA', 'ACTION_CLICK_CONFIRMED',
  'AJAX_TIMING_BATCH', 'UPDATE_COORDS',
  'BLANK_PAGE_DETECTED', 'FREEZE_DETECTED', 'ABANDONED_BLANK_PAGE',
  'LCP_FINAL_UPDATE', // fix-10: досылка финального LCP после отправки записи
  'RENDER_CHAIN_UPDATE', // fix-13: досылка цепочки отрисовки блоков
]);

function _bg_isTelemetryAllowed(type, sender) {
  if (!_BG_TELEMETRY_TYPES.has(type)) return true;
  const url = sender && sender.tab && sender.tab.url;
  const host = (self.RumSiteMatch && self.RumSiteMatch.extractHost(url)) || '';
  return !!(self.RumSiteMatch && self.RumSiteMatch.isDomainAllowed(host, _bg_siteConfigsCache));
}

// ─── Обработчики сообщений (compact fix-5: по функции на тип, роутер ниже) ───

/**
 * Обработчик выгрузки из popup: «модуль не загружен» → ошибка; иначе (по флагу — после
 * сохранения памяти в storage, fix-9) запуск выгрузки и ответ { success, error }.
 * isLoaded и run вызываются в момент сообщения — модуль мог не загрузиться.
 */
function _bg_exportHandler({ isLoaded, missing, flush, run }) {
  return function (request, sender, sendResponse) {
    if (!isLoaded()) {
      sendResponse({ success: false, error: missing });
      return;
    }
    (flush ? _bgFlushPersistAsync().then(run) : run())
      .then(result => sendResponse({ success: result.ok, error: result.error }))
      .catch(e => sendResponse({ success: false, error: String(e) }));
  };
}

/**
 * Досылка поля в уже сохранённую запись actionClicks (LCP_FINAL_UPDATE, RENDER_CHAIN_UPDATE).
 * Ищет с конца — обновляемая запись почти всегда среди последних. Нашли — apply(c), секция
 * clicks помечается изменённой и уходит в throttle-запись с причиной reason.
 */
function _bg_patchActionClick(clickId, apply, reason) {
  if (!clickId || !Array.isArray(aggregatedData.actionClicks)) return;
  for (let i = aggregatedData.actionClicks.length - 1; i >= 0; i--) {
    const c = aggregatedData.actionClicks[i];
    if (c && c.clickId === clickId) {
      apply(c);
      _rumMarkDirty('clicks');
      _bgSchedulePersist(reason);
      break;
    }
  }
}

function _bg_msgRumData(request, sender, sendResponse) {
  // ждем гидрации, иначе push в пустой aggregatedData затрёт storage
  (async () => {
    await _bgDataReady;
    handleRumData(request.data, sender);
    sendResponse({success: true});
  })();
}

function _bg_msgGetAggregatedData(request, sender, sendResponse) {
  // возвращаем aggregatedData только после гидрации, иначе popup увидит пустышку
  (async () => {
    await _bgDataReady;
    sendResponse({data: aggregatedData});
  })();
}

function _bg_msgClearRumData(request, sender, sendResponse) {
  // ждём initial restore. Иначе late restore callback перезапишет
  // только что очищенный aggregatedData старым snapshot  из storage.
  (async () => {
    await _bgDataReady;
    clearAggregatedData();
    sendResponse({success: true});
  })();
}

const _bg_msgExportAnomaliesCsv = _bg_exportHandler({
  isLoaded: () => typeof exportAnomaliesCsv === 'function',
  missing:  _t('errModuleNotLoaded', ['exportAnomaliesCsv.js']),
  flush:    true,
  run:      () => exportAnomaliesCsv(),
});

const _bg_msgExportSettingsJson = _bg_exportHandler({
  isLoaded: () => typeof exportSettings === 'function',
  missing:  _t('errModuleNotLoaded', ['exportSettings.js']),
  flush:    false,
  run:      () => exportSettings(),
});

// экспорт AJAX/fetch timing в отдельный CSV
const _bg_msgExportAjaxDetailsCsv = _bg_exportHandler({
  isLoaded: () => typeof exportAjaxDetailsCsv === 'function',
  missing:  _t('errModuleNotLoaded', ['exportAjaxDetailsCsv.js']),
  flush:    true,
  run:      () => exportAjaxDetailsCsv(),
});

// сохранение timezone из content-layer
function _bg_msgReportTimezone(request, sender, sendResponse) {
  if (request.timezone && typeof request.timezone === 'string') {
    _bgTimezone = request.timezone;
  }
  sendResponse({ success: true });
}

// экспорт детализации навигационных событий
const _bg_msgExportNavigationDetailCsv = _bg_exportHandler({
  isLoaded: () => typeof exportNavigationDetail === 'function',
  missing:  _t('errModuleNotLoaded', ['exportNavigationDetail.js']),
  flush:    true,
  run:      () => exportNavigationDetail(_bgBrowser, _bgTimezone),
});

// JSON-версия 04 navigation detail
const _bg_msgExportNavigationDetailJson = _bg_exportHandler({
  isLoaded: () => typeof exportNavigationDetailJson === 'function',
  missing:  _t('errModuleNotLoaded', ['exportNavigationDetail.js']),
  flush:    true,
  run:      () => exportNavigationDetailJson(_bgBrowser, _bgTimezone),
});

// подтверждённый action click из content.js
function _bg_msgActionClickConfirmed(request, sender, sendResponse) {
  // без ожидания гидрации push в пустой массив затёр бы storage
  (async () => {
    await _bgDataReady;
    const click = request.click;
    if (click && click.clickId && click.ts) {
      if (!Array.isArray(aggregatedData.actionClicks)) aggregatedData.actionClicks = [];
      // compact fix-2: pending-клик от 1.15.0 приходит из sessionStorage целиком —
      // текст клика и тип кнопки в storage не пишем.
      delete click.clickText;
      delete click.buttonType;
      aggregatedData.actionClicks.push(click);
      // лимит кольцевого буфера 1000 (включая browser_navigation записи)
      if (aggregatedData.actionClicks.length > 1000) {
        aggregatedData.actionClicks = aggregatedData.actionClicks.slice(-1000);
      }
      _rumMarkDirty('clicks'); // fix-9 Этап 2: изменилась только секция actionClicks
      _bgSchedulePersist('action-click'); // fix-9: главный источник 33+/мин — через throttle
    }
    sendResponse({ ok: true });
  })();
}

// fix-10: досылка финального LCP от долгоживущего коллектора
// (compact fix-4: services/vitals/resultVitals.js, сообщение отправляет content.js).
// Приходит после ACTION_CLICK_CONFIRMED, если LCP финализировался позже
// отправки записи (поздние кандидаты: large image, ленивый контент и т.п.).
function _bg_msgLcpFinalUpdate(request, sender, sendResponse) {
  (async () => {
    await _bgDataReady;
    _bg_patchActionClick(request.clickId, c => {
      if (typeof request.resLcp === 'number') c.resLcp = request.resLcp;
      if (Array.isArray(request.resLcpCandidates)) c.resLcpCandidates = request.resLcpCandidates;
    }, 'lcp-final-update');
    sendResponse({ ok: true });
  })();
}

// fix-13: досылка цепочки отрисовки блоков от watch-движка content.js.
// Приходит после ACTION_CLICK_CONFIRMED, если маркеры сработали позже отправки
// записи (карточка клиента грузится 7-9 с, оператор кликает раньше).
function _bg_msgRenderChainUpdate(request, sender, sendResponse) {
  (async () => {
    await _bgDataReady;
    _bg_patchActionClick(request.clickId, c => {
      if (Array.isArray(request.resRenderChain)) {
        c.resRenderChain = request.resRenderChain;
        // fix-14: поколение и смещение описывают досланную цепочку
        c.resWatchGen    = typeof request.resWatchGen    === 'number' ? request.resWatchGen    : null;
        c.resWatchOffset = typeof request.resWatchOffset === 'number' ? request.resWatchOffset : null;
      }
    }, 'render-chain-update');
    sendResponse({ ok: true });
  })();
}

// экспорт всех отчётов в один ZIP-архив
function _bg_msgExportRoleBundle(request, sender, sendResponse) {
  runRoleBundleExport().then(result => sendResponse(result)).catch(e => sendResponse({ success: false, error: String(e) }));
}

// батч AJAX timing событий от content.js
function _bg_msgAjaxTimingBatch(request, sender, sendResponse) {
  // ждём гидрации — иначе bgRecordAjaxTiming пишет поверх пустого ajaxTimings и debounce persist его зафиксирует
  (async () => {
    await _bgDataReady;
    const { payload } = request;
    if (Array.isArray(payload)) {
      if (!aggregatedData.ajaxTimings) aggregatedData.ajaxTimings = {};
      for (const event of payload) {
        bgRecordAjaxTiming(sender.tab?.id, event);
      }
      _rumMarkDirty('ajaxRaw'); // fix-9 Этап 2: изменилась только секция ajaxTimings._raw
      // fix-9: персистим через единый throttle-планировщик (окно 10 с):
      // экспорты читают из storage, SW эфемерен, flush перед экспортом обязателен
      _bgSchedulePersist('ajax-timings');
    }
    sendResponse({ success: true });
  })();
}

// content.js запрашивает свой tabId для включения в rawEvents навигационных таймингов;
// fix-14 — и время создания вкладки.
// Ждём restore: после пробуждения SW метка вкладки может ещё лежать только в storage.
function _bg_msgGetTabId(request, sender, sendResponse) {
  const tid = sender.tab?.id || 0;
  (_coordStateRestorePromise || Promise.resolve()).then(() => {
    sendResponse({ tabId: tid, tabCreatedTs: tabCreatedTs.get(tid) ?? null });
  });
}

// content.js обновляет координаты при навигации
// ждём завершения восстановления координатного состояния перед обработкой
function _bg_msgUpdateCoords(request, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tabId' });
    return;
  }
  // ТЗ-2 C2: X/Y зависят только от восстановленного координатного state.
  // Telemetry hydrate не ждём: _bg_recordAnomaly безопасно буферизует
  // редкую раннюю аномалию и не пишет storage до _bgDataReady.
  (_coordStateRestorePromise || Promise.resolve()).then(() => {
    console.log("[RUM:BG] UPDATE_COORDS", {
      tabId,
      url: request.url,
      transitionType: request.transitionType,
      existing: tabCoords.get(tabId),
    });
    const coords = _bg_applyCoordRule(tabId, {
      url: request.url,
      domain: request.domain,
      transitionType: request.transitionType || 'unknown',
      siteConfig: request.siteConfig || null
    });
    const response = coords
      ? { ok: true, X: coords.X, Y: coords.Y, domain: coords.domain,
          entryUrl: coords.entryUrl, coordVersion: COORD_VERSION, sessionId }
      : { ok: false, error: 'invalid url' };
    _bg_schedulePersist(); // сохраняем обновлённое состояние
    sendResponse(response);
  });
}

// текущий sessionId SW
function _bg_msgGetSessionId(request, sender, sendResponse) {
  sendResponse({ sessionId });
}

// Heartbeat от content script — обновляем метку времени для таба
function _bg_msgHeartbeat(request, sender, sendResponse) {
  const tabId = sender.tab?.id || 0;
  tabHeartbeats.set(tabId, {
    ts: request.timestamp || Date.now(),
    url: request.url,
    beats: request.beats,
    longTasksActive: request.longTasksActive
  });
  sendResponse({success: true});
}

// Пустые страницы: загружена, но LCP не появился или пользователь ушёл
function _bg_msgBlankPage(request, sender, sendResponse) {
  // ждём гидрации — иначе chrome.storage.local.set затрёт накопленный storage
  (async () => {
    await _bgDataReady;
    aggregatedData.blankPageEvents.push({ ...buildBlankPageEvent(request, sender.tab?.id || 0), session_id: sessionId });  // event-time session_id
    if (aggregatedData.blankPageEvents.length > 100) {
      aggregatedData.blankPageEvents = aggregatedData.blankPageEvents.slice(-50);
    }
    _bgSchedulePersist('blank-page'); // fix-9: через throttle-планировщик
    sendResponse({success: true});
  })();
}

// Тип сообщения → обработчик. Map, а не объект: у объекта есть прототипные ключи
// ('__proto__', 'constructor'), и такое сообщение нашло бы несуществующий обработчик.
// RELOAD_SETTINGS обрабатывает второй слушатель — services/prepilot.js.
const _BG_MESSAGE_HANDLERS = new Map([
  ['RUM_DATA',                      _bg_msgRumData],
  ['GET_AGGREGATED_DATA',           _bg_msgGetAggregatedData],
  ['CLEAR_RUM_DATA',                _bg_msgClearRumData],
  ['EXPORT_ANOMALIES_CSV',          _bg_msgExportAnomaliesCsv],
  ['EXPORT_SETTINGS_JSON',          _bg_msgExportSettingsJson],
  ['EXPORT_AJAX_DETAILS_CSV',       _bg_msgExportAjaxDetailsCsv],
  ['REPORT_TIMEZONE',               _bg_msgReportTimezone],
  ['EXPORT_NAVIGATION_DETAIL_CSV',  _bg_msgExportNavigationDetailCsv],
  ['EXPORT_NAVIGATION_DETAIL_JSON', _bg_msgExportNavigationDetailJson],
  ['ACTION_CLICK_CONFIRMED',        _bg_msgActionClickConfirmed],
  ['LCP_FINAL_UPDATE',              _bg_msgLcpFinalUpdate],
  ['RENDER_CHAIN_UPDATE',           _bg_msgRenderChainUpdate],
  ['EXPORT_ROLE_BUNDLE_CSV',        _bg_msgExportRoleBundle],
  ['AJAX_TIMING_BATCH',             _bg_msgAjaxTimingBatch],
  ['GET_TAB_ID',                    _bg_msgGetTabId],
  ['UPDATE_COORDS',                 _bg_msgUpdateCoords],
  ['GET_SESSION_ID',                _bg_msgGetSessionId],
  ['HEARTBEAT',                     _bg_msgHeartbeat],
  ['BLANK_PAGE_DETECTED',           _bg_msgBlankPage],
  ['ABANDONED_BLANK_PAGE',          _bg_msgBlankPage],
]);

// Получение сообщений от content scripts и popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  // Whitelist-проверка для telemetry-сообщений.
  const _reqType = request && (request.type || request.action);
  if (!_bg_isTelemetryAllowed(_reqType, sender)) {
    return; // тихо отбрасываем
  }
  const handler = _BG_MESSAGE_HANDLERS.get(request.type);
  if (handler) handler(request, sender, sendResponse);
  // true для всех типов, включая неизвестные: так было в 1.17.1 (§1.3)
  return true;
});

// Обработчик алармов
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (isAutoExportAlarm(alarm.name)) {
    // fix-8: передаём имя alarm — runAutoExport по нему находит schedule и его
    // cleanupAfterExport, а после успешной выгрузки решает про post-export prune.
    await runAutoExport({ alarmName: alarm.name });
  }
  // alarm'ы отправки и тренда очереди обрабатывает сам sendService.js (серверная сборка).
});

// наследование координат при открытии новой вкладки (ctrl+click).
// Состояние coordsPending=true: ждём первый UPDATE_COORDS чтобы сравнить домены.
chrome.tabs.onCreated.addListener((tab) => {
  // fix-14: метка создания — для всех вкладок
  if (typeof tab.id === 'number') {
    if (tabCreatedTs.size >= TAB_CREATED_MAX) {
      // вытесняем самую старую запись — Map хранит порядок вставки
      tabCreatedTs.delete(tabCreatedTs.keys().next().value);
    }
    tabCreatedTs.set(tab.id, Date.now());
    _bg_schedulePersist();
  }
  if (tab.openerTabId) {
    tabCoords.set(tab.id, { coordsPending: true, openerTabId: tab.openerTabId });
  }
});

// Очистка heartbeat и координат при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  tabHeartbeats.delete(tabId);
  tabCoords.delete(tabId); // очищаем состояние координат
  tabCreatedTs.delete(tabId);   // fix-14
  _bg_schedulePersist();   // сохраняем обновлённый tabCoords
});

// Периодическая проверка зависания вкладок по heartbeat (каждые 15 сек)
setInterval(() => {
  const now = Date.now();
  for (const [tabId, hb] of tabHeartbeats) {
    if (now - hb.ts > HEARTBEAT_TIMEOUT_MS) {
      aggregatedData.freezeEvents.push({ ...buildFreezeEvent(tabId, hb, now), session_id: sessionId });  // event-time session_id
      if (aggregatedData.freezeEvents.length > 100) {
        aggregatedData.freezeEvents = aggregatedData.freezeEvents.slice(-50);
      }
      _bgSchedulePersist('freeze-event'); // fix-9: через throttle-планировщик
      tabHeartbeats.delete(tabId);
    }
  }
}, 15000);

// Обработка полученных RUM данных
function handleRumData(data, sender) {
  const rumEntry = {
    timestamp: Date.now(),
    url: sender.tab?.url || 'unknown',
    ...data,
    tabId: sender.tab?.id || data.tabId || 0   // sender приоритетнее payload
  };

  // Сохраняем разные типы данных в соответствующие массивы
  if (data.type === 'web-vitals') {
    aggregatedData.webVitals.push(rumEntry);
    if (aggregatedData.webVitals.length > 100) {
      aggregatedData.webVitals = aggregatedData.webVitals.slice(-50);
    }
  } else if (data.type === 'aggregated-metrics') {
    aggregatedData.aggregatedMetrics.push(rumEntry);
    if (aggregatedData.aggregatedMetrics.length > 100) {
      aggregatedData.aggregatedMetrics = aggregatedData.aggregatedMetrics.slice(-50);
    }
  }

  // Сохраняем в локальное хранилище
  _bgSchedulePersist('rum-data'); // fix-9: через throttle-планировщик

  // Отправляем данные на сервер (только серверная сборка)
  globalThis.RumSend?.enqueue(rumEntry);
}

// Обычная сборка (без sendService.js): убираем следы серверной сборки. Обе сборки ставятся
// с одним ID, и после замены серверной на обычную остались бы alarm'ы отправки и тренда,
// очередь и история тренда в storage. Вызывается на каждом старте SW, повторный вызов безопасен.
function _bg_clearSendLeftovers() {
  try {
    chrome.alarms.clear('rumSendBatch', () => { void chrome.runtime.lastError; });
    chrome.alarms.clear('rumSendQueueTrend', () => { void chrome.runtime.lastError; });
    chrome.storage.local.remove(['rumSendQueue', 'rumSendQueueTrend'], () => { void chrome.runtime.lastError; });
  } catch (e) {
    console.warn('[RUM] send leftovers cleanup error:', e && e.message);
  }
}

// Очистка агрегированных данных
function clearAggregatedData() {
  aggregatedData = {
    webVitals: [],
    aggregatedMetrics: [],
    freezeEvents: [],
    blankPageEvents: [],
    anomalies: [],
    ajaxTimings: {},
    actionClicks: [],
    isCollecting: true
  };
  _bgPersistAggregatedData('clear-data');
  // Очередь отправки очищается вместе с данными; живые структуры вкладок
  // (tabHeartbeats) не трогаем.
  globalThis.RumSend?.clear();

  // явный сброс координатной сессии — пользователь нажал "Очистить данные".
  // После сброса следующий UPDATE_COORDS начнёт новую координатную сессию с нуля.
  chrome.storage.local.remove(['rumCoordState', 'rumSessionId', 'rumSessionStartTs']);
  // Сбрасываем in-memory состояние координат
  tabCoords.clear();
  pathMapping.clear();
  SESSION_START_TS = Date.now();
  sessionId = `session_${SESSION_START_TS}`;
  _sessionIdRestored = false;
  // Обогащаем новый sessionId идентификатором ПК
  if (_bgPcId) {
    sessionId = `${_bgPcId}_${SESSION_START_TS}`;
  } else {
    _bg_getPcIdentifier().then(id => {
      _bgPcId = id;
      sessionId = `${id}_${SESSION_START_TS}`;
    });
  }
}

// ТЗ-2 C3 (дополнение к C2): запускаем восстановление координатного состояния
// ПЕРЕД гидрацией телеметрии. Оба чтения идут в один storage area, и порядок
// их постановки в очередь определяет порядок ответов: если тяжёлый get
// (core-блоб + rumActionClicks + rumAjaxRaw, ~МБ) уходит первым, то лёгкий
// coord-get и его callback всё равно выполняются после доставки и структурной
// десериализации блоба в однопоточном SW — и снятое в C2 ожидание _bgDataReady
// не даёт наблюдаемого выигрыша. Порядок вызовов важен, содержимое обеих
// процедур не меняется.
// Сохраняем Promise, чтобы UPDATE_COORDS мог дождаться завершения restore.
_coordStateRestorePromise = _bg_restoreCoordState();

// Восстановление данных из хранилища при запуске идёт через единый helper.
// initial:true — разово резолвит _bgDataReady, что разблокирует onMessage/runRoleBundleExport.
_bg_hydrateAggregatedDataFromStorage({ initial: true });

// На каждом холодном старте SW перечитываем settings.json: при обычном пробуждении
// onInstalled/onStartup не срабатывают.
_bgPrepilotReady = initPrepilotSettings();
// alarm'ы отправки и тренда очереди ставит sendService.js (серверная сборка); в обычной
// сборке снимаем то, что могла оставить серверная.
if (!globalThis.RumSend) _bg_clearSendLeftovers();

// Одноразовые очистки хранилища — и при каждом старте SW, не только в onInstalled:
// onInstalled срабатывает раз на install/update. Маркер и флаг каждой очистки не дают
// выполнить её дважды, повторный вызов безопасен.
_bg_runStorageWipes();

// ─── fix-8: частичная очистка старых RUM-записей ПОСЛЕ успешной auto-export ───
//
// Заменяет прежний самостоятельный 7-дневный age-based cleanup (setInterval).
// Теперь единственная автоматическая age-based очистка RUM — это post-export prune:
// вызывается из services/export/autoExportService.js::runAutoExport() ТОЛЬКО после
// успешного runRoleBundleExport() для расписаний с
// cleanupAfterExport=true. Удаляются только timestamped-записи старше cutoffTs;
// записи за последний час и объекты без валидного timestamp сохраняются.
//
// НЕ использует clearAggregatedData() и НЕ трогает fileBasedSettings, pcIdentifier,
// координатную сессию (rumCoordState/rumSessionId/rumSessionStartTs, tabCoords, pathMapping),
// тренд очереди отправки (rumSendQueueTrend) и настройки.

/** true если ts — валидный положительный timestamp в миллисекундах. */
function _bg_isValidTs(ts) {
  return typeof ts === 'number' && isFinite(ts) && ts > 0;
}

/**
 * Частичный prune: оставляет только записи с timestamp >= cutoffTs.
 * Записи без валидного timestamp НЕ удаляются (считаются в missingTimestamp).
 * @param {number} cutoffTs — граница в мс; удаляются записи строго старше неё
 * @param {string} reason   — reason для persist
 * @returns {Promise<{removed:number, kept:number, missingTimestamp:number}>}
 */
async function pruneRumDataOlderThan(cutoffTs, reason = 'auto-export-prune') {
  await _bgDataReady; // не работаем поверх негидратированного aggregatedData
  _bg_applyAggregatedMigrationGuards(aggregatedData);

  const counters = { removed: 0, kept: 0, missingTimestamp: 0 };

  // Универсальный фильтр по одному массиву с выбором поля timestamp.
  const pruneArray = (arr, tsFields) => {
    if (!Array.isArray(arr)) return arr;
    const out = [];
    for (const entry of arr) {
      let ts = null;
      if (entry && typeof entry === 'object') {
        for (const f of tsFields) {
          if (_bg_isValidTs(entry[f])) { ts = entry[f]; break; }
        }
      }
      if (ts === null) { counters.missingTimestamp++; out.push(entry); continue; }
      if (ts >= cutoffTs) { counters.kept++; out.push(entry); }
      else { counters.removed++; }
    }
    return out;
  };

  aggregatedData.webVitals          = pruneArray(aggregatedData.webVitals, ['timestamp']);
  aggregatedData.aggregatedMetrics  = pruneArray(aggregatedData.aggregatedMetrics, ['timestamp']);
  aggregatedData.freezeEvents       = pruneArray(aggregatedData.freezeEvents, ['detectedAt', 'timestamp']);
  aggregatedData.blankPageEvents    = pruneArray(aggregatedData.blankPageEvents, ['timestamp']);
  aggregatedData.anomalies          = pruneArray(aggregatedData.anomalies, ['timestamp']);
  aggregatedData.actionClicks       = pruneArray(aggregatedData.actionClicks, ['ts', 'timestamp']);
  if (aggregatedData.ajaxTimings && Array.isArray(aggregatedData.ajaxTimings._raw)) {
    aggregatedData.ajaxTimings._raw = pruneArray(aggregatedData.ajaxTimings._raw, ['timestamp']);
  }

  // Очередь отправки (серверная сборка): те же правила — удаляются только события с валидным
  // timestamp старше cutoffTs; счётчики считает тот же pruneArray. Очередь сохраняет sendService.
  if (globalThis.RumSend) {
    await RumSend.prune(entry => pruneArray([entry], ['timestamp']).length > 0);
  }

  // fix-9: _bgPersistAggregatedData теперь возвращает Promise, резолвящийся после
  // фактического chrome.storage.local.set — семантика ТЗ fix-8 «дождаться реальной
  // записи» сохраняется одной записью вместо прежних двух. Ошибку записи пишет в
  // консоль сам persist (compact fix-3, Р10).
  // Этап 2: prune меняет core + actionClicks + ajaxTimings._raw; dirty-флаги не
  // ставим — сработает fallback «пишем все три ключа», что и требуется.
  await _bgPersistAggregatedData(reason);

  return counters;
}

// Сбрасываем debounce-очередь persist при засыпании SW.
// onSuspend срабатывает перед тем, как Chrome усыпит service worker.
// Страховка от потери последнего persist при быстром idle-sleep.
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    if (_persistDebounceTimer) {
      clearTimeout(_persistDebounceTimer);
      _persistDebounceTimer = null;
      _bg_persistCoordState();
    }
    // fix-9: доливаем отложенную throttle-запись aggregatedRumData, чтобы штатное
    // засыпание SW не теряло хвост ≤10 с. Остаточное окно потери — только
    // нештатное убийство SW (краш/OOM), принятый риск по 01_tradeoffs.md.
    try { _bgFlushPersist(); } catch (e) {
      console.warn('[RUM] onSuspend flush persist error:', e && e.message);
    }
  });
}

// ТЗ-2 C3: вызов _bg_restoreCoordState() перенесён выше, к
// _bg_hydrateAggregatedDataFromStorage({ initial: true }).

console.log('Optimized RUM Data Collector service worker запущен');
