// Content  для RUM Data Collector
// Базовый RUM: LCP/INP/CLS/TTFB + Long Tasks

// ТЗ-2 C1: будим service worker параллельно с загрузкой настроек страницы.
// Ответ не нужен; это не telemetry message и не создаёт storage-записей.
// До проверки managed siteConfigs ping возможен и на disabled-домене.
try {
  chrome.runtime.sendMessage({ type: 'GET_SESSION_ID' }, () => void chrome.runtime.lastError);
} catch (_) { /* контекст расширения уже недоступен */ }

let rumSettings = {
  rumEnabled: true
};

// Уникальный ID этого экземпляра content.js.
// При disable/enable расширения content.js загружается заново → новый ID → обработчики перерегистрируются.
// При hot-reload managed storage (initRumCollection вызван повторно в том же контексте) → ID тот же → двойная регистрация не происходит.
const _CT_INSTANCE_ID = `rum_${Date.now()}_${Math.random()}`;

// Детекция зависаний страницы
const HEARTBEAT_INTERVAL_MS = 5000;  // интервал heartbeat (мс)
const LCP_TIMEOUT_MS = 15000;        // таймаут ожидания LCP для blank-page детекции (мс)

// Long Tasks buffer для корреляции с api-to-card
const LONG_TASKS_TTL_MS = 10000;   // максимальное окно корреляции (10 сек)
const MAX_LONG_TASKS_BUFFER = 200; // hard cap на случай аномально высокой частоты

// Per-site режим текущей страницы
let siteMode = 'disabled'; // 'monitor' | 'both' | 'minimal' | 'disabled' (default-deny)
let siteConfig = null;  // полный конфиг из managed siteConfigs для текущего домена

// Текущие значения Web Vitals (заполняются через METRICS_REGISTRY.collect)
let metricValues = {};
const metricCleanups = [];
// Guard от повторной инициализации web-vitals collector'ов в том же page load
// (collectCoreWebVitals может быть вызван повторно при hot-reload managed storage).
let _webVitalsCollectorsStarted = false;
// Guard от двойной финальной отправки Web Vitals (срабатывают и pagehide, и visibilitychange:hidden).
let _webVitalsSent = false;

// Переменные для агрегации
let longTaskCount = 0;
let totalLongTaskTime = 0;
let longTasksBuffer = []; // скользящий буфер Long Tasks для api-to-card корреляции
let pageLongTaskCount = 0; // long tasks текущего документа с начала загрузки; resetCounters() не трогает (compact fix-7)
let _ctLongTaskObserver = null; // наблюдатель collectLongTasks(); null — longtask не поддерживается или не запускался
let pageLoadStart = Date.now();
let customTimings = [];
let navTimings = [];

// Состояние heartbeat и blank-page детекции
let heartbeatIntervalId = null;
let heartbeatBeats = 0;
let lcpTimeoutId = null;

// ─── Централизованные координаты (via background.js) 
// Координаты X/Y вычисляются в services/coords/coordModel.js (_bg_applyCoordRule).
// Z остаётся локальным счётчиком кликов на текущей странице.

// tabId — отдельное поле для изоляции данных по вкладкам на сервере.
let _ctTabId = '';
// fix-14: время создания вкладки из background (Date.now() в tabs.onCreated); null — метки нет
let _ctTabCreatedTs = null;
// fix-14: history.length на старте документа. 1 = первый документ вкладки: только для него
// «вкладка создана → документ начал грузиться» есть время открытия, а не время жизни вкладки.
const _ctHistLenAtStart = (() => { try { return history.length; } catch (e) { return 0; } })();

// кеш координат от background.js
let _ctCoords = null;        // { X, Y, entryUrl, coordVersion }
let _ctZ = 0;                // Z: счётчик кликов на текущей странице
let _ctTransitionType = 'unknown';
// fix-22: тип загрузки документа до уточнений _ct_initCoords (search/click).
// Читает только Guard 1 в _ct_captureBrowserNavigation(): решение «browser-initiated или нет»
// не должно зависеть от того, успел ли _ct_initCoords уточнить _ctTransitionType.
let _ctBrowserNavTransitionType = 'unknown';
let _ctSessionId = '';
const _ctClickZByEvent = new WeakMap();
// флаг "browser navigation уже захвачена на этой странице".
// Предотвращает повторный capture при hot-reload (повторный initRumCollection()
// в том же content-context не порождает новую навигацию, но
// _ctBrowserNavTransitionType остаётся 'direct').
let _ctBrowserNavCaptured = false;
// Ключ pending action-click нужен и координатной и action-click логике.
const _CT_ACTION_CLICK_PENDING_KEY = 'rumPendingActionClick';

// ─── AJAX/Fetch Resource Timing Observer 

/** @type {PerformanceObserver|null} */
let ctAjaxObserver = null;

/** Guard: не регистрировать observer дважды */
let ctAjaxObserverAttached = false;

/** Типы запросов для отслеживания */
const CT_AJAX_INITIATOR_TYPES = new Set(['fetch', 'xmlhttprequest']);

/** Hard cap: максимум событий за страницу (SPA-защита); per-site — ajaxMaxEventsPerPage */
let CT_AJAX_MAX_EVENTS_PER_PAGE = 500;

/** Счётчик событий на текущей "странице" (сбрасывается при SPA-nav) */
let ctAjaxEventCount = 0;

/** флаг "observer был запущен на этой странице" — нужен для re-enable в hot-reload */
let ctAjaxEverStarted = false;

/** Throttle батча: интервал отправки в background (мс) */
const CT_AJAX_BATCH_INTERVAL_MS = 2000;
let ctAjaxBatch = [];
let ctAjaxBatchTimer = null;

// click_id attribution для AJAX
let _ctCurrentClickId   = null;
let _ctClickIdAbsTimer  = null; // 10s абсолютная защита от polling
let _ctClickIdIdleTimer = null; // 5s idle после последнего AJAX

// MutationObserver для watchSelectors
let _ctWatchObserver = null;
// fix-11: label'ы, уже зафиксированные на текущей логической странице.
const _ctWatchFiredLabels = new Set();
// Generation не даёт callbacks старого observer/config отправлять события после re-init.
let _ctWatchGeneration = 0;
// Page generation инвалидирует debounce предыдущей SPA-страницы без остановки observer.
let _ctWatchPageGeneration = 0;
let _ctWatchDomReadyHandler = null;
// fix-14: логическая страница = путь. Смена query/hash — не новая страница:
// кабинет переписывает query при загрузке карточки, и сброс по href обнулял часы
// меток посреди одной загрузки. Цена: переключение таба карточки через ?tab=…
// метки не переснимает — так и нужно, метка описывает загрузку страницы.
let _ctWatchLogicalPath = window.location.pathname;
// fix-14: номер логической страницы внутри документа — 0 для страницы, с которой
// документ открылся, +1 на каждую смену пути. Не путать с _ctWatchPageGeneration:
// та растёт и на re-init конфига (DOMContentLoaded, hot-reload) и для отчёта не годится.
let _ctWatchPathIndex = 0;
// fix-23: номер пользовательского клика (capture-listener 04) и номер клика, последнего
// на момент смены пути. По ним SPA-клик узнаёт, что текущую логическую страницу открыл
// он, а не следующий клик.
let _ctActionClickSeq     = 0;
let _ctPathChangeClickSeq = 0;
let _ctWatchList = [];
// Отсчёт actionDuration для текущей логической страницы.
// 0 = time origin документа: для первой загрузки метрика остаётся «от начала навигации».
// При SPA-переходе перезаписывается, иначе performance.now() накапливал бы
// время всей вкладки и каждая следующая карточка уезжала бы в VERY_SLOW.
let _ctWatchPageStart = 0;

// ─── fix-13: цепочка отрисовки блоков ─────────────────────────────────
// Цепочка привязана к логической странице (_ctWatchPageGeneration), а не к записи
// навигации: источник данных (watch-observer) один на страницу, записей может быть больше.
let _ctRenderMarks        = [];    // [{ label, tDom, tPaint, sel }]
let _ctRenderMarksGen     = -1;    // генерация страницы, к которой относится цепочка
let _ctRenderMarksStart   = 0;     // fix-14: _ctWatchPageStart поколения _ctRenderMarksGen
let _ctRenderMarksPathIdx = null;  // fix-14: _ctWatchPathIndex поколения _ctRenderMarksGen
let _ctRenderObs          = null;  // PerformanceObserver('element')
let _ctRenderArmed        = null;  // { clickId, sentCount, offsetAtArm } для досылки
let _ctRenderTimeoutId    = null;
let _ctRenderPaintEnabled = true;  // рубильник siteConfig.renderPaintTiming
const RENDER_CHAIN_TIMEOUT_MS = 30000;
const RENDER_CHAIN_MAX_MARKS  = 10;

const _CT_MAX_PAGE_URL     = 2000; // hard cap для page_url / resourceUrl полей

/** Фильтр: не логировать расширение, data:, blob: URI */
function ctIsTrackableAjaxUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('data:')) return false;
  if (url.startsWith('blob:')) return false;
  return true;
}

/** PII-safe: убираем query и hash — оставляем origin+pathname */
function ctSanitizeResourceUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Безопасное извлечение разницы таймингов.
 * cross-origin записи возвращают 0 для фаз — пишем null, а не отрицательные числа.
 */
function ctSafeTimingDiff(end, start) {
  if (!end || !start || end <= 0 || start <= 0) return null;
  const diff = Math.round(end - start);
  return diff >= 0 ? diff : null;
}

/**
 * Проверить, нужно ли игнорировать URL по ajaxIgnorePatterns.
 * Поддержка: suffix (.google-analytics.com) и contains-match.
 */
function ctShouldIgnoreAjaxUrl(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    if (pattern.startsWith('.')) {
      try {
        const hostname = new URL(url).hostname;
        if (hostname.endsWith(pattern) || hostname === pattern.slice(1)) return true;
      } catch { /* ignore */ }
    } else {
      if (url.includes(pattern)) return true;
    }
  }
  return false;
}

// ─── click_id attribution helpers

/** сбросить активный click_id */
function _ct_clearClickId() {
  clearTimeout(_ctClickIdAbsTimer);
  clearTimeout(_ctClickIdIdleTimer);
  _ctClickIdAbsTimer  = null;
  _ctClickIdIdleTimer = null;
  _ctCurrentClickId   = null;
}

/**
 * установить активный click_id.
 * Вызывается при подтверждённом клике и при dom_appeared.
 * Запускает 10s абсолютный таймер; 5s idle управляется _ct_touchAjaxIdle.
 */
function _ct_setActiveClickId(id) {
  clearTimeout(_ctClickIdAbsTimer);
  clearTimeout(_ctClickIdIdleTimer);
  _ctCurrentClickId   = id || null;
  _ctClickIdIdleTimer = null;
  if (_ctCurrentClickId) {
    _ctClickIdAbsTimer = setTimeout(_ct_clearClickId, 10000);
  }
}

/**
 * вызывается при каждом AJAX пока click_id активен.
 * Перезапускает 5s idle-таймер.
 */
function _ct_touchAjaxIdle() {
  if (!_ctCurrentClickId) return;
  clearTimeout(_ctClickIdIdleTimer);
  _ctClickIdIdleTimer = setTimeout(_ct_clearClickId, 5000);
}

// ─── watchSelectors helpers ───────────────────────────────────────────

/** fix-13: label без символов-разделителей формата CSV и identifier elementtiming. */
function _ct_renderSafeLabel(label) {
  return String(label == null ? '' : label).replace(/[|:\/;\r\n]/g, '_').slice(0, 40);
}

/** fix-13: селектор из конфига — маскирование 6+ цифр ДО обрезки (как cls в fix-12). */
function _ct_renderSafeSel(selector) {
  try {
    return String(selector == null ? '' : selector).replace(/\d{6,}/g, '#').slice(0, 60);
  } catch (e) { return ''; }
}

/** fix-14: логическая страница = путь. Смена query/hash страницей не считается. */
function _ct_logicalPageKey() {
  try { return window.location.pathname; } catch (e) { return ''; }
}

/** fix-13: переключить цепочку на логическую страницу gen, сбросив чужие отметки. */
function _ct_renderChainEnsureGen(gen) {
  if (_ctRenderMarksGen !== gen) {
    _ctRenderMarks        = [];
    _ctRenderMarksGen     = gen;
    // fix-14: вызывается только с gen === _ctWatchPageGeneration,
    // значит живые значения относятся к этой же логической странице
    _ctRenderMarksStart   = _ctWatchPageStart;
    _ctRenderMarksPathIdx = _ctWatchPathIndex;
  }
}

/**
 * fix-13: все ли различные label конфига уже сработали.
 * Засчитываются только отметки с непустым tDom: отметка, созданная опередившим
 * paint'ом, ещё не «сработавшая метка» — её tDom придёт через debounce, и ранняя
 * финализация уехала бы с tDom = null, который потом уже не досылается.
 */
function _ct_renderAllLabelsFired() {
  try {
    const want = new Set();
    for (const it of _ctWatchList) {
      if (it && it.selector) want.add(_ct_renderSafeLabel(it.label || it.selector));
    }
    if (want.size === 0) return false;
    for (const m of _ctRenderMarks) if (m.tDom !== null) want.delete(m.label);
    return want.size === 0;
  } catch (e) { return false; }
}

/** fix-13: отметка t_dom. Ключ во всей цепочке — safe-label. */
function _ct_pushRenderMark(label, tDom, selector, gen) {
  try {
    if (gen !== _ctWatchPageGeneration) return;   // callback предыдущей страницы
    _ct_renderChainEnsureGen(gen);
    const safe  = _ct_renderSafeLabel(label);
    const found = _ctRenderMarks.find(m => m.label === safe);
    if (found) {
      // Отметку уже создал опередивший paint — дописываем t_dom и селектор.
      if (found.tDom === null) {
        found.tDom = tDom;
        found.sel  = _ct_renderSafeSel(selector);
        if (_ctRenderArmed && _ct_renderAllLabelsFired()) _ct_finalizeRenderChain();
      }
      return;                                     // дедупликация по label
    }
    if (_ctRenderMarks.length >= RENDER_CHAIN_MAX_MARKS) return;
    _ctRenderMarks.push({
      label:  safe,
      tDom:   tDom,
      tPaint: null,
      sel:    _ct_renderSafeSel(selector)
    });
    if (_ctRenderArmed && _ct_renderAllLabelsFired()) _ct_finalizeRenderChain();
  } catch (e) { /* цепочка не должна ронять watch-движок */ }
}

/** fix-13: копия отметок текущей генерации, отсортированная по tDom; null — в конец. */
function _ct_getRenderChain() {
  try {
    if (_ctRenderMarksGen !== _ctWatchPageGeneration) return [];
    return _ctRenderMarks
      .map(m => ({ label: m.label, tDom: m.tDom, tPaint: m.tPaint, sel: m.sel }))
      .sort((a, b) => {
        if (a.tDom === null && b.tDom === null) return 0;
        if (a.tDom === null) return 1;
        if (b.tDom === null) return -1;
        return a.tDom - b.tDom;
      });
  } catch (e) { return []; }
}

