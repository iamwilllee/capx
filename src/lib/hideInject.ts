// 隐藏脚本的按需注入工具，popup 与 background 共用。
// 只有用户授予了对应站点权限，注入才会成功。

export interface HideInjectResult {
  ok: boolean;
  error?: string;
}

async function pingHide(tabId: number): Promise<boolean> {
  try {
    const pong = await browser.tabs.sendMessage(tabId, { type: 'capx:hide-ping' });
    return !!pong?.ok;
  } catch {
    return false;
  }
}

/** 确保隐藏脚本已注入当前标签页（已注入则直接返回） */
export async function ensureHideInjected(tabId: number): Promise<HideInjectResult> {
  if (await pingHide(tabId)) return { ok: true };

  try {
    await browser.scripting.insertCSS({
      target: { tabId },
      files: ['/content-scripts/hide.css'],
    });
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/hide.js'],
    });
  } catch (e: any) {
    const raw = e?.message || '';
    return {
      ok: false,
      error: /cannot access|permission/i.test(raw)
        ? '无权限注入此页面，请重新点击图标授权'
        : '无法注入此页面：' + (raw || '未知错误'),
    };
  }

  if (await pingHide(tabId)) return { ok: true };
  return { ok: false, error: '隐藏脚本注入后未响应' };
}

/** 进入拾取模式 */
export async function startHidePicking(tabId: number): Promise<HideInjectResult> {
  const injected = await ensureHideInjected(tabId);
  if (!injected.ok) return injected;
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: 'capx:hide-pick' });
    return (res as HideInjectResult) || { ok: true };
  } catch (e: any) {
    return { ok: false, error: '启动拾取失败：' + (e?.message || '未知错误') };
  }
}

export interface RuleProbe {
  /** 选择器在当前页面匹配到的元素数 */
  matches: number;
  /** 其中仍然可见（未被隐藏）的数量 */
  visible: number;
  /** 是否靠文本锚点兜底才找到 */
  viaAnchor: boolean;
}

/** 在当前页面实测一条规则的命中情况，用于弹窗诊断 */
export async function probeRule(
  tabId: number,
  selector: string,
  scope: 'light' | 'shadow',
  anchor?: string,
  tag?: string,
): Promise<RuleProbe | null> {
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      func: (sel: string, sc: string, anch: string, tg: string) => {
        try {
          let els: Element[] = [];
          if (sc === 'shadow') {
            const walk = (root: Document | ShadowRoot) => {
              let hosts: Element[] = [];
              try { hosts = Array.from(root.querySelectorAll('*')); } catch { /* ignore */ }
              for (const host of hosts) {
                if (!host.shadowRoot) continue;
                try { els.push(...Array.from(host.shadowRoot.querySelectorAll(sel))); } catch { /* ignore */ }
                walk(host.shadowRoot);
              }
            };
            walk(document);
          } else {
            els = Array.from(document.querySelectorAll(sel));
          }
          let viaAnchor = false;
          // 与内容脚本保持一致：选择器匹配 0 个时用文本锚点兜底
          if (!els.length && anch) {
            let pool: Element[] = [];
            try { pool = Array.from(document.querySelectorAll(tg || '*')); } catch { pool = []; }
            els = pool.filter((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().includes(anch));
            viaAnchor = els.length > 0;
          }
          let visible = 0;
          for (const el of els) {
            if (getComputedStyle(el).display !== 'none') visible++;
          }
          return { matches: els.length, visible, viaAnchor };
        } catch {
          return { matches: -1, visible: -1, viaAnchor: false };
        }
      },
      args: [selector, scope, anchor || '', tag || ''],
    });
    const r = res?.result as RuleProbe | undefined;
    return r ?? null;
  } catch {
    return null;
  }
}
