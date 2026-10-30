// Строки интерфейса в SW-контексте (compact fix-9): тексты ошибок, которые popup показывает
// пользователю. Сами тексты — в _locales/<язык>/messages.json; язык выбирает Chrome по языку
// браузера, по умолчанию en (manifest.default_locale). Логи в консоль не переводятся.
//
// _t(key, subs) → строка для текущего языка. Нет chrome.i18n (node-стенды) или нет ключа →
// возвращается сам key: видно, какой ключ не найден, и выгрузка не падает.

function _t(key, subs) {
  try {
    const s = chrome.i18n.getMessage(key, subs);
    if (s) return s;
  } catch (e) { /* вне расширения chrome.i18n нет */ }
  return key;
}
