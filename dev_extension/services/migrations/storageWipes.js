/**
 * storageWipes.js
 *
 * Одноразовые очистки хранилища при обновлении: Web Vitals (смена методики), compact fix-1
 * (данные удалённых discovery и трекера ошибок), compact fix-2 (текст клика и тип кнопки),
 * compact fix-3 (отпечаток ПК, Performance Monitor, история диагностики). Каждая ставит свой
 * маркер в chrome.storage.local и выполняется один раз.
 * compact fix-5: четыре очистки перенесены из background.js без изменений; добавлена
 * _bg_runStorageWipes() — общий список вызовов для onInstalled и старта SW.
 *
 * Загружается через importScripts в background.js.
 * На верхнем уровне только объявления: при importScripts let/const background.js ещё
 * не инициализированы. Вызовы _bg_runStorageWipes() остаются в background.js.
 *
 * Читает глобалы background.js (только внутри функций): _bgDataReady,
 *   _bg_applyAggregatedMigrationGuards, aggregatedData, RUM_STORAGE_KEY_CORE,
 *   RUM_STORAGE_KEY_CLICKS, _rumCoreView.
 * Из services/export/exportAnomaliesCsv.js (загружается раньше) — _an_parseAnomalyDetail.
 * Вызывается из background.js: _bg_runStorageWipes() — в onInstalled (install/update) и при
 *   старте SW.
 */

// Одноразовая очистка накопленных Web Vitals при апгрейде  
//
// Защита от restore race: helper ОБЯЗАН ждать _bgDataReady. Никакого второго
// независимого chrome.storage.local.get('aggregatedRumData') + set() поверх
// ещё не гидратированного aggregatedData.
//
// Marker rumWebVitalsWipeVersion = '2' — при будущих methodology-breaking
// миграциях поднять до '3', и одноразовая очистка повторится.
let _bgWebVitalsWipeStarted = false;
async function ensureWebVitalsMethodologyWipe() {
  if (_bgWebVitalsWipeStarted) return;
  _bgWebVitalsWipeStarted = true;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('rumWebVitalsWipeVersion', (r) => {
        resolve(chrome.runtime.lastError ? {} : (r || {}));
      });
    });
    if (stored.rumWebVitalsWipeVersion === '2') return; // уже выполнено
    // Дожидаемся initial restore + migration guards (включая webVitals = webVitals || []).
    await _bgDataReady;
    _bg_applyAggregatedMigrationGuards(aggregatedData);
    aggregatedData.webVitals = [];
    // fix-6: сознательное исключение из _bgPersistAggregatedData — one-time
    // methodology wipe, требует собственного await-resolve, не runtime persist.
    // fix-9 Этап 2: webVitals — core-секция, пишем только core-ключ через
    // _rumCoreView(); тяжёлые ключи (clicks/ajaxRaw) не трогаем.
    await new Promise((resolve) => {
      chrome.storage.local.set({ [RUM_STORAGE_KEY_CORE]: _rumCoreView() }, () => resolve());
    });
    await new Promise((resolve) => {
      chrome.storage.local.set({ rumWebVitalsWipeVersion: '2' }, () => resolve());
    });
    console.log('[RUM] webVitals[] вычищен (one-time methodology wipe v2)');
  } catch (e) {
    console.warn('[RUM] ensureWebVitalsMethodologyWipe error:', e && e.message);
  }
}