/**
 * fix-14: на сколько ноль цепочки отстоит от нуля записи.
 * start — значение performance.now(), то есть мс от timeOrigin.
 * clickTs для browser_navigation равен timeOrigin, для клика — Date.now() клика.
 * Формула одна на оба случая; отрицательное значение законно (цепочка началась раньше клика).
 */
function _ct_getRenderOffset(clickTs, start = _ctRenderMarksStart) {
  try {
    if (typeof clickTs !== 'number' || !Number.isFinite(clickTs)) return null;
    return Math.round(performance.timeOrigin + start) - clickTs;
  } catch (e) { return null; }
}

/**
 * fix-14: поколение и смещение для цепочки chain. Пустая цепочка → оба null (§6):
 * «меток нет» не должно выглядеть как «ноль на такой-то странице».
 */
function _ct_renderChainMeta(chain, clickTs) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { resWatchGen: null, resWatchOffset: null };
  }
  return {
    resWatchGen:    _ctRenderMarksPathIdx,
    resWatchOffset: _ct_getRenderOffset(clickTs)
  };
}

/**
 * fix-23: поля цепочки отрисовки для записи spa_route_change.
 * Цепочка принадлежит переходу, если после клика путь сменился и последняя смена пути
 * случилась, пока этот клик был последним (редирект роутера — тоже его страница).
 * Иначе {} — поля не пишутся, как до fix-23 («0 меток» здесь было бы неправдой).
 */
function _ct_spaRenderFields(clickSeq, clickPathIdx, clickTs) {
  if (_ctWatchPathIndex <= clickPathIdx) return {};       // путь не менялся (query/hash)
  if (_ctPathChangeClickSeq !== clickSeq) return {};      // путь сменил следующий клик
  const chain = _ct_getRenderChain();
  return Object.assign({
    resRenderChain: chain,
    resWatchCfg:    _ct_watchConfigVersion(siteConfig)
  }, _ct_renderChainMeta(chain, clickTs));
}

/**
 * fix-13: запись Element Timing → t_paint.
 * Генерация сравнивается с живой _ctWatchPageGeneration, а не с _ctRenderMarksGen:
 * paint может опередить debounce, и на этот момент цепочка ещё не заведена.
 */
function _ct_ingestRenderPaint(entry) {
  try {
    const id = entry && entry.identifier;
    if (typeof id !== 'string' || id.slice(0, 4) !== 'rum:') return; // чужая разметка
    const sep = id.lastIndexOf(':');
    if (sep <= 3) return;
    const safe = id.slice(4, sep);                 // safe-label не содержит ':'
    const gen  = Number(id.slice(sep + 1));
    if (!Number.isFinite(gen) || gen !== _ctWatchPageGeneration) return;
    _ct_renderChainEnsureGen(gen);
    // Та же база времени, что у tDom: обе величины на performance-таймлайне.
    const tPaint = Math.max(0, Math.round(entry.startTime - _ctWatchPageStart));
    let mark = _ctRenderMarks.find(m => m.label === safe);
    if (!mark) {
      // Paint опередил debounce — отметка создаётся с tDom = null.
      if (_ctRenderMarks.length >= RENDER_CHAIN_MAX_MARKS) return;
      mark = { label: safe, tDom: null, tPaint: null, sel: '' };
      _ctRenderMarks.push(mark);
    }
    // Первая отрисовка: при повторной записи оставляем меньшее значение.
    mark.tPaint = (typeof mark.tPaint === 'number') ? Math.min(mark.tPaint, tPaint) : tPaint;
  } catch (e) { /* t_paint необязателен */ }
}

/**
 * fix-13: версия набора watchSelectors. Нужна серверу, чтобы не смешивать периоды
 * до и после правки конфига. Возвращает НЕПУСТУЮ строку всегда — по ней сервер
 * отличает «маркеры не сработали» (res_render_n = 0) от «старая версия расширения».
 */
function _ct_watchConfigVersion(config) {
  try {
    const v = config && config.watchSelectorsVersion;
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 32);
    const list = (config && Array.isArray(config.watchSelectors)) ? config.watchSelectors : [];
    if (list.length === 0) return 'empty';
    let src = '';
    for (const it of list) {
      if (!it) continue;
      src += (it.label || '') + '|' + (it.selector || '');   // порядок конфига значим
    }
    // djb2-xor
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = Math.imul(h, 33) ^ src.charCodeAt(i);
    return 'h' + (h >>> 0).toString(16).padStart(8, '0');
  } catch (e) { return 'empty'; }
}

/**
 * fix-13: поставить досылку RENDER_CHAIN_UPDATE после отправки записи навигации.
 * Собственный цикл финализации, LCP_FINAL_UPDATE не переиспользуется: тот завершается
 * по первому pointerdown/keydown оператора, а watch-observer продолжает работать
 * и после взаимодействия — в этом весь смысл цепочки.
 */
function _ct_armRenderChainUpdate(clickId, clickTs) {
  try {
    if (!clickId) return;
    if (_ctRenderArmed) _ct_finalizeRenderChain();   // закрыть предыдущую запись
    _ctRenderArmed = {
      clickId:     clickId,
      sentCount:   _ct_getRenderChain().length,
      // fix-14: смещение считаем сейчас — при финализации clickTs уже недоступен.
      // Берём живой _ctWatchPageStart: цепочка может быть ещё пуста, а досылка уходит
      // строго до смены поколения, так что её цепочка — этой же страницы.
      offsetAtArm: _ct_getRenderOffset(clickTs, _ctWatchPageStart)
    };
    _ctRenderTimeoutId = setTimeout(_ct_finalizeRenderChain, RENDER_CHAIN_TIMEOUT_MS);
    window.addEventListener('pagehide', _ct_finalizeRenderChain, true);
    document.addEventListener('visibilitychange', _ct_onRenderVisibility, true);
  } catch (e) { /* досылка необязательна */ }
}

function _ct_onRenderVisibility() {
  if (document.visibilityState === 'hidden') _ct_finalizeRenderChain();
}

/**
 * fix-13: отправить цепочку, если она выросла после отправки записи.
 * Не более одного сообщения на запись навигации.
 */
function _ct_finalizeRenderChain() {
  const armed = _ctRenderArmed;
  if (!armed) return;
  _ctRenderArmed = null;                              // до отправки — защита от повтора
  try {
    if (_ctRenderTimeoutId) { clearTimeout(_ctRenderTimeoutId); _ctRenderTimeoutId = null; }
    window.removeEventListener('pagehide', _ct_finalizeRenderChain, true);
    document.removeEventListener('visibilitychange', _ct_onRenderVisibility, true);
    const chain = _ct_getRenderChain();
    if (chain.length > armed.sentCount) {
      chrome.runtime.sendMessage({
        type:           'RENDER_CHAIN_UPDATE',
        clickId:        armed.clickId,
        resRenderChain: chain,
        resWatchGen:    _ctRenderMarksPathIdx,   // fix-14; chain непуста → снимок актуален
        resWatchOffset: armed.offsetAtArm        // fix-14
      }, () => void chrome.runtime.lastError);
    }
  } catch (e) { /* background недоступен — остаётся значение на момент отправки */ }
}

/**
 * Найти новые watchSelectors и запланировать synthetic dom_appeared.
 * freshNodesOnly=true берёт только узлы, которых watcher не видел ни на одной
 * странице. Нужно для scan в момент SPA-reset: DOM предыдущего маршрута ещё
 * смонтирован, и без этого ограничения его узел дал бы dom_appeared с
 * длительностью ~0. Переиспользованный узел станет кандидатом на ближайшей
 * мутации, когда новый маршрут действительно отрисуется.
 */
function _ct_scanWatchSelectors(watchList, generation = _ctWatchGeneration,
                                { freshNodesOnly = false } = {}) {
  if (generation !== _ctWatchGeneration) return;

  // MutationObserver может увидеть новый DOM раньше 500-мс polling URL.
  // Синхронизируем логическую страницу до проверки fired labels.
  const currentKey = _ct_logicalPageKey();
  if (currentKey !== _ctWatchLogicalPath) {
    _ctWatchLogicalPath = currentKey;
    // fix-14: тот же сброс, что и из navigation hooks, включая скан только свежих узлов.
    // Узлы предыдущего маршрута ещё смонтированы: без freshNodesOnly они совпали бы
    // немедленно и дали t_dom ≈ 0 за блок, висящий на экране секундами.
    // watchList/generation здесь равны _ctWatchList/_ctWatchGeneration (проверено выше).
    _ct_resetWatchSeen();
    return;   // без return цикл ниже прошёл бы вторым сканом уже без freshNodesOnly
  }

  for (const item of watchList) {
    if (!item || typeof item.selector !== 'string' || !item.selector) continue;

    const label = item.label || item.selector;
    if (_ctWatchFiredLabels.has(label)) continue;

    let elements = null;
    try {
      elements = document.querySelectorAll(item.selector);
    } catch (e) {
      continue; // невалидный selector не должен останавливать остальные маркеры
    }

    // Seen-метка действует только внутри своей логической страницы.
    // Даёт оба нужных поведения: старый узел не фиксируется повторно на том же
    // маршруте, а узел, переиспользованный фреймворком при SPA-переходе
    // (React-реконсиляция сохраняет DOM карточки), снова становится кандидатом.
    let el = null;
    for (const candidate of elements) {
      const seenGen = candidate.__rumWatchSeenGen;
      if (seenGen === _ctWatchPageGeneration) continue;      // уже учтён на этой странице
      if (freshNodesOnly && seenGen !== undefined) continue; // узел прошлого маршрута
      el = candidate;
      break;
    }
    if (!el) continue;
    el.__rumWatchSeenGen = _ctWatchPageGeneration;

    // fix-13: пометка для Element Timing. Ставится до debounce — атрибут должен
    // оказаться на элементе раньше отрисовки, иначе браузер записи не породит.
    if (_ctRenderPaintEnabled) {
      try {
        if (!el.hasAttribute('elementtiming')) {
          el.setAttribute('elementtiming',
            'rum:' + _ct_renderSafeLabel(label) + ':' + _ctWatchPageGeneration);
        }
      } catch (e) { /* атрибут не обязателен, t_dom важнее t_paint */ }
    }

    const debounce = item.debounceMs || 500;
    const pageGeneration = _ctWatchPageGeneration;
    // Момент появления маркера, а не момент подтверждения: debounce только
    // проверяет, что узел не исчез, и не должен приплюсовываться к длительности.
    const appearedAt = Math.max(0, Math.round(performance.now() - _ctWatchPageStart));
    setTimeout(() => {
      // Старый config/observer или предыдущая SPA-страница — callback устарел.
      if (generation !== _ctWatchGeneration ||
          pageGeneration !== _ctWatchPageGeneration) return;
      if (!document.contains(el) || _ctWatchFiredLabels.has(label)) return;

      // Добавляем до sendMessage: параллельные selectors с тем же label не дублируются.
      _ctWatchFiredLabels.add(label);

      // fix-13: та же точка, где метка признана сработавшей. До sendMessage —
      // если досылка упадёт, синтетический dom_appeared всё равно уйдёт.
      _ct_pushRenderMark(label, appearedAt, item.selector, pageGeneration);

      const operationId = Date.now().toString(36)
        + Math.random().toString(36).slice(2, 6);

      // Установить active click_id для привязки AJAX.
      _ct_setActiveClickId(operationId);

      const syntheticClick = {
        clickId:        operationId,
        ts:             Date.now(),
        actionDuration: appearedAt,
        tabId:          _ctTabId,
        sessionId:      _ctSessionId,
        sourceType:     'dom_appeared',
        actionType:     label,
        actionEvidence: 'dom_appeared',
        selector:       item.selector,
        tagName:        el.tagName.toLowerCase(),
        targetUrl:      RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
        fromUrl:        RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
        transitionType: _ctTransitionType || '',
        journey_x:      _ctCoords?.X        ?? 1,
        journey_y:      _ctCoords?.Y        ?? 0,
        journey_z:      _ctZ                ?? 0,
        entryUrl:       _ctCoords?.entryUrl ?? ''
      };

      try {
        chrome.runtime.sendMessage(
          { type: 'ACTION_CLICK_CONFIRMED', click: syntheticClick },
          () => void chrome.runtime.lastError
        );
      } catch (e) { /* background временно недоступен */ }
    }, debounce);
  }
}

/**
 * Инициализирует MutationObserver для siteConfig.watchSelectors.
 * preserveFiredLabels=true используется только для hot-reload той же страницы.
 */
function _ct_initWatchSelectors(config, { preserveFiredLabels = false } = {}) {
  const generation = ++_ctWatchGeneration;

  // fix-13: единственная часть задачи, вмешивающаяся в DOM страницы. По умолчанию — вкл.
  // Читается до всех ранних return, чтобы рубильник действовал и при пустом watchList.
  _ctRenderPaintEnabled = !(config && config.renderPaintTiming === false);

  // Отключить предыдущий observer при re-init.
  if (_ctWatchObserver) {
    _ctWatchObserver.disconnect();
    _ctWatchObserver = null;
  }

  // Не накапливать DOMContentLoaded callbacks со старыми версиями конфига.
  if (_ctWatchDomReadyHandler) {
    document.removeEventListener('DOMContentLoaded', _ctWatchDomReadyHandler);
    _ctWatchDomReadyHandler = null;
  }

  if (!preserveFiredLabels) {
    _ctWatchFiredLabels.clear();
    // fix-13: цепочка предыдущей логической страницы закрывается ДО инкремента —
    // после него _ct_getRenderChain() вернёт [] и досылка ушла бы пустой
    _ct_finalizeRenderChain();
    _ctWatchPageGeneration += 1;
  }

  const watchList = Array.isArray(config?.watchSelectors)
    ? config.watchSelectors.slice()
    : [];
  _ctWatchList = watchList;
  if (watchList.length === 0) return;

  if (!document.body) {
    _ctWatchDomReadyHandler = () => {
      if (generation !== _ctWatchGeneration) return;
      _ctWatchDomReadyHandler = null;
      _ct_initWatchSelectors(config, { preserveFiredLabels });
    };
    document.addEventListener('DOMContentLoaded', _ctWatchDomReadyHandler, { once: true });
    return;
  }

  _ctWatchObserver = new MutationObserver(() => {
    _ct_scanWatchSelectors(watchList, generation);
  });

  _ctWatchObserver.observe(document.body, { childList: true, subtree: true });

  // fix-13: observer живёт весь content script. Guard обязателен: _ct_initWatchSelectors
  // вызывается повторно (DOMContentLoaded-retry, hot-reload конфига), и без него каждый
  // re-init добавлял бы наблюдателя, а t_paint ингестился бы кратно числу перезагрузок.
  if (_ctRenderPaintEnabled && !_ctRenderObs) {
    try {
      _ctRenderObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) _ct_ingestRenderPaint(e);
      });
      _ctRenderObs.observe({ type: 'element', buffered: true });
    } catch (e) { /* тип 'element' не поддержан — t_paint останется пустым */ }
  }

  // Элемент мог существовать ещё до запуска observer.
  _ct_scanWatchSelectors(watchList, generation);
}

