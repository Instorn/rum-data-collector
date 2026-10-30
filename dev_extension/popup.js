// Упрощённый JavaScript для popup интерфейса RUM Data Collector

let aggregatedData = null;

// compact fix-9: строки интерфейса — chrome.i18n (_locales/en по умолчанию, _locales/ru).
// Нет ключа → возвращается сам ключ: видно, какой перевод пропущен.
function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

// Подставляет переводы в разметку: data-i18n → textContent, data-i18n-placeholder → placeholder.
function _applyI18n() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// Инициализация popup
document.addEventListener('DOMContentLoaded', function() {
  _applyI18n();
  loadSettings();
  loadAggregatedData();
  loadPCIdentifier();
  loadOrganization();
  loadPrepilotConfig(); // [prepilot]
  bindEvents();

  // Обновляем данные каждые 10 секунд
  setInterval(() => {
    loadAggregatedData();
    loadPCIdentifier();
    loadOrganization();
    loadPrepilotConfig(); // [prepilot]
  }, 10000);
});

// Загрузка настроек
function loadSettings() {
  const rumCheckbox = document.getElementById('rum-enabled');
  rumCheckbox.checked = true;
  rumCheckbox.disabled = true;
  rumCheckbox.parentElement.title = t('collectionAlwaysOn');
  updateStatus(true);

  // Загружаем managed-инфо (без возможности выключить сбор)
  if (chrome.storage && chrome.storage.managed) {
    chrome.storage.managed.get([
      'customPCName', 'organizationName', 'department', 'location'
    ], function(managedResult) {
      if (!chrome.runtime.lastError && Object.keys(managedResult).length > 0) {
        console.log('Managed settings found:', managedResult);
        showManagedStorageIndicator(managedResult);
      }
    });
  }
}

// Загрузка поля organization.
// Приоритет отображения: ручной ввод (local) > managed > fileBasedSettings.
// Поле всегда редактируемо; источник показывается как подсказка.
function loadOrganization() {
  const input  = document.getElementById('organization-input');
  const helpEl = input ? input.closest('.org-display')?.querySelector('.org-source-hint') : null;

  function _apply(value, source) {
    if (!input) return;
    input.value = value || '';
    if (helpEl) {
      helpEl.textContent = source === 'managed'  ? t('orgSourceManaged') :
                           source === 'settings' ? t('orgSourceSettings') :
                           '';
    }
  }

  chrome.storage.local.get(['organization', 'fileBasedSettings'], function(local) {
    const fromLocal    = local.organization || '';
    const fromSettings = local.fileBasedSettings?.organizationName || '';

    if (fromLocal) {
      // Пользователь уже ввёл значение — оно главное
      _apply(fromLocal, 'local');
      return;
    }

    // Нет локального — пробуем managed, затем settings
    if (chrome.storage && chrome.storage.managed) {
      chrome.storage.managed.get('organizationName', function(managed) {
        const fromManaged = (!chrome.runtime.lastError && managed?.organizationName) || '';
        if (fromManaged) {
          _apply(fromManaged, 'managed');
        } else if (fromSettings) {
          _apply(fromSettings, 'settings');
        } else {
          _apply('', 'local');
        }
      });
    } else if (fromSettings) {
      _apply(fromSettings, 'settings');
    } else {
      _apply('', 'local');
    }
  });
}

