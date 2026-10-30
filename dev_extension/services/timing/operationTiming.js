/**
 * operationTiming.js  
 *
 * Измеряет timeline-метрики операции после подтверждения action click:
 *   content_time_ms, data_ready_ms, visual_stable_ms, operation_time_ms,
 *   operation_timeout, completion_signal.
 *
 * Загружается как content script перед content.js.
 * Не пишет в storage, не шлёт runtime messages.
 */

// ─── Defaults 

const _OT_DEFAULTS = {
  enabled:                  true,
  operationTimeoutMs:       15000,
  quietWindowMs:            500,
  spaStabilityMs:           300,
  spaNetworkQuietMs:        500,
  spaStabilityTimeoutMs:    10000,
  spaMutationCap:           500,
  ajaxBatchQuietMs:         500,
  ajaxCompletionTimeoutMs:  10000,
  ajaxAttributionWindowMs:  5000,
  modalStabilityMs:         300,
  modalStabilityTimeoutMs:  5000,
  layoutStableMs:           500
};

function _ot_cfg(config) {
  return Object.assign({}, _OT_DEFAULTS, config || {});
}

// ─── Preemption guard 

let _currentMeasurement = null;

// При уходе страницы — завершаем досрочно с page_unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (_currentMeasurement) {
      const m = _currentMeasurement;
      _currentMeasurement = null;
      m.cleanup();
      m.resolve({
        contentTimeMs:   m.accumulatedContent,
        dataReadyMs:     m.accumulatedData,
        visualStableMs:  m.accumulatedVisual,
        operationTimeMs: Date.now() - m.clickTs,
        operationTimeout: false,
        completionSignal: 'page_unload'
      });
    }
  });
}

// ─── Helpers 

/**
 * Гарантирует порядок: duration_ms ≤ content_time_ms ≤ data_ready_ms ≤ visual_stable_ms ≤ operation_time_ms
 *
 * null означает «не применимо» — порядок гарантируется только между присутствующими значениями.
 * Если предшествующее значение null — текущее не флорится к нулю.
 * durationMs — нижняя граница для contentTimeMs.
 */
function _ot_enforceOrder(contentTimeMs, dataReadyMs, visualStableMs, operationTimeMs, durationMs) {
  let c = (contentTimeMs !== null && contentTimeMs !== undefined) ? contentTimeMs : null;
  if (c !== null && durationMs !== null && durationMs !== undefined && c < durationMs) c = durationMs;

  const d = (dataReadyMs !== null && dataReadyMs !== undefined)
    ? (c !== null ? Math.max(dataReadyMs, c) : dataReadyMs)
    : null;

  const prevForV = d !== null ? d : c;
  const v = (visualStableMs !== null && visualStableMs !== undefined)
    ? (prevForV !== null ? Math.max(visualStableMs, prevForV) : visualStableMs)
    : null;

  const prevForO = v !== null ? v : (d !== null ? d : c);
  const o = prevForO !== null
    ? Math.max(operationTimeMs ?? 0, prevForO)
    : (operationTimeMs ?? 0);

  return { contentTimeMs: c, dataReadyMs: d, visualStableMs: v, operationTimeMs: o };
}

// Единый набор «невидимых» тегов : использовать везде вместо отдельного _OT_IGNORED_TAGS
const _OT_IGNORED_CONTENT = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);

/**
 * True если мутация добавила хотя бы один видимый элемент.
 */
function _ot_isSignificantMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (_OT_IGNORED_CONTENT.has(node.tagName)) continue;
      try { if (node.offsetHeight > 0) return true; } catch { /* detached */ }
    }
  }
  return false;
}

/**
 * Создаёт PerformanceObserver безопасно. Возвращает null если API недоступен.
 */
function _ot_safeObserver(callback) {
  try {
    if (typeof PerformanceObserver === 'undefined') return null;
    return new PerformanceObserver(callback);
  } catch {
    return null;
  }
}

/**
 * Наблюдатель AJAX-тишины. Возвращает Promise<{ quietTs: number|null }>.
 * quietTs = Date.now() в момент подтверждения тишины.
 * null если AJAX не было.
 */
