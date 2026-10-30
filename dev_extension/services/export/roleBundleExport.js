/**
 * roleBundleExport.js
 *
 * ZIP-архив «Все отчёты»: адаптер fflate, отчёт 99 о состоянии отправки
 * (_bg_buildSendDiagnosticsReport), сборка архива (buildReportsZip) и выгрузка архива вместе
 * с отдельным 04 JSON (runRoleBundleExport).
 * compact fix-5: перенесено из background.js без изменений.
 *
 * Загружается через importScripts в background.js.
 * На верхнем уровне только объявления функций, вызовов при загрузке нет.
 *
 * Читает глобалы background.js (только внутри функций): _bgDataReady, _bgPrepilotReady,
 *   _bgFlushPersistAsync, _bgBrowser, _bgTimezone.
 * Состояние отправки — из globalThis.RumSend (diag, getTrend); его определяет
 *   server_addon/services/send/sendService.js только в серверной сборке.
 * Из модулей выгрузок (загружаются раньше): _aj_buildCsvContentFromSnapshot,
 *   _diag_buildCsvContentFromSnapshot, _nd_resolveReportIdentity, _nd_buildCsvContent,
 *   _ndj_buildJsonContent; fflate — из lib/fflate.umd.js; сохранение файла — _dl_download
 *   (services/export/downloadFile.js, compact fix-7).
 * Вызывается: runRoleBundleExport — из _bg_msgExportRoleBundle (background.js) и runAutoExport
 *   (services/export/autoExportService.js).
 */

// ───  ZIP adapter  ─────────────


function _bg_getFflateZipLib() {
  const lib = (typeof globalThis !== 'undefined' && globalThis.fflate)
    || (typeof self !== 'undefined' && self.fflate)
    || (typeof fflate !== 'undefined' ? fflate : null);
  if (!lib || typeof lib.zipSync !== 'function') {
    throw new Error('[RUM] fflate.zipSync is not available — vendored lib/fflate.umd.js не загрузился');
  }
  return lib;
}

function _bg_validateZipEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('[RUM] ZIP entry name must be a non-empty string');
  }
  if (name.indexOf('\0') !== -1) {
    throw new Error('[RUM] ZIP entry name contains NUL byte');
  }
  if (name.indexOf('\\') !== -1) {
    throw new Error('[RUM] ZIP entry name contains backslash: ' + name);
  }
  if (name.charAt(0) === '/' || /^[A-Za-z]:[\/\\]/.test(name)) {
    throw new Error('[RUM] ZIP entry name must be relative: ' + name);
  }
  const segments = name.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') {
      throw new Error('[RUM] ZIP entry name path traversal: ' + name);
    }
  }
  return name;
}

function _bg_normalizeZipEntryData(data) {
  if (data instanceof Uint8Array) return data;
  throw new Error('[RUM] ZIP entry data must be Uint8Array');
}

// ─────────────────────────────────────────────────────────────────────────────
// 99-diagnostics.json: состояние отправки на сервер (compact fix-3, остальные секции удалены)
// ─────────────────────────────────────────────────────────────────────────────

