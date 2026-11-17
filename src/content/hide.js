// Capx 隐藏元素 content core —— 与截图功能完全独立。
// 两种状态：静默应用规则（页面加载自动）+ 拾取模式（用户从弹窗发起）。
// 拾取模式交互：点击 = 立即从页面消失（所见即所得），可连续多选、逐项撤销；
// 最后一次性保存为永久规则。未保存就退出则全部还原。

import { addHideRule, getRulesForHost, newRuleId } from '../lib/hideRules';
import { buildRuleSelector, queryAllScoped, makeAnchor, findByAnchor } from '../lib/selector';
import { findSimilar, scanNoise, buildSkeleton, dedupeNested } from '../lib/aiLocal';

const state = {
  host: location.hostname,
  hidden: new Map(),        // ruleId -> [rec]  已保存规则隐藏的元素
  domObserver: null,
  applyPending: false,
  picking: false,
  pending: [],              // [{ info, matches, recs: [] }]  本次拾取、尚未保存
  detailOpen: false,        // 明细卡片是否展开
  chain: [],                // [deepest, ..., shallowest]
  hoverIdx: 0,
  locked: null,
  pointEl: null,
  aiCandidates: [],         // AI 预览候选 []
  aiMode: null,             // 'similar' | 'scan' | 'llm'
  aiMap: null,              // LLM 骨架 id -> Element
  ui: {},
};

const GUARD_LIMIT = 50;
const PENDING_OWNER = '__pending__';
const OWN_UI = '#capx-hide-bar, #capx-hide-hover, #capx-hide-label, #capx-hide-confirm, #capx-hide-toast';
const CURSOR_ON = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'26\' height=\'26\' viewBox=\'0 0 26 26\'><rect x=\'3\' y=\'3\' width=\'20\' height=\'20\' rx=\'4\' fill=\'rgba(240,151,107,0.15)\' stroke=\'%23f0976b\' stroke-width=\'2\'/><line x1=\'8\' y1=\'13\' x2=\'18\' y2=\'13\' stroke=\'%23f0976b\' stroke-width=\'2.4\' stroke-linecap=\'round\'/></svg>") 13 13, crosshair';

// ---------- DOM 小工具 ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isOwnUI(el) {
  return !!(el && el.closest && el.closest(OWN_UI));
}

function isOwnNode(n) {
  if (!n || n.nodeType !== 1) return true;
  if ((n.id || '').startsWith('capx-')) return true;
  if (n.classList && Array.from(n.classList).some((c) => c.startsWith('capx-'))) return true;
  return isOwnUI(n);
}

// ---------- UI ----------
function ensureUI() {
  if (state.ui.bar) return;
  state.ui.bar = h('div', { id: 'capx-hide-bar' });
  state.ui.hover = h('div', { id: 'capx-hide-hover' });
  state.ui.label = h('div', { id: 'capx-hide-label' });
  state.ui.confirm = h('div', { id: 'capx-hide-confirm' });
  state.ui.toast = h('div', { id: 'capx-hide-toast' });
  document.documentElement.append(state.ui.bar, state.ui.hover, state.ui.label, state.ui.confirm, state.ui.toast);
}

function toast(msg, warn = false) {
  if (!state.ui.toast) return;
  state.ui.toast.textContent = msg;
  state.ui.toast.className = 'capx-show' + (warn ? ' capx-warn' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { state.ui.toast.className = ''; }, 2600);
}