/**
 * Снять seen-метки на текущей логической странице.
 * Нужно только для hot-reload настроек: re-init инвалидирует pending debounce
 * через _ctWatchGeneration, и без сброса метки узел остался бы «съеденным»
 * отменённым callback'ом до конца страницы. SPA-переход этой функции не требует —
 * там метки обесцениваются ростом _ctWatchPageGeneration.
 */
function _ct_clearWatchSeenFlags(config) {
  const watchList = (config && config.watchSelectors) || [];
  for (const item of watchList) {
    let elements = null;
    try { elements = document.querySelectorAll(item.selector); } catch (e) { continue; }
    for (const el of elements) el.__rumWatchSeenGen = undefined;
  }
}

/** Сбросить watchSelectors для новой логической SPA-страницы. */
function _ct_resetWatchSeen() {
  // fix-13: цепочка предыдущей логической страницы закрывается ДО инкремента —
  // после него _ct_getRenderChain() вернёт [] и досылка ушла бы пустой
  _ct_finalizeRenderChain();
  _ctWatchPageGeneration += 1; // отменяет debounce предыдущей страницы и её seen-метки
  _ctWatchFiredLabels.clear();
  _ctWatchPageStart = performance.now(); // duration считаем от перехода, не от открытия вкладки
  _ctWatchPathIndex += 1;                   // fix-14: единственная точка смены пути
  _ctPathChangeClickSeq = _ctActionClickSeq;   // fix-23
  _ctRenderMarksStart = _ctWatchPageStart;  // fix-14 (§3.3); окончательно фиксируется в EnsureGen
  // Уже готовый новый marker находится немедленно, без ожидания следующей
  // MutationObserver callback. Узлы предыдущего маршрута исключены: они ещё
  // смонтированы и дали бы ложный dom_appeared с длительностью ~0.
  _ct_scanWatchSelectors(_ctWatchList, _ctWatchGeneration, { freshNodesOnly: true });
}

/** Не выполнять SPA-reset дважды, если путь увидели несколько navigation hooks. */
function _ct_resetWatchSeenForNavigation() {
  const currentKey = _ct_logicalPageKey();
  if (currentKey === _ctWatchLogicalPath) return;
  _ctWatchLogicalPath = currentKey;
  _ct_resetWatchSeen();
}

/** Применить новый config watcher без повторной отправки label'ов текущей страницы. */
function _ct_reloadWatchSelectors(config) {
  const isWatchMode = siteMode === 'monitor' || siteMode === 'both';
  if (isWatchMode) _ct_clearWatchSeenFlags(config);
  _ct_initWatchSelectors(isWatchMode ? config : null, { preserveFiredLabels: true });
}

// ─── /watchSelectors helpers 

// ─── /click_id attribution helpers 

/** Построить payload из PerformanceResourceTiming entry */
function ctBuildAjaxEvent(entry) {
  // использовать RumSanitize.pageUrl вместо ctSanitizeResourceUrl —
  // маскирует GUID и числовые ID в path, не только снимает query/hash.
  // ctSanitizeResourceUrl оставлен как fallback-заглушка на случай ошибки.
  let resourceUrl    = '';
  let resourceDomain = '';
  let resourcePath   = '';
  try {
    resourceUrl    = RumSanitize.pageUrl(entry.name, siteConfig).slice(0, _CT_MAX_PAGE_URL);
    const _pu      = new URL(resourceUrl);
    resourceDomain = _pu.hostname;
    resourcePath   = _pu.pathname; // уже содержит маскированные ID из pageUrl()
  } catch {
    // fallback: хотя бы снимаем query/hash
    try {
      const _fb = ctSanitizeResourceUrl(entry.name);
      resourceUrl    = _fb.slice(0, _CT_MAX_PAGE_URL);
      resourceDomain = new URL(entry.name).hostname;
      resourcePath   = new URL(entry.name).pathname;
    } catch { /* полностью неразбираемый URL */ }
  }

  // продлить idle-окно привязки AJAX к click_id
  if (_ctCurrentClickId) _ct_touchAjaxIdle();

  return {
    tabId:           _ctTabId,
    // полная санитизация page_url через RumSanitize.pageUrl
    pageUrl:         RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
    sessionId:       _ctSessionId,
    clickId:         _ctCurrentClickId || '',

    journeyx:        _ctCoords?.X           ?? 1,
    journeyy:        _ctCoords?.Y           ?? 0,
    journeyz:        _ctZ,
    entryUrl:        _ctCoords?.entryUrl    ?? '',
    coordVersion:    2,
    transitionType:  _ctTransitionType,

    resourceUrl,
    resourceDomain,
    resourcePath,
    initiatorType:   entry.initiatorType,

    duration:        Math.round(entry.duration),
    ttfb:            ctSafeTimingDiff(entry.responseStart, entry.requestStart),
    dnsTime:         ctSafeTimingDiff(entry.domainLookupEnd, entry.domainLookupStart),
    connectTime:     ctSafeTimingDiff(entry.connectEnd, entry.connectStart),
    tlsTime:         entry.secureConnectionStart > 0
                       ? ctSafeTimingDiff(entry.connectEnd, entry.secureConnectionStart)
                       : null,
    requestTime:     ctSafeTimingDiff(entry.responseStart, entry.requestStart),
    responseTime:    ctSafeTimingDiff(entry.responseEnd, entry.responseStart),

    transferSize:    entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0,

    protocol:        entry.nextHopProtocol || '',
    responseStatus:  typeof entry.responseStatus === 'number' ? entry.responseStatus : 0,
    cached:          entry.transferSize === 0 && entry.decodedBodySize > 0,
    timestamp:       Date.now(),

    // migration guard
    journeyPos:      _ct_journeyPos()
  };
}

/** Отправка накопленного батча в background */
function ctFlushAjaxBatch() {
  if (ctAjaxBatch.length === 0) return;
  const batch = ctAjaxBatch.splice(0);
  try {
    chrome.runtime.sendMessage({ type: 'AJAX_TIMING_BATCH', payload: batch });
  } catch (e) {
    // SW может быть остановлен — silent fail
  }
  ctAjaxBatchTimer = null;
}

/** Добавить событие в батч (с throttle) */
function ctEnqueueAjaxEvent(event) {
  ctAjaxBatch.push(event);
  if (!ctAjaxBatchTimer) {
    ctAjaxBatchTimer = setTimeout(ctFlushAjaxBatch, CT_AJAX_BATCH_INTERVAL_MS);
  }
}

/** Callback PerformanceObserver */
function ctHandleResourceEntries(list) {
  const ignorePatterns = siteConfig?.ajaxIgnorePatterns || [];
  for (const entry of list.getEntries()) {
    if (!CT_AJAX_INITIATOR_TYPES.has(entry.initiatorType)) continue;
    if (!ctIsTrackableAjaxUrl(entry.name)) continue;
    if (ctShouldIgnoreAjaxUrl(entry.name, ignorePatterns)) continue;
    if (ctAjaxEventCount >= CT_AJAX_MAX_EVENTS_PER_PAGE) continue;
    ctAjaxEventCount++;
    ctEnqueueAjaxEvent(ctBuildAjaxEvent(entry));
  }
}

/**
 * Инициализация AJAX observer.
 * Вызывается из _ct_initCoords() после UPDATE_COORDS.
 */
function ctInitAjaxObserver(config) {
  if (config && config.disableAjaxTiming) return;
  if (ctAjaxObserverAttached) return;
  ctAjaxObserverAttached = true;
  ctAjaxEventCount = 0;
  // Применяем per-site hard cap, если задан
  CT_AJAX_MAX_EVENTS_PER_PAGE = (config && typeof config.ajaxMaxEventsPerPage === 'number')
    ? Math.max(50, Math.min(config.ajaxMaxEventsPerPage, 2000))
    : 500;
  try {
    ctAjaxObserver = new PerformanceObserver(ctHandleResourceEntries);
    ctAjaxObserver.observe({ type: 'resource', buffered: false }); // buffered:true вызывал freeze при восстановлении вкладки
    // Защита от переполнения performance buffer
    performance.addEventListener('resourcetimingbufferfull', () => {
      performance.clearResourceTimings();
    });
    ctAjaxEverStarted = true; // нужен для re-enable при hot-reload
  } catch (e) {
    ctAjaxObserverAttached = false;
  }
}

/** Остановить AJAX observer и сбросить состояние */
function ctDestroyAjaxObserver() {
  if (ctAjaxObserver) {
    ctAjaxObserver.disconnect();
    ctAjaxObserver = null;
  }
  ctFlushAjaxBatch(); // дослать накопленное
  ctAjaxObserverAttached = false;
  ctAjaxEventCount = 0;
}

/**
 * Применить изменение конфига ajaxTiming в hot-reload контексте.
 * Вызывается из chrome.storage.onChanged при обновлении siteConfig.
 * - Обновляет CT_AJAX_MAX_EVENTS_PER_PAGE немедленно.
 * - disableAjaxTiming=true → teardown, если observer работает.
 * - disableAjaxTiming=false/absent → re-enable, если observer был запущен на этой странице
 *   (ctAjaxEverStarted=true) и сейчас остановлен.
 */
function _ct_applyAjaxTimingConfig(newConfig) {
  // Обновить hard cap немедленно, не дожидаясь навигации
  if (newConfig && typeof newConfig.ajaxMaxEventsPerPage === 'number') {
    const cap = newConfig.ajaxMaxEventsPerPage;
    if (cap >= 50 && cap <= 2000) {
      CT_AJAX_MAX_EVENTS_PER_PAGE = cap;
    }
  }

  if (newConfig && newConfig.disableAjaxTiming) {
    if (ctAjaxObserverAttached) {
      ctDestroyAjaxObserver();
    }
  } else if (!ctAjaxObserverAttached && ctAjaxEverStarted) {
    ctInitAjaxObserver(newConfig);
  }
}

// При уходе со страницы — дослать накопленный батч
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    ctFlushAjaxBatch();
  }
});

// ─── /AJAX/Fetch Resource Timing Observer 

// Возвращает позицию в формате "X.Y.Z" (migration guard для совместимости)
function _ct_journeyPos() {
  return `${_ctCoords?.X ?? 1}.${_ctCoords?.Y ?? 0}.${_ctZ}`;
}

function _ct_assignClickZ(event) {
  if (event && _ctClickZByEvent.has(event)) return _ctClickZByEvent.get(event);
  _ctZ++;
  const clickZ = _ctZ;
  if (event) {
    try { _ctClickZByEvent.set(event, clickZ); } catch (e) {}
  }
  return clickZ;
}

// Определяет transition_type из Navigation Timing API.
function _ct_getNavTransitionType() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav) return 'unknown';
    if (nav.type === 'reload')        return 'reload';
    if (nav.type === 'back_forward')  return 'back_forward';
    if (nav.type === 'navigate')      return 'navigate';
  } catch (e) {}
  return 'unknown';
}

// определяет начальный transitionType с учётом browser-initiated навигации.
// Если в sessionStorage есть pending action click — это click-triggered full-page nav,
// возвращаем тип из PerformanceNavigationTiming (существующая логика не меняется).
// Если pending нет + nav type ∈ {navigate, reload, back_forward} — browser-initiated → 'direct'.
// 'direct' используется в background Rule 3 для сброса {X:1, Y:0} без изменения SPA-логики.
function _ct_getInitialTransitionType() {
  try {
    if (sessionStorage.getItem(_CT_ACTION_CLICK_PENDING_KEY)) {
      return _ct_getNavTransitionType(); // click-triggered — поведение без изменений
    }
  } catch (e) { /* sessionStorage недоступен */ }
  const navType = performance.getEntriesByType?.('navigation')?.[0]?.type;
  if (navType === 'navigate' || navType === 'reload' || navType === 'back_forward') {
    return 'direct'; // browser-initiated → background установит Y=0
  }
  return 'unknown';
}

// fix: дедуп двойных UPDATE_COORDS на одном SPA-переходе.
// История: history.pushState wrapper + Navigation API listener срабатывают
// оба на один и тот же pushState. Wrapper шлёт _ct_updateCoords('click'),
// затем Navigation API сравнивает свой lastUrl (старый, обновляется только
// внутри listener) с window.location.href (уже изменён pushState'ом) и
// шлёт _ct_updateCoords('click') ещё раз. Background во второй раз идёт по
// шагу 3 _bg_computeY (mapping уже записан) и возвращает тот же Y — не
// инкрементирует, но всё равно тратит chrome.runtime.sendMessage round-trip
// и persist. Дедупим по (sanitizedUrl, transitionType) с окном 250ms.
const _CT_UPDATE_COORDS_DEDUP_MS = 250;
let _ctLastUpdateCoordsKey = '';
let _ctLastUpdateCoordsTs = 0;

// Отправляет UPDATE_COORDS в background и кеширует ответ. Сбрасывает _ctZ.
async function _ct_updateCoords(transitionType) {
  try {
    const sanitizedUrl = RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL);
    const dedupKey = `${transitionType}|${sanitizedUrl}`;
    const now = Date.now();
    if (dedupKey === _ctLastUpdateCoordsKey &&
        (now - _ctLastUpdateCoordsTs) < _CT_UPDATE_COORDS_DEDUP_MS) {
      // Тот же URL+transitionType пришёл повторно за <250ms — одно SPA-событие
      // зарегистрировано двумя путями (pushState wrapper + Navigation API).
      // Background уже обработал первый, повтор не нужен.
      return;
    }
    _ctLastUpdateCoordsKey = dedupKey;
    _ctLastUpdateCoordsTs  = now;

    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'UPDATE_COORDS',
        url: sanitizedUrl,
        domain: window.location.hostname,
        transitionType,
        siteConfig: siteConfig || null
      }, r => {
        resolve(r);
      });
    });
    if (resp?.ok) {
      _ctCoords = { X: resp.X, Y: resp.Y, entryUrl: resp.entryUrl, coordVersion: resp.coordVersion };
      if (resp.sessionId) _ctSessionId = resp.sessionId;
      _ctZ = 0;
    }
  } catch (e) { /* background недоступен */ }
}

// Проверяет является ли URL точкой сброса воронки (дублирует логику bg, без импорта).
// при hashNavigation=true матчит по pathname+hash.
// Автосброс на '/' срабатывает только если hash пустой или отсутствует —
// иначе /#inbox в hash-nav режиме ложно сбрасывал бы воронку.
function _ct_isResetUrl(url, patterns, hashNavigation) {
  try {
    const p = new URL(url);
    const useHash = hashNavigation === true;
    const hasFragment = p.hash && p.hash.length > 1; // лучше чем  '#'
    const isRoot = p.pathname === '/' || p.pathname === '';
    if (isRoot && !(useHash && hasFragment)) return true;
    const ps = useHash ? p.pathname + p.hash : p.pathname + p.search;
    return (patterns || []).some(pat => pat && ps.includes(pat));
  } catch (e) { return false; }
}
// ─────────────────────────────────────────────────────────────────────────────