// Показ индикатора managed storage
function showManagedStorageIndicator(managedSettings) {
  const infoSection = document.querySelector('.info-section');

  // Удаляем старый индикатор если есть
  const existingIndicator = document.getElementById('managed-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }

  // Создаем новый индикатор
  const managedIndicator = document.createElement('div');
  managedIndicator.id = 'managed-indicator';
  managedIndicator.className = 'managed-indicator';

  let managedInfo = '';
  if (managedSettings.organizationName) {
    managedInfo += t('managedOrg', [managedSettings.organizationName]);
  }
  if (managedSettings.department) {
    if (managedInfo) managedInfo += '\n';
    managedInfo += t('managedDept', [managedSettings.department]);
  }
  if (managedSettings.location) {
    if (managedInfo) managedInfo += '\n';
    managedInfo += t('managedLocation', [managedSettings.location]);
  }

  // fix-17: значения политики — только как текст, без innerHTML
  const details = document.createElement('div');
  details.className = 'managed-details';
  details.style.whiteSpace = 'pre-line';   // \n → перенос строки вместо <br>
  details.textContent = managedInfo;
  managedIndicator.replaceChildren(details);

  // Вставляем перед первым элементом info-section
  infoSection.insertBefore(managedIndicator, infoSection.firstChild);
}

// Загрузка идентификатора ПК
function loadPCIdentifier() {
  chrome.storage.local.get('pcIdentifier', function(result) {
    // compact fix-3: только имя ПК, без подсказки и источника
    const currentPCNameElement = document.getElementById('current-pc-name');
    if (!currentPCNameElement) return;
    if (result.pcIdentifier?.pcName) {
      currentPCNameElement.textContent = result.pcIdentifier.pcName;
      currentPCNameElement.className = 'pc-name-display';
    } else {
      currentPCNameElement.textContent = t('pcNameDetecting');
      currentPCNameElement.className = 'pc-name-display detecting';
    }
  });
}

// Загрузка агрегированных данных
function loadAggregatedData() {
  chrome.runtime.sendMessage({type: 'GET_AGGREGATED_DATA'}, function(response) {
    if (response && response.data) {
      aggregatedData = response.data;
      updateMetricsDisplay();
      updateInfoDisplay();
    }
  });
}

// Обновление отображения метрик
function updateMetricsDisplay() {
  if (!aggregatedData) return;

  // Web Vitals — динамический рендер по METRICS_REGISTRY
  const webVitalsStats = analyzeWebVitals();
  const section = document.getElementById('web-vitals-section');
  if (section) {
    section.innerHTML = '';
    const activeMetrics = METRICS_REGISTRY.filter(m => m.group === 'web-vitals' && m.enabled && !m.deprecated);
    for (const metric of activeMetrics) {
      const stats = webVitalsStats[metric.id];
      const value = stats?.median ?? null;

      // Цветовой статус по порогам метрики ({ good, poor } по контракту реестра)
      let statusClass = '';
      if (value !== null && metric.thresholds) {
        if (value <= metric.thresholds.good) statusClass = 'good';
        else if (value <= metric.thresholds.poor) statusClass = 'needs-improvement';
        else statusClass = 'poor';
      }

      const row = document.createElement('div');
      row.className = 'metric-row';
      const desc = chrome.i18n.getMessage('metricDesc_' + metric.id) || metric.description || '';
      row.innerHTML =
        `<span class="metric-label" title="${desc}">${metric.name} ${t('medianSuffix')}:</span>` +
        `<span class="metric-value ${statusClass}">${formatMetric(value, metric.unit, metric.decimals || 0)}</span>`;
      section.appendChild(row);
    }
  }

  // Остальные метрики (Long Tasks / Click-to-card) — хардкод вне scope реестра
  const perfStats = analyzePerformanceMetrics();
  document.getElementById('long-tasks-ratio').textContent = formatMetric(perfStats.longTaskRatio?.median, '%', 1, 100);
  document.getElementById('click-to-card').textContent = formatMetric(perfStats.clickToCardTime?.median, 'ms');
}

// Анализ Web Vitals — динамически по METRICS_REGISTRY.
// Источник значений — entry.metrics.{id} через _reg_getMetricValue.
// Старый fallback на entry.{id} удалён после fix-1: при апгрейде на vendored
// web-vitals выполняется одноразовая очистка webVitals[] (rumWebVitalsWipeVersion='2'),
// поэтому исторических записей старого формата в storage не остаётся.
function analyzeWebVitals() {
  if (!aggregatedData.webVitals || aggregatedData.webVitals.length === 0) return {};

  const activeMetrics = METRICS_REGISTRY.filter(m => m.group === 'web-vitals' && m.enabled && !m.deprecated);
  const result = {};

  for (const metric of activeMetrics) {
    const values = aggregatedData.webVitals
      .map(e => _reg_getMetricValue(e, metric.id))
      .filter(v => v != null && (metric.zeroIsValid ? v >= 0 : v > 0));
    result[metric.id] = calculateStats(values);
  }

  return result;
}

// Анализ метрик производительности
function analyzePerformanceMetrics() {
  if (!aggregatedData.aggregatedMetrics || aggregatedData.aggregatedMetrics.length === 0) {
    return {};
  }

  const longTaskRatios = aggregatedData.aggregatedMetrics.map(entry => entry.longTasks?.ratio || 0);
  const clickToCardTimes = aggregatedData.aggregatedMetrics
    .filter(entry => entry.customTimings?.clickToCard)
    .map(entry => entry.customTimings.clickToCard.median);

  return {
    longTaskRatio: calculateStats(longTaskRatios),
    clickToCardTime: clickToCardTimes.length > 0 ? calculateStats(clickToCardTimes) : null
  };
}

// Расчёт статистик
function calculateStats(values) {
  if (!values || values.length === 0) return null;

  const sorted = values.sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);

  return {
    count: values.length,
    median: getPercentile(sorted, 50),
    p95: getPercentile(sorted, 95),
    avg: sum / values.length
  };
}

