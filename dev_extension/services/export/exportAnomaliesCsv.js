/** services/export/exportAnomaliesCsv.js
CSV-экспорт аномалий: зависания страниц (freeze), пустые страницы (blank-page),
и координатные аномалии COORD_ANOMALY .
Выделен из exportRumDetailsCsv.js согласно.
Автономный модуль — не зависит от других export-модулей.
Подключается через importScripts в background.js.
Имя файла: {pc}_{YYYY-MM-DD}_anomalies.csv */

// ─── Утилиты 

function _an_sanitizePcName(pcName) {
  if (!pcName || typeof pcName !== 'string' || pcName.trim() === '') return 'none';
  return pcName.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function _an_buildFileName(pcName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return `${_an_sanitizePcName(pcName)}_${dateStr}_anomalies.csv`;
}

// Формат YYYY-MM-DD HH:mm:ss в локальном времени
function _an_formatDatetime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// CSV-escaping: числа — десятичная запятая (русский Excel); строки — кавычки если содержит ; " \n \r
// добавлен formula guard против Excel injection для строковых значений
function _an_csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
  }
  const str = String(value);
  // нейтрализуем Excel formula injection для строковых значений
  const guarded = (typeof csvFormulaGuard === 'function') ? csvFormulaGuard(str) : str;
  if (guarded.includes(';') || guarded.includes('"') || guarded.includes('\n') || guarded.includes('\r')) {
    return '"' + guarded.replace(/"/g, '""') + '"';
  }
  return guarded;
}

function _an_csvRow(fields) {
  return fields.map(_an_csvEscape).join(';');
}

// Извлекает hostname из URL, fallback 'unknown'
function _an_extractDomain(url) {
  if (!url) return 'unknown';
  try {
    return new URL(url).hostname || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// Имя ПК из storage-ключа pcIdentifier
function _an_pcId(pcIdentifier) {
  if (!pcIdentifier) return '';
  if (typeof pcIdentifier === 'string') return pcIdentifier;
  return pcIdentifier.pcName || '';
}

// ─── Утилиты парсинг detail координатной аномалии 

/**
 * Разбирает строку detail вида "X.Y|X'.Y'|type:rule|url".
 * URL может содержать символы |, поэтому всё после третьего | считается URL.
 */
function _an_parseAnomalyDetail(detail) {
  if (!detail || typeof detail !== 'string') {
    return { oldCoord: '', newCoord: '', rule: '', url: '' };
  }
  const parts = detail.split('|');
  return {
    oldCoord: parts[0] || '',
    newCoord: parts[1] || '',
    rule:     parts[2] || '',
    url:      parts.slice(3).join('|') || ''
  };
}

// ─── Чтение данных из storage 

function _an_readStorage() {
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

        let freezeEvents    = (raw.freezeEvents    || []).slice(-1000);
        let blankPageEvents = (raw.blankPageEvents || []).slice(-1000);
        let coordAnomalies  = (raw.anomalies       || []).filter(a => a.type === 'COORD_ANOMALY').slice(-1000);

        if (typeof self !== 'undefined' && self.RumExportWhitelist) {
          freezeEvents    = self.RumExportWhitelist.filterArray(freezeEvents,    siteConfigs);
          blankPageEvents = self.RumExportWhitelist.filterArray(blankPageEvents, siteConfigs);
          coordAnomalies  = self.RumExportWhitelist.filterArray(coordAnomalies,  siteConfigs);
        }

        resolve({
          freezeEvents:    freezeEvents,
          blankPageEvents: blankPageEvents,
          coordAnomalies:  coordAnomalies,
          pcIdentifier:    result.pcIdentifier || null
        });
      });
    });
  });
}

// ─── Построение строк 

// Заголовок: общие колонки + freeze-specific + blank-page-specific + coord_anomaly-specific.
// compact fix-1: колонка счётчика JS-ошибок у blank-page и блок трекера JS-ошибок удалены (24 → 19).
const _AN_HEADER = [
  'section', 'domain', 'url', 'pcIdentifier',
  // freeze
  'last_heartbeat_ts', 'detected_at', 'silence_duration_ms', 'last_beats', 'long_tasks_active',
  // blank-page
  'event_type', 'timestamp', 'ttfb', 'long_task_ratio', 'session_duration_ms', 'time_on_page_ms',
  // coord_anomaly 
  'old_coord', 'new_coord', 'anomaly_rule', 'anomaly_tab_id'
];

/**
 * Строки section='freeze': зависания вкладок по heartbeat timeout.
 * @param {Object[]} freezeEvents
 * @param {string} pcIdentifierStr
 * @returns {string[][]}
 */
