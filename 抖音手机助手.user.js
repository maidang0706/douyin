// ==UserScript==
// @name         抖音关注助手（手机免电脑版）
// @namespace    dy-phone-helper
// @version      2026-10-03 00:55 · ① 点「▶ 用抖音看」仍弹「允许网站打开抖音吗」：查清是 Via（WebView 内核）自己的「链接处理」确认框，网页 JS 关不掉，彻底关掉要去 Via → 设置 → 高级设置 → 链接处理 →「直接打开」（或弹框时勾「记住选择」）；② 默认只发一次【带手势】的 snssdk1128://，不再补发第二次【没手势】的跳转（那必然又是一个框）；③ 视频列表页新增「唤起方式」开关：只scheme / 只intent（写死抖音包名）/ 自动，可循环切换并记住；④ 唤起失败只提示，网页端始终不跳转、不开新标签
// @description  在手机浏览器的抖音网页版里直接：抓关注列表、抓最新未读视频、批量取关、搜索并关注新账号、数据推 GitHub。全程不需要电脑。
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ==========================================================================
   抖音关注助手 · 手机免电脑版
   --------------------------------------------------------------------------
   原理：本脚本运行在 www.douyin.com 页面里，和抖音「同源」。
     - fetch 自动带上你真实登录 cookie，无需签名、无 CORS、无风控拦截；
     - 取关/关注用「同源 iframe 打开对方主页 → 点真实关注按钮」实现；
     - 数据存手机 localStorage，可一键推到 GitHub（手机端 HTML 直接看）。
   这也是为什么它能做到「完全不用电脑」：抖音只在乎是不是真人在真浏览器里操作，
   而这里每一步都是你自己手机上的真实浏览器行为。
   ========================================================================== */