// Вычисление перцентилей
function getPercentile(sortedArray, percentile) {
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, index)] || 0;
}

// Форматирование метрик
function formatMetric(value, unit = '', decimals = 0, multiplier = 1) {
  if (value === null || value === undefined || value < 0) return '-';

  const formattedValue = Math.round((value * multiplier) * Math.pow(10, decimals)) / Math.pow(10, decimals);
  return `${formattedValue}${unit}`;
}

// Обновление информационного дисплея
function updateInfoDisplay() {
  if (!aggregatedData) return;

  document.getElementById('web-vitals-count').textContent = aggregatedData.webVitals?.length || 0;
  document.getElementById('aggregated-count').textContent = aggregatedData.aggregatedMetrics?.length || 0;

  // Счётчики зависаний
  document.getElementById('freeze-events-count').textContent = aggregatedData.freezeEvents?.length || 0;
  document.getElementById('blank-events-count').textContent = aggregatedData.blankPageEvents?.length || 0;

  // Вычисляем период сбора
  const allTimestamps = [
    ...(aggregatedData.webVitals || []).map(entry => entry.timestamp),
    ...(aggregatedData.aggregatedMetrics || []).map(entry => entry.timestamp)
  ];

  const period = allTimestamps.length > 0 ?
    Math.round((Date.now() - Math.min(...allTimestamps)) / (1000 * 60 * 60) * 10) / 10 : 0;

  document.getElementById('collection-period').textContent = period > 0 ? t('periodHours', [String(period)]) : '-';
}

// Обновление статуса
function updateStatus(isActive) {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');

  if (isActive) {
    indicator.classList.add('active');
    indicator.classList.remove('inactive');
    text.textContent = t('statusActive');
  } else {
    indicator.classList.add('inactive');
    indicator.classList.remove('active');
    text.textContent = t('statusInactive');
  }
}

// Вспомогательная функция: disable → sendMessage → notification → enable
function _triggerExport(btnId, msgType) {
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = true;
  chrome.runtime.sendMessage({ type: msgType }, function(response) {
    if (btn) btn.disabled = false;
    if (response && response.success) {
      showNotification(t('notifFileSaved'));
    } else {
      const msg = response?.error ? t('notifError', [response.error]) : t('notifExportError');
      showNotification(msg, 'error');
    }
  });
}

// Показ уведомления
function showNotification(message, type = 'success') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('show');
  }, 10);

  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 2000);
}

// [prepilot] Загружает и отображает информацию об активном конфиге
function loadPrepilotConfig() { // [prepilot]
  // fix-9 Этап 2: aggregatedRumData здесь не использовался (данные для UI приходят
  // через GET_AGGREGATED_DATA из памяти SW), а после разноса секций блоб неполон —
  // читаем только реально нужный fileBasedSettings.
  chrome.storage.local.get(['fileBasedSettings'], result => {
    const hasFileSettings = !!result.fileBasedSettings;
    const sourceEl = document.getElementById('config-source');
    if (sourceEl) {
      sourceEl.textContent = hasFileSettings ? 'settings.json' : t('configSourceRegistry');
    }

    // Определяем siteMode и конфиг для текущей активной вкладки
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      const url = tab?.url || '';
      let domain = '-';
      try { domain = new URL(url).hostname; } catch (e) { /* ignore */ }

      // Собираем siteConfigs из fileBasedSettings или пропускаем
      let siteConfigs = null;
      if (hasFileSettings) {
        const raw = result.fileBasedSettings;
        // Собираем siteConfig_N ключи
        const entries = Object.entries(raw)
          .filter(([k]) => /^siteConfig_\d+$/.test(k))
          .sort(([a], [b]) => parseInt(a.replace('siteConfig_', ''), 10) - parseInt(b.replace('siteConfig_', ''), 10))
          .map(([, v]) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } })
          .filter(Boolean);
        siteConfigs = Array.isArray(raw.siteConfigs) ? raw.siteConfigs
          : entries.length > 0 ? entries
          : null;
      }

      let siteModeText = '-';
      let maxCard = '-', pageLoad = '-', spaNav = '-';
      if (siteConfigs && domain !== '-') {
        // Находим конфиг по домену (wildcard-aware — упрощённая версия для popup)
        const cfg = siteConfigs.find(c => c.domain === domain)
          || siteConfigs.find(c => c.domain !== '*' && c.domain.startsWith('*.') && domain.endsWith(c.domain.slice(1)))
          || siteConfigs.find(c => c.domain === '*')
          || null;
        if (cfg) {
          siteModeText = cfg.mode || '-';
          if (cfg.maxCardLoadTime) maxCard = cfg.maxCardLoadTime + ' ' + t('unitMs');
          if (cfg.pageLoadTimeout)  pageLoad = cfg.pageLoadTimeout + ' ' + t('unitMs');
          if (cfg.spaNavTimeout)    spaNav   = cfg.spaNavTimeout + ' ' + t('unitMs');
        }
      }

      const modeEl = document.getElementById('config-site-mode');
      if (modeEl) modeEl.textContent = siteModeText + (domain !== '-' ? ` (${domain})` : '');
      const mct = document.getElementById('config-max-card-load-time');
      if (mct) mct.textContent = maxCard;
      const plt = document.getElementById('config-page-load-timeout');
      if (plt) plt.textContent = pageLoad;
      const snt = document.getElementById('config-spa-nav-timeout');
      if (snt) snt.textContent = spaNav;
    });
  });
}
// /[prepilot]