function renderBar() {
  ensureUI();
  state.ui.bar.innerHTML = '';
  const groups = state.pending.length;
  const elements = state.pending.reduce((n, p) => n + p.recs.length, 0);
  state.ui.bar.append(
    h('span', { class: 'capx-hide-ico', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>' }),
    h('span', { class: 'capx-hide-title' }, '隐藏元素'),
    h('span', { class: 'capx-hide-tip', html: groups
      ? `已隐藏 <b>${groups}</b> 项 / ${elements} 个元素 · 可继续点击`
      : '点击要隐藏的内容（点完立刻消失） · 滚轮调范围 · Esc 退出' }),
    h('button', { type: 'button', onClick: openDetail, ...(groups ? {} : { disabled: 'true' }) }, '明细'),
    h('button', { type: 'button', onClick: undoLast, ...(groups ? {} : { disabled: 'true' }), title: '撤销最后一项（Ctrl+Z）' }, '撤销'),
    h('button', {
      type: 'button', class: 'capx-hide-primary',
      ...(groups ? {} : { disabled: 'true' }),
      onClick: saveAll,
    }, groups ? `保存 ${groups} 项` : '保存'),
    h('button', { type: 'button', onClick: clearPending, ...(groups ? {} : { disabled: 'true' }) }, '清空'),
    h('button', { type: 'button', class: 'capx-hide-exit', onClick: exitPick }, '退出')
  );
  state.ui.bar.style.display = 'flex';
}

/** 明细卡片：展示本次已隐藏的每一项，可逐项撤销 */
function renderDetail() {
  ensureUI();
  state.ui.confirm.innerHTML = '';
  const box = h('div', { class: 'capx-hide-card' });
  box.append(
    h('div', { class: 'capx-hide-card-title' }, `本次已隐藏 ${state.pending.length} 项`),
    h('div', { class: 'capx-hide-card-hint' }, '下面这些元素已从页面消失。点 × 可恢复某一项；点「保存」后永久生效。')
  );

  const list = h('div', { class: 'capx-hide-list' });
  state.pending.forEach((item, idx) => {
    const { info, matches, recs } = item;
    list.append(
      h('div', { class: 'capx-hide-list-row' + (recs.length > 1 ? ' multi' : '') },
        h('div', { class: 'capx-hide-list-main' },
          h('code', { class: 'capx-hide-card-code', title: info.selector }, info.selector),
          h('span', { class: 'capx-hide-list-meta' },
            info.label + (recs.length > 1 ? ` · 已隐藏 ${recs.length} 个元素` : ' · 1 个元素')
          )
        ),
        h('button', {
          type: 'button', class: 'capx-hide-list-rm', title: '恢复这一项',
          onClick: () => undoGroup(idx),
        }, '×')
      )
    );
  });
  if (!state.pending.length) {
    list.append(h('div', { class: 'capx-hide-card-hint' }, '（暂无，回到页面继续点击元素）'));
  }
  box.append(list);

  box.append(
    h('div', { class: 'capx-hide-card-actions' },
      h('button', { type: 'button', class: 'capx-hide-btn', onClick: closeDetail }, '继续选择'),
      h('button', {
        type: 'button', class: 'capx-hide-btn primary',
        ...(state.pending.length ? {} : { disabled: 'true' }),
        onClick: saveAll,
      }, `保存 ${state.pending.length} 项`)
    )
  );
  state.ui.confirm.append(box);
  state.ui.confirm.style.display = 'flex';
}

function openDetail() {
  if (!state.pending.length) return;
  state.detailOpen = true;
  renderDetail();
}

function closeDetail() {
  state.detailOpen = false;
  if (state.ui.confirm) state.ui.confirm.style.display = 'none';
}

// ---------- AI 智能隐藏 ----------
let aiHighlightStyle = null;
function highlightCandidates(cands) {
  clearCandidateHighlight();
  aiHighlightStyle = document.createElement('style');
  aiHighlightStyle.id = 'capx-ai-highlight-style';
  const rules = cands.map((c, i) =>
    `[data-capx-ai-mark="${i}"]{outline:2px dashed #a78bfa !important;outline-offset:2px;background:rgba(167,139,250,.08) !important;}`
  ).join('\n');
  aiHighlightStyle.textContent = rules;
  (document.head || document.documentElement).appendChild(aiHighlightStyle);
  cands.forEach((c, i) => { try { c.el.setAttribute('data-capx-ai-mark', String(i)); } catch (_) {} });
}
function clearCandidateHighlight() {
  if (aiHighlightStyle) { aiHighlightStyle.remove(); aiHighlightStyle = null; }
  document.querySelectorAll('[data-capx-ai-mark]').forEach((el) => el.removeAttribute('data-capx-ai-mark'));
  document.querySelectorAll('[data-capx-ai-on]').forEach((el) => el.removeAttribute('data-capx-ai-on'));
}

function renderAiPanel() {
  ensureUI();
  state.ui.confirm.innerHTML = '';
  const titleMap = { similar: '找到的同类元素', scan: '疑似干扰内容', llm: 'AI 分析结果' };
  const box = h('div', { class: 'capx-hide-card' });
  box.append(
    h('div', { class: 'capx-hide-card-title' }, `${titleMap[state.aiMode] || 'AI 结果'} · ${state.aiCandidates.length} 项`),
    h('div', { class: 'capx-hide-card-hint' }, '勾选要隐藏的项（页面已高亮预览），点「隐藏选中」加入本次操作。')
  );
  const list = h('div', { class: 'capx-hide-list' });
  if (!state.aiCandidates.length) {
    list.append(h('div', { class: 'capx-hide-card-hint' }, '没有找到候选元素，换个方式再试试。'));
  }
  state.aiCandidates.forEach((c) => {
    const row = h('div', { class: 'capx-hide-list-row ai' });
    const check = h('input', { type: 'checkbox', class: 'capx-ai-check' });
    check.checked = c.checked !== false;
    check.addEventListener('change', () => {
      c.checked = check.checked;
      try { if (check.checked) c.el.setAttribute('data-capx-ai-on', '1'); else c.el.removeAttribute('data-capx-ai-on'); } catch (_) {}
    });
    if (check.checked) { try { c.el.setAttribute('data-capx-ai-on', '1'); } catch (_) {} }
    row.append(
      check,
      h('div', { class: 'capx-hide-list-main' },
        h('code', { class: 'capx-hide-card-code', title: c.selector }, c.selector),
        h('span', { class: 'capx-hide-list-meta' }, `${c.reason}${c.sample ? ' · ' + c.sample : ''}`)
      )
    );
    list.append(row);
  });
  box.append(list);
  box.append(
    h('div', { class: 'capx-hide-card-actions' },
      h('button', { type: 'button', class: 'capx-hide-btn', onClick: () => { clearAiPanel(); } }, '取消'),
      h('button', { type: 'button', class: 'capx-hide-btn primary', onClick: applyAiSelection }, '隐藏选中')
    )
  );
  state.ui.confirm.append(box);
  state.ui.confirm.style.display = 'flex';
  highlightCandidates(state.aiCandidates);
}

function clearAiPanel() {
  clearCandidateHighlight();
  state.aiCandidates = [];
  state.aiMode = null;
  state.aiMap = null;
  state.detailOpen = false;
  if (state.ui.confirm) state.ui.confirm.style.display = 'none';
}

function applyAiSelection() {
  const chosen = state.aiCandidates.filter((c) => c.checked !== false);
  if (!chosen.length) { toast('没有勾选任何元素', true); return; }
  const bySel = new Map();
  for (const c of chosen) {
    const key = c.selector + '||' + c.scope;
    if (!bySel.has(key)) bySel.set(key, { info: { selector: c.selector, scope: c.scope, label: c.label }, els: [] });
    bySel.get(key).els.push(c.el);
  }
  for (const g of bySel.values()) {
    const recs = [];
    for (const el of g.els) {
      const rec = hideElement(el, PENDING_OWNER);
      if (rec) recs.push(rec);
    }
    if (recs.length) {
      state.pending.push({ info: g.info, matches: recs.length, recs, tag: g.els[0].tagName.toLowerCase(), anchor: makeAnchor(g.els[0]) });
    }
  }
  const n = state.pending.reduce((s, g) => s + g.recs.length, 0);
  clearAiPanel();
  // 注意：不能 exitPick()——那会还原 pending 里刚隐藏的元素。
  // 留在拾取模式里，让用户继续补选或直接点「保存」。
  renderBar();
  toast(`已加入 ${n} 个元素 · 点顶部「保存」永久生效`);
}

function startSimilar() {
  ensureUI();
  enterPick();
  state.aiMode = 'similar-pick';
  toast('点一个元素作为样本 · 将找出同类供你勾选');
}

function startScan() {
  ensureUI();
  const cands = dedupeNested(scanNoise());
  cands.forEach((c) => { c.checked = true; });
  state.aiMode = 'scan';
  state.aiCandidates = cands;
  renderAiPanel();
}

async function startLlm() {
  ensureUI();
  toast('正在分析页面…');
  const { payload, map } = buildSkeleton();
  if (!payload.length) { toast('页面没有可分析的元素', true); return; }
  state.aiMap = map;
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: 'capx:ai-complete', nodes: payload });
  } catch (e) {
    toast('AI 调用失败：' + (e?.message || '未知错误'), true);
    return;
  }
  if (!res?.ok) { toast(res?.error || 'AI 调用失败', true); return; }
  const cands = [];
  for (const d of (res.decisions || [])) {
    const el = map.get(d.id);
    if (!el) continue;
    const info = buildRuleSelector(el);
    cands.push({
      selector: info.selector, scope: info.scope, label: info.label,
      reason: d.reason || 'AI 判定为干扰内容', matches: 1,
      sample: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), el, checked: true,
    });
  }
  state.aiMode = 'llm';
  state.aiCandidates = dedupeNested(cands);
  renderAiPanel();
}