function _ot_watchAjaxQuiet(clickTs, cfg, abortSignal) {
  return new Promise((resolve) => {
    const { ajaxBatchQuietMs, ajaxCompletionTimeoutMs, ajaxAttributionWindowMs } = cfg;
    let lastAjaxTs = null;
    let hasAnyAjax = false;
    let done = false;

    const resourceObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        const entryStartAbs = Math.round(performance.timeOrigin + entry.startTime);
        if (entryStartAbs - clickTs > ajaxAttributionWindowMs) continue;
        hasAnyAjax = true;
        lastAjaxTs = Date.now();
      }
    });
    try { resourceObs && resourceObs.observe({ type: 'resource', buffered: false }); } catch {}

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();
      if (hasAnyAjax && lastAjaxTs !== null && (now - lastAjaxTs >= ajaxBatchQuietMs)) {
        finish(now);
      }
    }, 100);

    const timeout = setTimeout(() => {
      if (done) return;
      finish(hasAnyAjax ? Date.now() : null);
    }, ajaxCompletionTimeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        if (!done) finish(hasAnyAjax ? Date.now() : null);
      }, { once: true });
    }

    function finish(quietTs) {
      if (done) return;
      done = true;
      clearInterval(checkInterval);
      clearTimeout(timeout);
      try { resourceObs && resourceObs.disconnect(); } catch {}
      resolve({ quietTs });
    }
  });
}

/**
 * Interactivity guard: ждёт тихое окно по longtask после completionTs.
 * Возвращает Promise<{ operationTimeMs, operationTimeout }>.
 */
function _ot_runInteractivityGuard(completionTs, clickTs, cfg, abortSignal) {
  return new Promise((resolve) => {
    const { quietWindowMs, operationTimeoutMs } = cfg;
    let lastLongTaskEnd = completionTs;
    let done = false;

    const ltObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        const taskEnd = Math.round(performance.timeOrigin + entry.startTime + entry.duration);
        if (taskEnd > lastLongTaskEnd) lastLongTaskEnd = taskEnd;
      }
    });
    try { ltObs && ltObs.observe({ type: 'longtask' }); } catch {}

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();
      // Общий таймаут
      if (now - clickTs >= operationTimeoutMs) {
        finish(operationTimeoutMs, true);
        return;
      }
      // Тихое окно
      if (now - lastLongTaskEnd >= quietWindowMs) {
        finish(now - clickTs, false);
      }
    }, 50);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        if (!done) finish(Math.min(Date.now() - clickTs, operationTimeoutMs), false);
      }, { once: true });
    }

    function finish(opTimeMs, timedOut) {
      if (done) return;
      done = true;
      clearInterval(checkInterval);
      try { ltObs && ltObs.disconnect(); } catch {}
      resolve({ operationTimeMs: opTimeMs, operationTimeout: timedOut });
    }
  });
}

// ─── Ветки по action_type 

