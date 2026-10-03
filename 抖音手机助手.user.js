// ==UserScript==
// @name         抖音关注助手（手机免电脑版）
// @namespace    dy-phone-helper
// @version      2026-10-04 01:05 · 找到「读不全 / 和 App 对不上」的真正根因：滚动写成了【一次跳到列表最底部】sc.scrollTop = sc.scrollHeight，而抖音这个关注列表是【虚拟滚动】——DOM 里只保留看得见的那几行，滚出视口就被回收。一跳到底 = 中间几百个号从头到尾根本没被渲染过，永远读不到；而列表行数始终不变，代码还以为「已经到底了」提前收工。★ 仿真对照：30 个号，旧版只读到 16 个，新版 30/30 全读到。★ 修法：① 改成每次只往下滚【一屏】，逐屏渲染、逐屏读（追加渲染和虚拟滚动两种模式都成立）；② 进度判据从「当前 DOM 行数」改成【累计读到过的账号数】；③ 容器查找从 8 层放宽到 25 层；④ 到底后回顶再走一轮，别漏最上面的号；⑤ 轮数 80→160，等待 1100→800ms。★ 体检新增【零】环境诊断（UA 是手机还是电脑、页面里到底有没有「我的关注(N)」那个侧栏 —— 手机 UA 下抖音给的是移动版，压根没这个侧栏，那就什么都读不到）+【零之二】滚动有效性（找没找到可滚动容器、滚了之后位置到底动没动）。★ 接口扫描再升级：把响应里【列表第一个对象的全部字段】摊开列出来，未读数藏在哪个字段一眼就能认出来。
// @description  在手机浏览器的抖音网页版里直接：抓关注列表、抓最新未读视频、搜索并关注新账号、数据推 GitHub。全程不需要电脑。（取关功能已取消，请在抖音 App 里取关）
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/* ==========================================================================
   抖音关注助手 · 手机免电脑版
   --------------------------------------------------------------------------
   原理：本脚本运行在 www.douyin.com 页面里，和抖音「同源」。
     - fetch 自动带上你真实登录 cookie，无需签名、无 CORS、无风控拦截；
     - 关注用「同源 iframe 打开对方主页 → 点真实关注按钮」实现；（取关功能已取消，需取关请在抖音 App 里操作）
     - 数据存手机 localStorage，可一键推到 GitHub（手机端 HTML 直接看）。
   这也是为什么它能做到「完全不用电脑」：抖音只在乎是不是真人在真浏览器里操作，
   而这里每一步都是你自己手机上的真实浏览器行为。
   ========================================================================== */

