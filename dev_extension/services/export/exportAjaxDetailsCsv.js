/** services/export/exportAjaxDetailsCsv.js
CSV-экспорт AJAX/fetch resource timing событий.
Формат: ajax-details.csv — raw-события AJAX/fetch.
Разделитель: ; (UTF-8 BOM, как все CSV проекта).
Автономный модуль — не зависит от других export-модулей.
Подключается через importScripts в background.js.
Имя файла: {pc}_{YYYY-MM-DD}_ajax-details.csv */

// ─── Утилиты 

function _aj_sanitizePcName(pcName) {
  if (!pcName || typeof pcName !== 'string' || pcName.trim() === '') return 'none';
  return pcName.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function _aj_buildFileName(pcName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return `${_aj_sanitizePcName(pcName)}_${dateStr}_ajax-details.csv`;
}

// имя файла для bundle-варианта — совпадает по стилю с 04/06
function _aj_buildBundleFileName(pcName) {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `05-ajax-details_${_aj_sanitizePcName(pcName)}_${dateStr}.csv`;
}

// Формат YYYY-MM-DD HH:mm:ss в локальном времени
function _aj_formatDatetime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Экранирование значения для CSV-ячейки (разделитель ;, русский Excel) */
// добавлен formula guard против Excel injection для строковых значений
function _aj_csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  }
  const s = String(v);
  // нейтрализуем Excel formula injection для строковых значений
  const guarded = (typeof csvFormulaGuard === 'function') ? csvFormulaGuard(s) : s;
  if (guarded.includes(';') || guarded.includes('"') || guarded.includes('\n')) {
    return '"' + guarded.replace(/"/g, '""') + '"';
  }
  return guarded;
}

/** Строка CSV из массива значений */
function _aj_csvRow(values) {
  return values.map(_aj_csvCell).join(';');
}

// ─── Построение секций CSV ────────────────────────────────────────────────────

function _aj_buildRawRows(rawEvents, pcName) {
  const header = _aj_csvRow([
    'pcname', 'ts', 'domain', 'tabid', 'sessionid',
    'click_id',
    'journeyx', 'journeyy', 'journeyz', 'entryurl', 'coordversion',
    'transitiontype', 'pageurl', 'resourceurl', 'resourcedomain',
    'resourcepath', 'initiatortype', 'duration', 'ttfb', 'dnstime',
    'connecttime', 'tlstime', 'requesttime', 'responsetime',
    'transfersize', 'encodedbodysize', 'decodedbodysize',
    'protocol', 'responsestatus', 'cached', 'journeypos'
  ]);

  const rows = (rawEvents || []).map(e => {
    // повторная санитизация URL-полей при экспорте — очищает исторические raw-данные
    const _safePageUrl     = (typeof exportSafeUrl === 'function') ? exportSafeUrl(e.pageUrl)     : (e.pageUrl     || '');
    const _safeResourceUrl = (typeof exportSafeUrl === 'function') ? exportSafeUrl(e.resourceUrl) : (e.resourceUrl || '');
    // resourcePath — часть URL, может содержать ID; берём pathname из sanitized resourceUrl
    let _safeResourcePath = e.resourcePath || '';
    if (typeof exportSafeUrl === 'function' && _safeResourcePath) {
      try {
        // resourcePath уже должен быть путём; если это так — переиспользуем из sanitized URL
        _safeResourcePath = new URL(_safeResourceUrl).pathname;
      } catch {
        _safeResourcePath = exportSafeUrl(_safeResourcePath);
      }
    }

    return _aj_csvRow([
    pcName,
    _aj_formatDatetime(e.timestamp),
    e.resourceDomain || '',
    e.tabId          ?? '',
    e.sessionId      || '',
    e.clickId        || '',
    e.journeyx       ?? '',
    e.journeyy       ?? '',
    e.journeyz       ?? '',
    e.entryUrl       || '',
    e.coordVersion   ?? '',
    e.transitionType || '',
    _safePageUrl,
    _safeResourceUrl,
    e.resourceDomain || '',
    _safeResourcePath,
    e.initiatorType  || '',
    e.duration       ?? '',
    e.ttfb           ?? '',
    e.dnsTime        ?? '',
    e.connectTime    ?? '',
    e.tlsTime        ?? '',
    e.requestTime    ?? '',
    e.responseTime   ?? '',
    e.transferSize   ?? '',
    e.encodedBodySize ?? '',
    e.decodedBodySize ?? '',
    e.protocol       || '',
    e.responseStatus ?? '',
    e.cached ? 1 : 0,
    e.journeyPos     ?? ''
    ]);
  });

  return [header, ...rows].join('\n');
}

