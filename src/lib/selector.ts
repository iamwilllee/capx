// 元素选择器工具：给「隐藏元素」功能生成可跨刷新复现的 CSS 选择器，并按作用域查找元素。
// 与截图功能完全独立，只被隐藏内容脚本使用。

export type SelectorScope = 'light' | 'shadow';

export interface ElementSelector {
  selector: string;
  scope: SelectorScope;
  label: string;
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

/** 跨 Shadow DOM 取父节点：shadow 内元素向上走到 host */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** 人类可读的简短描述，用于规则列表 */
export function describe(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  else if (typeof el.className === 'string') {
    const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    if (cls) s += '.' + cls;
  }
  return s;
}

/** 判断 class 是否像构建工具生成的动态名（刷新后会变），用于从选择器里剔除 */
function isStableClass(c: string): boolean {
  if (c.length < 3 || c.length > 40) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(c)) return false;
  // emotion / styled-components / CSS modules / x.com 的 r-xxx
  if (/^css-[a-z0-9]+$/i.test(c)) return false;
  if (/^r-[a-z0-9]{3,}$/i.test(c)) return false;
  if (/^sc-[a-z0-9]+$/i.test(c)) return false;
  if (/^[a-z]{1,3}-[a-z0-9]{5,}$/i.test(c) && /\d/.test(c)) return false;
  if (/\d{3,}/.test(c)) return false;
  if (!/[a-z]{2,}/i.test(c)) return false;
  return true;
}

/**
 * 生成选择器：优先唯一 id → 短 class 链 + nth-of-type；
 * 遇到 ShadowRoot 时以 shadow 内为作用域（host 不写进选择器）。
 */
export function buildRuleSelector(el: Element): ElementSelector {
  const parts: string[] = [];
  let cur: Element | null = el;
  let scope: SelectorScope = 'light';

  while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
    const root = cur.getRootNode();
    const scopeRoot = root instanceof Document || root instanceof ShadowRoot ? root : null;
    if (root instanceof ShadowRoot) scope = 'shadow';
    const curTag = cur.tagName;

    const id = cur.id;
    if (id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) && scopeRoot) {
      try {
        const found = scopeRoot.querySelectorAll('#' + cssEscape(id));
        if (found.length === 1 && found[0] === cur) {
          parts.unshift('#' + cssEscape(id));
          break;
        }
      } catch (_) { /* 非法 id 走普通路径 */ }
    }

    let part = curTag.toLowerCase();
    const classes = Array.from(cur.classList || []).filter(isStableClass).slice(0, 3);
    if (classes.length) part += classes.map((c) => '.' + cssEscape(c)).join('');

    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === curTag);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);

    if (root instanceof ShadowRoot) break;
    cur = parentOf(cur);
  }

  return {
    selector: parts.join(' > ') || el.tagName.toLowerCase(),
    scope,
    label: describe(el),
  };
}

/** 规范化元素文本，作为选择器失效时的兜底锚点 */
export function makeAnchor(el: Element): string {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 40);
}

/**
 * 选择器失效时的兜底：按标签 + 文本锚点找元素。
 * 只在 selector 匹配 0 个时使用，避免误伤。
 */
export function findByAnchor(anchor: string, tagName: string): Element[] {
  if (!anchor) return [];
  let pool: Element[] = [];
  try { pool = Array.from(document.querySelectorAll(tagName || '*')); } catch { return []; }
  const target = anchor;
  return pool.filter((el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.startsWith(target) || t.includes(target);
  });
}

/** light 只查 document；shadow 查所有开放 shadowRoot（含嵌套） */
export function queryAllScoped(selector: string, scope: SelectorScope): Element[] {
  if (scope === 'shadow') {
    const out: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      let hosts: Element[] = [];
      try { hosts = Array.from(root.querySelectorAll('*')); } catch (_) {}
      for (const host of hosts) {
        if (!host.shadowRoot) continue;
        try { out.push(...Array.from(host.shadowRoot.querySelectorAll(selector))); } catch (_) {}
        walk(host.shadowRoot);
      }
    };
    walk(document);
    return out;
  }
  try { return Array.from(document.querySelectorAll(selector)); } catch (_) { return []; }
}
