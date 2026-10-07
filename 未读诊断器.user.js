// ==UserScript==
// @name         抖音未读诊断器（只诊断，不改你的助手）
// @namespace    dy-unread-doctor
// @version      2026-10-07 19:30
// @description  在手机浏览器里打开抖音「关注」页运行。对比三个来源：①抖音页面自己写的红点「N个作品未看」②官方接口 v2 ③本机视频库推算。直接告诉你差在哪一层。
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ★ 这个脚本【只做诊断】：读一堆数、列表格、报告差异。
   它不修改 localStorage、不改任何数据，所以可以放心反复跑。
   目的：一次性定位「助手数字和抖音 App 对不上」到底错在哪一层，
        避免再靠猜反复改。*/
(function () {
  if (window.__dyhDoctorInstalled) return;
  window.__dyhDoctorInstalled = 1;

  var LS_KEY = 'dy_phone_helper_v1';

  /* ---------- UI ---------- */
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;' +
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:auto;padding:12px;' +
    'padding-bottom:calc(40px + env(safe-area-inset-bottom))';
  var out = document.createElement('pre');
  out.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:13px';
  box.appendChild(out);
  var bar = document.createElement('div');
  bar.style.cssText = 'position:sticky;top:0;background:#222;padding:8px 0;margin-bottom:8px;z-index:2';
  var btnScan = mkBtn('① 滚动读取红点（抖音页面写的数）', '#2ba471');
  var btnApi = mkBtn('② 读官方接口 v2', '#fe2c55');
  var btnAll = mkBtn('▶ 全部跑一遍并对账', '#1677ff');
  bar.appendChild(btnScan); bar.appendChild(btnApi); bar.appendChild(btnAll);
  box.insertBefore(bar, out);
  document.body.appendChild(box);

  function mkBtn(t, c) {
    var b = document.createElement('button');
    b.textContent = t;
    b.style.cssText = 'display:block;width:100%;margin:4px 0;padding:14px;border:0;border-radius:10px;' +
      'background:' + c + ';color:#fff;font-size:15px;font-weight:600';
    b.onclick = function () { b.style.opacity = '.6'; setTimeout(function () { b.style.opacity = '1'; }, 400); };
    return b;
  }
  function say(s) { out.textContent += s + '\n'; out.scrollTop = out.scrollHeight; }
  function hr(t) { say('\n======== ' + t + ' ========'); }

  /* ---------- 工具 ---------- */
  function norm(s) { return String(s || '').replace(/认证徽章|直播中/g, '').replace(/\s+/g, ' ').trim(); }
  function loadS() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- ① 滚动读取抖音页面自己写的红点 ---------- */
  function findScroller() {
    /* 抖音关注页有多个可滚动容器（左侧关注列表 / 右侧推荐流 / 整个窗口）。
       ★ 2026-10-07 20:00 修正：原来只取「可滚距离最大」的那个，往往是右侧推荐流，
       于是左边的关注列表根本没滚到 → 只能读到屏幕里那60 个（实测 60/389 = 15%）。
       现在：优先选【含有「个作品未看」文本】的那个容器（那就是关注列表），找不到再退回最大可滚的。 */
    var all = document.querySelectorAll('div,ul,ol,section,main,aside');
    var best = null, bestScore = 0, withBadge = null, badgeScore = 0;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var cs;
      try { cs = getComputedStyle(e); } catch (x) { continue; }
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      var can = e.scrollHeight - e.clientHeight;
      if (can <= 20) continue;                       // 滚不动的不用
      /* 找「含未看文字」的容器 —— 关注列表所在 */
      var lis = e.querySelectorAll('li');
      if (lis.length) {
        var hit = 0;
        for (var j = 0; j < lis.length; j++) { if (/个作品未看/.test(lis[j].innerText || '')) hit++; }
        if (hit > 0 && lis.length > badgeScore) { badgeScore = lis.length; withBadge = e; }
      }
      if (can > bestScore) { bestScore = can; best = e; }
    }
    var pick = withBadge || best;
    if (withBadge) say('  （已定位到【关注列表】容器，含' + withBadge.querySelectorAll('li').length + ' 个 li）');
    else if (best) say('  ⚠ 没找到含「个作品未看」的容器，退回最大可滚容器 —— 建议先手动在页面上点一下关注列表');
    return pick;
  }

  function readBadgesOnce() {
    var map = {}, liTotal = 0, hitAny = false;
    var lis = [].slice.call(document.querySelectorAll('li'));
    for (var i = 0; i < lis.length; i++) {
      var txt = lis[i].innerText || '';
      if (!txt) continue;
      /* 形如「账号名」+「N个作品未看」；也识别「进橱窗」「M个群聊」= 非未看 */
      var m = txt.match(/(\d+)\s*个作品未看/);
      var name = (lis[i].querySelector('a[href*="/user/"]') || {}).innerText || '';
      name = norm(name);
      if (m) {
        hitAny = true;
        var n = parseInt(m[1], 10);
        var sec = '';
        var a = lis[i].querySelector('a[href*="/user/"]');
        if (a) { var mm = (a.getAttribute('href') || '').match(/\/user\/([^?\/?]+)/); if (mm) sec = mm[1]; }
        var key = sec || ('n:' + name);
        map[key] = n;
        if (name) map['n:' + name] = n;
      }
    }
    var sc = findScroller();
    if (sc) { lis = [].slice.call(sc.querySelectorAll('li')); liTotal = lis.length; }
    return { map: map, hitAny: hitAny, liTotal: liTotal, sc: sc };
  }

  async function scanBadges() {
    say('滚动读取抖音页面自己写的「N个作品未看」…');
    var agg = {}, maxLi = 0, rounds = 0, sc = findScroller();
    if (!sc) { say('⚠ 没找到可滚动容器（请确认已在抖音「关注」页，并先手动点一下左侧关注列表）'); return null; }
    var idle = 0, lastLi = 0;
    for (; rounds < 400; rounds++) {
      var r = readBadgesOnce();
      /* 累计「见过的li 总数」与「有未看的号数」，两者任一增长就认为还有新东西 */
      maxLi = Math.max(maxLi, r.liTotal);
      for (var k in r.map) if (!(k in agg) || r.map[k] > agg[k]) agg[k] = r.map[k];
      var accNow = 0, sumNow = 0;
      for (var k0 in agg) if (k0.indexOf('n:') === 0) { accNow++; sumNow += agg[k0]; }
      say('  轮' + rounds + '：列表 ' + r.liTotal + ' 个 · 累计有未看 ' + accNow + ' 个号 / ' + sumNow + ' 条');
      /* 懒加载判定：连续 3 轮「li数没变且已见号数没变」才停 */
      if (r.liTotal === lastLi && accNow === (scanBadges._acc || 0)) { idle++; } else { idle = 0; }
      scanBadges._acc = accNow;
      lastLi = r.liTotal;
      if (idle >= 3) break;
      try { sc.scrollTop = sc.scrollHeight; } catch (e) {}
      await sleep(800);
    }
    var accSet = {};
    for (var k2 in agg) if (k2.indexOf('n:') === 0) accSet[k2] = agg[k2];
    var cnt = 0, sum = 0;
    for (var k3 in accSet) { cnt++; sum += accSet[k3]; }
    var totalLi = lastLi || maxLi;
    say('  ★ 完成：滚动 ' + rounds + ' 轮 · 关注列表共 ' + totalLi + ' 个 · 有未看 ' + cnt + ' 个号 / 共 ' + sum + ' 条');
    if (totalLi < 200) say('  ⚠ 只滚到 ' + totalLi + ' 个（你的关注约 389 个）—— 说明列表没滚到底，红点数据不完整');
    return { map: agg, accounts: cnt, sum: sum, liTotal: totalLi, rounds: rounds };
  }

  /* ---------- ② 读官方接口 v2 ---------- */
  function bp() {
    try {
      var es = performance.getEntriesByType('resource');
      for (var i = es.length - 1; i >= 0; i--) {
        var n = es[i].name || ''; if (n.indexOf('/aweme/v1/') < 0) continue;
        var kv = (n.split('?')[1] || '').split('&'), o = {}, c = 0;
        for (var j = 0; j < kv.length; j++) {
          var p = kv[j].split('='); if (p.length < 2) continue;
          var k = decodeURIComponent(p[0]), v = decodeURIComponent(p[1] || '');
          if (k && k.length <= 30) { o[k] = v; c++; }
        }
        if (c >= 10) return o;
      }
    } catch (e) {}
    var ua = navigator.userAgent || '';
    var isM = /Android|iPhone|iPad|Mobile/i.test(ua);
    return { device_platform: 'webapp', aid: '6383', channel: isM ? 'channel_web' : 'channel_pc_web',
      cookie_enabled: 'true', screen_width: String(screen.width || 390), screen_height: String(screen.height || 844),
      browser_language: 'zh-CN', browser_platform: isM ? 'iOS' : 'Win32', browser_name: 'Chrome',
      browser_online: 'true', engine_name: 'Blink', os_name: isM ? 'iOS' : 'Windows', platform: isM ? 'iPhone' : 'PC',
      downlink: '10', effective_type: '4g', round_trip_time: '50', pc_client_type: '1',
      version_code: '190500', version_name: '19.5.0', browser_version: '120.0.0.0', engine_version: '120.0.0.0',
      os_version: '10', cpu_core_num: '8', device_memory: '8' };
  }
  function msT() {
    try { var c = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/); if (c) return c[1]; } catch (e) {}
    var ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 107; i++) s += ch.charAt(Math.floor(Math.random() * ch.length));
    return s;
  }
  async function readApi() {
    say('读取官方接口 v2（following/list）…');
    var m = document.documentElement.innerHTML.match(/MS4wLjAB[A-Za-z0-9_\-]{20,}/);
    if (!m) { say('  ✖ 没拿到自己的 sec_uid（可能未登录）'); return null; }
    var self = m[0], offset = 0, maxTime = 0, pages = 0, seen = {};
    var byName = {}, bySec = {}, total = 0;
    while (pages < 25) {
      var p = bp(); p.user_id = ''; p.sec_user_id = self;
      p.offset = String(offset); p.min_time = '0'; p.max_time = String(maxTime);
      p.count = '20'; p.source_type = '4'; p.gps_access = '0'; p.address_book_access = '0';
      p.is_top = '1'; p.msToken = msT();
      var qs = [];
      for (var k in p) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]));
      var url = 'https://www.douyin.com/aweme/v1/web/user/following/list/?' + qs.join('&');
      var ctrl = new AbortController();
      var tm = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 9000);
      var page = null, why = '';
      try {
        var r = await fetch(url, { credentials: 'include', headers: { 'accept': 'application/json, text/plain, */*', 'Referer': 'https://www.douyin.com/' }, signal: ctrl.signal });
        clearTimeout(tm);
        var t = await r.text();
        if (r.status === 200 && t) { try { page = JSON.parse(t); } catch (e) { why = 'JSON 解析失败: ' + t.slice(0, 120); } }
        else why = 'HTTP ' + r.status + ' · 响应前120字: ' + t.slice(0, 120);
      } catch (e) { clearTimeout(tm); why = '请求异常: ' + (e && e.message); }
      pages++;
      if (!page) {
        say('  ✖ 第' + pages + '页 → ' + (why || '未知原因'));
        if (pages === 1) {
          say('  【关键】第一页就失败 = 接口读不到。若上面是 HTTP 403/444 → 被风控；');
          say('  若返回 200 但 followings 为空 → 参数不对（当前页面没先跑过关注接口，baseParams 嗅探不到）。');
        }
        offset += 20; continue;
      }
      var list = page.followings || [];
      for (var i = 0; i < list.length; i++) {
        var u = list[i] || {}; var sec = u.sec_uid || u.secUid; if (!sec) continue;
        if (!seen[sec]) { seen[sec] = 1; total++; }
        var ids = Array.isArray(u.not_seen_item_id_list_v2) ? u.not_seen_item_id_list_v2 : null;
        var nm = norm(u.nickname);
        bySec[sec] = { n: ids ? ids.length : 0, hasIds: !!ids, nickname: u.nickname };
        if (nm) byName[nm] = { n: ids ? ids.length : 0, hasIds: !!ids, sec: sec };
      }
      offset += list.length;
      if (page.max_time) maxTime = page.max_time;
      if (!page.has_more || !list.length) break;
      await sleep(600);
    }
    var c = 0, sum = 0;
    for (var s2 in bySec) { if (bySec[s2].n > 0) { c++; sum += bySec[s2].n; } }
    say('  接口返回 ' + total + ' 个号 · 有未看 ' + c + ' 个号 / 共 ' + sum + ' 条');
    return { byName: byName, bySec: bySec, total: total, acc: c, sum: sum };
  }

  /* ---------- ③ 本机视频库推算（助手现在显示的口径） ---------- */
  function readLocal() {
    var S = loadS(), acc = {};
    for (var i = 0; i < (S.videos || []).length; i++) {
      var v = S.videos[i]; if (!v) continue;
      var key = 'n:' + norm(v.account || '');
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }

  /* ---------- 对账 ---------- */
  function reconcile(dom, api, loc) {
    hr('三方对账（红色 = 不一致）');
    var names = {};
    if (dom) for (var k in dom.map) if (k.indexOf('n:') === 0) names[k.slice(2)] = 1;
    if (api) for (var k2 in api.byName) names[k2] = 1;

    var rows = [], diffDomApi = 0, diffApiLoc = 0, both = 0;
    for (var nm in names) {
      var d = dom && dom.map['n:' + nm] != null ? dom.map['n:' + nm] : null;
      var a = api && api.byName[nm] ? api.byName[nm].n : null;
      var l = loc && loc['n:' + nm] != null ? loc['n:' + nm] : 0;
      if (d != null && a != null) {
        both++;
        if (d !== a) { diffDomApi++; rows.push({ n: nm, d: d, a: a, l: l, why: '红点≠接口' }); }
      }
      if (a != null && a !== l) { diffApiLoc++; }
    }
    rows.sort(function (x, y) { return Math.abs(y.d - y.a) - Math.abs(x.d - x.a); });
    say('红点与接口【都有】的账号数: ' + both + '，其中不一致: ' + diffDomApi);
    say('接口与本机推算不一致: ' + diffApiLoc);
    say('');
    if (rows.length) {
      say('账号'.padEnd(20) + '红点'.padStart(6) + '接口'.padStart(6) + '本机'.padStart(6) + '  问题');
      say('-'.repeat(52));
      rows.slice(0, 25).forEach(function (r) {
        say(r.n.padEnd(18) + String(r.d).padStart(6) + String(r.a).padStart(6) + String(r.l).padStart(6) + '  ❌' + r.why);
      });
    } else say('（红点与接口完全一致）');

    hr('结论');
    if (!dom) say('没读到红点：请确认已停在抖音「关注」页');
    else if (!api) say('接口没读到：可能被风控，请稍后重试');
    else if (diffDomApi === 0 && both > 50) say('✅ 红点与接口一致 → 源是对的。若仍与App 不同，是【抖音网页版与App口径差异】，不是助手bug');
    else say('❌ 红点与接口不一致 → 说明接口读到的不是网页版真实显示值，需要继续查');
  }

  /* ---------- 按钮 ---------- */
  var R = { dom: null, api: null, loc: null };
  btnScan.onclick = async function () { hr('① 红点（抖音页面显示）'); R.dom = await scanBadges(); reconcile(R.dom, R.api, R.loc); };
  btnApi.onclick = async function () { hr('② 官方接口 v2'); R.api = await readApi(); reconcile(R.dom, R.api, R.loc); };
  btnAll.onclick = async function () {
    hr('全部诊断开始（约需 1~3 分钟，取决于关注数量）');
    R.loc = readLocal();
    say('本机视频库: ' + Object.keys(R.loc).length + ' 个号有视频');
    R.dom = await scanBadges();
    R.api = await readApi();
    reconcile(R.dom, R.api, R.loc);
    hr('诊断结束');
    say('把这页文字复制发给我，我就能定位到具体是哪一层错了。');
  };

  say('抖音未读诊断器已就绪\n');
  say('用法：\n');
  say('  1) 确认已登录抖音，且【停留在抖音「关注」页】\n');
  say('  2) 点「▶ 全部跑一遍并对账」\n');
  say('  3) 跑完把这页文字全选复制发给我\n');
  say('\n本诊断【不改你的任何数据】，可放心运行。');
})();