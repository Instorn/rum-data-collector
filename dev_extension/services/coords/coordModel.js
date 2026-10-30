/**
 * coordModel.js
 *
 * Координатная модель v2: X/Y вкладок (tabCoords), время создания вкладок (tabCreatedTs),
 * pathMapping, правила пересчёта координат (_bg_applyCoordRule), аномалии координат
 * (COORD_ANOMALY) и сохранение состояния в chrome.storage.local (rumCoordState).
 * compact fix-5: перенесено из background.js без изменений.
 *
 * Загружается через importScripts в background.js.
 * На верхнем уровне только объявления: при importScripts let/const background.js ещё
 * не инициализированы. Вызов при старте (_coordStateRestorePromise = _bg_restoreCoordState())
 * остаётся в background.js.
 * _BG_SW_BOOT_TS вычисляется при importScripts — раньше SESSION_START_TS (доли мс при старте SW;
 * смысл «момент загрузки SW» тот же).
 *
 * Читает глобалы background.js (только внутри функций): sessionId, SESSION_START_TS,
 *   _sessionIdRestored, _onStartupFired, aggregatedData, _bgDataHydrated, _bgPendingAnomalies,
 *   _BG_PENDING_ANOMALIES_MAX, _bgSchedulePersist.
 * Используется из background.js: onStartup, tabs.onCreated/onRemoved, clearAggregatedData,
 *   _bg_msgGetTabId, _bg_msgUpdateCoords, старт SW, onSuspend.
 */

// ─── Централизованная координатная модель v2 ──────────────────────────

const COORD_VERSION = 2;

// tabCoords: Map<tabId, CoordState>
// CoordState: { X, Y, domain, entryUrl, entryPath, lastPath, coordsPending, openerTabId }
const tabCoords = new Map();

// fix-14: время создания вкладки для ВСЕХ вкладок, не только с openerTabId.
// Вкладку от Avaya открывает внешний процесс — у неё openerTabId нет.
// Persist — вместе с tabCoords в rumCoordState (переживает сон SW).
const tabCreatedTs    = new Map();   // Map<tabId, number>
const TAB_CREATED_MAX = 300;
// fix-14: момент загрузки SW. Метки старше — из прошлой браузерной сессии (см. onStartup).
const _BG_SW_BOOT_TS  = Date.now();

// pathMapping: Map<"domain:path"|"domain:rule:pattern:path", { Y, ts }>
// Хранит уже вычисленные Y для быстрого lookup при возврате назад.
const pathMapping = new Map();
const PATH_MAPPING_HARD_CAP = 100; // максимум записей per domain

// debounce-таймер для отложенного persist координатного состояния.
let _persistDebounceTimer = null;

// Promise запуска восстановления координатного состояния.
// Присваивается при старте SW в background.js (_coordStateRestorePromise = _bg_restoreCoordState()).
let _coordStateRestorePromise = null;

// ─── Вспомогательные функции координат 

/**
 * Проверяет является ли URL точкой сброса воронки.
 * Автосброс на '/' (root pathname) — если hashNavigation=true и hash непустой,
 * автосброс не срабатывает (например, /#inbox в hash-nav режиме это не reset).
 * Дополнительные паттерны из sessionResetPatterns.
 * при hashNavigation=true матчит по pathname+hash,
 * иначе — по pathname+search (прежнее поведение).
 *
 * -
 * выровнено с _ct_isResetUrl в content.js — раньше background
 * не считал '/' reset-URL и при transitionType='search' 
 * апгрейда в content) уходил в правило 6 → _bg_computeY → fallback. Теперь
 * содержательно идентичен content-версии. Guard «не для click живёт
 * не здесь, а на месте вызова в _bg_applyCoordRule (Rule 4): сам predicate
 * остаётся чистой функцией свойства URL.
 */
