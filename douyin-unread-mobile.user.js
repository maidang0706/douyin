// ==UserScript==
// @name         抖音关注未读视频助手（手机版 / Via）2026-10-18 18:56 登录检测修正
// @namespace    com.workbuddy.douyin.unread.mobile
// @version      1.3.2
// @description  2026-10-18 18:56 登录检测修正：移动端改用非HttpOnly登录票据判定、HttpOnly读不到时默认已登录，并改用 www.douyin.com 接口避免移动端跨域失败；抓取抖音关注账号未读视频，支持「同步已读」「扫描全部关注」「分类→账号分组」。
// @author       WorkBuddy
// @match        https://m.douyin.com/*
// @match        https://www.douyin.com/*
// @match        https://*.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 实现说明：
 *  - 本脚本运行在抖音网页的「主世界」，因此可以直接劫持页面自身的 window.fetch / XMLHttpRequest，
 *    从接口返回的 JSON 中提取视频（作者、文案、封面、链接、发布时间）。
 *  - 用 localStorage（带 DYUNREAD_ 前缀）记录已见过的视频 ID 与已读状态。
 *  - 「未读」= 被记录过、且未标记已读的视频。
 *  - 手机端难以稳定自动识别「关注」页，因此提供两种记录开关：
 *      1) 自动：当网址包含 follow / following 时自动记录；
 *      2) 手动：在面板里点「开始记录」，手动开启后即使不在关注页也会记录（方便在关注页点开后用）。
 *  - 界面为移动端优化的悬浮按钮 + 底部面板上滑。
 */