// compact fix-1: одноразовая очистка данных удалённых discovery и трекера ошибок.
//
// По образцу ensureWebVitalsMethodologyWipe(): ждёт _bgDataReady и пишет core-ключ
// из памяти. Секции clickStats/discoveredNavSelectors/jsErrors снимают guards;
// здесь дополнительно убираются аномалии z_overflow (их писал только удалённый
// handleClickStats) и ключ discoveryConfig. Маркер ставится последним: при сбое
// записи очистка повторится на следующем старте SW.
let _bgCompactWipeStarted = false;
async function ensureCompactDataWipe() {
  if (_bgCompactWipeStarted) return;
  _bgCompactWipeStarted = true;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('rumCompactWipeVersion', (r) => {
        resolve(chrome.runtime.lastError ? {} : (r || {}));
      });
    });
    if (stored.rumCompactWipeVersion === '1') return; // уже выполнено
    await _bgDataReady;
    _bg_applyAggregatedMigrationGuards(aggregatedData);
    // detail: "X.Y|X'.Y'|rule|url"; z_overflow — точное значение правила,
    // у остальных COORD_ANOMALY оно вида y_jump:<rule> / x_overflow:<rule>.
    aggregatedData.anomalies = aggregatedData.anomalies.filter(a =>
      !(a && a.type === 'COORD_ANOMALY' && _an_parseAnomalyDetail(a.detail).rule === 'z_overflow'));
    // Сознательное исключение из _bgPersistAggregatedData, как в
    // ensureWebVitalsMethodologyWipe(): пишем только core-ключ, тяжёлые ключи не трогаем.
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [RUM_STORAGE_KEY_CORE]: _rumCoreView() }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      chrome.storage.local.remove('discoveryConfig', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    await new Promise((resolve) => {
      chrome.storage.local.set({ rumCompactWipeVersion: '1' }, () => resolve());
    });
    console.log('[RUM] данные discovery и трекера ошибок вычищены (compact fix-1)');
  } catch (e) {
    console.warn('[RUM] ensureCompactDataWipe error:', e && e.message);
  }
}

// compact fix-2: одноразовая очистка текста клика и типа кнопки.
//
// По образцу ensureCompactDataWipe(): ждёт _bgDataReady и снимает clickText/buttonType
// с записей actionClicks и с navTimings в aggregatedMetrics[].customTimings.navTransition.rawEvents.
// Core-ключ и actionClicks пишутся одной записью. Маркер ставится последним: при сбое
// записи очистка повторится на следующем старте SW.
let _bgClickTextWipeStarted = false;
async function ensureClickTextWipe() {
  if (_bgClickTextWipeStarted) return;
  _bgClickTextWipeStarted = true;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('rumClickTextWipeVersion', (r) => {
        resolve(chrome.runtime.lastError ? {} : (r || {}));
      });
    });
    if (stored.rumClickTextWipeVersion === '1') return; // уже выполнено
    await _bgDataReady;
    _bg_applyAggregatedMigrationGuards(aggregatedData);
    const strip = (rec) => {
      if (rec && typeof rec === 'object') { delete rec.clickText; delete rec.buttonType; }
    };
    if (Array.isArray(aggregatedData.actionClicks)) aggregatedData.actionClicks.forEach(strip);
    if (Array.isArray(aggregatedData.aggregatedMetrics)) {
      for (const m of aggregatedData.aggregatedMetrics) {
        const nav = m && m.customTimings && m.customTimings.navTransition;
        if (nav && Array.isArray(nav.rawEvents)) nav.rawEvents.forEach(strip);
      }
    }
    // Сознательное исключение из _bgPersistAggregatedData, как в ensureCompactDataWipe():
    // core-ключ и actionClicks — одной записью, rumAjaxRaw не трогаем.
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({
        [RUM_STORAGE_KEY_CORE]:   _rumCoreView(),
        [RUM_STORAGE_KEY_CLICKS]: aggregatedData.actionClicks,
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    await new Promise((resolve) => {
      chrome.storage.local.set({ rumClickTextWipeVersion: '1' }, () => resolve());
    });
    console.log('[RUM] текст клика и тип кнопки вычищены (compact fix-2)');
  } catch (e) {
    console.warn('[RUM] ensureClickTextWipe error:', e && e.message);
  }
}

