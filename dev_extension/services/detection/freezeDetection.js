/** services/detection/freezeDetection.js
Stateless-хелперы построения событий зависания и пустых страниц.
Подключается через importScripts в background.js.
Не хранит состояние — только чистые builder-функции. */

// ─── Builders 

/**
 * Строит запись события зависания вкладки (heartbeat timeout).
 *
 * @param {number} tabId
 * @param {{ ts: number, url: string, beats: number, longTasksActive: boolean }} hb
 * @param {number} now - Date.now() момент детекции
 * @returns {Object} freezeEvent
 */
function buildFreezeEvent(tabId, hb, now) {
  return {
    tabId,
    url:                  hb.url,
    lastHeartbeatTs:      hb.ts,
    detectedAt:           now,
    silenceDuration:      now - hb.ts,
    lastBeats:            hb.beats,
    lastLongTasksActive:  hb.longTasksActive
  };
}

/**
 * Строит запись события пустой страницы (LCP-timeout или abandoned).
 *
 * @param {Object} request - сообщение от content script
 * @param {string} request.type          - 'BLANK_PAGE_DETECTED' | 'ABANDONED_BLANK_PAGE'
 * @param {number} [request.timestamp]
 * @param {string} [request.url]
 * @param {number} [request.ttfb]
 * @param {number} [request.longTaskRatio]   - только BLANK_PAGE_DETECTED
 * @param {number} [request.sessionDuration] - только BLANK_PAGE_DETECTED
 * @param {number} [request.timeOnPage]      - только ABANDONED_BLANK_PAGE
 * @param {number} senderTabId
 * @returns {Object} blankPageEvent
 */
function buildBlankPageEvent(request, senderTabId) {
  const entry = {
    eventType:    request.type,
    timestamp:    request.timestamp || Date.now(),
    tabId:        senderTabId,
    url:          request.url,
    ttfb:         request.ttfb        || 0
  };

  if (request.type === 'BLANK_PAGE_DETECTED') {
    entry.longTaskRatio    = request.longTaskRatio    || 0;
    entry.sessionDuration  = request.sessionDuration  || 0;
  } else {
    entry.timeOnPage = request.timeOnPage || 0;
  }

  return entry;
}