(function () {
  'use strict';

  /* ---------------- 存储 ---------------- */
  const K_DATA = 'DYUNREAD_DATA_v1';
  const K_REC = 'DYUNREAD_REC_v1';
  const K_WATCHED = 'DYUNREAD_WATCHED_v1'; // 来自抖音「观看历史」的已看视频 ID 集合

  function loadData() {
    try { return JSON.parse(localStorage.getItem(K_DATA)) || {}; }
    catch (e) { return {}; }
  }
  function saveData(d) {
    try { localStorage.setItem(K_DATA, JSON.stringify(d)); } catch (e) {}
  }
  function loadWatched() {
    try { return new Set(JSON.parse(localStorage.getItem(K_WATCHED)) || []); }
    catch (e) { return new Set(); }
  }
  function saveWatched(set) {
    try { localStorage.setItem(K_WATCHED, JSON.stringify(Array.from(set))); } catch (e) {}
  }
  function mergeWatched(ids) {
    if (!ids || !ids.length) return;
    const set = loadWatched();
    let changed = false;
    for (const id of ids) { if (!set.has(String(id))) { set.add(String(id)); changed = true; } }
    if (changed) { saveWatched(set); updateBadge(); if (panelOpen) render(); }
  }
  function isManualRecording() { return localStorage.getItem(K_REC) === '1'; }
  function setManualRecording(v) { localStorage.setItem(K_REC, v ? '1' : '0'); }

  function isFollowUrl() { return /follow|following/.test(location.href); }
  function shouldRecord() { return isFollowUrl() || isManualRecording(); }

  /* ---------------- 视频字段提取 ---------------- */
  function firstUrl(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj[0] || '';
    const list = obj.url_list || obj.urlList || obj.origin_url_list || [];
    if (Array.isArray(list) && list.length) return list[0];
    return '';
  }
  function toVideo(a) {
    if (!a || typeof a !== 'object') return null;
    const id = String(a.aweme_id || a.awemeId || a.item_id || a.aweme_id_str || '');
    if (!id || id === '0') return null;
    const author = a.author || a.author_info || {};
    const video = a.video || {};
    const cover =
      firstUrl(video.cover) || firstUrl(video.origin_cover) ||
      firstUrl(video.dynamic_cover) || firstUrl(a.cover) || '';
    const desc = (a.desc || a.descr || a.caption || '').toString().trim();
    const authorName =
      author.nickname || author.nick_name || author.unique_id || author.short_id || '未知作者';
    const authorId = author.uid || author.sec_uid || author.unique_id || '';
    return {
      id: id,
      author: authorName,
      authorId: authorId,
      desc: desc,
      cover: cover,
      url: 'https://www.douyin.com/video/' + id,
      createTime: Number(a.create_time || a.createTime || Math.floor(Date.now() / 1000)),
    };
  }
  function collectAwemes(node, depth, out) {
    if (!node || out.length > 600) return;
    if (depth > 7) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (item && typeof item === 'object' && (item.aweme_id || item.awemeId || item.item_id)) {
          const v = toVideo(item);
          if (v) out.push(v);
        } else {
          collectAwemes(item, depth + 1, out);
        }
      }
    } else if (typeof node === 'object') {
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) collectAwemes(node[k], depth + 1, out);
      }
    }
  }
  function dedupe(videos) {
    const seen = new Set(); const res = [];
    for (const v of videos) { if (v && v.id && !seen.has(v.id)) { seen.add(v.id); res.push(v); } }
    return res;
  }
  // 递归收集响应里出现的所有 aweme_id（无论接口把视频套在 aweme_info / aweme_list 等任意层级）
  function collectIds(node, out) {
    if (!node || out.length > 6000) return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) collectIds(node[i], out); return; }
    if (typeof node === 'object') {
      const id = node.aweme_id || node.awemeId || node.item_id || node.aweme_id_str;
      if (id && String(id) !== '0') { const s = String(id); if (out.indexOf(s) === -1) out.push(s); }
      for (const k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) collectIds(node[k], out); }
    }
  }
  function parseAndCapture(data) {
    try {
      const raw = [];
      collectAwemes(data, 0, raw);
      const videos = dedupe(raw);
      if (videos.length) capture(videos);
    } catch (e) {}
  }

  /* ---------------- 记录 / 未读 ---------------- */
  function capture(videos, force) {
    if (!force && !shouldRecord()) return;
    const data = loadData();
    const now = Date.now();
    let added = 0;
    for (const v of videos) {
      if (!v || !v.id) continue;
      if (!data[v.id]) {
        data[v.id] = {
          id: v.id, author: v.author, authorId: v.authorId, desc: v.desc,
          cover: v.cover, url: v.url, createTime: v.createTime,
          cat: v.cat || '未分类',
          seenAt: now, read: false,
        };
        added++;
      }
    }
    if (added) { saveData(data); updateBadge(); if (panelOpen) render(); }
  }

  // 一个视频"已读" = 手动标记过 或 出现在抖音观看历史里
  function isRead(v) {
    if (v.read) return true;
    const set = loadWatched();
    return set.has(String(v.id));
  }
  function getUnread() {
    const data = loadData();
    return Object.values(data)
      .filter(function (v) { return !isRead(v); })
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
  }
  function markRead(id) {
    const data = loadData();
    if (data[id]) { data[id].read = true; data[id].readAt = Date.now(); }
    saveData(data); updateBadge(); render();
  }
  function markAllRead() {
    const data = loadData(); const now = Date.now();
    for (const k in data) { if (!data[k].read) { data[k].read = true; data[k].readAt = now; } }
    saveData(data); updateBadge(); render();
  }
  function clearRead() {
    const data = loadData(); const out = {};
    for (const k in data) { if (!isRead(data[k])) out[k] = data[k]; }
    saveData(out); updateBadge(); render();
  }

  // 账号标识：优先用 authorId，缺失时退化为 "n:" + 昵称
  function accKey(v) { return (v && v.authorId) ? v.authorId : ('n:' + (v.author || '未知作者')); }

  // 把某个账号的全部未读标记为已读
  function markAccountRead(key) {
    const data = loadData(); const now = Date.now();
    for (const k in data) { if (accKey(data[k]) === key) { data[k].read = true; if (!data[k].readAt) data[k].readAt = now; } }
    saveData(data); updateBadge(); render();
  }
  // 为某个账号设置/修改分类（同步到该账号下所有视频）
  function setAccountCat(key, cat) {
    const data = loadData(); const c = cat || '未分类';
    for (const k in data) { if (accKey(data[k]) === key) data[k].cat = c; }
    saveData(data); render();
  }

  /* ---------------- 接口劫持（主世界可直接 patch） ---------------- */
  function installFetchHook() {
    if (window.__dyMHook) return; window.__dyMHook = true;
    const orig = window.fetch ? window.fetch.bind(window) : null;
    if (!orig) return;
    window.fetch = function (input, init) {
      const p = orig(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (url && url.indexOf('douyin.com') !== -1) {
          if (url.indexOf('history/read') !== -1) {
            p.then(function (resp) {
              try {
                const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
                if (ct && ct.indexOf('json') !== -1) {
                  resp.clone().json().then(function (j) { const ids = []; collectIds(j, ids); mergeWatched(ids); }).catch(function () {});
                }
              } catch (e) {}
            }).catch(function () {});
          } else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) {
            p.then(function (resp) {
              try {
                const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
                if (ct && ct.indexOf('json') !== -1) {
                  resp.clone().json().then(parseAndCapture).catch(function () {});
                }
              } catch (e) {}
            }).catch(function () {});
          }
        }
      } catch (e) {}
      return p;
    };
  }
  function installXHRHook() {
    if (window.__dyMXHR) return; window.__dyMXHR = true;
    const Oo = XMLHttpRequest.prototype.open;
    const Os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = typeof u === 'string' ? u : ''; return Oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const url = this.__u || '';
          if (url && url.indexOf('douyin.com') !== -1) {
            const ct = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
            if (ct && ct.indexOf('json') !== -1) {
              if (url.indexOf('history/read') !== -1) {
                const ids = []; collectIds(JSON.parse(this.responseText), ids); mergeWatched(ids);
              } else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) {
                parseAndCapture(JSON.parse(this.responseText));
              }
            }
          }
        } catch (e) {}
      });
      return Os.apply(this, arguments);
    };
  }

  /* ---------------- DOM 兜底扫描 ---------------- */
  function scanDOM() {
    if (!shouldRecord()) return;
    try {
      const anchors = document.querySelectorAll('a[href*="/video/"]');
      if (!anchors.length) return;
      const videos = [];
      anchors.forEach(function (a) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/video\/(\d+)/);
        if (!m) return;
        const id = m[1];
        let card = a;
        for (let i = 0; i < 4 && card; i++) {
          if (card.classList && (card.classList.contains('video-card') || card.tagName === 'LI' || card.tagName === 'ARTICLE')) break;
          card = card.parentElement;
        }
        const img = a.querySelector('img') || (card ? card.querySelector('img') : null);
        let author = '未知作者';
        if (card) {
          const ae = card.querySelector('[class*="author"],[class*="nickname"],[class*="name"]');
          if (ae && ae.textContent) author = ae.textContent.trim().slice(0, 40);
        }
        videos.push({
          id: id, author: author, authorId: '',
          desc: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 120),
          cover: img ? (img.getAttribute('src') || img.src || '') : '',
          url: 'https://www.douyin.com/video/' + id,
          createTime: Math.floor(Date.now() / 1000),
        });
      });
      capture(dedupe(videos));
    } catch (e) {}
  }

  /* ---------------- 全量扫描：枚举关注账号并逐个拉取视频 ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setScanText(t) { const e = panel && panel.querySelector('#dyScanStatus'); if (e) { e.textContent = t; e.style.display = 'block'; } }

  // 接口基础域名：PC 网页接口只存在于 www.douyin.com。
  //  - 当页面就在 www.douyin.com 时，用同域（保证不跨域）；
  //  - 当页面在 m.douyin.com 等子域时，显式请求 www 接口（.douyin.com 的 cookie 跨子域共享，best-effort）。
  const API = (function () {
    const h = location.hostname;
    if (h === 'www.douyin.com' || h === 'douyin.com') return location.origin;
    return 'https://www.douyin.com';
  })();

  // 接口失败时的友好提示（区分移动端跨域与签名拦截）
  function apiFailHint() {
    if (/douyin\.com/.test(location.hostname) && location.hostname !== 'www.douyin.com') {
      return '当前在 m.douyin.com（移动版），显式接口为跨域请求易被拦截。建议：在 Via 开启「桌面模式」访问 www.douyin.com 后重试；或改用「关注」页下滑记录（该方式走页面自身请求，无跨域问题）。';
    }
    return '接口可能被签名拦截。可手动打开抖音「观看历史」页，本插件会自动捕获。';
  }

  // 是否登录：优先用非 HttpOnly 登录票据判定；读不到（sessionid / sid_tt 多为 HttpOnly）时，
  // 在 douyin 域名下默认视为已登录，避免把「隐私隔离 / HttpOnly 读不到」误判成未登录。
  // 真正的未登录会由下方接口返回未授权来体现，不会卡在「未登录」。
  function isLoggedIn() {
    const c = document.cookie || '';
    if (/(^|;\s*)(sessionid|sessionid_ss|sid_tt|sid_guard|sid_ucp_v1|uid_tt|ttwid|odin_tt|passport_csrf_token|passport_auth_status)=/.test(c)) return true;
    if (/douyin\.com/.test(location.hostname)) return true; // douyin 域名下兜底默认已登录
    return false;
  }
  // 直接从 cookie 读取当前登录用户的 uid（零请求、不跨域、最稳）
  function getUidFromCookie() {
    const c = document.cookie || '';
    const m = c.match(/(?:^|;\s*)uid_tt(?:_ss)?=(\d+)/);
    return m ? m[1] : '';
  }
  async function getMyUid() {
    const cookieUid = getUidFromCookie();
    if (cookieUid) return cookieUid;
    // 兜底：用当前域的同域接口（避免 m.douyin.com 下跨到 www 带不上登录 cookie）
    try {
      const r = await fetch(API + '/aweme/v1/web/commit/user/', { credentials: 'include' });
      const j = await r.json();
      if (j && j.user && j.user.uid) return String(j.user.uid);
    } catch (e) {}
    return '';
  }
  async function getFollowingList(myUid) {
    const out = [];
    let maxTime = 0;
    for (let page = 0; page < 40; page++) {
      let url = API + '/aweme/v1/web/user/following/list/?aid=6383&count=50' +
        '&user_id=' + encodeURIComponent(myUid) + '&source_type=1';
      if (maxTime) url += '&max_time=' + maxTime;
      let j = null;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) break;
        j = await r.json();
      } catch (e) { break; }
      const list = (j && j.following_list) || [];
      for (const a of list) { if (a && a.sec_uid) out.push({ sec_uid: a.sec_uid, nickname: a.nickname || a.unique_id || '未知' }); }
      if (!j || !j.has_more || !list.length) break;
      maxTime = j.max_time || (maxTime - 1);
    }
    return out;
  }
  async function getAccountPosts(secUid) {
    const out = [];
    let cursor = 0;
    for (let page = 0; page < 3; page++) {
      let url = API + '/aweme/v1/web/aweme/post/?aid=6383&count=35' +
        '&sec_user_id=' + encodeURIComponent(secUid);
      if (cursor) url += '&max_cursor=' + cursor;
      let j = null;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) break;
        j = await r.json();
      } catch (e) { break; }
      const arr = (j && j.aweme_list) || [];
      for (const a of arr) { const v = toVideo(a); if (v) out.push(v); }
      if (!j || !j.has_more || !arr.length) break;
      cursor = j.max_cursor || 0;
      if (!cursor) break;
    }
    return out;
  }
  async function runFullScanMobile() {
    setScanText('⏳ 准备中…');
    const myUid = await getMyUid();
    if (!myUid) {
      setScanText('⚠️ ' + (isLoggedIn() ? apiFailHint() : '检测到你尚未登录抖音，请先登录后再试。'));
      return;
    }
    const accounts = await getFollowingList(myUid);
    if (!accounts.length) { setScanText('⚠️ 失败：未读取到关注账号（接口可能被签名拦截，建议改用「关注」页下滑）'); return; }
    setScanText('⏳ 找到 ' + accounts.length + ' 个关注账号，开始逐个拉取…');
    let added = 0, failed = 0;
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        const vids = await getAccountPosts(acc.sec_uid);
        if (vids && vids.length) { capture(vids, true); added += vids.length; }
      } catch (e) { failed++; }
      setScanText('⏳ 拉取：' + acc.nickname + '（' + (i + 1) + '/' + accounts.length + '，新增 ' + added + '，跳过 ' + failed + '）');
      await sleep(200);
    }
    setScanText('✅ 扫描完成：新增 ' + added + ' 条，跳过 ' + failed + ' 个账号');
    render();
    setTimeout(function () { setScanText(''); }, 5000);
  }

  /* ---------------- 读取观看历史：用于推算"已读" ---------------- */
  async function getWatchHistory() {
    setScanText('⏳ 正在读取观看历史…');
    const ids = [];
    let cursor = '0';
    for (let page = 0; page < 80; page++) {
      const url = API + '/aweme/v1/web/history/read/?aid=6383&count=50&cursor=' +
        encodeURIComponent(cursor);
      let j = null;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) {
          setScanText('⚠️ 读取失败（HTTP ' + r.status + '）：' + (isLoggedIn() ? apiFailHint() : '检测到你尚未登录抖音，请先登录后再试。'));
          return;
        }
        j = await r.json();
      } catch (e) {
        setScanText('⚠️ 读取出错：' + e.message);
        return;
      }
      const pageIds = [];
      collectIds(j, pageIds);
      for (const id of pageIds) if (ids.indexOf(id) === -1) ids.push(id);
      setScanText('⏳ 已读取观看历史 ' + ids.length + ' 条（第 ' + (page + 1) + ' 页）…');
      const hasMore = !!(j && (j.has_more === 1 || j.has_more === true));
      const next = j && (j.cursor !== undefined ? j.cursor : (j.data && j.data.cursor));
      if (!hasMore || next === undefined || String(next) === String(cursor)) break;
      cursor = String(next);
      await sleep(120);
    }
    mergeWatched(ids);
    setScanText('✅ 已同步观看历史：' + ids.length + ' 条已看视频（它们会从「未读」中消失）');
    render();
    setTimeout(function () { setScanText(''); }, 6000);
  }

  /* ---------------- 移动端 UI ---------------- */
  let panelOpen = false;
  let fab, panel, listEl, statusEl, badgeEl;

  const CSS = `
  #dyFab{position:fixed;right:14px;bottom:84px;width:52px;height:52px;border-radius:50%;
    background:#fe2c55;color:#fff;font-size:22px;line-height:52px;text-align:center;
    box-shadow:0 4px 14px rgba(0,0,0,.4);z-index:2147483646;cursor:pointer;user-select:none;
    border:2px solid rgba(255,255,255,.85);}
  #dyBadge{position:absolute;top:-4px;right:-4px;background:#fff;color:#fe2c55;font-size:12px;
    font-weight:700;border-radius:10px;min-width:20px;height:20px;line-height:20px;text-align:center;
    padding:0 5px;box-shadow:0 1px 3px rgba(0,0,0,.3);}
  #dyPanel{position:fixed;left:0;right:0;bottom:0;max-height:82vh;background:#161823;color:#fff;
    border-radius:14px 14px 0 0;z-index:2147483647;transform:translateY(100%);
    transition:transform .25s ease;display:flex;flex-direction:column;
    box-shadow:0 -4px 20px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;}
  #dyPanel.open{transform:translateY(0);}
  .dyHd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
    border-bottom:1px solid #262a3b;}
  .dyHd b{font-size:15px;}
  .dyClose{font-size:20px;color:#9aa0b5;background:none;border:none;cursor:pointer;padding:0 6px;}
  .dyStatus{padding:8px 14px;font-size:12px;color:#9aa0b5;background:#1f2233;display:flex;
    align-items:center;justify-content:space-between;}
  .dyStatus .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#666;margin-right:6px;vertical-align:middle;}
  .dyStatus .dot.on{background:#22c55e;}
  .dyList{flex:1;overflow-y:auto;padding:4px 14px 8px;-webkit-overflow-scrolling:touch;}
  .dyEmpty{text-align:center;opacity:.6;padding:40px 10px;line-height:1.7;}
  .dyCard{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #262a3b;}
  .dyThumb{width:64px;height:84px;flex:0 0 64px;border-radius:8px;object-fit:cover;
    background:linear-gradient(135deg,#2a2d40,#3a3d52);}
  .dyPh{width:64px;height:84px;flex:0 0 64px;border-radius:8px;background:linear-gradient(135deg,#fe2c55,#f0385e);
    display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;}
  .dyMeta{flex:1;min-width:0;}
  .dyAuthor{font-weight:600;margin-bottom:3px;}
  .dyDesc{font-size:12px;opacity:.8;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;
    -webkit-box-orient:vertical;overflow:hidden;margin-bottom:6px;}
  .dyTime{font-size:11px;opacity:.5;margin-bottom:6px;}
  .dyOpen{color:#fe2c55;font-size:12px;text-decoration:none;margin-right:14px;}
  .dyMk{color:#9aa0b5;font-size:12px;background:none;border:none;padding:0;cursor:pointer;}
  .dyMk:hover{color:#fff;}
  .dyFt{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #262a3b;background:#1f2233;}
  .dyBtn{flex:1;border:none;border-radius:8px;padding:10px;font-size:13px;cursor:pointer;
    background:#2a2d40;color:#fff;}
  .dyBtn.primary{background:#fe2c55;font-weight:600;}
  .dyBtn.ghost{background:transparent;border:1px solid #3a3d52;}
  .dySummary{padding:8px 14px;font-size:12px;color:#9aa0b5;background:#1f2233;border-bottom:1px solid #262a3b;}
  .dyScanStatus{padding:8px 14px;font-size:12px;color:#ffd166;background:#2a2d40;border-bottom:1px solid #262a3b;line-height:1.5;}
  .dyCatHd{padding:8px 14px;font-size:12px;font-weight:700;color:#fe2c55;background:#161823;position:sticky;top:0;z-index:1;border-bottom:1px solid #262a3b;}
  .dyAcc{border-bottom:1px solid #262a3b;}
  .dyAccHd{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;}
  .dyAvatar{width:34px;height:34px;border-radius:50%;background:#fe2c55;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:0 0 34px;font-size:15px;}
  .dyAccName{flex:1;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .dyAccCount{background:#fe2c55;color:#fff;border-radius:10px;padding:1px 9px;font-size:12px;font-weight:700;min-width:20px;text-align:center;}
  .dyAccActions{display:flex;gap:6px;}
  .dyMini{background:#2a2d40;color:#fff;border:none;border-radius:6px;padding:5px 9px;font-size:11px;cursor:pointer;}
  .dyMini.cat{background:transparent;border:1px solid #3a3d52;color:#9aa0b5;}
  .dyAccBody{padding:0 14px 12px;}
  .dyThumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
  .dyThumbWrap{position:relative;display:block;border-radius:6px;overflow:hidden;background:#2a2d40;}
  .dyThumbWrap img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;}
  .dyPh2{width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fe2c55,#f0385e);color:#fff;font-size:18px;}
  .dyThumbMk{position:absolute;right:2px;bottom:2px;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:4px;font-size:10px;padding:2px 5px;cursor:pointer;}
  `;

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = document.createElement('div');
    fab.id = 'dyFab';
    fab.innerHTML = '▶<span id="dyBadge" style="display:none"></span>';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    badgeEl = fab.querySelector('#dyBadge');

    panel = document.createElement('div');
    panel.id = 'dyPanel';
    panel.innerHTML =
      '<div class="dyHd"><b>抖音关注 · 未读</b><button class="dyClose" id="dyClose">×</button></div>' +
      '<div class="dyStatus"><span><span class="dot" id="dyDot"></span><span id="dyStatusText">未记录</span></span>' +
      '<span id="dyCount"></span></div>' +
      '<div class="dySummary" id="dySummary"></div>' +
      '<div class="dyScanStatus" id="dyScanStatus" style="display:none"></div>' +
      '<div class="dyList" id="dyList"></div>' +
      '<div class="dyFt">' +
      '<button class="dyBtn primary" id="dyRec">开始记录</button>' +
      '<button class="dyBtn" id="dyScanAll">扫描全部关注</button>' +
      '<button class="dyBtn" id="dySync">同步已读</button>' +
      '<button class="dyBtn ghost" id="dyReadAll">全部已读</button>' +
      '<button class="dyBtn ghost" id="dyClear">清除已读</button>' +
      '</div>';
    document.body.appendChild(panel);
    listEl = panel.querySelector('#dyList');
    statusEl = panel.querySelector('#dyStatusText');

    panel.querySelector('#dyClose').addEventListener('click', togglePanel);
    panel.querySelector('#dyRec').addEventListener('click', toggleRec);
    panel.querySelector('#dyScanAll').addEventListener('click', function () {
      const s = panel.querySelector('#dyScanStatus'); if (s) s.style.display = 'block';
      runFullScanMobile();
    });
    panel.querySelector('#dyReadAll').addEventListener('click', function () { markAllRead(); });
    panel.querySelector('#dyClear').addEventListener('click', function () { clearRead(); });
    panel.querySelector('#dySync').addEventListener('click', function () {
      const s = panel.querySelector('#dyScanStatus'); if (s) s.style.display = 'block';
      getWatchHistory();
    });

    updateBadge();
    updateRecUI();
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) render();
  }
  function toggleRec() {
    // 手动记录开关：若当前在关注页则无需手动；否则切换手动记录
    setManualRecording(!isManualRecording());
    updateRecUI();
    render();
  }
  function updateRecUI() {
    const on = isManualRecording() || isFollowUrl();
    const dot = panel.querySelector('#dyDot');
    const txt = panel.querySelector('#dyStatusText');
    const btn = panel.querySelector('#dyRec');
    dot.classList.toggle('on', on);
    if (isFollowUrl()) { txt.textContent = '记录中：关注页'; btn.textContent = '停止记录'; }
    else if (isManualRecording()) { txt.textContent = '记录中：手动'; btn.textContent = '停止记录'; }
    else { txt.textContent = '未记录（去关注页或点开始）'; btn.textContent = '开始记录'; }
  }
  function updateBadge() {
    const n = getUnread().length;
    if (!badgeEl) return;
    if (n > 0) { badgeEl.style.display = 'block'; badgeEl.textContent = n > 99 ? '99+' : String(n); }
    else { badgeEl.style.display = 'none'; }
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const d = Math.floor(Date.now() / 1000) - Number(ts);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }
  function buildGroups(unread) {
    const cats = {};
    for (const v of unread) {
      const key = accKey(v);
      const cat = v.cat || '未分类';
      if (!cats[cat]) cats[cat] = {};
      if (!cats[cat][key]) cats[cat][key] = { key: key, name: v.author || '未知作者', authorId: v.authorId || '', items: [], latest: 0 };
      cats[cat][key].items.push(v);
      cats[cat][key].latest = Math.max(cats[cat][key].latest, v.createTime || 0);
    }
    const result = {};
    for (const c in cats) {
      result[c] = Object.values(cats[c]).sort(function (a, b) { return (b.items.length - a.items.length) || ((b.latest || 0) - (a.latest || 0)); });
    }
    const names = Object.keys(result).sort(function (a, b) {
      if (a === '未分类') return 1; if (b === '未分类') return -1;
      return a.localeCompare(b, 'zh');
    });
    return { cats: result, names: names };
  }

  function renderAccount(acc) {
    const wrap = document.createElement('div'); wrap.className = 'dyAcc';
    const hd = document.createElement('div'); hd.className = 'dyAccHd';
    const av = document.createElement('div'); av.className = 'dyAvatar'; av.textContent = (acc.name || '?').slice(0, 1);
    const name = document.createElement('div'); name.className = 'dyAccName'; name.textContent = acc.name;
    const cnt = document.createElement('div'); cnt.className = 'dyAccCount'; cnt.textContent = acc.items.length;
    const actions = document.createElement('div'); actions.className = 'dyAccActions';
    const bAll = document.createElement('button'); bAll.className = 'dyMini'; bAll.textContent = '全部已读';
    bAll.addEventListener('click', function (e) { e.stopPropagation(); markAccountRead(acc.key); });
    const bCat = document.createElement('button'); bCat.className = 'dyMini cat'; bCat.textContent = '分类';
    bCat.addEventListener('click', function (e) {
      e.stopPropagation();
      const c = window.prompt('为该账号设置分类（如：美食 / 科技）：', '未分类');
      if (c != null) setAccountCat(acc.key, (c.trim() || '未分类'));
    });
    actions.appendChild(bAll); actions.appendChild(bCat);
    hd.appendChild(av); hd.appendChild(name); hd.appendChild(cnt); hd.appendChild(actions);
    const body = document.createElement('div'); body.className = 'dyAccBody';
    const grid = document.createElement('div'); grid.className = 'dyThumbs';
    acc.items.forEach(function (v) {
      const a = document.createElement('a'); a.className = 'dyThumbWrap'; a.href = v.url; a.target = '_blank'; a.rel = 'noopener'; a.title = (v.desc || v.author || '');
      if (v.cover) {
        const img = document.createElement('img'); img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = v.cover; img.alt = v.author;
        img.onerror = function () { const ph = document.createElement('div'); ph.className = 'dyPh2'; ph.textContent = '▶'; img.replaceWith(ph); };
        a.appendChild(img);
      } else {
        const ph = document.createElement('div'); ph.className = 'dyPh2'; ph.textContent = '▶'; a.appendChild(ph);
      }
      const mk = document.createElement('button'); mk.className = 'dyThumbMk'; mk.textContent = '✓'; mk.title = '标记已读';
      mk.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); markRead(v.id); });
      a.appendChild(mk);
      grid.appendChild(a);
    });
    body.appendChild(grid);
    hd.addEventListener('click', function () { body.style.display = (body.style.display === 'none') ? '' : 'none'; });
    wrap.appendChild(hd); wrap.appendChild(body);
    return wrap;
  }

  function render() {
    if (!listEl) return;
    updateRecUI();
    const unread = getUnread();
    panel.querySelector('#dyCount').textContent = '未读 ' + unread.length;
    const accCount = new Set(unread.map(accKey)).size;
    const watched = loadWatched().size;
    const sumEl = panel.querySelector('#dySummary');
    if (sumEl) sumEl.textContent = unread.length
      ? (accCount + ' 个账号有未读 · 共 ' + unread.length + ' 条（已看历史 ' + watched + ' 条）')
      : '没有未读视频（已看历史 ' + watched + ' 条）';
    listEl.innerHTML = '';
    if (!unread.length) {
      const e = document.createElement('div');
      e.className = 'dyEmpty';
      e.innerHTML = '暂无未读视频。<br/>打开抖音「关注」页，确保状态为「记录中」，下滑加载视频即可。';
      listEl.appendChild(e);
      return;
    }
    const g = buildGroups(unread);
    for (const cat of g.names) {
      const accounts = g.cats[cat];
      let cAcc = 0, cUnread = 0;
      accounts.forEach(function (a) { cAcc++; cUnread += a.items.length; });
      const catHd = document.createElement('div'); catHd.className = 'dyCatHd';
      catHd.textContent = cat + ' · ' + cAcc + ' 个账号 / ' + cUnread + ' 条未读';
      listEl.appendChild(catHd);
      accounts.forEach(function (acc) { listEl.appendChild(renderAccount(acc)); });
    }
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    installFetchHook();
    installXHRHook();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        buildUI();
        if (isFollowUrl()) scanDOM();
      });
    } else {
      buildUI();
      if (isFollowUrl()) scanDOM();
    }
    // 周期性 DOM 兜底扫描 + 同步记录状态
    setInterval(function () {
      if (isFollowUrl()) scanDOM();
      if (panelOpen) updateRecUI();
    }, 5000);
    // 路由变化时同步 UI
    let lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) { lastHref = location.href; if (panelOpen) updateRecUI(); }
    }, 1000);
  }

  start();
})();
