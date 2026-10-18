/*
 * 抖音关注未读视频助手 —— 弹窗逻辑
 *
 * 支持两种运行环境：
 *  1. 作为扩展弹窗运行（chrome.runtime.id 存在）：与 background.js 通信；
 *  2. 作为普通网页预览运行（用 present_files 直接打开）：使用 localStorage + 内置示例数据，
 *     便于在没有抖音账号的情况下查看 UI 效果。
 *
 * 展示方式：按「分类 → 账号」两级分组，每个账号显示未读数量（红色角标）。
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
  markAccountRead: function (key) { return sendMessage({ type: 'MARK_ACCOUNT_READ', key: key }); },
  setAccountCat: function (key, cat) { return sendMessage({ type: 'SET_ACCOUNT_CAT', key: key, cat: cat }); },
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
      { id: 'm1', author: '摄影日记', authorId: 'u_photo', cat: '摄影', desc: '今天的日落真的绝了，分享给大家🌅', cover: '', url: 'https://www.douyin.com/video/m1', createTime: now - 1800, seenAt: Date.now(), read: false },
      { id: 'm1b', author: '摄影日记', authorId: 'u_photo', cat: '摄影', desc: '城市夜景延时摄影教程', cover: '', url: 'https://www.douyin.com/video/m1b', createTime: now - 3600, seenAt: Date.now(), read: false },
      { id: 'm2', author: '代码星球', authorId: 'u_code', cat: '编程', desc: '30 行实现一个迷你状态管理，建议收藏', cover: '', url: 'https://www.douyin.com/video/m2', createTime: now - 7200, seenAt: Date.now(), read: false },
      { id: 'm3', author: '猫咪日常', authorId: 'u_cat', cat: '萌宠', desc: '它又胖了三斤，但我还是好爱它🐱', cover: '', url: 'https://www.douyin.com/video/m3', createTime: now - 18000, seenAt: Date.now(), read: false },
      { id: 'm4', author: '旅行手帐', authorId: 'u_trip', cat: '摄影', desc: '周末去了趟海边，附详细攻略', cover: '', url: 'https://www.douyin.com/video/m4', createTime: now - 86400, seenAt: Date.now(), read: true },
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
  function accKey(v) { return v.authorId ? v.authorId : ('n:' + (v.author || '未知作者')); }
  function getState() {
    const s = load() || seed();
    return Promise.resolve(computeState(s.__store, s.settings));
  }
  function mutate(fn) {
    const s = load() || seed();
    fn(s.__store);
    const ns = computeState(s.__store, s.settings);
    save(ns);
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
    markAccountRead: function (key) {
      return mutate(function (store) {
        for (const k in store) if (accKey(store[k]) === key) store[k].read = true;
      });
    },
    setAccountCat: function (key, cat) {
      return mutate(function (store) {
        for (const k in store) if (accKey(store[k]) === key) store[k].cat = cat || '未分类';
      });
    },
    clearRead: function () {
      return mutate(function (store) { for (const k in store) if (store[k].read) delete store[k]; });
    },
    scanNow: function () { return Promise.resolve({ ok: true, mock: true }); },
  };
})();

const backend = isExtension ? chromeBackend : mockBackend;

/* ---------------- 工具 ---------------- */

const $ = function (id) { return document.getElementById(id); };

function accKey(v) { return v.authorId ? v.authorId : ('n:' + (v.author || '未知作者')); }

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

/* ---------------- 分组构建 ---------------- */

function buildGroups(unread) {
  const cats = {};
  for (const v of unread) {
    const key = accKey(v);
    const cat = v.cat || '未分类';
    if (!cats[cat]) cats[cat] = {};
    if (!cats[cat][key]) {
      cats[cat][key] = { key: key, name: v.author || '未知作者', authorId: v.authorId || '', items: [], latest: 0 };
    }
    cats[cat][key].items.push(v);
    cats[cat][key].latest = Math.max(cats[cat][key].latest, v.createTime || 0);
  }
  const result = {};
  for (const c in cats) {
    result[c] = Object.values(cats[c]).sort(function (a, b) {
      return (b.items.length - a.items.length) || ((b.latest || 0) - (a.latest || 0));
    });
  }
  const names = Object.keys(result).sort(function (a, b) {
    if (a === '未分类') return 1;
    if (b === '未分类') return -1;
    return a.localeCompare(b, 'zh');
  });
  return { cats: result, names: names };
}