// compact fix-3: одноразовая очистка следов удалённых функций (Р11).
//
// По образцу ensureClickTextWipe(): ждёт _bgDataReady и снимает отпечаток ПК (pcIdentifier) с записей
// webVitals/aggregatedMetrics/freezeEvents/blankPageEvents; секцию performanceMetrics (сырые URL)
// снимают guards. Core-ключ пишется одной записью, rumActionClicks и rumAjaxRaw не трогаем. Затем ключ
// pcIdentifier сводится к { pcName, generatedAt }, удаляются история и счётчики самодиагностики и
// снимается её alarm. Маркер ставится последним: при сбое очистка повторится на следующем старте SW.
let _bgCompact3WipeStarted = false;
async function ensureCompact3Wipe() {
  if (_bgCompact3WipeStarted) return;
  _bgCompact3WipeStarted = true;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('rumCompact3WipeVersion', (r) => {
        resolve(chrome.runtime.lastError ? {} : (r || {}));
      });
    });
    if (stored.rumCompact3WipeVersion === '1') return; // уже выполнено
    await _bgDataReady;
    _bg_applyAggregatedMigrationGuards(aggregatedData);
    for (const section of ['webVitals', 'aggregatedMetrics', 'freezeEvents', 'blankPageEvents']) {
      if (!Array.isArray(aggregatedData[section])) continue;
      for (const rec of aggregatedData[section]) {
        if (rec && typeof rec === 'object') delete rec.pcIdentifier;
      }
    }
    // Сознательное исключение из _bgPersistAggregatedData, как в ensureCompactDataWipe():
    // пишем только core-ключ, тяжёлые ключи не трогаем.
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [RUM_STORAGE_KEY_CORE]: _rumCoreView() }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    // Ключ pcIdentifier читаем после _bgDataReady: UUID от _bg_getPcIdentifier к этому времени уже
    // записан. Объект с именем → { pcName, generatedAt }; объект без имени → удалить (UUID создаст
    // _bg_getPcIdentifier на следующем старте SW); строку (формат до 1.14) не трогаем.
    const pid = await new Promise((resolve, reject) => {
      chrome.storage.local.get('pcIdentifier', (r) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r && r.pcIdentifier);
      });
    });
    if (pid && typeof pid === 'object') {
      await new Promise((resolve, reject) => {
        const done = () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        };
        if (typeof pid.pcName === 'string' && pid.pcName) {
          chrome.storage.local.set({ pcIdentifier: { pcName: pid.pcName, generatedAt: pid.generatedAt || null } }, done);
        } else {
          chrome.storage.local.remove('pcIdentifier', done);
        }
      });
    }
    await new Promise((resolve, reject) => {
      chrome.storage.local.remove(['rumDiagnostics', 'rumDiagCounters', 'rumDiagPing'], () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    // session-хранилище браузер и так очищает при обновлении расширения: его ошибка маркеру не мешает.
    if (chrome.storage.session) {
      await new Promise((resolve) => {
        chrome.storage.session.remove('rumDiagCounters', () => { void chrome.runtime.lastError; resolve(); });
      });
    }
    // Иначе alarm продолжит будить SW каждые 15 мин.
    await new Promise((resolve) => {
      chrome.alarms.clear('rumDiagnosticsSnapshot', () => { void chrome.runtime.lastError; resolve(); });
    });
    await new Promise((resolve) => {
      chrome.storage.local.set({ rumCompact3WipeVersion: '1' }, () => resolve());
    });
    console.log('[RUM] отпечаток ПК, Performance Monitor и история диагностики вычищены (compact fix-3)');
  } catch (e) {
    console.warn('[RUM] ensureCompact3Wipe error:', e && e.message);
  }
}

// compact fix-5: все одноразовые очистки по порядку. Каждая сама проверяет свой маркер
// и ждёт _bgDataReady, повторный вызов безопасен (флаг _bg…WipeStarted).
// Новая очистка добавляется сюда — и попадает и в onInstalled, и в старт SW.
function _bg_runStorageWipes() {
  ensureWebVitalsMethodologyWipe();
  ensureCompactDataWipe();   // compact fix-1: данные удалённых discovery и трекера ошибок
  ensureClickTextWipe();     // compact fix-2: текст клика и тип кнопки
  ensureCompact3Wipe();      // compact fix-3: отпечаток ПК, Performance Monitor, история диагностики
}