function _an_buildFreezeRows(freezeEvents, pcIdentifierStr) {
  return freezeEvents.map(ev => {
    // повторная санитизация URL при экспорте
    const _safeUrl = (typeof exportSafeUrl === 'function') ? exportSafeUrl(ev.url) : (ev.url || '');
    return [
      'freeze',
      _an_extractDomain(_safeUrl),
      _safeUrl,
      pcIdentifierStr,
      // freeze-specific
      _an_formatDatetime(ev.lastHeartbeatTs),
      _an_formatDatetime(ev.detectedAt),
      ev.silenceDuration != null ? String(ev.silenceDuration) : '',
      ev.lastBeats       != null ? String(ev.lastBeats)       : '',
      ev.lastLongTasksActive != null ? String(ev.lastLongTasksActive) : '',
      // blank-page-specific (пусто)
      '', '', '', '', '', '',
      // coord_anomaly-specific (пусто)
      '', '', '', ''
    ];
  });
}

/**
 * Строки section='blank-page': пустые страницы (LCP timeout или abandoned).
 * @param {Object[]} blankPageEvents
 * @param {string} pcIdentifierStr
 * @returns {string[][]}
 */
function _an_buildBlankRows(blankPageEvents, pcIdentifierStr) {
  return blankPageEvents.map(ev => {
    const isDetected = ev.eventType === 'BLANK_PAGE_DETECTED';
    // повторная санитизация URL при экспорте
    const _safeUrl = (typeof exportSafeUrl === 'function') ? exportSafeUrl(ev.url) : (ev.url || '');
    return [
      'blank-page',
      _an_extractDomain(_safeUrl),
      _safeUrl,
      pcIdentifierStr,
      // freeze-specific (пусто)
      '', '', '', '', '',
      // blank-page-specific
      ev.eventType || '',
      _an_formatDatetime(ev.timestamp),
      ev.ttfb       != null ? String(ev.ttfb)       : '',
      isDetected && ev.longTaskRatio   != null ? String(ev.longTaskRatio)   : '',
      isDetected && ev.sessionDuration != null ? String(ev.sessionDuration) : '',
      !isDetected && ev.timeOnPage     != null ? String(ev.timeOnPage)      : '',
      // coord_anomaly-specific (пусто) 
      '', '', '', ''
    ];
  });
}

/**
 * Строки section='coord_anomaly': координатные аномалии из _bg_recordAnomaly.
 * @param {Object[]} coordAnomalies - массив записей {type, tabId, url, timestamp, detail}
 * @param {string} pcIdentifierStr
 * @returns {string[][]}
 */
function _an_buildCoordAnomalyRows(coordAnomalies, pcIdentifierStr) {
  return coordAnomalies.map(ev => {
    const parsed = _an_parseAnomalyDetail(ev.detail);
    // повторная санитизация URL при экспорте
    const _safeUrl = (typeof exportSafeUrl === 'function') ? exportSafeUrl(ev.url || parsed.url) : (ev.url || parsed.url || '');
    const domain = _an_extractDomain(_safeUrl);
    return [
      'coord_anomaly',
      domain,
      _safeUrl,
      pcIdentifierStr,
      // freeze-specific (пусто)
      '', '', '', '', '',
      // blank-page-specific (пусто)
      'COORD_ANOMALY',
      _an_formatDatetime(ev.timestamp),
      '', '', '', '',
      // coord_anomaly-specific
      parsed.oldCoord,
      parsed.newCoord,
      parsed.rule,
      ev.tabId != null ? String(ev.tabId) : ''
    ];
  });
}

// ─── Публичная функция 

/**
 * Генерирует и скачивает CSV с секциями: freeze, blank-page, coord_anomaly.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function exportAnomaliesCsv() {
  let data;
  try {
    data = await _an_readStorage();
  } catch (e) {
    console.warn('[RUM] exportAnomaliesCsv: ошибка чтения storage:', e.message);
    return { ok: false, error: String(e) };
  }

  if (data.freezeEvents.length === 0 && data.blankPageEvents.length === 0 &&
      data.coordAnomalies.length === 0) {
    return { ok: false, error: _t('errNoAnomalies') };
  }

  const pcIdentifierStr = _an_pcId(data.pcIdentifier);
  const freezeRows      = _an_buildFreezeRows(data.freezeEvents, pcIdentifierStr);
  const blankRows       = _an_buildBlankRows(data.blankPageEvents, pcIdentifierStr);
  const coordRows       = _an_buildCoordAnomalyRows(data.coordAnomalies, pcIdentifierStr);

  const allRows = [
    _an_csvRow(_AN_HEADER),
    ...freezeRows.map(_an_csvRow),
    ...blankRows.map(_an_csvRow),
    ...coordRows.map(_an_csvRow)
  ];

  const csvContent = allRows.join('\r\n');
  const filename   = _an_buildFileName(data.pcIdentifier?.pcName);

  // UTF-8 BOM + base64
  let dataUrl;
  try {
    const BOM = '\uFEFF';
    const full = BOM + csvContent;
    dataUrl = 'data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(full)));
  } catch (e) {
    console.warn('[RUM] exportAnomaliesCsv: ошибка кодирования:', e.message);
    return { ok: false, error: String(e) };
  }

  try {
    await _dl_download({ url: dataUrl, filename });
    return { ok: true };
  } catch (e) {
    console.warn('[RUM] exportAnomaliesCsv: ошибка chrome.downloads:', e.message);
    return { ok: false, error: chrome.runtime.lastError?.message || String(e) };
  }
}
