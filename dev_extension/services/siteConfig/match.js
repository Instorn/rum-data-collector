/** services/siteConfig/match.js
 единый helper wildcard-матчинга доменов по siteConfigs.
 Загружается:
   - в service worker через importScripts('services/siteConfig/match.js');
   - в ISOLATED content-script bundle первым элементом (до content.js) через manifest.

Экспорт через self.RumSiteMatch — работает и в window (content), и в ServiceWorkerGlobalScope.

 ! логика wildcard-приоритета должна оставаться единой для всех слоёв
(content/background/export). Дублировать matching вне этого файла нельзя.
Приоритет выбора записи: exact → *.suffix → * (catch-all). */

(function (root) {
  function matchesDomain(pattern, domain) {
    if (!pattern || !domain) return false;
    if (pattern === '*') return true;
    if (pattern === domain) return true;
    if (pattern.indexOf('*.') === 0) {
      var suffix = pattern.slice(2);
      // *.example.com матчит example.com и любой sub.example.com.
      return domain === suffix || domain.endsWith('.' + suffix);
    }
    return false;
  }

  function findSiteConfig(domain, siteConfigs) {
    if (!Array.isArray(siteConfigs) || siteConfigs.length === 0) return null;
    if (!domain) return null;
    var exact = null, subdomain = null, catchAll = null;
    for (var i = 0; i < siteConfigs.length; i++) {
      var c = siteConfigs[i];
      if (!c || typeof c.domain !== 'string') continue;
      if (c.domain === domain) { exact = c; break; }
      if (!subdomain && c.domain.indexOf('*.') === 0 && matchesDomain(c.domain, domain)) subdomain = c;
      if (!catchAll && c.domain === '*') catchAll = c;
    }
    return exact || subdomain || catchAll || null;
  }

  var VALID_MODES = ['monitor', 'both', 'minimal', 'disabled'];

  // единый расчёт effective mode для всех слоёв (content/background/export).
  // Правила обязаны совпадать с content.js getSiteMode():
  //   - нет siteConfigs / нет записи → 'disabled';
  //   - enabled === false → 'disabled';
  //   - unknown mode → 'disabled' (в т. ч. 'discovery': режим удалён в 1.15.0, compact fix-1);
  //   - catch-all "*" с monitor/both → downgrade до 'minimal';
  //   - иначе — исходный mode ('both' работает как 'monitor').
  function resolveEffectiveMode(domain, siteConfigs) {
    if (!Array.isArray(siteConfigs) || siteConfigs.length === 0) return 'disabled';
    if (!domain) return 'disabled';
    var c = findSiteConfig(domain, siteConfigs);
    if (!c) return 'disabled';
    if (c.enabled === false) return 'disabled';
    var mode = c.mode;
    if (VALID_MODES.indexOf(mode) === -1) return 'disabled';
    if (c.domain === '*' && (mode === 'monitor' || mode === 'both')) {
      return 'minimal';
    }
    return mode;
  }

  // true только если effective mode домена не equivalent к "не собираем ничего".
  // Все слои (background gate / export filter) обязаны использовать ЭТОТ helper,
  // а не читать cfg.mode напрямую — иначе catch-all downgrade не удерживается
  // на втором эшелоне защиты.
  function isDomainAllowed(domain, siteConfigs) {
    var eff = resolveEffectiveMode(domain, siteConfigs);
    return eff !== 'disabled';
  }

  function extractHost(url) {
    if (!url) return '';
    try { return new URL(url).hostname || ''; } catch (_) { return ''; }
  }

  // fix-21: единый разбор siteConfigs из объекта настроек (перенесён 1:1 из модуля
  // удалённого отчёта 01, вызовы в background и выгрузках переведены сюда).
  // Поддерживает siteConfigs-массив и отдельные siteConfig_N ключи (по возрастанию N,
  // JSON-строки парсятся, битые пропускаются). Пусто → null.
  // От него зависит белый список доменов в background — не удалять.
  function parseSiteConfigs(settings) {
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

  root.RumSiteMatch = {
    matchesDomain: matchesDomain,
    findSiteConfig: findSiteConfig,
    resolveEffectiveMode: resolveEffectiveMode,
    isDomainAllowed: isDomainAllowed,
    extractHost: extractHost,
    parseSiteConfigs: parseSiteConfigs,
  };
})(typeof self !== 'undefined' ? self : this);
