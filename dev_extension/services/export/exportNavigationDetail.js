/** services/export/exportNavigationDetail.js
Ролевой экспорт 04-navigation-detail — CSV и JSON. Общий расчёт строки —
_nd_computeClickMetrics, форматирование — _nd_buildRowForActionClick (CSV) и
_ndj_buildEventObject (JSON).

 Модель: action click — каждая строка = один пользовательский клик,
после которого зафиксирован наблюдаемый эффект (full_page_navigation,
spa_route_change, form_submit, modal_or_popup_opened, ajax_only_action, …).

Источник данных: aggregatedData.actionClicks (ring buffer 500, заполняется
content.js → ACTION_CLICK_CONFIRMED → background.js).

Фильтр сайтов: mode != disabled.
Формат CSV: UTF-8 BOM, разделитель ;, decimal comma для numeric values.
Формат JSON: нативные типы (раздел «JSON 04» в конце файла).
Сортировка строк: по ts ascending.
Имя файла: 04-navigation-detail_{pcname}_{YYYYMMDD}.csv / .json

Подключается через importScripts в background.js после exportAnomaliesCsv.js. */

// ─── Built-in пороги ──────────────────────────────────────────────────────────

const _ND_DEFAULTS = {
  typical_load_sec:    { warn: 3.0,  crit: 5.0  }, // алиас avg_load_sec
  slow_load_sec:       { warn: 5.0,  crit: 10.0 }, // алиас p95_load_sec
  long_tasks_per_action: { warn: 5 },               // per-action порог
  ajax_slow_sec:       { warn: 3.0 }               // прокси через typical_load_sec
};

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function _nd_sanitizePcName(name) {
  if (!name || typeof name !== 'string' || name.trim() === '') return 'none';
  return name.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function _nd_buildFileName(pcName, ext = 'csv') {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `04-navigation-detail_${_nd_sanitizePcName(pcName)}_${dateStr}.${ext}`;
}

/** 8601 UTC из timestamp (ms) */
function _nd_formatTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toISOString(); } catch { return ''; }
}

/** Извлекает hostname из URL, fallback '' */
function _nd_extractDomain(url) {
  if (!url) return '';
  try { return new URL(String(url).split('#')[0]).hostname || ''; } catch { return ''; }
}

/**
 * Проверяет, подходит ли hostname под паттерн siteConfig.domain.
 * Поддерживает: точное совпадение, *.suffix, catch-all *.
 */
function _nd_matchesDomain(hostname, pattern) {
  if (!hostname || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    return hostname === pattern.slice(2) || hostname.endsWith(pattern.slice(1));
  }
  return hostname === pattern;
}

/**
 * Safe-wrapper над RumSanitize.pageUrl().
 * В SW-контексте RumSanitize доступен через importScripts.
 * Fallback: origin + pathname без query/hash.
 */
function _nd_sanitizePageUrl(url, siteConfig) {
  if (!url) return '';
  if (typeof RumSanitize !== 'undefined' && typeof RumSanitize.pageUrl === 'function') {
    try { return RumSanitize.pageUrl(url, siteConfig) || ''; } catch { /* fall */ }
  }
  try {
    const u = new URL(String(url).split('#')[0]);
    return u.origin + u.pathname;
  } catch { return ''; }
}

/**
 * Экранирование ячейки CSV (разделитель ;, decimal comma).
 */
function _nd_csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  }
  const s = String(v);
  const guarded = (typeof csvFormulaGuard === 'function') ? csvFormulaGuard(s) : s;
  if (guarded.includes(';') || guarded.includes('"') || guarded.includes('\n') || guarded.includes('\r')) {
    return '"' + guarded.replace(/"/g, '""') + '"';
  }
  return guarded;
}

function _nd_csvRow(vals) {
  return vals.map(_nd_csvCell).join(';');
}

// ─── Конфигурация 

function _nd_parseSiteConfigs(settings) {
  if (!settings) return null;
  if (Array.isArray(settings.siteConfigs) && settings.siteConfigs.length > 0) {
    return settings.siteConfigs;
  }
  const entries = Object.entries(settings)
    .filter(([k]) => /^siteConfig_\d+$/.test(k))
    .sort(([a], [b]) =>
      parseInt(a.replace('siteConfig_', ''), 10) -
      parseInt(b.replace('siteConfig_', ''), 10)
    )
    .map(([, v]) => {
      try { return typeof v === 'string' ? JSON.parse(v) : v; }
      catch { return null; }
    })
    .filter(Boolean);
  return entries.length > 0 ? entries : null;
}

/**
 * Разрешает пороги для exportNavigationDetail.
 * Pipeline: siteConfig.executiveSummaryThresholds → globalThresholds → _ND_DEFAULTS.
 * Алиасы: avg_load_sec ↔ typical_load_sec, p95_load_sec ↔ slow_load_sec.
 */
function _nd_resolveThresholds(siteConfig, globalThresholds) {
  const siteT = siteConfig?.executiveSummaryThresholds;
  const globT = globalThresholds;

  function pick(key, alias) {
    return {
      warn: siteT?.[key]?.warn   ?? siteT?.[alias]?.warn
            ?? globT?.[key]?.warn ?? globT?.[alias]?.warn
            ?? _ND_DEFAULTS[key]?.warn ?? _ND_DEFAULTS[alias]?.warn,
      crit: siteT?.[key]?.crit   ?? siteT?.[alias]?.crit
            ?? globT?.[key]?.crit ?? globT?.[alias]?.crit
            ?? _ND_DEFAULTS[key]?.crit ?? _ND_DEFAULTS[alias]?.crit
    };
  }

  const typical = pick('typical_load_sec', 'avg_load_sec');
  const slow    = pick('slow_load_sec',    'p95_load_sec');

  // per-action long_tasks: ключ long_tasks_per_action или built-in 5
  const ltWarn =
    siteT?.long_tasks_per_action?.warn ??
    globT?.long_tasks_per_action?.warn ??
    _ND_DEFAULTS.long_tasks_per_action.warn;

  return { typical, slow, long_tasks_per_action_warn: ltWarn };
}

// ─── Сбор action clicks для домена 

/**
 * Фильтрует actionClicks по домену из поля pageUrlBefore.
 * Возвращает все action clicks, где хост pageUrlBefore совпадает с паттерном.
 */
function _nd_collectActionClicksForDomain(pattern, snapshot) {
  const result = [];
  for (const click of (snapshot.actionClicks || [])) {
    // у browser_navigation записей pageUrlBefore='' — берём resultUrl
    // для определения домена (на какую страницу пришли).
    const pageUrl = click.pageUrlBefore || click.pageUrl || click.resultUrl || '';
    // pageUrlBefore / resultUrl уже sanitized (origin+pathname); domain определяем по hostname
    const hostname = _nd_extractDomain(pageUrl);
    if (_nd_matchesDomain(hostname, pattern)) {
      result.push(click);
    }
  }
  return result;
}

// ─── Индекс nav timing метрик 

/**
 * Строит индекс navTimings rawEvents для join с action clicks.
 *
 * Ключ: "tabId:fromUrl_normalized"
 * Значение: { navReady, navTtfb, navRender, duration, longTasks, ts }
 *
 * Используется только для full_page_navigation и spa_route_change,
 * чтобы заполнить nav_ready_ms / nav_ttfb_ms / nav_render_ms / duration_ms / long_tasks.
 *
 * Клик считается связанным с nav raw event, если:
 *   - табы совпадают (tabId)
 *   - fromUrl совпадает (pageUrlBefore клика ≈ fromUrl nav события)
 *   - временная дистанция ≤ 10 сек
 */