// Загружаем настройки
chrome.storage.sync.get(['rumEnabled'], (result) => {
  rumSettings = {...rumSettings, ...result};

  // Проверяем managed storage (корпоративные политики)
  checkManagedStorage().then(managedSettings => {
    // Объединяем настройки: managed > sync > defaults
    rumSettings = {...rumSettings, ...result, ...managedSettings};

    // Определяем per-site режим для текущего домена
    const domain = window.location.hostname;
    siteMode = getSiteMode(domain, managedSettings.siteConfigs);
    siteConfig = getSiteConfig(domain, managedSettings.siteConfigs);
    console.log('[RUM] siteMode:', siteMode, 'for', domain);

    if (siteMode === 'disabled') {
      return; // на disabled-домене ничего не запускаем
    }
    if (!rumSettings.rumEnabled) return;

    initRumCollection();
  }).catch((error) => {
    console.warn('[RUM] Managed storage error, trying to read basic settings:', error.message);

    // ИСПРАВЛЕНИЕ: Даже при ошибке пытаемся прочитать базовые настройки (customPCName и др.)
    // Это нужно, чтобы ошибка чтения siteConfigs не блокировала customPCName
    if (chrome.storage && chrome.storage.managed) {
      chrome.storage.managed.get(['customPCName', 'rumEnabled'], (basicSettings) => {
        if (!chrome.runtime.lastError && basicSettings) {
          console.log('[RUM] Basic managed settings found despite error:', basicSettings);
          rumSettings = {...rumSettings, ...result, ...basicSettings};
        }

        // default-deny — без siteConfigs из managed storage сбор не запускаем.
        siteMode = 'disabled';
      });
    } else {
      // default-deny при недоступном managed storage.
      siteMode = 'disabled';
    }
  });
});

// Hot-reload siteConfigs без перезагрузки страницы.
// Ограничение: сборщики, запущенные initRumCollection(), не перезапускаются и не
// останавливаются; новый режим полностью применяется со следующей навигации.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' && changes.siteConfigs) {
    const newSiteConfigs = changes.siteConfigs.newValue;
    const domain = window.location.hostname;
    const newMode = getSiteMode(domain, newSiteConfigs);
    const newConfig = getSiteConfig(domain, newSiteConfigs);

    siteConfig = newConfig; // всегда обновлять — иначе ajaxIgnorePatterns не применятся при смене без смены mode
    if (newMode !== siteMode) {
      console.log('[RUM] siteMode hot-reload:', siteMode, '->', newMode,
        '(mode switch takes full effect on next navigation)');
      siteMode = newMode;
    }
    // обновить AJAX конфиг (cap, teardown/re-enable observer)
    _ct_applyAjaxTimingConfig(newConfig);
    // fix-11: применить watchSelectors без повторной отправки label'ов этой страницы.
    _ct_reloadWatchSelectors(newConfig);
  }

  // [prepilot] Hot-reload при обновлении fileBasedSettings из background.js
  if (area === 'local' && changes.fileBasedSettings) {
    const newRaw = changes.fileBasedSettings.newValue;
    if (!newRaw) return;
    const processed = _processRawSettings(newRaw);
    const domain = window.location.hostname;
    const newMode = getSiteMode(domain, processed.siteConfigs);
    const newConfig = getSiteConfig(domain, processed.siteConfigs);
    siteConfig = newConfig; // всегда обновлять
    if (newMode !== siteMode) {
      console.log('[RUM] siteMode hot-reload (fileBasedSettings):', siteMode, '->', newMode);
      siteMode = newMode;
    }
    // обновить AJAX конфиг (cap, teardown/re-enable observer)
    _ct_applyAjaxTimingConfig(newConfig);
    // fix-11: применить watchSelectors без повторной отправки label'ов этой страницы.
    _ct_reloadWatchSelectors(newConfig);
  }
});

// Проверка корпоративных настроек через managed storage
async function checkManagedStorage() {
  try {
    // читаем ВСЕ ключи managed storage (null = get all), чтобы поддержать siteConfig_N
    const managedSettings = await new Promise((resolve, reject) => {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, (result) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result);
          }
        });
      } else {
        reject(new Error('Managed storage not available'));
      }
    });

    console.log('Managed storage settings found:', managedSettings);

    // [prepilot] useSettingsFile=1 → принудительно читать settings.json вместо реестра
    if (managedSettings.useSettingsFile) {
      const fileSettings = await _getFileBasedSettings();
      if (fileSettings) {
        console.log('[RUM] useSettingsFile=1, using fileBasedSettings');
        return _processRawSettings(fileSettings);
      }
    }

    const processedSettings = _processRawSettings(managedSettings);

    // [prepilot] Если managed пуст → пробуем settings.json как fallback
    if (Object.keys(processedSettings).length === 0) {
      const fileSettings = await _getFileBasedSettings();
      if (fileSettings) {
        console.log('[RUM] Managed storage empty, using fileBasedSettings as fallback');
        return _processRawSettings(fileSettings);
      }
    }

    return processedSettings;

  } catch (error) {
    console.log('Managed storage not available or error:', error.message);
    throw error;
  }
}

// [prepilot] Читает fileBasedSettings из chrome.storage.local (кладёт background.js)
function _getFileBasedSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get('fileBasedSettings', r => resolve(r.fileBasedSettings || null));
  });
}

// Обрабатывает сырые настройки (из managed storage или из settings.json).
// Поддерживает три источника siteConfigs с приоритетом:
//   1. siteConfigs — нативный массив (managed policy ADMX)
//   2. siteConfig_N — отдельные REG_SZ ключи реестра (fix9)
//   3. siteConfigsJson — JSON-строка (legacy fallback)
function _processRawSettings(raw) {
  const processedSettings = {};

  if (raw.customPCName) processedSettings.customPCName = raw.customPCName;
  if (typeof raw.rumEnabled === 'boolean') processedSettings.rumEnabled = raw.rumEnabled;
  if (Array.isArray(raw.disabledMetrics)) processedSettings.disabledMetrics = raw.disabledMetrics;

  // пре-пилот 1: нативный массив siteConfigs
  if (Array.isArray(raw.siteConfigs)) {
    processedSettings.siteConfigs = raw.siteConfigs;
  } else {
    // пре-пило 2: отдельные ключи siteConfig_N (REG_SZ, каждый — JSON-строка)
    const siteConfigEntries = Object.entries(raw)
      .filter(([key]) => /^siteConfig_\d+$/.test(key))
      .sort(([a], [b]) => parseInt(a.replace('siteConfig_', ''), 10) - parseInt(b.replace('siteConfig_', ''), 10))
      .map(([, val]) => {
        try {
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
          console.warn('[RUM] Failed to parse siteConfig_N value:', val, e.message);
          return null;
        }
      })
      .filter(Boolean);

    if (siteConfigEntries.length > 0) {
      processedSettings.siteConfigs = siteConfigEntries;
      console.log('[RUM] siteConfigs loaded from siteConfig_N keys:', siteConfigEntries.length);
    }
    // пре-пилот 3: siteConfigsJson (legacy JSON-string fallback)
    else if (raw.siteConfigsJson) {
      try {
        const parsed = JSON.parse(raw.siteConfigsJson);
        if (Array.isArray(parsed)) {
          processedSettings.siteConfigs = parsed;
          console.log('[RUM] siteConfigs loaded from siteConfigsJson');
        }
      } catch (e) {
        console.warn('[RUM] Failed to parse siteConfigsJson:', e.message);
      }
    }
  }

  return processedSettings;
}

// Проверяет соответствие configDomain паттерна странице pageDomain.
// Поддерживает: точное совпадение, *.suffix (все поддомены), * (catch-all)
function matchesDomain(configDomain, pageDomain) {
  if (configDomain === '*') return true;
  if (configDomain === pageDomain) return true;
  if (configDomain.startsWith('*.')) {
    const suffix = configDomain.slice(2); // убираем '*.'
    return pageDomain === suffix || pageDomain.endsWith('.' + suffix);
  }
  return false;
}

// делегация в общий helper services/siteConfig/match.js (RumSiteMatch).
// Дублирование wildcard-логики здесь запрещено.
function _findSiteConfig(domain, siteConfigs) {
  if (typeof self !== 'undefined' && self.RumSiteMatch) {
    return self.RumSiteMatch.findSiteConfig(domain, siteConfigs);
  }
  // Fallback (не должен срабатывать — match.js подгружается раньше content.js).
  if (!Array.isArray(siteConfigs) || siteConfigs.length === 0) return null;
  const exact = siteConfigs.find(c => c.domain === domain);
  if (exact) return exact;
  const subdomain = siteConfigs.find(c => c.domain.startsWith('*.') && matchesDomain(c.domain, domain));
  if (subdomain) return subdomain;
  return siteConfigs.find(c => c.domain === '*') || null;
}

// Определяет режим мониторинга для текущего домена на основе siteConfigs
function getSiteMode(domain, siteConfigs) {
  // делегируем в общий helper RumSiteMatch.resolveEffectiveMode.
  // Все слои (content/background/export) обязаны считать effective mode
  // одинаково, включая catch-all "*" downgrade до minimal.
  if (typeof self !== 'undefined' && self.RumSiteMatch) {
    const eff = self.RumSiteMatch.resolveEffectiveMode(domain, siteConfigs);
    // Диагностические warning'и оставляем на content-слое (ближе к админу).
    if (Array.isArray(siteConfigs) && siteConfigs.length > 0) {
      const cfg = self.RumSiteMatch.findSiteConfig(domain, siteConfigs);
      if (cfg && cfg.domain === '*' && (cfg.mode === 'monitor' || cfg.mode === 'both')) {
        console.warn('[RUM] catch-all "*" with strong mode', cfg.mode, '— downgraded to minimal (fix-8)');
      } else if (cfg && cfg.mode === 'discovery') {
        // compact fix-1: режим discovery удалён в 1.15.0 — домен отключается (default-deny)
        console.warn('[RUM] mode "discovery" removed in 1.15.0 — domain', domain, 'treated as disabled');
      } else if (cfg && ['monitor','both','minimal','disabled'].indexOf(cfg.mode) === -1) {
        console.warn('[RUM] Unknown siteMode:', cfg.mode, 'for domain:', domain, '— treating as disabled (fix-8 default-deny)');
      }
    }
    return eff;
  }
  // Fallback (не должен срабатывать — match.js грузится раньше content.js).
  if (!Array.isArray(siteConfigs) || siteConfigs.length === 0) return 'disabled';
  const config = _findSiteConfig(domain, siteConfigs);
  if (!config) return 'disabled';
  if (config.enabled === false) return 'disabled';
  const validModes = ['monitor', 'both', 'minimal', 'disabled'];
  if (!validModes.includes(config.mode)) return 'disabled';
  if (config.domain === '*' && (config.mode === 'monitor' || config.mode === 'both')) return 'minimal';
  return config.mode;
}

// Возвращает полный объект siteConfig для текущего домена
function getSiteConfig(domain, siteConfigs) {
  if (!Array.isArray(siteConfigs)) return null;
  return _findSiteConfig(domain, siteConfigs);
}

// Инициализация сбора RUM данных
function initRumCollection() {
  // disabled обрабатывается ещё до вызова этой функции, но на всякий случай guard
  if (siteMode === 'disabled') return;

  _ct_savePcName();

  // для minimal-режима — только web vitals + full_page_navigation.
  // minimal — явный облегчённый режим, выбранный админом через siteConfigs (не fallback).
  if (siteMode === 'minimal') {
    _ct_initCoordsLight();      // только получить tabId, без полного coord init
    collectCoreWebVitals();
    _ct_initActionClickCapture(); // с внутренним фильтром — только full_page_navigation пройдёт
    return;
  }

  // Запрашиваем tabId у background.js; после — инициализируем координаты.
  // Асинхронно — к моменту первого nav-клика значение гарантированно получено.
  try {
    chrome.runtime.sendMessage({type: 'GET_TAB_ID'}, (response) => {
      if (response?.tabId) _ctTabId = String(response.tabId);
      if (typeof response?.tabCreatedTs === 'number') _ctTabCreatedTs = response.tabCreatedTs;   // fix-14
    });
  } catch (e) { /* расширение может быть временно недоступно */ }

  // передаём timezone из браузерного контекста в background для экспорта 04.
  // SW может работать в отдельном OS-процессе с другим Intl; page-context надёжнее.
  try {
    const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (_tz) chrome.runtime.sendMessage({ type: 'REPORT_TIMEZONE', timezone: _tz }, () => {
      void chrome.runtime.lastError; // подавляем ошибку если background недоступен
    });
  } catch (e) { /* игнорируем: background использует SW-fallback timezone */ }

  // инициализируем координаты через background.js.
  _ct_initCoords();

  // fix-11: watcher не зависит от координат SW; fallback'и читаются при срабатывании.
  if (siteMode === 'monitor' || siteMode === 'both') {
    _ct_initWatchSelectors(siteConfig);
  }

  // Перехватываем history.pushState для SPA-навигации.
  // history.pushState НЕ вызывает popstate, поэтому collectNavTimings его не видит.
  // Здесь только обновляем tabCoords в background — nav timing по-прежнему идёт
  // через collectNavTimings (для navigationSelectors).
  // Guard: устанавливаем один раз — initRumCollection может быть вызван повторно
  // при hot-reload managed storage.
  if (window.__rumPushStateInstance !== _CT_INSTANCE_ID) {
    window.__rumPushStateInstance = _CT_INSTANCE_ID;
    // Сохраняем оригинальный pushState один раз, чтобы не накапливать цепочку обёрток
    // при повторных disable/enable циклах.
    if (!window.__rumOrigPushState) {
      window.__rumOrigPushState = history.pushState;
    }
    history.pushState = function(...args) {
      window.__rumOrigPushState.apply(history, args);
      // Обновляем координаты в background.
      _ct_updateCoords('click').catch(() => {});
      ctAjaxEventCount = 0; // сброс hard cap для новой SPA-"страницы"
      _ct_resetWatchSeenForNavigation();
      // ctAjaxEverStarted НЕ сбрасывается: observer продолжает работать после SPA-nav,
      // флаг нужен для re-enable при hot-reload disableAjaxTiming=false
    };
  }

  // SPA fallback — отслеживание смены URL через Navigation API или polling
  // Next.js и другие фреймворки могут обходить history.pushState патч
  (function _ct_setupSpaFallback() {
    if (window.__rumSpaFallbackInstance === _CT_INSTANCE_ID) return;
    window.__rumSpaFallbackInstance = _CT_INSTANCE_ID;

    let lastUrl = window.location.href;

    // Вариант 1: Navigation API (Chrome 105+)
    if (typeof navigation !== 'undefined' && navigation.addEventListener) {
      navigation.addEventListener('navigatesuccess', (e) => {
        const newUrl = window.location.href;
        if (newUrl !== lastUrl) {
          lastUrl = newUrl;
          const type = e.navigationType === 'traverse' ? 'back_forward' : 'click';
          _ct_updateCoords(type).catch(() => {});
          ctAjaxEventCount = 0; // сброс hard cap для новой SPA-"страницы"
          _ct_resetWatchSeenForNavigation();
        }
      });
      return; // Navigation API есть — polling не нужен
    }

    // Вариант 2: polling каждые 500ms (fallback для старых браузеров)
    setInterval(() => {
      const newUrl = window.location.href;
      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        // Polling не может определить тип навигации — используем 'navigate'
        // (не 'click', чтобы не инкрементировать Y как пользовательский шаг).
        // Если это был popstate — его listener уже обновил координаты раньше.
        _ct_updateCoords('navigate').catch(() => {});
        ctAjaxEventCount = 0; // сброс hard cap для новой SPA-"страницы"
        _ct_resetWatchSeenForNavigation();
      }
    }, 500);
  })();

  // popstate = back/forward навигация (постоянный listener, не {once: true})
  if (window.__rumPopstateInstance !== _CT_INSTANCE_ID) {
    window.__rumPopstateInstance = _CT_INSTANCE_ID;
    window.addEventListener('popstate', () => {
      _ct_updateCoords('back_forward').catch(() => {});
      ctAjaxEventCount = 0; // сброс hard cap при back/forward SPA-навигации
      _ct_resetWatchSeenForNavigation();
    });
  }

  collectCoreWebVitals();
  collectLongTasks();

  // collectCustomTimings запускается только в monitor/both: нужны cardSelectors из siteConfig
  if (siteMode === 'monitor' || siteMode === 'both') {
    collectCustomTimings();
  }

  // collectNavTimings запускается только в monitor/both при наличии navigationSelectors
  if ((siteMode === 'monitor' || siteMode === 'both') &&
      Array.isArray(siteConfig?.navigationSelectors) &&
      siteConfig.navigationSelectors.length > 0) {
    collectNavTimings();
  }

  // глобальный захват action clicks для 04-navigation-detail.csv
  // Запускается для всех режимов (disabled отфильтрован выше)
  _ct_initActionClickCapture();

  // Запускаем детекцию зависаний и пустых страниц
  watchForBlankPage();
  startHeartbeat();
  setupVisibilityChangeListener();

  // Отправляем агрегированные данные каждые 30 секунд
  // guard document.hidden — пропускаем тик пока вкладка скрыта,
  // данные накапливаются и отправятся на первом тике после восстановления
  setInterval(() => {
    if (document.hidden) return;
    sendAggregatedData();
  }, 30000);
}

