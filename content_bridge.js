(function () {
  'use strict';

  var CHANNEL = 'ALPHA_GUARD';
  var MSG_CONFIG = 'CONFIG';
  var MSG_REQUEST_SYNC = 'REQUEST_CONFIG';
  var MSG_PING = 'PING';

  function normalizeBlacklist(list) {
    if (!Array.isArray(list)) return [];
    var normalized = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var addr = '';
      var label = '';
      if (typeof raw === 'string') {
        addr = String(raw).trim().toLowerCase();
      } else if (raw && typeof raw === 'object') {
        addr = String(raw.address || '').trim().toLowerCase();
        label = String(raw.label || '').trim();
      }
      if (!addr || seen[addr]) continue;
      seen[addr] = 1;
      normalized.push({ address: addr, label: label });
    }
    return normalized;
  }

  /** 仅包含 storage 中已存在的键，避免未配置时覆盖主世界 DEFAULT_INIT_RULES */
  function buildPayloadFromStorage(items) {
    var payload = {};
    if (items && Object.prototype.hasOwnProperty.call(items, 'blacklist')) {
      payload.blacklist = normalizeBlacklist(items.blacklist);
    }
    if (items && Object.prototype.hasOwnProperty.call(items, 'thresholdPercent')) {
      var th = items.thresholdPercent;
      var num = typeof th === 'number' ? th : parseFloat(th);
      if (!isFinite(num) || num < 0) num = 5;
      if (num > 100) num = 100;
      payload.thresholdPercent = num;
    }
    if (items && Object.prototype.hasOwnProperty.call(items, 'enabled')) {
      payload.enabled = items.enabled !== false;
    }
    return payload;
  }

  function readStorage(cb) {
    try {
      chrome.storage.local.get(
        ['blacklist', 'thresholdPercent', 'enabled'],
        function (items) {
          if (chrome.runtime.lastError) {
            cb({});
            return;
          }
          cb(buildPayloadFromStorage(items || {}));
        }
      );
    } catch (e) {
      cb({});
    }
  }

  function broadcastConfig(config) {
    try {
      window.postMessage(
        {
          source: CHANNEL,
          type: MSG_CONFIG,
          payload: config,
          ts: Date.now()
        },
        '*'
      );
    } catch (e) {}
  }

  function pushCurrent() {
    readStorage(function (cfg) {
      broadcastConfig(cfg);
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== CHANNEL) return;
    if (d.type === MSG_REQUEST_SYNC || d.type === MSG_PING) {
      pushCurrent();
    }
  });

  try {
    chrome.storage.onChanged.addListener(function (_changes, area) {
      if (area !== 'local') return;
      pushCurrent();
    });
  } catch (e) {}

  pushCurrent();

  var heartbeatId = setInterval(function () {
    pushCurrent();
  }, 1000);

  window.addEventListener('unload', function () {
    clearInterval(heartbeatId);
  }, { once: true });
})();
