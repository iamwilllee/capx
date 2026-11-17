import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Capx — 截图 & 隐藏不想看的元素',
    description: '两种能力：先临时消除再圈选截图（退出自动复原）；或按站授权后永久隐藏不想看的元素。安装时不请求网站权限，用时按站授权。',
    version: '3.2.0',
    permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'clipboardWrite'],
    // 隐藏元素功能：按站授权后才会注入，不在安装时索要全部网站权限
    optional_host_permissions: ['<all_urls>'],
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+X' },
        description: '打开 Capx',
      },
    },
  },
});
