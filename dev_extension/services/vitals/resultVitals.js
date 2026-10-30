/**
 * resultVitals.js
 *
 * Метрики качества загрузки страницы-назначения для записи действия (04):
 *   res_lcp_ms, res_lcp_candidates, res_lcp_el — LCP-кандидаты (createLcpCollector);
 *   res_cls — CLS без сдвигов после ввода пользователя (createClsCollector).
 *
 * Загружается как content script перед content.js (compact fix-4: вынесено из content.js).
 * Не пишет в storage, не шлёт runtime messages: досылку финального LCP отдаёт колбэком
 * onFinalUpdate, сообщение LCP_FINAL_UPDATE отправляет content.js.
 */

const RumResultVitals = (() => {

  // ─── LCP-кандидаты ────────────────────────────────────────────────────────────

  /**
   * Долгоживущий LCP-коллектор (fix-10).
   *
   * Проблема: LCP-observer отключался в момент отправки ACTION_CLICK_CONFIRMED,
   * хотя браузер продолжает выдавать LCP-кандидатов до первого взаимодействия
   * пользователя. Записанный res_lcp_ms оказывался промежуточным кандидатом
   * (пример из трейса: 1807 ms при финальном LCP 5138 ms — large image).
   *
   * Решение: observer живёт до естественной финализации LCP — первого
   * pointerdown/keydown, скрытия вкладки, pagehide или opts.timeoutMs.
   * Все кандидаты копятся в массиве; если после отправки записи появились
   * новые — вызывается opts.onFinalUpdate с финальным значением
   * (content.js досылает в background LCP_FINAL_UPDATE).
   *
   * opts.timeoutMs        — таймаут финализации после armLateUpdate (content.js передаёт LCP_TIMEOUT_MS)
   * opts.describeElement  — (el) => string, селектор элемента-кандидата (content.js: _ct_getSimpleSelector)
   * opts.onFinalUpdate    — ({ clickId, resLcp, resLcpCandidates }) => void, вызывается не более
   *                         одного раза и только если после armLateUpdate появились новые кандидаты
   */
  function createLcpCollector(opts) {
    const o = opts || {};
    const st = {
      candidates: [],      // [{ t, size, tag, cls }] в порядке появления
      obs: null,
      finalized: false,
      armedClickId: null,  // clickId записи, которую нужно обновить досылкой
      sentCount: 0,        // сколько кандидатов было на момент отправки записи
      timeoutId: null
    };

    function _ingest(entries) {
      for (const e of entries) {
        if (st.candidates.length >= 20) break; // защитный лимит
        // fix-12: селектор элемента-кандидата. Сбор LCP важнее селектора —
        // любая ошибка построения гасится, кандидат всё равно пишется с cls = ''.
        let cls = '';
        try {
          if (e.element && typeof o.describeElement === 'function') {
            cls = o.describeElement(e.element)
                    .replace(/\d{6,}/g, '#')   // маскирование id клиента (до обрезки!)
                    .slice(0, 60);             // обрезка
          }
        } catch (err) { cls = ''; }
        st.candidates.push({
          t:    Math.round(e.startTime),
          size: typeof e.size === 'number' ? e.size : 0,
          tag:  (e.element && e.element.tagName) || '',
          cls:  cls
        });
      }
    }

    try {
      st.obs = new PerformanceObserver((list) => _ingest(list.getEntries()));
      st.obs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* LCP observer недоступен */ }

    function getResLcp() {
      return st.candidates.length > 0 ? st.candidates[st.candidates.length - 1].t : null;
    }

    function getCandidates() {
      return st.candidates.slice();
    }

    function _finalize() {
      if (st.finalized) return;
      st.finalized = true;
      try {
        // takeRecords: забираем кандидатов, уже зафиксированных браузером,
        // но ещё не доставленных в callback (доставка асинхронная)
        if (st.obs) { _ingest(st.obs.takeRecords()); st.obs.disconnect(); }
      } catch (e) {}
      if (st.timeoutId) { clearTimeout(st.timeoutId); st.timeoutId = null; }
      document.removeEventListener('pointerdown', _finalize, true);
      document.removeEventListener('keydown', _finalize, true);
      document.removeEventListener('visibilitychange', _onVisibility, true);
      window.removeEventListener('pagehide', _finalize, true);

      // Досылка — только если запись уже ушла и после отправки появились новые кандидаты
      if (st.armedClickId && st.candidates.length > st.sentCount) {
        try {
          if (typeof o.onFinalUpdate === 'function') {
            o.onFinalUpdate({
              clickId:          st.armedClickId,
              resLcp:           getResLcp(),
              resLcpCandidates: getCandidates()
            });
          }
        } catch (e) { /* ошибка колбэка не срывает финализацию */ }
      }
    }

    function _onVisibility() {
      if (document.visibilityState === 'hidden') _finalize();
    }

    /**
     * Вызывается сразу после отправки ACTION_CLICK_CONFIRMED.
     * Наблюдение продолжается до финализации LCP; при появлении новых
     * кандидатов запись clickId будет обновлена досылкой (onFinalUpdate).
     */
    function armLateUpdate(clickId) {
      if (st.finalized || !clickId) return;
      st.armedClickId = clickId;
      st.sentCount = st.candidates.length;
      document.addEventListener('pointerdown', _finalize, true);
      document.addEventListener('keydown', _finalize, true);
      document.addEventListener('visibilitychange', _onVisibility, true);
      window.addEventListener('pagehide', _finalize, true);
      st.timeoutId = setTimeout(_finalize, o.timeoutMs);
    }

    return { getResLcp, getCandidates, armLateUpdate };
  }

  // ─── CLS ──────────────────────────────────────────────────────────────────────

  /**
   * CLS без hadRecentInput: простая сумма layout-shift (buffered) до stop().
   * Отключается в момент отправки записи (в отличие от LCP-коллектора).
   * getValue(): число с 4 знаками или null, если сдвигов не было.
   */
  function createClsCollector() {
    let sum = 0;
    let hasEntries = false;
    let obs = null;

    try {
      obs = new PerformanceObserver((list) => {
        for (const s of list.getEntries()) {
          if (!s.hadRecentInput) { sum += s.value; hasEntries = true; }
        }
      });
      obs.observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* CLS observer недоступен */ }

    function stop() {
      try { if (obs) obs.disconnect(); } catch (e) {}
      obs = null;   // повторный вызов — без повторного disconnect
    }

    function getValue() {
      return hasEntries ? Math.round(sum * 10000) / 10000 : null;
    }

    return { getValue, stop };
  }

  return { createLcpCollector, createClsCollector };

})();