/** full_page_navigation */
async function _ot_measureFullPage(clickTs, cfg, durationMs, abortSignal) {
  // ── completion signal: MAX(LCP, loadEventEnd) с fallback на DCL 
  let lcpAbs = null;
  let contentTimeMs = null;

  try {
    const lcpObs = _ot_safeObserver((list) => {
      const entries = list.getEntries();
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        const abs = Math.round(performance.timeOrigin + last.startTime);
        lcpAbs = abs;
      }
    });
    if (lcpObs) {
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      // Даём время буфферизованным записям, 50ms надёжнее одного tick
      await new Promise(r => setTimeout(r, 50));
      lcpObs.disconnect();
    }
    // Попытка из буфера напрямую 
    if (lcpAbs === null) {
      const buffered = performance.getEntriesByType?.('largest-contentful-paint') || [];
      if (buffered.length > 0) {
        lcpAbs = Math.round(performance.timeOrigin + buffered[buffered.length - 1].startTime);
      }
    }
  } catch {}

  const [navEntry] = (performance.getEntriesByType?.('navigation') || []);
  const loadEventEndAbs = navEntry
    ? Math.round(performance.timeOrigin + navEntry.loadEventEnd)
    : null;
  const dclAbs = navEntry
    ? Math.round(performance.timeOrigin + navEntry.domContentLoadedEventEnd)
    : null;

  let completionTs, completionSignal;
  if (lcpAbs && loadEventEndAbs) {
    completionTs    = Math.max(lcpAbs, loadEventEndAbs);
    completionSignal = lcpAbs >= loadEventEndAbs ? 'lcp' : 'load_event';
  } else if (lcpAbs) {
    completionTs    = lcpAbs;
    completionSignal = 'lcp';
  } else if (loadEventEndAbs) {
    completionTs    = loadEventEndAbs;
    completionSignal = 'load_event';
  } else if (dclAbs) {
    completionTs    = dclAbs;
    completionSignal = 'dom_content_loaded';
  } else {
    completionTs    = Date.now();
    completionSignal = 'fallback';
  }

  // content_time_ms: LCP → loadEventEnd → DCL → null
  if (lcpAbs)          contentTimeMs = lcpAbs - clickTs;
  else if (loadEventEndAbs) contentTimeMs = loadEventEndAbs - clickTs;
  else if (dclAbs)     contentTimeMs = dclAbs - clickTs;

  // data_ready_ms через AJAX quiet (используем переданный abortSignal, не создаём локальный)
  const [ajaxResult, visualResult, guardResult] = await Promise.all([
    _ot_watchAjaxQuiet(clickTs, cfg, abortSignal),
    _ot_measureLayoutStable(clickTs, cfg, abortSignal),
    _ot_runInteractivityGuard(completionTs, clickTs, cfg, abortSignal)
  ]);

  const dataReadyMs   = ajaxResult.quietTs !== null ? ajaxResult.quietTs - clickTs : null;
  const visualStableMs = visualResult.stableTs !== null ? visualResult.stableTs - clickTs
    : (contentTimeMs !== null ? contentTimeMs : null);

  const ordered = _ot_enforceOrder(contentTimeMs, dataReadyMs, visualStableMs, guardResult.operationTimeMs, durationMs);

  return {
    contentTimeMs:   ordered.contentTimeMs,
    dataReadyMs:     ordered.dataReadyMs,
    visualStableMs:  ordered.visualStableMs,
    operationTimeMs: ordered.operationTimeMs,
    operationTimeout: guardResult.operationTimeout,
    completionSignal
  };
}

/**
 * Наблюдатель layout-shift для full_page. Возвращает Promise<{ stableTs }>.
 */
function _ot_measureLayoutStable(clickTs, cfg, abortSignal) {
  return new Promise((resolve) => {
    const { layoutStableMs, operationTimeoutMs } = cfg;
    let lastShiftTs = null;
    let done = false;

    const obs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          lastShiftTs = Math.round(performance.timeOrigin + entry.startTime);
        }
      }
    });
    try { obs && obs.observe({ type: 'layout-shift', buffered: true }); } catch {}

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();
      if (now - clickTs >= operationTimeoutMs) { finish(null); return; }
      if (lastShiftTs !== null && (now - lastShiftTs >= layoutStableMs)) {
        finish(lastShiftTs + layoutStableMs);
      }
    }, 100);

    const timeout = setTimeout(() => {
      if (!done) finish(null);
    }, operationTimeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        if (!done) finish(lastShiftTs ? lastShiftTs + layoutStableMs : null);
      }, { once: true });
    }

    function finish(stableTs) {
      if (done) return;
      done = true;
      clearInterval(checkInterval);
      clearTimeout(timeout);
      try { obs && obs.disconnect(); } catch {}
      resolve({ stableTs });
    }
  });
}

