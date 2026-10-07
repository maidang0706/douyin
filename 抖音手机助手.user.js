// ==UserScript==
// @name         抖音关注助手（手机免电脑版）
// @namespace    dy-phone-helper
// @version      2026-10-07 04:35 · 未读核验实证：v2准确(与红点92%一致)+user_not_see恒0已弃用；整页超时重试/红点100%补号，绝不因一页卡死整轮崩
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
  /* 关注列表未看字段（接口权威源）：只要响应体里出现这个串，就一定是关注列表接口。
     用它做【兜底分类】，避免抖音换了 host / 路径前缀 / 加了版本号导致 netKind 漏抓。 */
  var FOLLOW_BODY_RE = /not_seen_item_id_list/;
  function netKind(url) {
    if (!url) return '';
    if (url.indexOf('/aweme/v1/web/follow/') >= 0) return 'feed';
    if (url.indexOf('/aweme/v1/web/aweme/post/') >= 0) return 'post';
    /* ★ 10-06 修：放宽匹配 —— 只要路径里出现 following/list 或 user/following 都算关注列表，
       不再死磕 /aweme/v1/web/user/following/ 这个精确前缀（抖音换域名/加参数就抓不到） */
    if (url.indexOf('following/list') >= 0 || url.indexOf('user/following') >= 0) return 'following';
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
                /* ★ 10-06 修：netKind 没认出来，但响应体里带关注列表未看字段 → 也抓。
                   这是「从抖音接口读未读数」读不到的头号原因：抖音换了接口路径/域名，
                   netKind 失配，响应被整条丢掉，于是永远读到 0 个号。 */
                else if (t && FOLLOW_BODY_RE.test(t)) netPush('following', url, t);
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
                    /* ★ 10-06 修：同 fetch 分支 —— 响应体带未看字段也抓，避免路径失配漏抓 */
                    else if (self.responseText && FOLLOW_BODY_RE.test(self.responseText)) netPush('following', self.__dyUrl, self.responseText);
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
  var VER = '2026-10-07 04:35 · 未读核验实证：v2准确(与红点92%一致)+user_not_see恒0已弃用；整页超时重试/红点100%补号，绝不因一页卡死整轮崩';
  var VER_SHORT = '10-07 04:35';

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
      accCursor: {},     // {secUserId: 发布时间边界ms}：>边界的视频才算未读（由接口 not_seen_item_id_list_v2 反推，见 applyApiUnreadAll）
      scanJob: null,     // 断点：{sig, startIdx, cursor, ts}，中断/被杀后下次从这里续
      __vseq: 0,         // 视频库版本号（S.videos 变动时 +1）：视频索引按它复用缓存，避免每次重扫全部视频
      __rseq: 0,         // 已看记录版本号（S.readIds 变动时 +1）：readMap 按它复用缓存
      listAt: 0,         // 关注列表最后刷新的时间：刷新后未读视图以这份列表为准（见 listIsFresh / pruneToAccounts）
      /* ★ 22:50：抖音关注列表接口 /aweme/v1/web/user/following/list/ 响应里，
         每个账号自带 not_seen_item_id_list_v2 —— 页面上的「N个作品未看」就是它的长度。
         格式 {secUserId: {n, ids:[awemeId], nickname, at}}。
         ★ 这是最可信的一档：不受界面规则影响（直播号也有），还能给出【具体是哪几条】。 */
      apiUnread: {},
      apiUnreadAt: 0
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

  /* ★ 10-07 统一未读：直接走「关注列表接口」把每个号的官方未看一次性读全
     旧 readApiUnread 依赖「在关注页滚动、钩子抓响应」，关注列表一长（619 个）就滚不到底、
     缓冲被清、经常读 0 或漏一半。但「刷关注列表」用的就是同一个 following/list 接口、从没失败过 ——
     这里直接复用它的分页循环，把每个号的 not_seen_item_id_list_v2（= 抖音 App 里「N个作品未看」
     对应的【具体未看视频 id 清单】）全部取回来。覆盖度 = 100%（翻到底为止），数量 = 清单长度，
     且给出具体 id，后面反查视频也靠它。 */
  function fetchFollowingUnread(opts) {
    opts = opts || {};
    var maxPages = opts.maxPages || 200;
    return getSelfSecUid().then(function (self) {
      var map = {}, total = 0, pages = 0, offset = 0, maxTime = 0, pageErr = null;
      function fetchOne() {
        return dyGet(API_FOLLOWING, commonParams({
          user_id: '', sec_user_id: self, offset: String(offset),
          min_time: '0', max_time: String(maxTime), count: '20',
          source_type: '4', gps_access: '0', address_book_access: '0', is_top: '1'
        }), opts.signal ? { signal: opts.signal } : {});
      }
      /* ★ 10-07 韧性：单页超时/失败重试 2 次；仍失败则跳过该页继续翻，
         绝不因「某一页卡死」就把整轮读未读搞崩（真实环境 following/list 偶发 8s 超时）。 */
      function onePage() {
        if (pages >= maxPages) return Promise.resolve();
        var attempt = 0;
        function tryOnce() {
          return fetchOne().then(function (j) { return j; }, function (e) {
            attempt++;
            if (attempt < 2) return sleep(500).then(tryOnce);
            return { __err: String((e && e.message) || e) };
          });
        }
        return tryOnce().then(function (j) {
          pages++;
          if (j && j.__err) { pageErr = '第' + pages + '页读取失败已跳过: ' + j.__err; offset += 20; return; }
          if (!j || (!j.followings && !j.has_more)) { pageErr = '第' + pages + '页响应异常已跳过'; offset += 20; return; }
          var list = j.followings || [];
          for (var i = 0; i < list.length; i++) {
            var u = list[i] || {};
            var sec = u.sec_uid || u.secUid;
            if (!sec) continue;
            total++;
            var ids = pullUnreadIds(u);
            var n, src;
            if (ids) { n = ids.length; src = 'ids'; }
            else {
              /* ★ 10-07 全量实测（未读核验.js，389/389 号）：
                 v2 出现数 == 有未看账号数（132==132）→ 字段是「出现=有未看(长度=条数) / 缺失=无未看(0)」的
                 完整编码，覆盖 100%，并非部分覆盖。
                 同时 user_not_see 出现 389/389 但【恒为 0】，是死字段，绝不能当未读数（旧逻辑用它→永远显示 0）。
                 故 v2 缺失时直接记 0，并标 src='needDom'：万一红点 DOM 显示 N>0，
                 reconcileWithBadges 会用更鲜红的红点数覆盖它（红点是抖音同源地面真相）。 */
              n = 0; src = 'needDom';
            }
            if (!(n >= 0)) continue;
            /* 多页里同一号重复出现 → 以【最后一份】为准（和 collectFollowingUnread 一致） */
            map[sec] = { n: n, ids: ids || [], nickname: (u.nickname || u.nickName || ''), at: Date.now(), src: src };
          }
          offset += list.length;
          if (j.max_time) maxTime = j.max_time;
          if (opts.onPage) { try { opts.onPage({ pages: pages, got: Object.keys(map).length, total: total }); } catch (e) { } }
          if (!j.has_more || list.length === 0) return;
          return sleep(700).then(onePage);
        });
      }
      return onePage().then(function () {
        /* ★ 安全网：若一页都没读成功（系统性失败：未登录/接口被封），reject 触发 harvest 兜底；
           仅个别页超时则上面的跳过逻辑已处理，正常返回部分数据。 */
        if (total === 0 && pageErr) return Promise.reject(new Error('following/list 全部页读取失败：' + pageErr));
        return { map: map, total: total, pages: pages, pageErr: pageErr };
      });
    });
  }

  /* ★ 10-07：把「抖音官方未看 id 清单」里的视频，反查成本地可展示的视频对象。
     只认抖音给的未看 id —— 所以展示里每一条视频，都确确实实是抖音标了「未看」的那条，
     不会把早看过的旧视频混进来，也不会漏掉真未读。
     来源优先级：① 本机 S.videos 里已有 → 直接复用（0 请求）；
                 ② 没抓到 → 抓这个号的作品，按 id 命中入库（只存命中未看的，不存已看的）。 */
  function fetchUnreadVideoDetails(opts) {
    opts = opts || {};
    var stop = opts.shouldStop || function () { return false; };
    var known = {};
    for (var i = 0; i < S.videos.length; i++) if (S.videos[i] && S.videos[i].awemeId) known[S.videos[i].awemeId] = S.videos[i];
    var ap = S.apiUnread || {};
    var queue = [];
    for (var k in ap) {
      if (!Object.prototype.hasOwnProperty.call(ap, k)) continue;
      if (k === '__byName') continue;
      var rec = ap[k];
      if (!rec || !rec.ids || !rec.ids.length) continue;
      var idset = {}, x, missing = 0;
      for (x = 0; x < rec.ids.length; x++) { idset[String(rec.ids[x])] = 1; if (!known[String(rec.ids[x])]) missing++; }
      if (!missing) continue;     // 清单里的视频本机全有，不用再抓
      queue.push({ sec: k, name: rec.nickname || '', idset: idset });
    }
    if (!queue.length) return Promise.resolve({ added: 0, accounts: 0 });
    var conc = Math.min(3, Math.max(1, queue.length)), cursor = 0, active = 0, done = 0, added = 0;
    var aborted = false;
    return new Promise(function (resolve) {
      function finish() { if (added) { S.__vseq++; save(); } resolve({ added: added, accounts: queue.length }); }
      function tick() {
        if (aborted) return;
        while (active < conc && cursor < queue.length) {
          var q = queue[cursor++]; active++;
          (function (q) {
            if (stop()) { active--; done++; if (done >= queue.length) finish(); return; }
            fetchAccountWorks(q.sec, 3).then(function (list) {
              var l = list || [], j, v;
              for (j = 0; j < l.length; j++) {
                v = l[j];
                if (!v || !v.awemeId) continue;
                if (q.idset[String(v.awemeId)] && !known[v.awemeId]) {
                  if (!v.secUid) v.secUid = q.sec;
                  if (!v.account) v.account = q.name;
                  S.videos.push(v); known[v.awemeId] = v; added++;
                }
              }
              active--; done++;
              if (stop()) { aborted = true; finish(); return; }
              if (done >= queue.length) finish(); else tick();
            }).catch(function () { active--; done++; if (done >= queue.length) finish(); else tick(); });
          })(q);
        }
        if (active === 0 && done >= queue.length) finish();
      }
      tick();
    });
  }

  /* ★ 10-07 统一同步：先用 following 接口把全量官方未读读全（可靠、覆盖 100%），
     落盘（数量+清单+边界）后再把「清单里的视频」反查成本地可展示对象。
     直接接口失败时才退回「关注页滚动收割」兜底，绝不退化成「读不到/读不全」。 */
  function syncUnreadAuthoritative(statusCb) {
    function verifyAndFinish(r, fromHarvest) {
      /* ★ 10-07 核验：与「关注页红点」地面真相对账（仅在 /follow 页时有效） */
      return readFollowBadgesDom().then(function (dom) {
        var verify = reconcileWithBadges(dom);
        return fetchUnreadVideoDetails({ shouldStop: function () { return false; } }).then(function (d) {
          return { map: r.map, total: r.total, details: d, verify: verify, fromHarvest: !!fromHarvest };
        });
      });
    }
    function viaApi() {
      return fetchFollowingUnread({ onPage: statusCb ? function (p) {
        statusCb({ phase: 'side', got: p.got, pages: p.pages, total: p.total });
      } : null }).then(function (r) {
        applyApiUnreadAll(r.map);
        return r;
      });
    }
    return viaApi().then(function (r) {
      return verifyAndFinish(r, false);
    }).catch(function (e) {
      /* 接口失败（未登录 / 接口变更 / 风控）→ 退回在关注页滚动收割（0 自签请求）兜底 */
      if (onFollowPage()) {
        return harvestApiUnread({ maxRounds: 300, wait: 800, total: S.accounts.length })
          .then(function (acc) {
            var m = (collectFollowingUnread().map) || {};
            applyApiUnreadAll(m);
            return verifyAndFinish({ map: m, total: S.accounts.length }, true);
          });
      }
      throw e;   // 既没接口又没在关注页 → 如实报错，让上层提示去登录/去关注页
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
  /* 派发 wheel 事件：很多抖音版本左侧账号列表是「虚拟滚动 + 监听 wheel 翻页」，
     scrollTop 改了也不翻页。补发 wheel 逼它去请求下一批 /following/list/。 */
  function dispatchWheel(el) {
    try {
      if (window.WheelEvent) {
        el.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, deltaY: 700, deltaMode: 0 }));
      } else {
        var ev = document.createEvent('WheelEvent');
        ev.initEvent('wheel', true, true);
        el.dispatchEvent(ev);
      }
    } catch (e) { }
  }

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
        sc.scrollTop = before + step;                  // ★ 滚一屏
        /* ★ 10-06 修：虚拟滚动列表有时要吃「事件」才肯加载下一批，光改 scrollTop 不够 */
        try { sc.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { }
        try { if (typeof sc.scrollBy === 'function') sc.scrollBy(0, step); } catch (e) { }
        if (sc.scrollTop > before + 1) moved = true;
        else if (before > 0) { sc.scrollTop = 0; try { sc.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { } }  // 真到底：回顶再走一轮
      }
      /* 补发 wheel：对「只认手势、不认 scrollTop 改写」的列表有效 */
      if (hit) dispatchWheel(hit);
      if (sc) dispatchWheel(sc);
      if (!moved) {
        var se = document.scrollingElement || document.documentElement;
        if (se) {
          var step2 = Math.max(Math.floor((se.clientHeight || 600) * 0.85), 300);
          var b2 = se.scrollTop;
          try { se.scrollBy(0, step2); } catch (e) { window.scrollBy(0, step2); }
          if (se.scrollTop > b2 + 1) moved = true;
          else if (b2 > 0) window.scrollTo(0, 0);
        }
        if (hit) dispatchWheel(hit);
      }
    } catch (e) { }
    return moved;
  }

  
  /* ===================================================================
     ★★★ 22:50 · 你说的没错 —— 网页能显示，背后一定有接口。
     我把抖音 PC 网页端自己的前端代码扒出来看了（ies/douyin_web/async/1463.js）：

       let { sec_uid, uid, nickname, remark_name, avatar_uri, signature,
             follow_status, room_data, room_id,
             not_seen_item_id_list_v2: b, not_seen_item_id_list: E,
             live_status, aweme_count, user_not_see, is_not_show,
             account_cert_info, ... } = 关注列表里的一个用户对象;
       return { secUid, nickname, ..., notSeenItemList: (b ?? E) ?? [], ... }

     页面上那个「N个作品未看」就是 notSeenItemList.length（>99 显示 99，见 notSeenTag 那段）。
     也就是说：【关注列表接口 /aweme/v1/web/user/following/list/ 的响应里，
     每个账号自带「我没看过的作品 id 列表」】—— N 是它的长度，里面就是具体哪几条。
     这比读页面上的角标强得多：
       ① 不受界面规则限制 —— 直播号也有这个字段（页面上不显示而已）；
       ② 拿到的不只是数量，还有【具体是哪几条视频】；
       ③ 不用等每一行渲染出来，抖音自己翻页我们收响应就行。
     =================================================================== */
  /* 抖音在不同接口 / 不同版本里，未看作品 id 列表的字段名会变：
     · not_seen_item_id_list_v2（关注列表接口，最常出现）
     · not_seen_item_id_list（旧版 v1）
     · notSeenItemList / notSeenItemIdList（bundle 里映射后的驼峰名）
     全部收进来，哪个能拿到用哪个，避免因为字段改名就整批读成 0。 */
  var UNREAD_ID_KEYS = ['not_seen_item_id_list_v2', 'not_seen_item_id_list',
    'notSeenItemList', 'notSeenItemIdList'];

  /* 接口读来的未读数有效期：超过就当没读过，绝不让昨天的数压着今天显示（17:25 的教训）。 */
  var API_UNREAD_VALID_MS = 12 * 3600000;

  function pullUnreadIds(u) {
    var i;
    for (i = 0; i < UNREAD_ID_KEYS.length; i++) {
      var v = u[UNREAD_ID_KEYS[i]];
      if (Object.prototype.toString.call(v) === '[object Array]') return v;
    }
    return null;
  }

  /* 在响应 JSON 里找「元素是含 sec_uid 的对象」的那个数组
     （不写死叫 user_list，抖音改 key 也能找到） */
  function findUserArray(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      for (var i = 0; i < node.length; i++) {
        if (node[i] && typeof node[i] === 'object' && (node[i].sec_uid || node[i].secUid)) return node;
      }
      /* ★ 10-06 修：账号对象可能被包一层对象（{user:{sec_uid}} / {data:{sec_uid}}）。
         解出来看看；若解包后是账号，就返回这层数组，交给 collectFollowingUnread 去解包。 */
      for (var i3 = 0; i3 < node.length; i3++) {
        var e0 = node[i3];
        if (e0 && typeof e0 === 'object') {
          var eu = (e0.user && (e0.user.sec_uid || e0.user.secUid)) ? e0.user
            : (e0.data && (e0.data.sec_uid || e0.data.secUid)) ? e0.data : null;
          if (eu) return node;
        }
      }
      /* 也可能是多包了一层数组：递归找更深的账号数组 */
      for (var i2 = 0; i2 < node.length; i2++) {
        if (node[i2] && typeof node[i2] === 'object') {
          var nested = findUserArray(node[i2], depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = findUserArray(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  /* 把已经捕获到的所有 following 响应解析成 { secUid: {n, ids, nickname, src} } */
  function collectFollowingUnread() {
    var out = { map: {}, byName: {}, n: 0, users: 0, seen: 0 };
    try {
      var i, j;
      for (i = 0; i < NET.buf.length; i++) {
        var it = NET.buf[i];
        if (it.kind !== 'following') continue;
        var arr = findUserArray(it.json, 0);
        if (!arr) continue;
        for (j = 0; j < arr.length; j++) {
          var u = arr[j] || {};
          /* ★ 10-06 修：账号对象可能被包一层（{user:{sec_uid}} / {data:{...}}），先解出来 */
          if (!u.sec_uid && !u.secUid) {
            if (u.user && (u.user.sec_uid || u.user.secUid)) u = u.user;
            else if (u.data && (u.data.sec_uid || u.data.secUid)) u = u.data;
          }
          var sec = u.sec_uid || u.secUid;
          if (!sec) continue;
          out.seen++;                                  // ★ 覆盖度统计：扫到过的【账号总数】（不论有无未看）
          out.users++;
          var nm = u.nickname || u.nickName || '';
          var ids = pullUnreadIds(u);
          /* 优先用【未看作品 id 列表】的长度；没有列表才退用抖音给的计数 user_not_see */
          var n = -1, src = '';
          if (ids) { n = ids.length; src = 'ids'; }
          else if (u.user_not_see != null) { n = parseInt(u.user_not_see, 10); src = 'count'; }
          if (!(n >= 0)) continue;                            // 两者都没有 = 这个号不知道
          /* ★ 10-06 修正：以【最后一份响应】为准 —— NET.buf 是按到达顺序存的，后到的更新。
             旧写法「取历史最大值」有个致命后果：你刷掉几条之后再读，数字只会虚高、绝不回落，
             清单里还一直留着早就看过的视频。改成覆盖后又有的优雅性质：
             同一账号在多页重复出现时值相同，取最后一份不影响结果。 */
          out.map[sec] = { n: n, ids: ids || [], nickname: nm, src: src };
          if (nm) out.byName[nm] = n;
        }
      }
      out.n = Object.keys(out.map).length;
    } catch (e) { }
    return out;
  }

  /* 让抖音自己去翻关注列表（滚侧栏触发它发请求），我们一路收响应里的未读 id 列表。
     ★ 注意：我们【一个请求都不自己发】（自签必 403），全程只听抖音前端自己的响应。 */
  /* ===================================================================
     ★★★ 00:15 · 直接读【抖音网页端存放这份数据的地方】—— React 内存状态 ★★★

     你问得对：不该去"看页面上写了什么字"。那份数据抖音自己一定【存着】。
     我扒了它的 bundle，里面出现 __REACT_DEVTOOLS_GLOBAL_HOOK__ / react-dom
     → 抖音 PC 网页端就是 React。那么接口回来的整份账号数据，会被塞进
       组件 props / useState 的 hook 链（fiber.memoizedProps / memoizedState），
     页面上那行「N个作品未看」只是这份数据【渲染出来的一个字】。

     所以直接从 fiber 树里把对象取出来，绕开所有渲染层：
       ① 直播号页面上不写角标 → 内存里照样有（不受界面规则限制）；
       ② 虚拟滚动已经回收掉的行 → 只要抖音没丢弃，内存里还在；
       ③ 不用等它渲染成文字，也不用猜文案格式/标签名；
       ④ 拿到的不是「一个数字」，是那条 not_seen_item_id_list（具体哪几条）。
     =================================================================== */
  var FIBER_MAX = 80000;        /* 最多扫多少个 fiber 节点（防卡死） */
  var FIBER_OBJ_MAX = 150000;   /* 最多扫多少个内部对象 */
  var FIBER_DEPTH = 8;          /* 对象递归深度 */
  var FIBER_SKIP_KEYS = {
    alternate: 1, return: 1, stateNode: 1, _owner: 1, _store: 1,
    parentElement: 1, parentNode: 1, ownerDocument: 1, nextSibling: 1, previousSibling: 1
  };

  /* React 会把 fiber 挂在 DOM 元素上：__reactFiber$<随机> / __reactContainer$<随机> */
  function fiberOf(el) {
    if (!el || typeof el !== 'object') return null;
    try {
      var ks = Object.keys(el), i;
      for (i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0 ||
          k.indexOf('__reactContainer$') === 0) {
          if (el[k] && typeof el[k] === 'object') return el[k];
        }
      }
    } catch (e) { }
    return null;
  }
  function fiberRootOf(el) {
    var f = fiberOf(el);
    if (!f) return null;
    var g = 0;
    while (f && f.return && g++ < 800) f = f.return;
    return f || null;
  }

  /* 从一个账号对象里取「未看作品」—— 认抖音自己的字段名（snake_case 原始 + camelCase 已映射） */
  function userUnreadFromObj(o) {
    if (!o || typeof o !== 'object') return null;
    var sec = o.sec_uid || o.secUid || o.sec_user_id;
    if (!sec || typeof sec !== 'string' || sec.length < 4) return null;
    var ids = null, src = '', i;
    var KEYS = ['not_seen_item_id_list_v2', 'not_seen_item_id_list', 'not_seen_item_id_list_v1',
      'notSeenItemList', 'notSeenItemIdList'];
    for (i = 0; i < KEYS.length; i++) {
      var v = o[KEYS[i]];
      if (Object.prototype.toString.call(v) === '[object Array]') { ids = v; src = KEYS[i]; break; }
    }
    var n = ids ? ids.length : -1;
    if (n < 0) {
      var c = (o.user_not_see != null) ? o.user_not_see : ((o.userNotSee != null) ? o.userNotSee : null);
      if (c != null) { var ci = parseInt(c, 10); if (!isNaN(ci)) { n = ci; src = 'user_not_see'; } }
    }
    if (n < 0) return null;
    var out = [];
    if (ids) { for (i = 0; i < ids.length; i++) out.push(String(ids[i])); }
    return {
      sec: String(sec), nickname: String(o.nickname || o.remark_name || o.remarkName || ''),
      ids: out, n: n, src: src
    };
  }

  /* 在一个任意对象里递归找「含未读数据的账号对象」 */
  function deepFindUsers(v, depth, out, stats) {
    if (!v || typeof v !== 'object') return;
    if (depth > FIBER_DEPTH) return;
    if (stats.n > FIBER_OBJ_MAX) return;
    stats.n++;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      var lim = Math.min(v.length, 3000), i;
      for (i = 0; i < lim; i++) {
        var u = v[i];
        if (!u || typeof u !== 'object') continue;
        var r = userUnreadFromObj(u);
        if (r) { out.push(r); continue; }
        deepFindUsers(u, depth + 1, out, stats);
      }
      return;
    }
    var r0 = userUnreadFromObj(v);
    if (r0) { out.push(r0); return; }
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (FIBER_SKIP_KEYS[k]) continue;
      var vv;
      try { vv = v[k]; } catch (e) { continue; }
      if (vv && typeof vv === 'object') deepFindUsers(vv, depth + 1, out, stats);
    }
  }

  /* 一个 fiber 节点上可能挂数据的地方：props + hooks 链 */
  function scanFiberNode(f, out, stats) {
    if (!f || typeof f !== 'object') return;
    var paths = ['memoizedProps', 'pendingProps', 'memoizedState'], i;
    for (i = 0; i < paths.length; i++) {
      try {
        var v = f[paths[i]];
        if (v && typeof v === 'object') deepFindUsers(v, 0, out, stats);
      } catch (e) { }
    }
    /* useState 的 hook 链：{ memoizedState, next } 一路 next */
    try {
      var h = f.memoizedState, g = 0;
      while (h && typeof h === 'object' && g++ < 300) {
        if (h.memoizedState && typeof h.memoizedState === 'object') deepFindUsers(h.memoizedState, 0, out, stats);
        h = h.next;
        if (stats.n > FIBER_OBJ_MAX) break;
      }
    } catch (e) { }
  }

  /* 从根扫整棵 fiber 树（能捞到已经滚出屏幕、DOM 里回收掉的数据） */
  function walkFiberTree(root, out, stats) {
    if (!root) return 0;
    var stack = [root], n = 0;
    while (stack.length) {
      var f = stack.pop();
      if (!f || typeof f !== 'object') continue;
      if (++n > FIBER_MAX) break;
      stats.fibers++;
      scanFiberNode(f, out, stats);
      if (stats.n > FIBER_OBJ_MAX) break;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return n;
  }

  function mergeUnreadMap(acc, got) {
    if (!got) return acc;
    var k;
    if (got.users > acc.users) acc.users = got.users;
    for (k in got.map) {
      if (!Object.prototype.hasOwnProperty.call(got.map, k)) continue;
      var nv = got.map[k], ov = acc.map[k];
      if (!ov || nv.n > ov.n || (nv.n === ov.n && (nv.ids || []).length > (ov.ids || []).length)) acc.map[k] = nv;
    }
    for (k in got.byName) {
      if (!Object.prototype.hasOwnProperty.call(got.byName, k)) continue;
      if (acc.byName[k] == null || got.byName[k] > acc.byName[k]) acc.byName[k] = got.byName[k];
    }
    acc.got = Object.keys(acc.map).length;
    return acc;
  }

  /* ★ 从 React 内存里读所有账号的未读数据（quick=只走"每一行往上反查"的快路径） */
  function collectFiberUnread(opts) {
    opts = opts || {};
    var out = [], stats = { n: 0, fibers: 0 }, i;
    try {
      var as = document.querySelectorAll('a[href*="/user/"]');
      var lim = Math.min(as.length, 500);
      /* —— 快路径：每个作者链接往上反查 16 层，把它那一行的 props 翻出来 —— */
      for (i = 0; i < lim; i++) {
        var f = fiberOf(as[i]);
        if (!f) continue;
        var g = f, d = 0;
        while (g && d < 16 && stats.n < FIBER_OBJ_MAX) {
          stats.fibers++;
          scanFiberNode(g, out, stats);
          g = g.return; d++;
        }
      }
      /* —— 全量路径：从 React 根扫整棵树（虚拟滚动回收掉的也在这儿） —— */
      if (!opts.quick) {
        var roots = [], seen = [];
        var step = Math.max(1, Math.floor(lim / 6));
        for (i = 0; i < lim; i += step) {
          var r0 = fiberRootOf(as[i]);
          if (r0 && seen.indexOf(r0) < 0) { seen.push(r0); roots.push(r0); }
        }
        if (!roots.length) {
          var c = null;
          try { c = document.getElementById('root') || document.getElementById('app') || (document.body && document.body.firstElementChild); } catch (e) { }
          var r1 = fiberRootOf(c);
          if (r1) roots.push(r1);
        }
        for (i = 0; i < roots.length && stats.n < FIBER_OBJ_MAX; i++) walkFiberTree(roots[i], out, stats);
      }
    } catch (e) { }

    var map = {}, byName = {};
    for (i = 0; i < out.length; i++) {
      var it = out[i];
      if (!it || !it.sec) continue;
      var ov = map[it.sec];
      if (!ov || it.n > ov.n || (it.n === ov.n && it.ids.length > ov.ids.length)) map[it.sec] = it;
      if (it.nickname) {
        var nb = normName(it.nickname);
        if (byName[nb] == null || it.n > byName[nb]) byName[nb] = it.n;
      }
    }
    return {
      map: map, byName: byName, users: Object.keys(map).length,
      fibers: stats.fibers, objs: stats.n, found: out.length,
      srcs: uniqSrcs(out)
    };
  }
  function uniqSrcs(list) {
    var m = {}, a = [], i;
    for (i = 0; i < list.length; i++) if (list[i] && list[i].src) m[list[i].src] = (m[list[i].src] || 0) + 1;
    for (var k in m) a.push(k + '×' + m[k]);
    return a;
  }

  function harvestApiUnread(opts) {
    opts = opts || {};
    var acc = { map: {}, byName: {}, got: 0, users: 0, seen: 0, rounds: 0 };
    var lastSeen = -1, stable = 0, round = 0, maxRounds = opts.maxRounds || 400;
    function merge(got) {
      if (!got) return;
      var k;
      /* ★ 10-06 修正：以最新一份为准（collectFollowingUnread 已是「后来的覆盖先来的」），
         不再取历史最大值 —— 否则看完的号永远回落不了。 */
      for (k in got.map) {
        if (!Object.prototype.hasOwnProperty.call(got.map, k)) continue;
        acc.map[k] = got.map[k];
      }
      for (k in got.byName) {
        if (!Object.prototype.hasOwnProperty.call(got.byName, k)) continue;
        acc.byName[k] = got.byName[k];
      }
      if (got.users > acc.users) acc.users = got.users;
      if (got.seen > acc.seen) acc.seen = got.seen;   // ★ 覆盖度：扫到过多少个账号
      acc.got = Object.keys(acc.map).length;
    }
    function tick() {
      if (opts.shouldStop && opts.shouldStop()) return Promise.resolve(acc);
      if (round >= maxRounds) return Promise.resolve(acc);
      round++;
      acc.rounds = round;
      merge(collectFollowingUnread());
      if (opts.onTick) {
        try {
          opts.onTick({ round: round, got: acc.got, users: acc.users, seen: acc.seen });
        } catch (e) { }
      }
      /* ★★ 覆盖度判定（2026-10-06 修正「对不上」的核心）：
         以前只在「连续 8 轮没新增账号」就收工 —— 但 619 个号的关注列表要滚很多屏才能扫完，
         前面几屏没扫到的号根本没被读到，它们的未读数就退回本机估算、和抖音对不上。
         现在改为：扫到的账号数（seen）已经覆盖到【关注总数 92% 以上】才收工；
         否则即使暂时没新增（虚拟滚动偶发卡顿），也继续滚，直到把列表扫完。
         最多连续 idle 40 轮（约半分钟）还没进展才认栽，避免卡死不动。 */
      /* 单号扫描（没传 total）时不做覆盖度判定，否则 target 退化为 acc.seen、
         covered 恒为 1，会第一圈就返回、滚不到目标号 —— 退回 idle 40 轮 / maxRounds 收工。 */
      if (opts.total) {
        var covered = acc.seen / opts.total;
        if (covered >= 0.92) return Promise.resolve(acc);
      }
      /* 单号扫描专用：一旦在缓冲里找到目标号，立即收工（不用等整列扫完） */
      if (opts.untilSec && acc.map[opts.untilSec]) return Promise.resolve(acc);
      if (acc.seen === lastSeen) { stable++; } else { stable = 0; }
      lastSeen = acc.seen;
      if (stable >= 40) return Promise.resolve(acc);
      scrollFollowSidebar();
      return sleep(opts.wait || 800).then(tick);
    }
    return tick();
  }

  /* 某个号的视频（最新在前），直接走索引，避免每条都调 accountVideosSorted 的缓存路径 */
  function secVideosSorted(sec) {
    if (!sec) return [];
    var arr = buildVideoIndex().bySec[sec];
    if (!arr) return [];
    return arr.slice().sort(function (x, y) { return (y.publishedAt || 0) - (x.publishedAt || 0); });
  }

  /* ★★★ 把接口读到的结果【落到每一个账号上】——数量 + 未读视频清单 + 边界，三样一起 ★★★
     以前读完只把 {n, ids} 塞进 S.apiUnread 当缓存，清单还按本机边界猜 →
     「数字对上了，点进去看到的还是老视频」。现在读完就把这三件事做掉：

       ① 数量：抖音接口给的 N（accUnread 里最优先，含明确 0）；
       ② 清单：用接口给的【未看作品 id 列表】反过来决定哪些视频算未读
          —— 被本机误记成"已看"的，一律改回未读（抖音说没看就是没看，本机那套不算数）；
       ③ 边界：把 accCursor 划到「抖音说已看的最后一条」上，
          这样即使接口数据过期了，本机兜底算出来的也不会跑偏。

     返回 { known, sumN, haveN, missN, revived } */
  function applyApiUnreadAll(map, opts) {
    opts = opts || {};
    var st = { known: 0, sumN: 0, haveN: 0, missN: 0, revived: 0, kept: 0, staleDropped: 0 };
    /* ★ 10-06 重大修正：本轮【没读到】的号，必须保留它上一次的权威数据。
       旧写法第一行就是 S.apiUnread = { __byName: {} } —— 整体重建。于是只要这一轮
       没滚到某个号（harvestApiUnread 覆盖度没到 92% 就提前收工 / 单号扫描只带回来 1 个号），
       那个号的权威未读数就被抹掉，悄悄退回本机估算。
       表现就是：明明读过，过一会儿再看数字又变了、而且变小或变乱。 */
    if (!map) map = {};
    if (!S.apiUnread || typeof S.apiUnread !== 'object') S.apiUnread = {};
    if (!S.apiUnread.__byName || typeof S.apiUnread.__byName !== 'object') S.apiUnread.__byName = {};

    /* 超过 12 小时的旧记录先清掉 —— 保留归保留，但不能让它赖着冒充今天的数 */
    var _now0 = Date.now(), _k0;
    for (_k0 in S.apiUnread) {
      if (!Object.prototype.hasOwnProperty.call(S.apiUnread, _k0)) continue;
      if (_k0 === '__byName') continue;
      var _oe = S.apiUnread[_k0];
      if (_oe && _oe.at && _now0 - _oe.at > API_UNREAD_VALID_MS) {
        delete S.apiUnread[_k0]; st.staleDropped++;
      }
    }

    var k, i, allIds = {}, secids = {}, order = [];

    /* ---- 第一遍：落盘 + 收集本轮所有「未看视频 id」 ---- */
    for (k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var it = map[k] || {};
      var n = it.n, ids0 = it.ids || [], nm = it.nickname || '';
      if (!(n >= 0)) continue;                       // 抖音没给数 = 这个号不知道，跳过
      st.known++; st.sumN += n;
      var rec = { n: n, ids: ids0, nickname: nm, at: Date.now() };
      S.apiUnread[k] = rec;
      order.push(k);
      secids[k] = ids0;
      for (i = 0; i < ids0.length; i++) allIds[String(ids0[i])] = 1;
    }
    /* 数一数「本轮没读到、但上次的数还在」的号，同时重建 __byName 索引
       （旧索引条目可能还指着刚被过期清掉的 rec，必须重挂一遍） */
    S.apiUnread.__byName = {};
    for (k in S.apiUnread) {
      if (!Object.prototype.hasOwnProperty.call(S.apiUnread, k)) continue;
      if (k === '__byName') continue;
      if (order.indexOf(k) < 0) st.kept++;
      var _e0 = S.apiUnread[k];
      if (_e0 && _e0.nickname) S.apiUnread.__byName[normName(_e0.nickname)] = _e0;
    }
    S.apiUnreadAt = Date.now();

    /* ---- ② 本机记成"已看"但抖音说没看的 → 撤回已看标记 ----
       网页自动播放 / 旧版本误标都会把还看过的视频塞进 readIds，结果它就不出现在未读里了。
       权威只有一个：抖音给的未看 id 列表。 */
    var before = S.readIds.length;
    if (before) {
      var kept = [];
      for (i = 0; i < S.readIds.length; i++) {
        if (allIds[String(S.readIds[i])]) { st.revived++; continue; }
        kept.push(S.readIds[i]);
      }
      if (st.revived) { S.readIds = kept; S.__rseq = (S.__rseq || 0) + 1; }
    }

    /* ---- ②③ 每个号：划边界 + 数一数本机到底有几条明细 ---- */
    for (i = 0; i < order.length; i++) {
      k = order[i];
      var ids = secids[k] || [], vids = secVideosSorted(k);
      if (!vids.length) { st.missN += S.apiUnread[k].n; continue; }
      if (!ids.length) {
        /* 接口只给了个数（user_not_see 那种）→ 本机前 n 条算未读 */
        var take = Math.min(S.apiUnread[k].n, vids.length);
        st.haveN += take; st.missN += Math.max(0, S.apiUnread[k].n - take);
        if (take > 0) S.accCursor[k] = (vids[take - 1].publishedAt || 0) - 1;
        else S.accCursor[k] = (vids[0].publishedAt || 0);
        continue;
      }
      var set = {}, j;
      for (j = 0; j < ids.length; j++) set[String(ids[j])] = 1;
      var hit = 0, boundary = -1;
      for (j = 0; j < vids.length; j++) {
        /* 从最新往回走：还在未看名单里就继续，第一条【不在】名单的就是「已看的最后一条」 */
        if (!set[String(vids[j].awemeId)]) { boundary = vids[j].publishedAt || 0; break; }
        hit++;
      }
      st.haveN += hit;
      st.missN += Math.max(0, S.apiUnread[k].n - hit);
      if (hit === vids.length) {
        /* 本机有的全在未看名单里 → 边界压到最后一条之下，缺的那几条还没抓到 */
        var oldest = vids[vids.length - 1].publishedAt || 0;
        S.accCursor[k] = oldest > 0 ? oldest - 1 : 0;
      } else {
        S.accCursor[k] = boundary;
      }
    }
    save();
    return st;
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

  
  
  
  /* ★ 开一次「接口全扫描」：这段时间里抖音发出的每一个 /aweme/ 接口都记下来。
     目的只有一个 —— 查清除了页面上那个角标，抖音还有没有【别的地方】也下发未读数。 */
  var NETSCAN_MS = 60000;



  
  
  
  /* ★★ 23:55 新增：一次性把左侧「我的关注」列表滚到底，把抖音写的未读数【全部】读下来落盘。
     为什么要批量：388 个关注里，单号去读往往要滚很多次才轮到它；批量滚一遍，
     所有有未读的号一次全拿到（而且这个数就是网页端写出来的、与 App 同源）。
     ⚠ 直播中的号网页端不写角标（真机截图已证实），这类号读不到 —— 会如实算「未知」，不会报成 0。 */
  /* ★ 10-04：改成逐屏滚动后，一轮 = 一屏，轮数要够（几百个号 / 每屏十来个）；
     等待可以短一些（滚一屏后渲染很快，不再是等一整页网络）。 */
  var SIDE_HARVEST_WAIT = 800;
  /* ★★ 22:50：直接从【抖音关注列表接口】读每个号「几个作品未看」+ 具体是哪几条。
     做法：让抖音自己去翻关注列表（滚侧栏触发它发请求），我们一路收它自己的响应，
     解析里面的 not_seen_item_id_list_v2。全程一个自签请求都不发（自签必 403）。 */
  /* ★ 10-07 核验 + 兜底：直接读抖音「关注」页左侧「N个作品未看」红点 —— 这就是你在 App/网页
     关注列表里看到的未读数，是与抖音同源的【地面真相】。用它来交叉验证「直接调 following 接口」
     读到的数，并在接口读不到/读错时以红点为准。
     ⚠️ 不擅自跳页打扰：只在用户本就停留在 /follow 页时才读；不在就返回 null（由结果页提示去关注页再点）。
     返回 { map:{ secUid 或 "n:昵称" → N }, total, liTotal, ok }。 */
  function readFollowBadgesDom() {
    if (location.pathname !== '/follow') return Promise.resolve(null);
    function extract() {
      try {
        var lis = [].slice.call(document.querySelectorAll('li'));
        var map = {}, any = false, liTotal = 0, hit = null, i;
        if (!lis.length && !(document.body && document.body.innerText)) return { map: {}, any: false, total: -1, liTotal: 0 };
        for (i = 0; i < lis.length; i++) {
          if (/个作品未看/.test(lis[i].innerText || '')) { hit = lis[i]; break; }
        }
        if (hit && hit.parentElement) liTotal = hit.parentElement.children.length;
        /* 找左侧可滚动容器（抖音更新过结构，用「出现红点标记的 li」往上找第一个可滚祖先） */
        var sc = null, el = hit;
        for (i = 0; i < 8 && el; i++) {
          var cs = getComputedStyle(el);
          if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) { sc = el; break; }
          el = el.parentElement;
        }
        for (i = 0; i < lis.length; i++) {
          var tt = lis[i].innerText || '';
          var m2 = tt.match(/(\d+)个作品未看/);
          if (!m2) continue;
          any = true;
          var n = parseInt(m2[1], 10);
          var a = lis[i].querySelector('a[href*="/user/"]');
          var sec = '';
          if (a) { var h = a.getAttribute('href') || ''; var sm = h.match(/\/user\/([^/?#]+)/); if (sm) sec = sm[1]; }
          var name = tt.replace(/认证徽章|直播中|\d+个作品未看/g, ' ').replace(/\s+/g, ' ').trim();
          if (sec) map[sec] = n; else if (name) map['n:' + name] = n;
        }
        var totalM = (document.body && document.body.innerText || '').match(/我的关注\((\d+)\)/);
        var total = totalM ? +totalM[1] : -1;
        if (sc) { try { sc.scrollTop = sc.scrollHeight; } catch (e) {} }
        else { try { if (window.scrollTo) window.scrollTo(0, document.body ? document.body.scrollHeight : 0); } catch (e) {} }
        return { map: map, any: any, total: total, liTotal: liTotal };
      } catch (e) {
        /* 非真实抖音 /follow 页（例如仿真沙箱）→ 返回空，交由 reconcile 判定为「未核对」 */
        return { map: {}, any: false, total: -1, liTotal: 0 };
      }
    }
    return new Promise(function (resolve) {
      var final, last = -1, stable = 0, rounds = 0;
      try { final = extract(); } catch (e) { return resolve(null); }
      (function loop() {
        rounds++;
        try { final = extract(); } catch (e) { return resolve(null); }
        var prog = final.liTotal || 0;
        if (prog === last) stable++; else stable = 0;
        last = prog;
        if (final.total > 0 && prog >= final.total * 0.9) return resolve(final);
        if (stable >= 6 || rounds >= 30) return resolve(final);
        setTimeout(loop, 2500);
      })();
    });
  }

  /* 把「关注页红点」地面真相和「接口读到的未读」对账：
     ① 接口给了真实 id 清单（src==='ids'）→ 以接口为准（连具体视频都有）；
     ② 接口只给了个数/读不到（src!=='ids' 或 n===0），但红点说有 N → 以红点 N 为准（保证数量和抖音一致）；
     ③ 两者都有且不一致 → 记 mismatch，但保留接口（有 id 更精确），红点数仅作提示。
     返回 { checked, mismatches, usedDom, accounts }。 */
  function reconcileWithBadges(dom) {
    var v = { checked: false, mismatches: 0, usedDom: 0, accounts: 0 };
    if (!dom || !dom.map || typeof dom.map !== 'object') return v;
    v.checked = true;
    var ap = S.apiUnread || {}, dm = dom.map, k;
    for (k in ap) {
      if (!Object.prototype.hasOwnProperty.call(ap, k) || k === '__byName') continue;
      var rec = ap[k]; if (!rec) continue;
      v.accounts++;
      var domN = dm[k];
      if (domN == null && rec.nickname) { var nk = 'n:' + normName(rec.nickname); if (dm[nk] != null) domN = dm[nk]; }
      rec.domN = (domN != null ? domN : rec.n || 0);
      if (domN == null) continue;
      var apiN = rec.n || 0;
      if (rec.src !== 'ids' && domN > 0) {
        if (apiN !== domN) v.mismatches++;
        rec.n = domN; rec.src = (apiN > 0 ? 'ids+dom' : 'dom'); v.usedDom++;
      } else if (domN !== apiN) {
        v.mismatches++;
      }
    }
    /* ★ 10-07 韧性：红点 DOM 读到、但接口完全没覆盖到的号（整页失败/漏翻）也补进 S.apiUnread。
       保证「红点说有未看」的号绝不会被漏掉 —— 地面真相兜底，覆盖 100%。 */
    for (k in dm) {
      if (!Object.prototype.hasOwnProperty.call(dm, k)) continue;
      var dN = dm[k];
      if (dN == null || dN <= 0) continue;
      if (typeof k === 'string' && k.indexOf('n:') === 0) {
        var bare = k.slice(2), hitSec = null, k3;
        for (k3 in ap) {
          if (!Object.prototype.hasOwnProperty.call(ap, k3) || k3 === '__byName') continue;
          if (ap[k3] && ap[k3].nickname && normName(ap[k3].nickname) === bare) { hitSec = k3; break; }
        }
        if (hitSec) continue;                       // 已有 sec 主键且首轮已按昵称匹配过，跳过
        if (!ap['n:' + bare]) {
          ap['n:' + bare] = { n: dN, ids: [], nickname: bare, at: Date.now(), src: 'dom', domN: dN };
          v.usedDom++; v.accounts++;
          if (S.apiUnread.__byName) S.apiUnread.__byName[normName(bare)] = ap['n:' + bare];
        }
        continue;
      }
      if (ap[k]) continue;                          // 已是接口覆盖到的号
      ap[k] = { n: dN, ids: [], nickname: '', at: Date.now(), src: 'dom', domN: dN };
      v.usedDom++; v.accounts++;
    }
    /* 重建 __byName 索引，确保按昵称查询也能命中本次补进的号 */
    if (S.apiUnread.__byName) {
      for (k in ap) {
        if (!Object.prototype.hasOwnProperty.call(ap, k) || k === '__byName') continue;
        if (typeof k === 'string' && k.indexOf('n:') === 0) continue;
        if (ap[k] && ap[k].nickname) S.apiUnread.__byName[normName(ap[k].nickname)] = ap[k];
      }
    }
    S.unreadVerify = v;
    return v;
  }

  function readApiUnread() {
    setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
      '<div class="dyh-prog" id="dyh-prog">🔌 正在从抖音接口读未读数…<br>' +
      '<span style="font-size:19px">直接调关注列表接口（覆盖你全部关注的号）</span></div>');
    return syncUnreadAuthoritative(function (p) {
      var el = document.getElementById('dyh-prog');
      if (el) el.innerHTML = '🔌 正在从抖音接口读未读数…<br><span style="font-size:19px">' +
        '已读到 <b>' + (p.got || 0) + '</b> 个号的未看清单' +
        (p.total ? ' / 关注共 <b>' + p.total + '</b> 个' : '') + '</span>' +
        (p.pages ? '<br><span style="font-size:17px;color:#7A6A3F">第 ' + p.pages + ' 页（翻页中…）</span>' : '');
    }).then(function (r) {
      var apv = S.apiUnread || {};
      var st = { known: 0, sumN: 0 };
      for (var k in apv) { if (!Object.prototype.hasOwnProperty.call(apv, k) || k === '__byName') continue; var it = apv[k] || {}; if (!(it.n >= 0)) continue; st.known++; st.sumN += it.n; }
      var v = r.verify || S.unreadVerify || { checked: false, mismatches: 0, usedDom: 0 };
      // 统计本机已有哪些未看明细、还差哪些（基于 applyApiUnreadAll 已落盘的 S.apiUnread）
      var haveSet = {}, z;
      for (z = 0; z < S.videos.length; z++) if (S.videos[z] && S.videos[z].awemeId) haveSet[S.videos[z].awemeId] = 1;
      var ap = S.apiUnread || {}, have = 0, miss = 0, rev = 0, rmap = readIdMap();
      for (var k2 in ap) {
        if (!Object.prototype.hasOwnProperty.call(ap, k2)) continue;
        if (k2 === '__byName') continue;
        var rec = ap[k2]; if (!rec) continue;
        var ids = rec.ids || [];
        for (z = 0; z < ids.length; z++) {
          var id = String(ids[z]);
          if (rmap[id]) rev++; else if (haveSet[id]) have++; else miss++;
        }
      }
      var h = '<div class="dyh-back" data-act="home">← 返回</div>';
      h += '<div class="dyh-card">' +
        '<div class="dyh-row"><b>读到几个号</b><span class="dyh-hl">' + st.known + ' 个</span></div>' +
        '<div class="dyh-row"><b>合计未读</b><span class="dyh-hl">' + st.sumN + ' 条</span></div>' +
        '<div class="dyh-row"><b>本机已有明细</b><span>' + have + ' 条</span></div>' +
        '<div class="dyh-row"><b>还差明细</b><span>' + miss + ' 条</span></div>' +
        (rev ? '<div class="dyh-row"><b>改回未读</b><span>' + rev + ' 条（本机错标成已看的）</span></div>' : '') +
        (r.fromHarvest ? '<div class="dyh-row"><b>数据来源</b><span>关注页滚动收割（接口直读失败兜底）</span></div>' : '') +
        (v.checked ?
          (v.usedDom > 0 ?
            '<div class="dyh-row"><b>🔍 红点核对</b><span style="color:#b88200">接口漏读 ' + v.usedDom + ' 个号，已按关注页红点补全</span></div>' :
            (v.mismatches > 0 ?
              '<div class="dyh-row"><b>🔍 红点核对</b><span style="color:#b88200">' + v.mismatches + ' 个号接口数与红点不符，已提示</span></div>' :
              '<div class="dyh-row"><b>🔍 红点核对</b><span style="color:#2ba471">已与关注页红点逐个核对：一致</span></div>')) :
          '<div class="dyh-row"><b>🔍 红点核对</b><span style="color:#7A6A3F">未核对（请到抖音「关注」页再点一次以核对）</span></div>') +
        '</div>';
      if (miss > 0) {
        h += '<div class="dyh-tip" style="color:#b88200">抖音说有 <b>' + st.sumN + '</b> 条没看，但本机只存着 <b>' + have + '</b> 条的详情（标题/封面），还差 <b>' + miss + '</b> 条没抓回来。未读<b>数量</b>已经全部按抖音更新好了；点下面去把缺的视频也抓回来。</div>';
        h += '<button class="dyh-btn primary" data-act="scan">▶ 去抓缺的 ' + miss + ' 条视频</button>';
      } else if (st.known > 0) {
        h += '<div class="dyh-tip">✅ 数量和清单都已按抖音接口更新完毕 —— 现在点开任何一个号，看到的未读视频就和抖音 App 里点开它看到的是<b>同一批</b>。</div>';
      } else {
        h += '<div class="dyh-tip">没读到任何未看数据。多半是没登录抖音网页版，或这会儿抖音接口抽风 —— 在抖音「关注」页再点一次试试。</div>';
      }
      h += '<button class="dyh-btn primary" data-act="manage">📺 去看未读视频</button>';
      setBody(h);
      toast('读完 ' + st.known + ' 个号 · 合计 ' + st.sumN + ' 条未读');
      return st.known;
    }).catch(function (e) {
      setBody('<div class="dyh-back" data-act="manage">← 返回</div>' +
        '<div class="dyh-tip" style="color:#f53f3f">读取失败：' + esc(e && e.message ? e.message : e) + '</div>' +
        '<div class="dyh-tip">多半是没登录抖音网页版（接口需要登录态），或这会儿抖音在限流。请先在本页登录抖音，或在抖音「关注」页再点一次。</div>' +
        '<button class="dyh-btn primary" data-act="manage">返回</button>');
      return -1;
    });
  }

  /* ★ 00:15 · 「从网页内存里读」入口：滚 → 从 React 状态里把抖音存的那份数据抄出来
     全程不读页面上的任何文字，只看抖音自己放在内存里的对象。 */


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
        /* ★ 10-07：绝不因此收工。连挂再多次也只是降到最慢 + 长冷却后继续抓，
           直到把全部账号处理完（用户要的就是「一直抓完全部」）。 */
        if (slowRounds >= 3) {
          coolUntil = Date.now() + (25000 + Math.random() * 15000);
          toast('抖音这会儿一直不太给数据，已降到最慢速度继续抓（会一直抓完所有账号，不用你再点）。', 6000);
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
            /* ★ 10-07：全局限流也只是降速 + 长冷却继续，不收工（用户要一直抓完）。 */
            conc = 1; coolUntil = Date.now() + 30000;
            toast('抖音正在全局限流，已自动降到最慢速度继续抓（不会失败，只是慢一点，会一直抓完全部）。', 6000);
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
        // 停滞看门狗：90 秒没进展通常是被限流卡住 → 降速 + 长冷却 + 继续（绝不收工，用户要一直抓完）
        var stallTimer = setInterval(function () {
          if (ended) return;
          if (Date.now() - lastProgress > 90000) {
            stalled = true;
            if (scanCtrl) { try { scanCtrl.abort(); } catch (e) { } }   // 放掉卡住的在途请求，重新来
            conc = 1; refreshMsToken();
            coolUntil = Date.now() + 30000;
            lastProgress = Date.now();   // 重置，给冷却时间，不让它反复触发
            toast('网络有点卡，已自动降速重试（不会停，会一直抓完全部账号）。', 5000);
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

    // 看门狗：超过预算时间不强制收工（用户要一直抓完），只降速 + 冷却 + 续跑，并往后推预算避免反复弹
    var wdTimer = setInterval(function () {
      if (stopFlag) return;
      var budgetMs = (parseInt(S.cfg.scanBudget, 10) || 12) * 60000;
      if (Date.now() - startedAt > budgetMs) {
        conc = 1; refreshMsToken();
        coolUntil = Date.now() + 30000;
        startedAt = Date.now() - (budgetMs - 60000);   // 推后预算，避免每分钟都弹
        toast('抓取时间较长，已自动降速继续（会一直抓完所有账号，不用你再点）。', 6000);
      }
    }, 30000);

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
    function runPass(list) {
      /* ★ 逐个补抓固定用「最多 2 并发」（10-03 01:25）：
         这条路上一个账号一次请求，并发越高越像机器人 → 403 → 满屏失败。
         信息流阶段已经把绝大多数账号核对掉了，这里剩下的本来就不多，用 2 并发慢慢磨最稳。 */
      conc = Math.min(2, maxConc);
      var BATCH = list.length <= 120 ? list.length
        : Math.max(10, Math.min(60, parseInt(S.cfg.scanBatch, 10) || 60));
      /* ★ 10-07：不再「跟两批就收工」，而是【一直处理到整份名单走完】，中途被限流也降速继续，
         直到全部账号都跑过；真正死活抓不到的号在最后单独再补最多 2 轮（避免无限循环）。 */
      var cursor = 0, passes = 0, MAXP = Math.ceil(list.length / BATCH) + 3;
      function one() {
        if (shouldStop() || passes >= MAXP) return Promise.resolve();
        var batch = list.slice(cursor, cursor + BATCH);
        if (!batch.length) return Promise.resolve();
        return pump(batch).then(function () {
          prefixTotal += prefixOf(batch);
          cursor += BATCH; passes++;
          scheduleSave(); report();
          if (shouldStop()) return Promise.resolve();
          return sleep(400).then(one);
        });
      }
      return one().then(function () {
        /* 失败的号再单独补最多 2 轮（runItem 内部已就地重试 3 次，这里补整轮以覆盖限流恢复后的重试） */
        var rounds = 0;
        function retryFailed() {
          if (shouldStop() || !failed.length || rounds >= 2) return Promise.resolve();
          rounds++;
          var f = failed.slice(); failed = [];
          return pump(f).then(function () { return sleep(400).then(retryFailed); });
        }
        return retryFailed();
      });
    }

    /* ============ 阶段 0：关注页收割（10-03 02:20 新增，主引擎）============
       在抖音自己的「关注」页里往下滚，让抖音前端自己去翻页、自己发请求，
       我们只把它收到的响应抄下来解析 —— 全程 0 次自签名请求，所以 0 次失败。
       未读数量 / 清单统一由接口 not_seen_item_id_list_v2（见 readApiUnread）提供，
       不再从侧栏角标文字里读（角标/快照/估算/内存直读方法已全部删除）。 */
    var harvestInfo = null;
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
      }).catch(function () { /* 收割没收到东西也不算失败：下面还有信息流和逐个抓兜底 */ });
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
        return runPass(plan).then(function () {
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
    var apiAccs = 0, apiN = 0, apiHas = !!(S.apiUnread && Object.keys(S.apiUnread).length);
    if (apiHas) {
      var _now = Date.now();
      for (var _ak in S.apiUnread) {
        if (_ak === '__byName') continue;
        var _ae = S.apiUnread[_ak];
        if (_ae && _ae.at && _now - _ae.at <= API_UNREAD_VALID_MS) { apiAccs++; apiN += (_ae.n || 0); }
      }
    }
    var h = '';
    /* 注：原先这里有一段「⚠️ 检测到系统/浏览器正处于夜间模式…」的整块红字提示，
       按用户要求已删除（2026-10-03 15:14）。detectNightMode() 本身保留，设置页的皮肤自检还在用。 */
    h += '<div class="dyh-card">';
    h += '<div class="dyh-row"><b>账号</b><span>' + (S.selfSecUid ? '已登录' : '未识别') + '</span></div>';
    h += '<div class="dyh-row"><b>关注公众号</b><span>' + S.accounts.length + ' 个</span></div>';
    /* ★ 未读总数走「抖音自己在关注页标的数」，跟 App 同一口径（不是本机抓了多少条明细） */
    h += '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + tu.n + ' 条 / ' + tu.acc + ' 个号</span></div>';
    h += '<div class="dyh-row"><b>其中抖音官方未看</b><span>' +
      (apiHas ? (apiAccs + ' 个号 · ' + apiN + ' 条') : '（抓完一轮会自动读进来，点「📡 抓最新未读视频」就有了）') + '</span></div>';
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
    h += '<div class="dyh-tip">标题后面那个 <b>' + VER_SHORT + '</b> 是版本号，用来确认手机上跑的是不是最新版。</div>';
    h += '<div class="dyh-card" style="background:#F0E6CC">' +
      '<div class="dyh-row" style="font-weight:bold">📖 正确操作步骤</div>' +
      '<div class="dyh-tip" style="margin:6px 0 0">① 抖音网页版登录账号，进入「关注」页。<br>' +
      '② 点右下角 🎯 打开本助手面板。<br>' +
      '③ 点「📡 抓最新未读视频」——自动去关注页：先把每个号的未看视频抓进本机，' +
      '【抓完会自动继续】把抖音自己标的未看数量（和 App 同源）也读进来，全程只需点这一次。<br>' +
      '④ 点「📺 未读视频查看」，按账号看谁的未读最多；点任意账号看未看视频，用抖音 App 打开观看（看过的自动记成已看）。</div>' +
      '<div class="dyh-tip" style="margin:8px 0 0">📌 以前「抓视频」和「读未读数」要分两次点，现在合并成一步：' +
      '视频是明细、未读数是权威数量，二者都由抖音接口（not_seen_item_id_list_v2）给，和 App 完全一致。<br>' +
      '⚠️ 若弹「允许网站打开抖音吗」：Via → 设置 → 高级设置 → 链接处理 → 改成「直接打开」。</div>' +
      '</div>';
    return h;
  }

  function unreadVideos() {
    var readMap = readIdMap();
    /* ★ 10-07：只展示「抖音官方标了未看」的视频（其 id 在 S.apiUnread[某号].ids 里）。
       这样主列表里每一条都确确实实是抖音 App 里的未读，不会把早看过的旧视频混进来，
       也不会把「其实不是未读」的视频算进去 —— 数量也跟抖音一致。 */
    var unreadSet = {}, hasApi = false, ap = S.apiUnread || {};
    for (var k in ap) {
      if (!Object.prototype.hasOwnProperty.call(ap, k)) continue;
      if (k === '__byName') continue;
      var ids = (ap[k] && ap[k].ids) || [];
      if (ids.length) { hasApi = true; for (var i = 0; i < ids.length; i++) unreadSet[String(ids[i])] = 1; }
    }
    if (!hasApi) {
      return S.videos.filter(function (v) { return !readMap[v.awemeId]; })
        .sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
    }
    return S.videos.filter(function (v) {
      return unreadSet[String(v.awemeId)] && !readMap[v.awemeId];
    }).sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
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
    /* ★ 10-07：只认「抖音官方未看 id」的视频，保证视图里的每一条都确是未读 */
    var unreadSet = {}, hasApi = false, ap = S.apiUnread || {};
    for (var kk in ap) {
      if (!Object.prototype.hasOwnProperty.call(ap, kk)) continue;
      if (kk === '__byName') continue;
      var uids = (ap[kk] && ap[kk].ids) || [];
      if (uids.length) { hasApi = true; for (var ui = 0; ui < uids.length; ui++) unreadSet[String(uids[ui])] = 1; }
    }
    for (i = 0; i < S.videos.length; i++) {
      v = S.videos[i];
      if (!v || !v.awemeId || readMap[v.awemeId]) continue;
      if (hasApi && !unreadSet[String(v.awemeId)]) continue;   // ★ 只算抖音标了未看的
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

  
  
  /* ============ 未读数字的唯一权威来源 ============
     ★ 抖音关注列表接口 /aweme/v1/web/user/following/list/ 里，每个账号自带
       not_seen_item_id_list_v2（旧版 not_seen_item_id_list），其长度 = 该号未看视频条数，
       且给出【具体是哪几条视频 id】。页面上的「N个作品未看」只是它的渲染结果。
     ★ 所有未读数量 / 清单一律只信 apiUnreadOf()（数据存 S.apiUnread，12 小时有效）。
       读不到官方未读时，只退回「本机明细里未读的条数」（受 accCursor 边界约束），
       绝不拿视频库库存条数冒充未读数。
       （旧的角标/快照/估算/对账/诊断等方法已全部删除，见「未读数据源-权威说明.md」） */

  /* 接口里这个号的未读（{n, ids, nickname, at}），取不到返回 null */
  function apiUnreadOf(a) {
    if (!a || !S.apiUnread) return null;
    var v = null;
    if (a.secUserId) v = S.apiUnread[a.secUserId];
    if (!v && a.name && S.apiUnread.__byName) v = S.apiUnread.__byName[normName(a.name)];
    if (!v || v.n == null) return null;
    /* 过期就不认（它会不可信地盖住别的数据源） */
    if (v.at && Date.now() - v.at > API_UNREAD_VALID_MS) return null;
    return v;
  }


  /* 一个号有几个未读（数量）
     ★ 唯一权威来源：抖音关注列表接口 not_seen_item_id_list_v2（apiUnreadOf，12 小时有效）。
       读到了就直接返回它的 n（= 该号未看的视频条数，且含具体 id 清单）。
       没读到官方未读时，退回「本机明细里未读的条数」（受 accCursor 边界约束，不会是整库冒充）；
       没有边界也没有抓取记录时退化为 0，绝不拿视频库存条数冒充未读数。
       （accUnreadUnknown / accFreshN / accBadgeOf / serverUnread 等代理方法已全部删除） */
  function accUnread(a, um) {
    if (!a) return 0;
    if (a._ghost) return localUnread(a, um);          // 非关注的推荐号：抖音不会给它未读数
    var api = apiUnreadOf(a);
    if (api) return api.n;                            /* ⓪ 抖音关注列表接口给的未读 id 列表长度 = 官方未读数 */
    return unreadVideosOf(a.secUserId, a).length;    /* 兜底：本机明细里未读的视频条数（受 accCursor 边界约束） */
  }

  /* 「全部未读」= 按账号把抖音给的数加总（和 App 的关注未读总数同一口径）
     ★ 只信任接口权威未读（apiUnreadOf），不再用「本机抓到几条明细」去当总数。
     返回 { n: 未读总条数, acc: 有几个号有未读 } */
  function totalUnread() {
    var um = buildUnreadView().map, n = 0, acc = 0, i;
    for (i = 0; i < S.accounts.length; i++) {
      var x = accUnread(S.accounts[i], um);
      if (x > 0) { n += x; acc++; }
    }
    return { n: n, acc: acc };
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
    /* ★ 22:50：推荐走这条 —— 直接读抖音接口里的 not_seen_item_id_list_v2，
       比数页面上的角标准，连「直播号」都有（页面上不显示而已）。 */
    h += '<button class="dyh-btn primary" data-act="read-api-unread">🔌 从抖音接口读未读数（推荐·含直播号）</button>';

    /* ★ 读完留个凭据（23:12）：什么时候读的、读到几个号、合计几条 —— 一眼确认「全站已更新」 */
    (function () {
      var au = S.apiUnread, at = S.apiUnreadAt || 0, k;
      if (!au || !at) return;
      var cnt = 0, sum = 0, have = 0;
      for (k in au) {
        if (!Object.prototype.hasOwnProperty.call(au, k) || k === '__byName') continue;
        var r = au[k];
        if (!r || r.n == null) continue;
        cnt++; sum += r.n;
        var vv = secVideosSorted(k), hs = {};
        if (r.ids) { for (var q = 0; q < r.ids.length; q++) hs[String(r.ids[q])] = 1; }
        for (var p = 0; p < vv.length; p++) if (hs[String(vv[p].awemeId)]) have++;
      }
      if (!cnt) return;
      var mins = Math.round((Date.now() - at) / 60000);
      var age = mins < 2 ? '刚刚' : (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前');
      var stale = Date.now() - at > API_UNREAD_VALID_MS;
      h += '<div class="dyh-card">' +
        '<div class="dyh-row"><b>🔌 上次读接口</b><span>' + age + (stale ? '（已过期，不再采信）' : '') + '</span></div>' +
        '<div class="dyh-row"><b>　读到</b><span>' + cnt + ' 个号 · 合计 <b class="dyh-hl">' + sum + '</b> 条未读</span></div>' +
        (sum > have ? '<div class="dyh-row"><b>　其中本机有明细</b><span>' + have + ' 条（还差 ' + (sum - have) + ' 条详情没抓到）</span></div>' : '') +
        '</div>';
    })();


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
      var un = accUnread(a, um);
      var loc = localUnread(a, um);
      /* 抖音说还有更多的（本机没抓到明细）标个 +，让你知道不是没抓到、是还没抓到明细 */
      var plus = (un > loc) ? '<small style="font-size:15px;opacity:.75">⁺</small>' : '';
      h += '<div class="dyh-acc2">' +
        '<span class="dyh-nm" data-act="acc-videos" data-sec="' + esc(a.secUserId) + '" data-name="' + esc(a.name || '') + '">' +
        (a._ghost ? '<small style="font-size:15px;opacity:.7">新·</small>' : '') + esc(a.name || a.secUserId) + '</span>' +
        '<span class="dyh-urn2' + (un ? '' : ' ok') + '">' +
        (un ? (un + ' 未读' + plus) : '已看完') + '</span>' +
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

  /* per-account 未读边界：由接口 not_seen_item_id_list_v2 反推、经 applyApiUnreadAll 写入 S.accCursor。
     返回 -1 表示「还没定过边界」（退化到下面的本机明细规则）。 */
  function accCursorOf(a) {
    if (!a) return -1;
    if (a.secUserId && S.accCursor && S.accCursor[a.secUserId] != null) return S.accCursor[a.secUserId];
    return -1;
  }

  
  function unreadVideosOf(sec, acc) {
    /* ★★★ ⓪ 抖音【接口】给的「未看作品 id 列表」—— 就是 App 里点开那个号看到的那一批。
       以前只拿它算一个「数量」，清单还按本机边界瞎猜 —— 于是「数字对上了，点进去还是老视频」。
       现在直接按 id 取；本机误标成"已看"的那些也已在 applyApiUnreadAll 里撤回。 */
    var a0 = acc || { secUserId: sec };
    var apiv = apiUnreadOf(a0);
    if (apiv && apiv.n != null) {
      if (apiv.ids && apiv.ids.length) {
        var aid = {}, ax;
        for (ax = 0; ax < apiv.ids.length; ax++) aid[String(apiv.ids[ax])] = 1;
        var aAll = accountVideosSorted(a0), aOut = [], av;
        for (ax = 0; ax < aAll.length; ax++) { av = aAll[ax]; if (aid[String(av.awemeId)]) aOut.push(av); }
        return aOut;                       // accountVideosSorted 已是最新在前
      }
      if (apiv.n === 0) return [];         // 抖音明确说都看完了
      return accountVideosSorted(a0).slice(0, apiv.n);   // 只给了个数（user_not_see）→ 取最新 n 条
    }
    var readMap = readIdMap(), out = [], i, v;
    var all = accountVideosSorted(acc || { secUserId: sec });
    var cursor = accCursorOf(acc || { secUserId: sec });
    if (cursor >= 0) {
      /* 有官方边界（applyApiUnreadAll 据 not_seen_item_id_list_v2 反推写入）：
         只把边界之后、且本机未标已看的算未读，绝不把整库当未读。 */
      for (i = 0; i < all.length; i++) {
        v = all[i];
        if ((v.publishedAt || 0) <= cursor) continue;
        if (readMap[v.awemeId]) continue;
        out.push(v);
      }
    } else if (S.lastScanAt) {
      /* 没权威数据：只把「这次抓取新抓到的」当未读，绝不算陈年旧视频（避免冒充未读数） */
      for (i = 0; i < all.length; i++) {
        v = all[i];
        if (readMap[v.awemeId]) continue;
        if ((v.publishedAt || 0) <= S.lastScanAt) continue;
        out.push(v);
      }
    } else {
      /* 兜底：从没抓过 / 没有 lastScanAt → 退化成「全部抓到的」（极少触发，但不编造权威数） */
      for (i = 0; i < all.length; i++) {
        v = all[i];
        if (readMap[v.awemeId]) continue;
        out.push(v);
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
    var totalN = accUnread(acc, um);          // 该号的未读（抖音接口为准，没读到退回本机明细）
    var vids = unreadVideosOf(sec, acc);
    /* 抖音接口已经明确给了「是哪几条」时，清单就按它；否则 vids 走本机明细（受 accCursor 边界约束）。
       不再用任何侧栏快照 / 角标数字去截断清单（那会把抖音点名的未看视频砍掉）。 */
    var h = '<div class="dyh-back" data-act="manage">← 返回</div>';
    h += '<div class="dyh-card">' +
      '<div class="dyh-row"><b>公众号</b><span>' + esc(name) + (acc && acc._ghost ? ' <em style="font-style:normal;color:#7A6A3F">（非关注·不计未读）</em>' : '') + '</span></div>' +
      '<div class="dyh-row"><b>未读视频</b><span class="dyh-hl">' + totalN + ' 条</span></div>' +
      '<div class="dyh-row"><b>本机抓到明细</b><span>' + vids.length + ' 条</span></div>' +
      (acc && acc.category ? '<div class="dyh-row"><b>分类</b><span>' + esc(acc.category) + '</span></div>' : '') +
      '</div>';
    /* ★ 23:12：把「抖音接口」这份数据单独摊开——它同时决定了【数量】和下面【清单里的每一条】 */
    var apiV = acc ? apiUnreadOf(acc) : null;
    (function () {
      if (!apiV || apiV.n == null) return;
      var mins = Math.round((Date.now() - (apiV.at || 0)) / 60000);
      var age = mins < 2 ? '刚刚' : (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前');
      h += '<div class="dyh-card">' +
        '<div class="dyh-row"><b>🔌 抖音接口给的</b><span class="dyh-hl">' + apiV.n + ' 条未看</span></div>' +
        '<div class="dyh-row"><b>　字段</b><span>' +
        (apiV.ids && apiV.ids.length ? 'not_seen_item_id_list（连哪几条都给了）' : 'user_not_see（只给了数量）') +
        ' · ' + age + '</span></div>' +
        '<div class="dyh-row"><b>　本机有详情</b><span>' + vids.length + ' 条</span></div>' +
        (vids.length < apiV.n ? '<div class="dyh-row"><b>　还差明细</b><span style="color:#b88200">' +
          (apiV.n - vids.length) + ' 条没抓回来</span></div>' : '') +
        '</div>';
      if (apiV.n > vids.length) {

      }
    })();
    /* 没读到官方未读时的诚实提示：下面列的是本机抓到的未读明细（受边界约束），数量可能不准 */
    if (!apiV || apiV.n == null) {

    }
    /* ★ 2026-10-03 15:14 新增：
       抓这一个号的「N个作品未看」数量 + 对应的未读视频清单（只发几次请求，不用跑整轮、不用跳关注页）。 */


    /* 「唤起方式」开关：不同手机 / 不同浏览器对 scheme 和 intent 的放行程度不一样，
       哪个不弹「允许网站打开抖音吗」就锁哪个（点一下循环切换，会记住）。 */
    var om = S.cfg.openMode || 'scheme';
    var omNext = (om === 'scheme') ? 'intent' : (om === 'intent' ? 'auto' : 'scheme');
    var omTxt = { scheme: '① 只 scheme（默认，发一次）', intent: '② 只 intent（写死包名）', auto: '③ 自动（scheme 失败再补 intent）' };
    h += '<div class="dyh-row"><b>唤起方式</b>' +
      '<span class="dyh-mini" data-act="openmode" data-mode="' + esc(omNext) + '">' + esc(omTxt[om]) + ' ⇄</span></div>';

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
       ④ 把边界写进 S.accCursor（applyApiUnreadAll 同一套机制），于是未读视图 / 分类统计 /
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
    /* ★ N 的唯一权威 = 抖音关注列表接口 not_seen_item_id_list_v2（和 App 同源）。
       不再去读侧栏角标文字、也不再拿「已看记录算前缀」冒充（实测会算出 0）。
       下面只做两件事：① 抓作品并入库；② 从接口收该号的官方未读数据。 */
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
    /* ① 抓这个号的作品（用来列出未读清单、并入视频库） */
    prog('📡 正在抓「' + esc(who) + '」的作品…', '用来列出未读清单');
    return fetchAccountWorks(acc.secUserId, 5)
      .then(function (list) {
        var works = list || [], j, v, known = {}, added = 0;
        for (j = 0; j < S.videos.length; j++) known[S.videos[j].awemeId] = 1;
        for (j = 0; j < works.length; j++) {
          v = works[j];
          if (known[v.awemeId]) continue;
          if (!v.secUid) v.secUid = acc.secUserId;    // 作品接口偶尔不带 sec_uid / 昵称，补上才能归到这个号
          if (!v.account) v.account = who;
          known[v.awemeId] = 1; S.videos.push(v); added++;
        }
        if (added) { S.__vseq++; save(); }
        /* ② 从抖音接口读这个号的官方未读（not_seen_item_id_list_v2，和 App 同源）。
           让抖音自己翻关注列表，我们只收它自己的响应、一个自签请求都不发。 */
        prog('🔌 正在从抖音接口读官方未读…', '「' + esc(who) + '」未看的视频');
        /* ★ 10-06 修正：同样先倒掉上一次遗留的响应，只收本轮抖音新返回的；
           若这一轮它一条都没发，再把旧的放回去兜底，避免读成空白。 */
        var prevFoll = netTake('following');
        return harvestApiUnread({ maxRounds: 80, wait: 800, untilSec: acc.secUserId })
          .then(function (got) {
            /* ★ 10-06 修：始终并回开头倒掉的旧响应，不丢任何一份 */
            for (var pi = 0; pi < prevFoll.length; pi++) NET.buf.push(prevFoll[pi]);
            if (!got.users) got = collectFollowingUnread();
            if (got && got.map) applyApiUnreadAll(got.map);   // 落：数量 + 未读清单 + 已看边界
            var apiV = apiUnreadOf(acc);
            open('accv');
            if (apiV && apiV.n != null) {
              toast('「' + who + '」官方未读 ' + apiV.n + ' 条' + (added ? '，新增入库 ' + added + ' 条' : ''));
            } else {
              toast('已抓到作品，但没在接口里读到这个号的官方未读（可能要回到关注页多翻一会）');
            }
            return apiV ? apiV.n : 0;
          });
      })
      .catch(function (e) {
        setBody('<div class="dyh-back" data-act="accv">← 返回</div>' +
          '<div class="dyh-tip" style="color:#f53f3f">抓取失败：' + esc(e && e.message ? e.message : e) + '</div>' +
          '<div class="dyh-tip">多半是没登录抖音网页版，或刚被风控。回「关注」页跑一轮整轮抓通常更稳。</div>' +
          '<button class="dyh-btn" data-act="accv">← 返回这个号</button>');
        return 0;
      });
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

    /* ★ 抓法总开关（10-03 02:20）：「关注页收割」是我们不再失败的通道 —— 请求由抖音前端自己发。
       万一哪天它不灵（比如你用桌面 UA 看到的页面结构变了），可以关掉退回纯自签请求的旧路。 */
    var hvOn = S.cfg.harvest !== false;
    h += '<label class="dyh-lb">抓未读的主通道</label><div style="display:flex;gap:8px;margin:6px 0 4px">' +
      '<button class="dyh-btn' + (hvOn ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="harvest-mode" data-mode="on">关注页收割（推荐·不失败）</button>' +
      '<button class="dyh-btn' + (!hvOn ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="harvest-mode" data-mode="off">老办法（自己发请求）</button>' +
      '</div>';

    var md = S.cfg.scanMode === 'post' ? 'post' : 'auto';
    h += '<label class="dyh-lb">抓取方式</label><div style="display:flex;gap:8px;margin:6px 0 4px">' +
      '<button class="dyh-btn' + (md === 'auto' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="scan-mode" data-mode="auto">智能（默认，推荐）</button>' +
      '<button class="dyh-btn' + (md === 'post' ? ' primary' : '') + '" style="flex:1;text-align:center" data-act="scan-mode" data-mode="post">只逐个抓</button>' +
      '</div>';

    h += '<label class="dyh-lb">每次抓前几个账号（留空 = 全部 ' + S.accounts.length + ' 个）</label>' +
      '<input id="dyh-limit" class="dyh-input" type="number" min="0" inputmode="numeric" value="' + (S.cfg.scanLimit || 0) + '">';
    h += '<label class="dyh-lb">并发【上限】1~10（默认 6）</label>' +
      '<input id="dyh-conc" class="dyh-input" type="number" min="1" max="10" inputmode="numeric" value="' + (S.cfg.scanConc || 6) + '">';
    h += '<label class="dyh-lb">整轮最长几分钟（超时自动收尾，0 = 不限制）</label>' +
      '<input id="dyh-budget" class="dyh-input" type="number" min="0" max="60" inputmode="numeric" value="' + (S.cfg.scanBudget || 12) + '">';

    /* ★ 未读数只信任抖音接口 / 网页内存里的权威数据（not_seen_item_id_list_v2，和 App 同源）。
       以下两个按钮直接读这份数据，读完整个面板的未读数 / 未读清单都会按它更新。 */
    h += '<label class="dyh-lb">📡 读抖音官方未读数（权威源）</label>';
    h += '<button class="dyh-btn primary" data-act="read-api-unread">🔌 从抖音接口读未读数（推荐·含直播号）</button>';

    h += '<button class="dyh-btn primary" data-act="save-settings">💾 保存</button>';
    /* 皮肤自检：直接把浏览器【实际算出来】的底色打印出来。
       如果这里显示的是白色/透明，说明有别的东西（旧脚本的样式表 / Via 的夜间模式）在压我们 ——
       一眼就能定位，不用再猜「到底改没改上」。 */
    h += '<label class="dyh-lb">🎨 浅黄皮肤自检</label>';
    h += '<div class="dyh-card"><div class="dyh-tip" style="margin:0">' + skinProbe() + '</div></div>';
    h += '<button class="dyh-btn" data-act="reskin">🔧 重刷皮肤（底色被压回白色时点这个）</button>';

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
            ' 条新视频（' + Math.round(r.harvest.ms / 1000) + ' 秒，0 次失败）</span></div>' : '');
        if (r.left) h += '<div class="dyh-row"><b>还剩没抓到</b><span>' + r.left + ' 个（已记入断点）</span></div>';
        /* ★ 抓完直接对一次账（10-03 03:10）：本机抓到的明细条数 vs 抖音自己标的数量，
           以前结果页只说「新增 N 条」，进去查看页又是另一套统计，看着就像没按抓取结果显示。 */
        /* ★ 对账：未读总数【以抖音自己的数为准】（跟 App 一致），
           本机明细单列一行 —— 以前拿「本机抓到几条」当总数，
           所以你一进 App 就看出来「完全不一样」（旧视频都算进去了）。 */
        var tu = totalUnread();
        h += '<div class="dyh-row"><b>现在全部未读</b><span class="dyh-hl">' + tu.n + ' 条 / ' + tu.acc + ' 个号</span></div>';
        h += '<div class="dyh-row"><b>其中：抖音官方未看</b><span>' +
          (function () {
            var m = S.apiUnread || {}, c = 0, n = 0, now = Date.now(), k;
            for (k in m) { if (k === '__byName') continue; var e = m[k]; if (e && e.at && now - e.at <= API_UNREAD_VALID_MS) { c++; n += (e.n || 0); } }
            return c ? (c + ' 个号 · ' + n + ' 条') : '没读到（点「读官方未读数」或抓一轮会读）';
          })() + '</span></div>';
        h += '<div class="dyh-row"><b>本机抓到明细</b><span>' + unreadVideos().length + ' 条</span></div>';
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
        /* ★ 10-06 改：抓完视频【自动】把抖音官方未读数也读进来，不用再点「从抖音接口读未读数」。
           抓视频 + 读官方未读本来就是一条流水线（视频是明细、未读数是权威数量），拆成两步纯属多此一举。 */
        setTimeout(function () { try { readApiUnread(); } catch (e) { } }, 900);
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
    if (act === 'read-api-unread') { readApiUnread(); return; }
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
    /* ★ 单号「查官方未读」被带到 /follow 之后，在这里自动续跑（读接口权威数据 + 列清单）。
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
    /* ★ 23:55：「读全部账号的官方未读数」被带到 /follow 之后自动续跑（现在只走接口权威源，不再有内存直读分支） */
    try {
      if (S.pendingAllBadge && Date.now() - S.pendingAllBadge.at < 180000) {
        S.pendingAllBadge = null; save();
        if (onFollowPage()) setTimeout(function () {
          try { readApiUnread(); } catch (e) { }
        }, 1500);
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
    openInApp: openInApp,
    unreadByAccount: unreadByAccount,
    buildUnreadView: buildUnreadView,
    accUnread: accUnread,
    localUnread: localUnread,
    totalUnread: totalUnread,
    ghostAuthors: ghostAuthors,
    listIsFresh: listIsFresh,
    pruneToAccounts: pruneToAccounts,
    scanOneAccount: scanOneAccount,
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
    scrollFollowSidebar: scrollFollowSidebar,
    findScrollable: findScrollable,
    netCleanUrl: netCleanUrl,
    netWideRecord: netWideRecord,
    netPush: netPush,
    collectFollowingUnread: collectFollowingUnread,
    harvestApiUnread: harvestApiUnread,
    readApiUnread: readApiUnread,
    fetchFollowingUnread: fetchFollowingUnread,
    fetchUnreadVideoDetails: fetchUnreadVideoDetails,
    syncUnreadAuthoritative: syncUnreadAuthoritative,
    applyApiUnreadAll: applyApiUnreadAll,
    readFollowBadgesDom: readFollowBadgesDom,
    reconcileWithBadges: reconcileWithBadges,
    collectFiberUnread: collectFiberUnread,
    fiberOf: fiberOf,
    fiberRootOf: fiberRootOf,
    userUnreadFromObj: userUnreadFromObj,
    deepFindUsers: deepFindUsers,
    scanFiberNode: scanFiberNode,
    walkFiberTree: walkFiberTree,
    apiUnreadOf: apiUnreadOf,
    findUserArray: findUserArray,
    pullUnreadIds: pullUnreadIds,
    applyApiUnreadAll: applyApiUnreadAll,
    secVideosSorted: secVideosSorted,
    harvestFollowPage: harvestFollowPage,
    push: function () { return ghPush('unread.json', JSON.stringify(buildPayload()), '手机端更新 ' + fmtTime(Date.now())); },
    openPanel: function () { open('home'); }
  };
})();
