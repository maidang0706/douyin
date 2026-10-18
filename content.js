/*
 * 抖音关注未读视频助手 —— 内容脚本（运行于页面 MAIN 世界）
 *
 * 职责：
 *  1. 拦截抖音网页自身发出的接口请求（fetch / XHR），从 JSON 中提取视频信息；
 *  2. 作为兜底，对「关注」页已渲染的 DOM 进行扫描，提取视频卡片；
 *  3. 把抓取到的视频发送给后台（background.js）做去重与「未读」判定；
 *  4. 响应弹窗发来的 SCAN_NOW 指令，立即重新扫描。
 *
 * 注意：本脚本运行在页面主世界，因此可以劫持页面自身的 window.fetch / XMLHttpRequest，
 * 从而拿到接口返回的完整数据（比单纯解析 DOM 更稳定）。
 */
(function () {
  'use strict';

  const isExtension = !!(
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    chrome.runtime.id
  );

  // 仅当处于抖音域名下才工作
  const onDouyin = /douyin\.com/.test(location.hostname);
  if (!onDouyin) return;

  /* ---------------- 工具函数 ---------------- */

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
      firstUrl(video.cover) ||
      firstUrl(video.origin_cover) ||
      firstUrl(video.dynamic_cover) ||
      firstUrl(a.cover) ||
      '';
    const desc = (a.desc || a.descr || a.caption || '').toString().trim();
    const authorName =
      author.nickname || author.nick_name || author.unique_id || author.short_id || '未知作者';
    const authorId = author.uid || author.sec_uid || author.unique_id || '';
    return {
      id,
      author: authorName,
      authorId,
      desc,
      cover,
      url: 'https://www.douyin.com/video/' + id,
      createTime: Number(a.create_time || a.createTime || Math.floor(Date.now() / 1000)),
    };
  }

  // 递归从接口 JSON 中收集所有包含 aweme_id 的对象
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
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          collectAwemes(node[k], depth + 1, out);
        }
      }
    }
  }

  function dedupe(videos) {
    const seen = new Set();
    const result = [];
    for (const v of videos) {
      if (!v || !v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      result.push(v);
    }
    return result;
  }

  function parseAndSend(data) {
    try {
      const raw = [];
      collectAwemes(data, 0, raw);
      const videos = dedupe(raw);
      if (videos.length) sendVideos(videos);
    } catch (e) {
      /* 忽略解析异常 */
    }
  }

  function sendVideos(videos) {
    if (!isExtension) return;
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE', videos }, function () {
        // 忽略返回值 / 未监听的情况
        if (chrome.runtime.lastError) {
          /* noop */
        }
      });
    } catch (e) {
      /* noop */
    }
  }

  // 把"已看视频 ID 集合"发给后台（来自观看历史）
  function sendWatched(ids) {
    if (!isExtension) return;
    try {
      chrome.runtime.sendMessage({ type: 'SET_WATCHED', ids: ids }, function () {
        if (chrome.runtime.lastError) { /* noop */ }
      });
    } catch (e) { /* noop */ }
  }

  // 递归收集响应里出现的所有 aweme_id（无论接口把视频套在 aweme_info / aweme_list / 任意层级）
  function collectIds(node, out) {
    if (!node || out.length > 6000) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectIds(node[i], out);
      return;
    }
    if (typeof node === 'object') {
      const id = node.aweme_id || node.awemeId || node.item_id || node.aweme_id_str;
      if (id && String(id) !== '0') {
        const s = String(id);
        if (out.indexOf(s) === -1) out.push(s);
      }
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) collectIds(node[k], out);
      }
    }
  }

  /* ---------------- 接口请求劫持 ---------------- */

  function installFetchHook() {
    if (window.__dyFetchHooked) return;
    window.__dyFetchHooked = true;
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!origFetch) return;
    window.fetch = function (input, init) {
      const p = origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
        if (url && url.includes('douyin.com')) {
          // 观看历史：把看过的视频 ID 发给后台（用于推算"已读"）
          if (url.indexOf('history/read') !== -1) {
            p.then(function (resp) {
              try {
                const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
                if (ct && ct.indexOf('json') !== -1) {
                  resp.clone().json().then(function (j) {
                    const ids = [];
                    collectIds(j, ids);
                    if (ids.length) sendWatched(ids);
                  }).catch(function () {});
                }
              } catch (e) {}
            }).catch(function () {});
          } else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) {
            p.then(function (resp) {
              try {
                const clone = resp.clone();
                const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
                if (ct && ct.indexOf('json') !== -1) {
                  clone.json().then(parseAndSend).catch(function () {});
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
    if (window.__dyXHRHooked) return;
    window.__dyXHRHooked = true;
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dyUrl = typeof url === 'string' ? url : '';
      return OrigOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const url = this.__dyUrl || '';
          if (url && url.includes('douyin.com')) {
            const ct = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
            if (ct && ct.indexOf('json') !== -1) {
              if (url.indexOf('history/read') !== -1) {
                const ids = [];
                collectIds(JSON.parse(this.responseText), ids);
                if (ids.length) sendWatched(ids);
              } else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) {
                parseAndSend(JSON.parse(this.responseText));
              }
            }
          }
        } catch (e) {}
      });
      return OrigSend.apply(this, arguments);
    };
  }

  /* ---------------- DOM 扫描（兜底） ---------------- */

  function isFollowPage() {
    return /\/follow|following/.test(location.pathname) || location.href.includes('/follow');
  }

  function scanDOM() {
    if (!isExtension) return;
    try {
      const anchors = document.querySelectorAll('a[href*="/video/"]');
      if (!anchors.length) return;
      const videos = [];
      anchors.forEach(function (a) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/video\/(\d+)/);
        if (!m) return;
        const id = m[1];
        // 向上找一个合理的卡片容器
        let card = a;
        for (let i = 0; i < 4 && card; i++) {
          if (card.classList && (card.classList.contains('video-card') || card.tagName === 'LI' || card.tagName === 'ARTICLE')) break;
          card = card.parentElement;
        }
        const imgEl = a.querySelector('img') || (card ? card.querySelector('img') : null);
        let author = '未知作者';
        if (card) {
          const ae = card.querySelector('[class*="author"],[class*="nickname"],[class*="name"]');
          if (ae && ae.textContent) author = ae.textContent.trim().slice(0, 40);
        }
        videos.push({
          id,
          author,
          authorId: '',
          desc: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 120),
          cover: imgEl ? imgEl.getAttribute('src') || imgEl.src || '' : '',
          url: 'https://www.douyin.com/video/' + id,
          createTime: Math.floor(Date.now() / 1000),
        });
      });
      const deduped = dedupe(videos);
      if (deduped.length) sendVideos(deduped);
    } catch (e) {}
  }

  /* ---------------- 全量扫描：枚举关注账号并逐个拉取视频 ---------------- */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function reportScan(status) {
    if (!isExtension) return;
    try { chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', status: status }); } catch (e) {}
  }

  function reportReadSync(status) {
    if (!isExtension) return;
    try { chrome.runtime.sendMessage({ type: 'READ_SYNC_PROGRESS', status: status }); } catch (e) {}
  }

  // 获取当前登录用户的 uid（用于拉取关注列表）
  async function getMyUid() {
    try {
      const r = await fetch('https://www.douyin.com/aweme/v1/web/commit/user/', { credentials: 'include' });
      const j = await r.json();
      if (j && j.user && j.user.uid) return String(j.user.uid);
    } catch (e) {}
    return '';
  }

  // 分页拉取“我关注的账号”列表
  async function getFollowingList(myUid) {
    const out = [];
    let maxTime = 0;
    for (let page = 0; page < 40; page++) {
      let url = 'https://www.douyin.com/aweme/v1/web/user/following/list/?aid=6383&count=50' +
        '&user_id=' + encodeURIComponent(myUid) + '&source_type=1';
      if (maxTime) url += '&max_time=' + maxTime;
      let j = null;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) break;
        j = await r.json();
      } catch (e) { break; }
      const list = (j && j.following_list) || [];
      for (const a of list) {
        if (a && a.sec_uid) out.push({ sec_uid: a.sec_uid, nickname: a.nickname || a.unique_id || '未知' });
      }
      if (!j || !j.has_more || !list.length) break;
      maxTime = j.max_time || (maxTime - 1);
    }
    return out;
  }

  // 拉取单个账号的作品列表（最多 3 页，约 100 条）
  async function getAccountPosts(secUid) {
    const out = [];
    let cursor = 0;
    for (let page = 0; page < 3; page++) {
      let url = 'https://www.douyin.com/aweme/v1/web/aweme/post/?aid=6383&count=35' +
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

  // 全量扫描主流程：枚举关注账号 → 逐个拉取视频 → 上报进度
  async function runFullScan() {
    reportScan({ active: true, phase: '准备中…', current: 0, total: 0, added: 0, failed: 0, done: false });
    const myUid = await getMyUid();
    if (!myUid) {
      reportScan({ active: false, phase: '失败：无法获取你的账号（请确认已登录抖音网页版）', current: 0, total: 0, added: 0, failed: 0, done: true, error: true });
      return;
    }
    const accounts = await getFollowingList(myUid);
    if (!accounts.length) {
      reportScan({ active: false, phase: '失败：未读取到关注账号（接口可能被签名拦截，建议改用「关注」页下滑）', current: 0, total: 0, added: 0, failed: 0, done: true, error: true });
      return;
    }
    reportScan({ active: true, phase: '找到 ' + accounts.length + ' 个关注账号，开始逐个拉取…', current: 0, total: accounts.length, added: 0, failed: 0, done: false });
    let added = 0, failed = 0;
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        const vids = await getAccountPosts(acc.sec_uid);
        if (vids && vids.length) { sendVideos(vids); added += vids.length; }
      } catch (e) { failed++; }
      reportScan({ active: true, phase: '拉取：' + acc.nickname, current: i + 1, total: accounts.length, added: added, failed: failed, done: false });
      await sleep(200);
    }
    reportScan({ active: false, phase: '扫描完成：新增 ' + added + ' 条，跳过 ' + failed + ' 个账号', current: accounts.length, total: accounts.length, added: added, failed: failed, done: true });
  }

  /* ---------------- 读取观看历史：用于推算"已读" ---------------- */

  // 分页拉取"观看历史"（/aweme/v1/web/history/read/），收集所有看过的视频 ID。
  // 抖音真实的"已看"信号就在这里；一个视频只要出现在历史里，就视为已读。
  async function getWatchHistory() {
    const ids = [];
    let cursor = '0';
    let pages = 0;
    for (let page = 0; page < 80; page++) {
      pages++;
      let url = 'https://www.douyin.com/aweme/v1/web/history/read/?aid=6383&count=50&cursor=' +
        encodeURIComponent(cursor);
      let j = null;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) {
          reportReadSync({ active: false, done: true, error: true, added: ids.length,
            phase: '读取观看历史失败（HTTP ' + r.status + '）：接口可能被签名拦截。可手动打开抖音「观看历史」页，本插件会自动捕获。' });
          return;
        }
        j = await r.json();
      } catch (e) {
        reportReadSync({ active: false, done: true, error: true, added: ids.length,
          phase: '读取观看历史出错：' + e.message });
        return;
      }
      const pageIds = [];
      collectIds(j, pageIds);
      for (const id of pageIds) if (ids.indexOf(id) === -1) ids.push(id);
      reportReadSync({ active: true, done: false, error: false, added: ids.length,
        phase: '已读取观看历史 ' + ids.length + ' 条（第 ' + pages + ' 页）…' });
      const hasMore = !!(j && (j.has_more === 1 || j.has_more === true));
      const next = j && (j.cursor !== undefined ? j.cursor : (j.data && j.data.cursor));
      if (!hasMore || next === undefined || String(next) === String(cursor)) break;
      cursor = String(next);
      await sleep(120);
    }
    sendWatched(ids);
    reportReadSync({ active: false, done: true, error: false, added: ids.length,
      phase: '已同步观看历史：' + ids.length + ' 条已看视频（它们会从「未读」中消失）' });
  }

  /* ---------------- 启动与调度 ---------------- */

  function start() {
    installFetchHook();
    installXHRHook();

    // 在「关注」页周期性扫描 DOM（兜底 + 捕获已渲染但未走接口的内容）
    setInterval(function () {
      if (isFollowPage()) scanDOM();
    }, 5000);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (isFollowPage()) scanDOM();
      });
    } else if (isFollowPage()) {
      scanDOM();
    }
  }

  if (isExtension) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'SCAN_NOW') {
        installFetchHook();
        installXHRHook();
        scanDOM();
        try { sendResponse({ ok: true }); } catch (e) {}
        return true;
      }
      if (msg && msg.type === 'FULL_SCAN') {
        installFetchHook();
        installXHRHook();
        runFullScan();
        try { sendResponse({ ok: true }); } catch (e) {}
        return true;
      }
      if (msg && msg.type === 'SYNC_READ') {
        installFetchHook();
        installXHRHook();
        getWatchHistory();
        try { sendResponse({ ok: true }); } catch (e) {}
        return true;
      }
      return false;
    });
  }

  start();
})();