// spa_route_change 
async function _ot_measureSpa(clickTs, cfg, abortSignal, durationMs) {
  return new Promise((resolve) => {
    const {
      spaStabilityMs,
      spaNetworkQuietMs,
      spaStabilityTimeoutMs,
      spaMutationCap,
      operationTimeoutMs,
      quietWindowMs,
      layoutStableMs,
      ajaxAttributionWindowMs
    } = cfg;

    let domQuietSince     = Date.now();
    let networkQuietSince = Date.now();
    let totalMutations    = 0;
    let contentTimeMs     = null;
    let lastShiftTs       = null;
    let hasAjax           = false;   // были ли attributable AJAX
    let ajaxCompletionTs  = null;    // момент подтверждения network quiet
    let done              = false;
    const cleanups        = [];

    function abortCleanup() {
      // вызывается при preemption/page_unload — чистим все ресурсы
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());
      // Не вызываем resolve — внешний preemption/unload сам резолвит outerPromise
    }
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortCleanup, { once: true });
      cleanups.push(() => abortSignal.removeEventListener('abort', abortCleanup));
    }

    // ── Поток 1: DOM mutations 
    let mutObs = null;
    try {
      mutObs = new MutationObserver((mutations) => {
        if (done) return;
        let hasMeaningful = false;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (_OT_IGNORED_CONTENT.has(node.tagName)) continue;
            hasMeaningful = true;
            totalMutations++;
          }
        }
        if (totalMutations > spaMutationCap) {
          finish(Date.now(), null, null, 'spa_timeout');
          return;
        }
        if (hasMeaningful) {
          domQuietSince = Date.now();
          if (contentTimeMs === null && _ot_isSignificantMutation(mutations)) {
            contentTimeMs = Date.now() - clickTs;
          }
        }
      });
      mutObs.observe(document.body, { childList: true, subtree: true });
      cleanups.push(() => { try { mutObs.disconnect(); } catch {} });
    } catch {}

    // ── Поток 2: Network idle 
    const netObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        // фильтруем фоновые AJAX вне окна attribution (как в _ot_measureAjax/_ot_measureModal)
        const entryStartAbs = Math.round(performance.timeOrigin + entry.startTime);
        if (entryStartAbs - clickTs > ajaxAttributionWindowMs) continue;
        hasAjax = true;
        networkQuietSince = Date.now();
      }
    });
    try { netObs && netObs.observe({ type: 'resource', buffered: false }); } catch {}
    if (netObs) cleanups.push(() => { try { netObs.disconnect(); } catch {} });

    // ── Поток 3: layout-shift 
    const lsObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          lastShiftTs = Math.round(performance.timeOrigin + entry.startTime);
        }
      }
    });
    try { lsObs && lsObs.observe({ type: 'layout-shift', buffered: true }); } catch {}
    if (lsObs) cleanups.push(() => { try { lsObs.disconnect(); } catch {} });

    // ── interactivity guard 
    let lastLtEnd = Date.now();
    const ltObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        const taskEnd = Math.round(performance.timeOrigin + entry.startTime + entry.duration);
        if (taskEnd > lastLtEnd) lastLtEnd = taskEnd;
      }
    });
    try { ltObs && ltObs.observe({ type: 'longtask' }); } catch {}
    if (ltObs) cleanups.push(() => { try { ltObs.disconnect(); } catch {} });

    let completionSignalSet = null;

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();

      if (now - clickTs >= operationTimeoutMs) {
        finish(operationTimeoutMs, ajaxCompletionTs, null, 'spa_timeout', true);
        return;
      }

      const domQuiet = (now - domQuietSince >= spaStabilityMs);
      const netQuiet = (now - networkQuietSince >= spaNetworkQuietMs);

      if (!completionSignalSet && domQuiet && netQuiet) {
        completionSignalSet = 'spa_stable';
        // фиксируем момент network quiet как data_ready_ms (только если AJAX был)
        ajaxCompletionTs = hasAjax ? now : null;
        lastLtEnd = now;
      }

      if (completionSignalSet && (now - lastLtEnd >= quietWindowMs)) {
        let visualMs = null;
        if (lastShiftTs !== null) {
          const shiftStableTs = lastShiftTs + layoutStableMs;
          const mutStableTs = domQuietSince + spaStabilityMs;
          visualMs = Math.max(shiftStableTs, mutStableTs) - clickTs;
        } else {
          visualMs = domQuietSince + spaStabilityMs - clickTs;
        }
        finish(now - clickTs, ajaxCompletionTs, visualMs, completionSignalSet, false);
      }

      if (!completionSignalSet && (now - clickTs >= spaStabilityTimeoutMs)) {
        finish(now - clickTs, ajaxCompletionTs, null, 'spa_timeout', false);
      }
    }, 100);
    cleanups.push(() => clearInterval(checkInterval));
    // дублирующий spaTimeout убран — checkInterval (строка выше) уже обрабатывает
    // spaStabilityTimeoutMs и operationTimeoutMs; race condition с разными opTimeMs исключён.

    function finish(opTimeMs, ajaxTs, visualMs, signal, timedOut) {
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());

      const dataMs = ajaxTs !== null ? ajaxTs - clickTs : null;
      const ordered = _ot_enforceOrder(contentTimeMs, dataMs, visualMs, opTimeMs, durationMs);
      resolve({
        contentTimeMs:   ordered.contentTimeMs,
        dataReadyMs:     ordered.dataReadyMs,
        visualStableMs:  ordered.visualStableMs,
        operationTimeMs: ordered.operationTimeMs,
        operationTimeout: !!timedOut,
        completionSignal: signal
      });
    }
  });
}

