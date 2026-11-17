// 本地智能算法：A 点一个找同类 / B 启发式噪音扫描 / C 给 LLM 的页面骨架。
// 全部在内容脚本里跑，不联网。

export interface Candidate {
  selector: string;
  scope: 'light' | 'shadow';
  label: string;
  reason: string;
  matches: number;
  sample: string;
  el: Element;
}

const AD_CLASS = /(^|[-_])(ad|ads|advert|advertise|banner|promo|promotion|sponsor|sponsored|popup|modal|overlay|toast|snackbar|cookie|gdpr|newsletter|subscribe|recommend|related|suggest|float|sticky|fixed|sidebar|widget)([-_]|$)/i;
const AD_TEXT = /(广告|赞助|推广|立即下载|立即领取|限时|优惠|折扣|开通|会员|订阅|猜你喜欢|相关推荐|热门推荐|为你推荐|查看更多|sponsored|advertisement|subscribe now|sign up)/i;

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isStable(c: string): boolean {
  if (c.length < 3 || c.length > 40 || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(c)) return false;
  if (/^css-[a-z0-9]+$/i.test(c) || /^r-[a-z0-9]{3,}$/i.test(c) || /^sc-[a-z0-9]+$/i.test(c)) return false;
  if (/\d{3,}/.test(c)) return false;
  return /[a-z]{2,}/i.test(c);
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList || []).filter(isStable).slice(0, 4);
}

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8;
}

function describe(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  else {
    const cls = stableClasses(el).slice(0, 2).join('.');
    if (cls) s += '.' + cls;
  }
  return s;
}

function textOf(el: Element, max = 80): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 生成一条尽量稳的选择器（不含 nth-of-type，便于匹配同类） */
function generalizedSelector(el: Element): { selector: string; scope: 'light' | 'shadow' } {
  const parts: string[] = [];
  let cur: Element | null = el;
  let scope: 'light' | 'shadow' = 'light';
  let depth = 0;
  while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 4) {
    const root = cur.getRootNode();
    if (root instanceof ShadowRoot) scope = 'shadow';
    if (cur.id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cur.id)) {
      try {
        const found = (root instanceof Document || root instanceof ShadowRoot) ? root.querySelectorAll('#' + cssEscape(cur.id)) : [];
        if (found.length === 1 && found[0] === cur) { parts.unshift('#' + cssEscape(cur.id)); break; }
      } catch { /* ignore */ }
    }
    let part = cur.tagName.toLowerCase();
    const cls = stableClasses(cur);
    if (cls.length) part += cls.map((c) => '.' + cssEscape(c)).join('');
    parts.unshift(part);
    if (root instanceof ShadowRoot) break;
    cur = parentOf(cur);
    depth++;
  }
  return { selector: parts.join(' > ') || el.tagName.toLowerCase(), scope };
}

/** 去掉被其它候选包含的嵌套元素，只保留最外层（避免同一块生成多条规则） */
export function dedupeNested(cands: Candidate[]): Candidate[] {
  return cands.filter((c) => {
    for (const other of cands) {
      if (other === c) continue;
      if (other.el !== c.el && other.el.contains(c.el)) return false;
    }
    return true;
  });
}

