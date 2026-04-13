(function () {
  'use strict';

  var CHANNEL = 'ALPHA_GUARD';
  var MSG_CONFIG = 'CONFIG';

  /** 异步配置加载前仍生效的默认规则（含测试地址与备注 label） */
  var DEFAULT_INIT_RULES = {
    blacklist: [
      { address: '0x0000000000000000000000000000000000000001', label: '测试地址1' },
      { address: '0xdead000000000000000000000000000000000000', label: '测试地址2' }
    ],
    thresholdPercent: 5,
    enabled: true
  };

  var state = {
    blacklist: DEFAULT_INIT_RULES.blacklist.map(function (x) {
      return { address: x.address, label: x.label || '' };
    }),
    thresholdPercent: DEFAULT_INIT_RULES.thresholdPercent,
    enabled: DEFAULT_INIT_RULES.enabled,
    tripped: false,
    dismissed: false,
    tripContext: null,
    /** 熔断生效时的路由指纹；与当前 getRouteKey() 不一致则必须清理（补 RouterWatcher 漏检） */
    tripRouteKey: null
  };

  var tripAlertLogged = false;

  var lockBurstTimerId = null;
  var bannerWatchId = null;
  var fuseRoutePollId = null;

  /** SPA 路由指纹：pathname + search + hash（仅 pathname 时部分站点「换页」不触发清理） */
  function getRouteKey() {
    try {
      return (
        String(location.pathname || '') +
        String(location.search || '') +
        String(location.hash || '')
      );
    } catch (e) {
      return '';
    }
  }

  /** 从 GMGN 类路径解析当前页代币合约，如 /bsc/token/0xabc... */
  function extractPageTokenContract() {
    try {
      var p = String(location.pathname || '');
      var m = p.match(/\/token\/(0x[a-fA-F0-9]{40})\b/i);
      return m ? m[1].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  /** 递归深度限制，防止超大 JSON 卡死（GMGN 持仓结构可能较深） */
  var MAX_JSON_DEPTH = 10;

  var ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

  function isGmgnPageHost() {
    try {
      var h = String(location.hostname || '').toLowerCase();
      return h === 'gmgn.ai' || h === 'www.gmgn.ai' || h.endsWith('.gmgn.ai');
    } catch (e) {
      return false;
    }
  }

  /** 请求 URL 是否属于 GMGN（含子域 API，相对路径则按当前页判断） */
  function urlLooksLikeGmgnRequest(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      if (url.indexOf('://') === -1) return isGmgnPageHost();
      var u = new URL(url, location.href);
      var h = String(u.hostname || '').toLowerCase();
      return h === 'gmgn.ai' || h === 'www.gmgn.ai' || h.endsWith('.gmgn.ai');
    } catch (e) {
      return isGmgnPageHost();
    }
  }

  /**
   * 是否解析该请求的 JSON 以检测持仓。
   * 在 /token/0x 页面时：URL 必须带当前合约，或（无 holder 字样时）走 /api + 合约；禁止仅因路径含 holder
   * 就嗅探「与当前币无关」的全局接口，否则换币后易立刻误熔断、Banner 像「清不掉」。
   */
  function shouldSniffHoldersResponse(url) {
    if (typeof url !== 'string' || !url) return false;
    if (!urlLooksLikeGmgnRequest(url)) return false;
    var u = url.toLowerCase();
    var pageTok = extractPageTokenContract();
    var hasHolderWord = u.indexOf('holder') !== -1;
    var looksApi = u.indexOf('/api') !== -1;
    if (hasHolderWord) {
      if (pageTok) return u.indexOf(pageTok) !== -1;
      return true;
    }
    if (!looksApi) return false;
    if (!pageTok) return false;
    return u.indexOf(pageTok) !== -1;
  }

  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var n = parseFloat(String(v).replace(/,/g, ''));
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function scanTotalSupply(obj, depth) {
    if (obj == null || typeof obj !== 'object') return null;
    if (depth == null) depth = 0;
    if (depth > 24) return null;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var r = scanTotalSupply(obj[i], depth + 1);
        if (r != null) return r;
      }
      return null;
    }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var lk = keys[k].toLowerCase();
      if (lk === 'total_supply' || lk === 'totalsupply') {
        var n = parseNum(obj[keys[k]]);
        if (n != null && n > 0) return n;
      }
    }
    for (var j = 0; j < keys.length; j++) {
      var r2 = scanTotalSupply(obj[keys[j]], depth + 1);
      if (r2 != null) return r2;
    }
    return null;
  }

  function normalizeBlacklistItems(arr) {
    var merged = [];
    var seen = {};
    if (!Array.isArray(arr)) return merged;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var addr = '';
      var label = '';
      if (typeof it === 'string') {
        addr = String(it).trim().toLowerCase();
      } else if (it && typeof it === 'object') {
        addr = String(it.address || it.addr || '').trim().toLowerCase();
        label = String(
          it.label != null
            ? it.label
            : it.remark != null
              ? it.remark
              : it.name != null
                ? it.name
                : it.note != null
                  ? it.note
                  : ''
        ).trim();
      }
      if (!addr || seen[addr]) continue;
      seen[addr] = 1;
      merged.push({ address: addr, label: label });
    }
    return merged;
  }

  function mergeRules(base, incoming) {
    if (!incoming || typeof incoming !== 'object') return base;
    /* 熔断状态必须随 base 保留；否则隔离脚本每秒 CONFIG 广播会清空 tripped/tripContext，横幅立刻失效 */
    var out = {
      blacklist: base.blacklist.slice(),
      thresholdPercent: base.thresholdPercent,
      enabled: base.enabled,
      tripped: !!base.tripped,
      dismissed: !!base.dismissed,
      tripContext: base.tripContext != null ? base.tripContext : null,
      tripRouteKey: base.tripRouteKey != null ? base.tripRouteKey : null
    };
    if (
      Object.prototype.hasOwnProperty.call(incoming, 'blacklist') &&
      Array.isArray(incoming.blacklist)
    ) {
      out.blacklist = normalizeBlacklistItems(incoming.blacklist);
    }
    if (Object.prototype.hasOwnProperty.call(incoming, 'thresholdPercent')) {
      var t = parseFloat(incoming.thresholdPercent);
      if (isFinite(t)) {
        if (t < 0) t = 0;
        if (t > 100) t = 100;
        out.thresholdPercent = t;
      }
    }
    if (Object.prototype.hasOwnProperty.call(incoming, 'enabled')) {
      out.enabled = !!incoming.enabled;
    }
    if (!out.enabled) {
      out.tripped = false;
      out.dismissed = false;
      out.tripContext = null;
      out.tripRouteKey = null;
    }
    return out;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== CHANNEL || d.type !== MSG_CONFIG) return;
    var p = d.payload;
    var prevEnabled = state.enabled;
    state = mergeRules(state, p);
    if (!state.enabled && prevEnabled) {
      try {
        restoreTradingUi();
      } catch (eRestore) {}
    }
  });

  function requestConfigFromBridge() {
    try {
      window.postMessage({ source: CHANNEL, type: 'REQUEST_CONFIG' }, '*');
    } catch (e) {}
  }

  requestConfigFromBridge();
  setTimeout(requestConfigFromBridge, 0);
  setTimeout(requestConfigFromBridge, 500);

  function isAddressKey(lk) {
    return (
      lk.indexOf('addr') !== -1 ||
      lk.indexOf('wallet') !== -1 ||
      lk.indexOf('holder') !== -1 ||
      lk.indexOf('user') !== -1 ||
      lk.indexOf('owner') !== -1
    );
  }

  function isRatioLikeKey(lk) {
    return (
      lk.indexOf('ratio') !== -1 ||
      lk.indexOf('percent') !== -1 ||
      lk.indexOf('pct') !== -1 ||
      lk.indexOf('holding') !== -1 ||
      lk.indexOf('amount') !== -1
    );
  }

  function isLikelyWeiAmountKey(lk, n) {
    if (n == null || !isFinite(n)) return false;
    if (n <= 1000) return false;
    if (lk.indexOf('ratio') !== -1 || lk.indexOf('percent') !== -1 || lk.indexOf('pct') !== -1)
      return false;
    if (lk.indexOf('holding') !== -1 && lk.indexOf('amount') !== -1) return true;
    if (lk === 'balance' || lk === 'holding_amount') return true;
    if (lk.indexOf('amount') !== -1 && lk.indexOf('holding') === -1) return true;
    return false;
  }

  function normalizeRatioPercent(r) {
    if (r == null || !isFinite(r)) return null;
    if (r >= 0 && r <= 1) return r * 100;
    return r;
  }

  function extractHolderEntries(obj, out, ctx, depth) {
    if (!ctx) ctx = { totalSupply: null };
    if (depth == null) depth = 0;
    if (depth > MAX_JSON_DEPTH) return;
    if (obj == null) return;
    if (typeof obj === 'string') {
      if (ADDR_RE.test(obj)) out.push({ address: obj.toLowerCase(), ratio: 0 });
      return;
    }
    if (typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) extractHolderEntries(obj[i], out, ctx, depth + 1);
      return;
    }

    var keys = Object.keys(obj);
    var addr = null;
    var amount = null;
    var localSupply = null;
    var chosenRatio = null;

    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var v = obj[key];
      var lk = key.toLowerCase();
      if (typeof v === 'string' && ADDR_RE.test(v)) {
        if (!addr) addr = v.toLowerCase();
      }
      if (isAddressKey(lk) && typeof v === 'string' && ADDR_RE.test(v)) {
        addr = v.toLowerCase();
      }
    }

    for (var r = 0; r < keys.length; r++) {
      var keyR = keys[r];
      var vr = obj[keyR];
      var lkr = keyR.toLowerCase();
      var n = parseNum(vr);
      if (lkr === 'total_supply' || lkr === 'totalsupply') {
        var sn = parseNum(vr);
        if (sn != null && sn > 0) localSupply = sn;
      }
      if (!isRatioLikeKey(lkr) || n == null || !isFinite(n)) continue;
      if (isLikelyWeiAmountKey(lkr, n)) {
        amount = n;
        continue;
      }
      if (chosenRatio == null) chosenRatio = n;
    }

    if (addr) {
      var ratio = chosenRatio != null ? normalizeRatioPercent(chosenRatio) : null;
      if (ratio == null || !isFinite(ratio)) {
        if (amount != null && localSupply != null && localSupply > 0) {
          ratio = (amount / localSupply) * 100;
        } else if (amount != null && ctx.totalSupply != null && ctx.totalSupply > 0) {
          ratio = (amount / ctx.totalSupply) * 100;
        }
      }
      out.push({ address: addr, ratio: ratio || 0 });
    }

    for (var j = 0; j < keys.length; j++)
      extractHolderEntries(obj[keys[j]], out, ctx, depth + 1);
  }

  function analyzeBodyText(text) {
    var hits = [];
    if (!text) return hits;
    try {
      var parsed = JSON.parse(text);
      var globalSupply = scanTotalSupply(parsed);
      extractHolderEntries(parsed, hits, { totalSupply: globalSupply }, 0);
    } catch (e) {
      if (text.toLowerCase().indexOf('holder') === -1) return hits;
      var re = /0x[a-fA-F0-9]{40}/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        hits.push({ address: m[0].toLowerCase(), ratio: 0 });
      }
    }
    return hits;
  }

  /**
   * 收集所有「黑名单地址 + 持仓比例 ≥ 阈值」的条目；同一地址多条记录取最大 ratio。
   * @returns {Array<{address:string,ratio:number,label:string}>|null}
   */
  function getTripMatches(entries) {
    if (!state.enabled) return null;
    var labelMap = {};
    for (var i = 0; i < state.blacklist.length; i++) {
      var row = state.blacklist[i];
      if (!row || !row.address) continue;
      var akey = String(row.address).trim().toLowerCase();
      if (!akey) continue;
      labelMap[akey] = row.label != null ? String(row.label).trim() : '';
    }
    var ratioByAddr = {};
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (!e || !e.address) continue;
      var addr = String(e.address).trim().toLowerCase();
      if (!labelMap.hasOwnProperty(addr)) continue;
      var r = e.ratio;
      if (r == null || !isFinite(r)) continue;
      if (r >= state.thresholdPercent) {
        if (!ratioByAddr[addr] || r > ratioByAddr[addr]) ratioByAddr[addr] = r;
      }
    }
    var keys = Object.keys(ratioByAddr);
    if (keys.length === 0) return null;
    var out = [];
    for (var k = 0; k < keys.length; k++) {
      var ad = keys[k];
      out.push({
        address: ad,
        ratio: ratioByAddr[ad],
        label: labelMap[ad] != null ? String(labelMap[ad]) : ''
      });
    }
    out.sort(function (a, b) {
      return b.ratio - a.ratio;
    });
    return out;
  }

  function formatBannerRemark(match) {
    var lb = match.label && String(match.label).trim();
    if (lb) return lb;
    var a = match.address || '';
    if (a.length > 12) return a.slice(0, 6) + '…' + a.slice(-4);
    return a || '未知';
  }

  function formatRatioOneDecimal(r) {
    if (r == null || !isFinite(r)) return '0.0';
    return (Math.round(r * 10) / 10).toFixed(1);
  }

  /**
   * 熔断上下文 → 横幅文案：发现畜生！XX，X.X%持仓 [ 空格 YYY，Y.Y%持仓 … ]（比例保留一位小数）
   * @param {object} ctx  { matches: Array<{address,ratio,label}> } 或旧版单条 { address, ratio, label }
   */
  function formatFuseBannerTitle(ctx) {
    if (!ctx) return '';
    var matches = ctx.matches;
    if (!Array.isArray(matches) || matches.length === 0) {
      if (ctx.address != null && ctx.ratio != null) {
        matches = [ctx];
      } else {
        return '';
      }
    }
    var parts = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m) continue;
      var name = formatBannerRemark(m);
      var pct = formatRatioOneDecimal(m.ratio);
      parts.push(name + '，' + pct + '%持仓');
    }
    if (parts.length === 0) return '';
    return '发现畜生！' + parts.join(' ');
  }

  /* ─────────────────────────────────────────────────────────────────
   * BannerManager — banner 生命周期的唯一权威管理者
   *
   * 公开接口：
   *   showBanner(match)  创建/挂载/显示 banner，写 sessionStorage
   *   destroyBanner()    完全移除 DOM 节点，清 全局引用 + sessionStorage，返回 bool
   *   startWatchdog()    启动守卫定时器，防 React 重渲染把 banner 删掉
   *   stopWatchdog()     停止守卫定时器
   * ───────────────────────────────────────────────────────────────── */
  var BannerManager = (function () {
    var BANNER_ID  = 'alpha-guard-fuse-banner';
    var SESSION_KEY = 'alpha_guard_banner_path';

    /* 仅内联定位与层级；配色由 style.css（Neo-Brutalism 横幅）统一 */
    function _applyFixedStyles(node) {
      if (!node) return;
      try {
        node.style.cssText =
          'position:fixed;top:0;left:0;width:100%;z-index:9999999999;';
      } catch (e0) {}
      try {
        node.style.setProperty('position', 'fixed', 'important');
        node.style.setProperty('top', '0', 'important');
        node.style.setProperty('left', '0', 'important');
        node.style.setProperty('width', '100%', 'important');
        node.style.setProperty('z-index', '9999999999', 'important');
      } catch (e1) {}
    }

    function _mountIntoBody(node) {
      if (!node) return;
      _applyFixedStyles(node);
      try {
        document.body.insertBefore(node, document.body.firstChild);
      } catch (eBody) {}
    }

    /* document_start 时 body 常不存在：先挂 html，待 body 出现后移到 body 首位，避免样式/框架异常 */
    function _mount(node) {
      _applyFixedStyles(node);
      if (document.body) {
        _mountIntoBody(node);
        return;
      }
      try {
        document.documentElement.insertAdjacentElement('afterbegin', node);
      } catch (e3) {
        try {
          document.documentElement.appendChild(node);
        } catch (e4) {}
      }
      function promote() {
        if (!document.body || !node.parentNode) return;
        try {
          if (node.parentNode !== document.body) {
            document.body.insertBefore(node, document.body.firstChild);
          }
        } catch (eProm) {}
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', promote, { once: true });
      }
      var tries = 0;
      var poll = setInterval(function () {
        tries++;
        promote();
        if (document.body && node.parentNode === document.body) {
          clearInterval(poll);
          return;
        }
        if (tries > 400) clearInterval(poll);
      }, 25);
    }

    /* 按 tripContext（含 matches 数组）更新 banner 文案 */
    function _updateCopy(el, ctx) {
      if (!el || !ctx) return;
      var title = el.querySelector('.alpha-guard-fuse-title');
      if (!title) return;
      var line = formatFuseBannerTitle(ctx);
      if (line) title.textContent = line;
    }

    /* 创建新 banner 节点，或重新挂载已存在的节点 */
    function _ensureNode() {
      var el = document.getElementById(BANNER_ID);
      if (!el) {
        el = document.createElement('div');
        el.id        = BANNER_ID;
        el.className = 'alpha-guard-banner';
        el.setAttribute('data-alpha-guard', 'banner');
        el.innerHTML =
          '<div class="alpha-guard-fuse-inner">' +
            '<div class="alpha-guard-fuse-icon" aria-hidden="true">' +
              '<svg class="alpha-guard-fuse-svg" viewBox="0 0 24 24" fill="none">' +
                '<path d="M12 2L3 20h18L12 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
                '<path d="M12 9v5"              stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
                '<circle cx="12" cy="17" r="0.9" fill="currentColor"/>' +
              '</svg></div>' +
            '<div class="alpha-guard-fuse-text">' +
              '<div class="alpha-guard-fuse-title"></div>' +
            '</div>' +
            '<button type="button" class="alpha-guard-fuse-dismiss">忽略并继续</button>' +
          '</div>';
        _mount(el);
        var dismissBtn = el.querySelector('.alpha-guard-fuse-dismiss');
        if (dismissBtn) {
          dismissBtn.addEventListener('click', function () {
            console.log('[AlphaGuard][BannerManager] 用户点击「忽略并继续」');
            state.dismissed = true;
            restoreTradingUi();   // restoreTradingUi 内部会调用 destroyBanner
          });
        }
        console.log('[AlphaGuard][BannerManager] banner 节点已创建并挂载');
      } else {
        _mount(el);               // 可能被 React 移走，重新挂回来
      }
      window._bannerElement = el;
      return el;
    }

    /* ── 公开接口 ── */

    /**
     * 创建/挂载/显示 banner，同时写入 sessionStorage 记录当前路径
     * @param {object} ctx  { matches: [...] } 或兼容旧版单条
     * @returns {HTMLElement} banner 元素
     */
    function showBanner(ctx, opts) {
      if (
        state.tripped &&
        state.tripRouteKey &&
        getRouteKey() !== state.tripRouteKey
      ) {
        try {
          restoreTradingUi();
        } catch (eR) {}
        return null;
      }
      var quiet = opts && opts.quiet;
      var el = _ensureNode();
      _updateCopy(el, ctx);
      el.classList.add('alpha-guard-fuse-visible');
      try { el.style.setProperty('display', 'flex', 'important'); } catch (e) {}
      try { sessionStorage.setItem(SESSION_KEY, location.pathname); } catch (eS) {}
      if (!quiet) {
        var n = ctx && Array.isArray(ctx.matches) ? ctx.matches.length : ctx && ctx.address ? 1 : 0;
        console.log('[AlphaGuard][BannerManager] showBanner ✅', {
          matchCount: n,
          path:       location.pathname
        });
      }
      return el;
    }

    /**
     * 完全移除 banner DOM 节点，清除全局引用和 sessionStorage 标记
     * @returns {boolean} 清理是否成功
     */
    function destroyBanner() {
      var ok = false;
      try {
        var removed = 0;
        var nodes = document.querySelectorAll('#' + BANNER_ID);
        for (var i = nodes.length - 1; i >= 0; i--) {
          var n = nodes[i];
          if (n && n.parentNode) {
            try {
              n.parentNode.removeChild(n);
              removed++;
            } catch (eRm) {}
          }
        }
        if (removed > 0) {
          console.log(
            '[AlphaGuard][BannerManager] destroyBanner ✅ 已移除',
            removed,
            '个 banner 节点'
          );
        } else {
          console.log('[AlphaGuard][BannerManager] destroyBanner: banner 节点不存在，跳过');
        }
        ok = true;
      } catch (eDestroy) {
        console.warn('[AlphaGuard][BannerManager] destroyBanner ❌ 清理出错（不阻塞后续流程）:', eDestroy);
        ok = false;
      }
      window._bannerElement = null;
      try { sessionStorage.removeItem(SESSION_KEY); } catch (eS) {}
      return ok;
    }

    /**
     * 启动守卫定时器：每 1500ms 检查 banner 是否被 React 删掉或隐藏，若是则重建
     */
    function startWatchdog() {
      if (bannerWatchId != null) clearInterval(bannerWatchId);
      bannerWatchId = setInterval(function () {
        if (!state.tripped || state.dismissed) return;
        if (
          state.tripRouteKey &&
          getRouteKey() !== state.tripRouteKey
        ) {
          try {
            restoreTradingUi();
          } catch (eW) {}
          return;
        }
        var el = window._bannerElement;
        var inDom = el && document.contains(el);
        if (!inDom) {
          console.log('[AlphaGuard][BannerManager] watchdog: banner 丢失，重建');
          showBanner(state.tripContext, { quiet: true });
          return;
        }
        try {
          var visible = el.classList.contains('alpha-guard-fuse-visible') &&
                        getComputedStyle(el).display !== 'none';
          if (!visible) {
            console.log('[AlphaGuard][BannerManager] watchdog: banner 被隐藏，恢复');
            showBanner(state.tripContext, { quiet: true });
          }
        } catch (eCheck) {}
      }, 1500);
    }

    /** 停止守卫定时器 */
    function stopWatchdog() {
      if (bannerWatchId != null) {
        clearInterval(bannerWatchId);
        bannerWatchId = null;
      }
    }

    return {
      showBanner:    showBanner,
      destroyBanner: destroyBanner,
      startWatchdog: startWatchdog,
      stopWatchdog:  stopWatchdog
    };
  })();

  function lockTradingUi(opts) {
    var match = state.tripContext;
    if (!match) return;
    if (state.tripRouteKey && getRouteKey() !== state.tripRouteKey) {
      try {
        restoreTradingUi();
      } catch (eL) {}
      return;
    }
    BannerManager.showBanner(match, opts);
  }

  /** 熔断后只立即显示一次 + 短延迟再补一次；持续抢跑由 watchdog 负责（避免每 300ms 打日志、刷 DOM） */
  function scheduleLockTradingUiBurst() {
    if (lockBurstTimerId != null) {
      clearTimeout(lockBurstTimerId);
      lockBurstTimerId = null;
    }
    lockTradingUi();
    lockBurstTimerId = setTimeout(function () {
      lockBurstTimerId = null;
      if (state.tripped && !state.dismissed && state.tripContext) {
        lockTradingUi({ quiet: true });
      }
    }, 500);
  }

  function stopFuseRoutePoll() {
    if (fuseRoutePollId != null) {
      clearInterval(fuseRoutePollId);
      fuseRoutePollId = null;
    }
  }

  /** 熔断存续期间短周期比对路由，弥补 pushState 未触发、框架自定义导航等漏检 */
  function startFuseRoutePoll() {
    stopFuseRoutePoll();
    fuseRoutePollId = setInterval(function () {
      try {
        if (!state.tripped || state.dismissed) return;
        if (!state.tripRouteKey) return;
        if (getRouteKey() !== state.tripRouteKey) {
          console.log('[AlphaGuard] 路由指纹与熔断不一致，立即清理', {
            tripAt: state.tripRouteKey,
            now:    getRouteKey()
          });
          restoreTradingUi();
        }
      } catch (e) {}
    }, 200);
  }

  function restoreTradingUi() {
    stopFuseRoutePoll();
    try { BannerManager.destroyBanner(); } catch (eBanner) {
      console.warn('[AlphaGuard] restoreTradingUi: destroyBanner 出错（已捕获）', eBanner);
    }

    try {
      if (lockBurstTimerId != null) {
        clearTimeout(lockBurstTimerId);
        lockBurstTimerId = null;
      }
      BannerManager.stopWatchdog();
    } catch (eTimers) {
      console.warn('[AlphaGuard] restoreTradingUi: 停止定时器出错', eTimers);
    }

    try {
      if (!state || typeof state !== 'object') return;
      state.tripped      = false;
      state.dismissed    = false;
      state.tripContext  = null;
      state.tripRouteKey = null;
      tripAlertLogged    = false;
    } catch (eState) {
      console.warn('[AlphaGuard] restoreTradingUi: 重置 state 出错', eState);
    }

    console.log('[AlphaGuard] restoreTradingUi ✅ 完成');
  }

  function maybeTrip(entries) {
    if (!state.enabled) return;
    if (
      state.tripped &&
      state.tripRouteKey &&
      getRouteKey() !== state.tripRouteKey
    ) {
      restoreTradingUi();
    }
    if (state.tripped) return;
    var matches = getTripMatches(entries);
    if (!matches || matches.length === 0) return;
    state.tripped = true;
    state.dismissed = false;
    state.tripContext = { matches: matches };
    state.tripRouteKey = getRouteKey();
    if (!tripAlertLogged) {
      tripAlertLogged = true;
      console.log('🚨 Alpha Guard: 检测到高风险地址，已显示风险提示横幅。');
    }
    console.log('Alpha Guard Check:', entries);
    scheduleLockTradingUiBurst();
    BannerManager.startWatchdog();
    startFuseRoutePoll();
  }

  function fetchInputToUrl(input) {
    if (typeof input === 'string') return input;
    try {
      if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
  }

  function shouldParseFetchBody(res, url) {
    if (!shouldSniffHoldersResponse(url)) return false;
    try {
      var ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && ct.indexOf('json') === -1) return false;
      var cl = res.headers.get('content-length');
      if (cl != null && cl !== '') {
        var n = parseInt(cl, 10);
        if (isFinite(n) && n > 900000) return false;
      }
    } catch (eH) {
      return false;
    }
    return true;
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = fetchInputToUrl(input);
    var routeWhenStarted = getRouteKey();
    var p = nativeFetch.apply(this, arguments);
    if (!shouldSniffHoldersResponse(url)) return p;
    return p.then(function (res) {
      if (!shouldParseFetchBody(res, url)) return res;
      var clone = res.clone();
      clone
        .text()
        .then(function (text) {
          if (getRouteKey() !== routeWhenStarted) return;
          if (text && text.length > 900000) return;
          var entries = analyzeBodyText(text);
          maybeTrip(entries);
        })
        .catch(function () {});
      return res;
    });
  };

  var NativeXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new NativeXHR();
    var _open = xhr.open;
    var _send = xhr.send;
    var _url = '';
    xhr.open = function (method, url) {
      _url = typeof url === 'string' ? url : '';
      return _open.apply(xhr, arguments);
    };
    xhr.send = function (body) {
      if (shouldSniffHoldersResponse(_url)) {
        var routeWhenXhrSent = getRouteKey();
        xhr.addEventListener(
          'load',
          function () {
            try {
              if (getRouteKey() !== routeWhenXhrSent) return;
              var text = xhr.responseText || '';
              if (text.length > 900000) return;
              var ct = '';
              try {
                ct = (xhr.getResponseHeader('Content-Type') || '').toLowerCase();
              } catch (eCt) {}
              if (ct && ct.indexOf('json') === -1) return;
              var entries = analyzeBodyText(text);
              maybeTrip(entries);
            } catch (e) {}
          },
          { once: true }
        );
      }
      return _send.apply(xhr, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = NativeXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  /* ─────────────────────────────────────────────────────────────────
   * RouterWatcher — SPA 路由变化检测，三重机制确保不漏检
   *
   * 公开接口（挂到 window.AlphaGuardRouter）：
   *   manualClean()   供其他模块手动触发清理
   *   stop()          停止所有监听
   * ───────────────────────────────────────────────────────────────── */
  var RouterWatcher = (function () {
    var _lastRouteKey = getRouteKey();
    var _titleMo      = null;
    var _pollId       = null;

    function _onNavigate() {
      var key = getRouteKey();
      if (key === _lastRouteKey) return;
      var oldKey = _lastRouteKey;
      _lastRouteKey = key;

      console.log('[熔断插件] 路由切换，清理banner', {
        from:         oldKey,
        to:           key,
        bannerExists: !!window._bannerElement
      });

      restoreTradingUi();
    }

    function startWatching() {
      /* 机制1：hook pushState / replaceState（Next.js / React Router 主路径） */
      var _push    = history.pushState.bind(history);
      var _replace = history.replaceState.bind(history);
      history.pushState = function () {
        _push.apply(history, arguments);
        setTimeout(_onNavigate, 0);   // 延迟确保 location.pathname 已更新
      };
      history.replaceState = function () {
        _replace.apply(history, arguments);
        setTimeout(_onNavigate, 0);
      };

      /* 机制2：浏览器前进/后退按钮 */
      window.addEventListener('popstate', function () { setTimeout(_onNavigate, 0); });

      /* 机制2b：仅 hash 变化的路由 */
      window.addEventListener('hashchange', function () { setTimeout(_onNavigate, 0); });

      /* 机制3：MutationObserver 监听 <title>（document_start 时常尚无 <title>，需延迟挂载） */
      function tryAttachTitleMo() {
        try {
          if (_titleMo) return;
          var titleEl = document.querySelector('head > title');
          if (!titleEl) return;
          _titleMo = new MutationObserver(function () {
            setTimeout(_onNavigate, 50);
          });
          _titleMo.observe(titleEl, { childList: true, characterData: true, subtree: true });
          console.log('[AlphaGuard][RouterWatcher] MutationObserver 已挂载到 <title>');
        } catch (eMo) {
          console.warn('[AlphaGuard][RouterWatcher] MutationObserver 初始化失败:', eMo);
        }
      }
      tryAttachTitleMo();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryAttachTitleMo, { once: true });
      }

      /* 机制4：400ms 轮询兜底——覆盖一切绕过 pushState 的路由实现 */
      _pollId = setInterval(function () {
        if (getRouteKey() !== _lastRouteKey) _onNavigate();
      }, 400);

      console.log('[AlphaGuard][RouterWatcher] 启动 ✅（history hook + hash + title MO + 400ms 轮询）');
    }

    /** 停止所有监听，释放资源 */
    function stop() {
      if (_titleMo) { _titleMo.disconnect(); _titleMo = null; }
      if (_pollId)  { clearInterval(_pollId); _pollId  = null; }
      console.log('[AlphaGuard][RouterWatcher] 已停止');
    }

    /**
     * 手动触发清理接口，供其他模块（如 popup 消息）直接调用
     * @returns {boolean} 始终返回 true，错误不向上抛
     */
    function manualClean() {
      try {
        console.log('[AlphaGuard][RouterWatcher] manualClean 被调用', {
          currentRoute: getRouteKey(),
          bannerExists: !!window._bannerElement
        });
        _lastRouteKey = getRouteKey();
        restoreTradingUi();
      } catch (e) {
        console.warn('[AlphaGuard][RouterWatcher] manualClean 出错（已捕获）:', e);
      }
      return true;
    }

    return { startWatching: startWatching, stop: stop, manualClean: manualClean };
  })();

  RouterWatcher.startWatching();

  /* bfcache 返回或浏览器恢复：路由可能已变而内存状态仍 tripped */
  window.addEventListener('pageshow', function () {
    try {
      if (!state.tripped || state.dismissed || !state.tripRouteKey) return;
      if (getRouteKey() !== state.tripRouteKey) restoreTradingUi();
    } catch (ePs) {}
  });

  /* 暴露给外部模块（如 popup、其他 content script）手动触发清理 */
  window.AlphaGuardRouter = {
    manualClean: RouterWatcher.manualClean,
    stop:        RouterWatcher.stop
  };
})();