/**
 * SPA: после стабилизации DOM+network параллельно смотрим AJAX.
 * Используется отдельный AJAX observer чтобы получить data_ready_ms.
 * Объединяем в measureSpa выше.
 */

// ajax_only_action 
async function _ot_measureAjax(clickTs, cfg, abortSignal, durationMs) {
  const { ajaxBatchQuietMs, ajaxCompletionTimeoutMs, ajaxAttributionWindowMs,
          quietWindowMs, operationTimeoutMs } = cfg;

  return new Promise((resolve) => {
    let lastAjaxTs = null;
    let hasAnyAjax = false;
    let ajaxCompletionTs = null;
    let ajaxSignal = null;
    let done = false;
    const cleanups = [];

    function abortCleanup() {
      // вызывается при preemption/page_unload
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());
    }
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortCleanup, { once: true });
      cleanups.push(() => abortSignal.removeEventListener('abort', abortCleanup));
    }

    const resourceObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        const entryStartAbs = Math.round(performance.timeOrigin + entry.startTime);
        if (entryStartAbs - clickTs > ajaxAttributionWindowMs) continue;
        hasAnyAjax = true;
        lastAjaxTs = Date.now();
      }
    });
    try { resourceObs && resourceObs.observe({ type: 'resource', buffered: false }); } catch {}
    if (resourceObs) cleanups.push(() => { try { resourceObs.disconnect(); } catch {} });

    // interactivity guard
    let lastLtEnd = Date.now();
    const ltObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        const taskEnd = Math.round(performance.timeOrigin + entry.startTime + entry.duration);
        if (taskEnd > lastLtEnd) lastLtEnd = taskEnd;
      }
    });
    try { ltObs && ltObs.observe({ type: 'longtask' }); } catch {}
    if (ltObs) cleanups.push(() => { try { ltObs.disconnect(); } catch {} });

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();

      if (now - clickTs >= operationTimeoutMs) {
        finish(operationTimeoutMs, ajaxCompletionTs, true, hasAnyAjax ? 'ajax_timeout' : null);
        return;
      }

      // AJAX idle: observer увидел AJAX и таймер тишины истёк
      if (!ajaxCompletionTs && hasAnyAjax && lastAjaxTs !== null && (now - lastAjaxTs >= ajaxBatchQuietMs)) {
        ajaxCompletionTs = now;
        ajaxSignal = 'ajax_idle';
        lastLtEnd = now;
      }
      // если AJAX не было за ajaxCompletionTimeoutMs — не ставим ложный completionTs.
      // Значит AJAX завершился до старта observer'а или его не было.
      // Запускаем interactivity guard с completionTs = now и сигналом ajax_pre_measurement.
      if (!ajaxCompletionTs && !hasAnyAjax && (now - clickTs >= ajaxCompletionTimeoutMs)) {
        ajaxCompletionTs = now;
        ajaxSignal = 'ajax_pre_measurement';
        lastLtEnd = now;
      }

      // interactivity guard после AJAX idle / pre_measurement
      if (ajaxCompletionTs && (now - lastLtEnd >= quietWindowMs)) {
        // data_ready_ms = null если AJAX не был виден observer'ом
        const dataTs = hasAnyAjax ? ajaxCompletionTs : null;
        finish(now - clickTs, dataTs, false, ajaxSignal);
      }
    }, 100);
    cleanups.push(() => clearInterval(checkInterval));

    const timeout = setTimeout(() => {
      if (!done) {
        const dataTs = hasAnyAjax ? ajaxCompletionTs : null;
        finish(operationTimeoutMs, dataTs, true, hasAnyAjax ? 'ajax_timeout' : null);
      }
    }, operationTimeoutMs);
    cleanups.push(() => clearTimeout(timeout));

    function finish(opTimeMs, ajaxTs, timedOut, signal) {
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());
      const dataReadyMs = ajaxTs !== null ? ajaxTs - clickTs : null;
      const ordered = _ot_enforceOrder(null, dataReadyMs, null, opTimeMs, durationMs);
      resolve({
        contentTimeMs:   null,
        dataReadyMs:     ordered.dataReadyMs,
        visualStableMs:  null,
        operationTimeMs: ordered.operationTimeMs,
        operationTimeout: !!timedOut,
        completionSignal: signal || ''
      });
    }
  });
}