/** A：点一个找同类 —— 用结构签名找出同构元素 */
export function findSimilar(el: Element, limit = 24): Candidate[] {
  const seedTag = el.tagName.toLowerCase();
  const seedCls = stableClasses(el);
  const seedSig = seedTag + (seedCls.length ? '.' + seedCls.slice().sort().join('.') : '');

  const scopeRoot: Document | ShadowRoot = el.getRootNode() instanceof ShadowRoot
    ? (el.getRootNode() as ShadowRoot) : document;
  let pool: Element[] = [];
  try { pool = Array.from(scopeRoot.querySelectorAll('*')); } catch { return []; }

  const scored: { el: Element; score: number }[] = [];
  for (const cand of pool) {
    if (cand === el || !visible(cand)) continue;
    if (cand.closest('[id^="capx-"]')) continue;
    const tag = cand.tagName.toLowerCase();
    const cls = stableClasses(cand);
    const sig = tag + (cls.length ? '.' + cls.slice().sort().join('.') : '');
    let score = 0;
    if (sig === seedSig) score = 100;
    else if (tag === seedTag && cls.length && seedCls.length && cls.some((c) => seedCls.includes(c))) score = 60;
    else if (tag === seedTag && cls.length === 0 && seedCls.length === 0) {
      const p1 = parentOf(el), p2 = parentOf(cand);
      if (p1 && p2 && p1.tagName === p2.tagName) score = 35;
    }
    if (!score) continue;
    scored.push({ el: cand, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const gen = generalizedSelector(el);
  const out: Candidate[] = [];
  for (const { el: c } of scored.slice(0, limit)) {
    out.push({
      selector: gen.selector,
      scope: gen.scope,
      label: describe(c),
      reason: '与所选元素结构相同',
      matches: 1,
      sample: textOf(c, 40),
      el: c,
    });
  }
  return out;
}

/** B：启发式噪音扫描 —— 给元素打分，挑出疑似广告/推荐/悬浮层 */
export function scanNoise(limit = 20): Candidate[] {
  const scored: { el: Element; score: number }[] = [];
  const all: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    try { all.push(...Array.from(root.querySelectorAll('*'))); } catch { /* ignore */ }
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (host.shadowRoot) walk(host.shadowRoot);
    }
  };
  walk(document);

  for (const el of all) {
    if (!visible(el) || el === document.body || el === document.documentElement) continue;
    if (el.closest('[id^="capx-"]')) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 1500) continue;
    // 排除正文大容器
    if ((el.textContent || '').length > 1200 && el.children.length > 8) continue;

    let score = 0;
    const reasons: string[] = [];
    if (cs.position === 'fixed' || cs.position === 'sticky') { score += 3; reasons.push('悬浮定位'); }
    const zi = Number(cs.zIndex);
    if (zi >= 100) { score += 2; reasons.push('高层级'); }
    const idcls = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    if (AD_CLASS.test(idcls)) { score += 3; reasons.push('类名含广告/推广特征'); }
    const txt = textOf(el, 200);
    if (AD_TEXT.test(txt)) { score += 2; reasons.push('文案含推广词'); }
    const role = el.getAttribute('role') || '';
    if (/dialog|banner|complementary|alert/i.test(role)) { score += 1; reasons.push('语义为浮层/侧栏'); }
    if (r.top < 60 && area > 40000) { score += 1; reasons.push('顶部大块'); }
    if (score < 4) continue;

    const gen = generalizedSelector(el);
    scored.push({
      el,
      score,
    });
    void reasons;
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ el }) => {
    const gen = generalizedSelector(el);
    return {
      selector: gen.selector,
      scope: gen.scope,
      label: describe(el),
      reason: '疑似广告/推广/悬浮层',
      matches: 1,
      sample: textOf(el, 40),
      el,
    };
  });
}

/** C：构建给 LLM 的页面骨架（可序列化）+ 元素映射（不可序列化，留在内容脚本） */
export function buildSkeleton(limit = 120): {
  payload: { id: number; tag: string; cls: string[]; text: string; pos: string; rect: number[]; role: string }[];
  map: Map<number, Element>;
} {
  const all: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    try { all.push(...Array.from(root.querySelectorAll('*'))); } catch { /* ignore */ }
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (host.shadowRoot) walk(host.shadowRoot);
    }
  };
  walk(document);

  const map = new Map<number, Element>();
  const payload: { id: number; tag: string; cls: string[]; text: string; pos: string; rect: number[]; role: string }[] = [];
  let id = 0;
  for (const el of all) {
    if (!visible(el) || el === document.body || el === document.documentElement) continue;
    if (el.closest('[id^="capx-"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1200) continue;
    const cs = getComputedStyle(el);
    map.set(id, el);
    payload.push({
      id,
      tag: el.tagName.toLowerCase(),
      cls: stableClasses(el),
      text: textOf(el, 60),
      pos: cs.position,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      role: el.getAttribute('role') || '',
    });
    id++;
    if (payload.length >= limit) break;
  }
  return { payload, map };
}
