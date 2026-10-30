/** services/analysis/sanitizeText.js
Общий санитайзер текстовых данных для RUM-расширения.

Используется content.js и export-слоем background.js для маскировки ID в адресах страниц (pageUrl).

Подключение в content script: добавлен в manifest.json → content_scripts.js[] перед content.js.
Подключение в SW: importScripts('services/analysis/sanitizeText.js') при необходимости.

Не использует ES-модули — работает как в content script, так и в SW без изменений. */


const RumSanitize = (() => {

  // ─── Санитизация URL страницы ─────────────────────────────────────────────────

  /**
   * Санитизация URL страницы: с маской GUID и числовых сегментов пути,
   * с маской query-параметров, похожих на идентификаторы.
   * Применяется к page_url перед отправкой в background.
   *
   * принимает опциональный siteConfig для использования pageUrlIdMinDigits.
   * siteConfig.sanitize.pageUrlIdMinDigits управляет порогом для числовых сегментов
   * ТОЛЬКО в path (не в query, не влияет на GUID-маску).
   * Default: 4 (.
   *
   * при siteConfig.hashNavigation=true hash-фрагмент включается
   * в sanitized page_url. Числовые ID в hash маскируются через pageUrlIdMinDigits.
   * GUID в hash маскируется. Длина hash после '#' ограничивается через
   * sanitize.pageUrlHashMaxLength (опционально). При hashNavigation=false/absent
   * hash по-прежнему отбрасывается (прежнее поведение).
   *
   * @param {string} url
   * @param {object} [siteConfig] — опциональный конфиг домена 
   * @returns {string}
   */
  function pageUrl(url, siteConfig) {
    try {
      const san = (siteConfig && siteConfig.sanitize) || {};
      const minDigits = (typeof san.pageUrlIdMinDigits === 'number'
        && san.pageUrlIdMinDigits >= 2
        && san.pageUrlIdMinDigits <= 10)
        ? san.pageUrlIdMinDigits
        : 4;

      const numIdRe = new RegExp('/\\d{' + minDigits + ',}', 'g');
      const useHash = siteConfig?.hashNavigation === true;

      // При hashNavigation=false (дефолт) — отбрасываем hash как раньше.
      const rawUrl = useHash ? String(url) : String(url).split('#')[0];
      const u = new URL(rawUrl);

      const path = u.pathname
        // GUID в path-сегменте
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/[guid]')
        // Числовой ID в path: порог из конфига (дефолт 4)
        .replace(numIdRe, '/[id]');

      const qParts = [];
      u.searchParams.forEach((val, key) => {
        if (/^(id|.*_id|.*Id)$/i.test(key) || /^\d+$/.test(val) || /^[0-9a-f-]{32,}$/.test(val)) {
          qParts.push(key + '=[id]');
        } else {
          qParts.push(key + '=' + encodeURIComponent(val));
        }
      });
      const qs = qParts.length ? '?' + qParts.join('&') : '';

      // при useHash включаем и санитизируем hash-фрагмент.
      let hashPart = '';
      if (useHash && u.hash && u.hash.length > 1) {
        let h = u.hash; // начинается с '#'
        // GUID в hash
        h = h.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[guid]');
        // Числовые ID в hash: порог pageUrlIdMinDigits
        h = h.replace(new RegExp('\\d{' + minDigits + ',}', 'g'), '[id]');
        // Опциональный лимит длины hash после '#'
        const maxHashLen = typeof san.pageUrlHashMaxLength === 'number'
          && san.pageUrlHashMaxLength >= 1 ? san.pageUrlHashMaxLength : null;
        if (maxHashLen !== null && h.length - 1 > maxHashLen) {
          h = h.slice(0, maxHashLen + 1); // +1 чтобы сохранить '#'
        }
        hashPart = h;
      }

      return u.origin + path + qs + hashPart;
    } catch {
      const stripped = String(url).split('#')[0];
      return siteConfig?.hashNavigation === true ? String(url) : stripped;
    }
  }

  return {
    pageUrl,
  };

})();
