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
        if (url && url.includes('douyin.com') && /feed|aweme|following|follow|recommend|refresh/.test(url)) {
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
          if (url && url.includes('douyin.com') && /feed|aweme|following|follow|recommend|refresh/.test(url)) {
            const ct = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
            if (ct && ct.indexOf('json') !== -1) {
              const data = JSON.parse(this.responseText);
              parseAndSend(data);
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
      return false;
    });
  }

  start();
})();
