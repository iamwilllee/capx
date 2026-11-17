/// <reference types="chrome" />
// Capx background service worker
// 负责 captureVisibleTab（必须在 extension 上下文调用）、下载，以及原图缓存（IndexedDB，供弹窗复制）。
import { defineBackground } from 'wxt/utils/define-background';
import { ensureHideInjected } from '../src/lib/hideInject';

/** 动态注册脚本的稳定 id（origin 含特殊字符，做安全化） */
function hideScriptId(originPattern: string): string {
  return 'capx-hide-' + originPattern.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 按「已授权的站点」动态注册隐藏 content script。
 * registerContentScripts 由浏览器保证在每次页面加载（含刷新）时注入，
 * 不受 service worker 生命周期 / 导航竞态影响；撤销授权时注销。
 * 当前已打开的标签页由 popup 里的 ensureHideInjected 单独处理。
 */
async function syncHideScripts() {
  if (!chrome.scripting?.registerContentScripts) return;
  let origins: string[] = [];
  try { origins = (await chrome.permissions.getAll()).origins || []; } catch { return; }

  const registrations = origins
    .filter((o) => /^https?:\/\//.test(o))
    .map((o) => ({
      id: hideScriptId(o),
      matches: [o],
      // 路径必须相对扩展根目录（不要前导斜杠），否则注册会失败
      js: ['content-scripts/hide.js'],
      css: ['content-scripts/hide.css'],
      runAt: 'document_idle' as const,
    }));

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const wantIds = new Set(registrations.map((r) => r.id));
    const stale = existing
      .filter((s) => s.id.startsWith('capx-hide-') && !wantIds.has(s.id))
      .map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });

    const have = new Set(existing.map((s) => s.id));
    const fresh = registrations.filter((r) => !have.has(r.id));
    if (fresh.length) await chrome.scripting.registerContentScripts(fresh);
  } catch (e) {
    console.warn('[capx] syncHideScripts failed', e);
  }
}

// ---------- 原图缓存 IndexedDB（扩展 origin，content 与 popup 都通过本 worker 访问） ----------
const IMG_DB = 'capx-images';
const IMG_STORE = 'images';

function openImageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeImage(id: string, dataUrl: string): Promise<void> {
  try {
    const db = await openImageDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IMG_STORE, 'readwrite');
      tx.objectStore(IMG_STORE).put(dataUrl, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* 忽略 */ }
}

async function getImage(id: string): Promise<string | null> {
  try {
    const db = await openImageDB();
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(IMG_STORE, 'readonly');
      const req = tx.objectStore(IMG_STORE).get(id);
      req.onsuccess = () => resolve((req.result as string) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function clearImages(): Promise<void> {
  try {
    const db = await openImageDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IMG_STORE, 'readwrite');
      tx.objectStore(IMG_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* 忽略 */ }
}

export default defineBackground(() => {
  // 授权 / 撤销授权时同步动态注册的隐藏脚本
  chrome.permissions.onAdded.addListener(() => { void syncHideScripts(); });
  chrome.permissions.onRemoved.addListener(() => { void syncHideScripts(); });

  // service worker 每次启动都校准一次（防止注册丢失）
  void syncHideScripts();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'capx:sync-hide-scripts') {
      syncHideScripts().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === 'capx:store-image') {
      storeImage(msg.id, msg.dataUrl).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === 'capx:get-image') {
      getImage(msg.id).then((dataUrl) => sendResponse({ ok: true, dataUrl }));
      return true;
    }

    if (msg.type === 'capx:clear-images') {
      clearImages().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === 'capx:grab') {
      const windowId = sender.tab ? sender.tab.windowId : undefined;
      const opts = { format: 'png' as const };
      chrome.tabs.captureVisibleTab(windowId, opts, (dataUrl) => {
        if (chrome.runtime.lastError) {
          const raw = chrome.runtime.lastError.message || '无法截取可见区域';
          const hint = /activeTab|permission|cannot access/i.test(raw)
            ? raw + '（activeTab 授权可能已失效，请重新点击 Capx 图标后重试）'
            : raw;
          sendResponse({ ok: false, error: hint });
        } else if (!dataUrl) {
          sendResponse({ ok: false, error: '无法截取可见区域' });
        } else {
          sendResponse({ ok: true, dataUrl });
        }
      });
      return true;
    }

    if (msg.type === 'capx:download') {
      chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, id });
        }
      });
      return true;
    }

    return false;
  });
});