// Синхронно: RumSend.diag() — снимок из памяти SW, гидрации не ждёт. В обычной сборке
// RumSend нет: sendModule 'absent', отправка выключена, очередь пуста.
// Флаги и рекомендации — только 4 кода отправки; условия, пороги и тексты — из
// diagnosticsService.js 1.16.0.
function _bg_buildSendDiagnosticsReport() {
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const report = {
    generatedAt: new Date().toISOString(),
    diagnosticSchemaVersion: 3,
    extension: {}, sendQueue: {}, riskFlags: [], recommendations: [],
  };

  // ── extension ──
  try {
    const mf = chrome.runtime.getManifest();
    report.extension = {
      name: mf.name, version: mf.version, versionName: mf.version_name || null,
      manifestVersion: mf.manifest_version,
      extensionId: chrome.runtime.id || null,
    };
  } catch (e) { report.extension = { available: false, error: String(e && e.message) }; }

  // ── sendQueue ──
  const snd = globalThis.RumSend ? globalThis.RumSend.diag() : null;
  const events = snd ? snd.events : [];
  const now = Date.now();
  const tsOf = (ev) => (ev && typeof ev.timestamp === 'number') ? ev.timestamp : null;
  let oldest = null, newest = null;
  for (const ev of events) {
    const t = tsOf(ev);
    if (t != null) { if (oldest == null || t < oldest) oldest = t; if (newest == null || t > newest) newest = t; }
  }
  let approxBytes = 0;
  try { approxBytes = JSON.stringify(events).length; } catch (e) { approxBytes = 0; }
  const sq = report.sendQueue = {
    sendModule:     snd ? 'included' : 'absent', // серверная или обычная сборка
    sendingEnabled: snd ? snd.enabled : false,   // отличает «отправка выключена» от «отправлять нечего»
    queueLength:    events.length,
    approxBytes,
    oldestEventAgeMs: oldest != null ? now - oldest : null,
    newestEventAgeMs: newest != null ? now - newest : null,
    lastFlushAt:    snd ? snd.lastFlushAt : null,
    lastFlushOk:    snd ? snd.lastFlushOk : null,
    lastFlushStatus:snd ? snd.lastFlushStatus : null,
    lastFlushError: snd ? snd.lastFlushError : null,
    flushCountSinceStartup:       snd ? snd.flushCount : 0,
    failedFlushCountSinceStartup: snd ? snd.failedFlushCount : 0,
    droppedByCapSinceStartup:     snd ? snd.droppedByCap : 0,
  };

  // ── risk flags ──
  const flags = report.riskFlags;
  const add = (code, severity, message, value, threshold) =>
    flags.push({ code, severity, message, value, threshold });
  const MB = 1024 * 1024;
  const sqLen = num(sq.queueLength) || 0;
  if (sqLen > 500)      add('SEND_QUEUE_GROWING', 'critical', 'sendQueue больше 500 событий', sqLen, 500);
  else if (sqLen > 100) add('SEND_QUEUE_GROWING', 'warning',  'sendQueue больше 100 событий', sqLen, 100);
  const sqBytes = num(sq.approxBytes) || 0;
  if (sqBytes > 5 * MB)      add('SEND_QUEUE_LARGE_BYTES', 'critical', 'sendQueue больше 5 MB', sqBytes, 5 * MB);
  else if (sqBytes > 1 * MB) add('SEND_QUEUE_LARGE_BYTES', 'warning',  'sendQueue больше 1 MB', sqBytes, 1 * MB);
  if (sq.lastFlushOk === false && (num(sq.failedFlushCountSinceStartup) || 0) > 0) {
    add('SERVER_UNAVAILABLE', 'warning', 'Последний flush sendQueue не удался', sq.lastFlushStatus || sq.lastFlushError || 'error', null);
  }
  const oldestAge = num(sq.oldestEventAgeMs);
  if (oldestAge != null && oldestAge > 30 * 60 * 1000 && sqLen > 0) {
    add('SEND_QUEUE_OLD_EVENTS', 'warning', 'В sendQueue есть события старше 30 минут', oldestAge, 30 * 60 * 1000);
  }
  // critical → warning, стабильно по порядку добавления
  const rank = { critical: 0, warning: 1 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // ── recommendations: по одной на код ──
  const REC = {
    SEND_QUEUE_GROWING:     'Проверить доступность сервера и ограничить sendQueue; при отключённой отправке очередь не должна расти.',
    SEND_QUEUE_OLD_EVENTS:  'В очереди давно лежат события. Проверить flush и доступность endpoint.',
    SERVER_UNAVAILABLE:     'Сервер приёма недоступен. Проверить URL/доступность; при пилоте отправка должна быть отключена.',
    SEND_QUEUE_LARGE_BYTES: 'sendQueue занимает много памяти. Ужесточить cap очереди.',
  };
  const seen = new Set();
  for (const f of flags) {
    if (seen.has(f.code)) continue;
    seen.add(f.code);
    report.recommendations.push({ code: f.code, severity: f.severity, recommendation: REC[f.code] });
  }
  return report;
}

function buildReportsZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('[RUM] buildReportsZip: entries must be a non-empty array');
  }
  const lib = _bg_getFflateZipLib();
  const files = {};
  for (const entry of entries) {
    const name = _bg_validateZipEntryName(entry && entry.name);
    files[name] = _bg_normalizeZipEntryData(entry && entry.data);
  }
  // level: 0 — STORE/no compression, сохраняет поведение previous local ZIP builder.
  return lib.zipSync(files, { level: 0 });
}

