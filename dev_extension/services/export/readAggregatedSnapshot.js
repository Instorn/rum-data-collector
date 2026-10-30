/* fix-9 Этап 2 — единая точка чтения полного aggregatedRumData из storage-раскладки v2.

   Тяжёлые секции (actionClicks, ajaxTimings._raw) хранятся в отдельных ключах
   storage.local (rumActionClicks, rumAjaxRaw). Этот хелпер читает core-блоб +
   отдельные ключи + любые extraKeys и возвращает объект В ТОЙ ЖЕ ФОРМЕ, что
   раньше отдавал chrome.storage.local.get([...]):
     - result.aggregatedRumData — полный блоб с вклеенными actionClicks и
       ajaxTimings._raw;
     - все extraKeys — на верхнем уровне result (pcIdentifier, fileBasedSettings,
       rumSessionId, SESSION_START_TS и т.п.).

   Fallback на старую раскладку: если маркер rumStorageLayoutV2 не выставлен
   (расширение ещё не мигрировало) — actionClicks/ajaxTimings._raw берутся из
   самого блоба, отдельные ключи игнорируются. Это делает все читатели
   устойчивыми и до, и после миграции.

   Подключается в SW через importScripts ДО всех export-модулей; экспортёры —
   плоские скрипты в общем SW-scope, поэтому глобальная функция им доступна. */

(function () {
  'use strict';

  const CORE_KEY   = 'aggregatedRumData';
  const CLICKS_KEY = 'rumActionClicks';
  const AJAX_KEY   = 'rumAjaxRaw';
  const MARKER_KEY = 'rumStorageLayoutV2';

  /**
   * @param {string[]} [extraKeys] — дополнительные ключи storage.local, которые
   *   читателю нужны наравне с блобом (pcIdentifier, fileBasedSettings и т.д.).
   * @returns {Promise<Object>} объект вида
   *   { aggregatedRumData: <полный блоб>, ...extraKeys }.
   */
  function readAggregatedSnapshot(extraKeys) {
    const extras = Array.isArray(extraKeys) ? extraKeys : [];
    // Дедуп + всегда читаем core/clicks/ajax/marker.
    const keySet = {};
    [CORE_KEY, CLICKS_KEY, AJAX_KEY, MARKER_KEY].forEach(k => { keySet[k] = true; });
    extras.forEach(k => { if (typeof k === 'string' && k) keySet[k] = true; });
    const keys = Object.keys(keySet);

    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => {
        const result = {};
        const r = (chrome.runtime && chrome.runtime.lastError) ? {} : (res || {});

        // Копируем extraKeys как есть.
        extras.forEach(k => { if (typeof k === 'string' && k) result[k] = r[k]; });

        // Собираем полный блоб.
        const core = (r[CORE_KEY] && typeof r[CORE_KEY] === 'object') ? r[CORE_KEY] : {};
        const raw = Object.assign({}, core);

        const migratedV2 = r[MARKER_KEY] === '2';
        if (migratedV2) {
          // Раскладка v2: тяжёлые секции — из отдельных ключей.
          raw.actionClicks = Array.isArray(r[CLICKS_KEY]) ? r[CLICKS_KEY] : (Array.isArray(raw.actionClicks) ? raw.actionClicks : []);
          raw.ajaxTimings = (raw.ajaxTimings && typeof raw.ajaxTimings === 'object') ? raw.ajaxTimings : {};
          raw.ajaxTimings._raw = Array.isArray(r[AJAX_KEY]) ? r[AJAX_KEY] : (Array.isArray(raw.ajaxTimings._raw) ? raw.ajaxTimings._raw : []);
        } else {
          // Старая раскладка (ещё не мигрировано): всё в самом блобе. На случай,
          // если отдельные ключи всё же существуют (частичная миграция), отдаём
          // приоритет непустым отдельным ключам, иначе оставляем блоб.
          if (Array.isArray(r[CLICKS_KEY]) && r[CLICKS_KEY].length) raw.actionClicks = r[CLICKS_KEY];
          else raw.actionClicks = Array.isArray(raw.actionClicks) ? raw.actionClicks : [];
          raw.ajaxTimings = (raw.ajaxTimings && typeof raw.ajaxTimings === 'object') ? raw.ajaxTimings : {};
          if (Array.isArray(r[AJAX_KEY]) && r[AJAX_KEY].length) raw.ajaxTimings._raw = r[AJAX_KEY];
          else raw.ajaxTimings._raw = Array.isArray(raw.ajaxTimings._raw) ? raw.ajaxTimings._raw : [];
        }

        result[CORE_KEY] = raw;
        resolve(result);
      });
    });
  }

  /**
   * Синхронная склейка полного блоба из уже прочитанного объекта localData
   * (например, из chrome.storage.local.get(null)). Возвращает aggregatedRumData
   * с вклеенными actionClicks / ajaxTimings._raw. Используется там, где localData
   * уже прочитан целиком ради других ключей (runRoleBundleExport), чтобы не делать
   * второй get.
   * @param {Object} localData
   * @returns {Object} полный блоб
   */
  function mergeAggregatedFromLocalData(localData) {
    const ld = localData || {};
    const core = (ld[CORE_KEY] && typeof ld[CORE_KEY] === 'object') ? ld[CORE_KEY] : {};
    const raw = Object.assign({}, core);
    const migratedV2 = ld[MARKER_KEY] === '2';
    if (migratedV2) {
      raw.actionClicks = Array.isArray(ld[CLICKS_KEY]) ? ld[CLICKS_KEY] : (Array.isArray(raw.actionClicks) ? raw.actionClicks : []);
      raw.ajaxTimings = (raw.ajaxTimings && typeof raw.ajaxTimings === 'object') ? raw.ajaxTimings : {};
      raw.ajaxTimings._raw = Array.isArray(ld[AJAX_KEY]) ? ld[AJAX_KEY] : (Array.isArray(raw.ajaxTimings._raw) ? raw.ajaxTimings._raw : []);
    } else {
      if (Array.isArray(ld[CLICKS_KEY]) && ld[CLICKS_KEY].length) raw.actionClicks = ld[CLICKS_KEY];
      else raw.actionClicks = Array.isArray(raw.actionClicks) ? raw.actionClicks : [];
      raw.ajaxTimings = (raw.ajaxTimings && typeof raw.ajaxTimings === 'object') ? raw.ajaxTimings : {};
      if (Array.isArray(ld[AJAX_KEY]) && ld[AJAX_KEY].length) raw.ajaxTimings._raw = ld[AJAX_KEY];
      else raw.ajaxTimings._raw = Array.isArray(raw.ajaxTimings._raw) ? raw.ajaxTimings._raw : [];
    }
    return raw;
  }

  // Экспорт в глобальный SW-scope (плоский скрипт через importScripts).
  const _root = (typeof self !== 'undefined') ? self : ((typeof globalThis !== 'undefined') ? globalThis : this);
  if (_root) {
    _root.readAggregatedSnapshot = readAggregatedSnapshot;
    _root.mergeAggregatedFromLocalData = mergeAggregatedFromLocalData;
  }
})();