function setHoverHighlight(el) {
  if (!el) { hideHover(); return; }
  const r = el.getBoundingClientRect();
  Object.assign(state.ui.hover.style, {
    display: 'block', left: r.left + 'px', top: r.top + 'px',
    width: r.width + 'px', height: r.height + 'px',
  });
  state.ui.label.innerHTML = `<span style="opacity:.62">${escapeHtml(describeSafe(el))} · ${Math.round(r.width)} × ${Math.round(r.height)}</span> &nbsp;<span style="font-weight:800">点击隐藏</span>`;
  let top = r.top - 26;
  if (top < 4) top = r.top + r.height + 6;
  Object.assign(state.ui.label.style, {
    display: 'block', left: Math.max(4, r.left) + 'px', top: top + 'px',
    maxWidth: Math.min(window.innerWidth - 8, r.width + 200) + 'px',
  });
}

function describeSafe(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
  return s;
}

function hideHover() {
  if (state.ui.hover) state.ui.hover.style.display = 'none';
  if (state.ui.label) state.ui.label.style.display = 'none';
}

let cursorOn = false;
function setCursor(on) {
  if (on === cursorOn) return;
  cursorOn = on;
  document.documentElement.style.cursor = on ? CURSOR_ON : '';
}

// ---------- 元素隐藏（rec 所有权：active / owner） ----------
function restoreStyle(rec) {
  const el = rec.el;
  if (!el || !el.style) return;
  if (rec.prevDisplay === '') el.style.removeProperty('display');
  else el.style.setProperty('display', rec.prevDisplay, rec.prevImportant || '');
  if (!rec.hadStyleAttr && el.getAttribute('style') === '') el.removeAttribute('style');
}

