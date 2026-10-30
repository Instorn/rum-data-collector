/** services/export/exportWhitelistFilter.js
единый фильтр whitelist для всех export-модулей.
Вызывается в _xx_buildCsvContent/_xx_buildJsonContent и standalone-экспортах
ДО остальной обработки, чтобы события с неразрешённых доменов не попадали
в CSV/JSON даже при ошибке runtime-gate.

Source of truth matching — services/siteConfig/match.js (RumSiteMatch).
Локальные реализации matching в export-модулях запрещены. */

(function (root) {
  function _pickHost(ev) {
    if (!ev || typeof ev !== 'object') return '';
    // Возможные поля, откуда можно извлечь host/url в зависимости от типа события.
    var fields = ['url', 'page_url', 'pageUrl', 'resourceUrl', 'resource_url',
                  'pageUrlBefore', 'entry_url', 'resultUrl', 'result_url',
                  'targetUrl', 'target_url'];
    for (var i = 0; i < fields.length; i++) {
      var v = ev[fields[i]];
      if (!v) continue;
      var h = (root.RumSiteMatch && root.RumSiteMatch.extractHost(v)) || '';
      if (h) return h;
    }
    if (ev.domain && typeof ev.domain === 'string') return ev.domain;
    return '';
  }

  function _filterArray(arr, siteConfigs, opts) {
    if (!Array.isArray(arr)) return arr;
    var M = root.RumSiteMatch;
    if (!M) return arr;
    return arr.filter(function (ev) {
      var host = _pickHost(ev);
      if (!host) return false;
      // effective mode (учитывает catch-all downgrade до minimal).
      // Читать cfg.mode напрямую нельзя — это ломало бы второй слой защиты
      // при {"domain":"*","mode":"both"}.
      var eff = M.resolveEffectiveMode(host, siteConfigs);
      if (eff === 'disabled') return false;
      return true;
    });
  }

  // Возвращает shallow-копию snapshot с пере-фильтрованными буферами.
  // Не мутирует входной объект.
  function filterSnapshot(snapshot, siteConfigs, opts) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    if (!Array.isArray(siteConfigs)) siteConfigs = [];
    var out = Object.assign({}, snapshot);
    var arrKeys = [
      'webVitals', 'aggregatedMetrics',
      'freezeEvents', 'blankPageEvents', 'actionClicks',
      'anomalies', 'rawEvents', 'navigationEvents', 'events'
    ];
    for (var i = 0; i < arrKeys.length; i++) {
      var k = arrKeys[i];
      if (Array.isArray(out[k])) out[k] = _filterArray(out[k], siteConfigs, opts);
    }
    return out;
  }

  root.RumExportWhitelist = {
    filterSnapshot: filterSnapshot,
    filterArray: _filterArray,
    pickHost: _pickHost,
  };
})(typeof self !== 'undefined' ? self : this);
