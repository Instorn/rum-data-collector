/** services/export/exportDiagnosticsCsv.js
07: тренд длины очереди отправки на сервер.

Формат: 07-diagnostics_<pcName>_<YYYYMMDD>.csv
Одна строка — одна точка из chrome.storage.local['rumSendQueueTrend'] раз в 15 мин;
ведётся только при включённой отправке — в серверной сборке, историю отдаёт RumSend.getTrend()
(server_addon/services/send/sendService.js). compact fix-3: остальные колонки удалены вместе с
самодиагностикой.
Разделитель: ; (UTF-8 BOM добавляется на стороне bundle, как у остальных CSV).
Только числа/статусы/короткие строки — без URL, selector, текста кликов, DOM.

Автономный модуль — зависит только от глобального csvFormulaGuard (exportSanitize.js).
Подключается через importScripts в background.js рядом с export-модулями.

SOURCE_PATH: chrome-extension_v2/dev_extension/services/export/exportDiagnosticsCsv.js */

// ─── Утилиты ────────────────────────────────────────────────────────────────

function _diagcsv_sanitizePcName(pcName) {
  if (!pcName || typeof pcName !== 'string' || pcName.trim() === '') return 'none';
  return pcName.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function _diagcsv_buildFileName(pcName) {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `07-diagnostics_${_diagcsv_sanitizePcName(pcName)}_${dateStr}.csv`;
}

/** Экранирование значения для CSV-ячейки (разделитель ;, русский Excel) + formula guard */
function _diag_csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  }
  const s = String(v);
  const guarded = (typeof csvFormulaGuard === 'function') ? csvFormulaGuard(s) : s;
  if (guarded.includes(';') || guarded.includes('"') || guarded.includes('\n')) {
    return '"' + guarded.replace(/"/g, '""') + '"';
  }
  return guarded;
}

function _diag_csvRow(values) {
  return values.map(_diag_csvCell).join(';');
}

// Колонки v1 (ТЗ §15.2) — порядок фиксирован, downstream-парсеры на него опираются.
// compact fix-1: injected_size удалён (22 → 21).
// compact fix-3: 21 → 2 колонки.
const _DIAG_CSV_COLUMNS = ['ts', 'sendqueue_len'];

// ts храним как читаемый datetime в локальном времени (snapshot.ts — это epoch ms).
function _diag_formatTs(ts) {
  if (!ts || typeof ts !== 'number') return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Строит CSV-контент из истории periodic snapshots.
 * @param {Array<object>|object} snapshotOrHistory — массив snapshot'ов либо одиночный snapshot.
 * @param {string} [pcName]
 * @returns {{filename:string, csvContent:string}|{_err:string}}
 */
function _diag_buildCsvContentFromSnapshot(snapshotOrHistory, pcName) {
  let history;
  if (Array.isArray(snapshotOrHistory)) history = snapshotOrHistory;
  else if (snapshotOrHistory && typeof snapshotOrHistory === 'object') history = [snapshotOrHistory];
  else history = [];

  if (!history.length) return { _err: 'no_diagnostics_history' };

  const lines = [];
  lines.push(_DIAG_CSV_COLUMNS.join(';'));

  for (const snap of history) {
    if (!snap || typeof snap !== 'object') continue;
    const row = _DIAG_CSV_COLUMNS.map(col => {
      if (col === 'ts') return _diag_formatTs(snap.ts);
      return snap[col];
    });
    lines.push(_diag_csvRow(row));
  }

  if (lines.length <= 1) return { _err: 'no_diagnostics_history' };

  return {
    filename:   _diagcsv_buildFileName(pcName),
    csvContent: lines.join('\r\n'),
  };
}