// modal_or_popup_opened 
async function _ot_measureModal(modalElement, clickTs, cfg, abortSignal, durationMs) {
  const root = modalElement || document.body;
  const {
    modalStabilityMs,
    modalStabilityTimeoutMs,
    ajaxBatchQuietMs,
    ajaxAttributionWindowMs,
    quietWindowMs,
    operationTimeoutMs
  } = cfg;

  return new Promise((resolve) => {
    let domQuietSince     = Date.now();
    let networkQuietSince = Date.now();
    let hasAjax           = false;
    let ajaxCompletionTs  = null;  // момент AJAX quiet
    let contentTimeMs     = null;
    let done              = false;
    const cleanups        = [];

    function abortCleanup() {
      // вызывается при preemption/page_unload
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());
    }
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortCleanup, { once: true });
      cleanups.push(() => abortSignal.removeEventListener('abort', abortCleanup));
    }

    // Поток 1: DOM mutations внутри модалки
    let mutObs = null;
    try {
      mutObs = new MutationObserver((mutations) => {
        if (done) return;
        // fix сбрасываем domQuietSince только на видимые мутации (как в SPA)
        let hasMeaningful = false;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (_OT_IGNORED_CONTENT.has(node.tagName)) continue;
            hasMeaningful = true;
          }
        }
        if (hasMeaningful) domQuietSince = Date.now();
        if (contentTimeMs === null && _ot_isSignificantMutation(mutations)) {
          contentTimeMs = Date.now() - clickTs;
        }
      });
      mutObs.observe(root, { childList: true, subtree: true, characterData: true });
      cleanups.push(() => { try { mutObs.disconnect(); } catch {} });
    } catch {}

    // Поток 2: AJAX
    const netObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        const entryStartAbs = Math.round(performance.timeOrigin + entry.startTime);
        if (entryStartAbs - clickTs > ajaxAttributionWindowMs) continue;
        hasAjax = true;
        networkQuietSince = Date.now();
      }
    });
    try { netObs && netObs.observe({ type: 'resource', buffered: false }); } catch {}
    if (netObs) cleanups.push(() => { try { netObs.disconnect(); } catch {} });

    // interactivity guard
    let lastLtEnd = Date.now();
    const ltObs = _ot_safeObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        const taskEnd = Math.round(performance.timeOrigin + entry.startTime + entry.duration);
        if (taskEnd > lastLtEnd) lastLtEnd = taskEnd;
      }
    });
    try { ltObs && ltObs.observe({ type: 'longtask' }); } catch {}
    if (ltObs) cleanups.push(() => { try { ltObs.disconnect(); } catch {} });

    let completionTs = null;
    let completionSignal = null;

    const checkInterval = setInterval(() => {
      if (done) return;
      const now = Date.now();

      if (now - clickTs >= operationTimeoutMs) {
        finish(operationTimeoutMs, ajaxCompletionTs, null, 'modal_timeout', true);
        return;
      }

      const domQuiet = (now - domQuietSince >= modalStabilityMs);
      const netQuiet = !hasAjax || (now - networkQuietSince >= ajaxBatchQuietMs);

      if (!completionTs && domQuiet && netQuiet) {
        completionTs = now;
        completionSignal = 'modal_stable';
        // фиксируем AJAX completion только если AJAX был
        ajaxCompletionTs = hasAjax ? now : null;
        lastLtEnd = now;
      }

      if (completionTs && (now - lastLtEnd >= quietWindowMs)) {
        const visualMs = domQuietSince + modalStabilityMs - clickTs;
        finish(now - clickTs, ajaxCompletionTs, visualMs, completionSignal, false);
      }
    }, 100);
    cleanups.push(() => clearInterval(checkInterval));

    const modalTimeout = setTimeout(() => {
      if (!done) finish(Date.now() - clickTs, ajaxCompletionTs, null, 'modal_timeout', false);
    }, modalStabilityTimeoutMs);
    cleanups.push(() => clearTimeout(modalTimeout));

    function finish(opTimeMs, ajaxTs, visualMs, signal, timedOut) {
      if (done) return;
      done = true;
      cleanups.forEach(fn => fn());
      const dataMs = ajaxTs !== null ? ajaxTs - clickTs : null;
      const ordered = _ot_enforceOrder(contentTimeMs, dataMs, visualMs, opTimeMs, durationMs);
      resolve({
        contentTimeMs:   ordered.contentTimeMs,
        dataReadyMs:     ordered.dataReadyMs,  // теперь заполняется при AJAX
        visualStableMs:  ordered.visualStableMs,
        operationTimeMs: ordered.operationTimeMs,
        operationTimeout: !!timedOut,
        completionSignal: signal
      });
    }
  });
}

