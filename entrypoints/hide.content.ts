// 隐藏元素 content script（WXT entrypoint）
// registration: 'runtime' —— 不写入 manifest.content_scripts。
// 只有用户授权的站点才会由 background / popup 按需注入；CSS 也由注入方一起 insertCSS。

import { defineContentScript } from 'wxt/utils/define-content-script';
import '../src/content/hide.js';
import '../src/content/hide-overlay.css';

export default defineContentScript({
  registration: 'runtime',
  main() {
    // hide.js 自带消息监听与启动逻辑；这里只作为构建入口。
  },
});
