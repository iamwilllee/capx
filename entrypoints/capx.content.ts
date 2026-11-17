// Capx content script（WXT entrypoint）
//
// 关键：registration: 'runtime' —— 不写入 manifest.content_scripts，也不申请 host_permissions。
// 由 popup 在用户点击图标（activeTab 授权）后，用 scripting.executeScript 按需注入。
// CSS（content-scripts/capx.css）由 popup 用 scripting.insertCSS 一起注入。

import { defineContentScript } from 'wxt/utils/define-content-script';
import { boot, ping } from '../src/content/capx.js';
import '../src/content/overlay.css';

declare global {
  interface Window {
    __capxContentLoaded?: boolean;
  }
}

export default defineContentScript({
  registration: 'runtime',

  main() {
    // executeScript 可能重复注入同一文件：只保留一份消息监听
    if (window.__capxContentLoaded) return;
    window.__capxContentLoaded = true;

    // 同步响应：Chrome 的 onMessage 不支持返回 Promise
    browser.runtime.onMessage.addListener(
      (msg: any, _sender: any, sendResponse: (r: any) => void) => {
        if (!msg || !msg.type) return false;
        if (msg.type === 'capx:ping') {
          sendResponse(ping());
          return false;
        }
        if (msg.type === 'capx:start') {
          try {
            sendResponse(boot(msg.settings));
          } catch (e: any) {
            sendResponse({ ok: false, error: e?.message || '启动失败' });
          }
          return false;
        }
        return false;
      },
    );
  },
});