// бандл-экспорт отчётов в один ZIP-архив.
// Вызывается из message-handler EXPORT_ROLE_BUNDLE_CSV и из autoExportService.js.
async function runRoleBundleExport(opts = {}) {
  // ждём initial restore. Без этого другие handler'ы могли затереть storage пустышкой
  // до того, как localData.aggregatedRumData будет прочитан ниже.
  await _bgDataReady;
  // На холодном старте ждём загрузки settings.json.
  try { await _bgPrepilotReady; } catch (_) {}

  // fix-9: storage обязан догнать память до чтения localData ниже — иначе
  // throttle-планировщик молча теряет хвост ≤10 с (клики, ajax) из выгрузки.
  await _bgFlushPersistAsync();

  const enc = new TextEncoder();
  const BOM = '\uFEFF';

  const localData = await new Promise(res => chrome.storage.local.get(null, res));
  const managedData = await new Promise(res => {
    try {
      if (chrome.storage && chrome.storage.managed) {
        chrome.storage.managed.get(null, r => res(chrome.runtime.lastError ? {} : (r || {})));
      } else {
        res({});
      }
    } catch { res({}); }
  });

  // ff-14.14: registry-only identity для 04-отчётов (pc_cpu/rum).
  // Берётся строго из managedData (GPO/реестр), НЕ из globalSettings/fileBasedSettings:
  // при useSettingsFile globalSettings может быть file-based. Нестроковое значение → ''.
  // fix-16: тот же resolver, что у отдельной выгрузки 04, — плюс organization/location/
  // commit1/commit2 из активного источника настроек (settings.json или реестр).
  const _report04Identity = (typeof _nd_resolveReportIdentity === 'function')
    ? _nd_resolveReportIdentity(managedData, localData.fileBasedSettings)
    : {
        customPcNameCpu: typeof managedData.customPCNameCpu === 'string' ? managedData.customPCNameCpu : '',
        customPcNameRum: typeof managedData.customPCNameRum === 'string' ? managedData.customPCNameRum : ''
      };

  // Единый snapshot — используется всеми builder-функциями bundle
  // fix-9 Этап 2: localData прочитан через get(null) и после разноса не содержит
  // тяжёлых секций в блобе — склеиваем их из отдельных ключей rumActionClicks/rumAjaxRaw.
  const raw = (typeof mergeAggregatedFromLocalData === 'function')
    ? mergeAggregatedFromLocalData(localData)
    : (localData.aggregatedRumData || {});
  const snapshot = {
    aggregatedMetrics:  (raw.aggregatedMetrics  || []).slice(-2000),
    actionClicks:       (raw.actionClicks       || []).slice(-2000),
    webVitals:          (raw.webVitals           || []).slice(-2000),
    freezeEvents:       (raw.freezeEvents        || []).slice(-2000),
    blankPageEvents:    (raw.blankPageEvents     || []).slice(-2000),
    anomalies:          (raw.anomalies           || []).slice(-2000),
    ajaxTimings:            raw.ajaxTimings                    || null,
    pcIdentifier:           localData.pcIdentifier             || null,
    fileBasedSettings:      localData.fileBasedSettings        || null,
    rumSessionId:           localData.rumSessionId             || '',
    sessionStartTs:         localData.SESSION_START_TS         || Date.now(),
  };

  // siteConfigs и пороги 04 — из активного источника, тем же правилом, что сбор и отдельная
  // выгрузка 04 (compact fix-8): settings.json, если его выбирает prepilot (useSettingsFile или
  // пустой реестр), иначе только реестр. Копия fileBasedSettings при старте SW с реестром не удаляется.
  const _useFile = typeof shouldUseSettingsFile === 'function'
    ? shouldUseSettingsFile(managedData)
    : Object.keys(managedData).length === 0;
  const _settingsSrc = (_useFile ? snapshot.fileBasedSettings : managedData) || {};
  let siteConfigs      = self.RumSiteMatch && RumSiteMatch.parseSiteConfigs
    ? RumSiteMatch.parseSiteConfigs(_settingsSrc) : null;
  const globalThresholds = _settingsSrc.executiveSummaryThresholds || null;

  siteConfigs = siteConfigs || [];

  // Очищаем pcName для использования в имени файла
  function _safePcName(pcIdentifier) {
    const name = pcIdentifier?.pcName || 'none';
    return name.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
  }

  // Текущая дата для имён файлов
  const _d   = new Date();
  const _pad = n => String(n).padStart(2, '0');
  const _dateStr = `${_d.getFullYear()}${_pad(_d.getMonth() + 1)}${_pad(_d.getDate())}`;
  // и ручная кнопка, и авто-выгрузка теперь несут HHmm в имени архива
  const _timeStr = `${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
  const _pcSafe  = _safePcName(snapshot.pcIdentifier);

  // ── Собираем записи для ZIP ──────────────────────────────────────────
  // Состав bundle: 04 CSV, 04 JSON, 05, 99 (состояние отправки на сервер) и 07 (тренд
  // очереди, при включённой отправке).
  // fix-21: отчёты 01/02/03 удалены из расширения.
  const zipEntries = []; // { name: string, data: Uint8Array }

  // 04 Navigation Detail CSV
  const built04csv = typeof _nd_buildCsvContent === 'function'
    ? _nd_buildCsvContent(snapshot, siteConfigs, globalThresholds, _bgBrowser, _bgTimezone, _report04Identity) : null;
  if (built04csv && !built04csv._err) {
    zipEntries.push({ name: built04csv.filename, data: enc.encode(BOM + built04csv.csvContent) });
  }

  // 04 Navigation Detail JSON
  let _standalone04Bytes = null;
  const built04json = typeof _ndj_buildJsonContent === 'function'
    ? _ndj_buildJsonContent(snapshot, siteConfigs, globalThresholds, _bgBrowser, _bgTimezone, _report04Identity) : null;
  if (built04json && !built04json._err) {
    try {
      const jsonStr  = JSON.stringify(built04json.report, null, 2);
      const bytes04  = enc.encode(jsonStr);
      const fn04json = `04-navigation-detail_${_pcSafe}_${_dateStr}.json`;
      zipEntries.push({ name: fn04json, data: bytes04 });
      _standalone04Bytes = bytes04;
    } catch (e) {
      console.warn('[RUM] bundle 04 json encode error:', e.message);
    }
  }

  // 05 AJAX Details CSV (fix-6)
  const built05 = typeof _aj_buildCsvContentFromSnapshot === 'function'
    ? _aj_buildCsvContentFromSnapshot(snapshot) : null;
  if (built05 && !built05._err) {
    zipEntries.push({ name: built05.filename, data: enc.encode(BOM + built05.csvContent) });
  }

  // Без данных 04/05 архив не создаётся — ни вручную, ни по расписанию (compact fix-3).
  if (zipEntries.length === 0) {
    return { success: false, error: _t('errBundleNoData') };
  }

  // 99: состояние отправки на сервер (compact fix-3, Р12). Без BOM, UTF-8.
  // Ошибка сборки 99 не ломает остальной bundle.
  try {
    zipEntries.push({ name: '99-diagnostics.json', data: enc.encode(JSON.stringify(_bg_buildSendDiagnosticsReport(), null, 2)) });
  } catch (e) {
    console.warn('[RUM] bundle 99 error:', e && e.message);
  }

  // 07: тренд длины очереди отправки (Р16) — при непустой истории.
  try {
    const trend = globalThis.RumSend ? await globalThis.RumSend.getTrend() : [];
    const built07 = _diag_buildCsvContentFromSnapshot(trend, _pcSafe);
    if (built07 && !built07._err) {
      zipEntries.push({ name: built07.filename, data: enc.encode(BOM + built07.csvContent) });
    }
  } catch (e) {
    console.warn('[RUM] bundle 07 diagnostics csv error:', e && e.message);
  }

  // ── Собираем ZIP ─────────────────────────────────────────────────────
  const zipBytes = buildReportsZip(zipEntries);

  let binary = '';
  for (let i = 0; i < zipBytes.length; i++) {
    binary += String.fromCharCode(zipBytes[i]);
  }
  const zipBase64 = btoa(binary);
  // имя единое для ручной кнопки и авто-выгрузки,
  // всегда включает HHmm чтобы несколько выгрузок в сутки не перезаписывали друг друга.
  // opts.timeSuffix оставлен для обратной совместимости 
  const _timeSfx  = (opts && typeof opts.timeSuffix === 'string' && opts.timeSuffix)
    ? opts.timeSuffix : _timeStr;
  const zipName   = `rum-reports-bundle_${_pcSafe}_${_dateStr}_${_timeSfx}.zip`;

  await _dl_download({
    url:      'data:application/zip;base64,' + zipBase64,
    filename: zipName,
  });

  const _wantStandalone04 = !!(opts && opts.downloadStandalone04Json === true);
  if (!_wantStandalone04) {
    return { success: true, downloaded: zipEntries.length, zipName, zipDownloaded: true };
  }

  if (!_standalone04Bytes) {
    console.warn('[RUM] standalone 04 json запрошен, но report не построен — выгрузка неполна');
    return {
      success: false,
      error: 'standalone 04 json: report не построен',
      downloaded: zipEntries.length,
      zipName,
      zipDownloaded: true,
      standalone04: { success: false, error: 'report not built' },
    };
  }

  const fnStandalone04 = `04-navigation-detail_${_pcSafe}_${_dateStr}_${_timeSfx}.json`;
  try {
    let bin04 = '';
    for (let i = 0; i < _standalone04Bytes.length; i++) {
      bin04 += String.fromCharCode(_standalone04Bytes[i]);
    }
    const base64_04 = btoa(bin04);
    await _dl_download({
      url:      'data:application/json;base64,' + base64_04,
      filename: fnStandalone04,
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.warn('[RUM] standalone 04 json download failed:', msg);
    return {
      success: false,
      error: 'standalone 04 json download failed: ' + msg,
      downloaded: zipEntries.length,
      zipName,
      zipDownloaded: true,
      standalone04: { success: false, error: msg },
    };
  }

  return {
    success: true,
    downloaded: zipEntries.length,
    zipName,
    zipDownloaded: true,
    standalone04: { success: true, filename: fnStandalone04 },
  };
}