/** 释放一条 rec：断开守护 + 还原样式 + 标记为失效 */
function releaseRec(rec) {
  rec.active = false;
  if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
  restoreStyle(rec);
}

function attachGuard(rec) {
  try {
    rec.observer = new MutationObserver(() => {
      if (rec._pending) return;
      rec._pending = true;
      requestAnimationFrame(() => { rec._pending = false; reassert(rec); });
    });
    rec.observer.observe(rec.el, { attributes: true, attributeFilter: ['style'] });
  } catch (_) { /* 不可观察则跳过 */ }
}

function reassert(rec) {
  if (!rec.active) return;
  const el = rec.el;
  if (!el.isConnected) return;
  if (getComputedStyle(el).display !== 'none') {
    el.style.setProperty('display', 'none', 'important');
    rec.reasserts++;
    if (rec.reasserts > GUARD_LIMIT) {
      // 从所属列表移除
      if (rec.owner === PENDING_OWNER) {
        for (const g of state.pending) {
          const i = g.recs.indexOf(rec);
          if (i >= 0) { g.recs.splice(i, 1); break; }
        }
      } else {
        const list = state.hidden.get(rec.owner);
        if (list) { const i = list.indexOf(rec); if (i >= 0) list.splice(i, 1); }
      }
      releaseRec(rec);
      toast('页面持续重置该元素样式，已放弃隐藏它', true);
      renderBar();
      if (state.detailOpen) renderDetail();
    }
  }
}

/** 隐藏一个元素，返回 rec（带 owner / active 标记，便于撤销与交接） */
function hideElement(el, owner) {
  if (!el || el === document.body || el === document.documentElement || isOwnUI(el)) return null;
  const rec = {
    el,
    prevDisplay: el.style.getPropertyValue('display'),
    prevImportant: el.style.getPropertyPriority('display'),
    hadStyleAttr: el.hasAttribute('style'),
    observer: null,
    reasserts: 0,
    owner,
    active: true,
  };
  el.style.setProperty('display', 'none', 'important');
  attachGuard(rec);
  return rec;
}

