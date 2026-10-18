/*
 * 抖音关注未读视频助手 —— 后台 Service Worker
 *
 * 负责：
 *  - 接收内容脚本抓取到的视频，做去重与「未读」标记；
 *  - 维护本地存储（chrome.storage.local）：视频库 + 设置；
 *  - 向弹窗提供查询 / 标记已读 / 设置接口；
 *  - 更新工具栏角标（未读数）；
 *  - 定期清理已读已久的视频，避免存储无限增长。
 */
'use strict';

const VIDEOS_KEY = 'videos';
const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS = {
  autoScan: true, // 是否随页面自动抓取（预留，当前始终在抖音页抓取）
  keepReadDays: 7, // 已读视频保留天数后自动清理
};

// 全量扫描进度状态（由内容脚本实时上报）
let scanStatus = {
  active: false, phase: '', current: 0, total: 0, added: 0, failed: 0, done: false, error: false,
};

/* ---------------- 存储封装 ---------------- */

function getVideos() {
  return new Promise(function (res) {
    chrome.storage.local.get(VIDEOS_KEY, function (r) {
      res(r[VIDEOS_KEY] || {});
    });
  });
}
function saveVideos(v) {
  return new Promise(function (res) {
    chrome.storage.local.set({ [VIDEOS_KEY]: v }, res);
  });
}
function getSettings() {
  return new Promise(function (res) {
    chrome.storage.local.get(SETTINGS_KEY, function (r) {
      res(Object.assign({}, DEFAULT_SETTINGS, r[SETTINGS_KEY] || {}));
    });
  });
}
function saveSettings(s) {
  return new Promise(function (res) {
    chrome.storage.local.set({ [SETTINGS_KEY]: s }, res);
  });
}

/* ---------------- 业务逻辑 ---------------- */

async function capture(videos) {
  const store = await getVideos();
  const now = Date.now();
  let added = 0;
  for (const v of videos || []) {
    if (!v || !v.id) continue;
    if (!store[v.id]) {
      store[v.id] = {
        id: v.id,
        author: v.author || '未知作者',
        authorId: v.authorId || '',
        desc: v.desc || '',
        cover: v.cover || '',
        url: v.url || 'https://www.douyin.com/video/' + v.id,
        createTime: v.createTime || Math.floor(now / 1000),
        cat: v.cat || '未分类',
        seenAt: now,
        read: false,
      };
      added++;
    }
  }
  await saveVideos(store);
  await updateBadge(store);
  return { added: added, total: Object.keys(store).length };
}

async function getState() {
  const store = await getVideos();
  const settings = await getSettings();
  const all = Object.values(store);
  const unread = all
    .filter(function (v) { return !v.read; })
    .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
  const readCount = all.filter(function (v) { return v.read; }).length;
  return {
    unread: unread,
    stats: { total: all.length, unread: unread.length, read: readCount },
    settings: settings,
  };
}

async function markRead(id) {
  const store = await getVideos();
  if (store[id]) {
    store[id].read = true;
    store[id].readAt = Date.now();
  }
  await saveVideos(store);
  await updateBadge(store);
  return true;
}

async function markAllRead() {
  const store = await getVideos();
  const now = Date.now();
  for (const k in store) {
    if (!store[k].read) {
      store[k].read = true;
      store[k].readAt = now;
    }
  }
  await saveVideos(store);
  await updateBadge(store);
  return true;
}

async function clearRead() {
  const store = await getVideos();
  const out = {};
  for (const k in store) {
    if (!store[k].read) out[k] = store[k];
  }
  await saveVideos(out);
  await updateBadge(out);
  return true;
}

// 账号标识：优先用 authorId，缺失时退化为 "n:" + 昵称
function accountKeyOf(v) {
  return (v && v.authorId) ? v.authorId : ('n:' + (v.author || '未知作者'));
}

// 把某个账号的全部未读标记为已读
async function markAccountRead(key) {
  const store = await getVideos();
  const now = Date.now();
  for (const k in store) {
    const v = store[k];
    if (accountKeyOf(v) === key) {
      v.read = true;
      if (!v.readAt) v.readAt = now;
    }
  }
  await saveVideos(store);
  await updateBadge(store);
  return true;
}

// 为某个账号设置/修改分类（会同步到该账号下的所有视频）
async function setAccountCat(key, cat) {
  const store = await getVideos();
  const c = cat || '未分类';
  for (const k in store) {
    const v = store[k];
    if (accountKeyOf(v) === key) v.cat = c;
  }
  await saveVideos(store);
  return true;
}

async function cleanup() {
  const settings = await getSettings();
  const days = Number(settings.keepReadDays) || 7;
  const cutoff = Date.now() - days * 86400000;
  const store = await getVideos();
  let changed = false;
  for (const k in store) {
    if (store[k].read && (store[k].readAt || 0) < cutoff) {
      delete store[k];
      changed = true;
    }
  }
  if (changed) await saveVideos(store);
  return true;
}

async function updateBadge(store) {
  const count = Object.values(store).filter(function (v) { return !v.read; }).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  } catch (e) {}
}

async function forwardScanNow() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return { ok: false, error: 'no tab' };
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_NOW' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function forwardFullScan() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return { ok: false, error: 'no tab' };
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'FULL_SCAN' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  const run = (async function () {
    switch (msg.type) {
      case 'CAPTURE': return await capture(msg.videos);
      case 'GET_STATE': return await getState();
      case 'MARK_READ': return await markRead(msg.id);
      case 'MARK_ALL_READ': return await markAllRead();
      case 'CLEAR_READ': return await clearRead();
      case 'MARK_ACCOUNT_READ': return await markAccountRead(msg.key);
      case 'SET_ACCOUNT_CAT': return await setAccountCat(msg.key, msg.cat);
      case 'GET_SETTINGS': return await getSettings();
      case 'SET_SETTINGS': return await saveSettings(msg.settings);
      case 'SCAN_NOW': return await forwardScanNow();
      case 'FULL_SCAN': return await forwardFullScan();
      case 'SCAN_PROGRESS': scanStatus = msg.status || scanStatus; return { ok: true };
      case 'GET_SCAN_STATUS': return scanStatus;
      default: return { error: 'unknown message type' };
    }
  })();
  run.then(sendResponse, function (e) { sendResponse({ error: e.message }); });
  return true; // 保持消息通道，异步返回
});

/* ---------------- 定时清理 ---------------- */

chrome.runtime.onInstalled.addListener(function () {
  try {
    chrome.alarms.create('dy-cleanup', { periodInMinutes: 60 });
  } catch (e) {}
  // 初始化角标
  getVideos().then(updateBadge);
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === 'dy-cleanup') {
    cleanup();
  }
});