// Имя ПК из настроек администратора (реестр или settings.json). Без имени ключ не пишем:
// background.js хранит случайный UUID (_bg_getPcIdentifier).
function _ct_savePcName() {
  if (!rumSettings.customPCName) return;
  chrome.storage.local.set({ pcIdentifier: { pcName: rumSettings.customPCName, generatedAt: new Date().toISOString() } });
}

// Сбор основных Web Vitals через единый реестр метрик (METRICS_REGISTRY).
// После миграции на vendored web-vitals: подписка идёт через webVitals.on*() внутри
// metric.collect(), а финальная отправка — по pagehide / visibilitychange:hidden.
// Промежуточная отправка через setTimeout(..., 10000) удалена сознательно: текущие
// экспортёры считают записи type:'web-vitals' как агрегатные, две записи на один
// page load приведут к двойному учёту в средних/перцентилях.
function collectCoreWebVitals() {
  // Guard от повторного запуска collect'ов на том же page load
  // (initRumCollection может быть вызван повторно при hot-reload managed storage).
  if (_webVitalsCollectorsStarted) return;
  _webVitalsCollectorsStarted = true;

  // Фильтруем активные метрики: enabled, не deprecated, не в disabledMetrics из managed policy
  const disabledByPolicy = rumSettings.disabledMetrics || [];
  const activeMetrics = METRICS_REGISTRY.filter(
    m => m.group === 'web-vitals' && m.enabled && !m.deprecated && !disabledByPolicy.includes(m.id)
  );

  for (const metric of activeMetrics) {
    try {
      const cleanup = metric.collect((value) => {
        metricValues[metric.id] = value;
        // Отменяем blank-page таймаут как только LCP зафиксирован
        if (metric.id === 'lcp' && value > 0 && lcpTimeoutId) {
          clearTimeout(lcpTimeoutId);
          lcpTimeoutId = null;
        }
      });
      if (cleanup) metricCleanups.push(cleanup);
    } catch (e) {
      console.warn('[RUM] Ошибка запуска collect для метрики:', metric.id, e);
    }
  }

  // Финальная отправка по lifecycle страницы.
  // Регистрируем listener'ы ПОСЛЕ цикла metric.collect(...): web-vitals сам вешает
  // свои pagehide/visibilitychange handlers внутри on*(), и наш handler должен
  // выполниться после них, чтобы к моменту sendRumData() metricValues уже содержал
  // финальные session-window CLS и 98-перцентильный INP.
  const finalize = () => {
    if (_webVitalsSent) return;
    _webVitalsSent = true;
    try {
      sendRumData({
        type: 'web-vitals',
        url: RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
        metrics: { ...metricValues }
      });
    } catch (e) {
      console.warn('[RUM] Web Vitals final send error:', e && e.message);
    }
  };
  // pagehide диспатчится на Window — слушаем на window.
  // visibilitychange диспатчится на Document — слушаем на document (как соседние
  // handler'ы того же файла: ctFlushAjaxBatch line 487, blank-page line 1840).
  // window-listener для visibilitychange полагался бы на bubbling, что менее надёжно
  // для критичной финальной отправки Web Vitals.
  window.addEventListener('pagehide', finalize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') finalize();
  });
}

// Сбор Long Tasks и расчёт доли
function collectLongTasks() {
  try {
    const longTaskObserver = new PerformanceObserver((entryList) => {
      _ct_onLongTaskEntries(entryList.getEntries());
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
    _ctLongTaskObserver = longTaskObserver;
  } catch (e) {
    // Long Tasks не поддерживаются
  }
}

// Обработка записей longtask: из callback наблюдателя и из takeRecords().
function _ct_onLongTaskEntries(entries) {
  const now = Date.now();
  entries.forEach((entry) => {
    longTaskCount++;
    totalLongTaskTime += entry.duration;
    pageLongTaskCount++;

    // Обновляем скользящий буфер для api-to-card корреляции.
    // TTL-очистка при записи: удаляем записи старше LONG_TASKS_TTL_MS.
    const cutoff = now - LONG_TASKS_TTL_MS;
    longTasksBuffer = longTasksBuffer.filter(t => t.ts >= cutoff);
    // Hard cap после TTL-очистки: на случай аномально высокой частоты Long Tasks.
    if (longTasksBuffer.length >= MAX_LONG_TASKS_BUFFER) {
      longTasksBuffer = longTasksBuffer.slice(-MAX_LONG_TASKS_BUFFER);
    }
    longTasksBuffer.push({ts: now, duration: entry.duration});
  });
}

// Число long tasks текущего документа с начала загрузки (compact fix-7).
// takeRecords() забирает записи, которые наблюдатель ещё не доставил в callback (buffered):
// запись full_page_navigation может уйти раньше этой доставки. Забранные записи в callback не придут.
function _ct_getPageLongTaskCount() {
  try {
    if (_ctLongTaskObserver) _ct_onLongTaskEntries(_ctLongTaskObserver.takeRecords());
  } catch (e) { /* ignore */ }
  return pageLongTaskCount;
}

// Выборка Long Tasks для конкретного окна корреляции (api-to-card).
// Hard cap при чтении не применяется — иначе можно потерять ранние записи внутри нужного окна.
function getLongTasksInWindow(windowStartTs) {
  return longTasksBuffer.filter(t => t.ts >= windowStartTs);
}

// Метрика click-to-card для monitor/both.
// Использует cardSelectors из siteConfig, если заданы; иначе generic-селекторы.
function collectCustomTimings() {
  const cardSelectors = siteConfig?.cardSelectors || [];
  const triggerSelector = 'button, a, [data-card], [data-load], .card-trigger, .load-trigger';

  document.addEventListener('click', (event) => {
    const element = event.target;
    if (element.matches(triggerSelector) || element.closest(triggerSelector)) {
      const clickStartPerfTime = performance.now();
      const clickStartWallTs = Date.now();
      observeNewCards(clickStartPerfTime, clickStartWallTs, cardSelectors);
    }
  });
}

// Наблюдение за появлением новых карточек.
// При обнаружении карточки прикрепляет Long Tasks из окна корреляции (api-to-card).
function observeNewCards(startPerfTime, startWallTs, cardSelectors) {
  const defaultSelectors = '.card, .item, .product, [data-card-id], .list-item, .result';
  const maxWait = siteConfig?.maxCardLoadTime || 10000; // дефолт увеличен с 5000 до 10000

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const matched = cardSelectors.length > 0
            ? cardSelectors.some(sel => {
                try { return node.matches(sel) || node.querySelector(sel); }
                catch (e) { return false; }
              })
            : (node.matches(defaultSelectors) || node.querySelector(defaultSelectors));

          if (matched) {
            const endTime = performance.now();
            const duration = Math.round(endTime - startPerfTime);

            // Получаем Long Tasks в окне click-to-card для api-to-card корреляции.
            const correlatedTasks = getLongTasksInWindow(startWallTs);

            customTimings.push({
              type: 'click-to-card',
              duration,
              timestamp: Date.now(),
              longTasksDetails: correlatedTasks.length > 0 ? correlatedTasks : null
            });

            observer.disconnect();
          }
        });
      }
    });
  });

  observer.observe(document.body, {childList: true, subtree: true});
  setTimeout(() => observer.disconnect(), maxWait);
}

// ─── nav timing helpers ────────────────────────────────────────────────

// Ключ для хранения незавершённой full-page навигации между страницами.
// Хранится в sessionStorage (изолирован по вкладке), а не в chrome.storage.local:
// общий ключ «перехватывала» другая вкладка того же домена, догружавшаяся в этот
// момент, — клик из вкладки B попадал в navTimings вкладки A с её tabId.
const _CT_PENDING_NAV_KEY = 'rumPendingNav';
// TTL незавершённой навигации: если страница не загрузилась за 30 сек — отброс
const _CT_PENDING_NAV_TTL_MS = 30000;

// Guard: не регистрируем click-listener для nav timings дважды
let _navClickListenerAttached = false;

// Возвращает первый CSS-selector из массива selectors, которому соответствует el
// или один из его предков. Нужен чтобы в данных хранить selector из конфига, а не
// производный tag.className.
function _ct_getMatchedNavSelector(el, selectors) {
  for (const sel of selectors) {
    try {
      if (el.matches(sel) || el.closest(sel)) return sel;
    } catch (e) {
      // невалидный selector — пропускаем
    }
  }
  return '';
}

// Ищет ближайший <a href> у el или его предков, возвращает href или ''.
function _ct_getTargetUrl(el) {
  try {
    const anchor = el.tagName === 'A' ? el : el.closest('a[href]');
    if (!anchor) return '';
    const href = anchor.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:')) return '';
    // Разворачиваем относительный URL в абсолютный
    return new URL(href, window.location.href).href;
  } catch (e) {
    return '';
  }
}

// Извлекает hostname из URL, fallback 'unknown' (дублирует _rd_extractDomain из export,
// но content.js не может импортировать export-модуль)
function _ct_extractDomain(url) {
  if (!url) return 'unknown';
  try { return new URL(url).hostname || 'unknown'; } catch (e) { return 'unknown'; }
}

function _ct_hasPendingActionClickForCurrentUrl() {
  try {
    const raw = sessionStorage.getItem(_CT_ACTION_CLICK_PENDING_KEY);
    if (!raw) return false;
    const pending = JSON.parse(raw);
    const age = Date.now() - (pending.ts || 0);
    if (age > 30000) return false;
    const currentSanitized = (typeof RumSanitize !== 'undefined')
      ? RumSanitize.pageUrl(window.location.href, siteConfig)
      : (window.location.origin + window.location.pathname);
    return !!currentSanitized && currentSanitized !== (pending.pageUrlBefore || '');
  } catch (e) {
    return false;
  }
}

/**
 * Инициализирует координаты при загрузке страницы.
 * Определяет transition_type, проверяет pending nav (full-page timing),
 * вызывает UPDATE_COORDS в background и кеширует результат.
 * Заменяет _ct_checkPendingNav() (fix-2).
 */