async function applyRules() {
  let rules;
  try { rules = await getRulesForHost(state.host); } catch (_) { return; }
  const active = rules.filter((r) => r.enabled !== false);
  const ids = new Set(active.map((r) => r.id));

  // 规则被删除或禁用：恢复它隐藏过的元素
  for (const [ruleId, recs] of Array.from(state.hidden.entries())) {
    if (!ids.has(ruleId)) {
      recs.forEach(releaseRec);
      state.hidden.delete(ruleId);
    }
  }

  for (const rule of active) {
    const recs = state.hidden.get(rule.id) || [];
    // 清理已被页面移除的节点
    for (let i = recs.length - 1; i >= 0; i--) {
      if (!recs[i].el.isConnected) { releaseRec(recs[i]); recs.splice(i, 1); }
    }
    const seen = new Set(recs.map((r) => r.el));
    let targets = queryAllScoped(rule.selector, rule.scope);
    // 选择器失效（常见于动态 class 的 SPA）：用文本锚点兜底
    if (!targets.length && rule.anchor) {
      targets = findByAnchor(rule.anchor, rule.tag || '*');
    }
    for (const el of targets) {
      if (el === document.body || el === document.documentElement || isOwnUI(el)) continue;
      if (seen.has(el)) continue;
      const rec = hideElement(el, rule.id);
      if (rec) { recs.push(rec); seen.add(el); }
    }
    state.hidden.set(rule.id, recs);
  }
}

function watchDom() {
  stopWatchDom();
  try {
    state.domObserver = new MutationObserver((records) => {
      const relevant = records.some((m) =>
        Array.from(m.addedNodes).some((n) => !isOwnNode(n)) ||
        Array.from(m.removedNodes).some((n) => !isOwnNode(n))
      );
      if (!relevant || state.applyPending) return;
      state.applyPending = true;
      requestAnimationFrame(() => { state.applyPending = false; void applyRules(); });
    });
    state.domObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* 静默跳过 */ }
}

function stopWatchDom() {
  if (state.domObserver) { state.domObserver.disconnect(); state.domObserver = null; }
  state.applyPending = false;
}

// ---------- 拾取模式 ----------
function deepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function parentOf(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function buildChain(el) {
  const chain = [];
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    chain.push(cur);
    cur = parentOf(cur);
  }
  return chain;
}

function onMove(e) {
  if (!state.picking || state.detailOpen) return;
  if (isOwnUI(e.target)) return;
  const el = deepElementFromPoint(e.clientX, e.clientY);
  if (!el || isOwnUI(el) || el === document.body || el === document.documentElement) {
    hideHover(); state.chain = []; state.pointEl = null; state.locked = null; setCursor(false); return;
  }
  if (state.locked && el !== state.locked && state.locked.contains(el)) {
    setHoverHighlight(state.locked); setCursor(true); return;
  }
  if (state.locked && !(el === state.locked || state.locked.contains(el))) state.locked = null;
  if (state.pointEl !== el) {
    state.pointEl = el;
    state.chain = buildChain(el);
    state.hoverIdx = 0;
  }
  setHoverHighlight(state.chain[state.hoverIdx]);
  setCursor(true);
}

function onWheel(e) {
  if (!state.picking || state.detailOpen || !state.chain.length) return;
  if (isOwnUI(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.deltaY < 0) {
    if (state.hoverIdx < state.chain.length - 1) state.hoverIdx++;
  } else if (state.hoverIdx > 0) {
    state.hoverIdx--;
  }
  const picked = state.chain[state.hoverIdx];
  state.locked = state.hoverIdx > 0 ? picked : null;
  setHoverHighlight(picked);
  setCursor(true);
}

function onClick(e) {
  if (!state.picking || state.detailOpen || isOwnUI(e.target)) return;
  const el = state.locked || state.chain[state.hoverIdx] || deepElementFromPoint(e.clientX, e.clientY);
  if (!el || isOwnUI(el) || el === document.body || el === document.documentElement) return;
  e.preventDefault();
  e.stopPropagation();

  // A 模式的样本点击：不立即隐藏，找同类并预览
  if (state.aiMode === 'similar-pick') {
    const cands = findSimilar(el);
    // 把样本自身也作为一项
    const info = buildRuleSelector(el);
    cands.unshift({
      selector: info.selector, scope: info.scope, label: info.label,
      reason: '作为样本的元素', matches: 1,
      sample: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), el, checked: true,
    });
    state.aiMode = 'similar';
    state.aiCandidates = dedupeNested(cands);
    state.chain = []; state.pointEl = null; state.locked = null;
    hideHover();
    renderAiPanel();
    return;
  }

  const info = buildRuleSelector(el);
  const matches = queryAllScoped(info.selector, info.scope);
  // 点下去就立刻消失：把匹配到的元素全部隐藏（与日后规则的效果一致，所见即所得）
  const recs = [];
  for (const target of matches) {
    const rec = hideElement(target, PENDING_OWNER);
    if (rec) recs.push(rec);
  }
  if (!recs.length) return;

  state.pending.push({ info, matches: matches.length, recs, tag: el.tagName.toLowerCase(), anchor: makeAnchor(el) });
  state.chain = [];
  state.pointEl = null;
  state.locked = null;
  hideHover();
  renderBar();
  toast(recs.length > 1
    ? `已隐藏 ${recs.length} 个元素 · 点「保存 ${state.pending.length} 项」永久生效`
    : `已隐藏 · 点「保存 ${state.pending.length} 项」永久生效`);
}

