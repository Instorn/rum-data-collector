/**
 * downloadFile.js
 *
 * Сохранение файла выгрузки под нашим именем (compact fix-7).
 * Если в браузере есть другое расширение с chrome.downloads.onDeterminingFilename (Ui.Vision,
 * менеджеры загрузок), Chrome отбрасывает filename из chrome.downloads.download, и файл
 * сохраняется под именем по умолчанию («Без названия»). Документация chrome.downloads,
 * FilenameSuggestion: «filename is ignored if there are any onDeterminingFilename listeners
 * registered by any extensions».
 * Поэтому на время своей загрузки подключаем свой listener и сами предлагаем имя. Пока он
 * подключён, Chrome по той же причине отбрасывает filename у загрузок других расширений, —
 * поэтому listener живёт только до определения имени наших загрузок и ещё ~1 с, затем снимается.
 * Если чужое расширение предлагает имя всем загрузкам, побеждает установленное последним —
 * это ограничение Chrome.
 *
 * Загружается через importScripts в background.js, до модулей выгрузок.
 * На верхнем уровне только объявления.
 * Вызывается: _dl_download — из всех выгрузок (roleBundleExport.js, exportNavigationDetail.js,
 *   exportAjaxDetailsCsv.js, exportAnomaliesCsv.js, exportSettings.js).
 */

const _DL_PENDING_TTL_MS = 60000; // страховка: событие onDeterminingFilename не пришло
// Задержка снятия listener после последней нашей загрузки. suggest() и removeListener уходят в
// браузер разными путями; если снятие дойдёт первым, Chrome отклонит подсказку («Unchecked
// runtime.lastError: Unexpected determineFilename call») и имя потеряется.
const _DL_LISTENER_LINGER_MS = 1000;

// Наши загрузки, ждущие определения имени: { url, filename, timer }. Массив, а не Map:
// две одинаковые выгрузки подряд не затирают друг друга.
let _dlPending = [];
let _dlListenerOn = false;
let _dlRemoveTimer = null; // отложенное снятие listener

function _dl_setListener(on) {
  if (on === _dlListenerOn) return;
  const ev = chrome.downloads.onDeterminingFilename;
  if (on) ev.addListener(_dl_onDeterminingFilename);
  else ev.removeListener(_dl_onDeterminingFilename);
  _dlListenerOn = on;
}

// Снимает запись из очереди; при пустой очереди снимает listener через _DL_LISTENER_LINGER_MS.
function _dl_release(rec) {
  const i = _dlPending.indexOf(rec);
  if (i >= 0) _dlPending.splice(i, 1);
  clearTimeout(rec.timer);
  if (_dlPending.length === 0 && _dlListenerOn && _dlRemoveTimer === null) {
    _dlRemoveTimer = setTimeout(() => {
      _dlRemoveTimer = null;
      if (_dlPending.length === 0) _dl_setListener(false);
    }, _DL_LISTENER_LINGER_MS);
  }
}

// suggest вызывается синхронно и ровно один раз на каждой ветке (требование API).
function _dl_onDeterminingFilename(item, suggest) {
  if (!item || item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
  // Своя загрузка — по URL; если Chrome отдал URL в другом виде, а ждёт одна — она.
  let rec = _dlPending.find(r => r.url === item.url);
  if (!rec && _dlPending.length === 1) rec = _dlPending[0];
  if (!rec) { suggest(); return; }
  suggest({ filename: rec.filename, conflictAction: 'uniquify' });
  _dl_release(rec);
}

/**
 * chrome.downloads.download с нашим именем файла. Аргументы и результат — как у
 * chrome.downloads.download; ошибка пробрасывается без изменений.
 * filename по-прежнему передаётся в download(): без чужих listener'ов имя задаёт он.
 */
async function _dl_download({ url, filename }) {
  if (!chrome.downloads.onDeterminingFilename) {
    return chrome.downloads.download({ url, filename });
  }
  clearTimeout(_dlRemoveTimer); // новая загрузка в окне задержки — listener остаётся
  _dlRemoveTimer = null;
  const rec = { url, filename, timer: null };
  rec.timer = setTimeout(() => _dl_release(rec), _DL_PENDING_TTL_MS);
  _dlPending.push(rec);
  _dl_setListener(true);
  try {
    return await chrome.downloads.download({ url, filename });
  } catch (e) {
    _dl_release(rec);
    throw e;
  }
}
