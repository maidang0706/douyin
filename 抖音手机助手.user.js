// ==UserScript==
// @name         抖音关注助手（手机免电脑版）
// @namespace    dy-phone-helper
// @version      1.0.0
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

  /* ----------------------------- 存储 ----------------------------- */
  var S = loadState();
  function loadState() {
    var def = {
      cfg: { owner: 'maidang0706', repo: 'douyin', branch: 'main', token: '', scanLimit: 0, scanConc: 6, scanBudget: 12, uiScale: 'l' },
      selfSecUid: '',
      accounts: [],      // [{name, secUserId, category}]
      videos: [],        // [{awemeId, account, title, url, publishTime, publishedAt, thumbnail}]
      readIds: [],       // 已读视频 awemeId
      lastExport: 0,
      lastScanAt: 0,
      scanJob: null      // 断点：{sig, startIdx, cursor, ts}，中断/被杀后下次从这里续
    };
    try {
      var raw = localStorage.getItem(LS);
      if (!raw) return def;
      var o = JSON.parse(raw);
      for (var k in def) if (!(k in o)) o[k] = def[k];
      if (!o.cfg) o.cfg = def.cfg;
      if (!o.cfg.uiScale) o.cfg.uiScale = 'l';   // 老用户升级后自动用「更大」
      if (!o.cfg.scanConc) o.cfg.scanConc = 6;
      if (!o.cfg.scanBudget) o.cfg.scanBudget = 12;
      /* ★ 一次性迁移（2026-10-02）：老版本 scanConc 被上一轮迁移统一提到 6，
         结果一上来 6 并发猛打 → 失败率飙升 + 超时卡死。改回「上限 6，但开局只用 3」。
         断点（scanJob）也顺手清掉，免得带着半程状态起跑。 */
      if (!o._spdMig2) {
        o.cfg.scanConc = 6; o.cfg.scanBudget = 12; o.scanJob = null; o._spdMig2 = 1;
      }
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
        'padding:10px 16px;border-radius:20px;font-size:14px;z-index:2147483647;max-width:86vw;line-height:1.5;pointer-events:none;transition:opacity .25s';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.opacity = '0'; }, ms || 2600);
  }

  /* ----------------------------- 抖音接口 ----------------------------- */
  function commonParams(extra) {
    var o = {
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      pc_client_type: '1', version_code: '190500', version_name: '19.5.0',
      cookie_enabled: 'true', screen_width: String(window.screen.width || 1920),
      screen_height: String(window.screen.height || 1080),
      browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome',
      browser_version: '120.0.0.0', browser_online: 'true',
      engine_name: 'Blink', engine_version: '120.0.0.0',
      os_name: 'Windows', os_version: '10', cpu_core_num: '8', device_memory: '8',
      platform: 'PC', downlink: '10', effective_type: '4g', round_trip_time: '50'
    };
    for (var k in (extra || {})) o[k] = extra[k];
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
  // opt: { tries, backoff, timeout, signal }  —— signal 用于「停止抓取」时一次性掐掉所有在途请求
  function dyGet(base, params, opt) {
    opt = opt || {};
    var tries = (opt.tries == null) ? 2 : opt.tries;      // 除首次外额外重试次数
    var back = opt.backoff || [500, 1100, 2200];
    var timeout = opt.timeout || 8000;
    function once(n) {
      return rawFetch(base + '?' + q(params), timeout, opt.signal).then(parseJsonSafe).catch(function (e) {
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

  /* 抓单个账号的最新作品（opt.signal 可传入用于整体停止） */
  function fetchPosts(secUid, opt) {
    return dyGet(API_POST, commonParams({ sec_user_id: secUid, count: '20', max_cursor: '0' }), opt)
      .then(function (j) {
        var list = j.aweme_list || [];
        return list.map(function (a) {
          var cover = (a.video && a.video.cover && a.video.cover.url_list && a.video.cover.url_list[0]) ||
            (a.video && a.video.origin_cover && a.video.origin_cover.url_list && a.video.origin_cover.url_list[0]) || '';
          return {
            awemeId: String(a.aweme_id),
            account: (a.author && a.author.nickname) || '',
            title: (a.desc || '').trim(),
            url: 'https://www.douyin.com/video/' + a.aweme_id,
            publishTime: a.create_time ? fmtTime(Number(a.create_time) * 1000) : '',
            publishedAt: a.create_time ? Number(a.create_time) * 1000 : 0,
            thumbnail: cover
          };
        });
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

    /* 断点：只有「关注列表没变 + 上次确实没抓完」才续跑 */
    var j = S.scanJob || null;
    var resumeFrom = 0;
    if (j && j.sig === accountSig() && j.cursor > 0 && j.cursor < S.accounts.length) resumeFrom = j.cursor;

    var lim = parseInt(limitOverride != null ? limitOverride : S.cfg.scanLimit, 10);
    if (!lim || lim <= 0 || lim > S.accounts.length) lim = S.accounts.length;
    var plan = S.accounts.slice(resumeFrom, Math.min(S.accounts.length, resumeFrom + lim));
    if (!plan.length) { scanning = false; return Promise.resolve({ ok: false, error: '没有待抓的账号' }); }
    S.scanJob = { sig: accountSig(), startIdx: resumeFrom, cursor: 0, ts: Date.now() };

    var newCount = 0, errors = 0, okCount = 0;
    var consecOk = 0, consecFail = 0, coolUntil = 0, riskHits = 0, riskStreak = 0, bailout = false, dispatched = 0;
    // 上限取设置里的值（默认 6），但【开局只用 3 个】——先探路，顺了再往上加
    var maxConc = Math.max(1, Math.min(10, parseInt(S.cfg.scanConc, 10) || 6));
    var conc = Math.min(3, maxConc);
    var known = {}, readMap = {}, failed = [];
    for (var i = 0; i < S.videos.length; i++) known[S.videos[i].awemeId] = 1;
    for (var r = 0; r < S.readIds.length; r++) readMap[S.readIds[r]] = 1;

    function absorb(list) {
      for (var k = 0; k < list.length; k++) {
        var v = list[k];
        if (!known[v.awemeId] && !readMap[v.awemeId]) { S.videos.push(v); known[v.awemeId] = 1; newCount++; }
      }
    }
    // AIMD：顺了才加速，卡了立刻减速
    function onGood() {
      consecOk++; consecFail = 0;
      if (consecOk >= 5 && conc < maxConc) { conc++; consecOk = 0; }
    }
    function onBad(e) {
      errors++; consecOk = 0; consecFail++;
      if (e && e.risk) {                                   // 风控：降到底 + 长冷却，宁慢也别被封
        riskHits++; riskStreak++; consecFail = 0;
        conc = 1;
        coolUntil = Date.now() + 4000 + Math.random() * 2000;
        // 连续 3 次被风控 = 抖音正在盯你：别再硬磨了，直接收工，剩下的记进断点下次补
        if (riskStreak >= 3) { bailout = true; stopped = true; toast('抖音连续拒绝 3 次（风控中），本轮先收尾；没抓完的账号下次会从断点补。', 6000); }
      } else if (consecFail >= 2) {                        // 普通连挂：砍半 + 短冷却
        consecFail = 0; riskStreak = 0;
        conc = Math.max(1, Math.floor(conc / 2));
        coolUntil = Date.now() + 1800 + Math.random() * 1200;
      }
    }
    function shouldStop() { return stopFlag || bailout; }

    var lastReportAt = 0, startedAt = Date.now(), lastSnap = null;
    function snap(name) {
      var now = Date.now();
      var elapsed = now - startedAt;
      var cur = Math.min(okCount + errors, plan.length);
      return {
        cur: cur, total: plan.length, name: name || (lastSnap ? lastSnap.name : ''), newCount: newCount, errors: errors,
        conc: conc, maxConc: maxConc, risk: riskHits, stopped: stopped,
        elapsed: elapsed,
        eta: (plan.length - cur) > 0 ? Math.round((plan.length - cur) * (cur ? elapsed / cur : 0)) : 0,
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

    // 跑一个账号；无论成功失败都会 resolve，绝不把并发槽位漏掉（漏槽位 = 卡死的元凶）
    function runItem(acc) {
      var waitMs = Math.max(0, coolUntil - Date.now()) + Math.floor(Math.random() * 60); // 错峰 + 冷却
      dispatched++;
      return sleep(waitMs).then(function () {
        if (shouldStop()) return;
        return hardLimit(fetchPosts(acc.secUserId, { signal: scanCtrl ? scanCtrl.signal : null })
          .then(function (list) {
            if (shouldStop()) return;
            okCount++; acc.lastError = ''; acc.lastCount = list.length;
            absorb(list); onGood(); scheduleSave(); report(acc.name);
          }), 45000).catch(function (e) {
            if (shouldStop()) return;
            acc.lastError = (e && e.message) || '抓取失败';
            onBad(e);
            failed.push(acc);
            report(acc.name);
          });
      });
    }

    // 滑动窗口：谁回来谁补位；冷却期间由 runItem 自己等，槽位不空转
    function pump(items) {
      return new Promise(function (resolve) {
        var cursor = 0, active = 0, done = 0, ended = false;
        function finish() { if (ended) return; ended = true; resolve(); }
        function tick() {
          if (shouldStop()) { finish(); return; }
          while (active < conc && cursor < items.length) {
            active++;
            runItem(items[cursor]).then(function () {
              active--; done++;
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
      // 中途收尾时，断点回退到「失败的那几个」之前 —— 下次续跑会先把它们补上，一个都不漏
      S.scanJob = stopped
        ? { sig: accountSig(), startIdx: resumeFrom, cursor: resumeFrom + Math.max(0, Math.min(dispatched, plan.length) - failed.length), ts: Date.now() }
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
      // 还差点没抓到：总账号数 − 断点之前就已成功的 − 本轮成功的
      var left = Math.max(0, S.accounts.length - resumeFrom - okCount);
      return {
        ok: true, newCount: newCount, errors: errors, okCount: okCount, scanned: plan.length,
        conc: conc, risk: riskHits, stopped: stopped, resumeAt: resumeFrom, left: left,
        names: lastScanFailed.slice(0, 20)
      };
    }

    return pump(plan).then(function () {
      // 主流程跑完，把失败的账号用同样的并发窗口补抓一遍（比原来「一个一个串行」快得多）
      // 注意：如果是被风控逼停的，就不补抓了——再打也是同样的拒绝，留到下次断点重试
      if (failed.length && !shouldStop()) {
        var retryList = failed.slice(); failed = [];
        return pump(retryList).then(function () {
          cleanup(); report('', true);
          return resultObj();
        });
      }
      cleanup(); report('', true);
      return resultObj();
    }).catch(function (e) {
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
  var CATS = ['朋友', '军事', '学习', '工作', '实时新闻', '钓鱼', '娱乐'];

  function renderHome() {
    var unread = unreadVideos();
    var h = '';
    h += '<div class="dyh-card">';
    h += '<div class="dyh-row"><b>账号</b><span>' + (S.selfSecUid ? '已登录' : '未识别') + '</span></div>';
    h += '<div class="dyh-row"><b>关注公众号</b><span>' + S.accounts.length + ' 个</span></div>';
    h += '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + unread.length + ' 条</span></div>';
    h += '<div class="dyh-row"><b>上次抓取</b><span>' + (S.lastScanAt ? fmtTime(S.lastScanAt) : '从未') + '</span></div>';
    h += '</div>';
    h += '<button class="dyh-btn primary" data-act="scan">🔍 抓最新未读视频</button>';
    h += '<button class="dyh-btn" data-act="refresh">📥 刷新我的关注列表</button>';
    h += '<button class="dyh-btn" data-act="list">📺 看未读列表（' + unread.length + '）</button>';
    h += '<button class="dyh-btn" data-act="manage">🚫 批量取关 / 管理分类</button>';
    h += '<button class="dyh-btn" data-act="search">🔎 搜索并关注新账号</button>';
    h += '<button class="dyh-btn" data-act="push">☁️ 推到 GitHub（手机端 HTML 可看）</button>';
    h += '<button class="dyh-btn gray" data-act="settings">⚙️ 设置（GitHub / 数据）</button>';
    return h;
  }

  function unreadVideos() {
    var readMap = {};
    for (var i = 0; i < S.readIds.length; i++) readMap[S.readIds[i]] = 1;
    return S.videos.filter(function (v) { return !readMap[v.awemeId]; })
      .sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
  }

  function renderList() {
    var v = unreadVideos();
    var h = '<div class="dyh-back" data-act="home">← 返回</div>';
    h += '<div class="dyh-tip">共 ' + v.length + ' 条未读，点「已读」标记，点标题用抖音打开</div>';
    var n = Math.min(v.length, 300);
    for (var i = 0; i < n; i++) {
      var it = v[i];
      h += '<div class="dyh-item">' +
        '<div class="dyh-item-t" data-act="open" data-url="' + esc(it.url) + '">' + esc(it.title || '（无标题）') + '</div>' +
        '<div class="dyh-item-m"><span>' + esc(it.account || '') + '</span><span>' + esc(it.publishTime || '') + '</span>' +
        '<a href="javascript:;" data-act="read" data-id="' + esc(it.awemeId) + '">已读</a></div></div>';
    }
    if (v.length > n) h += '<div class="dyh-tip">仅显示最新 300 条（共 ' + v.length + ' 条）</div>';
    return h;
  }

  function renderManage() {
    var h = '<div class="dyh-back" data-act="home">← 返回</div>';
    h += '<div class="dyh-tip">选分类可批量取关；也可单独给账号设分类</div>';
    h += '<div class="dyh-card"><div class="dyh-row"><b>按分类批量取关</b><span></span></div>';
    for (var c = 0; c < CATS.length; c++) {
      var cnt = S.accounts.filter(function (a) { return a.category === CATS[c]; }).length;
      h += '<div class="dyh-row"><b>' + esc(CATS[c]) + '</b><a href="javascript:;" data-act="unfollow-cat" data-cat="' + esc(CATS[c]) + '">' +
        (cnt ? '取关这 ' + cnt + ' 个' : '无') + '</a></div>';
    }
    var noCat = S.accounts.filter(function (a) { return !a.category; }).length;
    if (noCat) h += '<div class="dyh-row"><b>未分类</b><a href="javascript:;" data-act="unfollow-cat" data-cat="">取关这 ' + noCat + ' 个</a></div>';
    h += '</div>';
    h += '<div class="dyh-tip">单个账号（点右侧 ✕ 取关，点分类名改分类）</div>';
    var list = S.accounts.slice(0, 200);
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      h += '<div class="dyh-item"><div class="dyh-item-t">' + esc(a.name || a.secUserId) + '</div>' +
        '<div class="dyh-item-m">' +
        '<a href="javascript:;" data-act="open-home" data-sec="' + esc(a.secUserId) + '">🌐 主页</a>' +
        '<a href="javascript:;" data-act="setcat" data-sec="' + esc(a.secUserId) + '">' + esc(a.category || '设分类') + '</a>' +
        '<a href="javascript:;" data-act="unfollow-one" data-sec="' + esc(a.secUserId) + '" data-name="' + esc(a.name) + '">✕ 取关</a></div></div>';
    }
    return h;
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
    h += '<label class="dyh-lb">助手界面大小（点了立刻生效，不用重开）</label><div style="display:flex;gap:8px;margin:4px 0 2px">' +
      '<button class="dyh-btn' + (S.cfg.uiScale === 's' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="ui-size" data-size="s">小</button>' +
      '<button class="dyh-btn' + (S.cfg.uiScale === 'm' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="ui-size" data-size="m">中</button>' +
      '<button class="dyh-btn' + (S.cfg.uiScale === 'l' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="ui-size" data-size="l">更大</button>' +
      '</div>' +
      '<div class="dyh-tip" style="margin-top:2px">默认「更大」= 宽占屏幕 96%、高占 93%，四周只留一点点边，字也跟着放大了一档。越小越省屏幕、越看得清全貌。</div>';
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
    return h;
  }

  /* ----------------------------- 面板骨架 ----------------------------- */
  var fab = null, panel = null, bodyEl = null;

  function ensureUI() {
    if (fab) return;
    var st = document.createElement('style');
    st.textContent =
      '.dyh-fab{position:fixed;right:16px;bottom:calc(28px + env(safe-area-inset-bottom));z-index:2147483640;' +
      'width:66px;height:66px;border-radius:50%;background:#fe2c55;color:#fff;font-size:32px;line-height:66px;' +
      'text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none}' +
      '.dyh-panel{position:fixed;left:0;right:0;bottom:0;top:0;z-index:2147483645;background:rgba(0,0,0,.55);' +
      'display:none;align-items:center;justify-content:center}' +
      /* 默认「更大」：宽 96% / 高 93%，四周只留一点点边，几乎就是铺满手机屏（10-02 按用户要求放大） */
      '.dyh-box{background:#fff;width:96%;max-width:980px;height:93%;max-height:920px;overflow:hidden;' +
      'border-radius:14px;padding:14px 16px calc(18px + env(safe-area-inset-bottom));font-size:17px;color:#1d2129;' +
      'display:flex;flex-direction:column}' +
      '.dyh-box.sz-s{width:74%;max-width:540px;height:70%;max-height:560px;font-size:15px}' +
      '.dyh-box.sz-m{width:88%;max-width:720px;height:85%;max-height:720px;font-size:16px}' +
      '.dyh-box.sz-l{width:96%;max-width:980px;height:93%;max-height:920px;font-size:17px}' +
      '.dyh-box h3{margin:0 0 12px;font-size:19px;display:flex;align-items:center;flex:0 0 auto}' +
      '.dyh-box h3 span{margin-left:auto;font-size:32px;color:#c9cdd4;padding:0 8px}' +
      '#dyh-body{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}' +
      '.dyh-btn{display:block;width:100%;margin:8px 0;padding:15px 16px;border:1px solid #e5e6eb;border-radius:10px;' +
      'background:#fff;font-size:17px;color:#1d2129;text-align:left}' +
      '.dyh-btn.primary{background:#fe2c55;color:#fff;border-color:#fe2c55;font-weight:600}' +
      '.dyh-btn.gray{color:#86909c}' +
      '.dyh-card{background:#f7f8fa;border-radius:10px;padding:11px 13px;margin-bottom:10px}' +
      '.dyh-row{display:flex;align-items:center;padding:11px 0;border-bottom:1px solid #f0f0f0;font-size:16px}' +
      '.dyh-row:last-child{border-bottom:0}' +
      '.dyh-row b{font-weight:500;color:#4e5969}' +
      '.dyh-row span,.dyh-row a{margin-left:auto;color:#1d2129;text-decoration:none}' +
      '.dyh-hl{color:#fe2c55!important;font-weight:600}' +
      '.dyh-item{padding:11px 0;border-bottom:1px solid #f2f3f5}' +
      '.dyh-item-t{font-size:16px;line-height:1.5;color:#1d2129}' +
      '.dyh-item-m{display:flex;gap:12px;align-items:center;margin-top:6px;font-size:14px;color:#86909c}' +
      '.dyh-item-m a{margin-left:auto;color:#fe2c55;text-decoration:none;padding:6px 12px}' +
      '.dyh-tip{font-size:14px;color:#86909c;line-height:1.6;margin:8px 0}' +
      '.dyh-back{font-size:15px;color:#fe2c55;margin-bottom:10px}' +
      '.dyh-input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e5e6eb;border-radius:8px;' +
      'font-size:16px;margin:4px 0 10px}' +
      '.dyh-lb{font-size:13px;color:#86909c;display:block;margin-top:8px}' +
      '.dyh-prog{background:#f2f3f5;border-radius:8px;padding:11px 13px;margin:10px 0;font-size:14px;line-height:1.6}';
    document.head.appendChild(st);

    fab = document.createElement('div');
    fab.className = 'dyh-fab';
    fab.textContent = '🎯';
    fab.onclick = function () { open('home'); };
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.className = 'dyh-panel';
    panel.innerHTML = '<div class="dyh-box"><h3>抖音关注助手<span data-act="close">×</span><div id="dyh-body"></div></h3></div>';
    // 修正结构：h3 不应包裹 body，重建
    panel.innerHTML = '<div class="dyh-box"><h3>抖音关注助手<span data-act="close">×</span></h3><div id="dyh-body"></div></div>';
    panel.addEventListener('click', function (e) {
      if (e.target === panel) { panel.style.display = 'none'; return; }
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'close') { panel.style.display = 'none'; return; }
      onAction(act, el);
    });
    document.body.appendChild(panel);
    bodyEl = panel.querySelector('#dyh-body');
    applyBoxSize();   // 按设置里的「界面大小」把面板调好
  }

  /* 界面大小三档：s=小(74%) / m=中(88%) / l=更大(96%，默认) */
  function applyBoxSize() {
    if (!panel) return;
    var box = panel.querySelector('.dyh-box');
    if (!box) return;
    var s = (S.cfg && S.cfg.uiScale) || 'l';
    if (s !== 's' && s !== 'm') s = 'l';
    box.className = 'dyh-box sz-' + s;
    box.style.width = ''; box.style.height = '';
  }

  function open(view) {
    ensureUI();
    panel.style.display = 'flex';
    if (view === 'home') bodyEl.innerHTML = renderHome();
    else if (view === 'list') bodyEl.innerHTML = renderList();
    else if (view === 'manage') bodyEl.innerHTML = renderManage();
    else if (view === 'search') bodyEl.innerHTML = renderSearch();
    else if (view === 'settings') bodyEl.innerHTML = renderSettings();
    else bodyEl.innerHTML = renderHome();
    resetScroll();
  }
  function setBody(html) { bodyEl.innerHTML = html; resetScroll(); }
  // 内容现在由 #dyh-body 自己滚动，每次换页都要把滚动条拉回顶部
  function resetScroll() { if (bodyEl) bodyEl.scrollTop = 0; }

  function onAction(act, el) {
    var i;
    if (act === 'home') { open('home'); return; }
    if (act === 'list') { open('list'); return; }
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
      setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
        '<div class="dyh-prog" id="dyh-prog">准备抓取…</div>' +
        '<div class="dyh-tip">本轮计划抓 <b>' + scopeTxt + '</b>（' +
        (resumeIdx > 0 ? '从断点 <b>' + resumeIdx + '</b> 之后的 ' + (S.accounts.length - resumeIdx) + ' 个开始' : '全部') + '）。<br>' +
        '· 开局同时抓 <b>3</b> 个，跑得顺会自动加（最多 ' + (S.cfg.scanConc || 6) + ' 个），发现抖音不理人就自动降速冷却；<br>' +
        '· 每个请求都有超时保护，单个账号最多卡 45 秒，整轮最长 ' + (S.cfg.scanBudget || 12) + ' 分钟，<b>不会卡死</b>；<br>' +
        '· 抓到一半切走 App / 熄屏 / 断网也没事：下次打开<b>自动从断点接着抓</b>；<br>' +
        '· 想马上收工就按「🛑 停止」，没抓完的会记进断点。</div>');
      scanUnread(function (s) {
        var p = document.getElementById('dyh-prog');
        if (!p) return;
        var mm = function (ms) { var x = Math.max(0, Math.round(ms / 1000)); return Math.floor(x / 60) + '分' + (x % 60) + '秒'; };
        var bar = Math.round(s.cur / Math.max(1, s.total) * 20);
        p.innerHTML = '已抓 <b>' + s.cur + '/' + s.total + '</b>　新增 <b>' + s.newCount + '</b>' +
          (s.errors ? '　失败 ' + s.errors : '') + '<br>' +
          '<span style="color:#c9cdd4">' + '█'.repeat(bar) + '<span style="opacity:.35">' + '░'.repeat(20 - bar) + '</span></span><br>' +
          '并发 <b>' + s.conc + '/' + s.maxConc + '</b>　已用 ' + mm(s.elapsed) +
          (s.eta ? '　预计还要 ' + mm(s.eta) : '') + '<br>' +
          (s.cool ? '<b style="color:#ff7d00">⚠ 抖音在冷却，正在降速（不顺就慢，但不会失败）</b><br>' : '') +
          (s.risk ? '风控命中 ' + s.risk + ' 次　' : '') + '当前：' + esc(s.name) +
          '<div style="margin-top:10px"><button class="dyh-btn gray" data-act="stop-scan">🛑 停止（已抓到的都保留）</button></div>';
      }).then(function (r) {
        var p = document.getElementById('dyh-prog');
        if (p && p.parentNode) p.parentNode.style.display = 'none';
        if (!r.ok) { setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-tip" style="color:#f53f3f">' + esc(r.error) + '</div>'); return; }
        S.lastScanAt = Date.now();
        var h = '<div class="dyh-back" data-act="home">← 返回</div>' +
          '<div class="dyh-card"><div class="dyh-row"><b>新增未读</b><span class="dyh-hl">' + r.newCount + ' 条</span></div>' +
          '<div class="dyh-row"><b>处理账号</b><span>' + r.scanned + (r.resumeAt ? '（断点续 ' + r.resumeAt + '）' : '') + '</span></div>' +
          '<div class="dyh-row"><b>成功 / 失败</b><span>' + r.okCount + ' / ' + r.errors + '</span></div>' +
          (r.risk ? '<div class="dyh-row"><b>风控命中</b><span>' + r.risk + ' 次</span></div>' : '');
        if (r.left) h += '<div class="dyh-row"><b>还剩没抓到</b><span>' + r.left + ' 个（已记入断点）</span></div>';
        h += '</div>';
        if (r.names && r.names.length) {
          h += '<div class="dyh-tip">这次没抓成的（下次会自动补）：' + esc(r.names.join('、')) +
            (r.names.length >= 20 ? ' 等' : '') + '</div>';
        }
        h += '<button class="dyh-btn primary" data-act="push">☁️ 推到 GitHub</button>' +
          '<button class="dyh-btn" data-act="list">📺 看未读列表</button>' +
          '<button class="dyh-btn gray" data-act="scan">🔁 再抓一轮（自动补剩下的）</button>';
        if (r.left) h += '<div class="dyh-tip">还有 ' + r.left + ' 个没抓到，点上面「再抓一轮」即可从断点补完，不会重复请求。</div>';
        setBody(h);
      });
      return;
    }

    if (act === 'stop-scan') { stopScan(); return; }
    if (act === 'clear-job') { S.scanJob = null; save(); toast('断点已清除，下次会全部重抓'); open('home'); return; }

    if (act === 'ui-size') {
      var sz = el.getAttribute('data-size');
      if (sz === 's' || sz === 'm' || sz === 'l') {
        S.cfg.uiScale = sz; save(); applyBoxSize();
        toast('界面已改成「' + (sz === 's' ? '小' : sz === 'm' ? '中' : '更大') + '」');
      }
      open('settings');   // 重新渲染，让选中态亮起来
      return;
    }

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

    if (act === 'unfollow-cat') {
      var cat = el.getAttribute('data-cat');
      var targets = S.accounts.filter(function (a) { return (a.category || '') === cat; });
      if (!targets.length) { toast('该分类下没有账号'); return; }
      if (!confirm('确定要取关「' + (cat || '未分类') + '」下的 ' + targets.length + ' 个账号吗？此操作会真的取消抖音关注，不可撤销。')) return;
      setBody('<div class="dyh-back" data-act="home">← 返回</div><div class="dyh-prog" id="dyh-prog">开始批量取关 0/' + targets.length + '</div>');
      var doneN = 0, failN = 0;
      function next(i2) {
        if (i2 >= targets.length) {
          save();
          setBody('<div class="dyh-back" data-act="home">← 返回</div>' +
            '<div class="dyh-card"><div class="dyh-row"><b>取关成功</b><span>' + doneN + '</span></div>' +
            '<div class="dyh-row"><b>失败</b><span>' + failN + '</span></div></div>' +
            '<button class="dyh-btn" data-act="manage">← 回到管理</button>');
          return Promise.resolve();
        }
        var p = document.getElementById('dyh-prog');
        if (p) p.innerHTML = '取关中 ' + (i2 + 1) + '/' + targets.length + '：' + esc(targets[i2].name);
        return setFollow(targets[i2].secUserId, false, targets[i2].name).then(function (r) {
          if (r.ok || r.noop) {
            doneN++;
            S.accounts = S.accounts.filter(function (a) { return a.secUserId !== targets[i2].secUserId; });
          } else failN++;
          return sleep(2200).then(function () { return next(i2 + 1); });
        });
      }
      next(0);
      return;
    }

    if (act === 'setcat') {
      var sec2 = el.getAttribute('data-sec');
      var cur = '';
      for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec2) cur = S.accounts[i].category || '';
      var h2 = '<div class="dyh-back" data-act="manage">← 返回</div><div class="dyh-tip">选择分类</div>';
      for (i = 0; i < CATS.length; i++) {
        h2 += '<button class="dyh-btn' + (CATS[i] === cur ? ' primary' : '') + '" data-act="do-setcat" data-sec="' + esc(sec2) + '" data-cat="' + esc(CATS[i]) + '">' + esc(CATS[i]) + '</button>';
      }
      h2 += '<button class="dyh-btn gray" data-act="do-setcat" data-sec="' + esc(sec2) + '" data-cat="">清除分类</button>';
      setBody(h2);
      return;
    }

    if (act === 'do-setcat') {
      var sec3 = el.getAttribute('data-sec'), cat3 = el.getAttribute('data-cat');
      for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec3) S.accounts[i].category = cat3;
      save(); toast('已设为「' + (cat3 || '未分类') + '」'); open('manage');
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

  /* ----------------------------- 启动 ----------------------------- */
  function boot() {
    if (!/www\.douyin\.com/.test(location.host)) return;
    /* 如果这是一个被脚本打开的「取关/关注」用标签页，先让它自动点完按钮再挂面板 */
    try { autoFollowWorker(); } catch (e) { console.warn('[抖音关注助手] 自动点击异常：', e); }
    ensureUI();
    console.log('[抖音关注助手] 已加载。右下角 🎯 按钮打开面板。');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 暴露内部能力，方便在控制台排查（无害，也可当作高级用法入口） */
  window.DYHelper = {
    version: '1.0.0',
    state: function () { return S; },
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
