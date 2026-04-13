(function () {
  'use strict';

  var ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

  var elToggle = document.getElementById('toggle');
  var elThreshold = document.getElementById('threshold');
  var elAddrInput = document.getElementById('addrInput');
  var elLabelInput = document.getElementById('labelInput');
  var elBtnAdd = document.getElementById('btnAdd');
  var elList = document.getElementById('list');
  var elSaved = document.getElementById('saved');

  var state = {
    enabled: true,
    thresholdPercent: 5,
    blacklist: []
  };

  var saveTimer = null;

  function showSaved() {
    elSaved.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      elSaved.classList.remove('show');
    }, 1200);
  }

  function persist() {
    chrome.storage.local.set(
      {
        enabled: state.enabled,
        thresholdPercent: state.thresholdPercent,
        blacklist: state.blacklist
      },
      function () {
        if (chrome.runtime.lastError) return;
        showSaved();
      }
    );
  }

  function normalizeAddr(s) {
    return String(s || '')
      .trim()
      .toLowerCase();
  }

  function normalizeEntry(item) {
    if (typeof item === 'string') {
      var a = normalizeAddr(item);
      if (!ADDR_RE.test(a)) return null;
      return { address: a, label: '' };
    }
    if (item && typeof item === 'object') {
      var addr = normalizeAddr(item.address);
      if (!ADDR_RE.test(addr)) return null;
      return { address: addr, label: String(item.label || '').trim() };
    }
    return null;
  }

  function renderList() {
    elList.innerHTML = '';
    if (!state.blacklist.length) {
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = '🍡 暂无黑名单地址～';
      elList.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.blacklist.length; i++) {
      (function (entry) {
        var row = document.createElement('div');
        row.className = 'row';
        var span = document.createElement('div');
        span.className = 'addr';
        var labelPart = entry.label ? ' · ' + entry.label : '';
        span.textContent = entry.address + labelPart;
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-del';
        del.setAttribute('aria-label', '删除');
        del.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a2 2 0 01-2 2H8a2 2 0 01-2-2V7h14zM10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        del.addEventListener('click', function () {
          row.classList.add('removing');
          setTimeout(function () {
            state.blacklist = state.blacklist.filter(function (x) {
              return x.address !== entry.address;
            });
            renderList();
            persist();
          }, 360);
        });
        row.appendChild(span);
        row.appendChild(del);
        elList.appendChild(row);
      })(state.blacklist[i]);
    }
  }

  function addAddress() {
    var raw = normalizeAddr(elAddrInput.value);
    if (!ADDR_RE.test(raw)) {
      elAddrInput.focus();
      return;
    }
    if (state.blacklist.some(function (x) { return x.address === raw; })) {
      elAddrInput.value = '';
      return;
    }
    var lb = String(elLabelInput.value || '').trim();
    state.blacklist.push({ address: raw, label: lb });
    elAddrInput.value = '';
    elLabelInput.value = '';
    renderList();
    persist();
  }

  elBtnAdd.addEventListener('click', addAddress);
  elAddrInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addAddress();
    }
  });

  var elToggleHint = document.getElementById('toggleHint');

  function syncToggleHint() {
    if (elToggleHint) elToggleHint.textContent = state.enabled ? '开启' : '关闭';
  }

  elToggle.addEventListener('click', function () {
    state.enabled = !state.enabled;
    elToggle.classList.toggle('on', state.enabled);
    elToggle.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
    syncToggleHint();
    persist();
  });

  elToggle.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      elToggle.click();
    }
  });

  elThreshold.addEventListener('change', function () {
    var v = parseFloat(elThreshold.value);
    if (!isFinite(v)) v = state.thresholdPercent;
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    state.thresholdPercent = v;
    elThreshold.value = String(v);
    persist();
  });

  chrome.storage.local.get(['enabled', 'thresholdPercent', 'blacklist'], function (items) {
    if (items.enabled === false) state.enabled = false;
    if (items.thresholdPercent != null) {
      var t = parseFloat(items.thresholdPercent);
      if (isFinite(t)) state.thresholdPercent = t;
    }
    if (Array.isArray(items.blacklist)) {
      var seen = {};
      var arr = [];
      for (var i = 0; i < items.blacklist.length; i++) {
        var ne = normalizeEntry(items.blacklist[i]);
        if (!ne || seen[ne.address]) continue;
        seen[ne.address] = 1;
        arr.push(ne);
      }
      state.blacklist = arr;
    }
    elToggle.classList.toggle('on', state.enabled);
    elToggle.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
    syncToggleHint();
    elThreshold.value = String(state.thresholdPercent);
    renderList();
  });
})();