(function () {
  'use strict';
  if (window.__DY_HELPER_LOADED__) return;
  window.__DY_HELPER_LOADED__ = true;

  /* ==========================================================================
     ★★★ 网络监听层（2026-10-03 02:20 新增）—— 这是「不再获取失败」的地基 ★★★
     --------------------------------------------------------------------------
     为什么需要它：电脑版 server/cdp.js 里的注释写得很明白 ——
       「2026-09 中旬起抖音上线 ArgusSecurityPlugin 风控：直发的签名请求缺 uifid，一律 403/444」
     翻译过来就是：我们【自己拼参数】去 fetch /aweme/v1/web/...，不管怎么调并发、怎么换 msToken、
     怎么降速，本质都是「脚本在冒充浏览器」，被 Argus 盯上只是时间问题 —— 这就是你看到的
     「不停提示获取失败」。而且电脑版自己现在也一样 403（server.log 里 10-02 02:13 之后全是 403），
     说明这条路已经走到头了，再怎么微调参数都救不回来。

     电脑版唯一稳定成功的那次是怎么做的？两条：
       ① 在【真实登录浏览器的 douyin.com 页面里】发请求（带真设备指纹）；
       ② 直接打开 /follow 页面，【读抖音自己渲染出来的 DOM】。
     这里做成更强的版本：
       ★ 我们【一个自签名请求都不发】，只「听」抖音自己的前端发了什么、收到了什么。
         抖音前端发的请求带完整签名 + uifid + 真设备指纹，服务端必然给它 200。
       ★ 我们只是把响应【抄一份】进 NET.buf，后面自己解析。不改任何请求 → 不可能被风控。
     ========================================================================== */
  /* wide = 接口扫描模式的截止时间戳（0 = 关）。平时完全不干活，不占资源。 */
  var NET = { buf: [], on: false, wide: 0, seen: {}, seenList: [] };
  function netKind(url) {
    if (!url) return '';
    if (url.indexOf('/aweme/v1/web/follow/') >= 0) return 'feed';
    if (url.indexOf('/aweme/v1/web/aweme/post/') >= 0) return 'post';
    if (url.indexOf('/aweme/v1/web/user/following/') >= 0) return 'following';
    if (url.indexOf('/aweme/v1/web/history/') >= 0) return 'history';
    return '';
  }
  function netPush(kind, url, text) {
    if (!kind || !text) return;
    var j = null;
    try { j = JSON.parse(text); } catch (e) { return; }
    if (!j) return;
    NET.buf.push({ kind: kind, url: url, json: j, ts: Date.now() });
    if (NET.buf.length > 150) NET.buf.splice(0, NET.buf.length - 150);   // 只留最近这些，别撑爆内存
  }
  /* 取走某类响应（取走即从缓存删除，避免同一份数据被重复消费） */
  function netTake(kind) {
    var out = [], keep = [], i;
    for (i = 0; i < NET.buf.length; i++) {
      if (NET.buf[i].kind === kind) out.push(NET.buf[i]); else keep.push(NET.buf[i]);
    }
    NET.buf = keep;
    return out;
  }
  function netCount(kind) {
    var n = 0;
    for (var i = 0; i < NET.buf.length; i++) if (NET.buf[i].kind === kind) n++;
    return n;
  }

  /* ===================================================================
     ★★ 「接口扫描」（2026-10-04 新增）—— 回答「除了页面上那个角标，
     还有没有别的办法拿到未读数」的唯一实证手段。
     以前我们只听 4 个已知地址，抖音只要换任何一个别的接口下发未读数，
     我们连记录都不会记录 —— 这就是「到底还有没有别的办法」一直没答案的原因。
     现在：扫描模式下，抖音自己发出的【每一个】/aweme/ 接口都记一笔，
     只留「地址 + 里面有没有未读类字段」，不留全文，占不了多少内存。
     =================================================================== */

  /* 把 URL 洗成看得懂的样子：去掉域名、去掉签名类噪音参数，只留路径 + 参数名 */
  var URL_NOISE_RE = /^(msToken|X-Bogus|_signature|a_bogus|verifyFp|s_v_web_id|fp|ts|device_id|_rticket|iid|cdid|cookie|ac|aid|app_name|version_code|version_name|channel|device_platform|os_api|os_version|d_devicebrand|uifid|webid|pc_client_type|pc_lib)$/i;
  function netCleanUrl(u) {
    var s = String(u || ''), q = '';
    try {
      var i = s.indexOf('?');
      if (i >= 0) {
        var keys = [], parts = s.slice(i + 1).split('&');
        for (var j = 0; j < parts.length; j++) {
          var kv = parts[j], eq = kv.indexOf('='), kk = eq >= 0 ? kv.slice(0, eq) : kv;
          if (!kk || URL_NOISE_RE.test(kk)) continue;
          keys.push(kk);
        }
        if (keys.length) q = '?' + keys.join('&');
        s = s.slice(0, i);
      }
      s = s.replace(/^https?:\/\/[^/]+/, '');
    } catch (e) { }
    return (s + q).slice(0, 150);
  }

  /* 找到响应里第一个「元素是对象的数组」（通常就是账号列表 / 视频列表） */
  function firstObjArray(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      for (var i = 0; i < node.length; i++) if (node[i] && typeof node[i] === 'object') return node;
      return null;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = firstObjArray(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  /* ★ 把列表里第一个对象的【所有字段】原样列出来（只留数字和短文本）。
     目的：抖音可能把未读数藏在名字完全猜不到的字段里（不叫 unread），
     只要把它摊开看一眼，是哪个字段一眼就认出来了。 */
  function netSampleFields(j) {
    var out = [];
    try {
      var arr = firstObjArray(j, 0);
      if (!arr) return out;
      var o = null, i;
      for (i = 0; i < arr.length && i < 3; i++) { if (arr[i] && typeof arr[i] === 'object') { o = arr[i]; break; } }
      if (!o) return out;
      var k;
      for (k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        var v = o[k];
        if (v == null) continue;
        if (typeof v === 'number') out.push(k + ' = ' + v);
        else if (typeof v === 'string' && v.length <= 24) out.push(k + ' = "' + v + '"');
        else if (typeof v === 'boolean') out.push(k + ' = ' + v);
      }
    } catch (e) { }
    return out.slice(0, 45);
  }

  /* 扫描期间：每见到一个新接口就记一条（同一地址只记一次，只累加次数） */
  function netWideRecord(url, text) {
    try {
      var clean = netCleanUrl(url);
      if (clean.indexOf('/aweme/') < 0) return;
      if (NET.seen[clean]) { NET.seen[clean].n++; return; }
      var rec = { url: clean, n: 1, fields: [], topKeys: '', raw: '' };
      NET.seen[clean] = rec;
      NET.seenList.push(rec);
      if (NET.seenList.length > 120) {
        var drop = NET.seenList.shift();
        if (drop) delete NET.seen[drop.url];
      }
      try {
        var j = JSON.parse(text);
        if (j && typeof j === 'object') {
          var ks = [], k;
          for (k in j) if (Object.prototype.hasOwnProperty.call(j, k)) ks.push(k);
          rec.topKeys = ks.slice(0, 24).join(', ');
          walkUnreadFields(j, '', rec.fields, 0);
          rec.fields = uniq(rec.fields).slice(0, 12);
          rec.sample = netSampleFields(j);
        }
      } catch (e) { rec.raw = '（不是 JSON）'; }
    } catch (e2) { }
  }

  function installNetHook() {
    if (NET.on) return;
    NET.on = true;
    var F = window.fetch;
    if (typeof F === 'function') {
      var patched = function () {
        var args = arguments, url = '';
        try { url = typeof args[0] === 'string' ? args[0] : ((args[0] && args[0].url) || ''); } catch (e) { }
        var k = netKind(url);
        var p = F.apply(this, args);
        if (!p || typeof p.then !== 'function') return p;
        /* 非已知接口：扫描期间也抄一份（只在 wide 开着的时候，平时一行都不多跑） */
        var maybeWide = !k && String(url).indexOf('/aweme/') >= 0;
        if (!k && !maybeWide) return p;
        return p.then(function (r) {
          /* ★ 只 clone 不消费：原响应原样交还给抖音，它完全感觉不到我们 */
          try {
            if (r && r.ok && typeof r.clone === 'function') {
              r.clone().text().then(function (t) {
                if (k) netPush(k, url, t);
                else if (NET.wide > Date.now()) netWideRecord(url, t);
              }).catch(function () { });
            }
          } catch (e) { }
          return r;
        }, function (e) { throw e; });
      };
      try { patched.toString = F.toString.bind(F); } catch (e) { }
      window.fetch = patched;
    }
    var X = window.XMLHttpRequest;
    if (typeof X === 'function' && X.prototype) {
      var op = X.prototype.open, se = X.prototype.send;
      if (typeof op === 'function') {
        X.prototype.open = function () {
          try { this.__dyUrl = String(arguments[1] || ''); } catch (e) { }
          return op.apply(this, arguments);
        };
      }
      if (typeof se === 'function') {
        X.prototype.send = function () {
          var self = this, k = netKind(this.__dyUrl);
          var maybeWide = !k && String(this.__dyUrl).indexOf('/aweme/') >= 0;
          if (k || maybeWide) {
            try {
              this.addEventListener('load', function () {
                try {
                  if (self.status === 200) {
                    if (k) netPush(k, self.__dyUrl, self.responseText);
                    else if (NET.wide > Date.now()) netWideRecord(self.__dyUrl, self.responseText);
                  }
                } catch (e) { }
              });
            } catch (e) { }
          }
          return se.apply(this, arguments);
        };
      }
    }
  }
  try { installNetHook(); } catch (e) { }

  /* ----------------------------- 常量 ----------------------------- */
  var API_POST = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
  var API_FOLLOWING = 'https://www.douyin.com/aweme/v1/web/user/following/list/';
  var LS = 'dy_phone_helper_v1';
  /* ★★ 版本号规则（2026-10-02 起，用户指定）★★
     不再用 v1.x 递增，改成「生成日期时间 + 这次改了什么」，
     改完必须同步改文件头的 @version，否则 Via 里跑的还是旧的那份。
     面板标题后面显示的是短版（MM-DD HH:MM），完整说明放在 title 和设置页里。 */
  var VER = '2026-10-04 01:05 · 找到「读不全 / 和 App 对不上」的真正根因：滚动写成了【一次跳到列表最底部】sc.scrollTop = sc.scrollHeight，而抖音这个关注列表是【虚拟滚动】——DOM 里只保留看得见的那几行，滚出视口就被回收。一跳到底 = 中间几百个号从头到尾根本没被渲染过，永远读不到；而列表行数始终不变，代码还以为「已经到底了」提前收工。★ 仿真对照：30 个号，旧版只读到 16 个，新版 30/30 全读到。★ 修法：① 改成每次只往下滚【一屏】，逐屏渲染、逐屏读（追加渲染和虚拟滚动两种模式都成立）；② 进度判据从「当前 DOM 行数」改成【累计读到过的账号数】；③ 容器查找从 8 层放宽到 25 层；④ 到底后回顶再走一轮，别漏最上面的号；⑤ 轮数 80→160，等待 1100→800ms。★ 体检新增【零】环境诊断（UA 是手机还是电脑、页面里到底有没有「我的关注(N)」那个侧栏 —— 手机 UA 下抖音给的是移动版，压根没这个侧栏，那就什么都读不到）+【零之二】滚动有效性（找没找到可滚动容器、滚了之后位置到底动没动）。★ 接口扫描再升级：把响应里【列表第一个对象的全部字段】摊开列出来，未读数藏在哪个字段一眼就能认出来。'
  var VER_SHORT = '10-04 01:05';

  /* ----------------------------- 存储 ----------------------------- */
  var S = loadState();
  function loadState() {
    var def = {
      /* openMode：点视频时用哪条路唤起抖音 App
           'scheme'（默认，只发一次带手势的 snssdk1128://，最不容易被弹框）
           'intent'（只发 intent://，写死抖音包名）
           'auto'  （先 scheme，1.2 秒没起来再补一次 intent —— 补的那下没手势，个别浏览器会弹框） */
      cfg: { owner: 'maidang0706', repo: 'douyin', branch: 'main', token: '', scanLimit: 0, scanConc: 6, scanBudget: 12, uiScale: 'xl', scanMode: 'auto', scanBatch: 60, openMode: 'scheme', harvest: true },
      selfSecUid: '',
      categories: ['朋友', '军事', '学习', '工作', '实时新闻', '钓鱼', '娱乐'],   // 用户自己建的分类，可增删改
      accounts: [],      // [{name, secUserId, category}]
      videos: [],        // [{awemeId, account, title, url, publishTime, publishedAt, thumbnail}]
      readIds: [],       // 已读视频 awemeId
      lastExport: 0,
      lastCatSync: 0,
      lastScanAt: 0,
      accCursor: {},     // {secUserId: 发布时间边界ms}：>边界的视频才算未读（由抖音「N个作品未看」反推，见 applyBadgeCursors）
      scanJob: null,     // 断点：{sig, startIdx, cursor, ts}，中断/被杀后下次从这里续
      __vseq: 0,         // 视频库版本号（S.videos 变动时 +1）：视频索引按它复用缓存，避免每次重扫全部视频
      __rseq: 0,         // 已看记录版本号（S.readIds 变动时 +1）：readMap 按它复用缓存
      listAt: 0,         // 关注列表最后刷新的时间：刷新后未读视图以这份列表为准（见 listIsFresh / pruneToAccounts）
      accUnreadN: {},    // {secUserId: {n, at, got, noBoundary}}：单独抓某个号时，按抖音口径算出的「N个作品未看」
      accBadge: {}       // {secUserId: {n, at}}：单独读到的【这个号的】官方角标（带独立时间戳，避免被几小时前的全局快照盖住）
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
      /* 2026-10-03 12:55：新增 per-account 未读边界（accCursor），老数据补一个空对象 */
      if (!o.accCursor) o.accCursor = {};
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
        S.accounts = out;
        /* ★ 2026-10-03 15:14：刷新关注列表之后，「未读视频查看」必须跟着这份列表走。
           取关掉的号，视频库里还留着它以前的视频 → 未读视图里会一直挂着它（显示成「新·」虚拟号），
           和 App 里「我的关注」对不上。现在刷到列表就把【不在列表里的号】的视频与未读边界清掉，
           并记下刷新时间：之后未读视图只认列表里的号（见 listIsFresh / ghostAuthors）。
           ⚠ 只有真的读到非空列表才清空 —— 万一这次请求异常返回空，不能把已有数据全抹掉。 */
        if (out.length) { pruneToAccounts(out); S.listAt = Date.now(); }
        save();
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
  /* ★ 每页多要点（10-03 01:25）：默认一页 40 条（原来是 20）。
     同样的翻页次数能覆盖两倍多的账号 → 需要逐个补抓的账号大幅变少 → 失败自然变少、也更快。
     抖音不认大 count 时会返回空，自动退回 20 再要一次（FEED_COUNT 记住这次教训，后面不再白试）。 */
  var FEED_COUNT = 40;
  function fetchFollowFeed(cursor, opt) {
    function go(n) {
      return dyGet(API_FOLLOW_FEED, commonParams({
        count: String(n), max_cursor: String(cursor || 0),
        refresh_index: '0', source_type: '0', feed_style: '0', is_top: '0', pull_type: '0'
      }), opt).then(function (j) {
        var list = (j && (j.aweme_list || [])) || [];
        if (!list.length && n > 20) { FEED_COUNT = 20; return go(20); }   // 不认 40：退回 20
        return {
          list: list.map(normAweme),
          hasMore: !!(j && j.has_more),
          nextCursor: (j && j.max_cursor) || 0
        };
      });
    }
    return go(FEED_COUNT);
  }

  /* ==========================================================================
     ★★★ 关注页收割引擎（2026-10-03 02:20）——「全部拿到、零失败」的主引擎 ★★★
     --------------------------------------------------------------------------
     灵感来自电脑版 cdp.js 的 readFollowUnread()：它唯一稳定成功的一次，是在
     【真实浏览器里打开 https://www.douyin.com/follow，然后读抖音自己渲染出来的页面】。
     原理很简单也很硬：抖音前端自己会去请求关注流，请求里带完整签名 + uifid + 真设备指纹，
     服务端必然给它 200 —— 它永远不可能被自己风控。
     我们要做的只有一件事：【在关注页里往下滚】，让抖音前端不停翻页，
     再把它的响应（已经被上面的 NET 抄下来了）拿走解析。
       ★ 全程 0 次自签名请求 → 0 次失败，也就不存在「获取失败」。

     另外顺手做一件更值钱的：关注页里每个账号旁边，抖音会写「N个作品未看」——
     那是【抖音服务器给的真实未读数】，和你在 App 里看到的完全一致。
     直接读它，比我们自己用「抓到的 − 已看记录 − 本机已读」去猜要准得多。
     ========================================================================== */
  function onFollowPage() { return /^\/follow(\/|\?|$)/.test(location.pathname || ''); }

  /* 把页面往下推一格：所有内部可滚动容器都推到底，窗口也推到底。
     抖音的关注流是「滚到底自动加载下一页」，推到底它就会自己去发下一页请求。 */
  function scrollDown() {
    var moved = false;
    try {
      var cands = document.querySelectorAll('div,ul,ol,section,main,aside');
      var n = Math.min(cands.length, 600);
      for (var i = 0; i < n; i++) {
        var el = cands[i];
        try {
          var cs = getComputedStyle(el);
          if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
          if (el.scrollHeight <= el.clientHeight + 30) continue;
          el.scrollTop = el.scrollHeight;
          moved = true;
        } catch (e) { }
      }
      var se = document.scrollingElement || document.documentElement;
      if (se) se.scrollTop = se.scrollHeight;
      window.scrollTo(0, document.body ? document.body.scrollHeight : 99999);
      moved = true;
    } catch (e) { }
    return moved;
  }

  /* 读关注页 DOM 里抖音写的「N个作品未看」—— 真实未读，和 App 完全一致
     ★★ 2026-10-03 11:35 重写：这一版以前有两个致命问题，直接导致「抓到的和 App 不一样」
        ⓐ 它是在【刚进 /follow 页】的时候只读一次的。电脑版 cdp.js 的经验写得很清楚：
           「左侧『我的关注』列表是懒加载的，必须滚动列表容器、轮询到数量稳定」。
           页面刚打开时侧栏还没渲染出来 → 读到的是空的/只有首屏十几个号 → 校准形同虚设，
           于是所有账号的未读都退回「本机明细」去猜（本机明细里混着一堆早看过的旧视频）。
        ⓑ 它要求每个 li 里必须有 a[href*="/user/"]，实际抖音关注页有两种 li：
           ① 左侧「我的关注」账号行（这才是「N个作品未看」的正主）；
           ② 右侧视频流卡片（同一条 li 里作者名 + 「N个作品未看」角标）。
           只认 ① 会把账号行漏掉，只认 ② 又会把同一作者的多条卡片互相覆盖（后一条盖掉前一条）。
     现在：两种 li 都认，【同一 secUid 取最大值】（最后一条卡片上的数不代表全未读）；
     并且把「我的关注(N)」总数 + 列表已加载账号数(liTotal) 一起带出来，后面好判断有没有读全。
     返回 { secMap, nameMap, map(=secMap 兼容旧调用), byName(=nameMap), total, liTotal, rows, unreadAcc } */
  function readFollowUnreadDom() {
    var secMap = {}, nameMap = {}, total = -1, liTotal = 0, rows = 0;
    /* ★ 16:28：还要记下【侧栏里出现过哪些号】。抖音对 0 未读的号**根本不写角标**，
       所以「在列表里但没角标」= 官方明确 0 条，「压根不在列表里」= 还没读到（-1）。
       这两种必须分得开，否则会把「官方 0 条」误当成「没读到」。 */
    var secSeen = {}, nameSeen = {};
    /* ★★ 23:55 真机截图发现的关键事实：**正在直播的号，网页端这一行【不写】「N个作品未看」**。
       截图里「记忆宫殿宁梓亦」名字带红色直播标、后面没有任何角标，而 App 里它是「5个作品未看」。
       所以「在侧栏里但没角标 = 官方 0 条」这条规则对【直播号】是错的 —— 它必须算「未知」，
       否则会把 App 里有未读的直播号报成「0 条未读」。 */
    var liveSeen = {};
    try {
      var t = document.body.innerText || '';
      var m = t.match(/我的关注\s*[（(]\s*(\d+)\s*[）)]/);
      if (m) total = parseInt(m[1], 10);
      var lis = document.querySelectorAll('li');
      var firstHit = null;
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        var tx = li.innerText || '';
        var mm = tx.match(/(\d+)\s*个作品未看/);
        var a0 = li.querySelector ? li.querySelector('a[href*="/user/"]') : null;
        var sec0 = '', name0 = '';
        if (a0) {
          var hm0 = (a0.getAttribute('href') || '').match(/\/user\/([^\/?#]+)/);
          if (hm0) sec0 = decodeURIComponent(hm0[1]).replace(/^@/, '');
          name0 = (a0.getAttribute('title') || a0.getAttribute('aria-label') || (a0.innerText || '')).trim();
        }
        if (sec0) secSeen[sec0] = 1;
        if (name0) nameSeen[normName(name0)] = 1;
        if (!mm) continue;                                 // 没有未读标记 → 这个号没有未看
        var num = parseInt(mm[1], 10);
        if (!num) continue;
        if (!firstHit) firstHit = li;
        rows++;
        var a = a0;
        var sec = sec0;
        /* 名字：账号行的 innerText 第一行就是昵称；卡片就先试 <a> 里的文本 */
        var name = name0;
        if (!name) {
          name = tx.replace(/认证徽章/g, '').replace(/\d+\s*个作品未看/g, '')
            .split('\n').filter(function (s) { return s.trim(); })[0] || '';
        }
        name = name.replace(/认证徽章/g, '').replace(/\s+/g, ' ').trim();
        if (name && name.length > 50) name = '';
        if (sec && (!secMap[sec] || num > secMap[sec])) secMap[sec] = num;
        if (name && (!nameMap[name] || num > nameMap[name])) nameMap[name] = num;
      }
      /* ★★ 18:00 追加（关键修复）：不要假设「账号行」一定是 <li>。
         抖音关注页的行标签会变（li / div / a 都可能），一旦对不上就**一个角标都读不到**，
         于是代码只能退化成「把这个号的全部视频当未读」——那个 16 其实是我们视频库里的条数，
         并不是抖音写的数（真机上「记忆宫殿宁梓亦」只有 5 个作品未看）。
         现在改成：以「作者主页链接」为锚点，向上找最多 6 层祖先里第一个含「N个作品未看」的那个。
         不管抖音用什么标签，都能读出官方角标。 */
      try {
        var as2 = document.querySelectorAll('a[href*="/user/"]');
        for (var ai = 0; ai < as2.length; ai++) {
          var a2 = as2[ai];
          var hm2 = (a2.getAttribute('href') || '').match(/\/user\/([^\/?#]+)/);
          if (!hm2) continue;
          var sec2 = decodeURIComponent(hm2[1]).replace(/^@/, '');
          var nm2 = (a2.getAttribute('title') || a2.getAttribute('aria-label') || a2.innerText || '')
            .replace(/认证徽章/g, '').replace(/\s+/g, ' ').trim();
          if (nm2 && nm2.length <= 50) nameSeen[normName(nm2)] = 1;
          /* ★ 23:55：这一行是不是「正在直播」的号？是的话它的「N个作品未看」可能压根不显示 */
          try {
            var elL = a2, isLive = false;
            for (var lv = 0; lv < 4 && elL; lv++) {
              if (/直播/.test(elL.innerText || '')) { isLive = true; break; }
              try {
                if (elL.querySelector && elL.querySelector('[class*="live"],[class*="Live"],[class*="LIVE"]')) { isLive = true; break; }
              } catch (e4) { }
              elL = elL.parentElement;
            }
            if (isLive) {
              if (sec2) liveSeen[sec2] = 1;
              if (nm2) liveSeen[normName(nm2)] = 1;
            }
          } catch (e5) { }
          if (sec2 && secSeen[sec2]) continue;              /* 已在上面那轮读到过 */
          var el2 = a2, got = null;
          for (var up = 0; up < 6 && el2; up++) {
            var tx2 = el2.innerText || '';
            if (tx2 && tx2.length < 500) {
              var mm2 = tx2.match(/(\d+)\s*个作品未看/);
              if (mm2) { got = { n: parseInt(mm2[1], 10), name: nm2 }; break; }
            }
            el2 = el2.parentElement;
          }
          if (got && got.n > 0) {
            if (sec2 && (!secMap[sec2] || got.n > secMap[sec2])) secMap[sec2] = got.n;
            if (got.name && (!nameMap[got.name] || got.n > nameMap[got.name])) nameMap[got.name] = got.n;
          }
        }
      } catch (e2) { }
      /* 列表已加载的账号总数（用正主那一行往上数）：进度就靠它，只读到十几个=没读全 */
      if (firstHit && firstHit.parentElement) liTotal = firstHit.parentElement.children.length || 0;
    } catch (e) { }
    return {
      secMap: secMap, nameMap: nameMap, map: secMap, byName: nameMap,
      secSeen: secSeen, nameSeen: nameSeen, liveSeen: liveSeen,
      total: total, liTotal: liTotal, rows: rows,
      unreadAcc: Object.keys(secMap).length
    };
  }

  /* 把关注页「我的关注」侧栏往上推一格：只推【账号列表自己的滚动容器】。
     ⚠ 不能直接滚 window —— 抖音关注页是左边账号列表(独立 overflow 容器) + 右边视频流，
     滚 window 只会翻视频流，账号列表一动不动，于是永远读不全真实未读（这就是根因之一）。 */
  /* 从一个元素往上找真正能滚的祖先（虚拟滚动的列表容器往往埋得很深，8 层根本不够） */
  function findScrollable(el, maxUp) {
    var k = 0;
    while (el && k < (maxUp || 25)) {
      try {
        var cs = getComputedStyle(el);
        if (cs && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) {
          if (el.scrollHeight > el.clientHeight + 50) return el;
        }
      } catch (e) { }
      el = el.parentElement; k++;
    }
    return null;
  }

  /* ★★★ 10-04 00:58 修（这是「读不全 / 读不到」的真正根因）★★★
     以前写的是 sc.scrollTop = sc.scrollHeight ——【一次跳到列表最底部】。
     抖音这个几百个号的列表是【虚拟滚动】：DOM 里只保留看得见的那几行，
     滚出视口的就被回收。一跳到底 = 中间几百个号从头到尾【根本没被渲染过】，
     于是永远读不到；而列表行数始终不变，代码还以为「已经到底了」提前收工
     —— 表现就是「只读到十几个号」「那个号一直对不上」。
     ★ 正解：每次只往下滚【一屏】，逐屏渲染、逐屏读。
       这在「追加渲染」和「虚拟滚动」两种模式下都成立。 */
  function scrollFollowSidebar() {
    var moved = false;
    try {
      var hit = null, lis = document.querySelectorAll('li'), i;
      for (i = 0; i < lis.length; i++) {
        if (/(\d+)\s*个作品未看/.test(lis[i].innerText || '')) { hit = lis[i]; break; }
      }
      if (!hit) {
        var as = document.querySelectorAll('a[href*="/user/"]');
        if (as && as.length) hit = as[0];
      }
      var sc = hit ? findScrollable(hit, 25) : null;
      if (sc) {
        var step = Math.max(Math.floor(sc.clientHeight * 0.85), 300);
        var before = sc.scrollTop;
        sc.scrollTop = before + step;                  // ★ 只滚一屏
        if (sc.scrollTop > before + 1) moved = true;
        else if (before > 0) sc.scrollTop = 0;         // 真到底了：回顶部，再走一轮（别漏顶上的号）
      }
      if (!moved) {
        var se = document.scrollingElement || document.documentElement;
        if (se) {
          var step2 = Math.max(Math.floor((se.clientHeight || 600) * 0.85), 300);
          var b2 = se.scrollTop;
          window.scrollBy(0, step2);
          if (se.scrollTop > b2 + 1) moved = true;
          else if (b2 > 0) window.scrollTo(0, 0);
        }
      }
    } catch (e) { }
    return moved;
  }

  /* ★★ 把抖音关注页左侧「我的关注」列表里的真实未读【读全】 ★★
     电脑版 cdp.js 里用的是同一招（readFollowUnread），它踩过的坑这里全都要避：
       - 进度指标必须用【列表里的账号总数 liTotal】，不能用「有未看标记的 li 数」
         （未看数为 0 的账号没有标记，用它计数会涨得极慢、提前退出 → 只读到首屏十几个号）；
       - 读到「我的关注(N)」总数的 85% 就认为读全；读不满也不能死等，连续几轮没增长就收手。
     全程 0 次自签名请求（纯滚动 + 读 DOM）。 */
  function harvestFollowSidebar(opts) {
    opts = opts || {};
    var best = { secMap: {}, nameMap: {}, total: -1, liTotal: 0, rows: 0 };
    /* ★ 10-04：虚拟滚动下 liTotal（当前 DOM 行数）恒定不变，用它判断「读完了」会提前收工。
       改用【累计读到过的账号数】—— 只有这个才真实反映进度。 */
    var seenAll = {}, lastN = -1, stable = 0, round = 0, maxRounds = opts.maxRounds || 120;
    function merge(du) {
      if (!du) return;
      var k;
      for (k in du.secMap) if (!best.secMap[k] || du.secMap[k] > best.secMap[k]) best.secMap[k] = du.secMap[k];
      for (k in du.nameMap) if (!best.nameMap[k] || du.nameMap[k] > best.nameMap[k]) best.nameMap[k] = du.nameMap[k];
      if (du.secSeen) for (k in du.secSeen) if (Object.prototype.hasOwnProperty.call(du.secSeen, k)) seenAll[k] = 1;
      if (du.total > best.total) best.total = du.total;
      if (du.liTotal > best.liTotal) best.liTotal = du.liTotal;
      if (du.rows > best.rows) best.rows = du.rows;
    }
    function tick() {
      if (opts.shouldStop && opts.shouldStop()) return Promise.resolve();
      if (round >= maxRounds) return Promise.resolve();
      round++;
      var du = readFollowUnreadDom();
      merge(du);
      if (opts.onTick) {
        try {
          var seenN2 = Object.keys(seenAll).length;
          opts.onTick({
            round: round, acc: Object.keys(best.secMap).length,
            liTotal: best.liTotal, total: best.total, seen: seenN2
          });
        } catch (e) { }
      }
      /* ★ 进度一律用【累计读到过的账号数 seenN】，不再用 liTotal（虚拟滚动下它不变） */
      var seenN = Object.keys(seenAll).length;
      if (best.total > 0 && seenN >= Math.ceil(best.total * 0.85)) return Promise.resolve();
      if (best.total < 0 && seenN === 0 && round >= 5) return Promise.resolve();
      if (seenN === lastN) { stable++; } else { stable = 0; }
      lastN = seenN;
      if (stable >= 6) return Promise.resolve();          // 连着 6 轮没多见到一个新号 = 到底了
      scrollFollowSidebar();
      return sleep(opts.wait || 1100).then(tick);
    }
    return tick().then(function () { return best; });
  }

  /* 关注页收割：滚 → 收 → 滚 …… 直到追平（翻到上次抓取之前的视频）或滚不动为止
     opts: { horizon, maxMs, uidMap, newest, shouldStop, onPage, stableMax }
     返回 { list, pages, covered, oldest, rounds, ms } —— list 就是新视频明细 */
  function harvestFollowPage(opts) {
    opts = opts || {};
    var horizon = opts.horizon || 0;
    var maxMs = opts.maxMs || 180000;
    var uidMap = opts.uidMap || {}, newest = opts.newest || {};
    var stableMax = opts.stableMax || 8;
    var got = [], covered = {}, oldest = Infinity, pages = 0, rounds = 0;
    var lastN = -1, stable = 0, t0 = Date.now();

    function drain() {
      var items = netTake('feed'), i, j;
      for (i = 0; i < items.length; i++) {
        pages++;
        var list = (items[i].json && items[i].json.aweme_list) || [];
        for (j = 0; j < list.length; j++) {
          var a = normAweme(list[j]);
          if (!a || !a.awemeId) continue;
          if (a.publishedAt && a.publishedAt < oldest) oldest = a.publishedAt;
          if (a.secUid) covered[a.secUid] = 1;
          /* 只收「比该账号已知最新一条还新」的，避免把翻到的旧视频又当成未读（以前越攒越多就是这个） */
          var base = newest[a.secUid] || 0;
          if (base && a.publishedAt && a.publishedAt <= base) continue;
          got.push(a);
          if (a.publishedAt && (!newest[a.secUid] || a.publishedAt > newest[a.secUid])) newest[a.secUid] = a.publishedAt;
        }
      }
      return items.length;
    }

    function step() {
      if (opts.shouldStop && opts.shouldStop()) return Promise.resolve();
      if (Date.now() - t0 > maxMs) return Promise.resolve();
      rounds++;
      scrollDown();
      return sleep(opts.wait || 1300).then(function () {
        drain();
        if (opts.onPage) {
          try {
            opts.onPage({
              rounds: rounds, pages: pages, got: got.length,
              oldest: oldest, covered: Object.keys(covered).length
            });
          } catch (e) { }
        }
        /* 追平判定：已经翻到「上次抓取时间」之前的视频 → 这段时间的新视频全部收齐了 */
        if (horizon && oldest <= horizon) return;
        if (got.length === lastN) stable++; else stable = 0;
        lastN = got.length;
        if (stable >= stableMax) return;         // 连滚好几轮都没新东西：确实到底了
        return step();
      });
    }
    return step().then(function () {
      return {
        list: got, pages: pages, covered: covered, oldest: oldest,
        rounds: rounds, ms: Date.now() - t0
      };
    });
  }

  /* ==========================================================================
     ★★★ 未读数字「体检」（2026-10-03 23:30 新增）★★★
     连着改了 5 版（16:05 / 16:28 / 17:25 / 18:05）都还是和 App 对不上，说明我们一直
     在【猜】抖音网页端到底写了什么、写在哪、叫什么名字。猜是猜不出来的。
     这一版先把【原始证据】抓出来：不加工、不推断 —— 抖音页面上写什么就原样抄什么，
     接口响应里有哪些字段也连路径一起列出来。拿到证据再改，别再猜。
     ========================================================================== */
  var UNREAD_KEY_RE = /unread|not_?see|unsee|new_?aweme|new_?count|new_?item|not_?watch|unwatch|watch_?status|item_?status|is_?new/i;

  /* 递归扫 JSON：把所有「看起来像未读数」的字段连路径一起列出来 */
  function walkUnreadFields(node, path, out, depth) {
    if (!node || depth > 8 || out.length > 80) return;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      for (var i = 0; i < node.length && i < 3; i++) walkUnreadFields(node[i], path + '[' + i + ']', out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k], p = path ? (path + '.' + k) : k;
      if (typeof v === 'number' && UNREAD_KEY_RE.test(k)) { out.push(p + ' = ' + v); continue; }
      if (v && typeof v === 'object') walkUnreadFields(v, p, out, depth + 1);
    }
  }

  /* 已捕获的网络响应里到底有没有「未读数」这个字段？顶层 key + 候选字段全列出来 */
  function netProbe() {
    var out = {
      kinds: {}, topKeys: {}, fields: [], urls: [],
      wide: { left: 0, list: [] }
    };
    try {
      out.wide.left = NET.wide > Date.now() ? Math.ceil((NET.wide - Date.now()) / 1000) : 0;
      for (var m = 0; m < NET.seenList.length; m++) {
        var rc = NET.seenList[m];
        out.wide.list.push({ url: rc.url, n: rc.n, fields: rc.fields, topKeys: rc.topKeys, raw: rc.raw, sample: rc.sample });
      }
      for (var i = 0; i < NET.buf.length; i++) {
        var it = NET.buf[i];
        out.kinds[it.kind] = (out.kinds[it.kind] || 0) + 1;
        var u = String(it.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 120);
        if (out.urls.length < 8) out.urls.push(it.kind + ' | ' + u);
        var j = it.json || {}, ks = [], k;
        for (k in j) if (Object.prototype.hasOwnProperty.call(j, k)) ks.push(k);
        if (!out.topKeys[it.kind]) out.topKeys[it.kind] = ks.slice(0, 30).join(', ');
        walkUnreadFields(j, '', out.fields, 0);
      }
      out.fields = uniq(out.fields).slice(0, 40);
    } catch (e) { }
    return out;
  }

  /* 把「抖音网页端现在到底显示着什么」原样抄下来（不加工、不推断） */
  function sideProbe(sec, name) {
    var r = { at: Date.now() };
    try {
      r.url = location.href;
      r.path = location.pathname || '';
      r.onFollow = onFollowPage();
      var body = document.body ? (document.body.innerText || '') : '';
      r.bodyLen = body.length;
      r.hitsOfWenkan = (body.match(/\d+\s*个作品未看/g) || []).length;
      r.hasOtherWord = (body.match(/\d+\s*(个)?(新作品|条新视频|个未看|条未看|个视频未看)/g) || []).slice(0, 10);
      var frags = body.split('\n'), i;
      r.frags = [];
      for (i = 0; i < frags.length && r.frags.length < 20; i++) {
        var t = (frags[i] || '').trim();
        if (t && /未看|新作品|未观看/.test(t)) r.frags.push(t.slice(0, 70));
      }
      var as = document.querySelectorAll('a[href*="/user/"]');
      r.userLinks = as.length;
      r.rows = [];
      for (i = 0; i < as.length && r.rows.length < 12; i++) {
        var a = as[i], el = a, txt = '';
        for (var up = 0; up < 5 && el; up++) {
          var tt = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (tt && tt.length > txt.length && tt.length < 200) txt = tt;
          el = el.parentElement;
        }
        if (txt) r.rows.push(txt.slice(0, 90));
      }
      var m = body.match(/我的关注\s*[（(]\s*(\d+)\s*[）)]/);
      r.myFollow = m ? parseInt(m[1], 10) : -1;

      /* ★ 10-04：环境 + 滚动有效性诊断。
         回答两个问题：① 你现在打开的到底是不是【有左侧栏的桌面版】？（手机 UA 下抖音给的是移动版，压根没这个侧栏）
         ② 滚动到底有没有把新的账号加载出来？（没变化 = 滚动没生效，那当然读不全） */
      try {
        var ua = navigator.userAgent || '';
        r.ua = ua.slice(0, 120);
        r.isMobileUa = /Android|iPhone|iPad|Mobile/i.test(ua);
        r.isDesktopUa = /Windows NT|Macintosh|X11|Linux/i.test(ua) && !r.isMobileUa;
        r.sidebarFound = /我的关注\s*[（(]\s*\d+/.test(body);
      } catch (e) { }
      try {
        var anchor = null;
        var als = document.querySelectorAll('a[href*="/user/"]');
        if (als && als.length) anchor = als[0];
        var scc = anchor ? findScrollable(anchor, 25) : null;
        if (scc) {
          r.scrollBox = { top: Math.round(scc.scrollTop), h: Math.round(scc.scrollHeight), view: Math.round(scc.clientHeight) };
          r.scrollMoved = scrollFollowSidebar();
          var after = null;
          try { after = Math.round(scc.scrollTop); } catch (e2) { }
          r.scrollAfter = after;
          r.scrollWorked = (after != null && r.scrollBox && after > r.scrollBox.top + 1);
          r.linksBefore = als ? als.length : 0;
        } else {
          r.scrollBox = null;
          r.scrollMoved = scrollFollowSidebar();
        }
      } catch (e3) { }

      var du = readFollowUnreadDom();
      r.badgeAcc = Object.keys(du.secMap || {}).length;
      r.seenAcc = Object.keys(du.secSeen || {}).length;
      r.liTotal = du.liTotal;
      if (sec) {
        r.sec = String(sec).slice(0, 24) + '…';
        r.secBadge = (du.secMap && du.secMap[sec] != null) ? du.secMap[sec] : -1;
        r.secSeen = !!(du.secSeen && du.secSeen[sec]);
        r.secLive = !!(du.liveSeen && du.liveSeen[sec]);
        /* ★ 把该号那一行的【原始 HTML】抄下来（截断到 1200 字）——
           一眼就能看出网页端把角标和「直播中」标记到底写在哪、写成什么样，不用再猜。 */
        try {
          var as3 = document.querySelectorAll('a[href*="/user/"]');
          for (var q = 0; q < as3.length; q++) {
            var hq = (as3[q].getAttribute('href') || '').match(/\/user\/([^\/?#]+)/);
            if (!hq) continue;
            if (decodeURIComponent(hq[1]).replace(/^@/, '') !== sec) continue;
            var row = as3[q];
            for (var u2 = 0; u2 < 3 && row.parentElement; u2++) row = row.parentElement;
            r.rowText = String(row.innerText || '').replace(/\s+/g, ' ').slice(0, 220);
            r.rowHtml = String(row.outerHTML || '').replace(/\s+/g, ' ').slice(0, 1200);
            break;
          }
        } catch (e6) { }
      }
      if (name) {
        var nn = normName(name);
        r.name = name;
        r.nameBadge = (du.nameMap && du.nameMap[name] != null) ? du.nameMap[name]
          : ((du.nameMap && du.nameMap[nn] != null) ? du.nameMap[nn] : -1);
        r.nameSeen = !!(du.nameSeen && du.nameSeen[nn]);
      }
      r.domUnreadAge = (S.domUnread && S.domUnread.ts) ? Math.round((Date.now() - S.domUnread.ts) / 60000) : null;
      r.domUnreadAcc = (S.domUnread && S.domUnread.map) ? Object.keys(S.domUnread.map).length : 0;
      r.net = netProbe();
    } catch (e) { r.err = String((e && e.message) || e); }
    return r;
  }

  /* 体检结果 → 一段可以直接发给我的纯文本 */
  function probeText(r) {
    var L = [];
    L.push('== 抖音未读数字体检 ' + fmtTime(r.at) + ' ==');
    L.push('当前页面: ' + r.path + (r.onFollow ? '  (是关注页)' : '  (★不是关注页！角标只在这里读得到)'));
    L.push('脚本版本: ' + VER_SHORT);
    L.push('');
    L.push('【零】环境：你现在打开的到底是什么页面');
    L.push('  网址: ' + r.url);
    L.push('  UA 是手机还是电脑: ' + (r.isDesktopUa ? '电脑' : (r.isMobileUa ? '★手机★' : '未知')));
    L.push('  ★ 页面里有「我的关注(N)」那个侧栏吗: ' + (r.sidebarFound ? '有 ✅' : '★没有★'));
    if (!r.sidebarFound) {
      L.push('  ⚠️ 这就解释了一切：你现在打开的页面【根本没有左侧那个账号列表】。');
      L.push('     手机 UA 下抖音给的是【移动版网页】，它没有这个侧栏，所以什么角标都读不到。');
      L.push('     办法：在浏览器设置里打开「桌面版网站 / 请求桌面站点」，再打开 www.douyin.com/follow 。');
    }
    L.push('  UA 原文: ' + (r.ua || ''));
    L.push('');
    L.push('【零之二】滚动到底有没有把新账号加载出来（读不全的真正原因都在这）');
    if (r.scrollBox) {
      L.push('  找到列表容器: 是（当前位置 ' + r.scrollBox.top + ' / 总高 ' + r.scrollBox.h + ' / 一屏 ' + r.scrollBox.view + '）');
      L.push('  ★ 总高 ' + r.scrollBox.h + ' 远大于一屏 ' + r.scrollBox.view + ' → 这是个可滚动的长列表 ✅');
    } else {
      L.push('  ★ 没找到可滚动的列表容器（只滚了页面本身）→ 侧栏可能根本没加载出来');
    }
    L.push('  ★ 刚才滚了一下，位置是否真的动了: ' + (r.scrollWorked ? '动了 ✅' : '★没动★ ← 滚不动就读不到后面的号'));
    L.push('  ★ 更准的验证：点「📡 读全部账号的官方未读数」，看进度里「已扫过 N 个号」会不会一直往上涨。');
    L.push('     会涨 = 滚起来了；一直停在同一个数 = 没滚起来（把数字告诉我）。');
    L.push('');
    L.push('【一】网页上有没有「N个作品未看」这几个字');
    L.push('  页面全文里出现了 ' + (r.hitsOfWenkan || 0) + ' 次「N个作品未看」');
    L.push('  其他类似说法: ' + ((r.hasOtherWord && r.hasOtherWord.length) ? r.hasOtherWord.join(' / ') : '（没有）'));
    L.push('  ★ 如果上面是 0 次 → 抖音【网页版根本不显示这个角标】（那是 App 独有的），网页端无从读取，这才是和 App 对不上的根因。');
    L.push('');
    L.push('【二】页面原文里含「未看/新作品」的行（原样抄，最多 20 行）');
    if (r.frags && r.frags.length) { for (var i = 0; i < r.frags.length; i++) L.push('  · ' + r.frags[i]); }
    else L.push('  （一行都没有）');
    L.push('');
    L.push('【三】账号行原文（前 12 行，原样抄）');
    if (r.rows && r.rows.length) { for (var j = 0; j < r.rows.length; j++) L.push('  · ' + r.rows[j]); }
    else L.push('  （页面上没找到任何 /user/ 链接）');
    L.push('');
    L.push('【四】这次读到的情况');
    L.push('  页面里 /user/ 链接数: ' + r.userLinks + '  「我的关注」总数: ' + r.myFollow);
    L.push('  本轮读到角标的号: ' + r.badgeAcc + ' 个；侧栏里出现过的号: ' + r.seenAcc + ' 个；列表行数: ' + r.liTotal);
    L.push('  之前存的全局快照: ' + r.domUnreadAcc + ' 个号' + (r.domUnreadAge != null ? '（' + r.domUnreadAge + ' 分钟前）' : '（无）'));
    if (r.sec) {
      L.push('  ---');
      L.push('  这个号: ' + (r.name || r.sec));
      L.push('  按 secUid 读到角标: ' + r.secBadge + '（在侧栏里出现过: ' + (r.secSeen ? '是' : '否') + '）');
      L.push('  按昵称读到角标: ' + r.nameBadge + '（在侧栏里出现过: ' + (r.nameSeen ? '是' : '否') + '）');
      L.push('  ★ 是否直播中（直播号网页端不写角标）: ' + (r.secLive ? '是 ← 网页端读不到它，属正常' : '否'));
      L.push('  ★ -1 = 没读到。若「出现过=是」+「非直播」而角标=-1 → 抖音给它标的就是 0 条。');
      if (r.rowText) {
        L.push('');
        L.push('【四之二】这个号那一行的原文（网页上真实长这样）');
        L.push('  文本: ' + r.rowText);
      }
      if (r.rowHtml) {
        L.push('  HTML: ' + r.rowHtml);
      }
    }
    L.push('');
    L.push('【五】抖音自己发的接口响应里有没有未读字段');
    var np = r.net || {};
    var ks = [], k;
    for (k in np.kinds) if (Object.prototype.hasOwnProperty.call(np.kinds, k)) ks.push(k + '×' + np.kinds[k]);
    L.push('  已捕获响应: ' + (ks.length ? ks.join(', ') : '（还没捕获到 —— 先去关注页滚一滚再体检）'));
    for (k in np.topKeys) if (Object.prototype.hasOwnProperty.call(np.topKeys, k)) {
      L.push('  ' + k + ' 响应顶层字段: ' + np.topKeys[k]);
    }
    L.push('  候选未读字段: ' + ((np.fields && np.fields.length) ? '' : '（一个都没有）'));
    if (np.fields && np.fields.length) for (var f = 0; f < np.fields.length; f++) L.push('    · ' + np.fields[f]);
    if (np.urls && np.urls.length) { L.push('  最近请求:'); for (var u = 0; u < np.urls.length; u++) L.push('    - ' + np.urls[u]); }
    L.push('');
    L.push('【六】★ 接口全扫描：抖音这段时间到底发了哪些接口（去重）');
    var w = (np.wide) || {};
    L.push('  扫描状态: ' + (w.left > 0 ? ('进行中，还剩 ' + w.left + ' 秒') : '未开始/已结束（点「🌐 扫描接口」开一次）'));
    var lst = w.list || [];
    L.push('  已看到 ' + lst.length + ' 个不同的 /aweme/ 接口');
    if (!lst.length) {
      L.push('  （还没有 —— 点「🌐 扫描接口」，然后去关注页上下滚 30 秒，再回来看）');
    } else {
      var hitN = 0, q;
      for (q = 0; q < lst.length; q++) if (lst[q].fields && lst[q].fields.length) hitN++;
      L.push('  ★ 其中【带未读类字段】的接口: ' + hitN + ' 个' +
        (hitN ? ' ← 【这就是第二个数据源】，可以不再依赖页面上的角标' : ' ← 抖音给网页端的接口里没带未读数，那网页端只能靠角标'));
      L.push('');
      for (q = 0; q < lst.length; q++) {
        L.push('  · ' + lst[q].url + '  (请求 ' + lst[q].n + ' 次)');
        if (lst[q].raw) L.push('      ' + lst[q].raw);
        if (lst[q].fields && lst[q].fields.length) {
          for (var z = 0; z < lst[q].fields.length; z++) L.push('      ⭐ ' + lst[q].fields[z]);
        }
        if (lst[q].topKeys) L.push('      顶层: ' + lst[q].topKeys);
        if (lst[q].sample && lst[q].sample.length) {
          L.push('      --- 列表里第一个对象的全部字段（★ 找未读数就看这里，看哪个数字对得上）---');
          for (var s2 = 0; s2 < lst[q].sample.length; s2++) L.push('        ' + lst[q].sample[s2]);
        }
      }
    }
    L.push('');
    L.push('（把上面这段整段复制发给我，我就能定位到底差在哪，不用再猜）');
    return L.join('\n');
  }

  /* ★ 开一次「接口全扫描」：这段时间里抖音发出的每一个 /aweme/ 接口都记下来。
     目的只有一个 —— 查清除了页面上那个角标，抖音还有没有【别的地方】也下发未读数。 */
  var NETSCAN_MS = 60000;
  function startNetScan() {
    NET.seen = {}; NET.seenList = [];
    NET.wide = Date.now() + NETSCAN_MS;
    toast('已开启扫描（60 秒）—— 现在去抖音「关注」页上下滚几屏，也可以点开一两个号，让抖音多请求几次', 6000);
    setTimeout(function () {
      NET.wide = 0;
      var hit = 0, i;
      try {
        for (i = 0; i < NET.seenList.length; i++) if (NET.seenList[i].fields && NET.seenList[i].fields.length) hit++;
      } catch (e) { }
      toast('扫描结束：共看到 ' + NET.seenList.length + ' 个接口，其中 ' + hit + ' 个带未读类字段', 6000);
      try { open('probe'); } catch (e2) { }
    }, NETSCAN_MS + 1200);
  }

  function renderProbe(r) {
    var txt = probeText(r);
    var ok = (r.hitsOfWenkan || 0) > 0;
    var h = '<div class="dyh-back" data-act="accv">← 返回</div>';
    h += '<div class="dyh-card"><div class="dyh-row"><b>体检结论</b><span class="dyh-hl">' +
      (ok ? '网页上能读到「N个作品未看」（' + r.hitsOfWenkan + ' 处）' : '⚠️ 网页上【没有】「N个作品未看」') +
      '</span></div>';
    if (!ok) {
      h += '<div class="dyh-tip" style="color:#f53f3f;margin:8px 0 0">' +
        '<b>这很可能就是和 App 对不上的根因。</b>抖音网页版的关注页可能<b>根本不写</b>「N个作品未看」这个角标' +
        '（那是 App 独有的显示），那我们在网页里就<b>永远读不到这个数</b> —— 不管怎么改解析都读不到。' +
        '<br>请确认一件事：在手机浏览器里打开抖音关注页，看看账号列表里到底有没有「X个作品未看」这几个字。' +
        '<br>如果确实没有 → 网页端这条路走不通，需要换数据源（我会按下面的接口字段另想办法）。</div>';
    }
    h += '<div class="dyh-row"><b>读到角标的号</b><span>' + r.badgeAcc + ' 个 / 侧栏出现 ' + r.seenAcc + ' 个</span></div>';
    h += '<div class="dyh-row"><b>接口里的未读字段</b><span>' +
      (((r.net && r.net.fields) ? r.net.fields.length : 0) + ' 个候选') + '</span></div></div>';
    h += '<textarea id="dyh-probe-t" readonly style="width:100%;height:340px;font-size:16px;' +
      'background:#fff8d0;color:#3d2f00;border:1px solid #e5cd7d;border-radius:10px;padding:10px">' + esc(txt) + '<\/textarea>';
    h += '<button class="dyh-btn primary" data-act="probe-copy">📋 复制体检结果（发给我）</button>';
    h += '<button class="dyh-btn" data-act="acc-probe" data-sec="' + esc(r._sec || '') + '" data-name="' + esc(r._name || '') + '">🔄 再体检一次</button>';
    h += (NET.wide > Date.now())
      ? '<div class="dyh-tip" style="color:#c8920a">🌐 接口扫描进行中…去抖音关注页上下滚几屏，60 秒后自动出结果。</div>'
      : '<button class="dyh-btn" data-act="net-scan">🌐 扫描接口：抖音还有哪些接口带着未读数</button>';
    h += '<div class="dyh-tip">🌐 扫描接口 = 开启 60 秒，把抖音给自己前端发的<b>每一个</b>接口都记下来，看有没有第二个地方也带着未读数（这个能回答「除了角标还有没有别的办法」）。</div>';
    h += '<div class="dyh-tip">先去抖音「关注」页往下滚几屏，让侧栏加载出一些账号，再体检 —— 信息会全很多。</div>';
    setBody(h);
  }

  function copyProbeText() {
    var ta = document.getElementById('dyh-probe-t');
    if (!ta) { toast('没有可复制的内容'); return; }
    var t = ta.value || '';
    var done = false;
    try { ta.removeAttribute('readonly'); ta.select(); ta.setSelectionRange(0, t.length); done = document.execCommand('copy'); ta.setAttribute('readonly', 'readonly'); } catch (e) { }
    if (!done && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast('已复制，粘贴发给我即可'); },
        function () { toast('复制失败，请长按上面的文本框手动全选复制'); });
      return;
    }
    toast(done ? '已复制，粘贴发给我即可' : '复制失败，请长按上面的文本框手动全选复制');
  }

  /* 【同步】读一次这个号旁边的官方角标：>=0 读到了（0 = 抖音标的就是 0 条），-1 = 这一帧没读到。
     注意「在侧栏里但没角标」和「压根不在侧栏里」要分开：前者是官方 0 条，后者是没读到。 */
  function readBadgeOnce(acc) {
    var badge = -1, inSidebar = false, liveNoBadge = false;
    try {
      var side = readFollowUnreadDom();
      if (side.secMap && side.secMap[acc.secUserId] != null) badge = side.secMap[acc.secUserId];
      else if (side.nameMap && acc.name) {
        if (side.nameMap[acc.name] != null) badge = side.nameMap[acc.name];
        else if (side.nameMap[normName(acc.name)] != null) badge = side.nameMap[normName(acc.name)];
      }
      if (badge < 0 && side.secSeen && side.secSeen[acc.secUserId]) inSidebar = true;
      else if (badge < 0 && side.nameSeen && acc.name && side.nameSeen[normName(acc.name)]) inSidebar = true;
      /* ★ 23:55：这行是不是「正在直播」的号？直播号网页端不写角标 → 没角标【不能】当 0 */
      var isLive = false;
      if (side.liveSeen) {
        if (acc.secUserId && side.liveSeen[acc.secUserId]) isLive = true;
        else if (acc.name && side.liveSeen[normName(acc.name)]) isLive = true;
      }
      if (badge < 0 && inSidebar && !isLive) badge = 0;   // 在侧栏里、非直播、又没角标 = 抖音标的就是 0
      if (isLive) liveNoBadge = true;                     // 直播中：网页端读不到它，只能算「未知」
    } catch (e) { }
    if (acc) acc._liveNoBadge = liveNoBadge;
    return badge;
  }

  /* 把读到的官方角标落盘（单号独立记录 + 给页面显示的数字） */
  function applyBadge(acc, badge) {
    if (!acc || !acc.secUserId || badge == null || badge < 0) return false;
    var cur = S.accBadge[acc.secUserId];
    if (cur && cur.n === badge && Date.now() - cur.at < 20000) return false;
    S.accBadge[acc.secUserId] = { n: badge, at: Date.now() };
    return true;
  }

  /* ★ 23:30 修：读官方角标必须【真等】。
     以前是同步 for 循环 —— 滚一下立刻再读 DOM，网络还没回来就读，等于同一帧读了十遍，
     这个号没露出来就永远读不到（这就是「一直读到同一个数 / 一直读不到」的原因）。
     现在每滚一次真等 900ms，最多滚 rounds 次。 */
  function readBadgeWait(acc, rounds, waitMs) {
    rounds = rounds || 20; waitMs = waitMs || 900;
    var round = 0;
    return new Promise(function (res) {
      (function tick() {
        var badge = readBadgeOnce(acc);
        if (badge >= 0) return res(badge);
        if (round >= rounds) return res(-1);
        round++;
        try { scrollFollowSidebar(); } catch (e) { }
        setTimeout(tick, waitMs);
      })();
    });
  }

  /* ★★ 23:55 新增：一次性把左侧「我的关注」列表滚到底，把抖音写的未读数【全部】读下来落盘。
     为什么要批量：388 个关注里，单号去读往往要滚很多次才轮到它；批量滚一遍，
     所有有未读的号一次全拿到（而且这个数就是网页端写出来的、与 App 同源）。
     ⚠ 直播中的号网页端不写角标（真机截图已证实），这类号读不到 —— 会如实算「未知」，不会报成 0。 */
  /* ★ 10-04：改成逐屏滚动后，一轮 = 一屏，轮数要够（几百个号 / 每屏十来个）；
     等待可以短一些（滚一屏后渲染很快，不再是等一整页网络）。 */
  var SIDE_HARVEST_WAIT = 800;
  function readAllBadges() {
    if (!onFollowPage()) {
      S.pendingAllBadge = { at: Date.now() };
      save();
      toast('官方未读数只能在抖音「关注」页读到，正在带你去…');
      setTimeout(function () { try { location.href = '/follow'; } catch (e) { location.reload(); } }, 600);
      return Promise.resolve(-1);
    }
    setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
      '<div class="dyh-prog" id="dyh-prog">📡 正在把左侧「我的关注」列表滚到底…<br>' +
      '<span style="font-size:19px">把抖音写的「N个作品未看」全部读下来</span></div>');
    return harvestFollowSidebar({
      maxRounds: 160, wait: SIDE_HARVEST_WAIT,
      onTick: function (p) {
        var el = document.getElementById('dyh-prog');
        if (el) el.innerHTML = '📡 正在逐屏读抖音写的未读数…<br><span style="font-size:19px">' +
          '已扫过 <b>' + (p.seen || 0) + '</b> 个号 · 其中 <b>' + p.acc + '</b> 个有未看' +
          (p.total > 0 ? ' · 关注共 <b>' + p.total + '</b> 个' : '') + '</span>' +
          '<br><span style="font-size:17px;color:#7A6A3F">第 ' + p.round + ' 屏（让它自己滚，别手动划）</span>';
      }
    }).then(function (best) {
      var n = Object.keys(best.secMap || {}).length, k;
      /* 落盘成全局侧栏快照（有效期 = SNAP_VALID_MS，过期一律不参与计算） */
      S.domUnread = {
        ts: Date.now(), map: best.secMap || {}, byName: best.nameMap || {},
        rows: best.rows || 0, liTotal: best.liTotal || 0, total: best.total || -1, all: 1
      };
      /* 同时给每个读到的号写【独立角标】（各自带时间戳），单号页面优先用它 */
      for (k in best.secMap) {
        if (Object.prototype.hasOwnProperty.call(best.secMap, k)) S.accBadge[k] = { n: best.secMap[k], at: Date.now() };
      }
      save();
      open('manage');
      toast('读到 ' + n + ' 个号有未看' +
        (best.total > 0 ? '（关注共 ' + best.total + ' 个 / 列表加载 ' + best.liTotal + ' 行）' : ''));
      return n;
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
  /* ★ 17:00：全局侧栏快照的有效期从 6 小时压到 30 分钟。
     未读数字是「你看过几条就掉几条」的活数据 —— 6 小时前的数字必然是过期的，
     而过期数字比没有数字更糟（用户看到的是"我明明看过却还显示 16"）。
     宁可显示"需要重读"，也不显示一个几小时前的旧数。 */
  var SNAP_VALID_MS = 30 * 60000;
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
    /* ★ 不在「关注」页 → 先带你过去（10-03 02:20）。
       为什么要多这一步：抖音现在（Argus 风控）几乎不放行我们自己拼的请求，
       但在【它自己的关注页】里，请求是它前端发的 —— 带完整签名和真设备指纹，永远 200。
       所以「先去关注页」不是绕路，是唯一一条不会失败的通道。到了那边会自动接着抓。 */
    if (S.cfg.harvest !== false && !onFollowPage()) {
      S.autoScan = { ts: Date.now(), limit: limitOverride || 0 };
      save();
      toast('正在打开抖音「关注」页 —— 接下来由抖音自己去取数据，不会再失败', 4000);
      setTimeout(function () { location.href = 'https://www.douyin.com/follow'; }, 700);
      return Promise.resolve({ ok: false, nav: true, error: '正在打开关注页，到那边会自动接着抓' });
    }
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
    var accFailStreak = 0, slowRounds = 0;   // 连续【账号】级失败数 + 已经「歇过几次」（连挂 5 个歇一次）
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
          if (!readMap[id]) { readMap[id] = 1; S.readIds.push(id); S.__rseq++; }
        }
      }
    }
    function absorb(list) {
      for (var k = 0; k < list.length; k++) {
        var v = list[k];
        if (known[v.awemeId] || readMap[v.awemeId]) continue;
        if (histMap[v.awemeId]) {                 // 抖音那边已经看过了 → 不算未读
          histSkip++;
          if (!readMap[v.awemeId]) { readMap[v.awemeId] = 1; S.readIds.push(v.awemeId); S.__rseq++; }
          continue;
        }
        S.videos.push(v); known[v.awemeId] = 1; newCount++; S.__vseq++;
      }
    }
    // AIMD：顺了才加速，卡了立刻减速（降到 1 之后恢复得更快：连成 4 个就 +1）
    function onGood() {
      consecOk++; consecFail = 0; riskStreak = 0; accFailStreak = 0;
      var need = conc <= 1 ? 4 : 6;
      if (consecOk >= need && conc < maxConc) { conc++; consecOk = 0; }
    }
    function onBad(e, acc) {
      errors++; consecOk = 0; consecFail++;
      if (acc && !acc._failCounted) { acc._failCounted = 1; failAcc++; accFailStreak++; }   // 同一账号只记一次
      /* ★ 连续 5 个账号没抓到 → 先「歇口气」再继续（10-03 01:25）。
         旧行为是硬磨：一个接一个 403，满屏失败，还把抖音盯得更死，下一轮更难抓。
         现在是：连挂 5 个 → 降到 1 并发 + 换令牌 + 长冷却 10~15 秒（让风控过去），
         ★ 注意是【冷却后继续】，不是【收工】—— 一轮能抓完就尽量一轮抓完，不让你多按几次。
         只有连着歇了 3 次还是没起色（累计约 15 个账号连挂，说明抖音这次真的不给了），
         才收工写断点；没抓到的下次自动从断点补，一个都不会漏。 */
      if (accFailStreak >= 5 && !bailout) {
        accFailStreak = 0; slowRounds++;
        conc = 1;
        refreshMsToken();
        coolUntil = Date.now() + (10000 + Math.random() * 5000);
        if (slowRounds >= 3) {
          bailout = true; stopped = true;
          toast('抖音这会儿一直不给数据，本轮先收尾（已抓到的都存好了）；没抓到的下次自动从断点补，不会漏。', 6000);
        } else {
          toast('连着几个没抓到，先歇十几秒再继续（这轮会接着抓完，不用你再点）。', 4000);
        }
      }
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
    /* ★ caught 提到 scanUnread 这一层（10-03 02:20）：关注页收割也要往里写「已核对」的账号，
       放在 feedPhase 里的话收割拿不到，就没法把「已经核对完」的账号从逐个抓里摘掉。 */
    var caught = {};
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
      var t0 = Date.now(), cursor = 0;   // caught 已提到外层（收割阶段共用）
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
      /* 错峰：别让几个请求在同一毫秒齐射出去（齐射最像机器人，容易被盯）。
         ★ 逐个补抓一律走「慢而稳」的节奏（10-03 01:25：700~1500ms）：
           这条路上一个账号就是一次请求，请求密了必然 403；慢一点代价只是时间，
           换来的是「几乎不失败」—— 失败要重跑整批，反倒更慢。 */
      var waitMs = Math.max(0, coolUntil - Date.now()) + 700 + Math.floor(Math.random() * 800);
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
        harvest: harvestInfo ? { pages: harvestInfo.pages, got: (harvestInfo.list || []).length, ms: harvestInfo.ms } : null,
        side: sideInfo ? {
          accN: Object.keys(sideInfo.secMap || {}).length, rows: sideInfo.rows || 0,
          total: sideInfo.total, liTotal: sideInfo.liTotal, secMap: sideInfo.secMap || {}
        } : null,
        domUnread: S.domUnread || null,
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
      /* ★ 逐个补抓固定用「最多 2 并发」（10-03 01:25）：
         这条路上一个账号一次请求，并发越高越像机器人 → 403 → 满屏失败。
         信息流阶段已经把绝大多数账号核对掉了，这里剩下的本来就不多，用 2 并发慢慢磨最稳。 */
      conc = Math.min(2, maxConc);
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

    /* ============ 阶段 0：关注页收割（10-03 02:20 新增，主引擎）============
       在抖音自己的「关注」页里往下滚，让抖音前端自己去翻页、自己发请求，
       我们只把它收到的响应抄下来解析 —— 全程 0 次自签名请求，所以 0 次失败。
       同时直接读页面上抖音写的「N个作品未看」，那是服务器给的真实未读数。 */
    var harvestInfo = null, sideInfo = null;
    function harvestPhase() {
      if (S.cfg.harvest === false) return Promise.resolve();
      if (!onFollowPage()) return Promise.resolve();
      var hUid = {}, hNew = {}, ix;
      for (ix = 0; ix < S.accounts.length; ix++) if (S.accounts[ix].secUserId) hUid[S.accounts[ix].secUserId] = 1;
      for (ix = 0; ix < S.videos.length; ix++) {
        var hv = S.videos[ix];
        if (hv.secUid && (!hNew[hv.secUid] || (hv.publishedAt || 0) > hNew[hv.secUid])) hNew[hv.secUid] = hv.publishedAt || 0;
      }
      phase = 'harvest';
      return harvestFollowPage({
        horizon: prevScanAt ? (prevScanAt - 90 * 60000) : 0,
        maxMs: 150000, uidMap: hUid, newest: hNew,
        shouldStop: function () { return shouldStop(); },
        onPage: function (st) {
          feedCaughtN = st.covered;
          feedPages = st.pages;
          report('关注页收割 第 ' + st.rounds + ' 屏');
        }
      }).then(function (res) {
        var before = newCount;
        absorb(res.list || []);
        feedNew += (newCount - before);
        harvestInfo = res;
        feedUsed = true;
        scheduleSave();
        var u2;
        for (u2 in res.covered) feedCovered[u2] = 1;
        /* 收割翻到了「上次抓取」之前的视频 → 这段时间的新视频已经全收齐了，
           其余账号这段时间根本没发 → 全部标成已核对，一个逐个请求都不用打。 */
        var hvFlat = (res.oldest !== Infinity && prevScanAt && res.oldest <= prevScanAt - 90 * 60000);
        if (hvFlat) {
          for (var ix2 = 0; ix2 < plan.length; ix2++) { if (plan[ix2].secUserId) caught[plan[ix2].secUserId] = 1; }
        } else {
          for (u2 in res.covered) if (res.covered[u2]) caught[u2] = 1;
        }
        if (!res.pages) {
          toast('关注页这次没翻出新内容（页面结构可能变了）。已自动用信息流 + 逐个补抓兜底。', 5000);
        } else if (hvFlat) {
          toast('关注页已追平（翻到上次抓取之前的视频），全部账号核对完毕 —— 0 次逐个请求。', 4000);
        }
      }).catch(function () { /* 收割没收到东西也不算失败：下面还有信息流和逐个抓兜底 */ })
      .then(function () {
        /* ★★ 收割完（这时页面已经被翻过好几屏）再回来把「我的关注」侧栏读全 ★★
           这一句是「未读数跟抖音 App 对得上」的关键：
           抖音自己写在侧栏上的「N 个作品未看」= 服务器算给你的真实未读，
           比我们自己拿「抓到的 − 已看记录 − 本机已读」去猜准得多。
           ⚠ 必须在收割之后再读：收割前的那一瞬间侧栏还没懒加载出来，读到的只有首屏十几个号。 */
        phase = 'side';
        return harvestFollowSidebar({
          shouldStop: function () { return shouldStop(); },
          onTick: function (st) {
            report('读抖音真实未读…');
          }
        }).then(function (side) {
          sideInfo = side;
          if (side && (Object.keys(side.secMap).length || side.liTotal)) {
            S.domUnread = {
              map: side.secMap, byName: side.nameMap,
              total: side.total, rows: side.liTotal, liTotal: side.liTotal,
              accN: Object.keys(side.secMap).length, ts: Date.now()
            };
            save();
          }
          /* ★★ 用这一轮读到的「N个作品未看」反推每个号的未读边界：
             没这一步，未读集合就只能退化成「全部抓到的视频」，旧视频全被算成未读 → 和 App 对不上。 */
          applyBadgeCursors(side);
          save();
        });
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
        return harvestPhase();
      })
      .then(function () {
        /* 收割核对过的账号要从本轮名单里划掉。
           ★ 以前这里写得有问题：left0 算出来了，却只用它决定「要不要跑信息流」，
             没用它缩小 plan —— 下一环节拿着【完整的 plan】照样把几百个账号逐个打一遍，
             于是收割刚抄到的新视频，又被后续这堆请求折腾一遍，性能和结果都对不上。 */
        var left0 = [];
        for (var iz = 0; iz < plan.length; iz++) if (!caught[plan[iz].secUserId]) left0.push(plan[iz]);
        if (!left0.length) feedCaughtN = plan.length;
        plan = left0;
        report('', true);
        if (!plan.length) return;
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
    var tu = totalUnread();
    var du = S.domUnread, duFresh = !!(du && du.ts && Date.now() - du.ts <= SNAP_VALID_MS);
    var h = '';
    /* 注：原先这里有一段「⚠️ 检测到系统/浏览器正处于夜间模式…」的整块红字提示，
       按用户要求已删除（2026-10-03 15:14）。detectNightMode() 本身保留，设置页的皮肤自检还在用。 */
    h += '<div class="dyh-card">';
    h += '<div class="dyh-row"><b>账号</b><span>' + (S.selfSecUid ? '已登录' : '未识别') + '</span></div>';
    h += '<div class="dyh-row"><b>关注公众号</b><span>' + S.accounts.length + ' 个</span></div>';
    /* ★ 未读总数走「抖音自己在关注页标的数」，跟 App 同一口径（不是本机抓了多少条明细） */
    h += '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + tu.n + ' 条 / ' + tu.acc + ' 个号</span></div>';
    h += '<div class="dyh-row"><b>其中抖音标记未看</b><span>' +
      (duFresh ? (Object.keys(du.map || {}).length + ' 个号 · ' + (function () {
        var s = 0; for (var k in du.map) s += du.map[k]; return s;
      })() + ' 条') : '（还没读到，抓一轮就有了）') + '</span></div>';
    h += '<div class="dyh-row"><b>本机抓到明细</b><span>' + unread.length + ' 条（点开看得到）</span></div>';
    h += '<div class="dyh-row"><b>上次抓取</b><span>' + (S.lastScanAt ? fmtTime(S.lastScanAt) : '从未') + '</span></div>';
    h += '<div class="dyh-row"><b>已看记录</b><span>' + S.readIds.length + ' 条</span></div>';
    h += '</div>';
    h += '<button class="dyh-btn" data-act="refresh">📥 刷新我的关注列表</button>';
    h += '<button class="dyh-btn primary" data-act="scan">📡 抓最新未读视频（去关注页·不失败）</button>';
    h += '<button class="dyh-btn" data-act="manage">📺 未读视频查看</button>';
    h += '<button class="dyh-btn" data-act="search">🔎 搜索并关注新账号</button>';
    h += '<button class="dyh-btn" data-act="push">☁️ 推到 GitHub（手机端 HTML 可看）</button>';
    h += '<button class="dyh-btn gray" data-act="settings">⚙️ 设置（GitHub / 数据）</button>';
    h += '<div class="dyh-tip">标题后面那个 <b>' + VER_SHORT +
      '</b> 是版本号（生成时间 + 本次改动，完整说明在设置页最下面），用来确认手机上跑的是不是最新版。</div>';
    return h;
  }

  function unreadVideos() {
    var readMap = readIdMap();
    return S.videos.filter(function (v) { return !readMap[v.awemeId]; })
      .sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
  }

  /* ===================== 未读对账页（10-03 11:40 新增）=====================
     你对照抖音 App 说「完全不一样」之后最需要的一页：把
       「抖音自己在关注页标的数」 和 「我们本机抓到的明细数」 摆在一起，
       再把【差在谁身上】一条条列出来。
     这样不用再猜「到底哪边错了」—— 数字摆一起、差的名单摆一起，一眼就明白。 */
  function renderRecon() {
    var r = reconUnread();
    var h = '<div class="dyh-back" data-act="home">← 返回</div>';
    h += '<div class="dyh-tip" style="margin:0 0 8px">这一页只做一件事：把<b>抖音自己标的未读数</b>和' +
      '<b>我们本机抓到的明细数</b>摆在一起，再列出差在谁身上。' +
      '面板里的「未读」一律以<b>抖音标的为准</b>（和 App 同一口径）。</div>';
    h += '<div class="dyh-card">';
    h += '<div class="dyh-row"><b>① 抖音标的</b><span class="dyh-hl">' + (r.fresh ? (r.duAcc + ' 个号 · ' + r.duN + ' 条') : '没读到') + '</span></div>';
    h += '<div class="dyh-row"><b>　侧栏读到账号</b><span>' + (r.duRows || '—') + ' 个（关注总数 ' + (r.accTotal) + '）</span></div>';
    h += '<div class="dyh-row"><b>② 本机抓到明细</b><span>' + r.locN + ' 条 · ' + r.locAcc + ' 个号</span></div>';
    h += '<div class="dyh-row"><b>③ 差别的</b><span>' + r.diffN + ' 个号两边数不一样</span></div>';
    h += '</div>';
    if (!r.fresh) {
      h += '<div class="dyh-tip" style="color:#f53f3f">⚠ 还没读到抖音标的数（一般是还没抓过 / 6 小时前那次没读成）。' +
        '点下面的「重新读一次」回到抖音「关注」页读一遍就好，读不到也不会更糟。</div>';
    }
    if (r.diffN) {
      h += '<div class="dyh-tip" style="margin:8px 0 6px">差在谁身上（±就是两边差多少）：</div>';
      h += '<div class="dyh-card">';
      for (var i = 0; i < r.diff.length; i++) {
        var d = r.diff[i];
        h += '<div class="dyh-row"><b>' + esc(d.name || '(没名字)') + '</b><span>' +
          '抖音 <b>' + (d.srv || 0) + '</b> 条 · 本机 <b>' + d.loc + '</b> 条 · 差 <b>' + (d.srv - d.loc) + '</b></span></div>';
      }
      h += '</div>';
    } else if (r.fresh) {
      h += '<div class="dyh-tip">✅ 两边完全一致，这个数就是你在抖音 App 里看到的未读。</div>';
    }
    h += '<button class="dyh-btn" data-act="recon-refresh">🔄 重新读一次（回抖音关注页）</button>';
    h += '<button class="dyh-btn primary" data-act="manage">📺 去看未读视频</button>';
    return h;
  }

  /* ============ 未读的「消费」全部收在助手面板里（不和电脑/GitHub 打交道）============
     以前的结果链路是：助手抓 → 推 GitHub → 再去手机端 HTML 看。用户要的是：
     【抓、判、看、标已看】全在抖音关注助手这一个面板里完成。下面这几个函数就是这条闭环。 */

  /* ======================= 管理分类 / 批量取关 =======================
     分类不再写死在脚本里（CATS 只当默认值），改成 S.categories —— 能新建、改名、删除，
     删掉的分类里的账号自动落到「未分类」，不会跟着消失。
     每个账号后面标未读条数：视频对象里带 secUid 就按 secUid 数（对方改名也不怕），
     拿不到就退回按昵称数。 */
  var MGR = { cat: '', kw: '', adding: false, editing: '', drop: false, acc: '', accName: '', sync: false };
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

  function normName(s) { return String(s || '').replace(/\s+/g, ''); }

  /* ======================= 未读统计的统一视图（10-03 03:10 重做）=======================
     以前 unreadByAccount 用「视频的 secUid」建表，而列表用「账号的 secUserId」去查 ——
     两边只要有一边缺失（老数据只有昵称 / 关注列表没刷新到），就查不到 → 抓到了也显示 0 未读，
     也就是你说的「抓完以后查看页没按抓取结果显示」。现在两边都写、两边都能查。

     顺便解决两件事：
       ① 作者不在关注列表里（列表没刷新过 / 刚关注）→ 合成「虚拟账号」照样列出来，绝不吞掉；
       ② 抖音关注页上写的「N 个作品未看」是服务器给的真实未读数，本机明细不够时以它为准。 */
  function buildUnreadView() {
    var readMap = readIdMap(), groups = {}, order = [], i, v, k;
    for (i = 0; i < S.videos.length; i++) {
      v = S.videos[i];
      if (!v || !v.awemeId || readMap[v.awemeId]) continue;
      k = v.secUid || ('n:' + normName(v.account || ''));
      if (!groups[k]) { groups[k] = { key: k, secUid: v.secUid || '', name: v.account || '', n: 0, newest: 0 }; order.push(k); }
      var g = groups[k];
      g.n++;
      if (!g.name && v.account) g.name = v.account;
      if (!g.secUid && v.secUid) g.secUid = v.secUid;
      if ((v.publishedAt || 0) > g.newest) g.newest = v.publishedAt || 0;
    }
    /* 同一个账号的两个 key 都登记同一个数 —— 谁查都查得到，但只数一次 */
    var map = {};
    for (i = 0; i < order.length; i++) {
      var g2 = groups[order[i]], n = g2.n;
      if (g2.secUid) map[g2.secUid] = n;
      var nn = normName(g2.name);
      if (nn) map[nn] = Math.max(map[nn] || 0, n);
      if (g2.name) map[g2.name] = Math.max(map[g2.name] || 0, n);
    }
    return { map: map, groups: groups, order: order };
  }

  /* 兼容旧写法：unreadByAccount() 直接当 map 用 */
  function unreadByAccount() { return buildUnreadView().map; }

  /* 一个账号有几个未读：本机明细（userid / 昵称 都能命中） */
  function localUnread(a, um) {
    if (!a) return 0;
    if (a.secUserId && um[a.secUserId]) return um[a.secUserId];
    if (a.name && um[a.name]) return um[a.name];
    var nn = normName(a.name);
    return (nn && um[nn]) || 0;
  }

  /* 抖音自己在关注页写的「N 个作品未看」—— 服务器给的真实未读数。
     只认 6 小时内的（更久之前的是上一次抓的快照，不能拿来压现在的数）。 */
  function serverUnread(a) {
    var du = S.domUnread;
    if (!du || !du.ts || Date.now() - du.ts > SNAP_VALID_MS) return 0;
    if (!a) return 0;
    if (a.secUserId && du.map && du.map[a.secUserId]) return du.map[a.secUserId];
    if (a.name && du.byName) {
      if (du.byName[a.name]) return du.byName[a.name];
      var nn = normName(a.name);
      if (du.byName[nn]) return du.byName[nn];
    }
    return 0;
  }

  /* 抖音在关注页标的「N个作品未看」：和 serverUnread 的区别是——它【能区分「明确标 0」和「没读到」】。
     返回：>=0 的数字（含 0，表示抖音这一轮确实读到了、且这个号标的就是这个数）；-1 表示
     没读到 / 过期（这时不能拿 0 去压数，要交给边界或 lastScanAt 兜底）。 */
  function douyinBadge(a) {
    var du = S.domUnread;
    if (!du || !du.ts || Date.now() - du.ts > SNAP_VALID_MS) return -1;
    if (!a) return -1;
    if (a.secUserId && du.map && du.map[a.secUserId] != null) return du.map[a.secUserId];
    if (a.name) {
      if (du.byName && du.byName[a.name] != null) return du.byName[a.name];
      var nn = normName(a.name);
      if (du.byName && du.byName[nn] != null) return du.byName[nn];
    }
    return -1;   // 这一轮读到了侧栏，但这个号没出现在「N个作品未看」里 → 抖音就是标 0
  }

  /* ============ 数字来源的优先级（16:05 重做，为解决「App 显示 6、我们显示 16」）============
     ★ 病根：`accUnread` 里只要 `srv > n` 就直接返回侧栏角标。而侧栏角标存在全局快照
       `S.domUnread` 里、有效期 6 小时 —— 你在这 6 小时里用 App 看过视频，App 变成 6 了，
       我们却还在拿 16 这个旧角标盖住新算出来的数，于是「未读 16 条」而「只抓到 15 条」。
     ★ 修法：把「数字」按可信度分层，越新、越针对这个号、越同源的越优先：
       ① 单号刚算出的抖音口径数（S.accUnreadN，2 小时内、找到了已看边界）—— 用抖音自己的已看记录算的，和 App 同源；
       ② 单号刚读到的官方角标（S.accBadge，30 分钟内）—— 就是这个号旁边写的「N个作品未看」；
       ③ 全局侧栏快照（S.domUnread，6 小时内）—— 可能过期，只在没有更准来源时用；
       ④ 本机按未读边界算出的条数（永远兜底，不会凭空多算）。 */

  /* 单号官方角标（带独立时间戳）。超过 30 分钟就当没有 —— 你在 App 里看几条它就变了。 */
  function accBadgeOf(a) {
    if (!a || !a.secUserId || !S.accBadge) return null;
    var r = S.accBadge[a.secUserId];
    if (!r || r.at == null) return null;
    if (Date.now() - r.at > 30 * 60000) return null;
    return r;
  }
  /* 单号刚算出的未读数；只有【官方角标】来源才算数（source==='badge'）。
     ★ 16:28：本机估算（网页已看记录算的）一律不采信 —— 实测它算出 0 而 App 是 6，
       因为网页端已看记录 ≠ App 观看状态（App 看过的网页未必有，网页自动播放的反而混进去）。 */
  function accFreshN(a) {
    if (!a || !a.secUserId || !S.accUnreadN) return null;
    var r = S.accUnreadN[a.secUserId];
    if (!r || r.n == null || r.source !== 'badge') return null;
    if (Date.now() - r.at > 2 * 3600000) return null;
    return r;
  }

  /* ★★ 18:00：这个号的未读数到底"知道不知道"？
     不知道 = 既没读到官方角标、也没有未读边界。此时**绝不能拿视频库条数冒充未读数** ——
     那个 16 就是这么来的（我们库里存了 16 条，就报"16 条未读"），而抖音 App 里只有 5。
     宁可显示「需重读」，也不编一个看起来很像真的数字。 */
  function accUnreadUnknown(a) {
    if (!a || a._ghost) return false;
    if (accFreshN(a) || accBadgeOf(a)) return false;
    if (accCursorOf(a) >= 0) return false;
    var du = S.domUnread;
    if (du && du.ts && Date.now() - du.ts <= SNAP_VALID_MS) {
      if (a.secUserId && du.map && du.map[a.secUserId] != null) return false;
      if (a.name && du.byName) {
        if (du.byName[a.name] != null || du.byName[normName(a.name)] != null) return false;
      }
    }
    return true;
  }

  /* 一个号有几个未读（数量）
     ★ 18:05 重要设计：**把"数字"和"这个数字可不可信"分开**。
       - 数字照常算（没有官方角标时用本机估算），这样列表/统计不会整个塌成 0；
       - 但 `accUnreadUnknown(a)` 会告诉你它不可信，**界面上必须标成「需重读 · 估 N」**，
         绝不能让它冒充成官方数（那个 16 就是这么被当成"未读数"报出来的）。
       - `totalUnread()` 不把不可信的号计入总数，避免首页被估算值撑大。 */
  function accUnread(a, um) {
    if (!a) return 0;
    if (a._ghost) return localUnread(a, um);          // 非关注的推荐号：抖音不会给它未读数
    /* ① 刚按官方角标算出来的 N（最可信：就是 App 里那个数） */
    var mu = accFreshN(a);
    if (mu) return mu.n;
    var vids = unreadVideosOf(a.secUserId, a);
    var n = vids.length;
    /* ② 官方角标（30 分钟内）：先看这个号的独立记录，再退到全局快照（有效期也已压到 30 分钟，
          17:00 起过期快照彻底不参与 —— 宁可显示本机条数，也不显示几小时前的旧数） */
    var ab = accBadgeOf(a);
    var srv = ab ? ab.n : serverUnread(a);
    if (srv > 0 && n < srv) return srv;              // 抓到的明细比官方标的少 → 以官方为准并标 ⁺
    return n;                                          /* ③ 本机按边界算出的条数（不够可信，见 accUnreadUnknown） */
  }

  /* 「全部未读」= 按账号把抖音给的数加总（和 App 的关注未读总数同一口径）
     ★ 不再用「本机抓到几条明细」去当总数 —— 那正是「抓到的和 App 里看到的完全不一样」的来源。
     返回 { n: 未读总条数, acc: 有几个号有未读 } */
  function totalUnread() {
    var um = buildUnreadView().map, n = 0, acc = 0, i, unk = 0;
    for (i = 0; i < S.accounts.length; i++) {
      /* ★ 18:05：不可信的号（本机估算，没读到官方角标/边界）**不计入总数**，
         否则首页会被估算值撑大 —— 那个 16 就是这么混进「未读总数」的。 */
      if (accUnreadUnknown(S.accounts[i])) { unk++; continue; }
      var x = accUnread(S.accounts[i], um);
      if (x > 0) { n += x; acc++; }
    }
    return { n: n, acc: acc, unknown: unk };
  }

  /* 和抖音对账：看看「抖音说 N 条」与「本机抓到 M 条明细」差在哪，差在谁身上 */
  function reconUnread() {
    var um = buildUnreadView().map, rows = [], i;
    var du = S.domUnread || null;
    var duFresh = !!(du && du.ts && Date.now() - du.ts <= SNAP_VALID_MS);
    var duN = 0, duAcc = 0;
    if (duFresh) { for (var k in du.map) { duN += du.map[k]; duAcc++; } }
    for (i = 0; i < S.accounts.length; i++) {
      var a = S.accounts[i];
      var srv = duFresh ? serverUnread(a) : 0;
      var loc = localUnread(a, um);
      if (srv === loc) continue;
      rows.push({ name: a.name || a.secUserId, srv: srv, loc: loc });
    }
    rows.sort(function (p, q) { return Math.abs(q.srv - q.loc) - Math.abs(p.srv - p.loc); });
    return {
      fresh: duFresh, accTotal: S.accounts.length,
      duN: duN, duAcc: duAcc, duRows: (du && du.liTotal) || 0,
      locN: S.videos.length - S.readIds.length, locAcc: buildUnreadView().order.length,
      diff: rows.slice(0, 30), diffN: rows.length
    };
  }

  /* 抓到视频了、但这个作者不在你的关注列表里（列表没刷新 / 刚关注 / 列表是旧的）
     → 也给你列出来，不能让抓到的东西凭空消失。 */
  /* ===================== 关注列表刷过之后，未读视图「以它为准」=====================
     ★ 2026-10-03 15:14（用户要求）：点「📥 刷新我的关注列表」之后，未读视频查看里的
       视频应该跟着【新的关注列表】变 —— 取关掉的号不该还留在里面。
       ① listIsFresh()：刚刷新过（24 小时内）→ 未读视图只认列表里的号；
       ② pruneToAccounts()：刷新时把「不在列表里的号」的视频和未读边界清掉。
     ⚠ 两者都要「列表刚刷新过」才生效：平时没刷新过列表时，虚拟号仍要保留 ——
       否则刚关注还没来得及刷新列表、或还没抓过的号，内容会凭空消失。 */
  function listIsFresh() {
    return !!(S.listAt && (Date.now() - S.listAt) < 24 * 3600000);
  }
  /* 把视频库、未读边界裁剪成「只留下这份关注列表里的号」 */
  function pruneToAccounts(accs) {
    var sec = {}, nm = {}, i, v, k;
    for (i = 0; i < accs.length; i++) {
      if (accs[i].secUserId) sec[accs[i].secUserId] = 1;
      if (accs[i].name) nm[normName(accs[i].name)] = 1;
    }
    var kept = [];
    for (i = 0; i < S.videos.length; i++) {
      v = S.videos[i];
      if (!v) continue;
      if ((v.secUid && sec[v.secUid]) || (v.account && nm[normName(v.account)])) kept.push(v);
    }
    if (kept.length !== S.videos.length) { S.videos = kept; S.__vseq++; }
    if (S.accCursor) {
      for (k in S.accCursor) {
        if (Object.prototype.hasOwnProperty.call(S.accCursor, k) && !sec[k]) delete S.accCursor[k];
      }
    }
    return S.videos.length;
  }

  function ghostAuthors(view) {
    /* 刚刷新过关注列表 → 以列表为准，不再把「抓到但不在列表里」的号混进来（否则已取关的号一直挂着） */
    if (listIsFresh()) return [];
    var have = {}, out = [], i, a;
    for (i = 0; i < S.accounts.length; i++) {
      a = S.accounts[i];
      if (a.secUserId) have[a.secUserId] = 1;
      if (a.name) have[normName(a.name)] = 1;
    }
    for (i = 0; i < view.order.length; i++) {
      var g = view.groups[view.order[i]];
      if ((g.secUid && have[g.secUid]) || (g.name && have[normName(g.name)])) continue;
      out.push({ secUserId: g.secUid || '', name: g.name || g.key, category: '', _ghost: 1 });
    }
    return out;
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
    var n = 0, i;
    for (i = 0; i < S.accounts.length; i++) {
      var a = S.accounts[i];
      if (cat !== ALL_CAT && catOf(a) !== cat) continue;
      n += accUnread(a, um);
    }
    /* 抓到了视频、但【不在你的关注列表里】的作者（推荐流 / 广告 / 列表没刷新过）：
       照样列出来让你看得见（抓到的东西不许凭空消失），但【不计入未读总数】——
       抖音的「我的关注」侧栏里根本没有他们，算进去就会跟 App 里的数对不上。 */
    var ghostN = 0;
    if (cat === ALL_CAT || cat === NO_CAT) {
      var gs = ghostAuthors(buildUnreadView());
      for (i = 0; i < gs.length; i++) ghostN += accUnread(gs[i], um);
    }
    catUnread.ghostN = ghostN;
    /* 「全部分类 / 未分类」视图把【抓到但不在关注列表里的号】也算进去，
       这样抓到的内容一条都不丢；首页的「未读总数」用的是独立的 totalUnread()，
       只数你真正关注的号（和 App 的「我的关注」口径一致）。 */
    return n + ghostN;
  }
  // 一个分类下【当前】的成员（已按昵称关键字过滤）；未读多的排前面
  function catMembers(cat, um) {
    var kw = (MGR.kw || '').trim().toLowerCase(), out = [], i, a;
    for (i = 0; i < S.accounts.length; i++) {
      a = S.accounts[i];
      if (cat !== ALL_CAT && catOf(a) !== cat) continue;
      if (kw && String(a.name || a.secUserId || '').toLowerCase().indexOf(kw) < 0) continue;
      out.push(a);
    }
    /* ★ 抓到视频却不在关注列表里的作者也要露出来（10-03 03:10）
       以前只看 S.accounts：关注列表要是没刷新过，抓到的东西就整个显示不出来。 */
    if (cat === ALL_CAT || cat === NO_CAT) {
      var gs = ghostAuthors(buildUnreadView());
      for (i = 0; i < gs.length; i++) {
        if (kw && String(gs[i].name || gs[i].secUserId || '').toLowerCase().indexOf(kw) < 0) continue;
        out.push(gs[i]);
      }
    }
    out.sort(function (x, y) { return accUnread(y, um) - accUnread(x, um); });
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
          ?             '<span class="dyh-mini" data-act="mgr-rename" data-cat="' + esc(cat) + '">改名</span>' +
            '<span class="dyh-mini dg" data-act="mgr-del-cat" data-cat="' + esc(cat) + '">删分类</span>'
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

    /* ★★ 23:55：「一次读全部」——单号去读要滚很多次才轮到它，这里一次性把侧栏滚到底，
       把抖音写的未读数【全部】读下来（这个数与 App 同源，就是权威值）。 */
    h += '<button class="dyh-btn primary" data-act="read-all-badges">📡 读全部账号的官方未读数</button>';
    h += '<div class="dyh-tip" style="margin-top:2px">把抖音「关注」页左侧列表<b>滚到底</b>，每行写的「N个作品未看」<b>全部抄下来</b>，' +
      '然后整个面板（未读列表 / 分类统计 / 首页未读总数）都按它更新。共 ' + S.accounts.length + ' 个号。<br>' +
      '⚠️ <b>正在直播的号，网页端不写这个角标</b>（真机截图已确认）—— 这类号会如实标成「未知」，不会瞎报 0。</div>';

    /* ---- 搜索 ---- */
    h += '<input id="dyh-mgr-kw" class="dyh-input" placeholder="搜公众号名称（留空看全部）" value="' + esc(MGR.kw || '') + '">';

    h += '<div id="dyh-mgr-list">' + mgrListHtml(cat, um) + '</div>';

    /* 注：原先这里有「☁️ 同步电脑端的分类」入口 + 拉取卡片（pullCats），
       按用户要求已从「未读视频查看」页整块删除（2026-10-03 15:14）。
       applyCatFile / pullCats 两个函数保留（设置页仍可调，且仿真仍覆盖），只是本页不再提供入口。 */
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
      var unknown = accUnreadUnknown(a);
      var un = accUnread(a, um);            /* ★ 数字照常算；unknown 只影响标签，不抹掉数字 */
      var loc = localUnread(a, um);
      /* 抖音说还有更多的（本机没抓到明细）标个 +，让你知道不是没抓到、是还没抓到明细 */
      var plus = (un > loc) ? '<small style="font-size:15px;opacity:.75">⁺</small>' : '';
      h += '<div class="dyh-acc2">' +
        '<span class="dyh-nm" data-act="acc-videos" data-sec="' + esc(a.secUserId) + '" data-name="' + esc(a.name || '') + '">' +
        (a._ghost ? '<small style="font-size:15px;opacity:.7">新·</small>' : '') + esc(a.name || a.secUserId) + '</span>' +
        /* ★ 18:05：没有可信来源时**保留数字但加「需重读」标记** ——
           既不把估算冒充成官方数，也不把用户已有的信息抹掉。 */
        '<span class="dyh-urn2' + (un ? '' : ' ok') + '">' +
        (un ? (un + ' 未读' + plus + (unknown ? '<small style="font-size:15px;opacity:.8"> 需重读</small>' : ''))
            : '已看完') + '</span>' +
        '<span class="dyh-mini" data-act="setcat" data-sec="' + esc(a.secUserId) + '">' + esc(a.category || '设分类') + '</span>' +
        '</div>';
    }
    if (!shown) h += '<div class="dyh-tip">这个分类下还没有公众号' + (kwOn ? '（换个关键词试试）' : '') + '。</div>';
    else if (shown > 300) h += '<div class="dyh-tip">先显示 300 个（本类共 ' + shown + ' 个），用上面搜索框过滤。</div>';
    return h;
  }

  /* ================= 某个公众号的「未读视频列表」 =================
     点进来只看这一个号的未读；点任意一条 → 唤起抖音 App 看（没唤起就退回网页版），
     并当场记成已看（未读数立刻 -1，不用等下一轮抓取）。

     ★★ 2026-10-03 12:55 重写（这是「抓到的视频对、但未读集合和 App 对不上」的根子）★★
     以前这里把【该账号抓到的全部视频】都当未读（只按本机已读记录过滤），
     只有当「抓到数 > 抖音标的 N」时才截断到最新的 N 条。一旦某个账号没匹配上抖音的
     「N个作品未看」（侧栏没读到 / 超过 6 小时），srvN=0，就【把该账号所有历史视频全算成未读】——
     包括你早看过的旧视频，于是和 App 完全对不上。
     现在：未读集合一律 = 该账号【最新的 N 条】，N 按下面的优先级取：
        ① 扫描时已由抖音 badge 反推出的 per-account 边界（accCursor）→ 边界之后才是未读
        ② 抖音关注页标的「N个作品未看」（6h 内）→ 最新的 N 条
        ③ 都没读到 → 只把「这次抓取新抓到的」(publishedAt > lastScanAt) 当未读，
           绝不把陈年旧视频算进来（宁可少算，也比把看过的算成未读强） */
  /* ================= 视频按账号建索引（性能关键，2026-10-03 14:05 加）=================
     以前 accountVideosSorted 每查一个账号都把全部 S.videos（约 1.2 万条）扫一遍，
     而列表排序 / 统计未读 / 下拉分类项又会对每个账号各查一次 → O(账号×视频)≈ 上千万次循环，
     打开「未读视频查看」直接卡住。这里把视频按 secUid / 昵称各建一份索引（只建一次，
     按 S.__vseq 复用），之后查某账号 = O(该账号自己的视频数)。 */
  var _vidIdx = null, _vidSrc = null, _vidLen = -1, _vidSeq = -1;
  function buildVideoIndex() {
    var src = S.videos, len = src ? src.length : 0, seq = S.__vseq || 0;
    /* ★ 失效判断必须同时看【数组引用】和【长度】，缺一不可：
         · S.videos = [...] 整段替换（脚本内部改状态 / 测试都这么干）→ 引用变了、长度可能不变；
         · S.videos.push(v) 抓取追加（引用没变、长度变了）。
         只看其中一个都会读到过期索引（表现为「视频明明加进去了却查不到」）。 */
    if (_vidIdx && _vidSrc === src && _vidLen === len && _vidSeq === seq) return _vidIdx;
    var bySec = {}, byName = {}, byRaw = {}, i, v;
    for (i = 0; i < len; i++) {
      v = src[i]; if (!v || !v.awemeId) continue;
      if (v.secUid) { (bySec[v.secUid] || (bySec[v.secUid] = [])).push(v); }
      if (v.account) {
        var rn = normName(v.account);
        (byName[rn] || (byName[rn] = [])).push(v);
        (byRaw[v.account] || (byRaw[v.account] = [])).push(v);
      }
    }
    _vidIdx = { bySec: bySec, byName: byName, byRaw: byRaw, accCache: {} };
    _vidSrc = src; _vidLen = len; _vidSeq = seq;
    return _vidIdx;
  }
  /* 已看记录缓存（同样按「引用 + 长度 + 序号」失效）：避免 unreadVideosOf / buildUnreadView
     每个账号都重建一遍 readMap（readIds 也可能上万条）。 */
  var _rmap = null, _rSrc = null, _rLen = -1, _rSeq = -1;
  function readIdMap() {
    var src = S.readIds, len = src ? src.length : 0, seq = S.__rseq || 0;
    if (_rmap && _rSrc === src && _rLen === len && _rSeq === seq) return _rmap;
    var m = {}, i; for (i = 0; i < len; i++) m[src[i]] = 1;
    _rmap = m; _rSrc = src; _rLen = len; _rSeq = seq; return m;
  }

  function accountVideosSorted(a) {
    var name = a ? (a.name || '') : '', nName = normName(name);
    var key = (a && a.secUserId) ? ('s:' + a.secUserId) : ('n:' + nName);
    var idx = buildVideoIndex();
    if (idx.accCache[key]) return idx.accCache[key];
    var pool = [], i, v, arr;
    if (a && a.secUserId && (arr = idx.bySec[a.secUserId])) pool = pool.concat(arr);
    if (nName && (arr = idx.byName[nName])) pool = pool.concat(arr);
    if (name && (arr = idx.byRaw[name])) {
      for (i = 0; i < arr.length; i++) {
        v = arr[i];
        if (!nName || normName(v.account) !== nName) pool.push(v);   // 原始名命中、但规范化昵称没命中的补进来
      }
    }
    /* 去重：同一视频可能同时命中 secUid 与昵称两条索引（旧数据 secUid 缺失时会重复） */
    var seen = {}, out = [];
    for (i = 0; i < pool.length; i++) {
      v = pool[i];
      if (seen[v.awemeId]) continue; seen[v.awemeId] = 1; out.push(v);
    }
    out.sort(function (x, y) { return (y.publishedAt || 0) - (x.publishedAt || 0); });
    idx.accCache[key] = out;
    return out;
  }

  /* per-account 未读边界：扫描时由抖音 badge 反推写入（见 applyBadgeCursors）。
     返回 -1 表示「还没定过边界」（退化到下面的 ②③ 规则）。 */
  function accCursorOf(a) {
    if (!a) return -1;
    if (a.secUserId && S.accCursor && S.accCursor[a.secUserId] != null) return S.accCursor[a.secUserId];
    return -1;
  }

  /* ★★ 扫描读到抖音「N个作品未看」后，用它反推每个号的未读边界 ★★
     抖音的未读 = 「上次看过之后、最新发布的 N 条」。所以从抓到的视频里取【最新的 N 条】当未读，
     边界就划在那第 N 条的下一条的发布时间之下。这样未读集合和 App 里点开那个号看到的完全一致，
     再也不会混入你早看过的旧视频。 */
  function applyBadgeCursors(side) {
    if (!side) return;
    var secMap = side.secMap || {}, nameMap = side.nameMap || {}, i, a;
    for (i = 0; i < S.accounts.length; i++) {
      a = S.accounts[i];
      if (!a || !a.secUserId) continue;
      var badge = 0;
      if (secMap[a.secUserId]) badge = secMap[a.secUserId];
      else if (a.name) {
        if (nameMap[a.name]) badge = nameMap[a.name];
        else if (nameMap[normName(a.name)]) badge = nameMap[normName(a.name)];
      }
      var vids = accountVideosSorted(a);
      if (badge <= 0) {
        S.accCursor[a.secUserId] = Date.now();        // 抖音说都看完了 → 一条未读都没有
      } else if (vids.length > badge) {
        /* 最新的 badge 条为未读：边界划在第 (badge) 条（0-based 第 badge 个 = 第 badge+1 条）的发布时间，
           这样 publishedAt > 边界 正好是前面最新的 badge 条，第 badge 条（更老的）被排除。 */
        S.accCursor[a.secUserId] = (vids[badge].publishedAt || 0);
      } else {
        S.accCursor[a.secUserId] = -1;                // 抓到比抖音标的还少 → 全部抓到的都算未读（会标 ⁺）
      }
    }
  }

  function unreadVideosOf(sec, acc) {
    var readMap = readIdMap(), out = [], i, v;
    var all = accountVideosSorted(acc || { secUserId: sec });
    var cursor = accCursorOf(acc || { secUserId: sec });
    if (cursor >= 0) {
      /* ① 扫描时已用抖音 badge 定过边界：只把边界之后的（即抖音认为未看的那些）算未读 */
      var want = -1, rec = (acc && acc.secUserId && S.accUnreadN) ? S.accUnreadN[acc.secUserId] : null;
      if (rec && rec.source === 'badge' && rec.n != null && Date.now() - rec.at <= 2 * 3600000) want = rec.n;
      var below = [];
      for (i = 0; i < all.length; i++) {
        v = all[i];
        if ((v.publishedAt || 0) <= cursor) { if (want > 0) below.push(v); continue; }
        if (readMap[v.awemeId]) continue;
        out.push(v);
      }
      /* 官方说 N 条、但边界之上的被「已看记录」误剔掉时（killHist 会把网页已看记录批量写进
         readIds，而那些不一定等于 App 里的已看）→ 用边界之下的补齐，保证列出条数 = N。 */
      if (want > 0 && out.length < want) {
        for (i = 0; i < below.length && out.length < want; i++) {
          if (!readMap[below[i].awemeId]) out.push(below[i]);
        }
        out.sort(function (x, y) { return (y.publishedAt || 0) - (x.publishedAt || 0); });
      }
    } else {
      var srv = douyinBadge(acc);
      if (srv === 0) {
        /* ②a 这一轮抖音明确标了 0 → 一条未读都没有（不能退化成「全部历史视频」） */
      } else if (srv > 0) {
        /* ②b 抖音标了 N 条未看 → 未读 = 最新的 N 条（和 App 里点开那个号看到的一致） */
        for (i = 0; i < all.length; i++) {
          v = all[i];
          if (readMap[v.awemeId]) continue;
          out.push(v);
          if (out.length >= srv) break;
        }
      } else if (S.lastScanAt) {
        /* ③ 没读到抖音标的（侧栏没这个号 / 过期）：只把「这次抓取新抓到的」当未读，绝不算陈年旧视频 */
        for (i = 0; i < all.length; i++) {
          v = all[i];
          if (readMap[v.awemeId]) continue;
          if ((v.publishedAt || 0) <= S.lastScanAt) continue;
          out.push(v);
        }
      } else {
        /* 兜底：从没抓过 / 没有 lastScanAt → 退化成「全部抓到的」（和旧版一致，极少触发） */
        for (i = 0; i < all.length; i++) {
          v = all[i];
          if (readMap[v.awemeId]) continue;
          out.push(v);
        }
      }
    }
    return out;   // accountVideosSorted 已按最新在前排序
  }

  function renderAccVideos() {
    var sec = MGR.acc || '', acc = null, i;
    for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec) { acc = S.accounts[i]; break; }
    /* 不在关注列表里的作者（列表没刷新 / 刚关注）：从抓到的视频里把名字捞出来照常显示 */
    if (!acc && MGR.accName) acc = { secUserId: sec, name: MGR.accName, category: '', _ghost: 1 };
    if (!acc) {
      var vv = buildUnreadView(), gg = null;
      for (i = 0; i < vv.order.length; i++) {
        var g0 = vv.groups[vv.order[i]];
        if (g0.secUid === sec) { gg = g0; break; }
      }
      if (gg) acc = { secUserId: gg.secUid, name: gg.name, category: '', _ghost: 1 };
    }
    var name = acc ? (acc.name || sec) : sec;
    var um = buildUnreadView().map;
    var totalN = accUnread(acc, um);          // 该号的未读（抖音标的为准，没标的退回本机明细）
    var srvN = serverUnread(acc);             // 抖音在关注页标的数量（服务器给的真实未读）
    var vids = unreadVideosOf(sec, acc);
    /* 单独抓这一号时算出来的「按抖音口径的 N 个作品未看」（见 scanOneAccount） */
    var mu = (acc && acc.secUserId && S.accUnreadN) ? (S.accUnreadN[acc.secUserId] || null) : null;
    /* 抖音标了 N 条未看 → 明细只留最新 N 条：更老的那几条是以前攒的旧视频，
       留在列表里会让你以为「未读里混着早看过的」，这也是「跟 App 对不上」的一部分。 */
    if (srvN > 0 && vids.length > srvN) vids = vids.slice(0, srvN);
    var h = '<div class="dyh-back" data-act="manage">← 返回</div>';
    h += '<div class="dyh-card">' +
      '<div class="dyh-row"><b>公众号</b><span>' + esc(name) + (acc && acc._ghost ? ' <em style="font-style:normal;color:#7A6A3F">（非关注·不计未读）</em>' : '') + '</span></div>' +
      (mu && mu.n != null ? '<div class="dyh-row"><b>未读视频（抖音官方）</b><span class="dyh-hl">' + mu.n + ' 条未看</span></div>' : '') +
      '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + totalN + ' 条</span></div>' +
      (srvN ? '<div class="dyh-row"><b>其中抖音标记</b><span>' + srvN + ' 条未看</span></div>' : '') +
      '<div class="dyh-row"><b>本机抓到明细</b><span>' + vids.length + ' 条</span></div>' +
      /* ★ 17:00：把「抖音网页侧栏写的那个数」原样摆出来（不加工、不替换），
         这样你一眼就能拿它和 App 里的数比 —— 如果两边不一样，说明网页和 App 本身就不一致。 */
      (function () {
        var du = S.domUnread || null;
        if (!du || !du.ts || !acc || !acc.secUserId || !du.map || du.map[acc.secUserId] == null) return '';
        var mins = Math.round((Date.now() - du.ts) / 60000);
        return '<div class="dyh-row"><b>抖音网页侧栏写的</b><span>' + du.map[acc.secUserId] +
          ' 条（' + (mins < 1 ? '刚刚' : mins + ' 分钟前') + '读的）</span></div>';
      })() +
      (acc && acc.category ? '<div class="dyh-row"><b>分类</b><span>' + esc(acc.category) + '</span></div>' : '') +
      '</div>';
    /* ★ 18:00：没有可信的官方数字时，如实说明「未读数未知」，绝不拿视频库条数冒充 */
    if (acc && !acc._ghost && accUnreadUnknown(acc)) {
      h += '<div class="dyh-tip" style="color:#b88200">⚠️ <b>这个号的未读数现在还不知道</b>（本机没有它的官方角标、也没有未读边界）。' +
        '所以本页<b>不显示未读数量</b>——以前这里会拿「视频库里存了多少条」当成未读数报出来（那是错的）。' +
        '点下面的「🔄 只重读抖音官方的未读数字」就能读到抖音 App 里那个真实数字。</div>';
    }
    if (srvN > vids.length) {
      h += '<div class="dyh-tip">抖音那边标了 <b>' + srvN + '</b> 条未看，本机抓到了 <b>' + vids.length +
        '</b> 条明细 —— 差的那几条这个号发布时间比较早，关注页滚动时没翻到。' +
        '再抓一轮（在「关注」页多往下滚一会）一般就补齐了。</div>';
    }
    /* 没读到官方数字时的诚实提示（16:28：不再拿本机估算冒充答案） */
    if (mu && mu.n == null) {
      h += '<div class="dyh-tip" style="color:#b88200">⚠️ 这次<b>没读到抖音官方的未读数字</b>（这个号在关注页侧栏里没露出来）。' +
        '下面列的是本机抓到的最近作品，<b>数量仅供参考、可能不准</b>。' +
        '点下面的按钮会先带你去抖音「关注」页读一次官方数字；或回首页跑一轮「📡 抓最新未读视频」。</div>';
    }
    /* ★★ 数字对账（16:05 加）：把「这个未读数字到底是哪来的」摊开写出来。
       以前 App 显示 6、我们显示 16 却看不出原因，就是因为几个来源悄悄互相盖住。 */
    (function () {
      var rows = [];
      if (mu && mu.n != null) rows.push(['抖音官方角标（刚读）', mu.n + ' 条', '★ 就是 App 里那个数']);
      else if (mu) rows.push(['抖音官方角标', '没读到', '这个号在侧栏里没露出来']);
      var ab = acc ? accBadgeOf(acc) : null;
      if (ab && (!mu || mu.n == null)) rows.push(['抖音官方角标（' + fmtTime(ab.at) + '）', ab.n + ' 条', '★ 就是 App 里那个数']);
      if (mu && mu.est != null && mu.source !== 'badge') {
        rows.push(['本机估算（不可靠）', mu.est + ' 条', '网页已看记录算的，App 里看的它不一定知道']);
      }
      var du = S.domUnread || null;
      var duAge = (du && du.ts) ? Math.round((Date.now() - du.ts) / 60000) : null;
      if (du && du.ts) {
        rows.push(['侧栏角标快照（' + duAge + ' 分钟前）', serverUnread(acc) + ' 条', '可能已过期，别当答案']);
      }
      rows.push(['本机抓到该号作品', (mu ? mu.got : vids.length) + ' 条',
        (mu && mu.hasMore) ? '还有更多没抓完' : '已抓到头']);
      if (rows.length < 2) return;
      var bh = '<div class="dyh-card" style="padding:8px 12px;margin:8px 0"><div class="dyh-tip" style="margin:0 0 4px">' +
        '<b>🔍 这个数字是怎么来的（对账）</b></div>';
      for (var i2 = 0; i2 < rows.length; i2++) {
        bh += '<div class="dyh-row" style="font-size:19px"><b>' + rows[i2][0] + '</b><span>' +
          rows[i2][1] + '<br><em style="font-style:normal;opacity:.7">' + rows[i2][2] + '</em></span></div>';
      }
      /* 几个来源不一致时直接点破，别让用户自己猜 */
      var nums = [];
      if (mu && !mu.noBoundary) nums.push(mu.n);
      if (ab) nums.push(ab.n);
      if (du && du.ts) nums.push(serverUnread(acc));
      var mx = Math.max.apply(null, nums.concat([0]));
      var mn = Math.min.apply(null, nums.concat([mx]));
      if (nums.length >= 2 && mx !== mn) {
        bh += '<div class="dyh-tip" style="color:#b88200;margin:4px 0 0">⚠️ 上面的数<b>不一致</b>（' +
          mn + ' ~ ' + mx + '）。<b>取的是最上面那一条</b>（最新、最同源）。' +
          '你在抖音 App 里看到的数如果不在里面，说明它比这些都新——' +
          '回「关注」页点一次「📡 抓最新未读视频」，把角标重读一遍即可。</div>';
      }
      h += bh + '</div>';
    })();
    /* ★ 2026-10-03 15:14 新增 / 15:40 按抖音口径重做：
       抓这一个号的「N个作品未看」数量 + 对应的未读视频清单（只发几次请求，不用跑整轮、不用跳关注页）。 */
    h += '<button class="dyh-btn primary" data-act="acc-scan" data-sec="' + esc(sec) + '" data-name="' + esc(name) + '">' +
      '📡 抓这个号的未读（数量 + 清单）</button>';
    /* ★ 17:00：即使当前就在关注页、也强制重读一次官方数字（清掉旧快照，不再拿旧数糊弄你） */
    h += '<button class="dyh-btn" data-act="acc-badge" data-sec="' + esc(sec) + '" data-name="' + esc(name) + '">' +
      '🔄 只重读抖音官方的未读数字</button>';
    /* ★ 23:30：改了 5 版都对不上 → 先把抖音网页端到底写了什么【原样抄出来】再看。
       点它会输出：网页上出现几次「N个作品未看」、账号行原文、接口里有没有未读字段。 */
    h += '<button class="dyh-btn" data-act="acc-probe" data-sec="' + esc(sec) + '" data-name="' + esc(name) + '">' +
      '🩺 体检：抖音网页上到底写了什么</button>';
    h += '<div class="dyh-tip" style="margin:0 0 10px">只抓<b>这一个号</b>：读它的作品 + 读你的<b>抖音已看记录</b>，' +
      '算出抖音 App 里那个「N个作品未看」的<b>数量</b>，并列出对应的<b>未读视频</b>。' +
      '结果直接写进本机数据，<b>整个面板（未读列表、分类、首页未读总数）都会按它更新</b>。</div>';
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

  /* ================= 单独抓某一个号的未读（2026-10-03 15:14 新增，15:40 按抖音口径重做）=================
     ★ 用户要的是「和抖音 App 里这个号显示的未读**数量**和**未读视频**一致」，不是"把最新作品当未读"。
     抖音的「N个作品未看」口径 = 【这个号的作品里，从最新往回数、你还没看过的那一整段前缀】。
     所以正确做法是：
       ① 抓这个号的作品（多翻几页，留足余量）；
       ② 读抖音侧的「已看记录」（/aweme/v1/web/history/read/，即你在抖音里真正看过哪些），
          再并上本机的已看记录 readIds；
       ③ 从最新往回数，**碰到第一个「看过」的为止**，前面那一段就是未读 → 段的长度 = N（数量），
          段里那几条就是未读视频（列表）。这与抖音 App 点进这个号看到的完全同源。
       ④ 把边界写进 S.accCursor（和 applyBadgeCursors 同一套机制），于是未读视图 / 分类统计 /
          首页未读总数全部按这个 N 重新算 —— 整个软件的数据都跟着更新。
     ⚠ 已看记录只覆盖近 120 天；若这个号的作品全部都比 120 天新且你没在抖音里看过，
       会找不到「已看边界」，此时 N 只能取到抓到的条数（可能偏多），页面会明确提示。 */
  function fetchAccountWorks(secUid, maxPages) {
    var all = [], seen = {}, cursor = '0', page = 0, maxN = maxPages || 5, hasMore = false;
    function step() {
      if (page >= maxN) return Promise.resolve(all);
      page++;
      return dyGet(API_POST, commonParams({ sec_user_id: secUid, count: '20', max_cursor: String(cursor) }), {})
        .then(function (j) {
          var list = (j && j.aweme_list) || [], i, v;
          for (i = 0; i < list.length; i++) {
            v = normAweme(list[i]);
            if (!v || !v.awemeId || seen[v.awemeId]) continue;
            seen[v.awemeId] = 1; all.push(v);
          }
          hasMore = !!(j && j.has_more);
          if (!list.length || !hasMore) return all;
          var nc = j.max_cursor;
          if (nc == null || String(nc) === String(cursor)) return all;
          cursor = String(nc);
          return step();
        });
    }
    return step().then(function (list) {
      list.sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });   // 最新在前
      list.hasMore = hasMore; list.pages = page;      // 附带信息（挂在数组上，供调用方显示）
      return list;
    });
  }

  /* ★ 17:00：只重读这个号的官方未读数字，不抓作品。
     关键动作 = **先把所有旧快照对这个号的记录清掉**（否则刚读到的真数会被旧数盖住，
     或者旧数继续被当成"有效值"显示）。清完再读，读到就是干净的。 */
  function readAccBadgeOnly(sec, name) {
    var acc = null, i;
    for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec) { acc = S.accounts[i]; break; }
    if (!acc && name) acc = { secUserId: sec, name: name, category: '', _ghost: 1 };
    if (!acc || !acc.secUserId) { toast('这个号没有 secUid，读不了'); return Promise.resolve(-1); }
    var who = acc.name || sec;
    if (!onFollowPage()) {
      S.pendingAccBadge = { sec: sec, name: who, at: Date.now() };
      save();
      toast('官方数字只能在抖音「关注」页读到，正在带你去…');
      setTimeout(function () { try { location.href = '/follow'; } catch (e) { location.reload(); } }, 600);
      return Promise.resolve(-1);
    }
    /* ★ 先把这个号相关的旧记录全清掉：全局快照里它的角标 + 它的独立记录 + 上次算出的数 */
    var du = S.domUnread;
    if (du && du.map && du.map[acc.secUserId] != null) { delete du.map[acc.secUserId]; du.ts = 0; }
    if (du && du.byName && acc.name) { delete du.byName[acc.name]; delete du.byName[normName(acc.name)]; }
    delete S.accBadge[acc.secUserId];
    delete S.accUnreadN[acc.secUserId];
    save();

    setBody('<div class="dyh-back" data-act="accv">← 返回</div>' +
      '<div class="dyh-prog" id="dyh-prog">🔎 正在读抖音官方的未读数字…<br>' +
      '<span style="font-size:19px">「' + esc(who) + '」旁边写的「N个作品未看」</span></div>');
    /* ★ 23:30：也换成 readBadgeWait（每滚一次真等 900ms）。
       以前是 350ms × 12 轮 —— 侧栏懒加载一轮网络往返都不止 350ms，等于白滚。
       ★ 同样先【同步读一次】：页面上已经有这个号时立刻就有结果。 */
    var b0 = readBadgeOnce(acc);
    if (b0 >= 0) {
      applyBadge(acc, b0);
      S.accUnreadN[acc.secUserId] = {
        n: b0, at: Date.now(), source: 'badge', noBoundary: false,
        got: (function () { var c = 0, v; for (v = 0; v < S.videos.length; v++) if (S.videos[v].secUid === acc.secUserId) c++; return c; })()
      };
      save();
    }
    return readBadgeWait(acc, 22, 900).then(function (badge) {
      if (badge < 0 && b0 >= 0) badge = b0;
      (function () {
        if (badge >= 0) {
          S.accBadge[acc.secUserId] = { n: badge, at: Date.now() };
          S.accUnreadN[acc.secUserId] = {
            n: badge, at: Date.now(), source: 'badge', noBoundary: false,
            got: (function () { var c = 0, v; for (v = 0; v < S.videos.length; v++) if (S.videos[v].secUid === acc.secUserId) c++; return c; })()
          };
          save();
        }
      })();
      open('accv');
      toast(badge >= 0 ? ('抖音官方写的是：' + badge + ' 条未看') : '还是没读到（点「🩺 体检」看看网页到底有没有这个角标）');
      return badge;
    });
  }

  function scanOneAccount(sec, name) {
    var acc = null, i;
    for (i = 0; i < S.accounts.length; i++) if (S.accounts[i].secUserId === sec) { acc = S.accounts[i]; break; }
    if (!acc && name) acc = { secUserId: sec, name: name, category: '', _ghost: 1 };
    if (!acc || !acc.secUserId) {
      toast('这个号没有 secUid，抓不了（它不在你的关注列表里）');
      return Promise.resolve(0);
    }
    var who = acc.name || sec;
    function prog(t, sub) {
      setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
        '<div class="dyh-prog" id="dyh-prog">' + t + '<br><span style="font-size:19px">' + sub + '</span></div>');
    }
    /* ★★ 16:28 重做：N 的唯一权威 = 抖音自己写在侧栏里的那个「N个作品未看」。
       为什么不再用「已看记录算前缀」（15:40 那版）：实测它算出 0，而 App 里是 6 ——
       【网页端的已看记录 ≠ App 的观看状态】：你在 App 里看过的，网页历史里未必有；
       而网页信息流里自动播放过的反而混进了历史 → 「从最新往回数，碰到看过就停」会立刻停在第 1 条 → N=0。
       所以本机估算只能当参考，不能当答案。 */
    if (!onFollowPage()) {
      /* 官方角标只在「关注」页的侧栏里读得到 → 先把浏览器带过去，落回来自动续跑
         （沿用整轮抓那套机制，用户不用点第二次）。 */
      S.pendingAccScan = { sec: sec, name: who, at: Date.now() };
      save();
      toast('官方未读数字只能在抖音「关注」页读到，正在带你去…');
      setTimeout(function () {
        try { location.href = '/follow'; } catch (e) { location.reload(); }
      }, 600);
      return Promise.resolve(-1);
    }
    /* ① 先把这个号旁边的官方角标读下来（多滚几轮，确保它在侧栏里露出来） */
    prog('🔎 正在读抖音官方的未读数字…', '「' + esc(who) + '」旁边写的「N个作品未看」');
    /* ★ 23:30：改成 readBadgeWait —— 每滚一次【真等】900ms 让网络把下一屏账号送回来。
       以前那份是同步 for 循环：滚一下立刻再读 DOM，网络根本没回来，等于同一帧读了十遍，
       这个号没露出来就永远读不到（「一直读到同一个数 / 一直读不到」就是这么来的）。
       ★ 另外先【同步读一次】：页面上已经有这个号时就不用白等 18 秒。 */
    var badge0 = readBadgeOnce(acc);
    if (badge0 >= 0) applyBadge(acc, badge0);
    return readBadgeWait(acc, 20, 900).then(function (badge) {
    if (badge < 0 && badge0 >= 0) badge = badge0;
    if (badge >= 0) applyBadge(acc, badge);

    /* ② 抓这个号的作品，用来列出「最新 N 条」那些视频 */
    prog('📡 正在抓「' + esc(who) + '」的作品…', '用来列出未读清单');
    var works = [];
    return fetchAccountWorks(acc.secUserId, 5)
      .then(function (list) {
        works = list || [];
        /* ③ 顺便读一下抖音已看记录 —— 只用来算「本机估算」这个参考值，不作为答案 */
        return fetchWatchHistory({}).catch(function () { return { ids: {}, n: 0 }; });
      })
      .then(function (h) {
        h = h || { ids: {}, n: 0 };
        /* 作品并进视频库（已存在的跳过，不重复计数） */
        var known = {}, added = 0, j, v;
        for (j = 0; j < S.videos.length; j++) known[S.videos[j].awemeId] = 1;
        for (j = 0; j < works.length; j++) {
          v = works[j];
          if (known[v.awemeId]) continue;
          if (!v.secUid) v.secUid = acc.secUserId;    // 作品接口偶尔不带 sec_uid / 昵称，补上才能归到这个号
          if (!v.account) v.account = who;
          known[v.awemeId] = 1; S.videos.push(v); added++;
        }
        if (added) S.__vseq++;

        /* 本机估算（仅参考）：从最新往回数，碰到第一个「看过」就停。
           ⚠ 别往 readIdMap() 的共享缓存里塞东西，用局部 seen。 */
        var seen = {}, k;
        for (j = 0; j < S.readIds.length; j++) seen[S.readIds[j]] = 1;
        for (k in h.ids) seen[k] = 1;
        var est = 0;
        while (est < works.length && !seen[works[est].awemeId]) est++;

        /* ★ 未读边界以【官方角标】为准：N 条未读 = 该号最新的 N 条作品 */
        var N = badge;                     // >=0 才是官方数字；-1 表示这次没读到
        if (N === 0) S.accCursor[acc.secUserId] = Date.now();              // 官方说看完了 → 0 未读
        else if (N > 0) S.accCursor[acc.secUserId] = (N < works.length) ? (works[N].publishedAt || 0) : -1;
        else delete S.accCursor[acc.secUserId];   // 没读到官方数字 → 宁可不写，也不拿估算冒充
        S.accUnreadN[acc.secUserId] = {
          n: (N >= 0 ? N : null), at: Date.now(), got: works.length,
          source: (N >= 0 ? 'badge' : 'none'),   // badge = 官方角标（权威）
          est: est,                               // 本机估算，仅供对账参考
          noBoundary: (N < 0),
          pages: works.pages || 0, hasMore: !!works.hasMore
        };

        save();
        open('accv');
        toast(N >= 0
          ? ('「' + who + '」官方未读 ' + N + ' 条' + (added ? '，新增入库 ' + added + ' 条' : ''))
          : ('没读到官方数字（这个号可能在侧栏没露出来），先跑一次整轮抓再试'));
        return N;
      })
      .catch(function (e) {
        setBody('<div class="dyh-back" data-act="accv">← 返回</div>' +
          '<div class="dyh-tip" style="color:#f53f3f">抓取失败：' + esc(e.message) + '</div>' +
          '<div class="dyh-tip">多半是没登录抖音网页版，或刚被风控。回「关注」页跑一轮整轮抓通常更稳。</div>' +
          '<button class="dyh-btn" data-act="accv">← 返回这个号</button>');
        return 0;
      });
    });   /* ← readBadgeWait().then(...) 收口 */
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
    /* ★ 抓法总开关（10-03 02:20）：「关注页收割」是我们不再失败的通道 —— 请求由抖音前端自己发。
       万一哪天它不灵（比如你用桌面 UA 看到的页面结构变了），可以关掉退回纯自签请求的旧路。 */
    var hvOn = S.cfg.harvest !== false;
    h += '<label class="dyh-lb">抓未读的主通道</label><div style="display:flex;gap:8px;margin:6px 0 4px">' +
      '<button class="dyh-btn' + (hvOn ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="harvest-mode" data-mode="on">关注页收割（推荐·不失败）</button>' +
      '<button class="dyh-btn' + (!hvOn ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="harvest-mode" data-mode="off">老办法（自己发请求）</button>' +
      '</div>' +
      '<div class="dyh-tip" style="margin-top:2px"><b>关注页收割</b>：点「抓未读」时会先把你带到抖音<b>「关注」页</b>，' +
      '然后在页面里往下滚 —— 翻页的请求是<b>抖音自己的前端发的</b>（带完整签名和真设备指纹），服务端必然给它 200，' +
      '所以<b>不存在「获取失败」</b>；我们只把它收到的响应抄一份。顺带还会直接读页面上抖音写的「N个作品未看」，那是真实未读数。<br>' +
      '<b>老办法</b>：脚本自己拼参数发请求，现在大概率被抖音风控（403）—— 只在收割不灵时才用。</div>';
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
    /* ★ 23:30：未读数和 App 对不上时，先做这个 —— 把抖音网页端的原始证据抄出来，别再猜 */
    h += '<label class="dyh-lb">🩺 未读数字体检 / 一键读全部</label>';
    h += '<button class="dyh-btn" data-act="read-all-badges">📡 读全部账号的官方未读数（把侧栏滚到底）</button>';
    h += (NET.wide > Date.now())
      ? '<div class="dyh-tip" style="color:#c8920a">🌐 接口扫描进行中…现在去抖音关注页上下滚几屏，60 秒后自动出结果（可以先把面板收起）。</div>'
      : '<button class="dyh-btn" data-act="net-scan">🌐 扫描接口：抖音还有哪些接口带着未读数</button>';
    h += '<button class="dyh-btn" data-act="probe">🩺 体检：抖音网页上到底写了什么</button>';
    h += '<div class="dyh-tip" style="margin-top:2px">未读数和抖音 App 对不上时用：<b>先去抖音「关注」页往下滚几屏</b>（让侧栏加载出一些账号），' +
      '再回来点它。它会把 ①网页上出现<b>几次</b>「N个作品未看」②<b>账号行原文</b>③抖音接口里<b>有没有未读字段</b> ' +
      '原样抄出来，一键复制。<br><b>如果①是 0 次 → 说明抖音网页版根本不显示这个角标</b>（那是 App 独有的），' +
      '网页端就永远读不到这个数，这才是和 App 对不上的根因。</div>';
    h += '<button class="dyh-btn primary" data-act="save-settings">💾 保存</button>';
    /* 皮肤自检：直接把浏览器【实际算出来】的底色打印出来。
       如果这里显示的是白色/透明，说明有别的东西（旧脚本的样式表 / Via 的夜间模式）在压我们 ——
       一眼就能定位，不用再猜「到底改没改上」。 */
    h += '<label class="dyh-lb">🎨 浅黄皮肤自检</label>';
    h += '<div class="dyh-card"><div class="dyh-tip" style="margin:0">' + skinProbe() + '</div></div>';
    h += '<button class="dyh-btn" data-act="reskin">🔧 重刷皮肤（底色被压回白色时点这个）</button>';
    h += '<div class="dyh-tip" style="margin-top:2px">如果自检里写到 <b>rgb(255, 255, 255)</b> 或 <b>rgba(0,0,0,0)</b>：' +
      '① 点一下上面这颗「重刷皮肤」；② 还是白 → 你手机里多半<b>还装着旧版脚本</b>（在 Via 的脚本/书签里把旧的删掉，只留一个）；' +
      '③ 开着 <b>Via 的夜间模式 / 深色网页</b> 会把浅色反掉，先关掉再看。</div>';
    h += '<button class="dyh-btn gray" data-act="clear-job">🧹 清掉抓取断点（下次全部重抓）</button>';
    h += '<button class="dyh-btn" data-act="export">📤 导出数据到手机本地（下载 json）</button>';
    h += '<button class="dyh-btn gray" data-act="clear">🗑 清空本地数据</button>';
    h += '<div class="dyh-tip">已读记录 ' + S.readIds.length + ' 条 · 视频库 ' + S.videos.length + ' 条</div>';
    h += '<div class="dyh-tip">本脚本版本（生成时间 + 本次改动）：<b>' + esc(VER) + '</b><br>' +
      '每次改动版本号都会变，Via 里的脚本不会自动更新 —— 看到这里和最新不一样，就在 Via 里删掉旧脚本重装一次。</div>';
    return h;
  }

  /* ----------------------------- 面板骨架 ----------------------------- */
  /* 米花色（奶油色）配色集中定义（10-03 12:00：用户要求从浅黄改成米花色。
     之前一直"改不成功"的真正根因：Via 的夜间模式 / 网页反色 把整页颜色反转，脚本层设的浅色被翻成深色，
     所以看着像黑的——这不是没生效。配色见下：面板 #F5EFE0 / 卡片·小标签 #ECE2CB / 按钮·输入框 #FBF7EE /
     描边 #D9CCA6 / 分割线 #E5DAC0 / 次要文字 #7A6A3F；正文主色仍是深色，易读）
     ★ BG_PANEL 这个常量下面 CSS 和 inline 两处都要用，改色只改这里 */
  var BG_PANEL = '#F5EFE0';
  var fab = null, panel = null, bodyEl = null, skinEl = null;

  function ensureUI() {
    if (fab) return;
    var st = document.createElement('style');
    st.textContent =
      ':root,html{color-scheme:light!important}' +
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
      '.dyh-zbtn{font-size:30px!important;color:#4e5969;background:#ECE2CB;border-radius:8px;' +
      'padding:4px 14px;margin-left:auto!important}' +
      '#dyh-body{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}' +
      '.dyh-btn{display:block;width:100%;margin:11px 0;padding:19px 20px;border:1px solid #D9CCA6;border-radius:10px;' +
      'background:#FBF7EE;font-size:24px!important;color:#1d2129;text-align:left}' +
      '.dyh-btn.primary{background:#fe2c55;color:#fff;border-color:#fe2c55;font-weight:600}' +
      '.dyh-btn.gray{color:#7A6A3F}' +
      '.dyh-card{background:#ECE2CB;border-radius:10px;padding:15px 17px;margin-bottom:13px}' +
      '.dyh-row{display:flex;align-items:center;padding:16px 0;border-bottom:1px solid #E5DAC0;font-size:24px!important}' +
      '.dyh-row:last-child{border-bottom:0}' +
      '.dyh-row b{font-weight:500;color:#4e5969}' +
      '.dyh-row span,.dyh-row a{margin-left:auto;color:#1d2129;text-decoration:none}' +
      '.dyh-hl{color:#fe2c55!important;font-weight:600}' +
      '.dyh-item{padding:16px 0;border-bottom:1px solid #E5DAC0}' +
      '.dyh-item-t{font-size:24px!important;line-height:1.5;color:#1d2129}' +
      '.dyh-item-m{display:flex;gap:12px;align-items:center;margin-top:9px;font-size:19px;color:#7A6A3F}' +
      '.dyh-item-m a{margin-left:auto;color:#fe2c55;text-decoration:none;padding:9px 17px}' +
      '.dyh-tip{font-size:19px!important;color:#7A6A3F;line-height:1.75;margin:11px 0}' +
      '.dyh-back{font-size:20px;color:#fe2c55;margin-bottom:13px}' +
      /* ---- 分类下拉选择器 ---- */
      '.dyh-sel{display:flex;align-items:center;gap:8px;background:#ECE2CB;border:1px solid #D9CCA6;' +
      'border-radius:10px;padding:14px 16px;margin:6px 0 10px}' +
      '.dyh-sel b{font-size:25px;font-weight:600;color:#1d2129}' +
      '.dyh-sel .dyh-caret{font-size:20px;color:#7A6A3F}' +
      '.dyh-sel em{margin-left:auto;font-size:18px;font-style:normal;color:#7A6A3F;white-space:nowrap}' +
      '.dyh-sel em b{color:#fe2c55;font-weight:700}' +
      '.dyh-drop{background:#FBF7EE;border:1px solid #D9CCA6;border-radius:10px;padding:6px 8px;margin:0 0 10px}' +
      '.dyh-drop-i{display:flex;align-items:center;gap:10px;padding:13px 10px;border-bottom:1px solid #E5DAC0;font-size:23px}' +
      '.dyh-drop-i.on{background:#E3D4AC;border-radius:8px;font-weight:600}' +
      '.dyh-drop-i em{margin-left:auto;font-size:17px;font-style:normal;color:#7A6A3F;white-space:nowrap}' +
      '.dyh-drop-a{display:flex;gap:8px;flex-wrap:wrap;padding:10px 6px 6px;border-top:1px solid #E5DAC0}' +
      /* ---- 公众号行：名称 / 未读数 / 设分类 / 取关 四个并排 ---- */
      '.dyh-acc2{display:flex;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #E5DAC0}' +
      '.dyh-nm{flex:1 1 auto;min-width:0;font-size:23px;color:#1d2129;line-height:1.35;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dyh-urn2{flex:0 0 auto;font-size:18px;font-weight:700;color:#fe2c55;white-space:nowrap}' +
      '.dyh-urn2.ok{color:#b3a66a;font-weight:400}' +
      '.dyh-acc2 .dyh-mini{flex:0 0 auto;padding:7px 10px;font-size:17px}' +
      /* ---- 某个公众号的未读视频列表 ---- */
      '.dyh-vid{padding:14px 0;border-bottom:1px solid #E5DAC0}' +
      '.dyh-vid-t{font-size:23px;line-height:1.5;color:#1d2129;word-break:break-all}' +
      '.dyh-vid-m{display:flex;align-items:center;gap:10px;margin-top:9px;font-size:19px;color:#7A6A3F}' +
      '.dyh-vid-m span:first-child{margin-right:auto}' +
      '.dyh-mini.go{background:#fe2c55;border-color:#fe2c55;color:#fff;font-weight:600}' +
      /* ---- 老的分类行 / 账号行（保留样式，防止旧页面残留） ---- */
      '.dyh-cat{display:flex;align-items:center;gap:10px;padding:14px 6px;border-bottom:1px solid #E5DAC0}' +
      '.dyh-cat.sel{background:#E3D4AC;border-radius:8px;margin:2px -6px;padding-left:12px;padding-right:6px}' +
      '.dyh-cat-l{display:flex;align-items:baseline;gap:9px;min-width:0}' +
      '.dyh-cat-l b{font-size:23px;font-weight:600}' +
      '.dyh-cat-l span{font-size:17px;color:#7A6A3F}' +
      '.dyh-cat-r{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}' +
      '.dyh-mini{display:inline-block;padding:8px 13px;border:1px solid #D9CCA6;border-radius:8px;background:#ECE2CB;' +
      'color:#4e5969;font-size:17px;text-decoration:none;white-space:nowrap}' +
      '.dyh-mini.dg{background:#fff0f1;border-color:#ffd9dc;color:#fe2c55}' +
      '.dyh-mini.on{background:#fe2c55;border-color:#fe2c55;color:#fff;font-weight:600}' +
      '.dyh-acc{padding:13px 0;border-bottom:1px solid #E5DAC0}' +
      '.dyh-acc-t{font-size:23px;color:#1d2129;line-height:1.45;word-break:break-all}' +
      '.dyh-urn{color:#fe2c55;font-weight:700;font-size:18px;margin-left:9px}' +
      '.dyh-urn.ok{color:#b3a66a;font-weight:400;margin-left:9px}' +
      '.dyh-acc-m{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}' +
      '.dyh-input{width:100%;box-sizing:border-box;padding:15px 16px;border:1px solid #D9CCA6;border-radius:8px;' +
      'background:#FBF7EE;font-size:20px;margin:4px 0 13px}' +
      '.dyh-lb{font-size:18px;color:#7A6A3F;display:block;margin-top:11px}' +
      '.dyh-prog{background:#ECE2CB;border-radius:8px;padding:16px 18px;margin:12px 0;font-size:19px;line-height:1.75}' +
      /* ---- 抓取进度条 ---- */
      '.dyh-pwrap{background:#FBF7EE;border:1px solid #D9CCA6;border-radius:12px;padding:16px 18px;margin:12px 0}' +
      '.dyh-ptop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}' +
      '.dyh-pnum{font-size:36px;font-weight:700;color:#fe2c55;line-height:1.1}' +
      '.dyh-pnum small{font-size:20px;font-weight:600}' +
      '.dyh-pcnt{font-size:19px;color:#4e5969;margin-left:auto}' +
      '.dyh-pbar{position:relative;height:22px;background:#E3D4AC;border-radius:11px;overflow:hidden;margin:12px 0 10px}' +
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
    /* ★ 皮肤样式表打标记 + 每次打开面板都把它重新塞到 <head> 的最后面：
       万一你手机里还装着【旧版脚本】（旧版那张样式表是白底 + !important），
       同优先级下「后出现的赢」—— 把我们的挪到最后，旧版就压不动我们了（10-03 01:25）。 */
    st.setAttribute('data-dyh-skin', '1');
    document.head.appendChild(st);
    skinEl = st;

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
    applySkin(box);
  }

  /* ★★ 浅黄皮肤三保险（10-03 01:25，专门治「改了还是白的」）
     ① inline 用 setProperty(..., 'important') —— inline + !important 是最高优先级，
        连旧版脚本那张「白底 + !important」的样式表都压不过它（上一版只写了 inline 没加 important，
        碰上旧的 !important 白底就会被顶回去，这就是上一版在你手机上没生效的真凶）；
     ② 把我们的皮肤样式表重新 append 到 <head> 最后面（同优先级下后出现的赢）；
     ③ 内容区保持透明，底色全部由面板这一层决定。 */
  function applySkin(box) {
    if (!box) { if (panel) box = panel.querySelector('.dyh-box'); }
    if (!box) return;
    try {
      box.style.setProperty('background', BG_PANEL, 'important');
      box.style.setProperty('background-color', BG_PANEL, 'important');
      box.style.setProperty('background-image', 'none', 'important');
    } catch (e) {
      box.style.background = BG_PANEL;            // 老浏览器兜底
      box.style.backgroundColor = BG_PANEL;
    }
    if (panel) {
      var bd = panel.querySelector('#dyh-body');
      if (bd) { bd.style.background = 'transparent'; bd.style.backgroundColor = 'transparent'; }
    }
    if (skinEl && skinEl.parentNode && skinEl.parentNode.lastChild !== skinEl) {
      try { skinEl.parentNode.appendChild(skinEl); } catch (e2) { }   // 挪到最后：谁最后谁说话
    }
  }
  /* 检测是不是被 Via 夜间模式 / 系统深色 / 网页反色 把整页颜色反转了
     （脚本层设的浅色会被它翻成深色，这就解释了"为什么一直改不成功"） */
  function detectNightMode() {
    try {
      var de = document.documentElement, b = document.body;
      var dcs = (window.getComputedStyle ? getComputedStyle(de) : de.style) || de.style;
      var bcs = (window.getComputedStyle ? getComputedStyle(b) : b.style) || b.style;
      var df = dcs.filter || '', bf = bcs.filter || '';
      if (/invert|brightness\s*\(\s*0|hue-rotate/.test(df + ' ' + bf))
        return { on: true, why: '页面被加了 filter 反色 / 压暗滤镜（Via 夜间模式常见做法）' };
      var sheets = document.styleSheets || [];
      for (var s = 0; s < sheets.length; s++) {
        var rules; try { rules = sheets[s].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var rl = rules[r], sel = (rl.selectorText || '').toLowerCase();
          if (sel === 'html' || sel === ':root' || sel === 'body' || sel.indexOf('html') >= 0) {
            var txt = (rl.cssText || '').toLowerCase();
            if (/filter\s*:\s*[^;]*(invert|hue-rotate|brightness\s*\(\s*0)|background[^:]*:\s*(#000|#000000|rgb\(0,\s*0,\s*0\))/.test(txt))
              return { on: true, why: '检测到页面样式表把底色设成纯黑 / 加了反色滤镜' };
          }
        }
      }
    } catch (e) { }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        return { on: true, why: '系统 / 浏览器正处于「深色模式」偏好（Via 可能据此反色）' };
    } catch (e) { }
    return { on: false, why: '' };
  }
  /* 皮肤自检：把浏览器【实际算出来的】底色报出来，一眼就能看出到底有没有生效 */
  function skinProbe() {
    if (!panel) return '（面板还没打开）';
    var box = panel.querySelector('.dyh-box');
    if (!box) return '（找不到面板）';
    var cs = (window.getComputedStyle ? window.getComputedStyle(box) : null);
    var real = cs ? (cs.backgroundColor || cs.background || '') : '';
    var inline = box.style.backgroundColor || box.style.background || '';
    var nm = detectNightMode();
    var tip = nm.on
      ? '<br>⚠️ <b style="color:#f53f3f">检测到「' + esc(nm.why) + '」</b>：这会把我们设的米花色整页翻成深色，' +
        '所以你看到的是黑的。<b>这不是脚本没生效</b>，是被反转了。请到 <b>Via 设置 → 显示 / 夜间模式</b> 里关掉' +
        '「夜间模式 / 暗黑模式 / 网页反色」，刷新页面重开助手即可看到米花色。'
      : '';
    return '浏览器实际底色：<b>' + esc(real || '空') + '</b><br>内联写入值：<b>' + esc(inline || '空') + '</b>' +
      '<br>我们设的期望值：<b>' + BG_PANEL + '</b>（米花色 rgb(245, 239, 224)）' + tip;
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

  /* 取关功能已于 2026-10-03 取消（用户要求）：单个取关、整类取关、批量取关逻辑全部移除。
     需要取关请在抖音 App 里操作（关注 → 批量管理）。关注功能 setFollow 保留。 */

  function onAction(act, el) {
    var i;
    if (act === 'home') { open('home'); return; }
    if (act === 'manage') { open('manage'); return; }
    if (act === 'search') { open('search'); return; }
    if (act === 'settings') { open('settings'); return; }

    if (act === 'open') { var u = el.getAttribute('data-url'); if (u) window.open(u, '_blank'); return; }

    if (act === 'read') {
      var id = el.getAttribute('data-id');
      S.readIds.push(id); S.__rseq++; save();
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
        '· <b>先在「关注」页收割</b>（①阶段，10-03 新增）：页面往下滚，翻页的请求是<b>抖音自己的前端发的</b>（带完整签名和真设备指纹），服务端必然给它 200 —— <b>所以这一步不会失败</b>；我们只把它收到的响应抄一份，同时直接读页面上抖音写的「N个作品未看」；<br>' +
        '· 收割没覆盖到的才走<b>关注页信息流</b>（②阶段）：一次拿 20 条、按时间倒序，翻到上次抓到的时间就追平 —— <b>2~5 次请求</b>核对完几百个账号；<br>' +
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
        gid('dyh-pnow').textContent =
          (s.phase === 'harvest' ? '① 关注页收割（抖音自己在取数据）'
            : s.phase === 'side' ? '① 读抖音标的真实未读数'
              : (s.phase === 'feed' ? '② ' : '③ ')) +
          (s.phase === 'harvest' || s.phase === 'side' ? '' : (s.name ? ('当前：' + s.name) : ''));
        var w = gid('dyh-pwarn');
        if (s.histErr && !s.hist) { w.style.display = ''; w.textContent = '⚠ 没读到抖音的已看记录（' + s.histErr + '），这一轮只扣掉了本机标记过的；下次抓取会自动重试'; }
        else if (s.risk) { w.style.display = ''; w.textContent = '⚠ 抖音限流中，已自动降速重试（不会算失败）'; }
        else if (s.cool) { w.style.display = ''; w.textContent = '⏳ 正在降速冷却，稍等一下就好'; }
        else if (s.phase === 'harvest') { w.style.display = ''; w.textContent = '① 关注页收割：在抖音「关注」页往下滚，翻页请求由抖音前端自己发（不会失败），我们只抄它的响应'; }
        else if (s.phase === 'side') { w.style.display = ''; w.textContent = '① 读抖音「我的关注」列表里每个号标了「几个作品未看」—— 这就是你在 App 里看到的那个数（不读它，未读就会跟 App 对不上）'; }
        else if (s.phase === 'feed') { w.style.display = ''; w.textContent = '② 关注页信息流：按时间倒序翻，翻到上次抓取的位置就追平（请求极少，不易被限流）'; }
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
          (r.risk ? '<div class="dyh-row"><b>风控命中</b><span>' + r.risk + ' 次</span></div>' : '') +
          (r.harvest ? '<div class="dyh-row"><b>① 关注页收割</b><span>抄到 ' + r.harvest.pages + ' 页 · ' + r.harvest.got +
            ' 条新视频（' + Math.round(r.harvest.ms / 1000) + ' 秒，0 次失败）</span></div>' : '') +
          (r.domUnread && r.domUnread.rows ? '<div class="dyh-row"><b>抖音标记「未看」</b><span>' + r.domUnread.rows +
            ' 个账号里有 ' + Object.keys(r.domUnread.map || {}).length + ' 个带未看</span></div>' : '');
        if (r.left) h += '<div class="dyh-row"><b>还剩没抓到</b><span>' + r.left + ' 个（已记入断点）</span></div>';
        /* ★ 抓完直接对一次账（10-03 03:10）：本机抓到的明细条数 vs 抖音自己标的数量，
           以前结果页只说「新增 N 条」，进去查看页又是另一套统计，看着就像没按抓取结果显示。 */
        /* ★ 对账：未读总数【以抖音自己的数为准】（跟 App 一致），
           本机明细单列一行 —— 以前拿「本机抓到几条」当总数，
           所以你一进 App 就看出来「完全不一样」（旧视频都算进去了）。 */
        var tu = totalUnread();
        h += '<div class="dyh-row"><b>现在全部未读</b><span class="dyh-hl">' + tu.n + ' 条 / ' + tu.acc + ' 个号</span></div>';
        h += '<div class="dyh-row"><b>其中：抖音标记未看</b><span>' +
          (r.side && r.side.accN
            ? (r.side.accN + ' 个号（侧栏读到 ' + r.side.rows + ' 个）')
            : '没读到（抓一轮会读）') + '</span></div>';
        h += '<div class="dyh-row"><b>本机抓到明细</b><span>' + unreadVideos().length + ' 条</span></div>';
        h += '</div>';
        h += '<button class="dyh-btn" data-act="recon">📊 和抖音里的数对一下账</button>';
        if (r.names && r.names.length) {
          h += '<div class="dyh-tip">这次没抓成的（下次会自动补）：' + esc(r.names.join('、')) +
            (r.names.length >= 20 ? ' 等' : '') + '</div>';
        }
        /* 「第二次」最常见的样子：信息流几下就追平、新增 0 条 —— 这是【正常】，不是坏了。
           不写清楚这句，就会有人以为第二次抓不动了（就是你说的「第一次可以、第二次不行」）。 */
        if (!r.newCount && r.feedCaught) {
          h += '<div class="dyh-tip">✅ 本轮用 <b>' + r.feedPages + '</b> 次请求就核对完 <b>' + r.feedCaught + '</b> 个账号：' +
            '你关注的人在这段时间确实没发新视频（只要发，不用逐个问，这几下请求里就直接收进来了）。' +
            '想按账号看谁的未读最多，点下面的「📺 去看未读视频」，每个号后面都标了未读条数。</div>';
        }
        /* 一个都没抓到：明确告诉用户原因，别让他对着「新增未读 0」干瞪眼 */
        if (!r.okCount && !r.feedCaught) {
          h += '<div class="dyh-tip" style="color:#f53f3f">⚠ 这轮<b>一个账号都没抓到</b>（抖音多半是没认登录 / 直接拒了请求）。' +
            '先点「📥 刷新我的关注列表」重新读一次登录态，然后再抓一轮就好。</div>';
        }
        h += '<button class="dyh-btn primary" data-act="manage">📺 去看未读视频（按账号排列）</button>' +
          '<button class="dyh-btn gray" data-act="push">☁️ 推到 GitHub</button>' +
          '<button class="dyh-btn gray" data-act="scan">🔁 再抓一轮（自动补剩下的）</button>';
        if (r.left) h += '<div class="dyh-tip">还有 ' + r.left + ' 个没抓到，点上面「再抓一轮」即可从断点补完，不会重复请求。</div>';
        setBody(h);
      });
      return;
    }

    if (act === 'stop-scan') { stopScan(); return; }
    if (act === 'clear-job') { S.scanJob = null; save(); toast('断点已清除，下次会全部重抓'); open('home'); return; }
    if (act === 'recon') { setBody(renderRecon()); return; }
    if (act === 'recon-refresh') {
      /* 回到抖音「关注」页重新读一遍抖音自己标的数：
         把浏览器带过去 + 记上自动续跑，页面重载后脚本会自己接着抓（就是那套 autoScan 机制），
         抓完自动回到结果页，再点「对账」就能看到最新的两边数字。 */
      try {
        var st2 = JSON.parse(localStorage.getItem(LS) || '{}');
        st2.autoScan = { ts: Date.now() };
        localStorage.setItem(LS, JSON.stringify(st2));
      } catch (e) { }
      toast('已回到抖音「关注」页，加载完脚本会自动接着抓一轮。', 6000);
      setTimeout(function () { location.href = 'https://www.douyin.com/follow'; }, 600);
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

    /* 重刷米黄皮肤：把样式表挪到 head 末尾 + 用 inline !important 重写底色 */
    if (act === 'reskin') {
      ensureUI();
      applySkin(panel ? panel.querySelector('.dyh-box') : null);
      toast('皮肤已重刷：' + (window.getComputedStyle && panel ?
        (window.getComputedStyle(panel.querySelector('.dyh-box')).backgroundColor || '') : ''));
      open('settings'); return;
    }

    /* ---------- 看某个公众号的未读视频 ---------- */
    if (act === 'acc-videos') {
      MGR.acc = el.getAttribute('data-sec') || '';
      MGR.accName = el.getAttribute('data-name') || '';   // 虚拟账号（不在关注列表里）靠它显示名字
      if (!MGR.cat) MGR.cat = ALL_CAT;
      open('accv'); return;
    }
    /* ★ 单独抓这一个号的未读视频（只 1 次请求）；抓完整个软件的数据都会更新 */
    if (act === 'acc-scan') {
      scanOneAccount(el.getAttribute('data-sec') || '', el.getAttribute('data-name') || '');
      return;
    }
    /* ★ 17:00：只重读官方数字（先清掉旧快照再读一次），不抓作品 */
    if (act === 'acc-badge') {
      readAccBadgeOnly(el.getAttribute('data-sec') || '', el.getAttribute('data-name') || '');
      return;
    }
    /* ★ 23:30 体检：不改任何数据，只把抖音网页端现在显示的东西原样抄出来 */
    if (act === 'acc-probe' || act === 'probe') {
      var ps = el.getAttribute('data-sec') || '', pn = el.getAttribute('data-name') || '';
      var pr = sideProbe(ps, pn);
      pr._sec = ps; pr._name = pn;
      renderProbe(pr);
      return;
    }
    if (act === 'probe-copy') { copyProbeText(); return; }
    if (act === 'net-scan') { startNetScan(); return; }
    /* ★ 23:55：一次把全部账号的官方未读数读下来（把侧栏滚到底） */
    if (act === 'read-all-badges') { readAllBadges(); return; }
    if (act === 'play') {
      var pid = el.getAttribute('data-id');
      openInApp(pid);          // 只唤起抖音 App；网页端不跳转、不开新标签
      if (pid && S.readIds.indexOf(pid) < 0) { S.readIds.push(pid); S.__rseq++; save(); }
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
      if (rid && S.readIds.indexOf(rid) < 0) { S.readIds.push(rid); S.__rseq++; save(); }
      toast('已标记已看'); open('accv'); return;
    }

    /* ---------- 管理分类 ---------- */
    if (act === 'cat-pull') { pullCats('cover'); return; }
    if (act === 'cat-merge') { pullCats('merge'); return; }

    /* 点当前分类那一行 → 展开/收起分类下拉 */
    if (act === 'mgr-drop') { MGR.drop = !MGR.drop; MGR.adding = false; MGR.editing = ''; open('manage'); return; }

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

    if (act === 'harvest-mode') {
      var hm2 = el.getAttribute('data-mode');
      S.cfg.harvest = (hm2 === 'on');
      save(); toast(S.cfg.harvest ? '已切到「关注页收割」（推荐，不会失败）' : '已切回老办法（自己发请求，可能被风控）');
      open('settings'); return;
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
      S.accounts = []; S.videos = []; S.readIds = []; S.__vseq++; S.__rseq++; save(); toast('已清空'); open('home');
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
      S.readIds.push(id); S.__rseq++; save();
      toast('已标记为已看，未读里会少这一条');
      return true;
    } catch (e) { return false; }
  }

  /* ----------------------------- 启动 ----------------------------- */
  function boot() {
    if (!/www\.douyin\.com/.test(location.host)) return;
    try { installNetHook(); } catch (e) { }   // 兜底：万一 document-start 没生效，这里再装一次
    autoMarkCurrentRead();
    /* 如果这是一个被脚本打开的「取关/关注」用标签页，先让它自动点完按钮再挂面板 */
    try { autoFollowWorker(); } catch (e) { console.warn('[抖音关注助手] 自动点击异常：', e); }
    ensureUI();
    /* ★ 被「去关注页」带过来之后自动接着抓（10-03 02:20）：
       上一页点了「抓未读」→ 脚本把浏览器带到 /follow，页面重载后在这里自动继续，
       用户不用再点第二次。超过 5 分钟就当作过期，不自动跑（免得莫名其妙自己开抓）。 */
    try {
      if (S.autoScan && Date.now() - S.autoScan.ts < 300000 && onFollowPage()) {
        S.autoScan = null; save();
        setTimeout(function () {
          try {
            open('home');
            var b = document.querySelector('[data-act="scan"]');
            if (b) b.click();
          } catch (e) { }
        }, 1200);
      } else if (S.autoScan) { S.autoScan = null; save(); }
    } catch (e) { }
    /* ★ 16:28：单号「查官方未读」被带到 /follow 之后，在这里自动续跑（读侧栏角标 + 列清单）。
       超过 3 分钟就当过期，不自动跑。 */
    try {
      if (S.pendingAccScan && Date.now() - S.pendingAccScan.at < 180000) {
        var pa = S.pendingAccScan; S.pendingAccScan = null; save();
        if (onFollowPage()) {
          setTimeout(function () {
            try {
              MGR.acc = pa.sec; MGR.accName = pa.name;
              if (!MGR.cat) MGR.cat = ALL_CAT;
              open('accv');
              scanOneAccount(pa.sec, pa.name);
            } catch (e) { }
          }, 1500);
        }
      } else if (S.pendingAccScan) { S.pendingAccScan = null; save(); }
    } catch (e) { }
    /* ★ 17:00：单号「只重读官方数字」被带到 /follow 之后自动续跑 */
    try {
      if (S.pendingAccBadge && Date.now() - S.pendingAccBadge.at < 180000) {
        var pb = S.pendingAccBadge; S.pendingAccBadge = null; save();
        if (onFollowPage()) {
          setTimeout(function () {
            try {
              MGR.acc = pb.sec; MGR.accName = pb.name;
              if (!MGR.cat) MGR.cat = ALL_CAT;
              open('accv');
              readAccBadgeOnly(pb.sec, pb.name);
            } catch (e) { }
          }, 1500);
        }
      } else if (S.pendingAccBadge) { S.pendingAccBadge = null; save(); }
    } catch (e) { }
    /* ★ 23:55：「读全部账号的官方未读数」被带到 /follow 之后自动续跑 */
    try {
      if (S.pendingAllBadge && Date.now() - S.pendingAllBadge.at < 180000) {
        S.pendingAllBadge = null; save();
        if (onFollowPage()) setTimeout(function () { try { readAllBadges(); } catch (e) { } }, 1500);
      } else if (S.pendingAllBadge) { S.pendingAllBadge = null; save(); }
    } catch (e) { }
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
    accountVideosSorted: accountVideosSorted,
    accCursorOf: accCursorOf,
    applyBadgeCursors: applyBadgeCursors,
    openInApp: openInApp,
    unreadByAccount: unreadByAccount,
    buildUnreadView: buildUnreadView,
    accUnread: accUnread,
    localUnread: localUnread,
    serverUnread: serverUnread,
    totalUnread: totalUnread,
    reconUnread: reconUnread,
    renderRecon: renderRecon,
    ghostAuthors: ghostAuthors,
    listIsFresh: listIsFresh,
    accUnreadUnknown: accUnreadUnknown,
    accBadgeOf: accBadgeOf,
    accFreshN: accFreshN,
    pruneToAccounts: pruneToAccounts,
    scanOneAccount: scanOneAccount,
    readAccBadgeOnly: readAccBadgeOnly,
    fetchAccountWorks: fetchAccountWorks,
    catMembers: catMembers,
    catUnread: catUnread,
    normName: normName,
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
    net: function () { return NET; },
    netKind: netKind,
    netTake: netTake,
    netCount: netCount,
    installNetHook: installNetHook,
    onFollowPage: onFollowPage,
    scrollDown: scrollDown,
    readFollowUnreadDom: readFollowUnreadDom,
    readBadgeOnce: readBadgeOnce,
    readBadgeWait: readBadgeWait,
    applyBadge: applyBadge,
    readAllBadges: readAllBadges,
    harvestFollowSidebar: harvestFollowSidebar,
    scrollFollowSidebar: scrollFollowSidebar,
    findScrollable: findScrollable,
    sideProbe: sideProbe,
    netProbe: netProbe,
    probeText: probeText,
    netCleanUrl: netCleanUrl,
    netWideRecord: netWideRecord,
    startNetScan: startNetScan,
    harvestFollowPage: harvestFollowPage,
    push: function () { return ghPush('unread.json', JSON.stringify(buildPayload()), '手机端更新 ' + fmtTime(Date.now())); },
    openPanel: function () { open('home'); }
  };
})();