async function _ct_initCoords() {
  // 1. Базовый transition_type: fix-6 добавляет 'direct' для browser-initiated навигации
  let transitionType = _ct_getInitialTransitionType();

  // ранний sync set до первого await — _ct_initActionClickCapture() вызывается
  // синхронно из initRumCollection() без ожидания _ct_initCoords().
  // fix-22: _ct_captureBrowserNavigation() читает _ctBrowserNavTransitionType — начальный
  // тип, который ниже не уточняется. _ctTransitionType к моменту захвата уже может
  // быть уточнён до 'search'/'click' (до первого await в этой функции).
  _ctTransitionType = transitionType;
  _ctBrowserNavTransitionType = transitionType;   // fix-22
  const hasPendingActionClickForCurrentUrl = _ct_hasPendingActionClickForCurrentUrl();

  // 2. Проверяем sessionResetPatterns
  // передаём hashNavigation чтобы совпадение шло по pathname+hash при true.
  const resetPatterns = siteConfig?.sessionResetPatterns || [];
  // fix4: раньше search-апгрейд ловил только 'unknown'. Browser-open
  // URL-бара/закладки на reset-URL после длинной сессии давал 'direct' и шёл
  // в _bg_applyCoordRule правилом 3 (X сбрасывался в 1, Y=0), хотя
  // семантически это logical reset воронки в рамках текущей X-сессии
  // (правило 4: X сохраняется, Y=0).
  // Различение между F5/back-forward (должны идти в Rule 3) и browser-open
  // новой сессии (должно идти в Rule 4) делается по сырому
  // PerformanceNavigationTiming.type, а не по _ctTransitionType: последний
  // схлопывает navigate/reload/back_forward в 'direct', если sessionStorage
  // pending action-click пуст (см. _ct_getInitialTransitionType).
  // fix4 P4/P5: апгрейдим до 'search' только схлопнутый 'direct' +
  // rawNavType === 'navigate'. Browser-navigation capture на reset-URL держится
  // на _ctBrowserNavTransitionType (остаётся 'direct'), а не на await: с fix-15
  // pendingNav читается синхронно, и до первого await _ctTransitionType уже
  // 'search'/'click' — из-за этого захват отваливался (fix-22). Click-triggered
  // full-page nav с pending action-click приходит как raw 'navigate', но не
  // 'direct', поэтому не превращается в 'search'.
  const rawNavType = _ct_getNavTransitionType();
  if (rawNavType === 'navigate' &&
      transitionType === 'direct' &&
      _ct_isResetUrl(window.location.href, resetPatterns, siteConfig?.hashNavigation)) {
    transitionType = 'search';
  }

  // 3. Проверяем pending nav (full-page переход по клику)
  let pendingNavEntry = null;
  try {
    const raw = sessionStorage.getItem(_CT_PENDING_NAV_KEY);
    // Всегда чистим — не хотим "зависшую" запись при следующем заходе
    if (raw) sessionStorage.removeItem(_CT_PENDING_NAV_KEY);
    const p = raw ? JSON.parse(raw) : null;

    if (p) {
      const age = Date.now() - (p.clickTs || 0);
      const fromDomain = _ct_extractDomain(p.fromUrl);
      // tabId сверяем, если обе стороны известны: sessionStorage копируется
      // при «Дублировать вкладку» / window.open с opener
      const sameTab = !p.tabId || !_ctTabId || String(p.tabId) === _ctTabId;
      if (sameTab &&
          age <= _CT_PENDING_NAV_TTL_MS &&
          fromDomain === window.location.hostname &&
          p.fromUrl !== window.location.href) {
        // fix-3: pendingNav найден и валиден → это full-page переход по клику.
        // _ct_getInitialTransitionType() для click-triggered nav возвращает
        // 'navigate' (через _ct_getNavTransitionType()), поэтому сравнение
        // только с 'unknown' не апгрейдит его до 'click'. Из-за этого в
        // background.js _bg_computeY() уходил по depth-diff fallback (шаг 4),
        // что давало пропуски Y (каталог: 0→3, минуя 1,2) и занижение Y на
        // переходе вглубь→корзину (/cart с y=4 вместо currentY+1).
        // 'reload' и 'back_forward' оставляем нетронутыми: первый сбрасывает
        // координаты в _bg_applyCoordRule (правило 3), второй — не шаг вперёд
        // по воронке.
        if (transitionType !== 'reload' && transitionType !== 'back_forward') {
          transitionType = 'click';
        }
        pendingNavEntry = { p, age };
      }
    }
  } catch (e) { /* storage недоступен */ }

  // fix-4 P5: если full-page клик не попал в navigationSelectors и потому
  // не создал _CT_PENDING_NAV_KEY, но есть валидный pending action-click на
  // новую страницу, координатная семантика всё равно click, а не search/reset.
  if (!pendingNavEntry &&
      transitionType === 'navigate' &&
      hasPendingActionClickForCurrentUrl) {
    transitionType = 'click';
  }

  _ctTransitionType = transitionType;

  // 4. Отправляем UPDATE_COORDS — получаем X/Y/entryUrl для текущей страницы
  await _ct_updateCoords(transitionType);

  // 5. Если был pending nav — добавляем запись с актуальными координатами
  if (pendingNavEntry) {
    const { p, age } = pendingNavEntry;

    // гранулярные full-page метрики из PerformanceNavigationTiming
    let navReady = null, navTtfb = null, navRender = null;
    let navDomInteractive = null, navDomComplete = null;
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.domContentLoadedEventEnd > 0) {
        navReady          = Math.round(nav.domContentLoadedEventEnd + (performance.timeOrigin - p.clickTs));
        navTtfb           = Math.round(nav.responseStart - nav.requestStart);
        navRender         = Math.round(nav.domContentLoadedEventEnd - nav.responseEnd);
        navDomInteractive = Math.round(nav.domInteractive);
        navDomComplete    = Math.round(nav.domComplete);
        if (navReady < 0) navReady = null; // guard: clock skew
      }
    } catch (e) { /* PerformanceNavigationTiming недоступен */ }

    navTimings.push({
      duration:          age,
      navReady:          navReady,
      navTtfb:           navTtfb,
      navRender:         navRender,
      navDomInteractive: navDomInteractive,
      navDomComplete:    navDomComplete,
      fromUrl:           p.fromUrl,
      toUrl:             RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
      selector:          p.selector    || '',
      targetUrl:         p.targetUrl  || '',
      timestamp:         p.clickTs,
      navType:           'full-page',
      journey_x:         _ctCoords?.X           ?? 1,
      journey_y:         _ctCoords?.Y           ?? 0,
      journey_z:         0,
      entryUrl:          _ctCoords?.entryUrl    ?? '',
      coordVersion:      _ctCoords?.coordVersion ?? 2,
      transitionType:    'click',
      sessionId:         _ctSessionId,
      journeyPos:        _ct_journeyPos(), // migration guard
      tabId:             _ctTabId
    });
  }

  // запускаем AJAX observer после получения координат/sessionId
  ctInitAjaxObserver(siteConfig);
}

// ─────────────────────────────────────────────────────────────────────────────

// Измерение времени SPA-навигации: click → новый вид отрисован.
// Запускается только при наличии siteConfig.navigationSelectors.
function collectNavTimings() {
  // pending nav check перенесён в _ct_initCoords() (вызывается при загрузке страницы)

  // guard — не регистрируем listener дважды (при hot-reload или повторном вызове)
  if (_navClickListenerAttached) return;
  _navClickListenerAttached = true;

  const triggerSelectors = siteConfig.navigationSelectors;
  const triggerSelector  = triggerSelectors.join(', ');

  document.addEventListener('click', (event) => {
    const el = event.target;
    if (!el.matches(triggerSelector) && !el.closest(triggerSelector)) return;

    const startTs         = Date.now();
    const fromUrl         = RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL);
    // selector из конфига (не производный tag.className)
    const matchedSelector = _ct_getMatchedNavSelector(el, triggerSelectors);
    const targetUrl       = _ct_getTargetUrl(el);
    // Z++ на DOM click. Если этот же Event увидит global action-click capture,
    // WeakMap вернёт тот же Z и не будет двойного инкремента.
    const clickZ          = _ct_assignClickZ(event);
    const clickX          = _ctCoords?.X           ?? 1;
    const clickY          = _ctCoords?.Y           ?? 0;
    const clickJourneyPos = _ct_journeyPos(); // migration guard

    // pending для full-page навигации — TTL-cleanup в _ct_initCoords() следующей страницы
    try {
      sessionStorage.setItem(_CT_PENDING_NAV_KEY, JSON.stringify({
        selector:   matchedSelector,
        fromUrl,
        clickTs:    startTs,
        targetUrl,
        journeyPos: clickJourneyPos, // migration guard
        tabId:      _ctTabId
      }));
    } catch (e) {
      // storage недоступен
    }

    // SPA-путь: hashchange / popstate (без перезагрузки страницы)
    const onUrlChange = () => {
      const toUrl = window.location.href;
      if (toUrl === fromUrl) return;

      // SPA-переход состоялся — pending уже не нужен (страница не перезагружалась)
      try { sessionStorage.removeItem(_CT_PENDING_NAV_KEY); } catch (e) {}

      let stabilizeTimer = null;
      const mo = new MutationObserver(() => {
        clearTimeout(stabilizeTimer);
        stabilizeTimer = setTimeout(async () => {
          mo.disconnect();
          // обновляем координаты через background (_ctZ сбрасывается внутри)
          await _ct_updateCoords('click');
          navTimings.push({
            duration:       Date.now() - startTs,
            fromUrl,
            toUrl,
            selector:       matchedSelector,
            targetUrl,
            timestamp:      startTs,
            navType:        'spa',
            journey_x:      clickX,
            journey_y:      clickY,
            journey_z:      clickZ,
            entryUrl:       _ctCoords?.entryUrl    ?? '',
            coordVersion:   _ctCoords?.coordVersion ?? 2,
            transitionType: 'click',
            sessionId:      _ctSessionId,
            journeyPos:     clickJourneyPos, // migration guard
            tabId:          _ctTabId
          });
        }, 300);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), siteConfig?.spaNavTimeout || 5000);
    };

    window.addEventListener('hashchange', onUrlChange, { once: true });
    window.addEventListener('popstate',   onUrlChange, { once: true });
  });
}

// Вычисляет статистику по navTimings для текущего периода
function _buildNavTransitionStats() {
  const durations = navTimings.map(t => t.duration).sort((a, b) => a - b);
  return {
    count:     durations.length,
    median:    getPercentile(durations, 50),
    p95:       getPercentile(durations, 95),
    avg:       Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    rawEvents: navTimings.map(t => ({ ...t }))
  };
}

// ─── Детекция зависания и пустых страниц ─────────────────────────────────────

// Периодический heartbeat для детекции зависания main thread
function startHeartbeat() {
  heartbeatIntervalId = setInterval(() => {
    heartbeatBeats++;
    const now = Date.now();
    const longTasksActive = longTasksBuffer.filter(t => t.ts >= now - 10000).length > 0;
    try {
      chrome.runtime.sendMessage({
        type: 'HEARTBEAT',
        // sanitize URL перед отправкой — маскирует GUID и числовые ID в path
        url: RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
        beats: heartbeatBeats,
        timestamp: now,
        longTasksActive,
        ttfb: metricValues['ttfb'] || 0
      });
    } catch (e) {
      // Extension context invalidated — расширение перезагружено
    }
  }, HEARTBEAT_INTERVAL_MS);

  window.addEventListener('beforeunload', () => {
    clearInterval(heartbeatIntervalId);
  }, { once: true });
}

// Детекция пустой страницы: если LCP не зафиксирован за LCP_TIMEOUT_MS
function watchForBlankPage() {
  lcpTimeoutId = setTimeout(() => {
    lcpTimeoutId = null;
    if ((metricValues['lcp'] || 0) > 0) return; // LCP уже зафиксирован

    const now = Date.now();
    const sessionDuration = now - pageLoadStart;
    const longTaskRatio = sessionDuration > 0
      ? Math.round((totalLongTaskTime / sessionDuration) * 1000) / 1000
      : 0;

    try {
      chrome.runtime.sendMessage({
        type: 'BLANK_PAGE_DETECTED',
        // sanitize URL перед отправкой
        url: RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
        ttfb: metricValues['ttfb'] || 0,
        longTaskRatio,
        sessionDuration: Math.round(sessionDuration),
        timestamp: now
      });
    } catch (e) {
      // Extension context invalidated
    }
  }, siteConfig?.pageLoadTimeout || LCP_TIMEOUT_MS); // per-site configurable
}

// Детекция "брошенной пустой страницы": пользователь ушёл при LCP = 0
function setupVisibilityChangeListener() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && (metricValues['lcp'] || 0) === 0) {
      const now = Date.now();
      try {
        chrome.runtime.sendMessage({
          type: 'ABANDONED_BLANK_PAGE',
          // sanitize URL перед отправкой
          url: RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
          timeOnPage: now - pageLoadStart,
          ttfb: metricValues['ttfb'] || 0,
          timestamp: now
        });
      } catch (e) {
        // Extension context invalidated
      }
    }
  });
}

// ─── Агрегация и отправка ─────────────────────────────────────────────────────

// Отправка агрегированных данных
function sendAggregatedData() {
  const now = Date.now();
  const sessionDuration = now - pageLoadStart;

  // Рассчитываем агрегированные метрики
  const longTaskRatio = sessionDuration > 0 ? (totalLongTaskTime / sessionDuration) : 0;

  // Статистика по кастомным таймингам
  let clickToCardStats = null;
  if (customTimings.length > 0) {
    const durations = customTimings.map(t => t.duration).sort((a, b) => a - b);
    // Собираем все Long Tasks деталей для api-to-card из всех timing-событий периода
    const allLongTasksDetails = customTimings
      .filter(t => t.longTasksDetails)
      .flatMap(t => t.longTasksDetails);
    clickToCardStats = {
      count: durations.length,
      median: getPercentile(durations, 50),
      p95: getPercentile(durations, 95),
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      longTasks: allLongTasksDetails.length > 0 ? {
        count: allLongTasksDetails.length,
        totalTime: Math.round(allLongTasksDetails.reduce((s, t) => s + t.duration, 0)),
        details: allLongTasksDetails
      } : null,
      rawEvents: customTimings.map(t => ({...t}))
    };
  }

  const aggregatedData = {
    type: 'aggregated-metrics',
    timestamp: now,
    url: RumSanitize.pageUrl(window.location.href, siteConfig).slice(0, _CT_MAX_PAGE_URL),
    sessionDuration: Math.round(sessionDuration),
    longTasks: {
      count: longTaskCount,
      totalTime: Math.round(totalLongTaskTime),
      ratio: Math.round(longTaskRatio * 1000) / 1000
    },
    customTimings: {
      clickToCard:   clickToCardStats,
      navTransition: navTimings.length > 0 ? _buildNavTransitionStats() : null
    }
  };

  sendRumData(aggregatedData);

  // Сброс счётчиков для следующего периода
  resetCounters();
}

// Сброс счётчиков агрегированного периода.
// longTasksBuffer НЕ сбрасывается: он TTL-based и нужен для корреляции между периодами.
function resetCounters() {
  longTaskCount = 0;
  totalLongTaskTime = 0;
  customTimings = [];
  navTimings = [];
  pageLoadStart = Date.now();
}

// Вычисление перцентилей
function getPercentile(sortedArray, percentile) {
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[index] || 0;
}

// Функция отправки RUM данных в background script
function sendRumData(data) {
  if (!rumSettings.rumEnabled) return;
  try {
    chrome.runtime.sendMessage({
      type: 'RUM_DATA',
      data: data
    });
  } catch (e) {
    // Extension context invalidated — расширение перезагружено,
    // старый content script продолжает работать. Ничего не делаем.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action Click Capture — candidate clicks → 04-navigation-detail.csv
//
// Архитектура:
//   1. Глобальный click listener перехватывает ВСЕ клики (не только navigationSelectors).
//   2. Для каждого клика открывается окно корреляции 1500 ms.
//   3. В окне детектируются evidence: SPA route change, form submit, modal open, AJAX.
//   4. При full-page navigation клик сохраняется в sessionStorage и подтверждается
//      на следующей странице через _ct_checkPendingActionClick().
//   5. Если evidence найдено — ACTION_CLICK_CONFIRMED → background.js → actionClicks.
//   6. Клики без evidence отбрасываются.
// ─────────────────────────────────────────────────────────────────────────────

const _CT_ACTION_CLICK_WINDOW_MS   = 1500; // окно корреляции клик → действие

/**
 * Генерирует компактный уникальный clickId без внешних зависимостей.
 * Формат: <timestamp base-36><4 random chars>
 */
function _ct_generateClickId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Строит простой CSS-selector для произвольного элемента DOM.
 * Используется вместо _ct_getMatchedNavSelector, который работает только с navigationSelectors.
 * Приоритет: #id → tag + первый класс + [role=...].
 */
function _ct_getSimpleSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = el.tagName.toLowerCase();
  if (el.id) return '#' + el.id;
  let cls = '';
  if (typeof el.className === 'string' && el.className.trim()) {
    cls = '.' + el.className.trim().split(/\s+/)[0];
  }
  const role = el.getAttribute ? el.getAttribute('role') : null;
  return tag + cls + (role ? `[role="${role}"]` : '');
}

/** compact fix-4: коллектор LCP страницы-назначения (services/vitals/resultVitals.js). */
function _ct_createLcpCollector() {
  return RumResultVitals.createLcpCollector({
    timeoutMs:       LCP_TIMEOUT_MS,
    describeElement: _ct_getSimpleSelector,
    onFinalUpdate:   (p) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: 'LCP_FINAL_UPDATE' }, p),
          () => void chrome.runtime.lastError);
      } catch (e) { /* background недоступен — остаётся значение на момент отправки */ }
    }
  });
}