/* ---------------- 渲染 ---------------- */

function renderAccount(acc) {
  const wrap = document.createElement('div');
  wrap.className = 'acc';

  const hd = document.createElement('div');
  hd.className = 'acc-hd';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = (acc.name || '?').slice(0, 1);
  const name = document.createElement('div');
  name.className = 'acc-name';
  name.textContent = acc.name;
  const cnt = document.createElement('div');
  cnt.className = 'acc-count';
  cnt.textContent = acc.items.length;
  const actions = document.createElement('div');
  actions.className = 'acc-actions';
  const bAll = document.createElement('button');
  bAll.className = 'mini-btn';
  bAll.textContent = '全部已读';
  bAll.addEventListener('click', function (e) { e.stopPropagation(); backend.markAccountRead(acc.key).then(refresh); });
  const bCat = document.createElement('button');
  bCat.className = 'mini-btn cat';
  bCat.textContent = '分类';
  bCat.addEventListener('click', function (e) {
    e.stopPropagation();
    const c = window.prompt('为该账号设置分类（如：美食 / 科技）：', '未分类');
    if (c != null) backend.setAccountCat(acc.key, (c.trim() || '未分类')).then(refresh);
  });
  actions.appendChild(bAll);
  actions.appendChild(bCat);
  hd.appendChild(av);
  hd.appendChild(name);
  hd.appendChild(cnt);
  hd.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'acc-body';
  const grid = document.createElement('div');
  grid.className = 'thumbs';
  acc.items.forEach(function (v) {
    const a = document.createElement('a');
    a.className = 'thumb-wrap';
    a.href = v.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = (v.desc || v.author || '');
    if (v.cover) {
      const img = document.createElement('img');
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
      a.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb-ph';
      ph.textContent = '▶';
      a.appendChild(ph);
    }
    const mk = document.createElement('button');
    mk.className = 'thumb-mk';
    mk.textContent = '✓';
    mk.title = '标记已读';
    mk.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      backend.markRead(v.id).then(refresh);
    });
    a.appendChild(mk);
    grid.appendChild(a);
  });
  body.appendChild(grid);

  // 默认展开；点击头部折叠/展开
  hd.addEventListener('click', function () {
    body.style.display = (body.style.display === 'none') ? '' : 'none';
  });

  wrap.appendChild(hd);
  wrap.appendChild(body);
  return wrap;
}

function render(state) {
  const unread = (state && state.unread) || [];
  const stats = (state && state.stats) || { total: 0, unread: 0, read: 0 };

  $('badge').textContent = stats.unread > 99 ? '99+' : String(stats.unread);
  $('stUnread').textContent = stats.unread;
  $('stRead').textContent = stats.read;
  $('stTotal').textContent = stats.total;

  const accCount = new Set(unread.map(accKey)).size;
  $('summary').textContent = unread.length
    ? (accCount + ' 个账号有未读 · 共 ' + unread.length + ' 条')
    : '没有未读视频';

  const groupsEl = $('groups');
  groupsEl.innerHTML = '';

  if (!unread.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '暂无未读视频。<br />打开抖音「关注」页并下滑，新视频会自动出现在这里。';
    groupsEl.appendChild(empty);
    return;
  }

  const g = buildGroups(unread);
  for (const cat of g.names) {
    const accounts = g.cats[cat];
    let cAcc = 0, cUnread = 0;
    accounts.forEach(function (a) { cAcc++; cUnread += a.items.length; });
    const catHd = document.createElement('div');
    catHd.className = 'cat-hd';
    catHd.textContent = cat + ' · ' + cAcc + ' 个账号 / ' + cUnread + ' 条未读';
    groupsEl.appendChild(catHd);
    accounts.forEach(function (acc) { groupsEl.appendChild(renderAccount(acc)); });
  }
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