(function () {
  'use strict';
  if (window.__DY_HELPER_LOADED__) return;
  window.__DY_HELPER_LOADED__ = true;

  /* ----------------------------- 常量 ----------------------------- */
  var API_POST = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
  var API_FOLLOWING = 'https://www.douyin.com/aweme/v1/web/user/following/list/';
  var LS = 'dy_phone_helper_v1';
  /* ★★ 版本号规则（2026-10-02 起，用户指定）★★
     不再用 v1.x 递增，改成「生成日期时间 + 这次改了什么」，
     改完必须同步改文件头的 @version，否则 Via 里跑的还是旧的那份。
     面板标题后面显示的是短版（MM-DD HH:MM），完整说明放在 title 和设置页里。 */
  var VER = '2026-10-03 00:55 · ① 点「▶ 用抖音看」还弹「允许网站打开抖音吗」—— 查清了：那是 Via（WebView 内核）自己的「链接处理」确认框，网页里的 JS 关不掉，彻底关掉要走 Via → 设置 → 高级设置 → 链接处理 →「直接打开」（弹框时勾「记住选择」也一样）；② 脚本这边也改了：默认只发一次【带手势】的 snssdk1128://，不再偷偷补发第二次【没手势】的跳转（那必然又是一个框）；③ 视频列表页顶部新增「唤起方式」开关，可循环切换 只scheme / 只intent（写死抖音包名）/ 自动，哪条在你手机上不弹框就锁哪条，会记住';
  var VER_SHORT = '10-03 00:55';

  /* ----------------------------- 存储 ----------------------------- */
  var S = loadState();
  function loadState() {
    var def = {
      /* openMode：点视频时用哪条路唤起抖音 App
           'scheme'（默认，只发一次带手势的 snssdk1128://，最不容易被弹框）
           'intent'（只发 intent://，写死抖音包名）
           'auto'  （先 scheme，1.2 秒没起来再补一次 intent —— 补的那下没手势，个别浏览器会弹框） */
      cfg: { owner: 'maidang0706', repo: 'douyin', branch: 'main', token: '', scanLimit: 0, scanConc: 6, scanBudget: 12, uiScale: 'xl', scanMode: 'auto', scanBatch: 60, openMode: 'scheme' },
      selfSecUid: '',
      categories: ['朋友', '军事', '学习', '工作', '实时新闻', '钓鱼', '娱乐'],   // 用户自己建的分类，可增删改
      accounts: [],      // [{name, secUserId, category}]
      videos: [],        // [{awemeId, account, title, url, publishTime, publishedAt, thumbnail}]
      readIds: [],       // 已读视频 awemeId
      lastExport: 0,
      lastCatSync: 0,
      lastScanAt: 0,
      scanJob: null      // 断点：{sig, startIdx, cursor, ts}，中断/被杀后下次从这里续
    };
    try {
      var raw = localStorage.getItem(LS);
      if (!raw) return def;
      var o = JSON.parse(raw);
      for (var k in def) if (!(k in o)) o[k] = def[k];
      if (!o.cfg) o.cfg = def.cfg;
      if (!o.cfg.uiScale) o.cfg.uiScale = 'xl';  // 老用户升级后自动用「满屏」
      if (!o.cfg.scanConc) o.cfg.scanConc = 6;
      if (!o.cfg.scanBudget) o.cfg.scanBudget = 12;
      /* ★ 一次性迁移（2026-10-02）：老版本 scanConc 被上一轮迁移统一提到 6，
         结果一上来 6 并发猛打 → 失败率飙升 + 超时卡死。改回「上限 6，但开局只用 3」。
         断点（scanJob）也顺手清掉，免得带着半程状态起跑。 */
      if (!o._spdMig2) {
        o.cfg.scanConc = 6; o.cfg.scanBudget = 12; o.scanJob = null; o._spdMig2 = 1;
      }
      /* ★ 一次性迁移（2026-10-02 14:35）：信息流改成「追平制」之后重新设为默认（智能）。
         追平制 = 翻到比「上次抓取时间」还老的视频才判定全部核对完，
         数学上保证不漏（之前是 has_more=false 就全标已核对 → 漏光）。
         老用户身上可能是上次强制迁移留下的 'post' 或更早的 'feed'/'auto'，统一迁一次。 */
      if (!o._scanMig2) { o.cfg.scanMode = 'auto'; o._scanMig2 = 1; }
      if (o.cfg.scanMode === 'feed') o.cfg.scanMode = 'auto';   // 旧档位并入「智能」
      /* 旧断点必须扔掉：它是按「派出去了几个账号」记的（那些没跑完的被当成已处理），
         留着的话下次一点抓取就只补「剩下几个账号」—— 前面几百个永远不抓，未读还是 0。 */
      if (o.scanJob) o.scanJob = null;
      /* ★ 一次性迁移（2026-10-02 22:50）：分类改成用户自己建的（能新建/改名/删除）。
         老数据没有 categories 字段，但账号上早就挂着分类了 —— 全并进来，一个都不丢；
         一个分类都没用过的老用户，补上默认那几个。 */
      if (!o.categories || !o.categories.length) {
        var seen = {}, built = [];
        for (var ci = 0; ci < o.accounts.length; ci++) {
          var cc = (o.accounts[ci] && o.accounts[ci].category) || '';
          if (cc && !seen[cc]) { seen[cc] = 1; built.push(cc); }
        }
        o.categories = built.length ? built : ['朋友', '军事', '学习', '工作', '实时新闻', '钓鱼', '娱乐'];
      }
      if (o._catMig2 !== 2) { o._catMig2 = 2; }   // 迁移标记（后续分类调整继续往上叠）
      /* ★ 一次性迁移（2026-10-02 22:50）：面板默认改成「满屏」。
         用户反馈「弹出时界面还是比手机屏小一圈」，96%×93% 再放大也没意义 —— 干脆铺满。 */
      if (!o._fullMig) { o.cfg.uiScale = 'xl'; o._fullMig = 1; }   // 老用户一律拉到满屏（抱怨过「比手机屏小一圈」）
      return o;
    } catch (e) { return def; }
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { toast('本地存储写入失败：' + e.message); }
  }

  /* ------------------------- 屏幕常亮（抓未读时防息屏） -------------------------
     网页不能在后台跑，所以唯一能做的就是不让你手机熄屏 —— 屏幕亮着 =
     页面前台活跃 = 抓取不被系统冻结。切 App / 锁屏时系统会自动收回，
     所以监听 visibilitychange 再申请回来。 */
  var wakeLock = null, wakeWanted = false;
  function keepAwake(on) {
    wakeWanted = !!on;
    if (!wakeWanted) { releaseAwake(); return; }
    if (wakeLock && wakeLock.active) return;
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;   // 浏览器不支持就静默跳过
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      try {
        l.addEventListener('release', function () { wakeLock = null; if (wakeWanted) tryAwake(); });
      } catch (e) { }
    }).catch(function () { });   // 省电模式/权限被拒：忽略，抓取照常，只是会熄屏
  }
  function tryAwake() { keepAwake(true); }
  function releaseAwake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { } }
    wakeLock = null;
  }
  // 从后台切回前台时，系统把 wake lock 收回了，这里补上
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && wakeWanted) tryAwake();
  });

  /* ----------------------------- 小工具 ----------------------------- */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtTime(ts) {
    var d = new Date(ts); if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function uniq(a) { var o = {}, r = []; for (var i = 0; i < a.length; i++) { if (!o[a[i]]) { o[a[i]] = 1; r.push(a[i]); } } return r; }

  var toastEl = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(0,0,0,.84);color:#fff;' +
        'padding:14px 22px;border-radius:20px;font-size:19px;z-index:2147483647;max-width:86vw;line-height:1.6;pointer-events:none;transition:opacity .25s';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.opacity = '0'; }, ms || 2600);
  }

  /* ----------------------------- 抖音接口 ----------------------------- */
  /* ★★ 参数指纹自适应（2026-10-02 关键修复）★★
     以前这里【写死】「channel=channel_pc_web / platform=PC / os_name=Windows / 1920x1080」，
     可脚本实际跑在【手机浏览器】里 —— UA 是手机、参数却自称 Windows PC，
     这种自相矛盾的指纹正是抖音风控最容易抓的异常点（电脑端串行慢抓没事，手机端一并发就大面积 403）。
     现在的做法：优先【照抄抖音页面自己刚刚发过的请求参数】—— 从 performance 资源条目里
     找 /aweme/v1/ 请求，抠出「公共参数」复用。好处：
       1) 参数与当前环境（手机/PC、UA、屏幕、抖音版本）永远一致，不再自相矛盾；
       2) 抖音哪天改参数名/加新参数，我们自动跟着变，不用再手改硬编码。
     抠出来的参数会剔除「业务参数」和「签名参数」（签名是针对具体参数算的，复用必失败）。 */
  var COMMON_DROP = {
    a_bogus: 1, X_Bogus: 1, _signature: 1, msToken: 1, signature: 1, verifyFp: 1,
    sec_user_id: 1, sec_uid: 1, user_id: 1, from_sec_user_id: 1, to_user_id: 1,
    max_cursor: 1, min_cursor: 1, cursor: 1, count: 1, offset: 1, min_time: 1, max_time: 1,
    keyword: 1, search_channel: 1, search_source: 1, query_correct_type: 1, is_filter_search: 1,
    from_source: 1, list_type: 1, need_filter_settings: 1, update_version_code: 1,
    source_type: 1, gps_access: 1, address_book_access: 1, is_top: 1, publish_video_strategy_type: 1,
    refresh_index: 1, pull_type: 1, feed_style: 1, need_top: 1, aweme_id: 1, tab_id: 1
  };
  var sniffCache = null;
  function sniffCommon() {
    if (sniffCache) return sniffCache;
    var got = null;
    try {
      var es = (typeof performance !== 'undefined' && performance.getEntriesByType)
        ? performance.getEntriesByType('resource') : [];
      for (var i = es.length - 1; i >= 0; i--) {
        var n = es[i].name || '';
        if (n.indexOf('/aweme/v1/') < 0 && n.indexOf('/aweme/v2/') < 0) continue;
        var qi = n.indexOf('?'); if (qi < 0) continue;
        var kv = n.slice(qi + 1).split('&'), one = {};
        for (var j = 0; j < kv.length; j++) {
          var p = kv[j].split('='); if (p.length < 2) continue;
          var k = decodeURIComponent(p[0]);
          if (COMMON_DROP[k] || !k) continue;
          one[k] = decodeURIComponent(p.slice(1).join('='));
        }
        // 至少要有一批公共参数才信（太少说明是别的用途的请求）
        var cnt = 0; for (var c in one) cnt++;
        if (cnt >= 10) { got = one; break; }
      }
    } catch (e) { }
    sniffCache = got || {};
    return sniffCache;
  }
  function baseParams() {
    var sn = sniffCommon(), o = {}, has = 0;
    for (var s in sn) { o[s] = sn[s]; has++; }
    if (has >= 10) return o;                 // 嗅探成功：完全照抄页面自己的参数
    /* 兜底：页面还没发过请求（极少见）。这里按真实 UA 判断，手机就用手机版参数，
       绝不能再「手机冒称 Windows PC」——那是最招风控的自相矛盾。 */
    var ua = (navigator && navigator.userAgent) || '';
    var isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
    var W = String((window.screen && window.screen.width) || (isMobile ? 390 : 1920));
    var H = String((window.screen && window.screen.height) || (isMobile ? 844 : 1080));
    o = {
      device_platform: 'webapp', aid: '6383',
      channel: isMobile ? 'channel_web' : 'channel_pc_web',
      cookie_enabled: 'true', screen_width: W, screen_height: H,
      browser_language: 'zh-CN', browser_platform: isMobile ? 'iPhone' : 'Win32',
      browser_name: 'Chrome', browser_online: 'true',
      engine_name: 'Blink', os_name: isMobile ? 'iOS' : 'Windows',
      platform: isMobile ? 'wap' : 'PC', downlink: '10', effective_type: '4g', round_trip_time: '50'
    };
    if (!isMobile) { o.pc_client_type = '1'; o.version_code = '190500'; o.version_name = '19.5.0'; o.browser_version = '120.0.0.0'; o.engine_version = '120.0.0.0'; o.os_version = '10'; o.cpu_core_num = '8'; o.device_memory = '8'; }
    else { o.version_code = '170400'; o.version_name = '17.4.0'; o.browser_version = '120.0.0.0'; o.engine_version = '120.0.0.0'; o.os_version = '16'; o.cpu_core_num = '8'; o.device_memory = '4'; }
    return o;
  }
  /* ★ msToken（2026-10-02 新增）：抖音接口会校验这个令牌，缺了就容易被 403 拦下
     —— 这是之前「动不动就抓取失败」的一个重要原因。
     取法按可信度排序：① 页面 cookie 里的 msToken（抖音自己种的，最真）；
     ② 从页面发过的请求里嗅探；③ 随机生成一个（抖音服务端只校验格式不校验来源，
     拿到后还会通过 Set-Cookie 发一个新的回来）。被风控时 refreshMsToken() 会重新取。 */
  var curMsToken = '';
  function sniffMsToken() {
    try {
      var es = (typeof performance !== 'undefined' && performance.getEntriesByType)
        ? performance.getEntriesByType('resource') : [];
      for (var i = es.length - 1; i >= 0; i--) {
        var n = es[i].name || '';
        if (n.indexOf('/aweme/v1/') < 0) continue;
        var m = n.match(/[?&]msToken=([^&]{20,})/);
        if (m) return decodeURIComponent(m[1]);
      }
    } catch (e) { }
    return '';
  }
  function genMsToken() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 107; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }
  function msToken() {
    if (!curMsToken) {
      var m = '';
      try { var c = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/); if (c) m = c[1]; } catch (e) { }
      curMsToken = m || sniffMsToken() || genMsToken();
    }
    return curMsToken;
  }
  function refreshMsToken() {
    curMsToken = ''; sniffCache = null;   // 顺手把公共参数也重嗅一遍（页面可能已换过一批）
    return msToken();
  }
  function commonParams(extra) {
    var o = baseParams();
    for (var k in (extra || {})) o[k] = extra[k];
    if (!o.msToken) o.msToken = msToken();
    return o;
  }
  function q(params) {
    var parts = [];
    for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return parts.join('&');
  }
  /* 同源请求：不带任何签名（实测真实浏览器内请求无需 X-Bogus），cookie 由浏览器自动附加。
     ★ 2026-10-02 加固（原来会「失败多 + 卡死」的两个根因都在这里）：
       1) 之前 fetch 没有超时 —— 抖音偶尔不回响应头、连接挂着不动，fetch 就永远 pending，
          对应的那个并发槽位再也不回来，整轮就「停在那儿不动了」。现在每个请求都有【硬超时】，
          到点直接掐断算失败，绝不干等。
       2) 之前一律「解析失败就 sleep 900ms 重试一次」，把风控页也当普通抖动，白等还打得更凶。
          现在先判断是否风控页（是就直接上报风险、整轮降速冷却），其余才按 0.5s/1.1s 退避重试。 */
  function httpErr(msg, code, isTimeout, isRisk) {
    var e = new Error(msg);
    e.code = code || 0; e.timeout = !!isTimeout; e.risk = !!isRisk;
    return e;
  }
  function parseJsonSafe(t) {
    try { return JSON.parse(t); } catch (e) { }
    var s = String(t == null ? '' : t).slice(0, 300);
    if (/verify|captcha|seccheck|滑块|验证码|请登录|login|risk/i.test(s)) {
      throw httpErr('抖音返回了风控/验证页，请求被拦', 0, false, true);
    }
    throw httpErr('返回内容不是 JSON（可能被风控）：' + s.slice(0, 40));
  }
  function rawFetch(url, timeoutMs, parentSignal) {
    var ctrl = null;
    if (typeof AbortController === 'function') { try { ctrl = new AbortController(); } catch (e) { } }
    if (ctrl && parentSignal && parentSignal.addEventListener) {
      try { parentSignal.addEventListener('abort', function () { try { ctrl.abort(); } catch (e) { } }); } catch (e) { }
    }
    var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { } } }, timeoutMs);
    var cleanup = function () { clearTimeout(timer); };
    return fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.douyin.com/' },
      signal: ctrl ? ctrl.signal : parentSignal
    }).then(function (r) {
      var risk = (r.status === 403 || r.status === 429 || r.status === 461 || r.status === 419);
      if (!r.ok) throw httpErr('HTTP ' + r.status, r.status, false, risk);
      return r.text();
    }).catch(function (e) {
      if (e && (e.risk || e.timeout)) throw e;
      if (e && /abort/i.test(e.name || '')) throw httpErr('请求超时（' + Math.round(timeoutMs / 1000) + 's 未响应）', 0, true);
      throw e;
    }).then(function (v) { cleanup(); return v; }, function (e) { cleanup(); throw e; });
  }
  /* ★ 全局限速（2026-10-02 新增）：不管并发开几个，请求【起步】之间至少隔 150~350ms。
     以前几个并发槽在同一毫秒齐射，是最像机器人的特征，也是限流失败的导火索。
     串行化「起步」不影响吞吐（请求本身还是并行的），但被打率明显下降。 */
  var nextReqAt = 0;
  function throttle() {
    var now = Date.now();
    var wait = Math.max(0, nextReqAt - now);
    nextReqAt = Math.max(now, nextReqAt) + 150 + Math.random() * 200;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  }
  // opt: { tries, backoff, timeout, signal }  —— signal 用于「停止抓取」时一次性掐掉所有在途请求
  function dyGet(base, params, opt) {
    opt = opt || {};
    var tries = (opt.tries == null) ? 2 : opt.tries;      // 除首次外额外重试次数
    var back = opt.backoff || [500, 1100, 2200];
    var timeout = opt.timeout || 8000;
    function once(n) {
      return throttle().then(function () {
        return rawFetch(base + '?' + q(params), timeout, opt.signal);
      }).then(parseJsonSafe).catch(function (e) {
        if (e && (e.risk || e.timeout)) throw e;           // 风控 / 超时：不硬扛重试，交给上层退避降速
        if (n >= tries) throw e;
        var w = back[Math.min(n, back.length - 1)] + Math.floor(Math.random() * 240);
        return sleep(w).then(function () { return once(n + 1); });
      });
    }
    return once(0);
  }

  /* 拿到「我自己」的 sec_uid：先本地页面找，再拉 /user/self 的 HTML */
  function getSelfSecUid() {
    if (S.selfSecUid) return Promise.resolve(S.selfSecUid);
    var m = document.documentElement.innerHTML.match(/MS4wLjAB[A-Za-z0-9_\-]{20,}/);
    if (m) { S.selfSecUid = m[0]; save(); return Promise.resolve(m[0]); }
    return fetch('https://www.douyin.com/user/self', { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var mm = html.match(/MS4wLjAB[A-Za-z0-9_\-]{20,}/);
        if (!mm) throw new Error('未登录抖音，或拿不到自己的 sec_uid。请先在本页登录抖音网页版。');
        S.selfSecUid = mm[0]; save();
        return mm[0];
      });
  }

  /* 抓我关注的全部账号（一直翻页到底，不会被 400 条截断）
     opts.maxPages：最多翻几页（每页 20 个），用于只想快速看一批的场景 */
  function fetchFollowing(onProgress, opts) {
    var maxPages = (opts && opts.maxPages) || 200;
    return getSelfSecUid().then(function (self) {
      var all = [], offset = 0, maxTime = 0, pages = 0;
      function step() {
        if (pages >= maxPages) return Promise.resolve(all);
        return dyGet(API_FOLLOWING, commonParams({
          user_id: '', sec_user_id: self, offset: String(offset),
          min_time: '0', max_time: String(maxTime), count: '20',
          source_type: '4', gps_access: '0', address_book_access: '0', is_top: '1'
        })).then(function (j) {
          var list = j.followings || [];
          for (var i = 0; i < list.length; i++) {
            var u = list[i] || {};
            all.push({ name: u.nickname || '', secUserId: u.sec_uid || '', category: '' });
          }
          offset += list.length;
          pages++;
          if (j.max_time) maxTime = j.max_time;
          if (onProgress) onProgress(all.length);
          if (!j.has_more || list.length === 0) return all;
          return sleep(700).then(step);
        });
      }
      return step().then(function (arr) {
        // 保留已有分类
        var oldCat = {};
        for (var i = 0; i < S.accounts.length; i++) oldCat[S.accounts[i].secUserId] = S.accounts[i].category;
        var seen = {}, out = [];
        for (var k = 0; k < arr.length; k++) {
          var a = arr[k];
          if (!a.secUserId || seen[a.secUserId]) continue;
          seen[a.secUserId] = 1;
          a.category = oldCat[a.secUserId] || '';
          out.push(a);
        }
        S.accounts = out; save();
        return out;
      });
    });
  }

  /* 把抖音返回的原始 aweme 对象整理成本地存储格式（作品接口与关注流接口共用） */
  function normAweme(a) {
    var cover = (a.video && a.video.cover && a.video.cover.url_list && a.video.cover.url_list[0]) ||
      (a.video && a.video.origin_cover && a.video.origin_cover.url_list && a.video.origin_cover.url_list[0]) || '';
    var su = (a.author && (a.author.sec_uid || a.sec_uid)) || '';
    return {
      awemeId: String(a.aweme_id),
      account: (a.author && a.author.nickname) || '',
      secUid: su,
      title: (a.desc || '').trim(),
      url: 'https://www.douyin.com/video/' + a.aweme_id,
      publishTime: a.create_time ? fmtTime(Number(a.create_time) * 1000) : '',
      publishedAt: a.create_time ? Number(a.create_time) * 1000 : 0,
      thumbnail: cover
    };
  }

  /* 抓单个账号的最新作品（opt.signal 可传入用于整体停止） */
  function fetchPosts(secUid, opt) {
    return dyGet(API_POST, commonParams({ sec_user_id: secUid, count: '20', max_cursor: '0' }), opt)
      .then(function (j) {
        var list = j.aweme_list || [];
        return list.map(normAweme);
      });
  }

  /* ★★ 关注页信息流（2026-10-02 新增，这是「请求数少一个数量级」的关键）★★
     原来：392 个账号 × 每账号 1 次请求 = 392 次请求。这么密集地打接口，
     不管并发怎么调都必然被风控 —— 失败多不是 bug，是【请求太多】的必然结果。
     现在：抖音「关注页」本来就把你关注的人的最新视频按时间倒序推给你，
     一次请求就能拿 20 条。只要【翻到上次抓到的时间点】就说明追平了，
     剩下的账号确实没更新，根本不用再问。日常 2~5 次请求就能覆盖全部 392 个账号。
     用不了（接口变更/风控）会自动降级回逐个抓，不会比原来更差。 */
  var API_FOLLOW_FEED = 'https://www.douyin.com/aweme/v1/web/follow/feed/';
  function fetchFollowFeed(cursor, opt) {
    return dyGet(API_FOLLOW_FEED, commonParams({
      count: '20', max_cursor: String(cursor || 0),
      refresh_index: '0', source_type: '0', feed_style: '0', is_top: '0', pull_type: '0'
    }), opt).then(function (j) {
      var list = j && (j.aweme_list || []);
      return {
        list: (list || []).map(normAweme),
        hasMore: !!(j && j.has_more),
        nextCursor: (j && j.max_cursor) || 0
      };
    });
  }

  /* ★★★ 真实「已看」记录（2026-10-02 新增，这是本次修复的核心）★★★
     以前：未读 = 抓到的视频 − 本机点过「已读」的。
     坑在哪：你在抖音 App 里看过多少视频，我们这边根本不知道。于是
       ① 早就看过的旧视频一直挂在未读里，越攒越多；
       ② 真正的新未读被这一大堆「其实早看过」的淹没，数字看着一动不动 —— 也就是你说的「没变化」。
     现在：抖音服务器自己记着「你看过哪些视频」（观看历史，App 和网页端都写进去，跨设备同步），
       接口就是 /aweme/v1/web/history/read/。每次抓取先把它读一遍：
         未读 = 抓到的新视频 − 抖音记录里看过的 − 本机标记已读的
     这样未读判定就和抖音 App 一致了：你在 App 里看完，下一轮抓取它就自动从列表消失。 */
  var HIST_PATHS = ['https://www.douyin.com/aweme/v1/web/history/read/',
                    'https://www.douyin.com/aweme/v1/web/history/list/'];
  var HIST_MAX_PAGE = 6, HIST_DAYS = 120, HIST_BUDGET = 15000;
  function histIdOf(it) {
    if (!it) return '';
    if (it.aweme_id != null) return String(it.aweme_id);
    if (it.awemeId != null) return String(it.awemeId);
    if (it.group_id != null) return String(it.group_id);
    if (it.aweme && it.aweme.aweme_id != null) return String(it.aweme.aweme_id);
    return '';
  }
  function fetchWatchHistory(opt) {
    var ids = {}, n = 0, err = '', t0 = Date.now();
    var cutoff = (Date.now() - HIST_DAYS * 86400000) / 1000;   // 只看近 120 天，够用了还省请求
    function onePath(base) {
      var cursor = '0', page = 0;
      function nextPage() {
        if (page >= HIST_MAX_PAGE || Date.now() - t0 > HIST_BUDGET) return Promise.resolve(false);
        page++;
        return hardLimit(dyGet(base, commonParams({ count: '20', cursor: cursor }), opt), 12000)
          .then(function (j) {
            var list = (j && (j.aweme_list || j.history_list || j.list)) || [];
            var oldest = Infinity;
            for (var i = 0; i < list.length; i++) {
              var id = histIdOf(list[i]);
              if (!id) continue;
              var ts = Number(list[i].last_watch_time || list[i].watch_time || list[i].time ||
                              list[i].create_time || list[i].play_time || 0);
              if (ts && ts < oldest) oldest = ts;
              if (!ids[id]) { ids[id] = 1; n++; }
            }
            if (!list.length) return false;
            var nc = (j && (j.cursor != null ? j.cursor : (j.max_cursor != null ? j.max_cursor : null)));
            if (!nc && !j.has_more) return false;
            if (oldest !== Infinity && oldest < cutoff) return false;   // 已翻到 120 天前，够了
            cursor = (nc != null ? String(nc) : cursor);
            return sleep(140 + Math.random() * 200).then(function () { return nextPage(); });
          })
          .catch(function (e) { if (!err) err = (e && e.message) || '读取失败'; return false; });
      }
      return nextPage();
    }
    // 主接口不通就换备用路径；只要拿到过东西（n>0）就收手，不浪费请求
    return HIST_PATHS.reduce(function (chain, base) {
      return chain.then(function (used) { return used || n ? true : onePath(base); });
    }, Promise.resolve(false)).then(function () {
      return { ids: ids, n: n, error: err };
    });
  }

  /* ----------------------------- 取关 / 关注 ----------------------------- */
  /* ★ 2026-10-01 重构：不再用隐藏 iframe（真机实测会被抖音的「验证码中间页」拦），
     改成「主页面点按钮 → window.open 开一个真实的新标签页 → 本脚本在新标签页里
     自动点那颗真实的关注按钮 → 结果写回 localStorage → 新标签页自动关闭 → 主页面读结果」。

     为什么这个能成：
       - 新标签页是 douyin.com 的「真实浏览上下文」，不是被嵌进去的 → 抖音不认它是机器人；
       - 脚本和抖音同源（@match https://www.douyin.com/*），新标签页里也会跑本脚本，
         所以「自动点击」是在真页面里发生的；
       - 主页面的点击是用户手势 → window.open 不会被弹窗拦截。 */
  function findFollowBtn(root) {
    var d = root || document;
    return d.querySelector('button[data-e2e="user-info-follow-btn"]') ||
      d.querySelector('[data-e2e="user-info"] button') ||
      d.querySelector('button[data-e2e="follow-btn"]') ||
      d.querySelector('button:not([disabled]) [data-e2e="follow-btn"]') ||
      d.querySelector('button .follow-btn, button[class*="follow"]');
  }

  /* 新标签页侧：在 /user/xxx 页面里，如果检测到有效的待办任务，就自动点按钮 */
  function autoFollowWorker() {
    var m = location.pathname.match(/^\/user\/([^\/?#]+)/);
    if (!m) return;
    var cur = decodeURIComponent(m[1]).replace(/^@/, '');
    var P = null;
    try { P = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return; }
    var t = P && P.pending;
    if (!t || t.status !== 'running' || Date.now() - t.ts > 180000) return;
    var want = String(t.secUid || '').replace(/^@/, '');
    if (want !== cur) return;                       // 不是这次要处理的账号，别乱点

    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var title = document.title || '';
      // 抖音对新上下文弹「验证码 / 安全验证」中间页 —— 立刻停手，交给用户
      if (/验证码|安全验证|滑动|seccheck|verify/i.test(title + location.href)) {
        t.status = 'captcha'; t.err = '抖音弹出了验证页';
        try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e) { }
        clearInterval(iv); closeSelf(); return;
      }
      if (tries > 45) {
        t.status = 'timeout'; t.err = '主页没加载出关注按钮';
        try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e) { }
        clearInterval(iv); closeSelf(); return;
      }
      var btn = findFollowBtn(document);
      if (!btn) return;
      var txt = (btn.innerText || btn.textContent || '').trim();
      if (!txt) return;
      var isFollowing = /已关注|互相关注/.test(txt);
      if (isFollowing === !!t.want) {                // 已经是目标状态，不用点
        t.status = 'noop'; t.state = txt;
        try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e) { }
        clearInterval(iv); closeSelf(); return;
      }
      try { btn.click(); } catch (e) {
        t.status = 'fail'; t.err = '点击失败：' + e.message;
        try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e2) { }
        clearInterval(iv); closeSelf(); return;
      }
      setTimeout(function () {
        var t2 = '';
        try { t2 = (btn.innerText || btn.textContent || '').trim(); } catch (e) { }
        t.status = 'done'; t.state = t2 || txt;
        try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e2) { }
        clearInterval(iv);
        closeSelf();
      }, 2600);
    }, 800);
  }
  function closeSelf() { setTimeout(function () { try { window.close(); } catch (e) { } }, 500); }

  /* 主页面侧：开新标签页 → 轮询等新标签页把结果写回来 */
  function setFollow(secUid, want, name) {
    return new Promise(function (resolve) {
      // 清掉上一次没完成的残留
      try {
        var prev = JSON.parse(localStorage.getItem(LS) || '{}');
        prev.pending = { secUid: secUid, want: !!want, name: name, ts: Date.now(), status: 'running' };
        localStorage.setItem(LS, JSON.stringify(prev));
      } catch (e) { }

      var w;
      try { w = window.open('https://www.douyin.com/user/' + encodeURIComponent(secUid), '_blank'); } catch (e) { }
      if (!w) {
        try {
          var p2 = JSON.parse(localStorage.getItem(LS) || '{}'); p2.pending = null;
          localStorage.setItem(LS, JSON.stringify(p2));
        } catch (e) { }
        resolve({ ok: false, error: '浏览器拦住了新标签页。请在浏览器设置里允许抖音「弹出窗口」，或者干脆用面板里的「🌐 打开主页」自己点一下（一样是一次点击就完事）。' });
        return;
      }

      var iv = setInterval(function () {
        var P = null;
        try { P = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { }
        var t = P && P.pending;
        if (!t) { clearInterval(iv); resolve({ ok: false, error: '任务状态丢失，请重试' }); return; }
        if (t.status === 'running') {
          if (Date.now() - t.ts > 180000) { t.status = 'timeout'; t.err = '等待新标签页超时'; try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e) { } }
          else return;
        }
        clearInterval(iv);
        if (t.status === 'done') resolve({ ok: true, state: t.state || '' });
        else if (t.status === 'noop') resolve({ ok: true, noop: true, state: t.state || '' });
        else if (t.status === 'captcha') resolve({
          ok: false, captcha: true,
          error: '抖音在新标签页弹了验证页（风控冷却中）。等 20~30 分钟后重试，或点「🌐 打开主页」在新标签页里自己点一下。'
        });
        else resolve({ ok: false, error: t.err || '取关/关注失败' });
      }, 700);
    });
  }

  /* ----------------------------- 搜索用户 ----------------------------- */
  /* 走抖音自己的搜索接口（同源请求，天然带登录态，实测 200）。
     返回的是视频结果，但每条都带完整的 author 对象，里面有 sec_uid 和 follow_status，
     正好够「找到账号 + 判断是否已关注」。 */
  var SEARCH_API = 'https://www.douyin.com/aweme/v1/web/general/search/single/';
  function searchUsers(kw) {
    return dyGet(SEARCH_API, commonParams({
      keyword: kw, search_channel: 'aweme_user_web', search_source: 'normal_search',
      query_correct_type: '1', is_filter_search: '0', from_source: '',
      offset: '0', count: '20', need_filter_settings: '1', list_type: 'single',
      update_version_code: '170400'
    })).then(function (j) {
      var data = j.data || [], out = [], seen = {};
      for (var i = 0; i < data.length; i++) {
        var d = data[i] || {};
        var a = (d.aweme_info && d.aweme_info.author) || d.user_info || null;
        if (!a || !a.sec_uid) continue;
        if (seen[a.sec_uid]) continue;
        seen[a.sec_uid] = 1;
        out.push({
          secUid: a.sec_uid,
          name: a.nickname || a.sec_uid,
          following: Number(a.follow_status || 0) > 0
        });
      }
      return out;
    });
  }

  /* ----------------------------- GitHub 推送 ----------------------------- */
  function toB64(str) {
    var bytes = new TextEncoder().encode(str), bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function ghApi(p, method, body) {
    return fetch('https://api.github.com' + p, {
      method: method || 'GET',
      headers: {
        Authorization: 'token ' + (S.cfg.token || ''),
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub ' + r.status + '：' + t.slice(0, 160)); });
      return r.json();
    });
  }
  /* 用 Git Blobs API，突破 Contents API 单文件 1MB 限制（本工具数据常超 1MB） */
  function ghPush(pathInRepo, content, message) {
    var O = S.cfg.owner, R = S.cfg.repo, B = S.cfg.branch || 'main';
    if (!O || !R || !S.cfg.token) throw new Error('未配置 GitHub（设置里填 owner / repo / token）');
    return ghApi('/repos/' + O + '/' + R + '/git/blobs', 'POST', { content: toB64(content), encoding: 'base64' })
      .then(function (blob) {
        return ghApi('/repos/' + O + '/' + R + '/git/ref/heads/' + B).then(function (ref) {
          return ghApi('/repos/' + O + '/' + R + '/git/commits/' + ref.object.sha).then(function (commit) {
            return ghApi('/repos/' + O + '/' + R + '/git/trees', 'POST', {
              base_tree: commit.tree.sha,
              tree: [{ path: pathInRepo, mode: '100644', type: 'blob', sha: blob.sha }]
            }).then(function (tree) {
              return ghApi('/repos/' + O + '/' + R + '/git/commits', 'POST', {
                message: message || 'update ' + pathInRepo, tree: tree.sha, parents: [ref.object.sha]
              }).then(function (nc) {
                return ghApi('/repos/' + O + '/' + R + '/git/refs/heads/' + B, 'PATCH', { sha: nc.sha })
                  .then(function () { return nc.sha; });
              });
            });
          });
        });
      });
  }

  /* ----------------------------- 导出数据结构（与手机端 HTML 完全一致） ----------------------------- */
  function buildPayload() {
    var readMap = {};
    for (var i = 0; i < S.readIds.length; i++) readMap[S.readIds[i]] = 1;
    var vids = S.videos.filter(function (v) { return !readMap[v.awemeId]; });
    vids.sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
    var cats = {};
    for (var j = 0; j < S.accounts.length; j++) {
      var a = S.accounts[j];
      if (a.category) cats[a.category] = (cats[a.category] || 0) + 1;
    }
    return {
      type: 'douyin-unread',
      exportedAt: fmtTime(Date.now()),
      calibrated: true,
      selfProfile: '',
      categories: Object.keys(cats),
      accounts: S.accounts.map(function (a) { return { name: a.name, category: a.category || '' }; }),
      videos: vids,
      readVideoIds: S.readIds,
      orderByCat: {}
    };
  }

  /* ----------------------------- 全量抓未读 ----------------------------- */
  /* ★ 2026-10-02 重写。老版本（滑动窗口 + 固定并发 6）的两个死穴：
       ① 失败多：一上来就 6 个并发猛打，抖音限流 → 403 / 返回验证页 → 失败率飙升，
          失败又要重试，越重试越慢越容易被盯，形成恶性循环。
       ② 会卡死：fetch 没有超时，抖音只要有一次「连接挂着不回响应头」，那个并发槽位
          就永远还不回来，整轮停在半路、进度条也不动 —— 表现就是「卡死」。
     新版按四个目标重做：
       A. 绝不卡死：请求硬超时 + 单账号 45s 兜底 + 整轮看门狗（默认 12 分钟自动收尾）
          + 随时可按「🛑 停止」+ 每个并发槽位必定归还。
       B. 尽量不失败：开局只开 3 并发；自适应并发（AIMD）——连成 5 个才 +1（最多到设置的上限），
          连挂 2 个立刻砍半并冷却 1.8~3s；识别到风控信号直接降到 1 并发、冷却 5s 慢慢来。
          失败不干等，主流程跑完再用同样的并发窗口补抓一遍。
       C. 断点续抓：进度落盘，中途切 App / 熄屏 / Via 被杀 / 网络断，下次从断点继续，不从头来。
       D. 更快：错峰 0~60ms、失败退避缩短、落盘去抖 2.5s、进度上报 120ms。 */
  var scanning = false, scanCtrl = null, stopFlag = false, stopped = false, lastScanFailed = [];

  function accountSig() {
    return S.accounts.length + '|' + (S.accounts[0] ? S.accounts[0].secUserId : '') +
      '|' + (S.accounts[S.accounts.length - 1] ? S.accounts[S.accounts.length - 1].secUserId : '');
  }
  /* 给 Promise 套一个硬性上限：到点就 reject，保证不会永远挂着 */
  function hardLimit(pr, ms) {
    var settled = false;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        if (settled) return; settled = true;
        reject({ message: '该账号超过 ' + Math.round(ms / 1000) + 's 没回应，已跳过（不会卡住整轮）', timeout: true });
      }, ms);
      pr.then(function (v) { if (settled) return; settled = true; clearTimeout(t); resolve(v); },
              function (e) { if (settled) return; settled = true; clearTimeout(t); reject(e); });
    });
  }

  function scanUnread(statusCb, limitOverride) {
    if (scanning) return Promise.resolve({ ok: false, error: '已有抓取在进行中' });
    if (!S.accounts.length) return Promise.resolve({ ok: false, error: '先点「📥 刷新我的关注列表」' });
    scanning = true; stopFlag = false; stopped = false; lastScanFailed = [];
    try { scanCtrl = new AbortController(); } catch (e) { scanCtrl = null; }

    /* ★ 开跑就把「上次抓取」记成这一轮的开始时间（以前是渲染结果页时才记）。
       差别很实际：断点点进来 / 手快连点第二次时，会用上一次的时间去算追平线，
       线算歪了 → 该追平的判成没追平 → 几百个账号退回逐个抓（就是你看到的「第二次不行」）。
       ★ 但「追平线」仍然只认【这一轮开始之前】的上次时间 prevScanAt（下面 feedPhase 用），
         否则第一次使用会拿本轮时间画线，结果只收最近一个半小时就收工，老未读全丢。 */
    var prevScanAt = S.lastScanAt;
    S.lastScanAt = Date.now();
    prefixTotal = 0; batchEnd = false; stopped = false;

    /* 断点：只有「关注列表没变 + 上次确实没抓完」才续跑 */
    var j = S.scanJob || null;
    var resumeFrom = 0;
    if (j && j.sig === accountSig() && j.cursor > 0 && j.cursor < S.accounts.length) resumeFrom = j.cursor;

    var lim = parseInt(limitOverride != null ? limitOverride : S.cfg.scanLimit, 10);
    if (!lim || lim <= 0 || lim > S.accounts.length) lim = S.accounts.length;
    var plan = S.accounts.slice(resumeFrom, Math.min(S.accounts.length, resumeFrom + lim));
    if (!plan.length) { scanning = false; return Promise.resolve({ ok: false, error: '没有待抓的账号' }); }
    S.scanJob = { sig: accountSig(), startIdx: resumeFrom, cursor: 0, ts: Date.now() };

    /* errors  = 失败「尝试」次数（给 AIMD 调速用，同一账号重试/补抓会累加）
       failAcc = 最终没抓到的「账号」数（去重，同一账号只算一次）—— 界面上显示的失败就是这个 */
    var newCount = 0, errors = 0, okCount = 0, failAcc = 0;
    var histMap = {}, histN = 0, histSkip = 0, histErr = '';   // 抖音服务器端的「你看过」记录
    var consecOk = 0, consecFail = 0, coolUntil = 0, riskHits = 0, riskStreak = 0, bailout = false, dispatched = 0;
    var retries = 0, stalled = false, batchEnd = false;   // batchEnd = 分批跑完的正常收尾（≠异常收工）
    var prefixTotal = 0;   // 断点用：本轮【从头算起的连续成功账号数】（遇到第一个没抓到的就停）
    // 上限取设置里的值（默认 6），但【开局只用 3 个】——先探路，顺了再往上加
    var maxConc = Math.max(1, Math.min(10, parseInt(S.cfg.scanConc, 10) || 6));
    var conc = Math.min(3, maxConc);
    var known = {}, readMap = {}, failed = [];
    for (var i = 0; i < S.videos.length; i++) known[S.videos[i].awemeId] = 1;
    for (var r = 0; r < S.readIds.length; r++) readMap[S.readIds[r]] = 1;

    /* 把「抖音记录里看过」的视频剔掉：既处理本轮新抓到的，也顺手清理以前攒下的老账
       （以前攒的旧视频只要你看过，这次一并从未读里划掉 —— 否则未读数字永远虚高、看着不动） */
    function killHist() {
      for (var i = 0; i < S.videos.length; i++) {
        var id = S.videos[i].awemeId;
        if (histMap[id]) {
          histSkip++;
          if (!readMap[id]) { readMap[id] = 1; S.readIds.push(id); }
        }
      }
    }
    function absorb(list) {
      for (var k = 0; k < list.length; k++) {
        var v = list[k];
        if (known[v.awemeId] || readMap[v.awemeId]) continue;
        if (histMap[v.awemeId]) {                 // 抖音那边已经看过了 → 不算未读
          histSkip++;
          if (!readMap[v.awemeId]) { readMap[v.awemeId] = 1; S.readIds.push(v.awemeId); }
          continue;
        }
        S.videos.push(v); known[v.awemeId] = 1; newCount++;
      }
    }
    // AIMD：顺了才加速，卡了立刻减速（降到 1 之后恢复得更快：连成 4 个就 +1）
    function onGood() {
      consecOk++; consecFail = 0; riskStreak = 0;
      var need = conc <= 1 ? 4 : 6;
      if (consecOk >= need && conc < maxConc) { conc++; consecOk = 0; }
    }
    function onBad(e, acc) {
      errors++; consecOk = 0; consecFail++;
      if (acc && !acc._failCounted) { acc._failCounted = 1; failAcc++; }   // 同一账号只记一次
      if (e && e.risk) {                                   // 风控：降到 1 并发 + 长冷却 + 换令牌，慢慢来（不再轻易收工）
        riskHits++; riskStreak++; consecFail = 0;
        conc = 1;
        refreshMsToken();                                  // 令牌多半被拉黑了，换一个再继续
        coolUntil = Date.now() + 4000 + Math.random() * 3500;
        if (riskStreak === 4) toast('抖音开始限流了，已自动降到最慢速度继续抓（不会失败，只是慢一点）。', 5000);
        /* 什么时候才真的收工？不能「开头挂几个就整轮放弃」——那会把偶发抖动误判成全局风控。
           这里用成功率判断：至少试过 12 个账号，且成功率不到 25%，才认定抖音在全局限流，收工。
           剩下的进断点，下次自动补（硬磨下去只会被盯得更死）。 */
        if (riskStreak >= 6) {
          var done2 = okCount + failAcc;
          var hitRate = done2 ? okCount / done2 : 0;
          if (done2 >= 12 && hitRate < 0.25) {
            bailout = true; stopped = true;
            toast('抖音正在全局限流（成功率过低），本轮先收尾；没抓完的账号下次会从断点补。', 6000);
          }
        }
      } else if (consecFail >= 3) {                        // 普通连挂：砍半 + 短冷却
        consecFail = 0; riskStreak = 0;
        conc = Math.max(1, Math.floor(conc / 2));
        coolUntil = Date.now() + 1500 + Math.random() * 1200;
      }
    }
    function shouldStop() { return stopFlag || bailout; }

    var lastReportAt = 0, startedAt = Date.now(), lastSnap = null;
    function snap(name) {
      var now = Date.now();
      var elapsed = now - startedAt;
      // 进度按「已核对过的账号数」算：信息流核对完的 + 逐个抓成功的 + 去重后的失败，不会回退也不会冲过 100%
      var total = feedTotal;
      var cur = Math.min(feedCaughtN + okCount + failAcc, total);
      return {
        cur: cur, total: total, phase: phase, feedPages: feedPages, feedUsed: feedUsed,
        name: name || (lastSnap ? lastSnap.name : ''), newCount: newCount,
        errors: failAcc, okCount: okCount, attempts: errors,
        conc: conc, maxConc: maxConc, risk: riskHits, stopped: stopped, retries: retries, stalled: stalled,
        hist: histN, histSkip: histSkip, histErr: histErr,
        pct: Math.min(100, Math.round(cur / total * 100)),
        elapsed: elapsed,
        eta: (total - cur) > 0 ? Math.round((total - cur) * (cur ? elapsed / cur : 0)) : 0,
        cool: coolUntil > now
      };
    }
    function report(name, force) {
      var now = Date.now();
      if (!force && now - lastReportAt < 120) return;
      lastReportAt = now;
      lastSnap = snap(name);
      if (statusCb) statusCb(lastSnap);
    }
    // 兜底心跳：就算某个回调被吞了（页面节流/异常），进度条也会自动往前走
    var beatTimer = setInterval(function () { if (shouldStop()) return; report(); }, 1500);
    function stopBeat() { clearInterval(beatTimer); }

    keepAwake(true);   // 抓的过程中别让手机熄屏（熄屏 = 页面被冻结 = 抓取停住）

    var saveTimer = null;
    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; save(); }, 2500);
    }

    /* ============ 阶段 0：关注页信息流（请求数极少，能走就走这条）============
       逐个账号打接口 = 392 次请求，这是【失败多】的根本原因：不是 bug，是请求太多，
       抖音必然限流 —— 并发怎么调都治不了本。
       关注流是抖音自己「把你关注的人的最新视频按时间倒序推给你」，一次请求 20 条。
       只要翻到某个账号【上次抓到的最新时间】，就说明这个账号没有更新的了，不用再问它。
       日常（几小时~一天没抓）只要 2~5 次请求就能核对完全部 392 个账号。
       走不通（接口变更 / 风控 / 返回空）会自动降级成逐个抓，绝不会比原来更差。 */
    var feedPages = 0, feedNew = 0, feedUsed = false, feedCaughtN = 0;
    var feedCovered = {};                  // 信息流里出现过的账号
    var phase = 'feed';                    // 'feed' = 收集信息流；'post' = 逐个补抓
    var feedTotal = Math.max(1, S.accounts.length - resumeFrom);

    function feedPhase() {
      if (S.cfg.scanMode === 'post') return Promise.resolve();   // 用户在设置里强制「只逐个抓」
      var uidMap = {}, newest = {}, i;
      for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId) uidMap[S.accounts[i].secUserId] = S.accounts[i];
      for (i = 0; i < S.videos.length; i++) {
        var vv = S.videos[i];
        if (vv.secUid && (!newest[vv.secUid] || (vv.publishedAt || 0) > newest[vv.secUid])) newest[vv.secUid] = vv.publishedAt || 0;
      }
      var caught = {}, t0 = Date.now(), cursor = 0;
      var BUDGET = 90000, MAXPAGE = 60, DEAD = 30 * 86400000;   // 最多 60 页 / 90 秒 / 回溯 30 天

      /* ★★ 追平线（2026-10-02 14:35 的核心改动）★★
         信息流是按时间【倒序】把你关注的人的新视频推给你。
         只要翻到一条比「上次抓取时间 − 30 分钟余量」还老的视频，就数学上保证了：
         自上次抓取以来，所有账号发的新视频【全部】已经在信息流里出现过（都已被 absorb 收走）。
         这时可以把【全部账号】标成已核对 —— 0 次逐个请求，还一个不漏。
         这就是「日常 2~5 次请求抓完 392 个账号」的原理。
         ★ 和之前那个漏抓 bug 的区别：之前是「接口说没了(has_more=false)就全标已核对」，
         而手机浏览器里接口经常只翻一两页就说没了 → 漏光。现在只认【时间追平】，
         接口提前说没了 → 只对「被证明追平」的账号跳过，其余照样逐个补。 */
      /* ★ 追平线为什么是「90 分钟」而不是 30 分钟（2026-10-02 21:45 修「第二次不行」）
         信息流是按时间倒序给的：只要翻到一条「比追平线还老」的视频，就证明追平线之后的
         所有视频都已经在前面出现过、都被收走了。可手机浏览器里这条信息流普遍只能回溯
         两三页（再往后抖音就说 has_more=false 了）—— 线画得越靠近「现在」，越容易翻不到
         那条老视频 → 判定不了追平 → 392 个账号全部退回逐个抓 → 请求暴涨 → 被限流 → 满屏失败。
         线往前挪到 90 分钟，就只要翻到 1.5 小时前的视频就算追平，命中率高得多；
         代价只是多翻一页（几百毫秒），远比掉回 392 次逐个打划算。 */
      var horizon = prevScanAt ? (prevScanAt - 90 * 60000) : 0;   // 只认【本轮开始之前】的那次抓取
      /* ★ 「是不是第一次用」不能用 lastScanAt 判断了 —— 上面开跑时已经把 lastScanAt 写成本轮时间，
         再拿它判首次，第一次使用也会被当成「非首次」→ 只收最近一个半小时 → 建不出基线 → 未读不全。
         真正的判据是「本地一条视频都没有」。 */
      var firstRun = !S.videos.length;
      var deepEnough = false, emptyPages = 0;

      function countCaught() { var n = 0; for (var u in caught) if (caught[u]) n++; return n; }

      function page() {
        if (shouldStop() || feedPages >= MAXPAGE || Date.now() - t0 > BUDGET) return Promise.resolve();
        feedPages++;
        report('关注流 第 ' + feedPages + ' 页');
        return hardLimit(fetchFollowFeed(cursor, { signal: scanCtrl ? scanCtrl.signal : null }), 20000)
          .then(function (res) {
            if (shouldStop()) return;
            feedUsed = true;
            var list = res.list || [], i2, oldest = Infinity, followed = 0;
            var mine = [];
            for (i2 = 0; i2 < list.length; i2++) {
              var a = list[i2];
              if (!a.secUid || !uidMap[a.secUid]) continue;     // 混入的推荐内容：不关我们的事
              followed++;
              if (a.publishedAt && a.publishedAt < oldest) oldest = a.publishedAt;
              feedCovered[a.secUid] = 1;
              var base = newest[a.secUid] || 0;
              /* 视频不比「该账号已知的最新一条」新 → 这个账号追平了，而且这条不是未读。
                 ★ 这一步同时保证未读列表干净：以前会把翻到的旧视频也当成新未读，越攒越多。 */
              if (base && a.publishedAt && a.publishedAt <= base) { caught[a.secUid] = 1; continue; }
              mine.push(a);
            }
            var before = newCount;
            absorb(mine);
            feedNew += (newCount - before);
            feedCaughtN = countCaught();
            scheduleSave(); report('关注流 第 ' + feedPages + ' 页');

            if (!list.length) return;                            // 空了：提前结束
            /* 整页都不是关注的人（连续两页全是推荐）→ 这条信息流不对劲，别再翻了 */
            if (!followed) { if (++emptyPages >= 2) return; } else emptyPages = 0;
            /* ★ 追平：翻到比「上次抓取」还老的视频 → 全部账号核对完毕 */
            if (horizon && oldest <= horizon) { deepEnough = true; return; }
            /* 首次使用没有基准：信息流只看最近 3 天先出个首批，其余靠逐个抓建基线 */
            if (firstRun && oldest < Date.now() - 3 * 86400000) return;
            if (oldest && oldest < Date.now() - DEAD) return;    // 翻进 30 天前了：没有意义
            /* ★ 接口说「没了」（手机信息流的常态，后面根本没内容了）
               旧版这里有两个极端，把这个功能毁了：
                 a) 无条件把所有人标成已核对 → 实际没核对到 → 未读永远是 0 条（就是你说的「抓不到」）；
                 b) 一律不认 → 几百个账号全部退回逐个抓 → 392 次请求 → 被风控 → 满屏失败。
               现在折中：翻过 3 页以上、而且信息流里已经见过我们关注的人 ≥ 六成，才认定「覆盖够了」；
               否则严一点，交给逐个抓补漏（宁可慢，也绝不允许漏账号）。 */
            if (!res.hasMore) {
              var touched = 0, uk;
              for (uk in feedCovered) if (uidMap[uk]) touched++;
              if (feedPages >= 3 && plan.length && touched / plan.length >= 0.6) {
                deepEnough = true;
                caught = {};
                for (uk in uidMap) if (uidMap[uk].secUserId) caught[uk] = 1;
              }
              return;
            }
            cursor = res.nextCursor || 0;
            if (!cursor) return;
            return sleep(260 + Math.random() * 340).then(page);  // 慢一点翻，像人在刷
          })
          .catch(function (e) {
            // 信息流这条路走不通（接口变了 / 被风控）：安静放弃，交给下面的逐个抓兜底
            feedCaughtN = countCaught();
            return;
          });
      }

      return page().then(function () {
        if (deepEnough) {
          /* ★ 信息流已覆盖「自上次抓取以来」的全部新视频：
             没出现在信息流里的账号 = 这段时间根本没发视频 = 没有未读，不用再问。
             这一步把逐个请求从 392 次降到 0 次，而且数学上一个不漏。 */
          for (var i4 = 0; i4 < plan.length; i4++) {
            var u4 = plan[i4].secUserId;
            if (u4) caught[u4] = 1;
          }
        }
        // 只有【明确核对过】的账号才跳过；没核对到的照样逐个抓，一个都不漏
        var left = [];
        for (var i3 = 0; i3 < plan.length; i3++) {
          var u = plan[i3].secUserId;
          if (!u || !caught[u]) left.push(plan[i3]);
        }
        feedCaughtN = countCaught();
        plan = left;
        phase = 'post';
      });
    }

    /* 跑一个账号：内置「就地重试」——抖一下就成功的不算失败，只有连试 3 次都不成才记失败。
       无论成败都一定 resolve，绝不漏掉并发槽位（漏槽位 = 卡死的元凶）。 */
    var MAX_TRY = 2;   // 首次之外再额外试 2 次
    function runItem(acc) {
      // 错峰：别让几个请求在同一毫秒齐射出去（齐射最像机器人，容易被盯）
      var waitMs = Math.max(0, coolUntil - Date.now()) + 80 + Math.floor(Math.random() * 220);
      dispatched++;
      return sleep(waitMs).then(function () { return step(0); });

      function step(n) {
        acc._pending = 1;                   // 标记「还没落定」：断点不许把它算成已抓到（中断时用它挡住）
        if (shouldStop()) return Promise.resolve();
        return hardLimit(fetchPosts(acc.secUserId, { signal: scanCtrl ? scanCtrl.signal : null }), 45000)
          .then(function (list) {
            if (shouldStop()) return;
            acc._pending = 0;
            okCount++; acc.lastError = ''; acc.lastCount = list.length;
            /* 之前几轮没抓成、这一轮成了 → 把「失败账号」的账也消掉：
               界面上「成功/失败」只反映【最终】结果（不然会出现 80 成功 + 1 失败 = 81 个的怪数） */
            if (acc._failCounted) { acc._failCounted = 0; failAcc--; }
            absorb(list); onGood(); scheduleSave(); report(acc.name);
          })
          .catch(function (e) {
            if (shouldStop()) return;
            if (n >= MAX_TRY) {                     // 3 次都没成，才算真失败（进补抓队列）
              acc.lastError = (e && e.message) || '抓取失败';
              onBad(e, acc); failed.push(acc); report(acc.name); return;
            }
            retries++;                              // 就地重试：退避后立刻再来，不用等最后统一补
            var w = (e && e.risk) ? (2500 + Math.random() * 2500)   // 风控：等久一点
                                  : (700 + n * 900 + Math.random() * 900);
            report(acc.name + '（第 ' + (n + 1) + ' 次重试）');
            return sleep(w).then(function () { return step(n + 1); });
          });
      }
    }

    /* 滑动窗口：谁回来谁补位；冷却期间由 runItem 自己等，槽位不空转。
       ★ cursor++ 必须在取元素的同一行 —— 少了它，所有并发会重复请求同一个账号
         （这是之前「失败一大片」的真正原因，别再改回去）。 */
    function pump(items) {
      return new Promise(function (resolve) {
        var cursor = 0, active = 0, done = 0, ended = false, lastProgress = Date.now();
        function finish() { if (ended) return; ended = true; clearInterval(stallTimer); resolve(); }
        // 停滞看门狗：90 秒一点进展都没有 = 真卡住了，强制收尾（剩下的进断点，绝不无限等）
        var stallTimer = setInterval(function () {
          if (ended) return;
          if (Date.now() - lastProgress > 90000) {
            stalled = true; stopped = true; stopFlag = true;
            if (scanCtrl) { try { scanCtrl.abort(); } catch (e) { } }
            toast('超过 90 秒没有任何进展，已强制收尾；没抓完的已记进断点，下次自动补。', 6000);
            finish();
          }
        }, 5000);
        function tick() {
          if (shouldStop()) { finish(); return; }
          while (active < conc && cursor < items.length) {
            var acc = items[cursor++];
            active++;
            runItem(acc).then(function () {
              active--; done++; lastProgress = Date.now();
              if (shouldStop() || done >= items.length) finish(); else tick();
            });
          }
          if (shouldStop() || done >= items.length) finish();
        }
        tick();
      });
    }

    // 看门狗：整轮超时自动收尾，剩下的账号留给断点续跑，绝不停在「半死不活」
    var wdTimer = setInterval(function () {
      if (stopFlag) return;
      var budgetMs = (parseInt(S.cfg.scanBudget, 10) || 12) * 60000;
      if (Date.now() - startedAt > budgetMs) {
        stopped = true; stopFlag = true;
        if (scanCtrl) { try { scanCtrl.abort(); } catch (e) { } }
        toast('本轮超过 ' + Math.round(budgetMs / 60000) + ' 分钟，已自动收尾；没抓到的账号下次会从断点继续。', 6000);
      }
    }, 4000);

    function cleanup() {
      clearInterval(wdTimer); stopBeat();
      scanning = false; keepAwake(false); stopFlag = false;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      // 没跑完 → 进度写进断点（下次从这里续）；跑完了 → 断点标记「已全部完成」
      /* ★ 断点口径：只认【真正抓到的账号数】(okCount)，既不认「派出去了几个」，也不认「试过了几个」。
         - 以前用派出数：中途被停下（熄屏 / 90 秒停滞看门狗 / 你按停止）时，还在飞的请求既没成功
           也没算失败，断点却把它们当「已处理」→ 下次直接跳过 → 一堆账号永远没抓过，未读永远是 0 条。
         - 更坑的是把「试过但失败」也记成进度：一批 60 个全失败 → 断点往前推 60 → 下次跳过这 60 个
           → 这些账号这辈子都不会被抓到（这就是「第一次可以、第二次就不行了」里最要命的一条）。
         现在只数成功的：没抓到的下次一定重来（宁可多跑几轮，绝不漏）。 */
      var unfinished = stopped || failed.length > 0 || batchEnd;
      S.scanJob = unfinished
        ? { sig: accountSig(), startIdx: resumeFrom, cursor: resumeFrom + Math.min(prefixTotal, plan.length), ts: Date.now() }
        : { sig: accountSig(), startIdx: 0, cursor: S.accounts.length, ts: Date.now() };
      save();
    }
    function resultObj() {
      if (failed.length) {
        var seenN = {};
        lastScanFailed = [];
        for (var fn = 0; fn < failed.length; fn++) {
          var nm = failed[fn].name || failed[fn].secUserId;
          if (!seenN[nm]) { seenN[nm] = 1; lastScanFailed.push(nm); }
        }
      }
      // 还差点没抓到：总账号数 − 断点之前的 − 信息流已核对的 − 本轮【抓到的】（含信息流）
      var left = Math.max(0, S.accounts.length - resumeFrom - feedCaughtN - prefixTotal);
      // 「分批跑完的正常收尾」不算异常：只有风控 / 看门狗 / 手动停止才算 stopped
      if (stopped && batchEnd) stopped = false;
      return {
        ok: true, newCount: newCount, errors: failAcc, okCount: okCount + feedCaughtN, scanned: plan.length,
        feedUsed: feedUsed, feedPages: feedPages, feedCaught: feedCaughtN,
        hist: histSkip, histN: histN, histErr: histErr,
        conc: conc, risk: riskHits, stopped: stopped, resumeAt: resumeFrom, left: left,
        retries: retries, attempts: errors, stalled: stalled,
        pct: Math.min(100, Math.round((feedCaughtN + okCount) / feedTotal * 100)),
        names: lastScanFailed.slice(0, 20)
      };
    }

    /* ★ 逐个抓改成【分批滚动】（2026-10-02 21:45 修「第二次不行」）
       以前是一口气把没核对完的几百个账号全丢进并发池：请求量瞬间回到 392 次，
       抖音必然限流，跑满 12 分钟看门狗再把半路砍掉 → 你看到的就是「失败一大片」。
       现在一批最多 60 个：这批跑完就落盘、写断点、本轮收尾；下次再点一次自动从断点续，
       一批批往前磨。总量没变，但每次只露一小头，被盯上的概率低得多，也随时能看到进度。 */
    /* 断点用的「连续成功前缀」：从头数，遇到第一个【没抓到的】就停。
       这样断点点只会落在「前面全抓到了」的位置：失败的、被中断的，下次一定重来，绝不跳过。 */
    function prefixOf(items) {
      var n = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].lastError || items[i]._pending) break;
        n++;
      }
      return n;
    }
    function runPass(list, pass) {
      var BATCH = list.length <= 120 ? list.length
        : Math.max(10, Math.min(60, parseInt(S.cfg.scanBatch, 10) || 60));
      var next = (pass || 0) + 1;
      var batch = list.slice(0, BATCH);
      return pump(batch).then(function () {
        prefixTotal += prefixOf(batch);
        var rest = list.length - BATCH;
        /* 这批【一个都没失败】= 一路很顺 → 再跟两批（省得为了几百个账号连点好几次）；
           只要有任何失败、或者跟满两批，就地收尾：剩下的进断点，下次自动补。 */
        if (!shouldStop() && !failed.length && rest > 0 && next <= 2) {
          return sleep(600).then(function () { return runPass(list.slice(BATCH), next); });
        }
        if (!shouldStop()) { batchEnd = true; stopFlag = true; }
      });
    }

    /* 阶段 -1：先把抖音服务器上「你已看过的视频」读一遍（1~2 次请求），再开始抓。
       这一步决定未读是不是准 —— 不读它，未读里就全是早看过的旧视频。 */
    var sig0 = (scanCtrl && scanCtrl.signal) || null;
    return Promise.resolve()
      .then(function () { return fetchWatchHistory({ signal: sig0 }); })
      .then(function (hres) {
        histMap = (hres && hres.ids) || {}; histN = (hres && hres.n) || 0; histErr = (hres && hres.error) || '';
        killHist();                       // 把以前攒下的「已看过的旧视频」也从未读里清掉
        scheduleSave();
        report('读取抖音已看记录 ' + histN + ' 条', true);
        return feedPhase();
      })
      .then(function () {
        // 信息流已经把账号全部核对完（日常绝大多数情况）：不用再逐个打接口了
        if (!plan.length) { cleanup(); report('', true); return resultObj(); }
        return runPass(plan, 0).then(function () {
          cleanup(); report('', true);
          return resultObj();
        });
      })
      .catch(function (e) {
      clearInterval(wdTimer); stopBeat(); scanning = false; keepAwake(false); stopFlag = false;
      try { save(); } catch (err) { }
      return { ok: false, error: (e && e.message) || '未知错误' };
    });
  }

  /* 抓取中随时可以喊停：掐掉所有在途请求，让当前批次立刻收尾，未跑完的记进断点 */
  function stopScan() {
    if (!scanning) return;
    stopped = true; stopFlag = true;
    if (scanCtrl) { try { scanCtrl.abort(); } catch (e) { } }
    toast('正在停止…', 3000);
  }

  /* ----------------------------- 面板 UI ----------------------------- */
  /* 默认分类（老用户升级时若没建过分类会用它兜底）。真正的分类以 S.categories 为准，
     那边能新建 / 改名 / 删除 —— 分类写死在脚本里就没法自己加了。 */
  var CATS = ['朋友', '军事', '学习', '工作', '实时新闻', '钓鱼', '娱乐'];

  function renderHome() {
    var unread = unreadVideos();
    var h = '';
    h += '<div class="dyh-card">';
    h += '<div class="dyh-row"><b>账号</b><span>' + (S.selfSecUid ? '已登录' : '未识别') + '</span></div>';
    h += '<div class="dyh-row"><b>关注公众号</b><span>' + S.accounts.length + ' 个</span></div>';
    h += '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + unread.length + ' 条</span></div>';
    h += '<div class="dyh-row"><b>上次抓取</b><span>' + (S.lastScanAt ? fmtTime(S.lastScanAt) : '从未') + '</span></div>';
    h += '<div class="dyh-row"><b>已看记录</b><span>' + S.readIds.length + ' 条</span></div>';
    h += '</div>';
    h += '<button class="dyh-btn primary" data-act="scan">🔍 抓最新未读视频</button>';
    h += '<button class="dyh-btn" data-act="refresh">📥 刷新我的关注列表</button>';
    h += '<button class="dyh-btn" data-act="manage">📺 未读视频查看</button>';
    h += '<button class="dyh-btn" data-act="search">🔎 搜索并关注新账号</button>';
    h += '<button class="dyh-btn" data-act="push">☁️ 推到 GitHub（手机端 HTML 可看）</button>';
    h += '<button class="dyh-btn gray" data-act="settings">⚙️ 设置（GitHub / 数据）</button>';
    h += '<div class="dyh-tip">标题后面那个 <b>' + VER_SHORT +
      '</b> 是版本号（生成时间 + 本次改动，完整说明在设置页最下面），用来确认手机上跑的是不是最新版。</div>';
    return h;
  }

  function unreadVideos() {
    var readMap = {};
    for (var i = 0; i < S.readIds.length; i++) readMap[S.readIds[i]] = 1;
    return S.videos.filter(function (v) { return !readMap[v.awemeId]; })
      .sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
  }

  /* ============ 未读的「消费」全部收在助手面板里（不和电脑/GitHub 打交道）============
     以前的结果链路是：助手抓 → 推 GitHub → 再去手机端 HTML 看。用户要的是：
     【抓、判、看、标已看】全在抖音关注助手这一个面板里完成。下面这几个函数就是这条闭环。 */

  /* ======================= 管理分类 / 批量取关 =======================
     分类不再写死在脚本里（CATS 只当默认值），改成 S.categories —— 能新建、改名、删除，
     删掉的分类里的账号自动落到「未分类」，不会跟着消失。
     每个账号后面标未读条数：视频对象里带 secUid 就按 secUid 数（对方改名也不怕），
     拿不到就退回按昵称数。 */
  var MGR = { cat: '', kw: '', adding: false, editing: '', drop: false, acc: '', sync: false };
  var NO_CAT = '__none__';                       // 「未分类」的空槽（真值仍是空字符串）
  var ALL_CAT = '__all__';                       // 「全部分类」（进管理页默认就是这个）

  function catNames() {
    var arr = (S.categories && S.categories.length) ? S.categories.slice() : [];
    // 账号上挂着、清单里却没有的分类（老数据 / 手工改过）也补进来，别让它无处可归
    for (var i = 0; i < S.accounts.length; i++) {
      var c = (S.accounts[i].category || '');
      if (c && arr.indexOf(c) < 0) arr.push(c);
    }
    return arr;
  }

  function unreadByAccount() {
    var readMap = {}, m = {}, i, j;
    for (i = 0; i < S.readIds.length; i++) readMap[S.readIds[i]] = 1;
    for (j = 0; j < S.videos.length; j++) {
      var v = S.videos[j];
      if (readMap[v.awemeId]) continue;
      var k = v.secUid || v.account;
      if (!k) continue;
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }

  function catOf(a) { return (a.category || NO_CAT); }
  function isAll(cat) { return cat === ALL_CAT; }
  function catLabel(cat) {
    if (cat === ALL_CAT) return '全部分类';
    if (cat === NO_CAT) return '未分类';
    return cat || '未分类';
  }
  function catCount(cat) {
    if (cat === ALL_CAT) return S.accounts.length;
    var n = 0;
    for (var i = 0; i < S.accounts.length; i++) if (catOf(S.accounts[i]) === cat) n++;
    return n;
  }
  function catUnread(cat, um) {
    var n = 0;
    for (var i = 0; i < S.accounts.length; i++) {
      var a = S.accounts[i];
      if (cat !== ALL_CAT && catOf(a) !== cat) continue;
      n += um[(a.secUserId || a.name)] || 0;
    }
    return n;
  }
  // 一个分类下【当前】的成员（已按昵称关键字过滤）；未读多的排前面
  function catMembers(cat, um) {
    var kw = (MGR.kw || '').trim().toLowerCase(), out = [];
    for (var i = 0; i < S.accounts.length; i++) {
      var a = S.accounts[i];
      if (cat !== ALL_CAT && catOf(a) !== cat) continue;
      if (kw && String(a.name || a.secUserId || '').toLowerCase().indexOf(kw) < 0) continue;
      out.push(a);
    }
    out.sort(function (x, y) {
      return (um[(y.secUserId || y.name)] || 0) - (um[(x.secUserId || x.name)] || 0);
    });
    return out;
  }

  /* ===================== 从 GitHub 拉分类 =====================
     为什么单独用 categories.json：unread.json 有 3.9MB，手机上根本拉不动（实测 3 分钟拉不完）。
     categories.json 只有 ~40KB，只装「分类名 + 账号昵称 + secUid + 归属分类」。
     匹配顺序：secUid 精确 → 昵称精确 → 昵称去空格。对方改名了也能靠 secUid 认出来。 */
  function applyCatFile(doc, mode) {
    if (!doc || doc.type !== 'douyin-categories' || !doc.accounts) {
      throw new Error('这不是分类清单文件（type=' + (doc && doc.type) + '）');
    }
    var bySec = {}, byName = {}, i, c;
    for (i = 0; i < doc.accounts.length; i++) {
      var r = doc.accounts[i];
      if (r.s) bySec[r.s] = (r.c || '');
      if (r.n) byName[String(r.n).replace(/\s+/g, '')] = (r.c || '');
    }
    var hit = 0, changed = 0, filled = 0, missed = 0;
    for (i = 0; i < S.accounts.length; i++) {
      var a = S.accounts[i];
      var k = '';
      if (a.secUserId && Object.prototype.hasOwnProperty.call(bySec, a.secUserId)) k = 'sec';
      else if (Object.prototype.hasOwnProperty.call(byName, String(a.name || '').replace(/\s+/g, ''))) k = 'name';
      if (!k) { missed++; continue; }                 // 清单里根本没这个号 → 一个字都不动
      var nc = (k === 'sec') ? bySec[a.secUserId] : byName[String(a.name || '').replace(/\s+/g, '')];
      hit++;
      if (mode === 'merge') {                          // 只补空缺：已有分类一律不动
        if (!a.category && nc) { a.category = nc; filled++; }
      } else {                                        // 覆盖：清单里为空 = 认定它「未分类」，也覆盖掉
        if ((a.category || '') !== nc) { a.category = nc; changed++; }
      }
    }
    /* 分类名清单：先并进本机已有的（不动顺序、不删用户自建的），清单里缺的补上。
       带 U+FFFD 乱码的直接跳过 —— 电脑端万漏修，手机上也不该凭空多出一个乱码分类。 */
    var names = catNames();
    for (i = 0; i < (doc.categories || []).length; i++) {
      c = doc.categories[i];
      if (!c || /\uFFFD/.test(c)) continue;
      if (names.indexOf(c) < 0) names.push(c);
    }
    S.categories = names;
    S.lastCatSync = Date.now();
    save();
    return { hit: hit, changed: changed, filled: filled, missed: missed, cats: names.length, at: doc.generatedAt || '' };
  }

  function pullCats(mode) {
    var O = S.cfg.owner, R = S.cfg.repo, B = S.cfg.branch;
    var url = 'https://raw.githubusercontent.com/' + encodeURIComponent(O) + '/' + encodeURIComponent(R) + '/' + encodeURIComponent(B) + '/categories.json';
    var old = setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
      '<div class="dyh-prog" id="dyh-prog">☁️ 正在拉取分类清单…<br><span style="font-size:19px">' + esc(url) + '</span></div>');
    return fetch(url + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + '（检查设置里的用户名/仓库/分支）');
        return r.text();
      })
      .then(function (txt) {
        var doc;
        try { doc = JSON.parse(txt); } catch (e) { throw new Error('拉回来的不是合法 JSON（前 80 字：' + txt.slice(0, 80) + '…）'); }
        var r2 = applyCatFile(doc, mode);
        var body = '<div class="dyh-back" data-act="manage">← 返回</div><div class="dyh-card">' +
          '<div class="dyh-row"><b>' + (mode === 'merge' ? '只补空缺' : '覆盖分类') + '完成</b><span class="dyh-hl">' + r2.hit + ' 个</span></div>' +
          '<div class="dyh-row"><b>本次改动</b><span>' + (mode === 'merge' ? ('补上 ' + r2.filled + ' 个') : (r2.changed + ' 个')) + '</span></div>' +
          '<div class="dyh-row"><b>清单里没有</b><span>' + r2.missed + ' 个（保持原样）</span></div>' +
          '<div class="dyh-row"><b>现有分类</b><span>' + r2.cats + ' 个</span></div>' +
          (r2.at ? '<div class="dyh-row"><b>清单生成于</b><span>' + esc(r2.at) + '</span></div>' : '') +
          '</div>' +
          '<div class="dyh-tip">' + (r2.changed || r2.filled
            ? '✅ 已经灌进本机了，下面按分类查看就能看到。'
            : '这次没有变化（可能本机已经是这份清单了）。') + '</div>' +
          '<button class="dyh-btn primary" data-act="manage">去分类里看看</button>';
        setBody(body);
      })
      .catch(function (e) {
        setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
          '<div class="dyh-tip" style="color:#f53f3f">☁️ 拉取失败：' + esc(e.message) + '</div>' +
          '<div class="dyh-tip">这个功能不需要填 Token（raw 地址公开可读）。请检查：<br>' +
          '① ⚙️ 设置里的 GitHub 用户名 / 仓库 / 分支对不对（现在是 ' + esc(S.cfg.owner) + ' / ' + esc(S.cfg.repo) + ' / ' + esc(S.cfg.branch) + '）；<br>' +
          '② 手机能不能上 raw.githubusercontent.com；<br>' +
          '③ 电脑上有没有跑过 <b>生成分类清单.js</b>（第一次要先在电脑上生成并推送一次）。</div>' +
          '<button class="dyh-btn" data-act="manage">← 返回管理页</button>');
      });
  }

  function renderManage() {
    var um = unreadByAccount();
    if (!MGR.cat) MGR.cat = ALL_CAT;            // ★ 进来默认就是「全部分类」
    var cat = MGR.cat;
    var i, h = '<div class="dyh-back" data-act="home">← 返回</div>';

    /* ---- 分类选择器：点这一行弹出下拉，选一个就切过去 ---- */
    h += '<div class="dyh-sel" data-act="mgr-drop"><b>' + esc(catLabel(cat)) + '</b>' +
      '<span class="dyh-caret">' + (MGR.drop ? '▴' : '▾') + '</span>' +
      '<em>' + catCount(cat) + ' 个 · <b>' + catUnread(cat, um) + '</b> 未读</em></div>';

    if (MGR.drop) {
      var opts = [{ key: ALL_CAT, name: '全部分类' }], cs = catNames();
      for (i = 0; i < cs.length; i++) opts.push({ key: cs[i], name: cs[i] });
      opts.push({ key: NO_CAT, name: '未分类' });
      h += '<div class="dyh-drop">';
      for (i = 0; i < opts.length; i++) {
        var k = opts[i].key;
        h += '<div class="dyh-drop-i' + (cat === k ? ' on' : '') + '" data-act="mgr-pick" data-cat="' + esc(k) + '">' +
          '<span>' + esc(opts[i].name) + '</span><em>' + catCount(k) + ' 个 · ' + catUnread(k, um) + ' 未读</em></div>';
      }
      h += '<div class="dyh-drop-a">' +
        '<span class="dyh-mini" data-act="mgr-newcat">＋ 新建分类</span>' +
        (cat !== ALL_CAT && cat !== NO_CAT
          ? '<span class="dyh-mini" data-act="mgr-rename" data-cat="' + esc(cat) + '">改名</span>' +
            '<span class="dyh-mini dg" data-act="mgr-del-cat" data-cat="' + esc(cat) + '">删分类</span>' +
            '<span class="dyh-mini dg" data-act="mgr-uf-cat" data-cat="' + esc(cat) + '">整类取关</span>'
          : '') +
        '</div>';
      // 就地展开的输入框（不用弹窗 —— 有些手机浏览器会禁 prompt）
      if (MGR.adding) {
        h += '<input id="dyh-newcat" class="dyh-input" placeholder="新分类名，比如「搞笑」">' +
          '<div style="display:flex;gap:8px;margin-bottom:6px">' +
          '<span class="dyh-mini on" style="flex:1;text-align:center;display:block" data-act="mgr-newcat-ok">＋ 加进来</span>' +
          '<span class="dyh-mini" style="flex:1;text-align:center;display:block" data-act="mgr-cat-cancel">取消</span></div>';
      }
      if (MGR.editing === cat) {
        h += '<input id="dyh-catname" class="dyh-input" value="' + esc(cat) + '" placeholder="分类名">' +
          '<div style="display:flex;gap:8px;margin-bottom:6px">' +
          '<span class="dyh-mini on" style="flex:1;text-align:center;display:block" data-act="mgr-cat-ok" data-cat="' + esc(cat) + '">保存</span>' +
          '<span class="dyh-mini" style="flex:1;text-align:center;display:block" data-act="mgr-cat-cancel">取消</span></div>';
      }
      h += '</div>';
    }

    /* ---- 搜索 ---- */
    h += '<input id="dyh-mgr-kw" class="dyh-input" placeholder="搜公众号名称（留空看全部）" value="' + esc(MGR.kw || '') + '">';

    h += '<div id="dyh-mgr-list">' + mgrListHtml(cat, um) + '</div>';

    /* ---- 从 GitHub 拉分类：折叠在最后，平时不占地方 ---- */
    if (MGR.sync) {
      h += '<div class="dyh-card" style="padding:10px 12px;margin:14px 0 0">' +
        '<div class="dyh-row"><b>☁️ 从 GitHub 拉分类</b><span></span></div>' +
        '<div class="dyh-tip" style="margin:2px 0 8px">电脑端整理好的分类清单存在 GitHub 的 <b>categories.json</b>' +
        '（只有几十 KB，不像 unread.json 有 3.9MB 手机拉不动）。拉下来会按账号对上号并覆盖本机分类。</div>' +
        (S.lastCatSync ? '<div class="dyh-tip" style="margin:0 0 8px">上次同步：' + esc(fmtTime(S.lastCatSync)) + '</div>' : '') +
        '<button class="dyh-btn primary" data-act="cat-pull">☁️ 拉取并覆盖分类</button>' +
        '<button class="dyh-btn" data-act="cat-merge">🔀 只补空缺（不覆盖已有）</button>' +
        '<button class="dyh-btn gray" data-act="mgr-sync-close">收起</button></div>';
    } else {
      h += '<div style="margin:14px 0 0"><span class="dyh-mini" data-act="mgr-sync">☁️ 同步电脑端的分类</span></div>';
    }
    return h;
  }

  /* 某个分类下的公众号列表（★ 名称 / 未读数 / 设分类 / 取关 四个并排一行）
     搜索框输入时只重渲这一块，输入框不会丢焦点。 */
  function mgrListHtml(cat, um) {
    var mem = catMembers(cat, um);
    var kwOn = (MGR.kw || '').trim() ? 1 : 0;
    var shown = mem.length;
    var h = '<div class="dyh-tip" style="margin:10px 0 4px"><b>' + esc(catLabel(cat)) + '</b> · ' +
      (kwOn ? '搜到 ' + shown + ' 个（本类共 ' + catCount(cat) + ' 个）' : shown + ' 个公众号') +
      ' · <span class="dyh-hl">' + catUnread(cat, um) + '</span> 条未读' +
      (kwOn ? '' : ' · 点名称看它的未读视频') + '</div>';
    var n = Math.min(shown, 300);
    for (var i = 0; i < n; i++) {
      var a = mem[i];
      var un = um[(a.secUserId || a.name)] || 0;
      h += '<div class="dyh-acc2">' +
        '<span class="dyh-nm" data-act="acc-videos" data-sec="' + esc(a.secUserId) + '" data-name="' + esc(a.name || '') + '">' +
        esc(a.name || a.secUserId) + '</span>' +
        '<span class="dyh-urn2' + (un ? '' : ' ok') + '">' + (un ? un + ' 未读' : '已看完') + '</span>' +
        '<span class="dyh-mini" data-act="setcat" data-sec="' + esc(a.secUserId) + '">' + esc(a.category || '设分类') + '</span>' +
        '<span class="dyh-mini dg" data-act="unfollow-one" data-sec="' + esc(a.secUserId) + '" data-name="' + esc(a.name || '') + '">取关</span>' +
        '</div>';
    }
    if (!shown) h += '<div class="dyh-tip">这个分类下还没有公众号' + (kwOn ? '（换个关键词试试）' : '') + '。</div>';
    else if (shown > 300) h += '<div class="dyh-tip">先显示 300 个（本类共 ' + shown + ' 个），用上面搜索框过滤。</div>';
    return h;
  }

  /* ================= 某个公众号的「未读视频列表」 =================
     点进来只看这一个号的未读；点任意一条 → 唤起抖音 App 看（没唤起就退回网页版），
     并当场记成已看（未读数立刻 -1，不用等下一轮抓取）。 */
  function unreadVideosOf(sec, acc) {
    var readMap = {}, out = [], i;
    for (i = 0; i < S.readIds.length; i++) readMap[S.readIds[i]] = 1;
    var name = acc ? (acc.name || '') : '';
    for (i = 0; i < S.videos.length; i++) {
      var v = S.videos[i];
      if (readMap[v.awemeId]) continue;
      // 优先按 secUid 认（对方改名也不怕）；老数据只有昵称的，退回比昵称
      var ok = sec ? (v.secUid === sec || (!v.secUid && name && v.account === name))
        : (!!name && v.account === name);
      if (ok) out.push(v);
    }
    out.sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
    return out;
  }

  function renderAccVideos() {
    var sec = MGR.acc || '', acc = null, i;
    for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec) { acc = S.accounts[i]; break; }
    var name = acc ? (acc.name || sec) : sec;
    var vids = unreadVideosOf(sec, acc);
    var h = '<div class="dyh-back" data-act="manage">← 返回</div>';
    h += '<div class="dyh-card">' +
      '<div class="dyh-row"><b>公众号</b><span>' + esc(name) + '</span></div>' +
      '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + vids.length + ' 条</span></div>' +
      (acc && acc.category ? '<div class="dyh-row"><b>分类</b><span>' + esc(acc.category) + '</span></div>' : '') +
      '</div>';
    h += '<div class="dyh-tip">点任意一条 → 用<b>抖音 App</b> 观看，唤起后<b>网页端不跳转、不做任何动作</b>' +
      '（面板原样留在这）；打开的同时记成已看，未读数当场减一。</div>';
    /* 「唤起方式」开关：不同手机 / 不同浏览器对 scheme 和 intent 的放行程度不一样，
       哪个不弹「允许网站打开抖音吗」就锁哪个（点一下循环切换，会记住）。 */
    var om = S.cfg.openMode || 'scheme';
    var omNext = (om === 'scheme') ? 'intent' : (om === 'intent' ? 'auto' : 'scheme');
    var omTxt = { scheme: '① 只 scheme（默认，发一次）', intent: '② 只 intent（写死包名）', auto: '③ 自动（scheme 失败再补 intent）' };
    h += '<div class="dyh-row"><b>唤起方式</b>' +
      '<span class="dyh-mini" data-act="openmode" data-mode="' + esc(omNext) + '">' + esc(omTxt[om]) + ' ⇄</span></div>';
    h += '<div class="dyh-tip" style="margin:4px 0 10px">还是弹「允许网站打开抖音吗」？那是 <b>Via 自己</b>的框（网页关不掉）：' +
      'Via → 设置 → 高级设置 → <b>链接处理 → 改成「直接打开」</b>（或弹框时勾「记住选择」再点允许）。' +
      '也可以点上面那颗按钮换一种唤起方式试试。</div>';
    for (i = 0; i < vids.length; i++) {
      var v = vids[i];
      h += '<div class="dyh-vid" data-act="play" data-id="' + esc(v.awemeId) + '" data-url="' + esc(v.url) + '">' +
        '<div class="dyh-vid-t">' + esc(v.title || '（无标题）') + '</div>' +
        '<div class="dyh-vid-m"><span>' + esc(v.publishTime || '') + '</span>' +
        '<span class="dyh-mini go">▶ 用抖音看</span>' +
        '<span class="dyh-mini" data-act="read-one" data-id="' + esc(v.awemeId) + '">已看</span></div></div>';
    }
    if (!vids.length) h += '<div class="dyh-tip">这个号现在没有未读视频。</div>';
    return h;
  }

  /* 唤起抖音 App 打开视频详情页（10-03 00:50 重写）
     ---------------------------------------------------------------------------
     ★★ 那个「允许网站打开抖音吗」的框到底是谁弹的（改这段代码前必读）：
        Via 这类浏览器是 **WebView 内核**。WebView 遇到非 http(s) 的 scheme（snssdk1128://、intent://）
        一律交给浏览器自己处理，Via 就按它自己的「链接处理」设定弹确认框。
        这是【浏览器层面】的框 —— 网页里的 JS 关不掉（iframe 没手势会弹，location 跳转照样会弹）。
        彻底关掉它的唯一办法在浏览器设置里（详见说明页 ⑤-15）：
          Via → 设置 → 高级设置 → 链接处理 → 改成「直接打开」
          （有的版本写作「允许外部应用打开链接」并带「记住选择」：框出来时勾上「记住」点一次允许，以后不再问）
        脚本这边能做的是：
          ① 只在【点击的回调里同步】发起（带用户手势 —— 能不弹就不弹）；
          ② 不再偷偷补发第二次【没有手势】的跳转（那必然又是一个框）：默认只发一次；
          ③ 给一个「唤起方式」开关（cfg.openMode = scheme / intent / auto），
             哪条路在你机器上不弹框，就锁哪条，下次一直按它来。
     ★ 网页端始终不做任何动作：不 window.open、不跳视频网页、不刷新，面板原样留着。 */
  function openInApp(awemeId) {
    var id = encodeURIComponent(awemeId || '');
    var mode = S.cfg.openMode || 'scheme';
    var scheme = 'snssdk1128://aweme/detail/' + id;
    // intent 写法：写死抖音包名 → 系统不会弹「用哪个应用打开」的选择框，也不会跳网页（没给 fallback URL）
    var intent = 'intent://aweme/detail/' + id +
      '#Intent;scheme=snssdk1128;package=com.ss.android.ugc.aweme;end';
    var first = (mode === 'intent') ? intent : scheme;
    try { window.location.href = first; } catch (e) { }
    /* 只有「自动」档才补第二下（1.2 秒还在前台 = 第一下没起来）。
       ⚠ 这一下不在点击手势里，个别浏览器会专门为它弹一个确认框 ——
         不想看到框就把「唤起方式」锁成 scheme 或 intent，别用自动。 */
    if (mode === 'auto') {
      setTimeout(function () {
        if (document.hidden) return;
        try { window.location.href = intent; } catch (e) { }
      }, 1200);
    }
    // 还是没起来 → 只提示，绝不跳转、绝不开新标签
    setTimeout(function () {
      if (document.hidden) return;
      toast('没跳到抖音？去 Via「设置 → 高级设置 → 链接处理」改成「直接打开」（这条已记成已看，网页没动）');
    }, 2700);
  }

  function renderSearch() {
    return '<div class="dyh-back" data-act="home">← 返回</div>' +
      '<div class="dyh-tip">输入昵称/关键词搜索，结果里点「关注」</div>' +
      '<input id="dyh-kw" class="dyh-input" placeholder="请输入抖音昵称或关键词">' +
      '<button class="dyh-btn primary" data-act="do-search">🔎 搜索</button>' +
      '<div id="dyh-results"></div>';
  }

  function renderSettings() {
    var h = '<div class="dyh-back" data-act="home">← 返回</div>';
    h += '<div class="dyh-tip">填一次会记住。Token 需要有 repo 权限的 classic PAT</div>';
    h += '<label class="dyh-lb">GitHub 用户名</label><input id="dyh-owner" class="dyh-input" value="' + esc(S.cfg.owner) + '">';
    h += '<label class="dyh-lb">仓库名</label><input id="dyh-repo" class="dyh-input" value="' + esc(S.cfg.repo) + '">';
    h += '<label class="dyh-lb">分支</label><input id="dyh-branch" class="dyh-input" value="' + esc(S.cfg.branch) + '">';
    h += '<label class="dyh-lb">Token</label><input id="dyh-token" class="dyh-input" type="password" value="' + esc(S.cfg.token) + '" placeholder="ghp_xxx">';
    h += '<div class="dyh-tip" style="margin-top:2px">助手面板已固定<b>铺满整块手机屏</b>（切换大小的功能按你的要求取消了）。</div>';
    var md = S.cfg.scanMode === 'post' ? 'post' : 'auto';
    h += '<label class="dyh-lb">抓取方式</label><div style="display:flex;gap:8px;margin:6px 0 4px">' +
      '<button class="dyh-btn' + (md === 'auto' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="scan-mode" data-mode="auto">智能（默认，推荐）</button>' +
      '<button class="dyh-btn' + (md === 'post' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="scan-mode" data-mode="post">只逐个抓</button>' +
      '</div>' +
      '<div class="dyh-tip" style="margin-top:2px"><b>智能（默认）</b> = 先用「关注页信息流」按时间倒序翻，翻到<b>上次抓取的位置</b>就算追平' +
      '（追平后 0 次逐个请求，也一个不漏 —— 自上次以来发过视频的账号必定都在信息流里）；' +
      '万一信息流提前结束，没追平的账号照样逐个补。<b>日常只要 2~5 次请求，又快又不容易被风控。</b><br>' +
      '<b>只逐个抓</b> = 一个账号一个请求（392 个号就是 392 次请求，慢且容易被限流），一般不用选。</div>';
    h += '<label class="dyh-lb">每次抓前几个账号（留空 = 全部 ' + S.accounts.length + ' 个）</label>' +
      '<input id="dyh-limit" class="dyh-input" type="number" min="0" inputmode="numeric" value="' + (S.cfg.scanLimit || 0) + '">';
    h += '<label class="dyh-lb">并发【上限】1~10（默认 6）</label>' +
      '<input id="dyh-conc" class="dyh-input" type="number" min="1" max="10" inputmode="numeric" value="' + (S.cfg.scanConc || 6) + '">';
    h += '<label class="dyh-lb">整轮最长几分钟（超时自动收尾，0 = 不限制）</label>' +
      '<input id="dyh-budget" class="dyh-input" type="number" min="0" max="60" inputmode="numeric" value="' + (S.cfg.scanBudget || 12) + '">';
    h += '<div class="dyh-tip"><b>不用改设置也能跑得又快又稳</b>：开局只打 <b>3</b> 个，抖音不拒绝就慢慢加到上限；' +
      '一旦连续失败或看到风控提示，立刻砍半并冷却，绝不会把整轮搞崩。<br>' +
      '想更快 → 上限填 <b>8~10</b>；还是失败多 → 上限填 <b>3~4</b>（慢一点但几乎不失败）。<br>' +
      '全部 ' + S.accounts.length + ' 个账号：上限 6 大约 2~5 分钟，上限 3 大约 4~8 分钟。</div>';
    h += '<button class="dyh-btn primary" data-act="save-settings">💾 保存</button>';
    h += '<button class="dyh-btn gray" data-act="clear-job">🧹 清掉抓取断点（下次全部重抓）</button>';
    h += '<button class="dyh-btn" data-act="export">📤 导出数据到手机本地（下载 json）</button>';
    h += '<button class="dyh-btn gray" data-act="clear">🗑 清空本地数据</button>';
    h += '<div class="dyh-tip">已读记录 ' + S.readIds.length + ' 条 · 视频库 ' + S.videos.length + ' 条</div>';
    h += '<div class="dyh-tip">本脚本版本（生成时间 + 本次改动）：<b>' + esc(VER) + '</b><br>' +
      '每次改动版本号都会变，Via 里的脚本不会自动更新 —— 看到这里和最新不一样，就在 Via 里删掉旧脚本重装一次。</div>';
    return h;
  }

  /* ----------------------------- 面板骨架 ----------------------------- */
  /* 浅黄配色集中定义（10-03 00:20：用户说第一版太淡看着还是白的，整体加深一档）
     面板 #fff6cc / 卡片·小标签 #ffefab / 按钮·输入框 #fffbe6 / 描边 #ecd98c / 分割线 #f2e3a8
     ★ BG_PANEL 这个常量下面 CSS 和 inline 两处都要用，改色只改这里 */
  var BG_PANEL = '#fff6cc';
  var fab = null, panel = null, bodyEl = null;

  function ensureUI() {
    if (fab) return;
    var st = document.createElement('style');
    st.textContent =
      '.dyh-fab{position:fixed;right:16px;bottom:calc(28px + env(safe-area-inset-bottom));z-index:2147483640;' +
      'width:74px;height:74px;border-radius:50%;background:#fe2c55;color:#fff;font-size:38px;line-height:74px;' +
      'text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none}' +
      '.dyh-panel{position:fixed;left:0;right:0;bottom:0;top:0;z-index:2147483645;background:rgba(0,0,0,.55);' +
      'display:none;align-items:center;justify-content:center}' +
      /* 面板固定铺满整屏（切换大小的功能已取消）+ 浅黄底色（10-03 00:20 加深一档，第一版太淡看着像白的）
         ★ 关键样式一律 !important：抖音自己后插入的样式表压不掉我们（否则会被顶回白底/小窗） */
      '.dyh-box{background:' + BG_PANEL + '!important;width:100%!important;max-width:none;height:100%!important;max-height:none;' +
      'overflow:hidden;border-radius:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom));' +
      'font-size:24px!important;color:#1d2129;' +
      'display:flex!important;flex-direction:column;box-sizing:border-box;line-height:1.65}' +
      '.dyh-box.sz-full{background:' + BG_PANEL + '!important;border-radius:0;font-size:24px!important;' +
      'padding:12px 12px calc(12px + env(safe-area-inset-bottom))!important}' +
      '.dyh-box.sz-s,.dyh-box.sz-m,.dyh-box.sz-l,.dyh-box.sz-xl{background:' + BG_PANEL + '!important}' +
      '.dyh-box h3{margin:0 0 17px!important;font-size:28px!important;display:flex!important;align-items:center;flex:0 0 auto}' +
      '.dyh-box h3 span{margin-left:auto;font-size:40px!important;color:#c9cdd4;padding:0 8px}' +
      '.dyh-ver{font-size:16px!important;color:#c9cdd4;font-weight:400;margin-left:9px!important}' +
      '.dyh-zbtn{font-size:30px!important;color:#4e5969;background:#ffefab;border-radius:8px;' +
      'padding:4px 14px;margin-left:auto!important}' +
      '#dyh-body{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}' +
      '.dyh-btn{display:block;width:100%;margin:11px 0;padding:19px 20px;border:1px solid #ecd98c;border-radius:10px;' +
      'background:#fffbe6;font-size:24px!important;color:#1d2129;text-align:left}' +
      '.dyh-btn.primary{background:#fe2c55;color:#fff;border-color:#fe2c55;font-weight:600}' +
      '.dyh-btn.gray{color:#8a6d1f}' +
      '.dyh-card{background:#ffefab;border-radius:10px;padding:15px 17px;margin-bottom:13px}' +
      '.dyh-row{display:flex;align-items:center;padding:16px 0;border-bottom:1px solid #f2e3a8;font-size:24px!important}' +
      '.dyh-row:last-child{border-bottom:0}' +
      '.dyh-row b{font-weight:500;color:#4e5969}' +
      '.dyh-row span,.dyh-row a{margin-left:auto;color:#1d2129;text-decoration:none}' +
      '.dyh-hl{color:#fe2c55!important;font-weight:600}' +
      '.dyh-item{padding:16px 0;border-bottom:1px solid #f2e3a8}' +
      '.dyh-item-t{font-size:24px!important;line-height:1.5;color:#1d2129}' +
      '.dyh-item-m{display:flex;gap:12px;align-items:center;margin-top:9px;font-size:19px;color:#8a6d1f}' +
      '.dyh-item-m a{margin-left:auto;color:#fe2c55;text-decoration:none;padding:9px 17px}' +
      '.dyh-tip{font-size:19px!important;color:#8a6d1f;line-height:1.75;margin:11px 0}' +
      '.dyh-back{font-size:20px;color:#fe2c55;margin-bottom:13px}' +
      /* ---- 分类下拉选择器 ---- */
      '.dyh-sel{display:flex;align-items:center;gap:8px;background:#ffefab;border:1px solid #ecd98c;' +
      'border-radius:10px;padding:14px 16px;margin:6px 0 10px}' +
      '.dyh-sel b{font-size:25px;font-weight:600;color:#1d2129}' +
      '.dyh-sel .dyh-caret{font-size:20px;color:#8a6d1f}' +
      '.dyh-sel em{margin-left:auto;font-size:18px;font-style:normal;color:#8a6d1f;white-space:nowrap}' +
      '.dyh-sel em b{color:#fe2c55;font-weight:700}' +
      '.dyh-drop{background:#fffbe6;border:1px solid #ecd98c;border-radius:10px;padding:6px 8px;margin:0 0 10px}' +
      '.dyh-drop-i{display:flex;align-items:center;gap:10px;padding:13px 10px;border-bottom:1px solid #f2e3a8;font-size:23px}' +
      '.dyh-drop-i.on{background:#ffe58f;border-radius:8px;font-weight:600}' +
      '.dyh-drop-i em{margin-left:auto;font-size:17px;font-style:normal;color:#8a6d1f;white-space:nowrap}' +
      '.dyh-drop-a{display:flex;gap:8px;flex-wrap:wrap;padding:10px 6px 6px;border-top:1px solid #f2e3a8}' +
      /* ---- 公众号行：名称 / 未读数 / 设分类 / 取关 四个并排 ---- */
      '.dyh-acc2{display:flex;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #f2e3a8}' +
      '.dyh-nm{flex:1 1 auto;min-width:0;font-size:23px;color:#1d2129;line-height:1.35;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dyh-urn2{flex:0 0 auto;font-size:18px;font-weight:700;color:#fe2c55;white-space:nowrap}' +
      '.dyh-urn2.ok{color:#b3a66a;font-weight:400}' +
      '.dyh-acc2 .dyh-mini{flex:0 0 auto;padding:7px 10px;font-size:17px}' +
      /* ---- 某个公众号的未读视频列表 ---- */
      '.dyh-vid{padding:14px 0;border-bottom:1px solid #f2e3a8}' +
      '.dyh-vid-t{font-size:23px;line-height:1.5;color:#1d2129;word-break:break-all}' +
      '.dyh-vid-m{display:flex;align-items:center;gap:10px;margin-top:9px;font-size:19px;color:#8a6d1f}' +
      '.dyh-vid-m span:first-child{margin-right:auto}' +
      '.dyh-mini.go{background:#fe2c55;border-color:#fe2c55;color:#fff;font-weight:600}' +
      /* ---- 老的分类行 / 账号行（保留样式，防止旧页面残留） ---- */
      '.dyh-cat{display:flex;align-items:center;gap:10px;padding:14px 6px;border-bottom:1px solid #f2e3a8}' +
      '.dyh-cat.sel{background:#ffe58f;border-radius:8px;margin:2px -6px;padding-left:12px;padding-right:6px}' +
      '.dyh-cat-l{display:flex;align-items:baseline;gap:9px;min-width:0}' +
      '.dyh-cat-l b{font-size:23px;font-weight:600}' +
      '.dyh-cat-l span{font-size:17px;color:#8a6d1f}' +
      '.dyh-cat-r{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}' +
      '.dyh-mini{display:inline-block;padding:8px 13px;border:1px solid #ecd98c;border-radius:8px;background:#ffefab;' +
      'color:#4e5969;font-size:17px;text-decoration:none;white-space:nowrap}' +
      '.dyh-mini.dg{background:#fff0f1;border-color:#ffd9dc;color:#fe2c55}' +
      '.dyh-mini.on{background:#fe2c55;border-color:#fe2c55;color:#fff;font-weight:600}' +
      '.dyh-acc{padding:13px 0;border-bottom:1px solid #f2e3a8}' +
      '.dyh-acc-t{font-size:23px;color:#1d2129;line-height:1.45;word-break:break-all}' +
      '.dyh-urn{color:#fe2c55;font-weight:700;font-size:18px;margin-left:9px}' +
      '.dyh-urn.ok{color:#b3a66a;font-weight:400;margin-left:9px}' +
      '.dyh-acc-m{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}' +
      '.dyh-input{width:100%;box-sizing:border-box;padding:15px 16px;border:1px solid #ecd98c;border-radius:8px;' +
      'background:#fffbe6;font-size:20px;margin:4px 0 13px}' +
      '.dyh-lb{font-size:18px;color:#8a6d1f;display:block;margin-top:11px}' +
      '.dyh-prog{background:#ffefab;border-radius:8px;padding:16px 18px;margin:12px 0;font-size:19px;line-height:1.75}' +
      /* ---- 抓取进度条 ---- */
      '.dyh-pwrap{background:#fffbe6;border:1px solid #ecd98c;border-radius:12px;padding:16px 18px;margin:12px 0}' +
      '.dyh-ptop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}' +
      '.dyh-pnum{font-size:36px;font-weight:700;color:#fe2c55;line-height:1.1}' +
      '.dyh-pnum small{font-size:20px;font-weight:600}' +
      '.dyh-pcnt{font-size:19px;color:#4e5969;margin-left:auto}' +
      '.dyh-pbar{position:relative;height:22px;background:#f0dfa0;border-radius:11px;overflow:hidden;margin:12px 0 10px}' +
      '.dyh-pin{height:100%;width:0;border-radius:11px;transition:width .35s ease;' +
      'background:linear-gradient(90deg,#fe2c55,#ff7d00);' +
      'background-size:28px 28px;' +
      'animation:dyhmove .9s linear infinite}' +
      '.dyh-pin.cool{background:linear-gradient(90deg,#ff9a2e,#ffc60a)}' +
      '.dyh-pin.risk{background:linear-gradient(90deg,#f53f3f,#ff7d00)}' +
      '.dyh-pin.done{animation:none;background:linear-gradient(90deg,#00b42a,#0fc95d)}' +
      '@keyframes dyhmove{from{background-position:0 0}to{background-position:28px 0}}' +
      '.dyh-pmeta{font-size:17px;color:#86909c;line-height:1.65}' +
      '.dyh-pmeta b{color:#1d2129;font-weight:600}' +
      '.dyh-pnow{font-size:17px;color:#4e5969;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.dyh-pwarn{margin-top:8px;font-size:17px;color:#ff7d00;font-weight:600}';
    document.head.appendChild(st);

    fab = document.createElement('div');
    fab.className = 'dyh-fab';
    fab.textContent = '🎯';
    fab.onclick = function () { open('home'); };
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.className = 'dyh-panel';
    // 结构：h3 只放标题/版本号/关闭，正文单独 #dyh-body（h3 不能包裹 body，否则内容区会缩成一行）
    panel.innerHTML = '<div class="dyh-box"><h3>抖音关注助手<span class="dyh-ver" title="' + esc(VER) + '">' + VER_SHORT + '</span>' +
      '<span data-act="close">×</span></h3><div id="dyh-body"></div></div>';
    panel.addEventListener('click', function (e) {
      if (e.target === panel) { panel.style.display = 'none'; return; }
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'close') { panel.style.display = 'none'; return; }
      onAction(act, el);
    });
    /* 管理页的搜索框：只重渲「账号列表」这一块，输入框本身不重建 → 边打字边过滤，焦点不丢 */
    panel.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.id !== 'dyh-mgr-kw') return;
      MGR.kw = t.value;
      var box = document.getElementById('dyh-mgr-list');
      if (box) box.innerHTML = mgrListHtml(MGR.cat, unreadByAccount());
    });
    document.body.appendChild(panel);
    bodyEl = panel.querySelector('#dyh-body');
    applyBoxSize();   // 按设置里的「界面大小」把面板调好
    // 转屏 / 分屏 / 地址栏收放都会改变视口，跟着重算一次，避免面板尺寸不对
    var reSize = function () { if (panel && panel.style.display === 'flex') applyBoxSize(); };
    window.addEventListener('resize', reSize);
    window.addEventListener('orientationchange', function () { setTimeout(reSize, 300); });
  }

  /* 面板固定「满屏」：宽高都铺满整块手机屏（2026-10-02 23:40：按用户要求取消了切换大小的功能）。
     ★ 双保险：class 用百分比（!important 防抖音样式覆盖）+ inline style 直接写算好的 px
       （inline 优先级最高，即使 CSS 类没命中、或页面样式再怎么压，尺寸也不会退回去） */
  function applyBoxSize() {
    if (!panel) return;
    var box = panel.querySelector('.dyh-box');
    if (!box) return;
    box.className = 'dyh-box sz-full';
    var W = window.innerWidth || 390, H = window.innerHeight || 844;
    box.style.width = Math.round(W) + 'px';
    box.style.height = Math.round(H) + 'px';
    box.style.maxWidth = 'none'; box.style.maxHeight = 'none';
    /* ★ 浅黄底色也用 inline 再写一遍：inline 优先级最高，抖音后插的样式表压不掉，
       即使 CSS 类被页面样式顶掉，底色也不会退回白色（10-03 00:20） */
    box.style.background = BG_PANEL;
    box.style.backgroundColor = BG_PANEL;
    var bd = panel.querySelector('#dyh-body');
    if (bd) { bd.style.background = 'transparent'; }
  }

  function open(view) {
    ensureUI();
    panel.style.display = 'flex';
    applyBoxSize();   // 每次打开都重算一次（视口可能变了，也防止尺寸被页面样式顶回去）
    if (view === 'home') bodyEl.innerHTML = renderHome();
    else if (view === 'manage') bodyEl.innerHTML = renderManage();
    else if (view === 'accv') bodyEl.innerHTML = renderAccVideos();
    else if (view === 'search') bodyEl.innerHTML = renderSearch();
    else if (view === 'settings') bodyEl.innerHTML = renderSettings();
    else bodyEl.innerHTML = renderHome();
    resetScroll();
  }
  function setBody(html) { if (!bodyEl) return; bodyEl.innerHTML = html; resetScroll(); }
  // 内容现在由 #dyh-body 自己滚动，每次换页都要把滚动条拉回顶部
  function resetScroll() { if (bodyEl) bodyEl.scrollTop = 0; }

  /* ==================== 批量取关（管理页用） ====================
     一个一个来，中间隔 2.2 秒（抖音对连点很敏感，批量取关比抓未读更容易被盯）；
     全程可以「🛑 停在这一个」—— 已经取掉的都保留，没到的一概不碰。
     失败的列清单，让人知道是哪些、还能点「主页」自己补一下。 */
  var UF_CANCEL = false;
  function doUnfollowList(targets) {
    if (!targets || !targets.length) return;
    UF_CANCEL = false;
    var doneN = 0, failList = [], n2 = targets.length;
    setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
      '<div class="dyh-prog" id="dyh-prog">开始取关 0/' + n2 + '</div>' +
      '<button class="dyh-btn gray" data-act="uf-stop">🛑 停在这一个（已经取掉的都保留）</button>');
    function finish() {
      save();
      var h = '<div class="dyh-back" data-act="home">← 返回</div>' +
        '<div class="dyh-card">' +
        '<div class="dyh-row"><b>已取关</b><span class="dyh-hl">' + doneN + ' 个</span></div>' +
        '<div class="dyh-row"><b>没成功</b><span>' + failList.length + ' 个</span></div></div>';
      if (failList.length) {
        h += '<div class="dyh-tip">这几个没取成（抖音没点头，多半是弹了验证页）：' + esc(failList.join('、')) +
          ' —— 点每个号右边的「主页」，在新标签页里点一下「已关注」就行。</div>';
      }
      h += '<button class="dyh-btn" data-act="manage">← 回到管理</button>';
      setBody(h);
    }
    function step(i3) {
      if (UF_CANCEL || i3 >= n2) { finish(); return Promise.resolve(); }
      var p = document.getElementById('dyh-prog');
      if (p) p.innerHTML = '取关中 ' + (i3 + 1) + '/' + n2 + '：' + esc(targets[i3].name);
      return setFollow(targets[i3].secUserId, false, targets[i3].name).then(function (r) {
        if (r.ok || r.noop) {
          doneN++;
          S.accounts = S.accounts.filter(function (a) { return a.secUserId !== targets[i3].secUserId; });
        } else failList.push(targets[i3].name);
        return sleep(2200).then(function () { return step(i3 + 1); });
      });
    }
    step(0);
  }

  function onAction(act, el) {
    var i;
    if (act === 'home') { open('home'); return; }
    if (act === 'manage') { open('manage'); return; }
    if (act === 'search') { open('search'); return; }
    if (act === 'settings') { open('settings'); return; }

    if (act === 'open') { var u = el.getAttribute('data-url'); if (u) window.open(u, '_blank'); return; }

    if (act === 'read') {
      var id = el.getAttribute('data-id');
      S.readIds.push(id); save();
      var p = el.parentNode;
      if (p && p.parentNode) p.parentNode.style.opacity = '.4';
      toast('已标记已读'); return;
    }

    if (act === 'refresh') {
      setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-prog" id="dyh-prog">正在读取你的关注列表…</div>');
      fetchFollowing(function (n) {
        var p = document.getElementById('dyh-prog');
        if (p) p.innerHTML = '已读取 ' + n + ' 个关注账号…';
      }).then(function (arr) {
        toast('已刷新：' + arr.length + ' 个关注账号');
        open('home');
      }).catch(function (e) {
        setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-tip" style="color:#f53f3f">失败：' + esc(e.message) +
          '<br><br>多半是没登录抖音网页版。请在本页面登录后再试。</div>');
      });
      return;
    }

    if (act === 'scan' || act === 'scan-resume') {
      var resumeIdx = 0;
      var jobGot = S.scanJob || null;
      if (act === 'scan' && jobGot && jobGot.sig === accountSig() && jobGot.cursor > 0 && jobGot.cursor < S.accounts.length) {
        resumeIdx = jobGot.cursor;
      }
      var scopeTxt = (S.cfg.scanLimit > 0 ? '前 ' + S.cfg.scanLimit + ' 个' : '全部 ' + S.accounts.length + ' 个');
      if (act === 'scan' && resumeIdx > 0) {
        // 上次没抓完 → 先问：继续剩下的，还是从头再来？
        setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
          '<div class="dyh-card"><div class="dyh-row"><b>上次抓到</b><span>' + resumeIdx + ' / ' + S.accounts.length + '</span></div>' +
          '<div class="dyh-row"><b>未完成</b><span>' + (S.accounts.length - resumeIdx) + ' 个</span></div></div>' +
          '<div class="dyh-tip">断点还在。可以直接把剩下的 <b>' + (S.accounts.length - resumeIdx) + ' 个</b>补完' +
          '（已抓过的不会重复请求，最快、也最不容易被抖音盯上），或者重头抓一遍。</div>' +
          '<button class="dyh-btn primary" data-act="scan-resume">▶ 从断点继续（补剩下 ' + (S.accounts.length - resumeIdx) + ' 个）</button>' +
          '<button class="dyh-btn gray" data-act="scan-fresh">↻ 重头全部抓一遍</button>' +
          '<button class="dyh-btn gray" data-act="clear-job">🧹 清掉这个断点（下次直接全抓）</button>');
        return;
      }
      if (act === 'scan-fresh') { S.scanJob = null; save(); }
      var totalN = Math.max(1, (S.cfg.scanLimit > 0
        ? Math.min(S.cfg.scanLimit, S.accounts.length - resumeIdx)
        : (S.accounts.length - resumeIdx)));
      // 进度条骨架只渲染一次，之后只改数字/宽度 —— 这样过渡动画才连贯，按钮也不会被重建
      setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
        '<div class="dyh-pwrap">' +
        '<div class="dyh-ptop"><span class="dyh-pnum" id="dyh-pnum">0<small>%</small></span>' +
        '<span class="dyh-pcnt" id="dyh-pcnt">0 / ' + totalN + '</span></div>' +
        '<div class="dyh-pbar"><div class="dyh-pin" id="dyh-pin"></div></div>' +
        '<div class="dyh-pmeta" id="dyh-pmeta">正在准备…</div>' +
        '<div class="dyh-pnow" id="dyh-pnow"></div>' +
        '<div class="dyh-pwarn" id="dyh-pwarn" style="display:none"></div>' +
        '</div>' +
        '<div class="dyh-tip">本轮计划抓 <b>' + scopeTxt + '</b>（' +
        (resumeIdx > 0 ? '从断点 <b>' + resumeIdx + '</b> 之后的 ' + (S.accounts.length - resumeIdx) + ' 个开始' : '全部') + '）。<br>' +
        '· <b>先走关注页信息流</b>（①阶段）：一次拿 20 条、按时间倒序，翻到上次抓到的时间就追平了 —— <b>2~5 次请求</b>就能核对完几百个账号，这才是「又快又不失败」的关键；<br>' +
        '· 只有信息流<b>没覆盖到</b>的账号才逐个补抓（②阶段，首次使用会多一些，之后很少）；<br>' +
        '· 补抓开局同时抓 <b>3</b> 个，跑得顺自动加（最多 ' + (S.cfg.scanConc || 6) + ' 个），抖音不理人就自动降速；<br>' +
        '· <b>单个账号失败会就地重试 3 次</b>（退避后再来），整轮结束还会再补最多 2 轮 —— 抖一下不算失败；<br>' +
        '· 每请求 8 秒超时、单账号 45 秒、整轮 ' + (S.cfg.scanBudget || 12) + ' 分钟，另有 90 秒「无进展」强制收尾，<b>不会卡死</b>；<br>' +
        '· 抓到一半切走 App / 熄屏 / 断网也没事：下次打开<b>自动从断点接着抓</b>。</div>' +
        '<button class="dyh-btn gray" data-act="stop-scan">🛑 停止（已抓到的都保留）</button>');
      var gid = function (id) { return document.getElementById(id); };
      var mm = function (ms) { var x = Math.max(0, Math.round(ms / 1000)); return Math.floor(x / 60) + '分' + (x % 60) + '秒'; };
      scanUnread(function (s) {
        var num = gid('dyh-pnum'); if (!num) return;      // 已经离开这一页就不画了
        num.innerHTML = s.pct + '<small>%</small>';
        gid('dyh-pcnt').textContent = s.cur + ' / ' + s.total;
        var bar = gid('dyh-pin');
        bar.style.width = s.pct + '%';
        bar.className = 'dyh-pin' + (s.risk ? ' risk' : (s.cool ? ' cool' : ''));
        gid('dyh-pmeta').innerHTML =
          '成功 <b>' + (s.okCount || Math.max(0, s.cur - s.errors)) + '</b>　失败 <b>' + s.errors + '</b>　新增 <b>' + s.newCount + '</b><br>' +
          '并发 <b>' + s.conc + '/' + s.maxConc + '</b>　已用 <b>' + mm(s.elapsed) + '</b>' +
          (s.eta ? '　预计还需 <b>' + mm(s.eta) + '</b>' : '') +
          (s.retries ? '　自动重试 <b>' + s.retries + '</b> 次' : '');
        gid('dyh-pnow').textContent = (s.phase === 'feed' ? '① ' : '② ') + (s.name ? ('当前：' + s.name) : '');
        var w = gid('dyh-pwarn');
        if (s.histErr && !s.hist) { w.style.display = ''; w.textContent = '⚠ 没读到抖音的已看记录（' + s.histErr + '），这一轮只扣掉了本机标记过的；下次抓取会自动重试'; }
        else if (s.risk) { w.style.display = ''; w.textContent = '⚠ 抖音限流中，已自动降速重试（不会算失败）'; }
        else if (s.cool) { w.style.display = ''; w.textContent = '⏳ 正在降速冷却，稍等一下就好'; }
        else if (s.phase === 'feed') { w.style.display = ''; w.textContent = '① 关注页信息流：按时间倒序翻，翻到上次抓取的位置就追平（请求极少，不易被限流）'; }
        else if (s.feedUsed) { w.style.display = ''; w.textContent = '② 逐个补抓信息流没追平的账号（日常很少，首次/隔久了会多一些）'; }
        else { w.style.display = 'none'; }
      }).then(function (r) {
        var bar = gid('dyh-pin');
        if (bar) { bar.style.width = '100%'; bar.className = 'dyh-pin done'; }
        var num = gid('dyh-pnum');
        if (num && r.ok) num.innerHTML = (r.pct == null ? 100 : r.pct) + '<small>%</small>';
        if (!r.ok) { setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-tip" style="color:#f53f3f">' + esc(r.error) + '</div>'); return; }
        S.lastScanAt = Date.now();
        var h = '<div class="dyh-back" data-act="home">← 返回</div>' +
          '<div class="dyh-card">' +
          '<div class="dyh-row"><b>完成率</b><span class="dyh-hl">' + (r.pct == null ? 100 : r.pct) + '%</span></div>' +
          '<div class="dyh-row"><b>新增未读</b><span class="dyh-hl">' + r.newCount + ' 条</span></div>' +
          '<div class="dyh-row"><b>处理账号</b><span>' + r.scanned + (r.resumeAt ? '（断点续 ' + r.resumeAt + '）' : '') + '</span></div>' +
          (r.feedUsed ? '<div class="dyh-row"><b>信息流核对</b><span>' + r.feedCaught + ' 个（只用 ' + r.feedPages + ' 次请求）</span></div>' : '') +
          '<div class="dyh-row"><b>成功 / 失败</b><span>' + r.okCount + ' / ' + r.errors + '</span></div>' +
          (r.retries ? '<div class="dyh-row"><b>自动重试</b><span>' + r.retries + ' 次（已全部救回）</span></div>' : '') +
          (r.risk ? '<div class="dyh-row"><b>风控命中</b><span>' + r.risk + ' 次</span></div>' : '');
        if (r.left) h += '<div class="dyh-row"><b>还剩没抓到</b><span>' + r.left + ' 个（已记入断点）</span></div>';
        h += '</div>';
        if (r.names && r.names.length) {
          h += '<div class="dyh-tip">这次没抓成的（下次会自动补）：' + esc(r.names.join('、')) +
            (r.names.length >= 20 ? ' 等' : '') + '</div>';
        }
        /* 「第二次」最常见的样子：信息流几下就追平、新增 0 条 —— 这是【正常】，不是坏了。
           不写清楚这句，就会有人以为第二次抓不动了（就是你说的「第一次可以、第二次不行」）。 */
        if (!r.newCount && r.feedCaught) {
          h += '<div class="dyh-tip">✅ 本轮用 <b>' + r.feedPages + '</b> 次请求就核对完 <b>' + r.feedCaught + '</b> 个账号：' +
            '你关注的人在这段时间确实没发新视频（只要发，不用逐个问，这几下请求里就直接收进来了）。' +
            '想按账号看谁的未读最多，去「🚫 批量取关 / 管理分类」那一页，每个号后面都标了未读条数。</div>';
        }
        /* 一个都没抓到：明确告诉用户原因，别让他对着「新增未读 0」干瞪眼 */
        if (!r.okCount && !r.feedCaught) {
          h += '<div class="dyh-tip" style="color:#f53f3f">⚠ 这轮<b>一个账号都没抓到</b>（抖音多半是没认登录 / 直接拒了请求）。' +
            '先点「📥 刷新我的关注列表」重新读一次登录态，然后再抓一轮就好。</div>';
        }
        h +=           '<button class="dyh-btn primary" data-act="push">☁️ 推到 GitHub</button>' +
          '<button class="dyh-btn gray" data-act="scan">🔁 再抓一轮（自动补剩下的）</button>';
        if (r.left) h += '<div class="dyh-tip">还有 ' + r.left + ' 个没抓到，点上面「再抓一轮」即可从断点补完，不会重复请求。</div>';
        setBody(h);
      });
      return;
    }

    if (act === 'stop-scan') { stopScan(); return; }
    if (act === 'clear-job') { S.scanJob = null; save(); toast('断点已清除，下次会全部重抓'); open('home'); return; }

    if (act === 'push') {
      setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-prog" id="dyh-prog">正在推送到 GitHub…</div>');
      var payload = buildPayload();
      ghPush('unread.json', JSON.stringify(payload), '手机端更新 ' + fmtTime(Date.now()))
        .then(function (sha) {
          S.lastExport = Date.now(); save();
          setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
            '<div class="dyh-card"><div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + payload.videos.length + ' 条</span></div>' +
            '<div class="dyh-row"><b>账号</b><span>' + payload.accounts.length + ' 个</span></div>' +
            '<div class="dyh-row"><b>commit</b><span>' + esc(String(sha).slice(0, 7)) + '</span></div></div>' +
            '<div class="dyh-tip">推送成功。现在打开手机端 HTML 点「🔄 同步」，或直接访问 raw 地址即可看到最新数据。</div>');
        })
        .catch(function (e) {
          setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-tip" style="color:#f53f3f">推送失败：' + esc(e.message) + '</div>' +
            '<button class="dyh-btn" data-act="settings">⚙️ 去设置检查 GitHub 配置</button>');
        });
      return;
    }

    if (act === 'do-search') {
      var kwEl = document.getElementById('dyh-kw');
      var kw = kwEl ? kwEl.value.trim() : '';
      var box = document.getElementById('dyh-results');
      if (!kw) { if (box) box.innerHTML = '<div class="dyh-tip">先输入昵称</div>'; return; }
      if (box) box.innerHTML = '<div class="dyh-tip">搜索中…</div>';
      searchUsers(kw).then(function (list) {
        if (!box) return;
        if (!list.length) { box.innerHTML = '<div class="dyh-tip">没搜到账号。抖音搜索页结构可能变了，也可以直接在上面搜索框里手动关注。</div>'; return; }
        var h = '';
        for (i = 0; i < list.length; i++) {
          h += '<div class="dyh-item"><div class="dyh-item-t">' + esc(list[i].name) + '</div>' +
            '<div class="dyh-item-m"><span>' + (list[i].following ? '已关注' : '未关注') + '</span>' +
            (list[i].following ? '' : '<a href="javascript:;" data-act="follow" data-sec="' + esc(list[i].secUid) + '" data-name="' + esc(list[i].name) + '">＋ 关注</a>') +
            '</div></div>';
        }
        box.innerHTML = h;
      }).catch(function (e) {
        if (box) box.innerHTML = '<div class="dyh-tip" style="color:#f53f3f">搜索失败：' + esc(e.message) + '</div>';
      });
      return;
    }

    if (act === 'follow') {
      var sec = el.getAttribute('data-sec'), nm = el.getAttribute('data-name');
      toast('正在关注 ' + nm + '…', 8000);
      setFollow(sec, true, nm).then(function (r) {
        toast(r.ok ? ('✅ 已关注 ' + nm) : ('关注失败：' + (r.error || r.state)));
        S.accounts.push({ name: nm, secUserId: sec, category: '' }); save();
      });
      return;
    }

    if (act === 'open-home') {
      var sh = el.getAttribute('data-sec');
      var w = window.open('https://www.douyin.com/user/' + encodeURIComponent(sh), '_blank');
      if (!w) toast('浏览器拦截了新标签页，请允许弹出窗口');
      return;
    }

    if (act === 'unfollow-one') {
      var s1 = el.getAttribute('data-sec'), n1 = el.getAttribute('data-name');
      if (!confirm('确定要在抖音里取关「' + n1 + '」吗？')) return;
      toast('正在取关…', 8000);
      setFollow(s1, false, n1).then(function (r) {
        if (r.ok || r.noop) {
          S.accounts = S.accounts.filter(function (a) { return a.secUserId !== s1; }); save();
          toast('✅ 已取关 ' + n1); open('manage');
          return;
        }
        setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
          '<div class="dyh-tip" style="color:#f53f3f">取关「' + esc(n1) + '」失败：' + esc(r.error || r.state || '未知原因') + '</div>' +
          '<button class="dyh-btn primary" data-act="open-home" data-sec="' + esc(s1) + '">🌐 打开 TA 的主页手动取关</button>' +
          '<div class="dyh-tip">在新标签页里点一下「已关注」按钮即可。手动操作走的是真实页面，不会被验证码拦。</div>');
      });
      return;
    }

    if (act === 'uf-stop') { UF_CANCEL = true; toast('已停手，剩下几个保持原样'); return; }

    /* ---------- 看某个公众号的未读视频 ---------- */
    if (act === 'acc-videos') {
      MGR.acc = el.getAttribute('data-sec') || '';
      if (!MGR.cat) MGR.cat = ALL_CAT;
      open('accv'); return;
    }
    if (act === 'play') {
      var pid = el.getAttribute('data-id');
      openInApp(pid);          // 只唤起抖音 App；网页端不跳转、不开新标签
      if (pid && S.readIds.indexOf(pid) < 0) { S.readIds.push(pid); save(); }
      toast('已唤起抖音 App（网页保持不动）');
      open('accv'); return;
    }
    /* 切换「唤起方式」：scheme → intent → auto → scheme，记住选择 */
    if (act === 'openmode') {
      var m = el.getAttribute('data-mode') || 'scheme';
      S.cfg.openMode = (m === 'intent' || m === 'auto') ? m : 'scheme';
      save();
      toast('唤起方式：' + (m === 'intent' ? '只 intent://' : m === 'auto' ? '自动（会补一次）' : '只 scheme'));
      open('accv'); return;
    }
    if (act === 'read-one') {
      var rid = el.getAttribute('data-id');
      if (rid && S.readIds.indexOf(rid) < 0) { S.readIds.push(rid); save(); }
      toast('已标记已看'); open('accv'); return;
    }

    /* ---------- 管理分类 ---------- */
    if (act === 'cat-pull') { pullCats('cover'); return; }
    if (act === 'cat-merge') { pullCats('merge'); return; }

    /* 点当前分类那一行 → 展开/收起分类下拉 */
    if (act === 'mgr-drop') { MGR.drop = !MGR.drop; MGR.adding = false; MGR.editing = ''; open('manage'); return; }
    if (act === 'mgr-sync') { MGR.sync = true; open('manage'); return; }
    if (act === 'mgr-sync-close') { MGR.sync = false; open('manage'); return; }

    if (act === 'mgr-pick') {
      MGR.cat = el.getAttribute('data-cat'); MGR.drop = false; MGR.adding = false; MGR.editing = '';
      open('manage'); return;
    }
    if (act === 'mgr-newcat') { MGR.adding = true; MGR.editing = ''; MGR.drop = true; open('manage'); return; }
    if (act === 'mgr-rename') { MGR.editing = el.getAttribute('data-cat'); MGR.adding = false; MGR.drop = true; open('manage'); return; }
    if (act === 'mgr-cat-cancel') { MGR.adding = false; MGR.editing = ''; open('manage'); return; }
    if (act === 'mgr-cat-ok') {
      var oldName = el.getAttribute('data-cat');
      var inp = document.getElementById('dyh-catname');
      var newName = inp ? inp.value.trim() : '';
      if (!newName) { toast('分类名不能空'); return; }
      if (newName === oldName) { MGR.editing = ''; open('manage'); return; }
      if (newName.indexOf('|') >= 0) { toast('名字里别用 | 这个符号'); return; }
      if (catNames().indexOf(newName) >= 0) { toast('已经有叫「' + newName + '」的分类了'); return; }
      for (i = 0; i < S.categories.length; i++) if (S.categories[i] === oldName) S.categories[i] = newName;
      for (i = 0; i < S.accounts.length; i++) if ((S.accounts[i].category || '') === oldName) S.accounts[i].category = newName;
      MGR.editing = ''; MGR.cat = newName; save();
      toast('已改名为「' + newName + '」'); open('manage'); return;
    }
    if (act === 'mgr-newcat-ok') {
      var ninp = document.getElementById('dyh-newcat');
      var nc = ninp ? ninp.value.trim() : '';
      if (!nc) { toast('先填个分类名'); return; }
      if (nc.indexOf('|') >= 0) { toast('名字里别用 | 这个符号'); return; }
      if (catNames().indexOf(nc) >= 0) { toast('已经有叫「' + nc + '」的分类了'); return; }
      S.categories.push(nc);
      MGR.adding = false; MGR.cat = nc; save();
      toast('已建分类「' + nc + '」：下面的账号点「设分类」就能归进去'); open('manage'); return;
    }
    if (act === 'mgr-del-cat') {
      var del = el.getAttribute('data-cat');
      var memberN = catCount(del);
      if (memberN && !confirm('「' + del + '」下有 ' + memberN + ' 个账号。\n删掉这个分类后，这 ' + memberN + ' 个账号会落到「未分类」（不会丢账号、也不会取关）。\n确定删吗？')) return;
      S.categories = S.categories.filter(function (c) { return c !== del; });
      for (i = 0; i < S.accounts.length; i++) if ((S.accounts[i].category || '') === del) S.accounts[i].category = '';
      if (MGR.cat === del) MGR.cat = '';
      save(); toast('已删除「' + del + '」'); open('manage'); return;
    }
    if (act === 'mgr-uf-cat') {
      var catk = el.getAttribute('data-cat');
      var tg = S.accounts.filter(function (a) { return catOf(a) === catk; });
      if (!tg.length) { toast('这个分类下没有账号'); return; }
      var mins = Math.max(1, Math.round(tg.length * 2.6 / 60));
      if (!confirm('把「' + (catk === NO_CAT ? '未分类' : catk) + '」下的 ' + tg.length + ' 个账号全取关？\n' +
        '这会真的取消抖音关注，不可撤销。\n一个一个来，每个约 3 秒，大概 ' + mins + ' 分钟。')) return;
      doUnfollowList(tg);
      return;
    }

    if (act === 'setcat') {
      var sec2 = el.getAttribute('data-sec');
      var cur = '';
      for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec2) cur = S.accounts[i].category || '';
      var h2 = '<div class="dyh-back" data-act="manage">← 返回</div><div class="dyh-tip">给这个账号选个分类（现在有哪些分类你说了算）</div>';
      h2 += '<span class="dyh-mini' + (cur ? '' : ' on') + '" style="margin:0 8px 10px 0" data-act="do-setcat" data-sec="' + esc(sec2) + '" data-cat="">未分类</span>';
      var cs = catNames();
      for (i = 0; i < cs.length; i++) {
        h2 += '<span class="dyh-mini' + (cs[i] === cur ? ' on' : '') + '" style="margin:0 8px 10px 0" ' +
          'data-act="do-setcat" data-sec="' + esc(sec2) + '" data-cat="' + esc(cs[i]) + '">' + esc(cs[i]) + '</span>';
      }
      h2 += '<div class="dyh-tip">这些就是在管理页新建的那些分类。想改名/删除/再加一个，回到管理页点分类右边的「改名 / 删 / ＋ 新建分类」。</div>';
      setBody(h2);
      return;
    }

    if (act === 'do-setcat') {
      var sec3 = el.getAttribute('data-sec'), cat3 = el.getAttribute('data-cat');
      for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec3) S.accounts[i].category = cat3;
      save(); toast('已设为「' + (cat3 || '未分类') + '」'); open('manage');
      return;
    }

    if (act === 'scan-mode') {
      var smd = el.getAttribute('data-mode') === 'post' ? 'post' : 'auto';
      S.cfg.scanMode = smd;
      save(); toast(smd === 'post' ? '已切为「只逐个抓」（慢，容易被限流）' : '已切为「智能」：信息流追平 + 逐个补漏（推荐）'); open('settings');
      return;
    }

    if (act === 'save-settings') {
      S.cfg.owner = (document.getElementById('dyh-owner') || {}).value || S.cfg.owner;
      S.cfg.repo = (document.getElementById('dyh-repo') || {}).value || S.cfg.repo;
      S.cfg.branch = (document.getElementById('dyh-branch') || {}).value || S.cfg.branch;
      S.cfg.token = (document.getElementById('dyh-token') || {}).value || '';
      var lim = parseInt((document.getElementById('dyh-limit') || {}).value, 10);
      S.cfg.scanLimit = (lim > 0) ? lim : 0;
      var cc = parseInt((document.getElementById('dyh-conc') || {}).value, 10);
      S.cfg.scanConc = (cc >= 1 && cc <= 10) ? cc : (S.cfg.scanConc || 6);
      var bg = parseInt((document.getElementById('dyh-budget') || {}).value, 10);
      S.cfg.scanBudget = (!bg || bg < 0) ? 0 : Math.min(60, bg);
      save(); toast('已保存' + (S.cfg.scanLimit ? '（每轮抓前 ' + S.cfg.scanLimit + ' 个）' : '（全部抓取，并发上限 ' + S.cfg.scanConc + '）')); open('home');
      return;
    }

    if (act === 'export') {
      var blob = new Blob([JSON.stringify(buildPayload())], { type: 'application/json' });
      var a2 = document.createElement('a');
      a2.href = URL.createObjectURL(blob);
      a2.download = '抖音未读-' + Date.now() + '.json';
      document.body.appendChild(a2); a2.click();
      setTimeout(function () { URL.revokeObjectURL(a2.href); a2.remove(); }, 1500);
      toast('已下载'); return;
    }

    if (act === 'clear') {
      if (!confirm('确定清空本机保存的关注列表、视频库和已读记录吗？（不影响抖音账号本身）')) return;
      S.accounts = []; S.videos = []; S.readIds = []; save(); toast('已清空'); open('home');
      return;
    }
  }

  /* ★ 你在本浏览器里打开某个视频（点未读列表里的标题就会跳这里）→ 自动记成「已看」，
     和抖音 App 的行为一致：看了就从「未读」里掉下去，不用再去点那颗「已读」。
     注意：在 App 里看的话，这个自动记不下来，要靠上面那套「抖音已看记录」在下次抓取时同步。 */
  function autoMarkCurrentRead() {
    try {
      var href = (location && (location.href || location.pathname)) || '';
      var m = /\/video\/(\d+)/.exec(href);
      if (!m) return false;
      var id = String(m[1]);
      for (var i = 0; i < S.readIds.length; i++) if (S.readIds[i] === id) return false;
      S.readIds.push(id); save();
      toast('已标记为已看，未读里会少这一条');
      return true;
    } catch (e) { return false; }
  }

  /* ----------------------------- 启动 ----------------------------- */
  function boot() {
    if (!/www\.douyin\.com/.test(location.host)) return;
    autoMarkCurrentRead();
    /* 如果这是一个被脚本打开的「取关/关注」用标签页，先让它自动点完按钮再挂面板 */
    try { autoFollowWorker(); } catch (e) { console.warn('[抖音关注助手] 自动点击异常：', e); }
    ensureUI();
    console.log('[抖音关注助手] 已加载。右下角 🎯 按钮打开面板。');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 暴露内部能力，方便在控制台排查（无害，也可当作高级用法入口） */
  window.DYHelper = {
    version: VER,
    state: function () { return S; },
    unread: unreadVideos,
    renderHome: renderHome,
    renderManage: renderManage,
    renderAccVideos: renderAccVideos,
    mgrListHtml: mgrListHtml,
    catNames: catNames,
    catLabel: catLabel,
    mgr: function () { return MGR; },
    unreadVideosOf: unreadVideosOf,
    openInApp: openInApp,
    unreadByAccount: unreadByAccount,
    applyCatFile: applyCatFile,
    pullCats: pullCats,
    applyBoxSize: applyBoxSize,
    save: save,
    getSelfSecUid: getSelfSecUid,
    fetchFollowing: fetchFollowing,
    fetchPosts: fetchPosts,
    searchUsers: searchUsers,
    setFollow: setFollow,
    buildPayload: buildPayload,
    scan: scanUnread,
    stop: stopScan,
    push: function () { return ghPush('unread.json', JSON.stringify(buildPayload()), '手机端更新 ' + fmtTime(Date.now())); },
    openPanel: function () { open('home'); }
  };
})();