// form_submit 
async function _ot_measureFormSubmit(clickTs, durationMs, cfg, abortSignal) {
  // Ждём 200ms — если страница уходит, beforeunload/abort прервёт нас
  await new Promise(r => {
    const t = setTimeout(r, 200);
    if (abortSignal) abortSignal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
  if (abortSignal?.aborted) return { contentTimeMs: null, dataReadyMs: null, visualStableMs: null, operationTimeMs: durationMs ?? 0, operationTimeout: false, completionSignal: 'preempted' };

  // Смотрим AJAX
  const ajaxResult = await _ot_watchAjaxQuiet(clickTs, cfg, abortSignal);
  if (ajaxResult.quietTs !== null) {
    const dataReadyMs = ajaxResult.quietTs - clickTs;
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const guard = await _ot_runInteractivityGuard(ajaxResult.quietTs, clickTs, cfg, abortCtrl?.signal);
    if (abortCtrl) abortCtrl.abort();
    const ordered = _ot_enforceOrder(null, dataReadyMs, null, guard.operationTimeMs, durationMs);
    return {
      contentTimeMs:   null,
      dataReadyMs:     ordered.dataReadyMs,
      visualStableMs:  null,
      operationTimeMs: ordered.operationTimeMs,
      operationTimeout: guard.operationTimeout,
      completionSignal: 'form_ajax_idle'
    };
  }

  // Нет AJAX и страница не ушла — мгновенный результат
  const opMs = durationMs ?? 0;
  return {
    contentTimeMs:   null,
    dataReadyMs:     null,
    visualStableMs:  null,
    operationTimeMs: opMs,
    operationTimeout: false,
    completionSignal: 'form_immediate'
  };
}

// ─── Публичный API 

/**
 * Начинает измерение timeline-метрик после подтверждения action click.
 *
 * @param {Object} params
 * @param {number}        params.clickTimestamp  — Date.now() в момент клика
 * @param {string}        params.actionType      — тип действия из action click observer
 * @param {number|null}   params.durationMs      — duration_ms (first response), для passthrough
 * @param {Element|null}  params.modalElement    — найденный модальный элемент
 * @param {Object}        params.config          — siteConfig.operationTiming блок
 * @returns {Promise<OperationTimingResult>}
 */
async function measureOperationTime({ clickTimestamp, actionType, durationMs, modalElement, config }) {
  // Preempt предыдущее измерение
  if (_currentMeasurement) {
    const prev = _currentMeasurement;
    _currentMeasurement = null;
    prev.cleanup();
    prev.resolve({
      contentTimeMs:   prev.accumulatedContent,
      dataReadyMs:     prev.accumulatedData,
      visualStableMs:  prev.accumulatedVisual,
      operationTimeMs: Date.now() - prev.clickTs,
      operationTimeout: false,
      completionSignal: 'preempted'
    });
  }

  const cfg = _ot_cfg(config);

  // Passthrough: new_tab_or_window
  if (actionType === 'new_tab_or_window') {
    return {
      contentTimeMs:   null,
      dataReadyMs:     null,
      visualStableMs:  null,
      operationTimeMs: durationMs ?? 0,
      operationTimeout: false,
      completionSignal: 'new_tab_immediate'
    };
  }

  // Passthrough: dom_state_change
  if (actionType === 'dom_state_change') {
    return {
      contentTimeMs:   null,
      dataReadyMs:     null,
      visualStableMs:  null,
      operationTimeMs: durationMs ?? 0,
      operationTimeout: false,
      completionSignal: 'dom_immediate'
    };
  }

  // Полное измерение: регистрируем в preemption guard
  return new Promise((outerResolve) => {
    // AbortController для реального cleanup внутренних observers при preemption/unload
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const innerSignal = abortCtrl?.signal ?? null;

    const guardEntry = {
      resolve: outerResolve,
      cleanup: () => { try { abortCtrl?.abort(); } catch {} }, // реальный cleanup
      clickTs: clickTimestamp,
      accumulatedContent: null,
      accumulatedData:    null,
      accumulatedVisual:  null
    };
    _currentMeasurement = guardEntry;

    let inner;
    try {
      switch (actionType) {
        case 'full_page_navigation':
          inner = _ot_measureFullPage(clickTimestamp, cfg, durationMs, innerSignal);
          break;
        case 'spa_route_change':
          inner = _ot_measureSpa(clickTimestamp, cfg, innerSignal, durationMs);
          break;
        case 'ajax_only_action':
          inner = _ot_measureAjax(clickTimestamp, cfg, innerSignal, durationMs);
          break;
        case 'modal_or_popup_opened':
          inner = _ot_measureModal(modalElement, clickTimestamp, cfg, innerSignal, durationMs);
          break;
        case 'form_submit':
          inner = _ot_measureFormSubmit(clickTimestamp, durationMs, cfg, innerSignal);
          break;
        default:
          // Неизвестный тип — fallback passthrough
          inner = Promise.resolve({
            contentTimeMs:   null,
            dataReadyMs:     null,
            visualStableMs:  null,
            operationTimeMs: durationMs ?? 0,
            operationTimeout: false,
            completionSignal: 'unknown_passthrough'
          });
      }
    } catch (e) {
      inner = Promise.reject(e);
    }

    inner.then((result) => {
      if (_currentMeasurement === guardEntry) {
        _currentMeasurement = null;
      }
      outerResolve(result);
    }).catch(() => {
      if (_currentMeasurement === guardEntry) {
        _currentMeasurement = null;
      }
      // При ошибке — минимальный passthrough
      outerResolve({
        contentTimeMs:   null,
        dataReadyMs:     null,
        visualStableMs:  null,
        operationTimeMs: durationMs ?? 0,
        operationTimeout: false,
        completionSignal: 'error_fallback'
      });
    });
  });
}