function _bg_isResetUrl(url, patterns, hashNavigation) {
  try {
    const parsed = new URL(url);
    const useHash = hashNavigation === true;
    const hasFragment = parsed.hash && parsed.hash.length > 1;
    const isRoot = parsed.pathname === '/' || parsed.pathname === '';
    if (isRoot && !(useHash && hasFragment)) return true;
    const pathAndSearch = useHash
      ? parsed.pathname + parsed.hash
      : parsed.pathname + parsed.search;
    return (patterns || []).some(p => p && pathAndSearch.includes(p));
  } catch (e) { return false; }
}

/**
 * возвращает path-discriminator для координатной модели.
 * При hashNavigation=true: pathname + hash (например "/t#inbox").
 * При hashNavigation=false/absent: только pathname (прежнее поведение).
 * Используется как ключ в pathMapping, entryPath, lastPath.
 */
function _bg_getPathDiscriminator(urlObj, siteConfig) {
  if (siteConfig?.hashNavigation === true) {
    return urlObj.pathname + (urlObj.hash || '');
  }
  return urlObj.pathname;
}

/**
 * Возвращает TTL в мс для pathMapping на основе siteConfig.sessionBackTtlMin.
 * 0 = отключено (Y всегда инкрементируется). Дефолт: 30 минут.
 */
function _bg_getTtlMs(siteConfig) {
  const min = siteConfig?.sessionBackTtlMin;
  if (min === 0) return 0;
  if (typeof min === 'number' && min > 0) return min * 60 * 1000;
  return 30 * 60 * 1000;
}

/**
 * Простой glob-матчинг пути. Поддерживает:
 *   *  = один сегмент (без /)
 *   ** = произвольный хвост (в т.ч. с /)
 */
function _bg_globMatch(pattern, path) {
  try {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped
      .replace(/\*\*/g, '\u0000') // временная замена, чтобы не затронуть одиночные *
      .replace(/\*/g, '[^/]+')
      .replace(/\u0000/g, '.*');
    return new RegExp('^' + regexStr + '$').test(path);
  } catch (e) {
    return false;
  }
}

/**
 * Удаляет старые записи pathMapping для домена: TTL + hard cap.
 */
function _bg_cleanPathMapping(domain) {
  const prefix = `${domain}:`;
  const ttlMs = 15 * 60 * 1000; // общий TTL для очистки
  const now = Date.now();

  for (const [key, val] of pathMapping) {
    if (!key.startsWith(prefix)) continue;
    if (ttlMs > 0 && (now - val.ts) > ttlMs) {
      pathMapping.delete(key);
    }
  }

  // Жёсткий лимит: удаляем самые старые записи если превышен
  const remaining = [...pathMapping.entries()].filter(([k]) => k.startsWith(prefix));
  if (remaining.length > PATH_MAPPING_HARD_CAP) {
    remaining.sort((a, b) => a[1].ts - b[1].ts);
    remaining.slice(0, remaining.length - PATH_MAPPING_HARD_CAP)
      .forEach(([k]) => pathMapping.delete(k));
  }
}

/**
 * Сохраняет Y для пути в pathMapping.
 */
function _bg_setPathMapping(domain, path, Y) {
  const key = `${domain}:${path}`;
  console.log('[RUM:BG] setPathMapping', { key, Y });
  pathMapping.set(key, { Y, ts: Date.now() });
  _bg_cleanPathMapping(domain);
}

/**
 * Вычисляет новое Y для перехода на newPath. 4 уровня приоритета:
 *   1. pathAliases  → Y не меняется (логически тот же экран)
 *   2. pathRules    → Y = yBase + yStep * N (wizard/flat)
 *   3. pathMapping  → Y из ранее виденного пути (с TTL)
 *   4. Иерархия     → разница глубин сегментов relative to entryPath
 */