/**
 * Проверяет, является ли элемент интерактивным кастомным контролом.
 * Нужно, чтобы не пропускать div/li/span с обработчиком, которые не попадают
 * в _ct_getTargetUrl / _ct_getMatchedNavSelector.
 */
function _ct_isInteractive(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName.toUpperCase();
  if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(tag)) return true;
  const role = el.getAttribute('role') || '';
  return ['button', 'link', 'menuitem', 'option', 'tab', 'checkbox', 'radio',
          'treeitem', 'gridcell'].includes(role);
}

/**
 * Ищет наиболее релевантного предка для candidate click:
 * интерактивный элемент или сам кликнутый el.
 */
function _ct_resolveInteractiveEl(el) {
  if (!el) return null;
  if (_ct_isInteractive(el)) return el;
  // ищем ближайший интерактивный предок
  const anchor = el.closest('a[href], button, [role="button"], [role="link"]');
  if (anchor) return anchor;
  return el; // возвращаем сам элемент — кастомный контрол
}

/**
 * Читает PerformanceNavigationTiming и Long Tasks из текущего контекста страницы.
 * Возвращает { navReady, navTtfb, navRender, navDuration, longTasks }.
 *
 * navReady = время от клика до DOMContentLoaded (использует clickTs для корреляции).
 * Если domContentLoadedEventEnd ещё 0 — возвращает null для nav_* (данные не готовы).
 */
function _ct_readNavTiming(clickTs) {
  let navReady = null, navTtfb = null, navRender = null, navDuration = null;
  let longTasks = 0;

  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.domContentLoadedEventEnd > 0) {
      // navReady: время от клика до DOMContentLoaded события страницы.
      // Вычисляется как (timeOrigin + DCL) - clickTs, где timeOrigin — старт нынешней страницы.
      const rd = Math.round((performance.timeOrigin + nav.domContentLoadedEventEnd) - clickTs);
      if (rd > 0 && rd < 120000) navReady = rd; // guard: не более 2 минут
      navTtfb   = nav.responseStart > 0
        ? Math.round(nav.responseStart - nav.requestStart) : null;
      navRender = nav.domContentLoadedEventEnd > 0 && nav.responseEnd > 0
        ? Math.round(nav.domContentLoadedEventEnd - nav.responseEnd) : null;
      if (navTtfb   !== null && navTtfb   < 0) navTtfb   = null;
      if (navRender !== null && navRender < 0) navRender = null;
      navDuration = navReady; // для full_page_navigation duration = navReady
    }
  } catch (e) { /* PerformanceNavigationTiming недоступен */ }

  // Long Tasks страницы с начала загрузки: наблюдатель collectLongTasks()
  // (getEntriesByType('longtask') в Chrome всегда пуст — compact fix-7)
  longTasks = _ct_getPageLongTaskCount();

  return { navReady, navTtfb, navRender, navDuration, longTasks };
}

/**
 * compact fix-5: обогащение записи полями operationTiming перед отправкой — общее для клика
 * на этой странице, клика → новая страница и прямого захода / F5.
 * При выключенном siteConfig.operationTiming или ошибке замера — send() без timeline-полей.
 */
function _ct_withOperationTiming(params, send) {
  const opConfig  = siteConfig?.operationTiming || {};
  const opEnabled = opConfig.enabled !== false;
  if (opEnabled && typeof measureOperationTime === 'function') {
    measureOperationTime({
      clickTimestamp: params.clickTimestamp,
      actionType:     params.actionType,
      durationMs:     params.durationMs,
      modalElement:   params.modalElement,
      config:         opConfig
    }).then((timing) => {
      send({
        contentTimeMs:    timing.contentTimeMs,
        dataReadyMs:      timing.dataReadyMs,
        visualStableMs:   timing.visualStableMs,
        operationTimeMs:  timing.operationTimeMs,
        operationTimeout: timing.operationTimeout,
        completionSignal: timing.completionSignal
      });
    }).catch(() => send());   // fallback: без timeline-полей
  } else {
    send();
  }
}

/**
 * compact fix-5: общая часть полной навигации — клик с прошлой страницы
 * (_ct_checkPendingActionClick) и прямой заход / F5 (_ct_captureBrowserNavigation).
 *
 * Ждёт nav timing и LCP: первая попытка через 150 ms (buffered-записи PerformanceObserver
 * приходят в callback следующей задачей), дальше — до 10 попыток через 500 ms.
 *   readNav()              — снимок nav timing на очередной попытке;
 *   isReady(nav)           — готов ли снимок;
 *   buildBase(nav, vitals) — запись без timeline-полей; vitals = { resLcp, resLcpCandidates, resCls }.
 *                            base.ts — «момент клика», base.navDuration — длительность для operationTiming.
 *
 * LCP и CLS собираем через PerformanceObserver с buffered:true.
 * buffered:true воспроизводит уже накопленные entries немедленно в callback,
 * даже если observer создан спустя несколько секунд после события.
 * performance.getEntriesByType() ненадёжен для LCP — может вернуть [] до первого пользовательского
 * взаимодействия или если браузер ещё не зафиксировал paint.
 * operationTiming запускается здесь, на новой странице: доступны LCP, loadEventEnd и layout-shift
 * страницы-назначения.
 */
function _ct_sendFullPageResult({ readNav, isReady, buildBase }) {
  // fix-10: LCP — долгоживущий коллектор, живёт до финализации LCP (первое взаимодействие /
  // скрытие вкладки / таймаут), а не до отправки записи. CLS — до отправки.
  const lcpCol = _ct_createLcpCollector();
  const clsCol = RumResultVitals.createClsCollector();

  function attempt(n) {
    const nav = readNav();
    if ((!isReady(nav) || lcpCol.getResLcp() === null) && n < 10) {
      setTimeout(() => attempt(n + 1), 500);
      return;
    }
    // fix-10: LCP-коллектор НЕ отключаем — при необходимости он дошлёт LCP_FINAL_UPDATE
    clsCol.stop();
    const resCls = clsCol.getValue();
    // fix-10: resLcp на момент отправки; может уточниться через LCP_FINAL_UPDATE
    const base = buildBase(nav, {
      resLcp:           lcpCol.getResLcp(),
      resLcpCandidates: lcpCol.getCandidates(),
      resCls
    });

    function send(timingFields) {
      // fix-10: resLcp — на момент фактической отправки: operationTiming мог задержать её на секунды
      // fix-13: цепочка и версия набора — тоже на момент фактической отправки
      // fix-14: поколение и смещение описывают ту же цепочку, поэтому считаются здесь же
      const renderChain = _ct_getRenderChain();
      const entry = Object.assign({}, base, timingFields || {}, {
        resLcp:           lcpCol.getResLcp(),
        resLcpCandidates: lcpCol.getCandidates(),
        resRenderChain:   renderChain,
        resWatchCfg:      _ct_watchConfigVersion(siteConfig)
      }, _ct_renderChainMeta(renderChain, base.ts));
      try {
        _ct_setActiveClickId(entry.clickId || '');
        chrome.runtime.sendMessage({ type: 'ACTION_CLICK_CONFIRMED', click: entry },
          () => void chrome.runtime.lastError);
      } catch (e) { /* background временно недоступен */ }
      // fix-10: досылка LCP_FINAL_UPDATE, если LCP финализируется позже
      lcpCol.armLateUpdate(entry.clickId || '');
      // fix-13: своя досылка цепочки отрисовки — блоки приезжают на 7-9 с
      _ct_armRenderChainUpdate(entry.clickId || '', base.ts);
    }

    // click_id — немедленно, не дожидаясь measureOperationTime
    _ct_setActiveClickId(base.clickId || '');
    _ct_withOperationTiming({
      clickTimestamp: base.ts,
      actionType:     'full_page_navigation',
      durationMs:     base.navDuration,
      modalElement:   null
    }, send);
  }

  // 150 ms: даём один event loop tick для flush buffered PerformanceObserver entries
  setTimeout(() => attempt(1), 150);
}

/**
 * Читает sessionStorage: если предыдущая страница сохранила pending action click
 * и URL изменился → подтверждает как full_page_navigation и отправляет в background.
 *
 * Вызывается один раз при инициализации content.js на каждой странице.
 */
function _ct_checkPendingActionClick() {
  try {
    const raw = sessionStorage.getItem(_CT_ACTION_CLICK_PENDING_KEY);
    if (!raw) return;
    sessionStorage.removeItem(_CT_ACTION_CLICK_PENDING_KEY);

    const pending = JSON.parse(raw);
    const age = Date.now() - (pending.ts || 0);
    if (age > 30000) return; // устарело — больше 30 сек прошло

    // Подтверждаем только если URL реально изменился
    const currentSanitized = (typeof RumSanitize !== 'undefined')
      ? RumSanitize.pageUrl(window.location.href, siteConfig)
      : (window.location.origin + window.location.pathname);

    if (!currentSanitized || currentSanitized === (pending.pageUrlBefore || '')) return;

    // Устанавливаем click_id немедленно — до цикла ожидания в _ct_sendFullPageResult
    _ct_setActiveClickId(pending.clickId || '');

    _ct_sendFullPageResult({
      readNav:   () => _ct_readNavTiming(pending.ts),
      isReady:   (timing) => timing.navReady !== null,
      buildBase: (timing, vitals) => Object.assign({}, pending, {
        actionEvidence: ['full_page_navigation'],
        actionType:     'full_page_navigation',
        resultUrl:      currentSanitized,
        navReady:       timing.navReady,
        navTtfb:        timing.navTtfb,
        navRender:      timing.navRender,
        navDuration:    timing.navDuration ?? age,
        longTasksCount: timing.longTasks,
        // метрики качества загрузки страницы-назначения (Вариант B)
        resLcp:           vitals.resLcp,           // LCP новой страницы, ms
        resLcpCandidates: vitals.resLcpCandidates,
        resCls:           vitals.resCls            // CLS новой страницы, 0..∞
      })
    });
  } catch (e) { /* sessionStorage недоступен или JSON невалиден */ }
}

/**
 * Захватывает browser-initiated full-page навигацию как synthetic ACTION_CLICK_CONFIRMED.
 * Вызывается из _ct_initActionClickCapture() после _ct_checkPendingActionClick().
 *
 * Активируется только когда _ctBrowserNavTransitionType === 'direct' (начальный тип
 * загрузки, до уточнений search/click в _ct_initCoords — fix-22), что означает:
 *   - PerformanceNavigationTiming.type ∈ {navigate, reload, back_forward}
 *   - И нет pending action click в sessionStorage (не click-triggered навигация)
 *
 * Собирает nav timing, LCP, CLS, timeline metrics (fix-5) и шлёт
 * ACTION_CLICK_CONFIRMED с sourceType='browser_navigation'.
 */
