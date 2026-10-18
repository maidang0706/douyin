/*
 * 抖音关注未读视频助手 —— 弹窗逻辑
 *
 * 支持两种运行环境：
 *  1. 作为扩展弹窗运行（chrome.runtime.id 存在）：与 background.js 通信；
 *  2. 作为普通网页预览运行（用 present_files 直接打开）：使用 localStorage + 内置示例数据，
 *     便于在没有抖音账号的情况下查看 UI 效果。
 */
'use strict';

const isExtension = !!(
  typeof chrome !== 'undefined' &&
  chrome.runtime &&
  chrome.runtime.id
);

/* ---------------- 后端抽象 ---------------- */

function sendMessage(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (resp) {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || {});
      }
    });
  });
}

const chromeBackend = {
  getState: function () { return sendMessage({ type: 'GET_STATE' }); },
  markRead: function (id) { return sendMessage({ type: 'MARK_READ', id: id }); },
  markAllRead: function () { return sendMessage({ type: 'MARK_ALL_READ' }); },
  clearRead: function () { return sendMessage({ type: 'CLEAR_READ' }); },
  scanNow: function () { return sendMessage({ type: 'SCAN_NOW' }); },
};

// 预览模式后端（localStorage + 示例数据）
const mockBackend = (function () {
  const KEY = 'dy_mock_state_v1';
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
  function seed() {
    const now = Math.floor(Date.now() / 1000);
    const items = [
      { id: 'm1', author: '摄影日记', authorId: '', desc: '今天的日落真的绝了，分享给大家🌅', cover: '', url: 'https://www.douyin.com/video/m1', createTime: now - 1800, seenAt: Date.now(), read: false },
      { id: 'm2', author: '代码星球', authorId: '', desc: '30 行实现一个迷你状态管理，建议收藏', cover: '', url: 'https://www.douyin.com/video/m2', createTime: now - 7200, seenAt: Date.now(), read: false },
      { id: 'm3', author: '猫咪日常', authorId: '', desc: '它又胖了三斤，但我还是好爱它🐱', cover: '', url: 'https://www.douyin.com/video/m3', createTime: now - 18000, seenAt: Date.now(), read: false },
      { id: 'm4', author: '旅行手帐', authorId: '', desc: '周末去了趟海边，附详细攻略', cover: '', url: 'https://www.douyin.com/video/m4', createTime: now - 86400, seenAt: Date.now(), read: true },
    ];
    const store = {};
    items.forEach(function (v) { store[v.id] = v; });
    const state = computeState(store, {});
    save(state);
    return state;
  }
  function computeState(store, settings) {
    const all = Object.values(store);
    const unread = all
      .filter(function (v) { return !v.read; })
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    const readCount = all.filter(function (v) { return v.read; }).length;
    return {
      unread: unread,
      stats: { total: all.length, unread: unread.length, read: readCount },
      settings: settings || { autoScan: true, keepReadDays: 7 },
      __store: store,
    };
  }
  function getState() {
    const s = load() || seed();
    return Promise.resolve(computeState(s.__store, s.settings));
  }
  function persist(state) { save(state); }
  function mutate(fn) {
    const s = load() || seed();
    fn(s.__store);
    const ns = computeState(s.__store, s.settings);
    persist(ns);
    return Promise.resolve(ns);
  }
  return {
    getState: getState,
    markRead: function (id) {
      return mutate(function (store) { if (store[id]) store[id].read = true; });
    },
    markAllRead: function () {
      return mutate(function (store) { for (const k in store) store[k].read = true; });
    },
    clearRead: function () {
      return mutate(function (store) { for (const k in store) if (store[k].read) delete store[k]; });
    },
    scanNow: function () { return Promise.resolve({ ok: true, mock: true }); },
  };
})();

const backend = isExtension ? chromeBackend : mockBackend;

/* ---------------- 渲染 ---------------- */

const $ = function (id) { return document.getElementById(id); };

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

function render(state) {
  const unread = (state && state.unread) || [];
  const stats = (state && state.stats) || { total: 0, unread: 0, read: 0 };

  $('badge').textContent = stats.unread > 99 ? '99+' : String(stats.unread);
  $('stUnread').textContent = stats.unread;
  $('stRead').textContent = stats.read;
  $('stTotal').textContent = stats.total;

  const list = $('list');
  list.innerHTML = '';

  if (!unread.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '暂无未读视频。<br />打开抖音「关注」页并下滑，新视频会自动出现在这里。';
    list.appendChild(empty);
    return;
  }

  unread.forEach(function (v) {
    const card = document.createElement('div');
    card.className = 'card';

    // 封面（带防盗链与加载失败兜底）
    if (v.cover) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = v.cover;
      img.alt = v.author || '';
      img.onerror = function () {
        const ph = document.createElement('div');
        ph.className = 'thumb-ph';
        ph.textContent = '▶';
        img.replaceWith(ph);
      };
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb-ph';
      ph.textContent = '▶';
      card.appendChild(ph);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';

    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = v.author || '未知作者';
    meta.appendChild(author);

    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = v.desc || '(无文案)';
    meta.appendChild(desc);

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = timeAgo(v.createTime);
    meta.appendChild(time);

    const links = document.createElement('div');
    const open = document.createElement('a');
    open.className = 'open';
    open.href = v.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '打开视频';
    links.appendChild(open);

    const mk = document.createElement('button');
    mk.className = 'mk';
    mk.textContent = '标记已读';
    mk.addEventListener('click', function () {
      backend.markRead(v.id).then(refresh);
    });
    links.appendChild(mk);

    meta.appendChild(links);
    card.appendChild(meta);
    list.appendChild(card);
  });
}

function refresh() {
  backend.getState().then(function (state) {
    if (state && state.error) {
      showHint('加载失败：' + state.error);
      return;
    }
    render(state);
  });
}

let hintTimer = null;
function showHint(text) {
  const h = $('hint');
  h.textContent = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(function () { h.textContent = ''; }, 2500);
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('btnScan').addEventListener('click', function () {
    backend.scanNow().then(function (r) {
      if (r && r.ok) showHint('已发送扫描指令');
      else showHint('请先打开抖音网页');
      setTimeout(refresh, 600);
    });
  });

  $('btnOpen').addEventListener('click', function () {
    if (isExtension) {
      chrome.tabs.create({ url: 'https://www.douyin.com/follow' });
    } else {
      window.open('https://www.douyin.com/follow', '_blank');
    }
  });

  $('btnReadAll').addEventListener('click', function () {
    backend.markAllRead().then(refresh);
  });

  $('btnClear').addEventListener('click', function () {
    backend.clearRead().then(refresh);
  });
}

bind();
refresh();
