/** services/export/exportSanitize.js
 Единый export-helper для повторной санитизации при выгрузке данных.

 Подключается через importScripts в background.js, ПОСЛЕ sanitizeText.js и ДО export-модулей.
 Все функции — глобальные (не ES-модуль), совместимы с SW и content-script окружением.

 Использование в export-модулях:
   exportSafeUrl(val)       — повторная санитизация URL (маска ID/GUID в path, лимит 2000 симв.)
   csvFormulaGuard(str)     — нейтрализация Excel formula injection для строковых CSV-ячеек */

// ─── Лимиты 

const _ES_MAX_URL  = 2000;

// Символы-триггеры Excel formula injection (строковые значения)
const _ES_FORMULA_CHARS = ['=', '+', '-', '@', '\t', '\r'];

// ─── Inline fallback-паттерны (применяются когда RumSanitize недоступен) 
// URL-path паттерны для fallback exportSafeUrl
const _ESF_GUID_P = [/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/[guid]'];
const _ESF_NUMID_P = [/\/\d{4,}/g,                                              '/[id]'];

/**
 * Минимальная inline-санитизация URL без RumSanitize.
 * Маскирует GUID и числовые ID в path-сегментах.
 *
 * @param {string} s
 * @returns {string}
 */
function _esFallbackUrl(s) {
  return s
    .replace(_ESF_GUID_P[0],  _ESF_GUID_P[1])
    .replace(_ESF_NUMID_P[0], _ESF_NUMID_P[1])
    .slice(0, _ES_MAX_URL);
}

// ─── Публичные helper

/**
 * Повторная санитизация URL-поля перед экспортом.
 * Применяет RumSanitize.pageUrl() без siteConfig (нет per-site контекста в SW)
 * — маскирует GUID и числовые ID в path с дефолтным порогом 4 цифры.
 * Обрезает по лимиту.
 *
 * @param {unknown} val
 * @returns {string}
 */
function exportSafeUrl(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (!s) return '';
  try {
    if (typeof RumSanitize !== 'undefined') {
      return RumSanitize.pageUrl(s).slice(0, _ES_MAX_URL);
    }
  } catch (_) { /* sanitizer недоступен — fallback */ }
  return _esFallbackUrl(s);
}

/**
 * Нейтрализует Excel formula injection для строкового значения CSV-ячейки.
 * Если строка начинается с =, +, -, @, TAB или CR — добавляет апостроф-префикс.
 * Excel воспринимает ячейку с апострофом как текст, не выполняет формулу.
 *
 * Применяется ТОЛЬКО к строкам (числа экспортируются отдельной веткой escape-функций
 * и не могут содержать формульные символы в смысле Excel injection).
 *
 * @param {string} str — уже приведённая к строке ячейка
 * @returns {string}
 */
function csvFormulaGuard(str) {
  if (!str) return str;
  const first = str[0];
  for (let i = 0; i < _ES_FORMULA_CHARS.length; i++) {
    if (first === _ES_FORMULA_CHARS[i]) return "'" + str;
  }
  return str;
}