// Привязка событий
function bindEvents() {
  // бандл-выгрузка всех отчётов (ZIP) одним нажатием
  const btnBundle = document.getElementById('btn-export-role-bundle');
  if (btnBundle) {
    btnBundle.addEventListener('click', () => {
      _triggerExport('btn-export-role-bundle', 'EXPORT_ROLE_BUNDLE_CSV');
    });
  }

  // ролевая выгрузка navigation detail
  const btnNavDetail = document.getElementById('btn-export-navigation-detail');
  if (btnNavDetail) {
    btnNavDetail.addEventListener('click', () => {
      _triggerExport('btn-export-navigation-detail', 'EXPORT_NAVIGATION_DETAIL_CSV');
    });
  }

  // JSON-версия 04 navigation detail, кастомное сообщение
  const btnNavDetailJson = document.getElementById('btn-export-navigation-detail-json');
  if (btnNavDetailJson) {
    btnNavDetailJson.addEventListener('click', () => {
      btnNavDetailJson.disabled = true;
      chrome.runtime.sendMessage({ type: 'EXPORT_NAVIGATION_DETAIL_JSON' }, resp => {
        btnNavDetailJson.disabled = false;
        if (chrome.runtime.lastError) return;
        if (resp?.success) {
          showNotification(t('notifNav04JsonSaved'));
        } else {
          const msg = resp?.error ? t('notifError', [resp.error]) : t('notifExportError');
          showNotification(msg, 'error');
        }
      });
    });
  }

  document.getElementById('btn-export-anomalies').addEventListener('click', () => {
    _triggerExport('btn-export-anomalies', 'EXPORT_ANOMALIES_CSV');
  });

  // экспорт AJAX timing
  const btnAjax = document.getElementById('btn-export-ajax-details');
  if (btnAjax) {
    btnAjax.addEventListener('click', () => {
      _triggerExport('btn-export-ajax-details', 'EXPORT_AJAX_DETAILS_CSV');
    });
  }
  document.getElementById('btn-export-settings').addEventListener('click', () => {
    _triggerExport('btn-export-settings', 'EXPORT_SETTINGS_JSON');
  });

  // сохранение organization при потере фокуса
  const orgInput = document.getElementById('organization-input');
  if (orgInput) {
    orgInput.addEventListener('blur', () => {
      chrome.storage.local.set({ organization: orgInput.value.trim() });
    });
  }

  // полная очистка накопленных данных
  const btnClear = document.getElementById('btn-clear-data');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (!confirm(t('confirmClear'))) return;
      btnClear.disabled = true;
      chrome.runtime.sendMessage({ type: 'CLEAR_RUM_DATA' }, response => {
        btnClear.disabled = false;
        if (response && response.success) {
          showNotification(t('notifCleared'));
          loadAggregatedData();
        } else {
          showNotification(t('notifClearError'), 'error');
        }
      });
    });
  }

  // [TEMP] Кнопка перезагрузки настроек из settings.json / реестра
  document.getElementById('btn-reload-settings').addEventListener('click', () => {
    const btn = document.getElementById('btn-reload-settings');
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'RELOAD_SETTINGS' }, response => {
      btn.disabled = false;
      if (response && response.success) {
        const src = response.source === 'file' ? 'settings.json' : t('sourceRegistry');
        showNotification(t('notifSettingsReloaded', [src]));
        loadPrepilotConfig();
      } else {
        showNotification(response?.error || t('notifReloadError'), 'error');
      }
    });
  });
  // /[prepilot]
}