async function _ct_captureBrowserNavigation() {
  // Guard 1: только для browser-initiated navigations
  if (_ctBrowserNavTransitionType !== 'direct') return;

  // Guard 2: получаем и проверяем тип навигации
  let navEntry;
  try {
    navEntry = performance.getEntriesByType('navigation')[0];
  } catch (e) { return; }
  const navType = navEntry?.type;
  if (!navType || navType === 'prerender') return;
  if (navType !== 'navigate' && navType !== 'reload' && navType !== 'back_forward') return;

  // для minimal browser-nav не нужен — нет pending click, нет строки в 04
  if (siteMode === 'minimal') return;

  // Guard 3: one-shot per page load — ставим ПОСЛЕ проверки navType, чтобы
  // ранний выход из Guard 2 (API недоступен) не блокировал флаг навсегда.
  // Предотвращает дубли при hot-reload: повторный initRumCollection() не порождает новую навигацию,
  // но _ctBrowserNavTransitionType остаётся 'direct'.
  if (_ctBrowserNavCaptured) return;
  _ctBrowserNavCaptured = true;

  // Генерируем click_id немедленно — до цикла ожидания в _ct_sendFullPageResult
  const _bnEarlyClickId = `bn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _ct_setActiveClickId(_bnEarlyClickId);

  _ct_sendFullPageResult({
    readNav:   () => { try { return performance.getEntriesByType('navigation')[0]; } catch (e) { return undefined; } },
    isReady:   (ne) => !!(ne && ne.loadEventEnd > 0),
    buildBase: (ne, vitals) => {
      // Nav timing — абсолютные значения от start навигации (timeOrigin = 0)
      const navReady    = ne && ne.domContentLoadedEventEnd > 0
        ? Math.round(ne.domContentLoadedEventEnd) : null;
      const navTtfb     = ne && ne.responseStart > 0 && ne.requestStart >= 0
        ? Math.round(ne.responseStart - ne.requestStart) : null;
      const navRender   = ne && ne.domContentLoadedEventEnd > 0 && ne.responseEnd > 0
        ? Math.round(ne.domContentLoadedEventEnd - ne.responseEnd) : null;
      const navDuration = ne && ne.loadEventEnd > 0
        ? Math.round(ne.loadEventEnd) : null;

      const pageUrl = (typeof RumSanitize !== 'undefined')
        ? RumSanitize.pageUrl(window.location.href, siteConfig)
        : (location.origin + location.pathname);

      // «Момент клика» для browser nav = начало навигации (timeOrigin)
      const navStartTs = Math.round(performance.timeOrigin);
      // fix-14: отрезок «вкладка создана → документ начал грузиться». Для карточки от Avaya
      // это часть ожидания оператора, которой изнутри страницы не видно.
      // Только первый документ вкладки: на reload/back_forward/втором документе
      // та же разность даёт время жизни вкладки, а не время её открытия.
      const tabOpenLagMs = (typeof _ctTabCreatedTs === 'number'
                            && navType === 'navigate' && _ctHistLenAtStart === 1)
        ? Math.max(0, navStartTs - _ctTabCreatedTs)
        : null;

      return {
        clickId:         _bnEarlyClickId,
        ts:              navStartTs,
        tabId:           _ctTabId,
        sessionId:       _ctSessionId,

        journey_x:       _ctCoords?.X ?? 1,
        journey_y:       0,           // browser nav = начало нового трека
        journey_z:       0,
        entryUrl:        _ctCoords?.entryUrl ?? '',
        tabOpenLagMs:    tabOpenLagMs,   // fix-14
        coordVersion:    2,
        transitionType:  navType,     // 'navigate' | 'reload' | 'back_forward'

        sourceType:      'browser_navigation',
        actionType:      'full_page_navigation',
        actionEvidence:  ['full_page_navigation'],
        pageUrlBefore:   '',          // нет клика — нет предыдущей страницы
        resultUrl:       pageUrl,

        // Пустые click-поля
        selector:        '',
        tagName:         '',
        targetUrl:       '',

        // Nav timing
        navReady:        navReady,
        navTtfb:         navTtfb,
        navRender:       navRender,
        navDuration:     navDuration,
        actionDuration:  navDuration,

        // Web Vitals страницы назначения
        // fix-10: значение на момент отправки; может уточниться через LCP_FINAL_UPDATE
        resLcp:           vitals.resLcp,
        resLcpCandidates: vitals.resLcpCandidates,
        resCls:           vitals.resCls,

        // Long Tasks страницы с начала загрузки — как в _ct_readNavTiming (compact fix-7)
        longTasksCount:  _ct_getPageLongTaskCount()
      };
    }
  });
}

/**
 * Минимальная инициализация координат для siteMode='minimal'.
 * Получает только tabId от background, не отправляет UPDATE_COORDS.
 * X/Y/Z для minimal = 0 — нормально, отчёт 04 по minimal не строится.
 */
function _ct_initCoordsLight() {
  try {
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
      if (response?.tabId) _ctTabId = String(response.tabId);
      if (typeof response?.tabCreatedTs === 'number') _ctTabCreatedTs = response.tabCreatedTs;   // fix-14
    });
  } catch (e) { /* background временно недоступен */ }
  // UPDATE_COORDS не отправляем — полный coord init не нужен для other
}

// compact fix-5: приоритет признаков результата клика — первый найденный задаёт action_type
const _CT_ACTION_PRIORITY = [
  'full_page_navigation', 'spa_route_change', 'new_tab_or_window',
  'form_submit', 'modal_or_popup_opened', 'ajax_only_action', 'dom_state_change'
];

/** Ресурсные записи fetch/xhr — основа ajax_only_action. Может бросить: ловит вызывающий. */
function _ct_getAjaxResourceEntries() {
  return performance.getEntriesByType('resource').filter(
    e => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'
  );
}

/**
 * Состояние окна корреляции клика:
 *   st = { evidence: Set<string>, firstTs: number|null, resultUrl: string, modalEl: Element|null }
 * Отмечает признак; первый отмеченный задаёт firstTs (по умолчанию — сейчас; для ajax — старт запроса или null).
 */
function _ct_markEvidence(st, name, ts) {
  st.firstTs = st.firstTs ?? (ts === undefined ? Date.now() : ts);
  st.evidence.add(name);
}

/** new_tab_or_window: Ctrl/Cmd/Shift/средняя кнопка или ссылка с target="_blank". */
function _ct_isNewTabClick(event, el) {
  const isModifiedClick = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey;
  const linkEl = el.tagName.toLowerCase() === 'a' ? el
    : (el.closest ? el.closest('a') : null);
  return isModifiedClick || linkEl?.getAttribute('target') === '_blank';
}

/**
 * Наблюдатели на время окна: submit, появление модалки, aria-состояние кликнутого элемента,
 * смена URL без перезагрузки (SPA). Возвращает stop(): снимает всё; вызывается из finalize
 * и из beforeunload.
 */
function _ct_watchClickEffects(st, clickedEl, fromUrl) {
  // Слушатели, добавляемые на время окна (снимаются в stop)
  const onFormSubmit = () => { _ct_markEvidence(st, 'form_submit'); };
  document.addEventListener('submit', onFormSubmit, { capture: true });

  // MutationObserver: детектируем появление диалогов/модалок
  let modalObserver = null;
  try {
    modalObserver = new MutationObserver((mutations) => {
      if (st.evidence.has('modal_or_popup_opened')) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const ntag = node.tagName.toLowerCase();
          const nrole = (node.getAttribute && node.getAttribute('role')) || '';
          const ncls  = (typeof node.className === 'string') ? node.className : '';
          if (ntag === 'dialog' || nrole === 'dialog' ||
              /\b(modal|dialog|drawer|popup|popover)\b/i.test(ncls)) {
            _ct_markEvidence(st, 'modal_or_popup_opened');
            st.modalEl = node; // сохраняем для operationTiming
            return;
          }
        }
      }
    });
    modalObserver.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}

  // MutationObserver: dom_state_change — изменение aria-атрибутов ТОЛЬКО на кликнутом элементе.
  // subtree: false намеренно — наблюдаем только сам элемент, а не весь subtree вокруг него.
  // Это исключает ложные срабатывания от параллельных aria-мутаций реактивных фреймворков
  // на других частях страницы (ТЗ §3.1: требуется state change именно кликнутого контрола).
  let domStateObserver = null;
  try {
    domStateObserver = new MutationObserver(() => { _ct_markEvidence(st, 'dom_state_change'); });
    domStateObserver.observe(clickedEl, {
      attributes: true,
      attributeFilter: ['aria-expanded', 'aria-checked', 'aria-selected',
                        'aria-pressed', 'aria-current'],
      subtree: false
    });
  } catch (e) {}

  // Polling URL-change для SPA (pushState/replaceState/hash — не пойманы hashchange)
  let spaUrlBefore = fromUrl;
  const spaInterval = setInterval(() => {
    const cur = window.location.href;
    if (cur !== spaUrlBefore) {
      spaUrlBefore = cur; // предотвращаем повторное добавление
      if (!st.evidence.has('spa_route_change') && !st.evidence.has('full_page_navigation')) {
        _ct_markEvidence(st, 'spa_route_change');
        st.resultUrl = (typeof RumSanitize !== 'undefined')
          ? RumSanitize.pageUrl(cur, siteConfig)
          : (new URL(cur).origin + new URL(cur).pathname);
      }
      clearInterval(spaInterval);
    }
  }, 100);

  return function stop() {
    clearInterval(spaInterval);
    document.removeEventListener('submit', onFormSubmit, { capture: true });
    if (modalObserver)    { try { modalObserver.disconnect();    } catch (e) {} }
    if (domStateObserver) { try { domStateObserver.disconnect(); } catch (e) {} }
  };
}

/** ajax_only_action: новые fetch/xhr после клика (вызывать, только если других признаков нет). */
function _ct_detectAjaxOnly(st, ajaxCountBefore, clickTs) {
  try {
    const ajaxEntries = _ct_getAjaxResourceEntries();
    if (ajaxEntries.length > ajaxCountBefore) {
      // st.firstTs = момент старта первого нового AJAX-запроса (не время finalize).
      // Guard: используем startTime только если запрос стартовал ПОСЛЕ клика.
      // Иначе это фоновый polling/prefetch, попавший в буфер уже после клика —
      // duration_ms должен быть пустым, а не отрицательным.
      const firstNew = ajaxEntries[ajaxCountBefore];
      const ajaxStartAbs = Math.round(performance.timeOrigin + firstNew.startTime);
      _ct_markEvidence(st, 'ajax_only_action', ajaxStartAbs >= clickTs ? ajaxStartAbs : null);
    }
  } catch (e) {}
}

/** Запись клика без результата: id, время, координаты, URL до клика, селектор, тег, ссылка. */
function _ct_buildBaseClick({ clickId, clickTs, clickZ, fromUrl, el }) {
  // sanitized URL страницы в момент клика
  const pageUrlBefore = (typeof RumSanitize !== 'undefined')
    ? RumSanitize.pageUrl(fromUrl, siteConfig)
    : (location.origin + location.pathname);

  const tagName    = el.tagName.toLowerCase();
  const selector   = _ct_getSimpleSelector(el);
  const targetUrl  = _ct_getTargetUrl(el);

  const coords = _ctCoords || {};
  return {
    clickId,
    ts:           clickTs,
    tabId:        _ctTabId,
    sessionId:    _ctSessionId,
    journey_x:    coords.X    ?? '',
    journey_y:    coords.Y    ?? '',
    journey_z:    clickZ,
    pageUrlBefore,
    selector,
    tagName,
    targetUrl: (targetUrl && typeof RumSanitize !== 'undefined')
      ? (RumSanitize.pageUrl(targetUrl, siteConfig) || '')
      : (targetUrl || '')
  };
}

/**
 * Инициализирует глобальный захват action clicks.
 * Вызывается из initRumCollection() для режимов != disabled.
 * Guard window.__rumActionClickInstance предотвращает двойную регистрацию
 * при повторном вызове initRumCollection() (hot-reload managed storage).
 */
function _ct_initActionClickCapture() {
  // Проверяем pending click от предыдущей (full-page) навигации
  _ct_checkPendingActionClick();
  // если нет pending click — проверяем browser-initiated навигацию
  _ct_captureBrowserNavigation();

  // Per-instance guard: аналогично __rumPushStateInstance
  if (window.__rumActionClickInstance === _CT_INSTANCE_ID) return;
  window.__rumActionClickInstance = _CT_INSTANCE_ID;

  document.addEventListener('click', (event) => {
    const rawEl = event.target;
    if (!rawEl || rawEl.nodeType !== Node.ELEMENT_NODE) return;

    const interactiveEl  = _ct_resolveInteractiveEl(rawEl);
    const clickId        = _ct_generateClickId();
    const clickTs        = Date.now();
    const fromUrl        = window.location.href;
    const clickZ         = _ct_assignClickZ(event);
    const clickSeq     = ++_ctActionClickSeq;   // fix-23
    const clickPathIdx = _ctWatchPathIndex;     // fix-23

    const baseClick = _ct_buildBaseClick({ clickId, clickTs, clickZ, fromUrl, el: interactiveEl || rawEl });

    // Сохраняем в sessionStorage для подтверждения через full-page navigation
    try {
      sessionStorage.setItem(_CT_ACTION_CLICK_PENDING_KEY, JSON.stringify(baseClick));
    } catch (e) { /* storage может быть заблокирован */ }

    // для minimal не запускаем pipeline наблюдателей.
    // sessionStorage уже записан — этого достаточно для full_page_navigation через _ct_checkPendingActionClick.
    // Чистим pending если в течение окна навигации не произошло; beforeunload отменяет таймер при навигации.
    if (siteMode === 'minimal') {
      const _otherTimer = setTimeout(() => {
        try { sessionStorage.removeItem(_CT_ACTION_CLICK_PENDING_KEY); } catch (e) {}
      }, _CT_ACTION_CLICK_WINDOW_MS + 100);
      window.addEventListener('beforeunload', () => clearTimeout(_otherTimer), { once: true });
      return;
    }

    // ── Снимок счётчика AJAX-запросов до клика для ajax_only_action evidence ──
    let ajaxCountBefore = 0;
    try {
      ajaxCountBefore = _ct_getAjaxResourceEntries().length;
    } catch (e) {}

    // ── Набор evidence, собранный за окно корреляции ──────────────────────────
    const st = { evidence: new Set(), firstTs: null, resultUrl: '', modalEl: null };
    let   completed = false;

    // Немедленная проверка: new_tab_or_window
    // Ctrl/Cmd/Middle-click или элемент с target="_blank" открывают новую вкладку/окно.
    // Событие происходит сразу — не надо ждать окно корреляции.
    if (_ct_isNewTabClick(event, interactiveEl || rawEl)) _ct_markEvidence(st, 'new_tab_or_window');

    const stopWatch = _ct_watchClickEffects(st, interactiveEl || rawEl, fromUrl);

    // ── finalize: собираем итог, отправляем если есть evidence ───────────────
    const finalize = () => {
      if (completed) return;
      completed = true;
      stopWatch();

      // AJAX-only evidence: новые fetch/xhr запросы с момента клика
      if (!st.evidence.size) _ct_detectAjaxOnly(st, ajaxCountBefore, clickTs);

      if (!st.evidence.size) {
        // Нет evidence → клик без наблюдаемого эффекта, не сохраняем
        try { sessionStorage.removeItem(_CT_ACTION_CLICK_PENDING_KEY); } catch (e) {}
        return;
      }

      // Клик подтверждён на этой же странице → sessionStorage больше не нужен
      try { sessionStorage.removeItem(_CT_ACTION_CLICK_PENDING_KEY); } catch (e) {}

      const sortedEvidence = _CT_ACTION_PRIORITY.filter(e => st.evidence.has(e));
      if (!sortedEvidence.length) return;

      const actionType = sortedEvidence[0];

      // result_url: только если URL реально сменился
      if (!st.resultUrl && (actionType === 'spa_route_change' || actionType === 'full_page_navigation')) {
        const curSan = (typeof RumSanitize !== 'undefined')
          ? RumSanitize.pageUrl(window.location.href, siteConfig)
          : (location.origin + location.pathname);
        st.resultUrl = (curSan !== baseClick.pageUrlBefore) ? curSan : '';
      }

      const actionDuration = st.firstTs !== null ? (st.firstTs - clickTs) : null;

      function send(timingFields) {
        // для minimal отправляем только full_page_navigation
        // (full_page_navigation сюда не доходит — уходит через beforeunload + pending,
        //  но guard оставлен явно для защиты от будущих изменений)
        if (siteMode === 'minimal' && actionType !== 'full_page_navigation') return;
        const spaRender = actionType === 'spa_route_change' ? _ct_spaRenderFields(clickSeq, clickPathIdx, clickTs) : {};   // fix-23
        const confirmedClick = Object.assign({}, baseClick, {
          actionEvidence: sortedEvidence,
          actionType,
          resultUrl:      st.resultUrl || '',
          actionDuration
        }, timingFields || {}, spaRender);
        try {
          _ct_setActiveClickId(confirmedClick.clickId || '');
          chrome.runtime.sendMessage({ type: 'ACTION_CLICK_CONFIRMED', click: confirmedClick },
            () => void chrome.runtime.lastError);
        } catch (e) { /* background временно недоступен */ }
        // fix-23: блоки карточки приезжают за 3–9 с, запись уходит раньше
        if (spaRender.resRenderChain) _ct_armRenderChainUpdate(confirmedClick.clickId || '', clickTs);
      }

      // Устанавливаем click_id немедленно, не дожидаясь завершения measureOperationTime
      _ct_setActiveClickId(baseClick.clickId || '');
      _ct_withOperationTiming({
        clickTimestamp: clickTs,
        actionType,
        durationMs:     actionDuration,
        modalElement:   st.modalEl
      }, send);
    };

    // При full-page navigation страница уходит до истечения окна.
    // Не вызываем finalize — pending click в sessionStorage несёт данные на следующую страницу.
    const onBeforeUnload = () => {
      completed = true; // блокируем finalize из setTimeout
      stopWatch();
      // sessionStorage уже записан выше — передаём данные следующей странице
    };
    window.addEventListener('beforeunload', onBeforeUnload, { once: true });

    setTimeout(() => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      finalize();
    }, _CT_ACTION_CLICK_WINDOW_MS);

  }, true /* capture=true — перехватываем до любых page-level listeners */);
}

console.log('[RUM] Content script loaded for:', window.location.href);