function _nd_buildNavIndex(snapshot) {
  // index: Map<"tabId:fromUrlNorm" → Array<{navReady, navTtfb, navRender, duration, longTasks, ts}>>
  const idx = new Map();

  function norm(url) {
    // Нормализуем до origin+pathname (без query, hash) для сопоставления
    if (!url) return '';
    try {
      const u = new URL(String(url).split('#')[0]);
      return (u.origin + u.pathname).toLowerCase();
    } catch { return String(url).toLowerCase(); }
  }

  function addToIdx(tabId, fromUrl, entry) {
    const key = `${tabId}:${norm(fromUrl)}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(entry);
  }

  // 1. aggregatedData.navTimings если хранится как отдельный ключ
  const navRaw = snapshot.navTimings?._raw || snapshot.navTimings?.rawEvents;
  if (Array.isArray(navRaw)) {
    for (const ev of navRaw) {
      const tabId = String(ev.tabId ?? ev.tab_id ?? '');
      const fromUrl = ev.fromUrl || ev.pageUrl || ev.url || '';
      addToIdx(tabId, fromUrl, {
        navReady:   ev.navReady   ?? null,
        navTtfb:    ev.navTtfb    ?? null,
        navRender:  ev.navRender  ?? null,
        duration:   ev.duration   ?? null,
        longTasks:  ev.longTasksDetails?.count ?? 0,
        ts: ev.timestamp ?? 0
      });
    }
  }

  // 2. aggregatedMetrics → customTimings → navTransition → rawEvents
  for (const entry of (snapshot.aggregatedMetrics || [])) {
    const raws = entry.customTimings?.navTransition?.rawEvents;
    if (!Array.isArray(raws)) continue;
    for (const ev of raws) {
      const tabId = String(ev.tabId ?? ev.tab_id ?? '');
      const fromUrl = ev.fromUrl || ev.pageUrl || ev.url || '';
      addToIdx(tabId, fromUrl, {
        navReady:   ev.navReady   ?? null,
        navTtfb:    ev.navTtfb    ?? null,
        navRender:  ev.navRender  ?? null,
        duration:   ev.duration   ?? null,
        longTasks:  ev.longTasksDetails?.count ?? 0,
        ts: ev.timestamp ?? 0
      });
    }
  }

  return { idx, norm };
}

/**
 * Ищет наиболее близкий по времени nav timing entry для action click.
 * Окно сопоставления: ±10 секунд от click.ts.
 *
 * @returns {Object|null} найденный entry или null
 */
function _nd_findNavEntry(click, navIndex) {
  const { idx, norm } = navIndex;
  const tabId = String(click.tabId ?? '');
  const fromUrl = click.pageUrlBefore || '';
  if (!tabId || !fromUrl) return null;

  const key = `${tabId}:${norm(fromUrl)}`;
  const candidates = idx.get(key);
  if (!candidates || candidates.length === 0) return null;

  const clickTs = click.ts || 0;
  // Выбираем ближайший entry в окне ±10 сек
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs((c.ts || 0) - clickTs);
    if (dist <= 10000 && dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

// ─── Индексы для JOIN с аномалиями и AJAX ────────────────────────────────────

/**
 * Строит индексы для JOIN action click с аномалиями и AJAX.
 *
 * Ключ JOIN для аномалий: "tabId:journey_x:journey_y" (базовый ключ tabId+jx+jy).
 * Fallback для legacy-событий без journey_x/y: time-window в _nd_buildRowForActionClick.
 *
 * Ключ JOIN для AJAX: "tabId:journey_x:journey_y:journey_z".
 * Legacy AJAX без координат → ajaxLegacy (time-window fallback в buildRow).
 */
function _nd_buildIndexes(snapshot) {
  const freezeByTabJXY   = new Map();  // "tabId:jx:jy" → count
  const blankByTabJXY    = new Map();  // "tabId:jx:jy" → count
  const ajaxByTabXYZ     = new Map();  // "tabId:jx:jy:jz" → {count, slow, error}

  const freezeLegacy   = [];
  const blankLegacy    = [];
  const ajaxLegacy     = [];  // AJAX без координат — time-window fallback

  function incMap(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  // freeze: ключ tabId:jx:jy
  for (const ev of (snapshot.freezeEvents || [])) {
    const tabId = String(ev.tabId ?? ev.tab_id ?? '');
    const jx    = String(ev.journey_x ?? ev.journeyx ?? '');
    const jy    = ev.journey_y ?? ev.journeyY ?? null;
    if (jy !== null && jy !== undefined && jy !== '' && tabId) {
      incMap(freezeByTabJXY, `${tabId}:${jx}:${jy}`);
    } else {
      freezeLegacy.push(ev);
    }
  }

  // blank_page: ключ tabId:jx:jy
  for (const ev of (snapshot.blankPageEvents || [])) {
    const tabId = String(ev.tabId ?? ev.tab_id ?? '');
    const jx    = String(ev.journey_x ?? ev.journeyx ?? '');
    const jy    = ev.journey_y ?? ev.journeyY ?? null;
    if (jy !== null && jy !== undefined && jy !== '' && tabId) {
      incMap(blankByTabJXY, `${tabId}:${jx}:${jy}`);
    } else {
      blankLegacy.push(ev);
    }
  }

  // AJAX: базовый индекс без slow (slow зависит от порога сайта — пересчитается в buildIndexesWithSlow)
  const ajaxRaw = snapshot.ajaxTimings?._raw;
  if (Array.isArray(ajaxRaw)) {
    for (const ev of ajaxRaw) {
      const tabId = String(ev.tabId ?? '');
      const jx    = String(ev.journeyx ?? ev.journey_x ?? '');
      const jy    = String(ev.journeyy ?? ev.journey_y ?? '');
      const jz    = String(ev.journeyz ?? ev.journey_z ?? '');
      if (!tabId) continue;
      // Устаревшие AJAX-события без координат → привязка по временному окну
      if (!jx && !jy && !jz) {
        ajaxLegacy.push(ev);
        continue;
      }
      const key = `${tabId}:${jx}:${jy}:${jz}`;
      const cur = ajaxByTabXYZ.get(key) || { count: 0, slow: 0, error: 0 };
      cur.count++;
      const status = ev.responseStatus ?? ev.response_status ?? null;
      if (status !== null && (status === 0 || status >= 400)) cur.error++;
      ajaxByTabXYZ.set(key, cur);
    }
  }

  return { freezeByTabJXY, blankByTabJXY, ajaxByTabXYZ,
           freezeLegacy, blankLegacy, ajaxLegacy };
}

/**
 * Пересчитывает ajaxByTabXYZ с учётом slow-порога конкретного сайта.
 * Базовые индексы freeze/blank берём из baseIndexes без изменений.
 * ajaxLegacy (без координат) тоже пересчитывается с slow-флагом.
 */
function _nd_buildIndexesWithSlow(snapshot, siteConfig, typWarnMs, baseIndexes) {
  const ajaxByTabXYZ = new Map();
  const ajaxLegacy   = [];
  // индексы raw AJAX-событий для TTFB-полей nav-detail
  const ajaxEventsByClickId = new Map();  // clickId → AJAX[]
  const ajaxEventsByTabXYZ  = new Map();  // "tabId:jx:jy:jz" → AJAX[]
  const siteDomain   = siteConfig.domain || '';

  const ajaxRaw = snapshot.ajaxTimings?._raw;
  if (Array.isArray(ajaxRaw)) {
    for (const ev of ajaxRaw) {
      // Фильтруем AJAX по домену сайта (resource_domain)
      const resDomain = ev.resourceDomain || ev.resource_domain
        || _nd_extractDomain(ev.resourceUrl || ev.resource_url || '');
      if (siteDomain && siteDomain !== '*') {
        if (!_nd_matchesDomain(resDomain, siteDomain)) continue;
      }

      const tabId = String(ev.tabId ?? '');
      const jx    = String(ev.journeyx ?? ev.journey_x ?? '');
      const jy    = String(ev.journeyy ?? ev.journey_y ?? '');
      const jz    = String(ev.journeyz ?? ev.journey_z ?? '');
      if (!tabId) continue;

      const dur    = ev.duration ?? null;
      const status = ev.responseStatus ?? ev.response_status ?? null;
      const isSlow  = dur !== null && dur > typWarnMs;
      const isError = status !== null && (status === 0 || status >= 400);

      // в индекс по clickId кладём все AJAX с известным clickId
      const clickId = ev.clickId || ev.click_id || '';
      if (clickId) {
        const arr = ajaxEventsByClickId.get(clickId) || [];
        arr.push(ev);
        ajaxEventsByClickId.set(clickId, arr);
      }

      // Устаревшие AJAX-события без координат → привязка по временному окну
      if (!jx && !jy && !jz) {
        ajaxLegacy.push({ ...ev, _isSlow: isSlow, _isError: isError });
        continue;
      }

      const key = `${tabId}:${jx}:${jy}:${jz}`;
      const cur = ajaxByTabXYZ.get(key) || { count: 0, slow: 0, error: 0 };
      cur.count++;
      if (isSlow)  cur.slow++;
      if (isError) cur.error++;

      ajaxByTabXYZ.set(key, cur);

      // параллельно кладём raw событие в индекс по tab+xyz
      const arrXYZ = ajaxEventsByTabXYZ.get(key) || [];
      arrXYZ.push(ev);
      ajaxEventsByTabXYZ.set(key, arrXYZ);
    }
  }

  return {
    freezeByTabJXY:   baseIndexes.freezeByTabJXY,
    blankByTabJXY:    baseIndexes.blankByTabJXY,
    ajaxByTabXYZ,
    ajaxEventsByClickId,
    ajaxEventsByTabXYZ,
    freezeLegacy:     baseIndexes.freezeLegacy,
    blankLegacy:      baseIndexes.blankLegacy,
    ajaxLegacy
  };
}

// ─── TTFB-поля по связанным raw AJAX ──────────────────────────────────

/**
 * Выбирает 4 TTFB/size-поля из массива raw AJAX-событий, связанных
 * с одной строкой 04-navigation-detail.
 *
 * Правила (жёстко зафиксированы, одинаковы для CSV и JSON):
 *   - first:    ttfb AJAX с минимальным timestamp/ts (раньше всех стартовал)
 *   - longest:  ttfb AJAX с максимальным duration
 *   - heaviest: ttfb + size AJAX с максимальным размером
 *               (size = transferSize → encodedBodySize → decodedBodySize)
 *
 * Если связанный запрос не имеет ttfb (например, cross-origin без
 * Timing-Allow-Origin) — соответствующее TTFB-поле остаётся null.
 * Если ни у одного события size не определён — heaviest* тоже null.
 *
 * @param {Array} events
 * @returns {{first:number|null,longest:number|null,heaviestTtfb:number|null,heaviestSize:number|null}}
 */
function _nd_pickAjaxDerivedFields(events) {
  const out = { first: null, longest: null, heaviestTtfb: null, heaviestSize: null };
  if (!Array.isArray(events) || events.length === 0) return out;

  const getTs   = e => (e.timestamp ?? e.ts ?? null);
  const getDur  = e => (e.duration ?? null);
  const getTtfb = e => (e.ttfb ?? null);
  const getSize = e => {
    const t = e.transferSize;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    const enc = e.encodedBodySize;
    if (typeof enc === 'number' && Number.isFinite(enc)) return enc;
    const dec = e.decodedBodySize;
    if (typeof dec === 'number' && Number.isFinite(dec)) return dec;
    return null;
  };

  // first: минимальный timestamp
  let firstEv = null;
  for (const e of events) {
    const t = getTs(e);
    if (t === null) continue;
    if (!firstEv || t < getTs(firstEv)) firstEv = e;
  }
  if (firstEv) {
    const ttfb = getTtfb(firstEv);
    out.first = (typeof ttfb === 'number' && Number.isFinite(ttfb)) ? ttfb : null;
  }

  // Самый долгий запрос: максимальный duration
  let longestEv = null;
  for (const e of events) {
    const d = getDur(e);
    if (d === null || d === undefined) continue;
    if (!longestEv || d > getDur(longestEv)) longestEv = e;
  }
  if (longestEv) {
    const ttfb = getTtfb(longestEv);
    out.longest = (typeof ttfb === 'number' && Number.isFinite(ttfb)) ? ttfb : null;
  }

  // Самый тяжёлый запрос: максимальный size
  let heaviestEv = null;
  let heaviestSize = null;
  for (const e of events) {
    const sz = getSize(e);
    if (sz === null) continue;
    if (heaviestEv === null || sz > heaviestSize) {
      heaviestEv = e;
      heaviestSize = sz;
    }
  }
  if (heaviestEv) {
    const ttfb = getTtfb(heaviestEv);
    out.heaviestTtfb = (typeof ttfb === 'number' && Number.isFinite(ttfb)) ? ttfb : null;
    out.heaviestSize = heaviestSize;
  }

  return out;
}

/** Time-window fallback для legacy-событий без journey_y 
 * 
*/
function _nd_countLegacyByWindow(legacyEvts, navTabId, navTs, navDuration) {
  if (!legacyEvts.length || !navTabId) return 0;
  const windowEnd = navTs + (navDuration || 0) + 30000;
  let cnt = 0;
  for (const ev of legacyEvts) {
    const evTabId = String(ev.tabId ?? ev.tab_id ?? '');
    if (evTabId !== navTabId) continue;
    const evTs = ev.timestamp ?? ev.ts ?? 0;
    if (evTs >= navTs && evTs <= windowEnd) cnt++;
  }
  return cnt;
}

// ─── Alert flags ──────────────────────────────────────────────────────────────

/**
 * Вычисляет alert_flags для одной строки отчёта.
 * Флаги по TZ раздел 8: SLOW, VERY_SLOW, FREEZE, BLANK, LONG_TASKS, SLOW_AJAX, AJAX_ERROR.
 * Возвращает string[]: CSV склеивает через |, JSON пишет массивом.
 */
function _nd_computeAlertFlags(metrics, thresholds) {
  const flags = [];
  const { duration_ms, freeze_count, blank_count,
          long_tasks, ajax_slow_count, ajax_error_count,
          operation_time_ms, operation_timeout } = metrics;

  const typWarnMs  = (thresholds.typical?.warn ?? 3.0) * 1000;
  const slowWarnMs = (thresholds.slow?.warn    ?? 5.0) * 1000;
  const ltWarn     = thresholds.long_tasks_per_action_warn ?? 5;

  if (duration_ms != null && duration_ms > typWarnMs)  flags.push('SLOW');
  if (duration_ms != null && duration_ms > slowWarnMs) flags.push('VERY_SLOW');
  if (freeze_count  > 0)  flags.push('FREEZE');
  if (blank_count   > 0)  flags.push('BLANK');
  if (long_tasks != null && long_tasks > ltWarn) flags.push('LONG_TASKS');
  if (ajax_slow_count  > 0) flags.push('SLOW_AJAX');
  if (ajax_error_count > 0) flags.push('AJAX_ERROR');
  // SLOW_OPERATION — долгая операция по operation_time_ms.
  // Не ставится при operation_timeout=TRUE артефакт measurement noise.
  if (operation_time_ms != null && !operation_timeout && operation_time_ms > typWarnMs) {
    flags.push('SLOW_OPERATION');
  }

  return flags;
}

// ─── Расчёт строки (общий для CSV и JSON) ─────────────────────────────────────

/**
 * Общий расчёт одной строки 04 для action click: JOIN аномалий и AJAX, TTFB-поля,
 * nav-метрики, timeline, URL и alert_flags (string[]). Значения без форматирования
 * (null — значения нет); форматирование — _nd_buildRowForActionClick (CSV) и
 * _ndj_buildEventObject (JSON).
 */
function _nd_computeClickMetrics(click, siteConfig, navIndex, siteIndexes, thresholds) {
  const {
    freezeByTabJXY, blankByTabJXY, ajaxByTabXYZ,
    ajaxEventsByClickId, ajaxEventsByTabXYZ,
    freezeLegacy, blankLegacy, ajaxLegacy
  } = siteIndexes;

  const tabId = String(click.tabId ?? '');
  const jx    = click.journey_x ?? null;
  const jy    = click.journey_y ?? null;
  const jz    = click.journey_z ?? null;
  // ключи JOIN — из строк координат
  const jxStr = String(jx ?? '');
  const jyStr = String(jy ?? '');
  const jzStr = String(jz ?? '');
  const clickTs = click.ts || 0;

  // ── Аномалии JOIN 
  // Базовый ключ: tabId:journey_x:journey_y (TZ §7.2)
  const jxyKey = `${tabId}:${jxStr}:${jyStr}`;
  let freeze_count  = freezeByTabJXY.get(jxyKey)   || 0;
  let blank_count   = blankByTabJXY.get(jxyKey)     || 0;

  // Привязка по временному окну для устаревших событий без journey_x/y
  if (freezeLegacy.length)   freeze_count  += _nd_countLegacyByWindow(freezeLegacy,   tabId, clickTs, null);
  if (blankLegacy.length)    blank_count   += _nd_countLegacyByWindow(blankLegacy,    tabId, clickTs, null);

  // ── AJAX JOIN 
  const ajaxKey  = `${tabId}:${jxStr}:${jyStr}:${jzStr}`;
  const ajaxData = { ...(ajaxByTabXYZ.get(ajaxKey) || { count: 0, slow: 0, error: 0 }) };

  // Привязка по временному окну для устаревших AJAX-событий без координат
  if (ajaxLegacy && ajaxLegacy.length) {
    const windowEnd = clickTs + (click.navDuration || 0) + 30000;
    for (const ev of ajaxLegacy) {
      const evTabId = String(ev.tabId ?? '');
      if (evTabId !== tabId) continue;
      const evTs = ev.timestamp ?? ev.ts ?? 0;
      if (evTs >= clickTs && evTs <= windowEnd) {
        ajaxData.count++;
        if (ev._isSlow)  ajaxData.slow++;
        if (ev._isError) ajaxData.error++;
      }
    }
  }

  // ── raw AJAX события этой строки для TTFB-полей 
  // Инвариант: если у клика есть click_id, join только точный. Fallback
  // на tabXYZ/time-window применяется ТОЛЬКО для legacy-строк без click_id,
  // иначе можно подмешать чужие AJAX и исказить ajax_first/longest/heaviest.
  let ajaxEventsForRow = [];
  if (click.clickId) {
    // Точный join — либо нашли, либо пусто (fallback запрещён)
    if (ajaxEventsByClickId && ajaxEventsByClickId.has(click.clickId)) {
      ajaxEventsForRow = ajaxEventsByClickId.get(click.clickId);
    }
  } else if (ajaxEventsByTabXYZ && ajaxEventsByTabXYZ.has(ajaxKey)) {
    ajaxEventsForRow = ajaxEventsByTabXYZ.get(ajaxKey);
  } else if (ajaxLegacy && ajaxLegacy.length) {
    const windowEnd = clickTs + (click.navDuration || 0) + 30000;
    ajaxEventsForRow = ajaxLegacy.filter(ev => {
      if (String(ev.tabId ?? '') !== tabId) return false;
      const evTs = ev.timestamp ?? ev.ts ?? 0;
      return evTs >= clickTs && evTs <= windowEnd;
    });
  }
  const ajaxDerived = _nd_pickAjaxDerivedFields(ajaxEventsForRow);

  // ── Nav timing метрики ───────────────────────────────────────────────────
  // Источники (по приоритету):
  //   1. Поля click.navReady/navTtfb/navRender/navDuration — захвачены в
  //      _ct_checkPendingActionClick() прямо на новой странице (full_page_navigation).
  //      Работает для ЛЮБОГО клика, не только navigationSelectors.
  //   2. Fallback на nav index join (aggregatedMetrics rawEvents) — для кликов
  //      из navigationSelectors где pending nav был захвачен collectNavTimings().
  // nav_* поля заполняются только для full_page_navigation.
  // duration_ms заполняется для full_page_navigation и spa_route_change.
  const isFullPage = click.actionType === 'full_page_navigation';
  const isSpa      = click.actionType === 'spa_route_change';
  let nav_ready  = null;
  let nav_ttfb   = null;
  let nav_render = null;
  let duration_ms = null;
  let long_tasks  = 0;

  if (isFullPage) {
    // Приоритет 1: поля из payload, захваченные _ct_checkPendingActionClick()
    // на новой странице. Работает для ЛЮБОГО клика (не только navigationSelectors).
    nav_ready   = click.navReady    ?? null;
    nav_ttfb    = click.navTtfb     ?? null;
    nav_render  = click.navRender   ?? null;
    duration_ms = click.navDuration ?? null;
    // long_tasks: из payload (счётчик long tasks страницы, content.js _ct_getPageLongTaskCount)
    if (click.longTasksCount != null) long_tasks = click.longTasksCount;

    // Приоритет 2: fallback на nav index join (для legacy/старых данных без payload полей)
    if (nav_ready === null && duration_ms === null) {
      const navEntry = _nd_findNavEntry(click, navIndex);
      if (navEntry) {
        duration_ms = navEntry.duration  ?? null;
        if (!long_tasks) long_tasks = navEntry.longTasks ?? 0;
        nav_ready   = navEntry.navReady  ?? null;
        nav_ttfb    = navEntry.navTtfb   ?? null;
        nav_render  = navEntry.navRender ?? null;
      }
    }
  }

  if (isSpa) {
    const navEntry = _nd_findNavEntry(click, navIndex);
    if (navEntry) {
      duration_ms = navEntry.duration  ?? null;
      long_tasks  = navEntry.longTasks ?? 0;
      // nav_* для SPA намеренно остаются null
    }
    // Запасной вариант: actionDuration из payload если объединение по nav index не дало результата
    if (duration_ms === null && click.actionDuration != null) {
      duration_ms = click.actionDuration;
    }
  }

  // duration_ms для прочих action_type (new_tab_or_window, form_submit,
  // modal_or_popup_opened, dom_state_change): время от клика до детекции эффекта,
  // захваченное в content.js через evidenceFirstTs.
  // ajax_only_action детектируется только в конце окна — duration_ms остаётся null.
  if (!isFullPage && !isSpa && click.actionDuration != null) {
    duration_ms = click.actionDuration;
  }

  // ── Timeline milestones (migration guard) 
  // operationTimeMs присутствует только в записях, собранных после fix.
  // Для legacy записей все 6 timeline-колонок остаются пустыми.
  const hasTimeline = click.operationTimeMs !== undefined && click.operationTimeMs !== null;
  const content_time_ms   = hasTimeline ? (click.contentTimeMs   ?? null) : null;
  const data_ready_ms     = hasTimeline ? (click.dataReadyMs     ?? null) : null;
  const visual_stable_ms  = hasTimeline ? (click.visualStableMs  ?? null) : null;
  const operation_time_ms = hasTimeline ? (click.operationTimeMs ?? null) : null;

  // ── page_url_before 
  // Уже sanitized в content.js, дополнительно прогоняем через safe-wrapper на случай legacy-данных
  const page_url_before = _nd_sanitizePageUrl(click.pageUrlBefore || '', siteConfig);

  // ── result_url ────────────────────────────────────────────────────────────
  // Заполняется только при подтверждённой смене URL
  const result_url = (click.resultUrl && click.resultUrl !== page_url_before)
    ? _nd_sanitizePageUrl(click.resultUrl, siteConfig)
    : '';

  // ── target_url 
  const target_url = click.targetUrl
    ? _nd_sanitizePageUrl(click.targetUrl, siteConfig)
    : '';

  // ── alert_flags 
  const rowMetrics = { duration_ms, freeze_count, blank_count,
                       long_tasks, ajax_slow_count: ajaxData.slow, ajax_error_count: ajaxData.error,
                       // передаём для SLOW_OPERATION; operationTimeout пишется только булевым (operationTiming.js)
                       operation_time_ms, operation_timeout: click.operationTimeout === true };
  const alert_flags = _nd_computeAlertFlags(rowMetrics, thresholds);

  return {
    jx, jy, jz,
    freeze_count, blank_count, ajaxData, ajaxDerived,
    isFullPage, isSpa,
    nav_ready, nav_ttfb, nav_render, duration_ms, long_tasks,
    hasTimeline, content_time_ms, data_ready_ms, visual_stable_ms, operation_time_ms,
    page_url_before, result_url, target_url,
    alert_flags
  };
}

// ─── Построение строки CSV ────────────────────────────────────────────────────

/**
 * Строит массив значений (59 колонок, порядок — HEADER в _nd_buildCsvContent) для одного
 * action click. Расчёт — _nd_computeClickMetrics, здесь только CSV-форматирование.
 */
function _nd_buildRowForActionClick(click, siteConfig, navIndex, siteIndexes, thresholds, browser, timezone, pcName, reportIdentity) {
  const m = _nd_computeClickMetrics(click, siteConfig, navIndex, siteIndexes, thresholds);
  const {
    freeze_count, blank_count, ajaxData, ajaxDerived,
    isFullPage, isSpa,
    nav_ready, nav_ttfb, nav_render, duration_ms, long_tasks,
    hasTimeline, content_time_ms, data_ready_ms, visual_stable_ms, operation_time_ms,
    page_url_before, result_url, target_url
  } = m;
  const jx = String(m.jx ?? '');
  const jy = String(m.jy ?? '');
  const jz = String(m.jz ?? '');

  // ── ts 
  const ts = _nd_formatTs(click.ts || 0);

  // ── Timeline: флаг таймаута и сигнал завершения
  const operation_timeout = hasTimeline && click.operationTimeout ? 'TRUE' : '';
  const completion_signal = hasTimeline ? (click.completionSignal ?? '') : '';

  // ── action_evidence 
  const action_evidence = Array.isArray(click.actionEvidence)
    ? click.actionEvidence.join('|')
    : (click.actionEvidence || '');

  // ── Метрики качества загрузки страницы-назначения (только full_page_navigation) ──
  const res_lcp = isFullPage ? (click.resLcp ?? null) : null;
  const res_cls = isFullPage ? (click.resCls ?? null) : null;
  // fix-10: все LCP-кандидаты через | — "1576|1807|5138" (старые записи → '')
  const res_lcp_candidates = isFullPage && Array.isArray(click.resLcpCandidates)
    ? click.resLcpCandidates
        .map(c => (c && typeof c === 'object') ? c.t : c)
        .filter(v => v !== null && v !== undefined)
        .join('|')
    : '';
  // fix-12: селектор последнего кандидата — элемент, ставший LCP (старые записи → '')
  let res_lcp_el = '';
  if (isFullPage && Array.isArray(click.resLcpCandidates) && click.resLcpCandidates.length) {
    const _lastCand = click.resLcpCandidates[click.resLcpCandidates.length - 1];
    if (_lastCand && typeof _lastCand === 'object' && typeof _lastCand.cls === 'string') {
      res_lcp_el = _lastCand.cls;
    }
  }

  // fix-13: цепочка отрисовки блоков — "label:tDom/tPaint|..."; старые записи → ''
  // full_page_navigation и spa_route_change (fix-23)
  let res_render_chain = '';
  let res_render_n     = '';
  let res_watch_cfg    = '';
  if (isFullPage || isSpa) {
    res_watch_cfg = typeof click.resWatchCfg === 'string' ? click.resWatchCfg : '';
    if (Array.isArray(click.resRenderChain)) {
      // остаётся '' у старых записей без поля, но становится 0 при пустой цепочке
      res_render_n     = click.resRenderChain.length;
      res_render_chain = click.resRenderChain.map(m => {
        const label  = (m && m.label != null) ? String(m.label) : '';
        const tDom   = (m && typeof m.tDom   === 'number') ? m.tDom   : '';
        const tPaint = (m && typeof m.tPaint === 'number') ? m.tPaint : '';
        return label + ':' + tDom + '/' + tPaint;
      }).join('|');
    }
  }

  // fix-14: поколение/смещение цепочки (full_page_navigation и spa_route_change (fix-23)),
  // время открытия вкладки и точка входа трека. Пусто — значения нет; 0 — значение есть и оно ноль.
  const res_watch_gen       = (isFullPage || isSpa) && typeof click.resWatchGen    === 'number' ? click.resWatchGen    : '';
  const res_watch_offset_ms = (isFullPage || isSpa) && typeof click.resWatchOffset === 'number' ? click.resWatchOffset : '';
  const tab_open_lag_ms     = typeof click.tabOpenLagMs === 'number' ? click.tabOpenLagMs : '';
  const entry_url           = click.entryUrl ? _nd_sanitizePageUrl(click.entryUrl, siteConfig) : '';

  // ── alert_flags 
  const alert_flags = m.alert_flags.join('|');

  // ── 59 колонок (compact fix-1: JS-ошибки; compact fix-2: click_text, button_type). Сквозная нумерация в комментариях ниже устарела ещё до fix-12:
  // она не учитывает pc_cpu/pc_rum (ff-14.14), четыре атрибута ПК (fix-16) и четыре
  // ajax_*_ttfb. Не полагаться —
  // проверять равенством длин массива строки и HEADER.
  return [
    ts,                                    //  1  ts
    siteConfig.domain || '',               //  2  site_domain
    pcName || '',                          //  3  pc_name
    // ff-14.14: два registry-only PC-атрибута сразу после pc_name (пусто → '')
    (reportIdentity && reportIdentity.customPcNameCpu) || '', //  pc_cpu
    (reportIdentity && reportIdentity.customPcNameRum) || '', //  pc_rum
    // fix-16: атрибуты ПК из settings.json/реестра, в UI не показываются (пусто → '')
    (reportIdentity && reportIdentity.organizationName) || '', //  organization
    (reportIdentity && reportIdentity.location) || '',         //  location
    (reportIdentity && reportIdentity.commit1) || '',          //  commit1
    (reportIdentity && reportIdentity.commit2) || '',          //  commit2
    siteConfig._effMode || siteConfig.mode || '',  //  4  mode (effective mode, учитывает catch-all downgrade)
    browser || '',                         //  5  browser
    timezone || '',                        //  6  timezone
    click.sessionId  ?? '',                //  7  session_id
    click.tabId      ?? '',                //  8  tab_id
    click.clickId    ?? '',                //  9  click_id  ()
    jx,                                    // 10  journey_x
    jy,                                    // 11  journey_y
    jz,                                    // 12  journey_z
    click.sourceType   || 'click',         // 13  source_type: 'click' | 'browser_navigation' | 'dom_appeared' (, )
    click.transitionType || 'click',       // 14  transition_type: 'click' | 'navigate' | 'reload' | 'back_forward' (; guard для старых записей)
    page_url_before,                       // 15  page_url_before
    click.selector   ?? '',                // 16  selector
    click.tagName    ?? '',                // 17  element_tag
    target_url,                            // 20  target_url
    click.actionType ?? '',                // 21  action_type
    action_evidence,                       // 22  action_evidence
    result_url,                            // 23  result_url
    nav_ready  !== null ? nav_ready  : '', // 24  nav_ready_ms
    nav_ttfb   !== null ? nav_ttfb   : '', // 25  nav_ttfb_ms
    // 4 TTFB/size поля по связанным raw AJAX (между nav_ttfb_ms и nav_render_ms)
    ajaxDerived.first        !== null ? ajaxDerived.first        : '', // 26  ajax_first_request_ttfb_ms
    ajaxDerived.longest      !== null ? ajaxDerived.longest      : '', // 27  ajax_longest_request_ttfb_ms
    ajaxDerived.heaviestTtfb !== null ? ajaxDerived.heaviestTtfb : '', // 28  ajax_heaviest_request_ttfb_ms
    ajaxDerived.heaviestSize !== null ? ajaxDerived.heaviestSize : '', // 29  ajax_heaviest_request_size_bytes
    nav_render !== null ? nav_render : '', // 30  nav_render_ms
    duration_ms !== null ? duration_ms : '',        // 27  duration_ms
    // 6 timeline-колонок (28–33)
    content_time_ms   !== null ? content_time_ms   : '',  // 28  content_time_ms
    data_ready_ms     !== null ? data_ready_ms     : '',  // 29  data_ready_ms
    visual_stable_ms  !== null ? visual_stable_ms  : '',  // 30  visual_stable_ms
    operation_time_ms !== null ? operation_time_ms : '',  // 31  operation_time_ms
    operation_timeout,                                     // 32  operation_timeout
    completion_signal,                                     // 33  completion_signal
    // /fix
    long_tasks,                            // 34  long_tasks
    freeze_count,                          // 36  freeze_count
    blank_count,                           // 37  blank_count
    ajaxData.count,                        // 38  ajax_count
    ajaxData.slow,                         // 39  ajax_slow_count
    ajaxData.error,                        // 40  ajax_error_count
    res_lcp !== null ? res_lcp : '',       // 41  res_lcp_ms  (только full_page_navigation)
    res_lcp_candidates,                    // 42  res_lcp_candidates (fix-10: "1576|1807|5138")
    res_lcp_el,                            // 43  res_lcp_el  (fix-12: селектор последнего кандидата)
    res_cls !== null ? res_cls : '',       // 44  res_cls     (только full_page_navigation)
    alert_flags,                           // 45  alert_flags
    res_render_chain,                      // 46  res_render_chain (fix-13)
    res_render_n,                          // 47  res_render_n     (fix-13)
    res_watch_cfg,                         // 48  res_watch_cfg    (fix-13)
    res_watch_gen,                         //     res_watch_gen       (fix-14)
    res_watch_offset_ms,                   //     res_watch_offset_ms (fix-14)
    tab_open_lag_ms,                       //     tab_open_lag_ms     (fix-14)
    entry_url                              //     entry_url           (fix-14)
  ];
}

// ─── Общий цикл CSV и JSON ────────────────────────────────────────────────────

/**
 * Общая часть построителей 04: фильтр whitelist, активные сайты (_effMode), индексы,
 * обход сайтов и их кликов, сортировка по ts. Строку CSV или событие JSON строит
 * buildOne(click, siteConfig, navIndex, siteIndexes, thresholds).
 *
 * @returns {{ items: Array<{ ts: number, value: * }>, activeSites: Array } | { _err: string, activeSiteCount?: number }}
 */
function _nd_buildItems(snapshot, siteConfigs, globalThresholds, buildOne) {
  // защита export-слоя — отбрасываем события с доменов вне текущего whitelist.
  if (typeof self !== 'undefined' && self.RumExportWhitelist) {
    snapshot = self.RumExportWhitelist.filterSnapshot(snapshot, siteConfigs);
  }
  // Фильтр: mode != disabled
  // effective mode (catch-all "*" downgrade учитывается).
  const _resolveEff = (self.RumSiteMatch && self.RumSiteMatch.resolveEffectiveMode)
    || ((d, cs) => { const c = (cs || []).find(x => x.domain === d); return c ? (c.mode || 'disabled') : 'disabled'; });
  const activeSites = (siteConfigs || [])
    .map(sc => Object.assign({}, sc, { _effMode: _resolveEff(sc.domain, siteConfigs) }))
    .filter(sc => {
      const m = (sc._effMode || '').toLowerCase();
      return m !== 'disabled';
    });
  if (activeSites.length === 0) return { _err: 'no_active_sites' };

  // Проверяем наличие action clicks
  if (!Array.isArray(snapshot.actionClicks) || snapshot.actionClicks.length === 0) {
    return { _err: 'no_action_clicks', activeSiteCount: activeSites.length };
  }

  // Строим базовые индексы один раз для всего snapshot (без slow AJAX — зависит от порога сайта)
  const baseIndexes = _nd_buildIndexes(snapshot);

  // Строим индекс nav timing метрик
  const navIndex = _nd_buildNavIndex(snapshot);

  const items = []; // { ts: number, value: строка CSV | событие JSON }

  for (const siteConfig of activeSites) {
    const thresholds = _nd_resolveThresholds(siteConfig, globalThresholds);
    const typWarnMs  = (thresholds.typical?.warn ?? 3.0) * 1000;

    // Пересчитываем AJAX с учётом slow-порога этого сайта
    const siteIndexes = _nd_buildIndexesWithSlow(snapshot, siteConfig, typWarnMs, baseIndexes);

    // Собираем action clicks для этого домена
    const clicks = _nd_collectActionClicksForDomain(siteConfig.domain || '', snapshot);

    for (const click of clicks) {
      items.push({ ts: click.ts || 0, value: buildOne(click, siteConfig, navIndex, siteIndexes, thresholds) });
    }
  }

  if (items.length === 0) {
    return { _err: 'no_rows_for_sites', activeSiteCount: activeSites.length };
  }

  // Сортировка по ts ascending
  items.sort((a, b) => a.ts - b.ts);

  return { items, activeSites };
}

// ─── Snapshot API 

/**
 * Строит CSV-контент из уже загруженного snapshot.
 *
 * @param {Object} snapshot         - данные из local storage
 * @param {Array}  siteConfigs      - массив siteConfigs
 * @param {Object} globalThresholds
 * @param {string} browser
 * @param {string} timezone
 * @returns {{ csvContent: string, filename: string } | { _err: string, ... }}
 */
function _nd_buildCsvContent(snapshot, siteConfigs, globalThresholds, browser, timezone, reportIdentity) {
  const _identity = reportIdentity || { customPcNameCpu: '', customPcNameRum: '' };
  // pcIdentifier фильтр whitelist не меняет — имя ПК берём из исходного snapshot
  const pcName = snapshot.pcIdentifier?.pcName || '';

  const built = _nd_buildItems(snapshot, siteConfigs, globalThresholds,
    (click, siteConfig, navIndex, siteIndexes, thresholds) => _nd_buildRowForActionClick(
      click, siteConfig, navIndex, siteIndexes, thresholds, browser, timezone, pcName, _identity
    ));
  if (built._err) return built;

  const HEADER = [
    'ts', 'site_domain', 'pc_name',
    // ff-14.14: registry-only PC-атрибуты сразу после pc_name
    'pc_cpu', 'pc_rum',
    // fix-16: атрибуты ПК из settings.json/реестра
    'organization', 'location', 'commit1', 'commit2',
    'mode', 'browser', 'timezone',
    'session_id', 'tab_id', 'click_id',
    'journey_x', 'journey_y', 'journey_z',
    'source_type', 'transition_type', 'page_url_before',
    'selector', 'element_tag', 'target_url',
    'action_type', 'action_evidence', 'result_url',
    'nav_ready_ms', 'nav_ttfb_ms',
    // 4 TTFB/size-поля по связанным raw AJAX (между nav_ttfb_ms и nav_render_ms)
    'ajax_first_request_ttfb_ms', 'ajax_longest_request_ttfb_ms',
    'ajax_heaviest_request_ttfb_ms', 'ajax_heaviest_request_size_bytes',
    'nav_render_ms',
    'duration_ms',
    // timeline-метрики операции (6 новых колонок после duration_ms)
    'content_time_ms',    // основной контент отрисован
    'data_ready_ms',      // AJAX завершились
    'visual_stable_ms',   // визуально стабильно
    'operation_time_ms',  // полная интерактивность
    'operation_timeout',  // boolean: таймаут измерения
    'completion_signal',  // тип completion signal
    // /
    'long_tasks',
    'freeze_count', 'blank_count',
    'ajax_count', 'ajax_slow_count', 'ajax_error_count',
    'res_lcp_ms',   // LCP страницы-назначения, только full_page_navigation
    'res_lcp_candidates', // fix-10: все LCP-кандидаты через |, только full_page_navigation
    'res_lcp_el',   // fix-12: селектор последнего LCP-кандидата, только full_page_navigation
    'res_cls',      // CLS страницы-назначения, только full_page_navigation
    'alert_flags',
    'res_render_chain', // fix-13: цепочка отрисовки "label:t_dom/t_paint|...", full_page_navigation и spa_route_change (fix-23)
    'res_render_n',     // fix-13: число сработавших меток; 0 отличается от пустого
    'res_watch_cfg',    // fix-13: версия набора watchSelectors; пусто = запись до fix-13
    'res_watch_gen',       // fix-14: номер логической страницы цепочки; 0 = страница открытия
    'res_watch_offset_ms', // fix-14: ноль цепочки относительно ts записи; t_dom + это = шкала записи
    'tab_open_lag_ms',     // fix-14: вкладка создана → документ начал грузиться
    'entry_url'            // fix-14: точка входа трека, санитизирована
  ];

  const lines = [_nd_csvRow(HEADER)];
  for (const { value } of built.items) {
    lines.push(_nd_csvRow(value));
  }

  return {
    csvContent: lines.join('\r\n'),
    filename:   _nd_buildFileName(pcName)
  };
}

// ─── Чтение из storage 

function _nd_readLocalStorage() {
  return new Promise(resolve => {
    readAggregatedSnapshot( // fix-9 Этап 2: единая точка чтения блоба
      ['pcIdentifier', 'fileBasedSettings']).then(
      result => {
        const raw = result.aggregatedRumData || {};
        resolve({
          // Основной источник: подтверждённые action clicks от content.js
          actionClicks:      (raw.actionClicks      || []).slice(-2000),
          // Для join nav timing метрик (full_page_navigation / spa_route_change)
          aggregatedMetrics: (raw.aggregatedMetrics || []).slice(-2000),
          navTimings:        raw.navTimings         || null,
          // Для join аномалий
          freezeEvents:      (raw.freezeEvents      || []).slice(-2000),
          blankPageEvents:   (raw.blankPageEvents   || []).slice(-2000),
          // Для join AJAX
          ajaxTimings:       raw.ajaxTimings        || null,
          // Мета
          pcIdentifier:      result.pcIdentifier    || null,
          fileBasedSettings: result.fileBasedSettings || null
        });
      }
    );
  });
}

function _nd_readManagedStorage() {
  return new Promise(resolve => {
    try {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, result => {
          resolve(chrome.runtime.lastError ? {} : (result || {}));
        });
      } else {
        resolve({});
      }
    } catch { resolve({}); }
  });
}

/**
 * ff-14.14: report identity — атрибуты ПК для 04-отчётов.
 * pc_cpu/pc_rum — ИСКЛЮЧИТЕЛЬНО из managed storage (GPO/реестр), не из fileBasedSettings,
 * local/sync storage или pcIdentifier. Нестроковое/отсутствующее значение → ''.
 * fix-16: organization/location/commit1/commit2 — из активного источника (файл или реестр).
 */
function _nd_resolveReportIdentity(managed, fileBased) {
  const m = managed || {};
  // fix-16: organizationName/location/commit1/commit2 — из активного источника настроек:
  // settings.json, если его выбирает prepilot (useSettingsFile или пустой реестр), иначе реестр.
  // fileBasedSettings сам по себе не признак: при старте SW с реестром он не удаляется.
  const useFile = typeof shouldUseSettingsFile === 'function'
    ? shouldUseSettingsFile(m)
    : Object.keys(m).length === 0;
  const s = (useFile ? fileBased : m) || {};
  const str = v => (typeof v === 'string' ? v : '');
  return {
    customPcNameCpu: typeof m.customPCNameCpu === 'string' ? m.customPCNameCpu : '',
    customPcNameRum: typeof m.customPCNameRum === 'string' ? m.customPCNameRum : '',
    organizationName: str(s.organizationName),
    location:         str(s.location),
    commit1:          str(s.commit1),
    commit2:          str(s.commit2)
  };
}

// ─── Загрузка и тексты ошибок отдельной выгрузки (CSV и JSON) ─────────────────

/**
 * Шаги 1–3 отдельной выгрузки 04: local и managed storage, report identity,
 * siteConfigs + globalThresholds (из активного источника: файл или реестр), запасной часовой пояс.
 *
 * @param {string} timezone  - строка из background (_bgTimezone)
 * @returns {Promise<{ localData, siteConfigs, globalThresholds, reportIdentity, tz } | { error: string }>}
 */
async function _nd_loadExportInput(timezone) {
  // 1. Local storage
  let localData;
  try {
    localData = await _nd_readLocalStorage();
  } catch (e) {
    console.warn('[RUM] exportNavigationDetail: ошибка чтения storage:', e.message);
    return { error: String(e) };
  }

  // ff-14.14: managed storage читаем ВСЕГДА — из него берём registry-only identity
  // (pc_cpu/rum) независимо от источника siteConfigs. Ошибка/недоступность
  // managed не блокирует экспорт — identity остаётся пустым.
  let managed = {};
  try {
    managed = await _nd_readManagedStorage();
  } catch (e) {
    console.warn('[RUM] exportNavigationDetail: managed storage недоступен:', e.message);
  }
  const reportIdentity = _nd_resolveReportIdentity(managed, localData.fileBasedSettings);

  // 2. siteConfigs + globalThresholds — из активного источника, тем же правилом, что сбор и
  // _nd_resolveReportIdentity (compact fix-8): settings.json, если его выбирает prepilot
  // (useSettingsFile или пустой реестр), иначе только реестр. Копия fileBasedSettings при старте
  // SW с реестром не удаляется, и «файл, а при пустом — реестр» строил 04 по её сайтам и порогам.
  const useFile = typeof shouldUseSettingsFile === 'function'
    ? shouldUseSettingsFile(managed)
    : Object.keys(managed).length === 0;
  const settingsSrc      = (useFile ? localData.fileBasedSettings : managed) || {};
  const siteConfigs      = _nd_parseSiteConfigs(settingsSrc);
  const globalThresholds = settingsSrc.executiveSummaryThresholds || null;

  if (!siteConfigs || siteConfigs.length === 0) {
    return { error: _t('errNoSiteConfigs') };
  }

  // 3. Timezone fallback (SW-контекст)
  const tz = timezone || (typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : '');

  return { localData, siteConfigs, globalThresholds, reportIdentity, tz };
}

/**
 * Текст ошибки отдельной выгрузки 04 по результату построителя (_err из _nd_buildItems).
 * Один для CSV и JSON.
 */
function _nd_buildErrorText(built) {
  if (!built || built._err === 'no_active_sites') {
    return _t('errNoActiveSites');
  }
  if (built._err === 'no_action_clicks') {
    return _t('errNoActionClicks', [String(built.activeSiteCount)]);
  }
  if (built._err === 'no_rows_for_sites') {
    return _t('errNoDomainMatch', [String(built.activeSiteCount)]);
  }
  return _t('errNoData');
}

// ─── Основная функция экспорта 

/**
 * @param {string} browser   - строка из background (_bgBrowser)
 * @param {string} timezone  - строка из background (_bgTimezone)
 */
async function exportNavigationDetail(browser, timezone) {
  // 1–3. storage, siteConfigs, часовой пояс
  const input = await _nd_loadExportInput(timezone);
  if (input.error) return { ok: false, error: input.error };
  const { localData, siteConfigs, globalThresholds, reportIdentity, tz } = input;

  // 4. Построить CSV
  const built = _nd_buildCsvContent(localData, siteConfigs, globalThresholds, browser || '', tz, reportIdentity);

  if (!built || built._err) {
    return { ok: false, error: _nd_buildErrorText(built) };
  }

  // 5. Encode + download
  let dataUrl;
  try {
    const BOM  = '\uFEFF';
    const full = BOM + built.csvContent;
    dataUrl = 'data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(full)));
  } catch (e) {
    console.warn('[RUM] exportNavigationDetail: ошибка кодирования:', e.message);
    return { ok: false, error: String(e) };
  }

  try {
    await _dl_download({ url: dataUrl, filename: built.filename });
    return { ok: true };
  } catch (e) {
    console.warn('[RUM] exportNavigationDetail: ошибка chrome.downloads:', e.message);
    return { ok: false, error: chrome.runtime.lastError?.message || String(e) };
  }
}

// ─── JSON 04 ──────────────────────────────────────────────────────────────────
// JSON-версия 04 с нативными типами:
//    - number вместо decimal-comma строк
//    - null вместо пустых строк
//    - boolean для operation_timeout
//    - string[] для action_evidence и alert_flags
// Расчёт общий с CSV (_nd_computeClickMetrics, _nd_buildItems, _nd_loadExportInput),
// здесь только форматирование. Префикс _ndj_ — у функций, которые вызывает roleBundleExport.js.
// Имя файла: 04-navigation-detail_{pcname}_{YYYYMMDD}.json

/**
 * Строит объект события (61 ключ, порядок — форма JSON 04) с нативными JSON-типами.
 * Аналог _nd_buildRowForActionClick(): расчёт — _nd_computeClickMetrics, здесь только форматирование.
 */
function _ndj_buildEventObject(click, siteConfig, navIndex, siteIndexes, thresholds, browser, timezone, pcName, reportIdentity) {
  const {
    jx, jy, jz,
    freeze_count, blank_count, ajaxData, ajaxDerived,
    isFullPage, isSpa,
    nav_ready, nav_ttfb, nav_render, duration_ms, long_tasks,
    hasTimeline, content_time_ms, data_ready_ms, visual_stable_ms, operation_time_ms,
    page_url_before, result_url, target_url,
    alert_flags
  } = _nd_computeClickMetrics(click, siteConfig, navIndex, siteIndexes, thresholds);
  const clickTs = click.ts || 0;

  // ── Timeline: флаг таймаута и сигнал завершения
  // JSON: boolean вместо CSV "TRUE"/""
  const operation_timeout = hasTimeline ? (click.operationTimeout === true) : false;
  // JSON: null вместо пустой строки
  const completion_signal = hasTimeline ? (click.completionSignal || null) : null;

  // ── action_evidence → string[]
  const action_evidence = Array.isArray(click.actionEvidence)
    ? click.actionEvidence
    : (click.actionEvidence ? [click.actionEvidence] : []);

  // ── Web Vitals (только full_page_navigation)
  const res_lcp_ms = isFullPage ? (click.resLcp ?? null) : null;
  const res_cls    = isFullPage ? (click.resCls ?? null) : null;

  // ff-14.14: registry-only identity — пустое значение → null
  const _idCpu = (reportIdentity && reportIdentity.customPcNameCpu) ? reportIdentity.customPcNameCpu : null;
  const _idRum = (reportIdentity && reportIdentity.customPcNameRum) ? reportIdentity.customPcNameRum : null;

  return {
    ts:               _nd_formatTs(clickTs),
    site_domain:      siteConfig.domain || '',
    pc_name:          pcName || null,
    // ff-14.14: registry-only PC-атрибуты сразу после pc_name (пусто → null)
    pc_cpu: _idCpu,
    pc_rum: _idRum,
    // fix-16: атрибуты ПК из settings.json/реестра, в UI не показываются (пусто → null)
    organization: (reportIdentity && reportIdentity.organizationName) || null,
    location:     (reportIdentity && reportIdentity.location) || null,
    commit1:      (reportIdentity && reportIdentity.commit1) || null,
    commit2:      (reportIdentity && reportIdentity.commit2) || null,
    mode:             siteConfig._effMode || siteConfig.mode || '',
    browser:          browser || '',
    timezone:         timezone || '',
    session_id:       click.sessionId  ?? null,
    tab_id:           click.tabId      ?? null,
    // ff-14.14: click_id сразу после tab_id (в CSV он уже есть в этой позиции)
    click_id:         click.clickId    ?? null,
    journey_x:        jx !== null ? Number(jx) : null,
    journey_y:        jy !== null ? Number(jy) : null,
    journey_z:        jz !== null ? Number(jz) : null,
    source_type:      click.sourceType   || 'click',
    transition_type:  click.transitionType || 'click',
    // URL — строками, как в CSV
    page_url_before:  page_url_before,
    selector:         click.selector   ?? null,
    element_tag:      click.tagName    ?? null,
    click_text:       null,   // compact fix-2: текст клика не собирается, поле сохранено для формы JSON 04
    button_type:      null,   // compact fix-2: тип кнопки не вычисляется, поле сохранено для формы JSON 04
    target_url,
    action_type:      click.actionType ?? null,
    action_evidence,
    result_url,
    nav_ready_ms:     nav_ready   !== null ? Number(nav_ready)   : null,
    nav_ttfb_ms:      nav_ttfb    !== null ? Number(nav_ttfb)    : null,
    // 4 TTFB/size-поля по связанным raw AJAX (между nav_ttfb_ms и nav_render_ms)
    ajaxFirstRequestTtfbMs:    ajaxDerived.first        !== null ? Number(ajaxDerived.first)        : null,
    ajaxLongestRequestTtfbMs:  ajaxDerived.longest      !== null ? Number(ajaxDerived.longest)      : null,
    ajaxHeaviestRequestTtfbMs: ajaxDerived.heaviestTtfb !== null ? Number(ajaxDerived.heaviestTtfb) : null,
    ajaxHeaviestRequestSizeBytes: ajaxDerived.heaviestSize !== null ? Number(ajaxDerived.heaviestSize) : null,
    nav_render_ms:    nav_render  !== null ? Number(nav_render)  : null,
    duration_ms:      duration_ms !== null ? Number(duration_ms) : null,
    content_time_ms:  content_time_ms  !== null ? Number(content_time_ms)  : null,
    data_ready_ms:    data_ready_ms    !== null ? Number(data_ready_ms)    : null,
    visual_stable_ms: visual_stable_ms !== null ? Number(visual_stable_ms) : null,
    operation_time_ms:operation_time_ms!== null ? Number(operation_time_ms): null,
    operation_timeout,
    completion_signal,
    long_tasks:       Number(long_tasks),
    jserror_count:    null,   // compact fix-1: трекер JS-ошибок удалён, поле сохранено для формы JSON 04
    freeze_count:     Number(freeze_count),
    blank_count:      Number(blank_count),
    ajax_count:       Number(ajaxData.count),
    ajax_slow_count:  Number(ajaxData.slow),
    ajax_error_count: Number(ajaxData.error),
    res_lcp_ms:       res_lcp_ms !== null ? Number(res_lcp_ms) : null,
    // fix-10/fix-12: полный список LCP-кандидатов { t, size, tag, cls }; старые записи → null
    res_lcp_candidates: isFullPage && Array.isArray(click.resLcpCandidates) && click.resLcpCandidates.length
      ? click.resLcpCandidates.map(c => (c && typeof c === 'object')
          ? { t: c.t ?? null, size: c.size ?? null, tag: c.tag ?? null, cls: c.cls ?? null }
          : { t: c, size: null, tag: null, cls: null })
      : null,
    res_cls:          res_cls    !== null ? Number(res_cls)    : null,
    // fix-13: цепочка отрисовки блоков; старые записи → null
    // full_page_navigation и spa_route_change (fix-23) — здесь и в res_render_n…res_watch_offset_ms
    res_render_chain: (isFullPage || isSpa) && Array.isArray(click.resRenderChain) && click.resRenderChain.length
      ? click.resRenderChain.map(m => ({
          label:   m && m.label   != null ? String(m.label) : null,
          t_dom:   m && typeof m.tDom   === 'number' ? m.tDom   : null,
          t_paint: m && typeof m.tPaint === 'number' ? m.tPaint : null,
          sel:     m && m.sel     != null ? String(m.sel)   : null
        }))
      : null,
    // fix-13: число сработавших меток. Пишется и при пустой цепочке (0) — «ноль
    // меток» и «нет поля» на сервере должны различаться.
    res_render_n:  (isFullPage || isSpa) && Array.isArray(click.resRenderChain) ? click.resRenderChain.length : null,
    // fix-13: версия набора watchSelectors; пусто = запись сделана до fix-13
    res_watch_cfg: (isFullPage || isSpa) ? (click.resWatchCfg || '') : '',
    // fix-14: номер логической страницы внутри документа (0 — страница открытия),
    // к которой относится res_render_chain; null — цепочки нет или запись до fix-14
    res_watch_gen:       (isFullPage || isSpa) && typeof click.resWatchGen === 'number' ? click.resWatchGen : null,
    // fix-14: смещение нуля цепочки относительно ts записи; t_dom + это = шкала записи
    res_watch_offset_ms: (isFullPage || isSpa) && typeof click.resWatchOffset === 'number' ? click.resWatchOffset : null,
    // fix-14: «вкладка создана → документ начал грузиться»; null — метки нет
    // или запись не первого документа вкладки
    tab_open_lag_ms:     typeof click.tabOpenLagMs === 'number' ? click.tabOpenLagMs : null,
    // fix-14: точка входа трека — по ней делятся сценарии /search и прямого входа.
    // Санитайзер обязателен, даже если entryUrl уже маскирован в content.js
    entry_url:           (click.entryUrl && _nd_sanitizePageUrl(click.entryUrl, siteConfig)) || null,
    alert_flags
  };
}

/**
 * Строит полный JSON-отчёт из snapshot.
 * @returns {{ report: Object }} или { _err: string, ... }
 */
function _ndj_buildJsonContent(snapshot, siteConfigs, globalThresholds, browser, timezone, reportIdentity) {
  const _identity = reportIdentity || { customPcNameCpu: '', customPcNameRum: '' };
  // pcIdentifier фильтр whitelist не меняет — имя ПК берём из исходного snapshot
  const pcName = snapshot.pcIdentifier?.pcName || null;

  const built = _nd_buildItems(snapshot, siteConfigs, globalThresholds,
    (click, siteConfig, navIndex, siteIndexes, thresholds) => _ndj_buildEventObject(
      click, siteConfig, navIndex, siteIndexes, thresholds, browser, timezone, pcName, _identity
    ));
  if (built._err) return built;
  const { items, activeSites } = built;

  const events = items.map(e => e.value);

  // period.from = минимальный ts по событиям
  const periodFrom = items[0].ts;
  const periodTo   = Date.now();

  // activeSites в summary — только домены, для которых есть события
  const domainsWithEvents = new Set(events.map(e => e.site_domain).filter(Boolean));
  const activeSiteDomains = activeSites
    .map(sc => sc.domain || '')
    .filter(d => domainsWithEvents.has(d));

  // Per-site пороги для воспроизводимости: только домены, для которых есть события
  // (синхронно с summary.activeSites). Ключ — domain, значение — реально применённые
  // пороги (_nd_resolveThresholds учитывает per-site overrides).
  const thresholdsForReport = {};
  for (const sc of activeSites) {
    const domain = sc.domain || '*';
    if (!domainsWithEvents.has(domain)) continue;
    const t = _nd_resolveThresholds(sc, globalThresholds);
    thresholdsForReport[domain] = {
      typical_load_sec:           t.typical,
      slow_load_sec:              t.slow,
      long_tasks_per_action_warn: t.long_tasks_per_action_warn
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    pcName,
    period: {
      from: periodFrom,
      to:   periodTo
    },
    summary: {
      totalEvents:  events.length,
      activeSites:  activeSiteDomains
    },
    thresholds: thresholdsForReport,
    events
  };

  return { report };
}

/**
 * Формирует и скачивает 04-navigation-detail_{pcname}_{YYYYMMDD}.json.
 * @param {string} browser   - строка браузера из _bgBrowser (background.js)
 * @param {string} timezone  - строка таймзоны из _bgTimezone (background.js)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function exportNavigationDetailJson(browser, timezone) {
  // 1–3. storage, siteConfigs, часовой пояс — общие с CSV
  const input = await _nd_loadExportInput(timezone);
  if (input.error) return { ok: false, error: input.error };
  const { localData, siteConfigs, globalThresholds, reportIdentity, tz } = input;

  // 4. Построить JSON
  const built = _ndj_buildJsonContent(localData, siteConfigs, globalThresholds, browser || '', tz, reportIdentity);

  if (!built || built._err) {
    return { ok: false, error: _nd_buildErrorText(built) };
  }

  // 5. Encode + download
  const filename = _nd_buildFileName(localData.pcIdentifier?.pcName, 'json');

  let dataUrl;
  try {
    const json = JSON.stringify(built.report, null, 2);
    dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  try {
    await _dl_download({ url: dataUrl, filename });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: chrome.runtime.lastError?.message || String(e) };
  }
}