function undoGroup(idx) {
  const g = state.pending[idx];
  if (!g) return;
  g.recs.forEach(releaseRec);
  state.pending.splice(idx, 1);
  renderBar();
  if (state.detailOpen) {
    if (state.pending.length) renderDetail();
    else closeDetail();
  }
}

function undoLast() {
  if (state.pending.length) undoGroup(state.pending.length - 1);
}

function clearPending() {
  state.pending.forEach((g) => g.recs.forEach(releaseRec));
  state.pending = [];
  closeDetail();
  renderBar();
  toast('已还原本次所有隐藏');
}

async function saveAll() {
  if (!state.pending.length) return;
  const groups = state.pending.slice();
  let saved = 0;
  for (const g of groups) {
    const id = newRuleId();
    const rule = {
      id,
      host: state.host,
      selector: g.info.selector,
      scope: g.info.scope,
      label: g.info.label,
      tag: g.tag,
      anchor: g.anchor,
      createdAt: Date.now(),
      matches: g.matches,
      enabled: true,
    };
    // 把临时隐藏的 rec 交接给规则：改写 owner，放进 state.hidden，
    // 这样 storage.onChanged 触发 applyRules 时不会重复隐藏、也不会破坏原始 display。
    g.recs.forEach((r) => { r.owner = id; });
    state.hidden.set(id, g.recs);
    try { await addHideRule(rule); saved++; }
    catch (_) {
      state.hidden.delete(id);
      g.recs.forEach((r) => { r.owner = PENDING_OWNER; });
    }
  }
  state.pending = [];
  closeDetail();
  exitPick();
  await applyRules();
  toast(saved === groups.length
    ? `已保存 ${saved} 条规则 · 以后打开本站自动隐藏`
    : `已保存 ${saved} / ${groups.length} 条`, saved !== groups.length);
}

function onKey(e) {
  if (!state.picking) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    e.stopPropagation();
    undoLast();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (state.detailOpen) closeDetail();
    else exitPick();
  }
}

function enterPick() {
  ensureUI();
  if (state.picking) return;
  state.picking = true;
  state.pending = [];
  state.aiMode = null;
  state.aiCandidates = [];
  state.chain = [];
  state.hoverIdx = 0;
  state.locked = null;
  state.pointEl = null;
  renderBar();
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  toast('隐藏模式 · 点击元素即隐藏，可连续点多个');
}

function exitPick() {
  // 未保存的隐藏全部还原
  clearAiPanel();
  state.pending.forEach((g) => g.recs.forEach(releaseRec));
  state.pending = [];
  state.picking = false;
  state.detailOpen = false;
  state.chain = [];
  state.locked = null;
  if (state.ui.bar) state.ui.bar.style.display = 'none';
  if (state.ui.confirm) state.ui.confirm.style.display = 'none';
  hideHover();
  setCursor(false);
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('wheel', onWheel, { capture: true, passive: false });
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
}

// ---------- 消息 ----------
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'capx:hide-ping') {
    sendResponse({ ok: true, picking: state.picking, host: state.host });
    return false;
  }
  if (msg.type === 'capx:hide-pick') {
    enterPick();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'capx:hide-exit') {
    exitPick();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'capx:hide-apply') {
    // 弹窗手动触发：立即重新应用规则（用于诊断 / 规则变化后强制生效）
    applyRules().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'capx:ai-similar') {
    startSimilar();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'capx:ai-scan') {
    startScan();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'capx:ai-llm') {
    void startLlm();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 规则在弹窗里变化（删除 / 禁用）时实时同步
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.capxHideRules) void applyRules();
});

// ---------- 启动：静默应用规则 ----------
void applyRules();
watchDom();

export { enterPick, exitPick };
