// 截图启动链路：ping → 按需注入（activeTab）→ 发送 capx:start
// 全程不使用 host_permissions：只有用户点了图标，activeTab 才授权当前标签页。

import { buildStartPayload, markOnboarded } from './settings';

const BLOCKED_SCHEME = /^(chrome|edge|about|chrome-extension|moz-extension|devtools|view-source):/i;

export interface StartResult {
  ok: boolean;
  error?: string;
}

export async function startCapture(): Promise<StartResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: '找不到当前标签页' };

  if (tab.url && BLOCKED_SCHEME.test(tab.url)) {
    return { ok: false, error: '此页面不允许注入（浏览器内置页）' };
  }

  const payload = await buildStartPayload();

  let injected = false;
  try {
    const pong: any = await browser.tabs.sendMessage(tab.id, { type: 'capx:ping' });
    injected = !!pong?.ok;
  } catch {
    injected = false;
  }

  if (!injected) {
    try {
      // 覆盖层样式必须一起注入：运行时注册的 content script 不会自动带 CSS
      await browser.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['/content-scripts/capx.css'],
      });
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['/content-scripts/capx.js'],
      });
    } catch (e: any) {
      const raw = e?.message || '';
      return {
        ok: false,
        error: /cannot access|permission/i.test(raw)
          ? '无法注入此页面：请重新点击 Capx 图标（激活授权）后重试'
          : '无法注入此页面：' + (raw || '未知错误'),
      };
    }
  }

  try {
    await browser.tabs.sendMessage(tab.id, { type: 'capx:start', settings: payload });
  } catch (e: any) {
    return { ok: false, error: '启动失败：' + (e?.message || '未知错误') };
  }

  if (payload.firstRun) await markOnboarded();
  return { ok: true };
}
