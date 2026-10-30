// metrics/registry.js
// Единый реестр Web Vitals метрик — единственный источник правды.
// Потребители: content.js (collect), popup.js (render), background.js (importScripts),
//              exportRumDetailsCsv.js, exportJson.js.
//
// Контракт collect(onValue):
//   - onValue(value) вызывается при каждом обновлении метрики
//   - возвращает cleanup-функцию ИЛИ null (для web-vitals 5.x cleanup не возвращается:
//     библиотека сама регистрирует pagehide/visibilitychange listener'ы и финализирует
//     значение по lifecycle страницы)
//
// Контракт thresholds: { good: Number, poor: Number }
//   - value <= good         → статус 'good'  (зелёный)
//   - good < value <= poor  → статус 'needs-improvement'  (жёлтый)
//   - value > poor          → статус 'poor'  (красный)
//
// Фильтр активности метрик: enabled === true && deprecated !== true

// Вспомогательный helper: безопасная подписка на webVitals.on*().
// Не падает, если библиотека или конкретная функция недоступна — пишет console.warn,
// чтобы факт отсутствия web-vitals.iife.js или несовместимой версии был виден в логе.
function _reg_subscribeWebVital(apiName, onValue, options, decimals) {
  const lib = (typeof globalThis !== 'undefined' && globalThis.webVitals) || null;
  const fn = lib && typeof lib[apiName] === 'function' ? lib[apiName] : null;
  if (!fn) {
    console.warn('[RUM] web-vitals API недоступен:', apiName);
    return null;
  }
  try {
    const cb = (metric) => {
      if (!metric || typeof metric.value !== 'number' || !isFinite(metric.value)) return;
      const v = decimals === 0
        ? Math.round(metric.value)
        : Math.round(metric.value * Math.pow(10, decimals)) / Math.pow(10, decimals);
      onValue(v);
    };
    if (options) {
      fn(cb, options);
    } else {
      fn(cb);
    }
  } catch (e) {
    console.warn('[RUM] web-vitals subscribe error:', apiName, e && e.message);
  }
  // web-vitals 5.x не возвращает unsubscribe — listener живёт до pagehide.
  return null;
}

const METRICS_REGISTRY = [
  {
    id: 'lcp',
    name: 'LCP',
    group: 'web-vitals',
    unit: 'ms',
    decimals: 0,
    enabled: true,
    zeroIsValid: false,     // 0 фильтруется при вычислении статистики
    description: 'Largest Contentful Paint — время отрисовки наибольшего элемента',
    thresholds: { good: 2500, poor: 4000 },
    collect(onValue) {
      // reportAllChanges:true нужен blank-page детекции в content.js: watchForBlankPage()
      // и setupVisibilityChangeListener() читают metricValues['lcp'] до ухода страницы в hidden.
      return _reg_subscribeWebVital('onLCP', onValue, { reportAllChanges: true }, 0);
    }
  },

  {
    id: 'inp',
    name: 'INP',
    group: 'web-vitals',
    unit: 'ms',
    decimals: 0,
    enabled: true,
    zeroIsValid: false,
    description: 'Interaction to Next Paint — задержка от взаимодействия до отрисовки',
    thresholds: { good: 200, poor: 500 },
    collect(onValue) {
      // durationThreshold:40 — ловим короткие события (browser default 104ms их пропускает).
      return _reg_subscribeWebVital('onINP', onValue, { durationThreshold: 40 }, 0);
    }
  },

  {
    id: 'cls',
    name: 'CLS',
    group: 'web-vitals',
    unit: '',
    decimals: 3,
    enabled: true,
    zeroIsValid: true,      // CLS = 0 означает отсутствие сдвигов — валидное значение
    description: 'Cumulative Layout Shift — суммарный сдвиг макета страницы',
    thresholds: { good: 0.1, poor: 0.25 },
    collect(onValue) {
      // Без reportAllChanges: финальное session-window значение CLS приходит при pagehide.
      return _reg_subscribeWebVital('onCLS', onValue, null, 3);
    }
  },

  {
    id: 'ttfb',
    name: 'TTFB',
    group: 'web-vitals',
    unit: 'ms',
    decimals: 0,
    enabled: true,
    zeroIsValid: false,
    description: 'Time to First Byte — время до первого байта ответа сервера',
    thresholds: { good: 800, poor: 1800 },
    collect(onValue) {
      // Библиотека сама использует PerformanceNavigationTiming; deprecated performance.timing удалён.
      return _reg_subscribeWebVital('onTTFB', onValue, null, 0);
    }
  }
];

// ─── Утилита: извлечение значения метрики из записи ──────────────────────────
// Формат: entry.metrics.{id}. Старый fallback на entry[metricId] удалён, потому что
// при апгрейде на новую методику Web Vitals выполняется одноразовый wipe webVitals[]
// (см. services/migrations/storageWipes.js::ensureWebVitalsMethodologyWipe).
function _reg_getMetricValue(entry, metricId) {
  return entry && entry.metrics && entry.metrics[metricId];
}