// ─── Bundle builder 

/**
 * Строит CSV-контент bundle-варианта из уже загруженного snapshot.
 * Используется из runRoleBundleExport() в services/export/roleBundleExport.js.
 *
 * Источник данных — тот же, что и у standalone-экспорта:
 *   snapshot.ajaxTimings._raw
 *
 * @param {Object} snapshot — { ajaxTimings, pcIdentifier }
 * @returns {{ csvContent: string, filename: string } | { _err: string }}
 */
function _aj_buildCsvContentFromSnapshot(snapshot) {
  const ajax = snapshot && snapshot.ajaxTimings;
  if (!ajax || !Array.isArray(ajax._raw) || ajax._raw.length === 0) {
    return { _err: 'no_ajax_data' };
  }

  const pcName = snapshot.pcIdentifier?.pcName || 'none';
  const pcSafe = _aj_sanitizePcName(pcName);

  const csvContent = _aj_buildRawRows(ajax._raw, pcSafe);

  return {
    csvContent,
    filename: _aj_buildBundleFileName(pcName)
  };
}

// ─── Чтение данных из storage 

function _aj_readStorage() {
  return new Promise(resolve => {
    readAggregatedSnapshot(['pcIdentifier', 'fileBasedSettings']).then(result => { // fix-9 Этап 2: единая точка чтения блоба
      const raw = result.aggregatedRumData || {};
      chrome.storage.managed.get(null, (mg) => {
        // актуальный whitelist siteConfigs.
        let siteConfigs = (mg && Array.isArray(mg.siteConfigs)) ? mg.siteConfigs : null;
        if (!siteConfigs && self.RumSiteMatch && RumSiteMatch.parseSiteConfigs) {
          try { siteConfigs = RumSiteMatch.parseSiteConfigs(mg) || null; } catch (_) {}
        }
        if ((!siteConfigs || siteConfigs.length === 0) && result.fileBasedSettings) {
          try { siteConfigs = RumSiteMatch.parseSiteConfigs(result.fileBasedSettings) || []; } catch (_) { siteConfigs = []; }
        }
        siteConfigs = siteConfigs || [];

        let ajaxTimings = raw.ajaxTimings || null;
        if (ajaxTimings && typeof self !== 'undefined' && self.RumExportWhitelist) {
          // Фильтруем raw массив по ключу (endpoint URL).
          const atCopy = Object.assign({}, ajaxTimings);
          if (Array.isArray(atCopy._raw)) {
            atCopy._raw = self.RumExportWhitelist.filterArray(atCopy._raw, siteConfigs);
          }
          ajaxTimings = atCopy;
        }

        resolve({
          ajaxTimings:  ajaxTimings,
          pcIdentifier: result.pcIdentifier || null
        });
      });
    });
  });
}

// ─── Основная функция экспорта 

async function exportAjaxDetailsCsv() {
  let data;
  try {
    data = await _aj_readStorage();
  } catch (e) {
    console.warn('[RUM] exportAjaxDetailsCsv: ошибка чтения storage:', e.message);
    return { ok: false, error: String(e) };
  }

  const ajax = data.ajaxTimings;
  if (!ajax || !Array.isArray(ajax._raw) || ajax._raw.length === 0) {
    return { ok: false, error: 'no ajax timing data' };
  }

  const pcName   = data.pcIdentifier?.pcName || 'none';
  const filename = _aj_buildFileName(pcName);

  const csvContent = _aj_buildRawRows(ajax._raw, _aj_sanitizePcName(pcName));

  let dataUrl;
  try {
    const BOM  = '\uFEFF';
    const full = BOM + csvContent;
    dataUrl = 'data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(full)));
  } catch (e) {
    console.warn('[RUM] exportAjaxDetailsCsv: ошибка кодирования:', e.message);
    return { ok: false, error: String(e) };
  }

  try {
    await _dl_download({ url: dataUrl, filename });
    return { ok: true };
  } catch (e) {
    console.warn('[RUM] exportAjaxDetailsCsv: ошибка chrome.downloads:', e.message);
    return { ok: false, error: chrome.runtime.lastError?.message || String(e) };
  }
}