function _bg_computeY(tabId, domain, newPath, siteConfig, transitionType) {
  const existing = tabCoords.get(tabId);
  const entryPath = existing?.entryPath || '/';
  const lastPath = existing?.lastPath || entryPath;
  const currentY = existing?.Y ?? 0;
  const pathAliases = siteConfig?.pathAliases || [];
  const pathRules = siteConfig?.pathRules || [];
  const ttlMs = _bg_getTtlMs(siteConfig);

  // шаг 1: pathAliases — from↔to считается одним экраном
  for (const alias of pathAliases) {
    if (!alias.from || !alias.to) continue;
    const pair = [alias.from, alias.to];
    if (pair.includes(newPath) && pair.includes(lastPath)) {
      return currentY;
    }
  }

  // шаг 2: pathRules — шаблоны с yBase/yStep
  for (const rule of pathRules) {
    if (!rule.pattern || !_bg_globMatch(rule.pattern, newPath)) continue;
    const yBase = typeof rule.yBase === 'number' ? rule.yBase : 0;
    const yStep = typeof rule.yStep === 'number' ? rule.yStep : 0;
    if (yStep > 0) {
      const countKey = `${domain}:rule:${rule.pattern}:${newPath}`;
      if (!pathMapping.has(countKey)) {
        const cnt = [...pathMapping.keys()]
          .filter(k => k.startsWith(`${domain}:rule:${rule.pattern}:`)).length;
        pathMapping.set(countKey, { Y: yBase + cnt * yStep, ts: Date.now() });
        _bg_cleanPathMapping(domain);
      }
      return pathMapping.get(countKey).Y;
    }
    return yBase;
  }

  // шаг 3: pathMapping — ранее посещённый путь
  const mappingKey = `${domain}:${newPath}`;
  console.log('[RUM:BG] computeY lookup', { mappingKey, found: pathMapping.has(mappingKey), map: [...pathMapping.entries()] });
  if (pathMapping.has(mappingKey)) {
    const mapped = pathMapping.get(mappingKey);
    if (ttlMs === 0 || (Date.now() - mapped.ts) < ttlMs) {
      return mapped.Y;
    }
    pathMapping.delete(mappingKey);
  }

  // шаг 4: двойная стратегия.
  // «click» (кнопка UI) → шаг в пользовательском пути: currentY + 1.
  // Иначе (navigate/back_forward/unknown = правка URL, кнопка браузера) →
  // дельта глубины относительно lastPath.
  if (transitionType === 'click') {
    return currentY + 1;
  }

  // fix  (#1): не уменьшаем Y по depth-diff. URL-структура ≠ глубина воронки:
  // переход «товар (3 segs) → /cart (1 seg)» давал depthDiff=-2 и Y падал
  // c 6 до 4. Теперь:
  //   depthDiff > 0 → currentY + depthDiff (углубление в иерархию URL)
  //   depthDiff <= 0 → currentY + 1 (тот же уровень или подъём — это шаг
  //                     вперёд в воронке, а не назад).
  // Floor по 0 убран: если currentY=0 и depthDiff отрицательный, теперь
  // даём currentY+1=1, а не Math.max(0, …)=0 (иначе на entry → /cart
  // получали Y=0, неотличимое от entry).
  const newSegs = newPath.split('/').filter(Boolean);
  const lastSegs = lastPath.split('/').filter(Boolean);
  const depthDiff = newSegs.length - lastSegs.length;
  return depthDiff > 0 ? currentY + depthDiff : currentY + 1;
}

/**
 * Записывает аномалию в aggregatedData.anomalies.
 */
function _bg_recordAnomaly(tabId, oldCoords, newCoords, rule, url) {
  if (!oldCoords) return;
  const oldStr = `${oldCoords.X}.${oldCoords.Y}`;
  const newStr = `${newCoords.X}.${newCoords.Y}`;
  const anomalies = [];

  if (Math.abs(newCoords.Y - oldCoords.Y) > 3) {
    anomalies.push({ detail: `${oldStr}|${newStr}|y_jump:${rule}|${url}` });
  }
  if (newCoords.X > 10) {
    anomalies.push({ detail: `${oldStr}|${newStr}|x_overflow:${rule}|${url}` });
  }

  if (anomalies.length === 0) return;

  const records = anomalies.map(a => ({
    type: 'COORD_ANOMALY',
    tabId,
    url,
    timestamp: Date.now(),
    detail: a.detail,
    session_id: sessionId  // session_id на момент события
  }));

  // ТЗ-2 C2: до hydrate складываем только в ограниченный memory-buffer.
  // Callback _bgDataReady.then(...) добавит его в hydrated core-state одним batch'ем.
  if (!_bgDataHydrated) {
    for (const record of records) {
      if (_bgPendingAnomalies.length >= _BG_PENDING_ANOMALIES_MAX) break;
      _bgPendingAnomalies.push(record);
    }
    return;
  }

  aggregatedData.anomalies = aggregatedData.anomalies || [];
  aggregatedData.anomalies.push(...records);
  if (aggregatedData.anomalies.length > 200) {
    aggregatedData.anomalies = aggregatedData.anomalies.slice(-100);
  }
  _bgSchedulePersist('coord-anomaly'); // fix-9: через throttle-планировщик
}

