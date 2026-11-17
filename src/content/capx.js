// Capx content core — 消除 + 选元素 + 圈选 + 恢复
// 由 entrypoints/capx.content.ts 调用；本模块只导出 boot / ping，不再自带消息监听。
// 重复注入由 entrypoint 的 window 哨兵负责，模块内只保证「boot 幂等」。

// ---------- 状态 ----------
  const state = {
    active: false,
    mode: 'erase',            // 'erase' | 'capture'
    settings: {
      autoRestore: true,
      format: 'png',
      after: 'both',
      color: '#22d3ee',
      editAfterCapture: false,
      saveDir: 'Capx',
      theme: 'auto',
    },
    erased: [],               // [{ el, prevDisplay, prevImportant, hadStyleAttr, prevStyleAttr, observer, reasserts }]
    // 链式选择：从鼠标下最深元素到根的祖先链（穿透 Shadow DOM 边界）
    chain: [],                // [deepest, ..., shallowest]，不含 body/html
    hoverIdx: 0,              // 当前选中链上的层级索引
    pointEl: null,            // 命中测试递归下钻得到的最深元素
    locked: null,             // 滚轮提升后锁定的外层容器（鼠标在其内部移动时保持高亮）
    quickSelect: null,        // Shift+拖拽就地圈选的起点
    suppressClick: false,     // 快速圈选刚结束，抑制紧随其后的 click
    // 拖拽状态
    dragging: false,
    startX: 0, startY: 0,
    curX: 0, curY: 0,
  };

  const ACCENT_PROP = '--capx-accent';

  // ---------- DOM 工具 ----------
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

  const ICONS = {
    target: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
    frame: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    element: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
  };

  // ---------- UI 引用（惰性创建） ----------
  let ui = {};

  function ensureUI() {
    if (ui.toolbar) return;

    ui.toolbar = h('div', { id: 'capx-toolbar' });
    ui.hoverBox = h('div', { id: 'capx-hover-box' });
    ui.hoverLabel = h('div', { id: 'capx-hover-label' });
    ui.dim = h('div', { id: 'capx-dim' });
    ui.crosshair = h('div', { id: 'capx-crosshair' });
    ui.select = h('div', {
      id: 'capx-select',
      html: '<div class="capx-handle capx-h-tl"></div><div class="capx-handle capx-h-tr"></div><div class="capx-handle capx-h-bl"></div><div class="capx-handle capx-h-br"></div>',
    });
    ui.sizeBadge = h('div', { id: 'capx-size-badge' });
    ui.toast = h('div', { id: 'capx-toast' });

    document.documentElement.append(
      ui.hoverBox, ui.hoverLabel, ui.dim, ui.crosshair, ui.select, ui.sizeBadge, ui.toolbar, ui.toast
    );
  }

  function applyAccent(color) {
    document.documentElement.style.setProperty(ACCENT_PROP, color || '#22d3ee');
  }

  // 主题：把解析后的明暗写到宿主 html 的 data-capx-theme（仅影响 --capx-* 变量）
  function applyTheme(theme) {
    const mode = theme === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (theme === 'light' ? 'light' : 'dark');
    if (mode === 'light') {
      document.documentElement.setAttribute('data-capx-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-capx-theme');
    }
  }

  function clearTheme() {
    document.documentElement.removeAttribute('data-capx-theme');
  }

  function toast(msg, warn = false) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.className = 'capx-show' + (warn ? ' capx-warn' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { ui.toast.className = warn ? 'capx-warn' : ''; }, 2400);
  }

  // ---------- 工具栏（三模式：消除 / 选元素 / 圈选） ----------
  const MODES = [
    { id: 'erase', label: '消除', icon: ICONS.target, tip: '点击移除不想要的内容（M1）' },
    { id: 'pick', label: '选元素', icon: ICONS.element, tip: '悬停选元素，点击截取该元素（M2）' },
    { id: 'capture', label: '圈选', icon: ICONS.frame, tip: '拖拽框选任意区域（M3）' },
  ];

  function renderToolbar() {
    pruneErased();
    ui.toolbar.innerHTML = '';
    const count = state.erased.length;
    const mode = state.mode;
    const hasTarget = !!(state.chain.length && state.chain[state.hoverIdx]);

    // 模式切换段
    const seg = h('div', { class: 'capx-modes' });
    MODES.forEach((m) => {
      seg.append(h('button', {
        type: 'button',
        class: 'capx-mode' + (m.id === mode ? ' active' : ''),
        title: m.tip,
        onClick: () => switchMode(m.id),
      }, m.label));
    });

    let msg;
    if (mode === 'erase') {
      msg = count
        ? `点击移除 · 滚轮调范围 · 已消除 <b>${count}</b> 个`
        : '点击要移除的内容 · 滚轮调范围';
    } else if (mode === 'pick') {
      msg = hasTarget
        ? `已选中：<b>${escapeHtml(describe(state.chain[state.hoverIdx]))}</b> · 点击即截取`
        : '把鼠标移到要截取的元素上';
    } else {
      msg = '拖动鼠标框选要截取的区域';
    }
    ui.msgEl = h('span', { class: 'capx-msg', html: msg });
    ui._msgHtml = ui.msgEl.innerHTML;

    const actions = h('div', { class: 'capx-actions' });
    if (mode === 'erase') {
      actions.append(
        h('button', { type: 'button', onClick: undoErase, id: 'capx-undo', ...(count ? {} : { disabled: 'true' }) }, '撤销')
      );
    } else if (mode === 'pick') {
      ui.captureElBtn = h('button', {
        type: 'button', onClick: captureElement, id: 'capx-capture-el', class: 'capx-primary',
        title: hasTarget ? '截取当前选中的元素（也可按回车）' : '先把鼠标移到要截取的元素上',
        ...(hasTarget ? {} : { disabled: 'true', 'data-empty': 'true' }),
      }, '截取此元素');
      actions.append(ui.captureElBtn);
    } else {
      ui.captureElBtn = null;
    }
    actions.append(h('button', { type: 'button', onClick: cancelAll }, 'Esc 退出'));

    ui.toolbar.append(
      h('span', { class: 'capx-ico', html: MODES.find((m) => m.id === mode).icon }),
      seg,
      ui.msgEl,
      actions
    );
    ui.toolbar.style.display = 'flex';
    // 圈选模式需要十字准星层
    if (mode === 'capture') {
      ui.crosshair.style.display = 'block';
      document.documentElement.style.cursor = 'crosshair';
    }
  }

  // 模式切换
  function switchMode(next) {
    if (!state.active || state.mode === next) return;
    const prev = state.mode;
    // 离开模式时的清理
    if (prev === 'capture') teardownCaptureUI();
    if (prev === 'pick') { state.locked = null; }
    hideHover();
    state.chain = [];
    state.pointEl = null;
    state.hoverIdx = 0;
    state.locked = null;
    _eraseCursorOn = null;
    document.documentElement.style.cursor = '';
    state.mode = next;

    if (next === 'capture') {
      attachCaptureListeners();
    } else if (next === 'pick') {
      // 选元素模式：悬停高亮，点击即截取
    }
    renderToolbar();
    const hint = { erase: '消除模式 · 点击要移除的内容', pick: '选元素模式 · 悬停后点击即截取', capture: '圈选模式 · 拖拽框选区域' };
    toast(hint[next] || '');
  }

  // ---------- 消除模式 ----------
  function setHoverHighlight(el) {
    if (!el) { hideHover(); return; }
    const r = el.getBoundingClientRect();
    Object.assign(ui.hoverBox.style, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
    const desc = describe(el);
    // 标签里的动作提示随模式变化：消除模式说「点击消除」，选元素模式说「点击截取」
    const action = state.mode === 'pick' ? '点击截取' : '点击消除';
    ui.hoverLabel.innerHTML = `<span style="opacity:.6">${escapeHtml(desc)} · ${Math.round(r.width)} × ${Math.round(r.height)}</span> &nbsp;<span style="font-weight:800">${action}</span>`;
    // 标签定位在元素上方，超出顶部则放下方
    let top = r.top - 26;
    if (top < 4) top = r.top + r.height + 6;
    Object.assign(ui.hoverLabel.style, {
      display: 'block',
      left: Math.max(4, r.left) + 'px',
      top: top + 'px',
      maxWidth: Math.min(window.innerWidth - 8, r.width + 200) + 'px',
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hideHover() {
    if (ui.hoverBox) ui.hoverBox.style.display = 'none';
    if (ui.hoverLabel) ui.hoverLabel.style.display = 'none';
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) s += '.' + cls;
    }
    return s;
  }

  // 判断元素是否是我们自己的 UI
  function isOwnUI(el) {
    return el && el.closest && el.closest(
      '#capx-toolbar, #capx-hover-box, #capx-hover-label, #capx-dim, #capx-select, #capx-size-badge, #capx-crosshair, #capx-toast, #capx-onboard, #capx-editor'
    );
  }

  // ---------- 深度命中测试（穿透 Shadow DOM） ----------
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    // 命中 shadow host 时继续下钻到 shadow 内部的最深元素
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // 跨 Shadow DOM 边界取父节点：shadow 内元素向上走到 host
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  // 从最深元素向上构建祖先链（不含 body/html，它们不可消除）
  function buildChain(el) {
    const chain = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      chain.push(cur);
      cur = parentOf(cur);
    }
    return chain;
  }

  // 悬停处理：消除模式与选元素模式共用（都做「就近高亮 + 滚轮调层级」）
  function onEraseMove(e) {
    if (!state.active) return;
    if (state.mode !== 'erase' && state.mode !== 'pick') return;
    if (state.quickSelect) return; // 快速圈选中，不更新高亮

    // 鼠标移到插件自己的 UI（工具栏等）上时：保留当前选中，不清空。
    // 否则用户「选中元素 → 移向按钮」的途中选中就丢了。
    if (isOwnUI(e.target)) {
      setEraseCursor(false);
      return;
    }

    const el = deepElementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnUI(el) || el === document.documentElement || el === document.body) {
      hideHover();
      state.chain = [];
      state.pointEl = null;
      state.locked = null;
      setEraseCursor(false);
      refreshTargetButton();
      return;
    }

    // 滚轮提升后锁定外层容器：鼠标在容器内移动时保持高亮，不乱跳
    if (state.locked && el !== state.locked && state.locked.contains(el)) {
      setHoverHighlight(state.locked);
      setEraseCursor(true);
      refreshTargetButton();
      return;
    }
    if (state.locked && !(el === state.locked || state.locked.contains(el))) {
      state.locked = null;
    }

    if (state.pointEl !== el) {
      state.pointEl = el;
      state.chain = buildChain(el);
      state.hoverIdx = 0; // 就近：默认最深元素
    }
    setHoverHighlight(state.chain[state.hoverIdx]);
    setEraseCursor(true);
    refreshTargetButton();
  }

  // 悬停可消除元素时切换光标形状（自定义准星+取景框，明确「可点击消除」）
  let _eraseCursorOn = null;
  const ERASE_CURSOR_ON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'><rect x='3' y='3' width='20' height='20' rx='4' fill='rgba(34,211,238,0.15)' stroke='%2322d3ee' stroke-width='2'/><line x1='8' y1='13' x2='18' y2='13' stroke='%2322d3ee' stroke-width='2.4' stroke-linecap='round'/></svg>\") 13 13, crosshair";
  function setEraseCursor(on) {
    if (on === _eraseCursorOn) return;
    _eraseCursorOn = on;
    document.documentElement.style.cursor = on ? ERASE_CURSOR_ON : 'default';
  }

  // 仅更新「截取此元素」按钮的可用态与提示，避免整条工具栏重绘
  // 仅更新提示文案与「截取此元素」按钮态（选元素模式）
  function refreshTargetButton() {
    const el = state.chain.length ? state.chain[state.hoverIdx] : null;
    const has = !!el;

    if (state.mode === 'pick') {
      const btn = ui.captureElBtn;
      if (btn) {
        if (btn.disabled === has) btn.disabled = !has;
        if (has) { btn.removeAttribute('data-empty'); btn.title = '截取当前选中的元素（也可按回车）'; }
        else { btn.setAttribute('data-empty', 'true'); btn.title = '先把鼠标移到要截取的元素上'; }
      }
    }

    if (ui.msgEl) {
      let next = null;
      if (state.mode === 'erase') {
        next = `点击移除 · 滚轮调范围 · 已消除 <b>${state.erased.length}</b> 个`;
      } else if (state.mode === 'pick') {
        next = has
          ? `已选中：<b>${escapeHtml(describe(el))}</b> · 点击即截取`
          : '把鼠标移到要截取的元素上';
      }
      if (next !== null && ui._msgHtml !== next) {
        ui._msgHtml = next;
        ui.msgEl.innerHTML = next;
      }
    }
  }

  // 滚轮：向上把选择提升到外层容器，向下收回到更深的子元素（沿链移动，可跨 shadow 边界）
  function onEraseWheel(e) {
    if (!state.active) return;
    if (state.mode !== 'erase' && state.mode !== 'pick') return;
    if (!state.chain.length) return;
    // 在插件 UI 上滚轮不拦截
    if (isOwnUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.deltaY < 0) {
      if (state.hoverIdx < state.chain.length - 1) state.hoverIdx++;
    } else {
      if (state.hoverIdx > 0) state.hoverIdx--;
    }
    const picked = state.chain[state.hoverIdx];
    // 提升到「更外层」时锁定该容器：鼠标在其范围内移动保持高亮，不乱跳；
    // 回到最内层（hoverIdx===0）则解除锁定，恢复就近跟随。
    if (state.hoverIdx > 0) {
      state.locked = picked;
    } else {
      state.locked = null;
    }
    setHoverHighlight(picked);
    setEraseCursor(true);
    refreshTargetButton();
  }

  function onEraseClick(e) {
    if (!state.active) return;
    if (state.mode !== 'erase' && state.mode !== 'pick') return;
    if (state.suppressClick) return;
    if (isOwnUI(e.target)) return;

    // 当前高亮元素（可能已通过滚轮沿链提升/锁定）
    const el = state.locked || state.chain[state.hoverIdx] || deepElementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnUI(el) || el === document.documentElement || el === document.body) return;

    e.preventDefault();
    e.stopPropagation();

    // 选元素模式：点击 = 立即截取该元素
    if (state.mode === 'pick') {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { toast('该元素尺寸过小，无法截取', true); return; }
      hideHover();
      doCapture({ left: r.left, top: r.top, w: r.width, h: r.height });
      return;
    }

    // 消除模式：点击 = 消除该元素
    eraseElement(el);
    state.chain = [];
    state.pointEl = null;
    state.locked = null;
    hideHover();
    const under = deepElementFromPoint(e.clientX, e.clientY);
    if (under && !isOwnUI(under) && under !== document.documentElement && under !== document.body) {
      state.pointEl = under;
      state.chain = buildChain(under);
      state.hoverIdx = 0;
      setHoverHighlight(under);
    }
  }

  const GUARD_LIMIT = 50;   // 页面持续对抗样式的容忍上限

  function eraseElement(el) {
    const prevDisplay = el.style.getPropertyValue('display');
    const prevImportant = el.style.getPropertyPriority('display');
    const hadStyleAttr = el.hasAttribute('style');
    const prevStyleAttr = hadStyleAttr ? el.getAttribute('style') : null;
    const rec = { el, prevDisplay, prevImportant, hadStyleAttr, prevStyleAttr, observer: null, reasserts: 0 };
    state.erased.push(rec);
    el.style.setProperty('display', 'none', 'important');
    attachGuard(rec);
    renderToolbar();
  }

  // SPA 防护：监视被消除元素的内联 style，页面脚本改回去时重新压制
  function attachGuard(rec) {
    try {
      rec.observer = new MutationObserver(() => scheduleReassert(rec));
      rec.observer.observe(rec.el, { attributes: true, attributeFilter: ['style'] });
    } catch (_) { /* 不可观察的元素静默跳过 */ }
  }

  function scheduleReassert(rec) {
    if (rec._pending) return;
    rec._pending = true;
    requestAnimationFrame(() => {
      rec._pending = false;
      reassert(rec);
    });
  }

  function reassert(rec) {
    // 记录已恢复/放弃则不动作（也防止与我们自己的写入形成回环）
    if (!state.erased.includes(rec)) return;
    const el = rec.el;
    if (!el.isConnected) return;
    if (getComputedStyle(el).display !== 'none') {
      el.style.setProperty('display', 'none', 'important');
      rec.reasserts++;
      if (rec.reasserts > GUARD_LIMIT) giveUp(rec);
    }
  }

  // 页面框架持续重置样式时放弃该元素，避免无限拉锯
  function giveUp(rec) {
    const i = state.erased.indexOf(rec);
    if (i >= 0) state.erased.splice(i, 1);
    if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
    restoreRecord(rec);
    toast('页面持续重置该元素样式，已放弃隐藏它', true);
    renderToolbar();
  }

  // 清理已从文档移除的记录（SPA 重渲染会整体丢弃旧节点）
  function pruneErased() {
    for (let i = state.erased.length - 1; i >= 0; i--) {
      const rec = state.erased[i];
      if (!rec.el.isConnected) {
        if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
        state.erased.splice(i, 1);
      }
    }
  }

  function undoErase() {
    const rec = state.erased.pop();
    if (!rec) return;
    restoreRecord(rec);
    renderToolbar();
    toast('已撤销上一步消除');
  }

  function restoreRecord(rec) {
    const { el, prevDisplay, prevImportant, hadStyleAttr } = rec;
    // 先断开守护观察器，避免恢复写入被当作页面行为再次压制
    if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
    if (!el || !el.style) return;
    if (prevDisplay === '') {
      el.style.removeProperty('display');
    } else {
      el.style.setProperty('display', prevDisplay, prevImportant || '');
    }
    // 若原本没有 style 属性，恢复后把空的 style="" 一并移除，做到完全无痕
    if (!hadStyleAttr && el.getAttribute('style') === '') {
      el.removeAttribute('style');
    }
  }

  function restoreAll() {
    // 从后往前恢复
    while (state.erased.length) {
      const rec = state.erased.pop();
      restoreRecord(rec);
    }
  }

  // ---------- 整元素截取 ----------
  // 直接截取当前高亮元素（复用 doCapture 的裁剪/导出/恢复链路）
  function captureElement() {
    if (!state.active) return;
    if (state.mode !== 'erase' && state.mode !== 'pick') return;
    const el = state.locked || state.chain[state.hoverIdx];
    if (!el) { toast('先把鼠标移到要截取的元素上', true); return; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { toast('该元素尺寸过小，无法截取', true); return; }
    hideHover();
    doCapture({ left: r.left, top: r.top, w: r.width, h: r.height });
  }

  function teardownCaptureUI() {
    ui.crosshair.style.display = 'none';
    ui.dim.style.display = 'none';
    ui.select.style.display = 'none';
    ui.sizeBadge.style.display = 'none';
    document.documentElement.style.cursor = '';
    detachCaptureListeners();
  }

  function onCaptureMouseDown(e) {
    if (state.mode !== 'capture') return;
    if (isOwnUI(e.target)) return;
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();
    state.dragging = true;
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.curX = e.clientX;
    state.curY = e.clientY;
    ui.select.style.display = 'block';
    ui.sizeBadge.style.display = 'block';
    updateSelectBox();
  }

  function onCaptureMouseMove(e) {
    if (state.mode !== 'capture') return;
    if (!state.dragging) return;
    state.curX = e.clientX;
    state.curY = e.clientY;
    updateSelectBox();
  }

  function onCaptureMouseUp(e) {
    if (state.mode !== 'capture' || !state.dragging) return;
    state.dragging = false;
    const rect = normalizeRect(state.startX, state.startY, e.clientX, e.clientY);
    // 太小的选区视为误触
    if (rect.w < 8 || rect.h < 8) {
      ui.select.style.display = 'none';
      ui.sizeBadge.style.display = 'none';
      return;
    }
    // 直接导出该区域
    doCapture(rect);
  }

  function normalizeRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const hgt = Math.abs(y2 - y1);
    return { left, top, w, h: hgt };
  }

  function updateSelectBox() {
    const rect = normalizeRect(state.startX, state.startY, state.curX, state.curY);
    Object.assign(ui.select.style, {
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.w + 'px',
      height: rect.h + 'px',
    });
    ui.sizeBadge.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
    let bTop = rect.top + rect.h + 8;
    if (bTop + 26 > window.innerHeight) bTop = rect.top + rect.h - 32;
    Object.assign(ui.sizeBadge.style, {
      left: Math.min(rect.left + rect.w - 100, window.innerWidth - 130) + 'px',
      top: bTop + 'px',
    });
  }

  // ---------- 导出截图 ----------
  async function doCapture(rect) {
    state._modeBeforeCapture = state.mode;
    pruneErased();
    // 截图前先隐藏所有 Capx UI，保证画面干净
    const hidden = hideForShot();
    // 等两帧让布局稳定
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let cropped = null;
    try {
      const dataUrl = await grabViewport();
      cropped = await cropDataUrl(dataUrl, rect);
    } catch (err) {
      console.error('[capx] capture failed', err);
      toast('截图失败：' + (err.message || '未知错误'), true);
    } finally {
      showAfterShot(hidden);
    }
    if (!cropped) { finishAfterCapture(); return; }

    // 截后编辑：开启时先进入编辑器，用户确认后再导出
    if (state.settings.editAfterCapture) {
      openEditor(cropped, () => finishAfterCapture());
    } else {
      await deliver(cropped);
      finishAfterCapture();
    }
  }

  function hideForShot() {
    const els = [ui.toolbar, ui.hoverBox, ui.hoverLabel, ui.dim, ui.select, ui.sizeBadge, ui.crosshair, ui.toast, document.getElementById('capx-onboard')];
    const saved = els.map((el) => (el ? el.style.visibility : ''));
    els.forEach((el) => { if (el) el.style.visibility = 'hidden'; });
    return { els, saved };
  }

  function showAfterShot(hidden) {
    hidden.els.forEach((el, i) => { if (el) el.style.visibility = hidden.saved[i]; });
  }

  // 通过 background service worker 调 captureVisibleTab；这里用 runtime 消息
  function grabViewport() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'capx:grab' }, (resp) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!resp || !resp.ok) { reject(new Error(resp && resp.error ? resp.error : '截图失败')); return; }
        resolve(resp.dataUrl);
      });
    });
  }

  // 把整屏 dataUrl 按选区(设备像素)裁剪
  async function cropDataUrl(dataUrl, rect) {
    const img = await loadImage(dataUrl);
    const dpr = window.devicePixelRatio || 1;
    // captureVisibleTab 返回的是设备像素图，其尺寸 = 视口CSS尺寸 * dpr
    const sx = Math.max(0, Math.round(rect.left * dpr));
    const sy = Math.max(0, Math.round(rect.top * dpr));
    const sw = Math.min(img.width - sx, Math.round(rect.w * dpr));
    const sh = Math.min(img.height - sy, Math.round(rect.h * dpr));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const ctx = canvas.getContext('2d');

    // JPG 需要白底
    const fmt = state.settings.format === 'jpg' ? 'jpeg' : 'png';
    if (fmt === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const quality = fmt === 'jpeg' ? 0.92 : undefined;
    return { dataUrl: canvas.toDataURL('image/' + fmt, quality), ext: fmt === 'jpeg' ? 'jpg' : 'png' };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图像加载失败'));
      im.src = src;
    });
  }

  async function deliver(result) {
    const { dataUrl, ext } = result;
    const after = state.settings.after; // 'both'(保存+复制) | 'copy'(仅复制)

    let copied = false;
    // 复制到剪贴板（两种模式都先尝试复制）
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copied = true;
    } catch (err) {
      console.warn('[capx] clipboard failed', err);
    }

    if (after === 'both') {
      const { name, downloadId } = await triggerDownload(dataUrl, ext);
      toast(copied ? '已保存并复制到剪贴板（点图标可打开文件夹）' : '已保存到下载文件夹（点图标可打开文件夹）');
      recordHistory(dataUrl, name, downloadId);
    } else {
      // 仅复制模式：复制失败则退回下载，保证一定拿得到截图
      if (copied) {
        toast('已复制到剪贴板');
        recordHistory(dataUrl, '');
      } else {
        const { name, downloadId } = await triggerDownload(dataUrl, ext);
        toast('复制失败，已改为下载', true);
        recordHistory(dataUrl, name, downloadId);
      }
    }
  }

  function triggerDownload(dataUrl, ext) {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `capx-${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
    // 防御性清洗：只允许「相对子路径」，去反斜杠/非法文件名字符/点段（弹窗侧已校验，这里兜底）
    const dir = String(state.settings.saveDir || '')
      .replace(/\\/g, '/')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..' && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s))
      .join('/');
    const path = dir ? `${dir}/${name}` : name;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (downloadId) => {
        if (settled) return;
        settled = true;
        resolve({ name: path, downloadId: downloadId ?? null });
      };
      chrome.runtime.sendMessage({ type: 'capx:download', dataUrl, filename: path }, (res) => {
        if (chrome.runtime.lastError) { finish(null); return; }
        if (res && res.ok === false) toast('保存失败：' + (res.error || '未知错误'), true);
        finish(res && res.ok ? res.id : null);
      });
      // 兜底：回调迟迟不来也不能卡住截图流程
      setTimeout(() => finish(null), 1500);
    });
  }

  // 生成小尺寸缩略图（用于历史记录，控制 storage 体积）
  const HISTORY_MAX = 20;
  async function recordHistory(fullDataUrl, filename, downloadId) {
    try {
      const img = await loadImage(fullDataUrl);
      const maxW = 320, maxH = 200;
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const hh = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      const cx = c.getContext('2d');
      cx.fillStyle = '#0f1319';
      cx.fillRect(0, 0, w, hh);
      cx.drawImage(img, 0, 0, w, hh);
      const thumb = c.toDataURL('image/jpeg', 0.72);

      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const store = await chrome.storage.local.get({ capxHistory: [] });
      const list = store.capxHistory || [];
      list.unshift({
        id,
        thumb, w: img.width, h: img.height,
        name: filename || '',
        path: filename || '',
        downloadId: downloadId ?? null,
        at: Date.now(),
      });
      const trimmed = list.slice(0, HISTORY_MAX);
      await chrome.storage.local.set({ capxHistory: trimmed });

      // 原图存扩展 IndexedDB（storage.local 放不下大图），供弹窗「复制」用。
      // 注意：content script 的 indexedDB 属于宿主页面、与扩展不共享，必须经 background 中转。
      await storeFullImageViaBackground(id, fullDataUrl);
    } catch (err) {
      console.warn('[capx] history failed', err);
    }
  }

  // 把原图交给 background 写入扩展 IndexedDB（异步，不阻塞截图收尾）
  function storeFullImageViaBackground(id, dataUrl) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'capx:store-image', id, dataUrl }, () => {
          // 忽略 lastError（上下文失效等）
          void chrome.runtime.lastError;
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  // 截图完成后的收尾
  function finishAfterCapture() {
    const autoRestore = state.settings.autoRestore !== false;
    if (autoRestore) {
      restoreAll();
      teardown();
    } else {
      // 不自动恢复：回到之前模式，让用户手动退出（仍保留消除状态）
      teardownCaptureUI();
      state.mode = state._modeBeforeCapture || 'erase';
      document.documentElement.style.cursor = '';
      _eraseCursorOn = null;
      renderToolbar();
      toast('已截图 · 页面保持消除状态，按 Esc 恢复');
    }
  }

  // ---------- 截后标注编辑器 ----------
  const ED = {
    open: false,
    root: null,
    canvas: null,
    ctx: null,
    baseImg: null,        // 原始截图 Image
    natW: 0, natH: 0,     // 原始像素尺寸
    dispW: 0, dispH: 0,   // 屏幕上显示尺寸（CSS px）
    scale: 1,             // disp / nat
    tool: 'arrow',        // arrow | rect | text | pen | mosaic
    color: '#22d3ee',
    lineWidth: 4,         // 以原始像素为单位
    ops: [],              // 已提交的标注
    redo: [],
    drawing: null,        // 正在绘制的临时 op
    onDone: null,
    textEl: null,
    // 裁切：拖拽中的选框（显示坐标）与已确认的裁切态
    cropMode: false,      // 是否处于裁切拖拽态
    cropRect: null,       // {x,y,w,h} 显示坐标，待确认
    cropButtons: null,
  };

  let edHandlers = null;

  function openEditor(cropped, onDone) {
    // 编辑器接管期间停掉消除模式的页面监听，避免误吞编辑器交互
    detachEraseListeners();
    ED.onDone = onDone;
    ED.ops = [];
    ED.redo = [];
    ED.drawing = null;
    ED.tool = 'arrow';
    ED.color = state.settings.color || '#22d3ee';
    ED.lineWidth = 4;

    loadImage(cropped.dataUrl).then((img) => {
      ED.baseImg = img;
      ED.natW = img.naturalWidth || img.width;
      ED.natH = img.naturalHeight || img.height;
      buildEditorUI(cropped);
    }).catch((err) => {
      console.error('[capx] editor image load failed', err);
      toast('编辑器加载失败：' + (err.message || ''), true);
      onDone && onDone();
    });
  }

  function buildEditorUI(cropped) {
    // 计算显示尺寸：最多占视口 82%，不放大超过原始尺寸
    const maxW = window.innerWidth * 0.82;
    const maxH = window.innerHeight * 0.82;
    let dispW = ED.natW, dispH = ED.natH;
    const s = Math.min(1, maxW / ED.natW, maxH / ED.natH);
    dispW = Math.round(ED.natW * s);
    dispH = Math.round(ED.natH * s);
    ED.dispW = dispW; ED.dispH = dispH;
    ED.scale = dispW / ED.natW;

    const root = h('div', { id: 'capx-editor' });

    // 画布
    const canvas = document.createElement('canvas');
    canvas.width = dispW; canvas.height = dispH;
    canvas.className = 'capx-ed-canvas';
    ED.canvas = canvas;
    ED.ctx = canvas.getContext('2d');

    // 工具栏
    const toolbar = h('div', { class: 'capx-ed-toolbar' });
    const tools = [
      { id: 'arrow', label: '箭头', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>' },
      { id: 'rect', label: '矩形', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>' },
      { id: 'text', label: '文字', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M12 6v13M8 19h8"/></svg>' },
      { id: 'pen', label: '画笔', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>' },
      { id: 'mosaic', label: '马赛克', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/></svg>' },
      { id: 'crop', label: '裁切', svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/></svg>' },
    ];
    const toolBtns = {};
    const toolWrap = h('div', { class: 'capx-ed-group' });
    tools.forEach((t) => {
      const b = h('button', {
        type: 'button', class: 'capx-ed-tool', title: t.label,
        onClick: () => setTool(t.id),
      });
      b.innerHTML = t.svg;
      toolBtns[t.id] = b;
      toolWrap.append(b);
    });
    ED._toolBtns = toolBtns;

    // 颜色
    const colors = ['#22d3ee', '#f0976b', '#4ade80', '#a78bfa', '#f43f5e', '#e6e9ef'];
    const colorWrap = h('div', { class: 'capx-ed-group' });
    const colorBtns = [];
    colors.forEach((c) => {
      const b = h('button', { type: 'button', class: 'capx-ed-color', style: { background: c }, title: c,
        onClick: () => setColor(c) });
      colorBtns.push(b);
      colorWrap.append(b);
    });
    ED._colorBtns = colorBtns;

    // 线宽
    const widthWrap = h('div', { class: 'capx-ed-group' });
    const widths = [2, 4, 7, 11];
    const widthBtns = [];
    widths.forEach((wv) => {
      const b = h('button', { type: 'button', class: 'capx-ed-width', title: wv + 'px',
        onClick: () => setLineWidth(wv) });
      b.innerHTML = `<span style="width:${Math.min(16, wv + 3)}px;height:${wv}px;display:block;border-radius:2px;background:currentColor"></span>`;
      b.dataset.w = wv;
      widthBtns.push(b);
      widthWrap.append(b);
    });
    ED._widthBtns = widthBtns;

    // 撤销/重做
    const histWrap = h('div', { class: 'capx-ed-group' });
    const undoBtn = h('button', { type: 'button', class: 'capx-ed-tool', title: '撤销 (Ctrl+Z)', onClick: editorUndo }, '↶');
    const redoBtn = h('button', { type: 'button', class: 'capx-ed-tool', title: '重做 (Ctrl+Shift+Z)', onClick: editorRedo }, '↷');
    ED._undoBtn = undoBtn; ED._redoBtn = redoBtn;
    histWrap.append(undoBtn, redoBtn);

    toolbar.append(toolWrap, sep(), colorWrap, sep(), widthWrap, sep(), histWrap);

    // 右上操作
    const actions = h('div', { class: 'capx-ed-actions' });
    actions.append(
      h('button', { type: 'button', class: 'capx-ed-cancel', onClick: editorCancel }, '取消'),
      h('button', { type: 'button', class: 'capx-ed-done', onClick: editorConfirm }, '完成 ✓')
    );

    // 顶部条
    const topbar = h('div', { class: 'capx-ed-topbar' }, toolbar, actions);
    // 画布容器（居中）
    const stage = h('div', { class: 'capx-ed-stage' });
    stage.append(canvas);

    const wrap = h('div', { class: 'capx-ed-wrap' });
    wrap.append(topbar, stage);
    root.append(wrap);
    document.documentElement.append(root);
    ED.root = root;
    ED.open = true;
    ED._mosaicSrc = buildMosaicSource();

    setTool('arrow');
    setColor(ED.color);
    setLineWidth(4);
    updateHistBtns();
    renderEditor();
    attachEditorHandlers();
  }

  function sep() { return h('span', { class: 'capx-ed-sep' }); }

  function setTool(id) {
    // 切走裁切工具时清掉未确认的裁切框
    if (ED.tool === 'crop' && id !== 'crop') cancelCrop();
    ED.tool = id;
    if (ED._toolBtns) Object.entries(ED._toolBtns).forEach(([k, b]) => b.classList.toggle('active', k === id));
    if (ED.canvas) ED.canvas.style.cursor = (id === 'text') ? 'text' : (id === 'crop' ? 'crosshair' : 'crosshair');
  }
  function setColor(c) {
    ED.color = c;
    if (ED._colorBtns) ED._colorBtns.forEach((b) => b.classList.toggle('active', b.title === c));
  }
  function setLineWidth(w) {
    ED.lineWidth = w;
    if (ED._widthBtns) ED._widthBtns.forEach((b) => b.classList.toggle('active', +b.dataset.w === w));
  }

  function updateHistBtns() {
    if (ED._undoBtn) ED._undoBtn.disabled = ED.ops.length === 0;
    if (ED._redoBtn) ED._redoBtn.disabled = ED.redo.length === 0;
  }

  // 画布坐标系换算（事件坐标 → canvas CSS 坐标）
  function canvasPoint(e) {
    const r = ED.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left), y: (e.clientY - r.top) };
  }

  function attachEditorHandlers() {
    const cv = ED.canvas;
    const down = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = canvasPoint(e);
      if (ED.tool === 'text') { placeTextInput(p, e); return; }
      // 裁切：拖出选框
      if (ED.tool === 'crop') {
        clearCropButtons();
        ED.drawing = { tool: 'crop', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        renderEditor();
        return;
      }
      ED.drawing = {
        tool: ED.tool, color: ED.color, lw: ED.lineWidth,
        x0: p.x, y0: p.y, x1: p.x, y1: p.y,
        pts: (ED.tool === 'pen' || ED.tool === 'mosaic') ? [p] : null,
      };
      renderEditor();
    };
    const move = (e) => {
      if (!ED.drawing) return;
      const p = canvasPoint(e);
      // 限制在画布内
      const cx = Math.max(0, Math.min(ED.dispW, p.x));
      const cy = Math.max(0, Math.min(ED.dispH, p.y));
      ED.drawing.x1 = cx; ED.drawing.y1 = cy;
      if ((ED.tool === 'pen' || ED.tool === 'mosaic') && ED.drawing.pts) ED.drawing.pts.push({ x: cx, y: cy });
      renderEditor();
    };
    const up = (e) => {
      if (!ED.drawing) return;
      const d = ED.drawing;
      ED.drawing = null;

      // 裁切：生成待确认选框 + 确认/重设按钮
      if (d.tool === 'crop') {
        const rect = normRect(d.x0, d.y0, d.x1, d.y1);
        if (rect.w >= 12 && rect.h >= 12) {
          ED.cropRect = rect;
          showCropButtons();
        }
        renderEditor();
        return;
      }

      // 过滤过小的误触
      const tooSmall = (d.tool === 'pen' || d.tool === 'mosaic')
        ? (!d.pts || d.pts.length < 2)
        : (Math.abs(d.x1 - d.x0) < 4 && Math.abs(d.y1 - d.y0) < 4);
      if (!tooSmall) {
        ED.ops.push(d);
        ED.redo = [];
      }
      updateHistBtns();
      renderEditor();
    };
    ED.canvas.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    const key = (e) => {
      if (!ED.open) return;
      if (e.key === 'Escape') { e.preventDefault(); editorCancel(); }
      else if (e.key === 'Enter' && ED.tool === 'crop' && ED.cropRect) { e.preventDefault(); confirmCrop(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) editorRedo(); else editorUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault(); editorRedo();
      }
    };
    window.addEventListener('keydown', key, true);
    edHandlers = { down, move, up, key };
  }

  function detachEditorHandlers() {
    if (!edHandlers) return;
    window.removeEventListener('mousemove', edHandlers.move, true);
    window.removeEventListener('mouseup', edHandlers.up, true);
    window.removeEventListener('keydown', edHandlers.key, true);
    edHandlers = null;
  }

  // 文字工具：在点击处放一个 input，回车/失焦提交
  function placeTextInput(p, ev) {
    if (ED.textEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'capx-ed-textinput';
    input.placeholder = '输入文字…';
    const stageRect = ED.canvas.getBoundingClientRect();
    input.style.left = (stageRect.left + p.x) + 'px';
    input.style.top = (stageRect.top + p.y) + 'px';
    input.style.color = ED.color;
    input.style.fontSize = Math.max(14, ED.lineWidth * 5) + 'px';
    document.documentElement.append(input);
    ED.textEl = input;
    setTimeout(() => input.focus(), 0);

    const commit = () => {
      if (ED.textEl !== input) return; // 幂等：blur 与 Enter 可能双触发
      ED.textEl = null;
      const val = input.value.trim();
      if (val) {
        ED.ops.push({ tool: 'text', color: input.style.color, lw: ED.lineWidth, x0: p.x, y0: p.y, text: val, fontSize: parseFloat(input.style.fontSize) });
        ED.redo = [];
      }
      if (input.parentNode) input.remove();
      updateHistBtns(); renderEditor();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (ED.textEl === input) ED.textEl = null;
        if (input.parentNode) input.remove();
        renderEditor();
      }
    });
    input.addEventListener('blur', commit);
  }

  function editorUndo() {
    if (!ED.ops.length) return;
    ED.redo.push(ED.ops.pop());
    updateHistBtns(); renderEditor();
  }
  function editorRedo() {
    if (!ED.redo.length) return;
    ED.ops.push(ED.redo.pop());
    updateHistBtns(); renderEditor();
  }

  // 在指定 ctx 与坐标系下绘制所有 op
  // sx/sy：op 坐标→目标坐标的缩放；mosaic：{ small, factor } 用于马赛克取样
  function paintOps(ctx, ops, sx, sy, mosaic) {
    ops.forEach((op) => {
      if (op.tool === 'mosaic') {
        drawMosaicOp(ctx, op, sx, sy, mosaic);
        return;
      }
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = Math.max(1, op.lw * sx);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (op.tool === 'rect') {
        const x = Math.min(op.x0, op.x1) * sx, y = Math.min(op.y0, op.y1) * sy;
        const w = Math.abs(op.x1 - op.x0) * sx, hh = Math.abs(op.y1 - op.y0) * sy;
        ctx.strokeRect(x, y, w, hh);
      } else if (op.tool === 'arrow') {
        drawArrow(ctx, op.x0 * sx, op.y0 * sy, op.x1 * sx, op.y1 * sy, Math.max(1, op.lw * sx));
      } else if (op.tool === 'pen') {
        ctx.beginPath();
        op.pts.forEach((pt, i) => {
          const X = pt.x * sx, Y = pt.y * sy;
          if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        });
        ctx.stroke();
      } else if (op.tool === 'text') {
        ctx.font = `700 ${Math.max(10, op.fontSize * sx)}px -apple-system, "PingFang SC", system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(op.text, op.x0 * sx, op.y0 * sy);
      }
      ctx.restore();
    });
  }

  // 马赛克：以粗笔触为裁剪路径，把低分辨率取样图放大铺上去（近邻采样=像素块）
  function drawMosaicOp(ctx, op, sx, sy, mosaic) {
    if (!mosaic || !mosaic.small || !op.pts || op.pts.length < 1) return;
    const block = Math.max(6, op.lw * 3);          // 目标坐标下的马赛克块大小
    const lineW = Math.max(6, op.lw * sx * 1.6);   // 笔触宽度（目标坐标）
    ctx.save();
    ctx.beginPath();
    if (op.pts.length === 1) {
      ctx.arc(op.pts[0].x * sx, op.pts[0].y * sy, lineW / 2, 0, Math.PI * 2);
    } else {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lineW;
      op.pts.forEach((pt, i) => {
        const X = pt.x * sx, Y = pt.y * sy;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      });
      // 用 stroke 形状裁剪：需先描边成实心路径——改用 lineTo 轮廓不可行，
      // 这里改用「实心描边绘制马赛克块」的方式，见下。
    }
    ctx.restore();

    // 逐点铺马赛克块（简单可靠，跨帧/导出一致）
    const small = mosaic.small;       // 低分辨率取样 canvas
    const sScale = small.width / (ED.natW); // small → 原始比例
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const R = lineW / 2;
    op.pts.forEach((pt) => {
      const gx = pt.x * sx, gy = pt.y * sy;
      // 对齐到 block 网格，避免抖动
      const bx = Math.floor((gx - R) / block) * block;
      const by = Math.floor((gy - R) / block) * block;
      // 该块在显示坐标下的范围映射回取样图
      for (let x = bx; x <= gx + R; x += block) {
        for (let y = by; y <= gy + R; y += block) {
          if (Math.hypot(x + block / 2 - gx, y + block / 2 - gy) > R + block * 0.4) continue;
          // 取样：显示坐标 x → 原始坐标 x/sx（sx=1 显示；导出 sx=1/scale）
          const natX = x / sx;
          const natY = y / sy;
          const sxp = natX * sScale;
          const syp = natY * sScale;
          const sw = Math.max(1, block / sx * sScale);
          const sh = Math.max(1, block / sy * sScale);
          ctx.drawImage(small, sxp, syp, sw, sh, x, y, block, block);
        }
      }
    });
    ctx.restore();
  }

  function drawArrow(ctx, x0, y0, x1, y1, lw) {
    const head = Math.max(8, lw * 3.2);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    // 线身（略缩短以免箭头戳出）
    const bx = x1 - Math.cos(ang) * head * 0.8;
    const by = y1 - Math.sin(ang) * head * 0.8;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(bx, by); ctx.stroke();
    // 箭头三角
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - Math.cos(ang - Math.PI / 7) * head, y1 - Math.sin(ang - Math.PI / 7) * head);
    ctx.lineTo(x1 - Math.cos(ang + Math.PI / 7) * head, y1 - Math.sin(ang + Math.PI / 7) * head);
    ctx.closePath();
    ctx.fill();
  }

  // ---------- 裁切辅助 ----------
  function normRect(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  function showCropButtons() {
    clearCropButtons();
    const r = ED.cropRect;
    const stageRect = ED.canvas.getBoundingClientRect();
    const bar = h('div', { class: 'capx-ed-cropbar' });
    bar.append(
      h('span', { class: 'capx-ed-cropsize' }, `${Math.round(r.w)} × ${Math.round(r.h)}`),
      h('button', { type: 'button', class: 'capx-ed-cropapply', onClick: confirmCrop }, '应用裁切 ✓'),
      h('button', { type: 'button', class: 'capx-ed-cropreset', onClick: () => { ED.cropRect = null; clearCropButtons(); renderEditor(); } }, '重设')
    );
    bar.style.left = (stageRect.left + r.x + r.w / 2) + 'px';
    bar.style.top = (stageRect.top + r.y + r.h + 10) + 'px';
    document.documentElement.append(bar);
    ED.cropButtons = bar;
  }

  function clearCropButtons() {
    if (ED.cropButtons) { ED.cropButtons.remove(); ED.cropButtons = null; }
  }

  function cancelCrop() {
    ED.cropRect = null;
    clearCropButtons();
  }

  // 应用裁切：把当前底图 + 已绘标注压平，再裁切为新底图（保证坐标零漂移）
  function confirmCrop() {
    if (!ED.cropRect) return;
    const r = ED.cropRect;
    // 1) 先把当前状态（底图+ops）以显示分辨率压平
    const flat = document.createElement('canvas');
    flat.width = ED.dispW; flat.height = ED.dispH;
    const fx = flat.getContext('2d');
    fx.drawImage(ED.baseImg, 0, 0, ED.dispW, ED.dispH);
    paintOps(fx, ED.ops, 1, 1, { small: ED._mosaicSrc });

    // 2) 从压平图裁出选框
    const cw = Math.max(1, Math.round(r.w)), ch2 = Math.max(1, Math.round(r.h));
    const cropped = document.createElement('canvas');
    cropped.width = cw; cropped.height = ch2;
    cropped.getContext('2d').drawImage(flat, r.x, r.y, cw, ch2, 0, 0, cw, ch2);

    // 3) 用裁剪结果替换底图（转换成 Image），重置标注、重算尺寸
    const dataUrl = cropped.toDataURL('image/png');
    loadImage(dataUrl).then((img) => {
      ED.baseImg = img;
      ED.natW = img.naturalWidth; ED.natH = img.naturalHeight;
      ED.ops = []; ED.redo = [];
      ED.cropRect = null;
      clearCropButtons();
      // 重新适配画布尺寸
      const maxW = window.innerWidth * 0.82, maxH = window.innerHeight * 0.82;
      const s = Math.min(1, maxW / ED.natW, maxH / ED.natH);
      ED.dispW = Math.round(ED.natW * s); ED.dispH = Math.round(ED.natH * s);
      ED.scale = ED.dispW / ED.natW;
      ED.canvas.width = ED.dispW; ED.canvas.height = ED.dispH;
      ED._mosaicSrc = buildMosaicSource();
      updateHistBtns();
      renderEditor();
      toast('已裁切 · 如需撤销可继续操作');
    });
  }

  // 构造马赛克取样图：把底图缩到很小，之后用近邻放大即得色块
  function buildMosaicSource(regionW, regionH) {
    const factor = 24; // 每 block 约等于 24 原始像素
    const w = Math.max(1, Math.round(ED.natW / factor));
    const hh = Math.max(1, Math.round(ED.natH / factor));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.drawImage(ED.baseImg, 0, 0, w, hh);
    return c;
  }

  // 重绘显示画布：底图 + 已提交 ops + 正在绘制的临时 op + 裁切框
  function renderEditor() {
    const ctx = ED.ctx;
    ctx.clearRect(0, 0, ED.dispW, ED.dispH);
    ctx.drawImage(ED.baseImg, 0, 0, ED.dispW, ED.dispH);
    const mosaic = { small: ED._mosaicSrc };
    paintOps(ctx, ED.ops, 1, 1, mosaic);
    if (ED.drawing) paintOps(ctx, [ED.drawing], 1, 1, mosaic);
    // 裁切选框
    if (ED.cropRect) drawCropBox(ctx, ED.cropRect);
    else if (ED.drawing && ED.drawing.tool === 'crop') {
      drawCropBox(ctx, normRect(ED.drawing.x0, ED.drawing.y0, ED.drawing.x1, ED.drawing.y1));
    }
  }

  function drawCropBox(ctx, r) {
    ctx.save();
    // 变暗框外
    ctx.fillStyle = 'rgba(5,8,12,0.6)';
    ctx.fillRect(0, 0, ED.dispW, r.y);
    ctx.fillRect(0, r.y + r.h, ED.dispW, ED.dispH - (r.y + r.h));
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, ED.dispW - (r.x + r.w), r.h);
    // 框线
    ctx.strokeStyle = ED.color || '#22d3ee';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.restore();
  }

  // 合成最终图（原始分辨率）
  function composeFinal() {
    const cropN = ED.cropRect ? {
      x: Math.round(ED.cropRect.x / ED.scale),
      y: Math.round(ED.cropRect.y / ED.scale),
      w: Math.round(ED.cropRect.w / ED.scale),
      h: Math.round(ED.cropRect.h / ED.scale),
    } : null;
    const outW = cropN ? cropN.w : ED.natW;
    const outH = cropN ? cropN.h : ED.natH;

    const c = document.createElement('canvas');
    c.width = Math.max(1, outW); c.height = Math.max(1, outH);
    const ctx = c.getContext('2d');
    const fmt = state.settings.format === 'jpg' ? 'jpeg' : 'png';
    if (fmt === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }

    const ox = cropN ? cropN.x : 0;
    const oy = cropN ? cropN.y : 0;
    // 底图（可能被裁切）
    ctx.drawImage(ED.baseImg, ox, oy, outW, outH, 0, 0, outW, outH);
    // op 坐标是显示坐标：映射回原始 = /scale，再减去裁切偏移
    ctx.save();
    ctx.translate(-ox, -oy);
    const mosaic = { small: ED._mosaicSrc };
    paintOps(ctx, ED.ops, 1 / ED.scale, 1 / ED.scale, mosaic);
    ctx.restore();

    const quality = fmt === 'jpeg' ? 0.92 : undefined;
    return { dataUrl: c.toDataURL('image/' + fmt, quality), ext: fmt === 'jpeg' ? 'jpg' : 'png' };
  }

  async function editorConfirm() {
    const result = composeFinal();
    const done = ED.onDone;
    closeEditor();
    await deliver(result);
    done && done();
  }

  function editorCancel() {
    // 取消 = 放弃这张截图（不导出）
    const done = ED.onDone;
    closeEditor();
    toast('已取消编辑，未保存');
    done && done();
  }

  function closeEditor() {
    ED.open = false;
    detachEditorHandlers();
    clearCropButtons();
    ED.cropRect = null;
    if (ED.textEl) { ED.textEl.remove(); ED.textEl = null; }
    if (ED.root) { ED.root.remove(); ED.root = null; }
  }

  // ---------- 生命周期 ----------
  function attachEraseListeners() {
    document.addEventListener('mousemove', onEraseMove, true);
    document.addEventListener('click', onEraseClick, true);
    document.addEventListener('wheel', onEraseWheel, { capture: true, passive: false });
    // Shift + 拖拽 = 就地快速圈选（无需先切到圈选模式）
    document.addEventListener('mousedown', onQuickSelectDown, true);
    document.addEventListener('mousemove', onQuickSelectMove, true);
    document.addEventListener('mouseup', onQuickSelectUp, true);
  }
  function detachEraseListeners() {
    document.removeEventListener('mousemove', onEraseMove, true);
    document.removeEventListener('click', onEraseClick, true);
    document.removeEventListener('wheel', onEraseWheel, { capture: true, passive: false });
    document.removeEventListener('mousedown', onQuickSelectDown, true);
    document.removeEventListener('mousemove', onQuickSelectMove, true);
    document.removeEventListener('mouseup', onQuickSelectUp, true);
  }

  // ---------- Shift + 拖拽：就地圈选 ----------
  function onQuickSelectDown(e) {
    if (!state.active || state.mode !== 'erase') return;
    if (!e.shiftKey || e.button !== 0) return;
    if (isOwnUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    state.quickSelect = { startX: e.clientX, startY: e.clientY };
    state.dragging = false;
    hideHover();
    setEraseCursor(false);
    ui.select.style.display = 'block';
    ui.sizeBadge.style.display = 'block';
    document.documentElement.style.cursor = 'crosshair';
    updateSelectBoxAt(e.clientX, e.clientY);
  }

  function onQuickSelectMove(e) {
    if (!state.quickSelect) return;
    e.preventDefault();
    e.stopPropagation();
    updateSelectBoxAt(e.clientX, e.clientY);
  }

  function onQuickSelectUp(e) {
    if (!state.quickSelect) return;
    const { startX, startY } = state.quickSelect;
    state.quickSelect = null;
    e.preventDefault();
    e.stopPropagation();
    const rect = normalizeRect(startX, startY, e.clientX, e.clientY);
    ui.select.style.display = 'none';
    ui.sizeBadge.style.display = 'none';
    document.documentElement.style.cursor = '';
    _eraseCursorOn = null;
    if (rect.w < 8 || rect.h < 8) { renderToolbar(); return; }
    // 抑制拖拽结束后浏览器补发的 click，避免误消除
    state.suppressClick = true;
    setTimeout(() => { state.suppressClick = false; }, 0);
    doCapture(rect);
  }

  function updateSelectBoxAt(cx, cy) {
    const { startX, startY } = state.quickSelect;
    const rect = normalizeRect(startX, startY, cx, cy);
    Object.assign(ui.select.style, {
      left: rect.left + 'px', top: rect.top + 'px',
      width: rect.w + 'px', height: rect.h + 'px',
    });
    ui.sizeBadge.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
    let bTop = rect.top + rect.h + 8;
    if (bTop + 26 > window.innerHeight) bTop = rect.top + rect.h - 32;
    Object.assign(ui.sizeBadge.style, {
      left: Math.min(rect.left + rect.w - 100, window.innerWidth - 130) + 'px',
      top: bTop + 'px',
    });
  }
  function attachCaptureListeners() {
    document.addEventListener('mousedown', onCaptureMouseDown, true);
    document.addEventListener('mousemove', onCaptureMouseMove, true);
    document.addEventListener('mouseup', onCaptureMouseUp, true);
  }
  function detachCaptureListeners() {
    document.removeEventListener('mousedown', onCaptureMouseDown, true);
    document.removeEventListener('mousemove', onCaptureMouseMove, true);
    document.removeEventListener('mouseup', onCaptureMouseUp, true);
  }

  function onKeyDown(e) {
    if (!state.active) return;
    // 编辑器打开期间，页面级快捷键一律让位给编辑器
    if (ED.open) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelAll();
      return;
    }
    // 数字键 1/2/3 切换模式
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '1') { e.preventDefault(); e.stopPropagation(); switchMode('erase'); return; }
      if (e.key === '2') { e.preventDefault(); e.stopPropagation(); switchMode('pick'); return; }
      if (e.key === '3') { e.preventDefault(); e.stopPropagation(); switchMode('capture'); return; }
    }
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && state.mode === 'erase') {
      e.preventDefault();
      undoErase();
    } else if (e.key === 'Enter' && state.mode === 'pick') {
      // 选元素模式：回车截取当前选中元素
      e.preventDefault();
      e.stopPropagation();
      captureElement();
    }
  }

  function cancelAll() {
    restoreAll();
    teardown();
  }

  function teardown() {
    state.active = false;
    state.mode = 'erase';
    state.dragging = false;
    state.locked = null;
    detachEraseListeners();
    detachCaptureListeners();
    document.removeEventListener('keydown', onKeyDown, true);
    hideHover();
    // 还原主机光标
    setEraseCursor(false);
    document.documentElement.style.cursor = '';
    if (ui.toolbar) ui.toolbar.style.display = 'none';
    teardownCaptureUI();
    clearTheme();
  }

  function start(settings) {
    Object.assign(state.settings, settings || {});
    ensureUI();
    applyAccent(state.settings.color);
    applyTheme(state.settings.theme);
    if (state.active) {
      // 已在运行：重置到消除模式（必须先摘掉旧监听，否则会重复挂载导致一次点击触发两次截取）
      restoreAll();
      detachEraseListeners();
      detachCaptureListeners();
      document.removeEventListener('keydown', onKeyDown, true);
      teardownCaptureUI();
    }
    state.active = true;
    state.mode = 'erase';
    state.erased = [];
    state.chain = [];
    state.hoverIdx = 0;
    state.pointEl = null;
    state.locked = null;
    _eraseCursorOn = null;

    attachEraseListeners();
    document.addEventListener('keydown', onKeyDown, true);
    renderToolbar();
    if (state.settings.firstRun) {
      showOnboarding();
    } else {
      toast('消除模式已开启 · 点击要去掉的内容');
    }
  }

  // ---------- 首次运行引导 ----------
  function showOnboarding() {
    // 若已存在则移除旧的
    const old = document.getElementById('capx-onboard');
    if (old) old.remove();

    const steps = [
      { n: '1', t: '三种模式，随时切换', d: '顶部切换：① 消除 ② 选元素 ③ 圈选（也可按数字键 1 / 2 / 3）。' },
      { n: '2', t: '先消除不想要的', d: '在「消除」模式下点击内容即可移除，下方自动上移填补；滚轮可调范围。' },
      { n: '3', t: '再截取', d: '「选元素」模式：悬停后点击（或回车）直接截该元素；「圈选」模式：拖框截任意区域。截完页面自动复原。' },
    ];

    const card = h('div', { id: 'capx-onboard' });
    const inner = h('div', { class: 'capx-ob-card' });
    inner.append(
      h('div', { class: 'capx-ob-title' }, '欢迎使用 Capx 👋'),
      h('div', { class: 'capx-ob-sub' }, '先消除不想要的内容，再选元素或圈选截图，截完自动复原')
    );
    const list = h('div', { class: 'capx-ob-steps' });
    steps.forEach((s) => {
      list.append(
        h('div', { class: 'capx-ob-step' },
          h('span', { class: 'capx-ob-n' }, s.n),
          h('div', { class: 'capx-ob-txt' },
            h('div', { class: 'capx-ob-t' }, s.t),
            h('div', { class: 'capx-ob-d' }, s.d)
          )
        )
      );
    });
    inner.append(list);
    inner.append(
      h('button', {
        type: 'button', class: 'capx-ob-btn',
        onClick: () => { card.remove(); toast('开始吧 · 点击你想去掉的内容'); },
      }, '知道了，开始')
    );
    card.append(inner);
    document.documentElement.append(card);
    // 点击遮罩空白处也可关闭
    card.addEventListener('click', (e) => { if (e.target === card) card.remove(); });
  }

  // ---------- 对外接口（由 entrypoint 调用） ----------
  /** 启动 / 重启插件。settings 与默认值合并。 */
  function boot(settings) {
    start(settings || {});
    return { ok: true };
  }

  /** 探活：popup 用它判断是否已注入。 */
  function ping() {
    return { ok: true, active: state.active, mode: state.mode };
  }

  /** 当前是否已有可见 UI（Exit/Esc 之后为 false）。 */
  function isIdle() {
    return !state.active;
  }

  export { boot, ping, isIdle };