/**
 * Применяет правила координатной модели v2 и обновляет tabCoords[tabId].
 * Правила:
 *   1. Нет existing     → { X:1, Y:0 }
 *   2. coordsPending    → наследование от opener (rules 5/5b)
 *   3. reload           → { X:1, Y:0 }
 *   4. search/reset     → { X:same, Y:0 }
 *   5. domain changed   → { X:X+1, Y:0 }
 *   6. same domain      → { X:same, Y:computeY() }
 * @returns CoordState
 */
function _bg_applyCoordRule(tabId, { url, domain, transitionType, siteConfig }) {
  let urlObj;
  try { urlObj = new URL(url); } catch (e) { return null; }
  // при hashNavigation=true discriminator включает hash-фрагмент,
  // чтобы /t#inbox и /t#following считались разными страницами.
  const pathOnly = _bg_getPathDiscriminator(urlObj, siteConfig);

  const existing = tabCoords.get(tabId);

  // Правило 1: нет состояния — новая вкладка или первая загрузка
  if (!existing) {
    const c = { X: 1, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    tabCoords.set(tabId, c);
    // fix #5: фиксируем entryPath в pathMapping с Y=0, чтобы возврат
    // на entry через клик-навигацию (например, по логотипу) попадал в
    // шаг 3 _bg_computeY и давал Y=0, а не depth-diff fallback.
    _bg_setPathMapping(domain, pathOnly, 0);
    return c;
  }

  // Правило 2: coordsPending — tab был создан с openerTabId, ждём первый UPDATE_COORDS
  if (existing.coordsPending) {
    const parent = tabCoords.get(existing.openerTabId);
    let c;
    if (!parent) {
      c = { X: 1, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    } else if (parent.domain === domain) {
      // Правило 5: та же вкладка → новая вкладка, тот же домен
      c = { X: parent.X, Y: parent.Y + 1, domain,
            entryUrl: parent.entryUrl, entryPath: parent.entryPath, lastPath: pathOnly };
    } else {
      // Правило 5b: новая вкладка, другой домен
      c = { X: parent.X + 1, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    }
    tabCoords.set(tabId, c);
    _bg_recordAnomaly(tabId, null, c, 'tab_inherit', url);
    return c;
  }

  // Правило 3: reload / прямая навигация браузером — сброс к началу
  if (transitionType === 'reload' || transitionType === 'direct') {
    const c = { X: 1, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    tabCoords.set(tabId, c);
    return c;
  }

  const resetPatterns = siteConfig?.sessionResetPatterns || [];

  // Правило 4: search/reset — X сохраняется, Y сбрасывается
  // передаём флаг, чтобы reset матчился по pathname+hash при hashNavigation=true.
  // fix: guard «не для click». После расширения _bg_isResetUrl на
  // root-path '/' любой клик по логотипу попадал бы в Rule 4 и писался в
  // _bg_recordAnomaly как 'search_reset', хотя семантически это обычный
  // шаг воронки. Reset-семантика осмыслена только для не-click переходов
  // ('search' от browser-open URL-бара/закладки на reset-URL, 'navigate'
  // от polling fallback и т.п.). Click на reset-URL пойдёт в Rule 6;
  // _bg_computeY шаг 3 найдёт pathMapping (записан в Rule 1 fix-4 (#5)
  // или в этом же Rule 4 при предыдущем reset) и вернёт Y=0. X сохраняется
  // в обоих ветках, разница только в anomaly-tag.
  // Rule 4 применим только внутри того же домена. Иначе ручной
  // browser-open на root другого домена (https://b.example/) сохранял X
  // от предыдущего домена и обходил Rule 5 domain_change.
  if (transitionType !== 'click' &&
      existing.domain === domain &&
      _bg_isResetUrl(url, resetPatterns, siteConfig?.hashNavigation)) {
    const c = { X: existing.X, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    tabCoords.set(tabId, c);
    _bg_recordAnomaly(tabId, existing, c, 'search_reset', url);
    // fix (#5): фиксируем reset-точку в pathMapping с Y=0. Иначе после
    // reset переход на тот же путь в шаге 3 _bg_computeY не находил его и
    // уходил в depth-diff fallback.
    _bg_setPathMapping(domain, pathOnly, 0);
    return c;
  }

  // Правило 5 (same-tab): клик → другой домен → X+1
  if (existing.domain !== domain) {
    const c = { X: existing.X + 1, Y: 0, domain, entryUrl: url, entryPath: pathOnly, lastPath: pathOnly };
    tabCoords.set(tabId, c);
    _bg_recordAnomaly(tabId, existing, c, 'domain_change', url);
    return c;
  }

  // Правило 6 / 4: тот же домен — вычисляем Y
  // Гарантируем, что entryPath этой вкладки есть в pathMapping
  const entryMappingKey = `${domain}:${existing.entryPath}`;
  if (!pathMapping.has(entryMappingKey)) {
    _bg_setPathMapping(domain, existing.entryPath, 0);
  }
  const newY = _bg_computeY(tabId, domain, pathOnly, siteConfig, transitionType);
  console.log("[RUM:BG] Rule6", { tabId, pathOnly, entryPath: existing.entryPath, lastPath: existing.lastPath, newY, currentY: existing.Y });
  const c = {
    X: existing.X,
    Y: newY,
    domain,
    entryUrl: existing.entryUrl,
    entryPath: existing.entryPath,
    lastPath: pathOnly
  };
  tabCoords.set(tabId, c);
  _bg_recordAnomaly(tabId, existing, c, transitionType, url);
  _bg_setPathMapping(domain, pathOnly, newY);
  console.log("[RUM:BG] Rule6 result", c);
  return c;
}

// ─── Персистентность координатного состояния ─────────────────────────────────

/**
 * Восстанавливает tabCoords, pathMapping, sessionId и SESSION_START_TS из
 * chrome.storage.session при старте SW. При ошибке — graceful degradation
 * (пустые Map, новый sessionId остаётся).
 */
async function _bg_restoreCoordState() {
  try {
    // читаем из chrome.storage.local вместо .session.
    // Причина: chrome.storage.session очищается при disable-расширения, поэтому
    // disable → enable теряло состояние. local переживает disable/enable.
    // Очистка при новой браузерной сессии делается в chrome.runtime.onStartup.
    const stored = await chrome.storage.local.get([
      'rumCoordState', 'rumSessionId', 'rumSessionStartTs'
    ]);

    // Защита от гонки — onStartup мог выставить флаг пока ждали get().
    // В этом случае onStartup уже сбросил in-memory состояние → не восстанавливаем.
    if (_onStartupFired) {
      console.log('[RUM:BG] onStartup fired during restore — skipping, state already reset.');
      return;
    }

    // Восстанавливаем sessionId и SESSION_START_TS
    if (stored.rumSessionId) {
      sessionId = stored.rumSessionId;
      if (typeof stored.rumSessionStartTs === 'number') {
        SESSION_START_TS = stored.rumSessionStartTs;
      }
      _sessionIdRestored = true;
      console.log('[RUM:BG] sessionId restored from session storage:', sessionId);
    }

    // Восстанавливаем tabCoords и pathMapping
    if (stored.rumCoordState && typeof stored.rumCoordState === 'object') {
      const state = stored.rumCoordState;

      if (state.tabCoords && typeof state.tabCoords === 'object') {
        for (const [tabId, coords] of Object.entries(state.tabCoords)) {
          const id = Number(tabId);
          if (id && coords && typeof coords === 'object') {
            tabCoords.set(id, coords);
          }
        }
      }

      // fix-14: метки создания вкладок. Память приоритетнее storage: SW мог проснуться
      // именно от onCreated новой вкладки, и её метка уже стоит.
      if (state.tabCreatedTs && typeof state.tabCreatedTs === 'object') {
        for (const [tabId, ts] of Object.entries(state.tabCreatedTs)) {
          const id = Number(tabId);
          if (id && typeof ts === 'number' && !tabCreatedTs.has(id)
              && tabCreatedTs.size < TAB_CREATED_MAX) {
            tabCreatedTs.set(id, ts);
          }
        }
      }

      // pathMapping намеренно НЕ восстанавливается из session storage.
      // Причина: сохранённые Y-значения могут быть неверными (cross-tab contamination,
      // навигация «назад» с завышенным Y), что приводит к «залипанию» Y=const после
      // рестарта SW (Правило 3 всегда возвращает устаревшее значение).
      // pathMapping — кэш-оптимизация; он перестраивается за 1-2 навигации.

      
      console.log('[RUM:BG] tabCoords restored:', tabCoords.size,
        '(pathMapping intentionally not restored — rebuilds from navigation)');
    }

    // Валидация: удаляем координаты закрытых вкладок
    // fix-14: и метки создания закрытых вкладок — тем же запросом
    if (tabCoords.size > 0 || tabCreatedTs.size > 0) {
      const tabs = await chrome.tabs.query({});
      const liveTabIds = new Set(tabs.map(t => t.id));
      let removed = 0;
      for (const tabId of tabCoords.keys()) {
        if (!liveTabIds.has(tabId)) {
          tabCoords.delete(tabId);
          removed++;
        }
      }
      for (const tabId of tabCreatedTs.keys()) {
        if (!liveTabIds.has(tabId)) {
          tabCreatedTs.delete(tabId);
          removed++;
        }
      }
      if (removed > 0) {
        console.log('[RUM:BG] removed ghost tabCoords:', removed);
        // Сохраняем очищенное состояние
        await _bg_persistCoordState();
      }
    }

    // Если сессии не было — сохраняем новую
    if (!stored.rumSessionId) {
      await _bg_persistCoordState();
    }

  } catch (e) {
    console.warn('[RUM:BG] restoreCoordState error (graceful degradation):', e.message);
    tabCoords.clear();
    pathMapping.clear();
    _sessionIdRestored = false;
  }
}

/**
 * Сохраняет tabCoords, sessionId и SESSION_START_TS в chrome.storage.local.
 * (изменено с chrome.storage.session, которое очищается при disable-расширения)
 * pathMapping намеренно не сохраняется — комент в _bg_restoreCoordState.
 * При ошибке — тихий fallback.
 */
async function _bg_persistCoordState() {
  try {
    const tabCoordsObj = {};
    for (const [k, v] of tabCoords) tabCoordsObj[String(k)] = v;
    const tabCreatedObj = {};
    for (const [k, v] of tabCreatedTs) tabCreatedObj[String(k)] = v;

    await chrome.storage.local.set({
      rumCoordState: {
        tabCoords:    tabCoordsObj,
        tabCreatedTs: tabCreatedObj,   // fix-14
        savedAt:      Date.now()
      },
      rumSessionId: sessionId,
      rumSessionStartTs: SESSION_START_TS
    });
  } catch (e) {
    console.warn('[RUM:BG] persistCoordState error:', e.message);
  }
}

/**
 * Планирует отложенный persist координатного состояния (debounce 1 сек).
 * Серия быстрых переходов даёт один batched persist.
 */
function _bg_schedulePersist() {
  if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer);
  _persistDebounceTimer = setTimeout(() => {
    _persistDebounceTimer = null;
    _bg_persistCoordState();
  }, 1000);
}

// ─── /Координатная инфраструктура ────────────────────────────────────────────
