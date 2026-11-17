import React, { useEffect, useState, useCallback } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import {
  Scan, Camera, X, FolderOpen, Copy, Trash2, EyeOff, Plus,
  ShieldCheck, ShieldOff, MousePointer2, Globe2, Power, PowerOff,
} from 'lucide-react';
import { Row, Toggle, Segmented, Swatches } from './ui';
import {
  COLORS,
  DEFAULTS,
  loadSettings,
  saveSetting,
  sanitizeSaveDir,
  type Settings,
} from '../lib/settings';
import { startCapture } from '../lib/capture';
import {
  type HistoryItem,
  getFullImage,
  clearFullImages,
  copyDataUrlToClipboard,
} from '../lib/history';
import {
  type HideRule,
  type HideRuleMap,
  getRulesForHost,
  getAllRules,
  removeHideRule,
  clearHideRules,
  setRuleEnabled,
} from '../lib/hideRules';
import { ensureHideInjected, startHidePicking, probeRule, type RuleProbe } from '../lib/hideInject';

const iconProps = {
  size: 15,
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

interface Site {
  host: string;
  origin: string;
  url: string;
  tabId: number;
}

export function App() {
  const [view, setView] = useState<'capture' | 'hide'>('capture');
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<{ msg: string; warn?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  const [preview, setPreview] = useState<HistoryItem | null>(null);
  const [dirDraft, setDirDraft] = useState<string | null>(null);

  // 隐藏功能状态
  const [site, setSite] = useState<Site | null>(null);
  const [granted, setGranted] = useState(false);
  const [rules, setRules] = useState<HideRule[]>([]);
  const [allRules, setAllRules] = useState<HideRuleMap>({});
  const [probes, setProbes] = useState<Record<string, RuleProbe | null>>({});
  const [showAll, setShowAll] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = settings.theme === 'auto'
        ? (mq.matches ? 'dark' : 'light')
        : settings.theme;
      document.documentElement.setAttribute('data-capx-theme', resolved);
    };
    apply();
    if (settings.theme === 'auto') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings.theme]);

  const flash = useCallback((msg: string, warn = false) => {
    setToast({ msg, warn });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshHistory = useCallback(async () => {
    const store = (await browser.storage.local.get({ capxHistory: [] })) as {
      capxHistory: HistoryItem[];
    };
    setHistory(store.capxHistory || []);
  }, []);

  const refreshRules = useCallback(async (host: string) => {
    const list = await getRulesForHost(host);
    setRules(list);
    setAllRules(await getAllRules());
    return list;
  }, []);

  /** 实测每条规则在当前页面的命中情况，让「没生效」不再是黑盒 */
  const probeRules = useCallback(async (tabId: number, list: HideRule[]) => {
    const out: Record<string, RuleProbe | null> = {};
    for (const r of list) {
      out[r.id] = await probeRule(tabId, r.selector, r.scope, r.anchor, r.tag);
    }
    setProbes(out);
  }, []);

  // 读取当前标签页与授权状态
  const loadSite = useCallback(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) { setSite(null); return; }
    try {
      const u = new URL(tab.url);
      if (!/^https?:$/.test(u.protocol)) { setSite(null); return; }
      const s: Site = { host: u.hostname, origin: u.origin + '/*', url: tab.url, tabId: tab.id };
      setSite(s);
      let ok = false;
      try { ok = await browser.permissions.contains({ origins: [s.origin] }); } catch { /* ignore */ }
      setGranted(ok);
      const list = await refreshRules(s.host);
      // 打开弹窗时校准一次动态注册（防止 service worker 未启动导致注册缺失）
      if (ok) {
        try { await browser.runtime.sendMessage({ type: 'capx:sync-hide-scripts' }); } catch { /* ignore */ }
        void probeRules(s.tabId, list);
      }
    } catch { setSite(null); }
  }, [refreshRules, probeRules]);

  useEffect(() => {
    loadSettings().then(setSettings);
    refreshHistory();
    setVersion(browser.runtime.getManifest().version);
    void loadSite();

    const onChanged = (changes: any, area: string) => {
      if (area === 'local' && changes.capxHistory) refreshHistory();
      if (area === 'local' && changes.capxHideRules) {
        void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          try {
            const h = tab?.url ? new URL(tab.url).hostname : '';
            if (h) void refreshRules(h);
          } catch { /* ignore */ }
        });
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [refreshHistory, refreshRules, loadSite]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    void saveSetting(key, value);
  };

  // ---------- 截图 ----------
  const onStart = async () => {
    setBusy(true);
    const res = await startCapture();
    setBusy(false);
    if (res.ok) window.close();
    else flash(res.error || '启动失败', true);
  };

  const clearHistory = async () => {
    await browser.storage.local.set({ capxHistory: [] } as any);
    await clearFullImages();
    await refreshHistory();
    flash('历史记录已清空');
  };

  const copyImage = async (item: HistoryItem) => {
    const full = await getFullImage(item.id);
    if (!full) { flash('原图不可用，请重新截图后再复制', true); return; }
    const ok = await copyDataUrlToClipboard(full);
    flash(ok ? '原图已复制到剪贴板' : '复制失败，可点开大图手动复制', !ok);
  };

  const showInFolder = (item: HistoryItem) => {
    if (item.downloadId == null) { flash('这条记录没有关联的下载项', true); return; }
    try { browser.downloads.show(item.downloadId); }
    catch { flash('打开文件夹失败', true); }
  };

  // ---------- 隐藏 ----------
  const onEnableSite = async () => {
    if (!site) return;
    setBusy(true);
    let ok = false;
    try { ok = await browser.permissions.request({ origins: [site.origin] }); } catch { ok = false; }
    if (!ok) {
      setBusy(false);
      flash('未获得授权，无法启用本站自动隐藏', true);
      return;
    }
    const injected = await ensureHideInjected(site.tabId);
    // 关键：注册未来导航自动注入（刷新后靠它生效），并让已打开的当前页立即注入
    try { await browser.runtime.sendMessage({ type: 'capx:sync-hide-scripts' }); } catch { /* ignore */ }
    setBusy(false);
    if (!injected.ok) { flash(injected.error || '注入失败', true); return; }
    setGranted(true);
    flash('已启用 · 刷新本站页面仍会自动隐藏');
  };

  const onDisableSite = async () => {
    if (!site) return;
    let ok = false;
    try { ok = await browser.permissions.remove({ origins: [site.origin] }); } catch { ok = false; }
    setGranted(false);
    flash(ok ? '已停用本站自动隐藏' : '未能撤销授权，请在浏览器扩展设置里手动关闭', !ok);
  };

  const onPick = async () => {
    if (!site) return;
    setPicking(true);
    const res = await startHidePicking(site.tabId);
    setPicking(false);
    if (!res.ok) { flash(res.error || '启动拾取失败', true); return; }
    window.close();
  };

  const deleteRule = async (host: string, id: string) => {
    await removeHideRule(host, id);
    if (site) {
      const list = await refreshRules(site.host);
      void probeRules(site.tabId, list);
    }
    flash('规则已删除，对应元素会恢复显示');
  };

  const toggleRule = async (rule: HideRule) => {
    await setRuleEnabled(rule.host, rule.id, rule.enabled === false);
    if (site) {
      const list = await refreshRules(site.host);
      void probeRules(site.tabId, list);
    }
  };

  const clearRules = async () => {
    if (!site) return;
    await clearHideRules(site.host);
    await refreshRules(site.host);
    setProbes({});
    flash('本站隐藏规则已清空');
  };

  /** 强制让当前页面重新应用规则，并刷新诊断结果 */
  const reapplyRules = async () => {
    if (!site) return;
    try { await browser.tabs.sendMessage(site.tabId, { type: 'capx:hide-apply' }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250));
    void probeRules(site.tabId, rules);
    flash('已重新应用规则');
  };

  const dirValue = dirDraft ?? settings.saveDir;
  const dirCheck = sanitizeSaveDir(dirValue);
  const saveDirHint = settings.saveDir
    ? `截图保存在：下载 / ${settings.saveDir} /`
    : '截图保存在：下载 文件夹（根目录）';
  const onDirChange = (raw: string) => {
    setDirDraft(raw);
    const check = sanitizeSaveDir(raw);
    if (check.ok && check.value !== settings.saveDir) update('saveDir', check.value);
  };

  const allHosts = Object.keys(allRules).filter((h) => allRules[h]?.length);

  return (
    <div className="wrap">
      <header className="hd">
        <div className="logo"><Scan {...iconProps} /></div>
        <div className="hd-text">
          <div className="brand">
            Capx
            <span className="badge-local" title="所有处理都在本地完成">纯本地</span>
          </div>
          <div className="tag">
            {view === 'capture' ? '先消除 · 再选元素或圈选 · 自动恢复' : '按站授权 · 打开网页自动隐藏不想看的内容'}
          </div>
        </div>
      </header>

      <div className="view-switch" role="tablist" aria-label="功能切换">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'capture'}
          className={'view-btn' + (view === 'capture' ? ' active' : '')}
          onClick={() => setView('capture')}
        >
          <Camera size={14} aria-hidden /> 截图
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'hide'}
          className={'view-btn hide' + (view === 'hide' ? ' active' : '')}
          onClick={() => setView('hide')}
        >
          <EyeOff size={14} aria-hidden /> 隐藏元素
        </button>
      </div>

      {view === 'capture' ? (
        <>
          <button className="cta" type="button" onClick={onStart} disabled={busy}>
            <span className="cta-ico"><Camera {...iconProps} /></span>
            <span className="cta-label">{busy ? '启动中…' : '开始截图'}</span>
            <kbd className="kbd">Alt ⇧ X</kbd>
          </button>

          <section className="card">
            <h2 className="card-title">截图设置</h2>
            <Row label="导出后自动恢复页面" hint="截完立刻把页面还原成原样">
              <Toggle checked={settings.autoRestore} onChange={(v) => update('autoRestore', v)} label="导出后自动恢复页面" />
            </Row>
            <Row label="截图后先标注" hint="进入编辑器画框、箭头、文字、马赛克">
              <Toggle checked={settings.editAfterCapture} onChange={(v) => update('editAfterCapture', v)} label="截图后先标注" />
            </Row>
            <Row label="导出格式">
              <Segmented label="导出格式" value={settings.format} onChange={(v) => update('format', v)}
                options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }]} />
            </Row>
            <Row label="截图后">
              <Segmented label="截图后动作" value={settings.after} onChange={(v) => update('after', v)}
                options={[{ value: 'both', label: '保存+复制' }, { value: 'copy', label: '仅复制' }]} />
            </Row>
            <Row label="保存子文件夹" hint={dirCheck.ok ? '相对下载目录，如 Capx；留空=下载根目录' : dirCheck.error}>
              <input
                type="text"
                className={'text-input' + (dirCheck.ok ? '' : ' invalid')}
                value={dirValue}
                placeholder="Capx"
                spellCheck={false}
                aria-label="保存子文件夹"
                onChange={(e) => onDirChange(e.target.value)}
                onBlur={() => setDirDraft(null)}
              />
            </Row>
            <Row label="高亮描边颜色">
              <Swatches value={settings.color} options={COLORS} onChange={(v) => update('color', v)} />
            </Row>
            <Row label="界面主题">
              <Segmented label="界面主题" value={settings.theme} onChange={(v) => update('theme', v)}
                options={[
                  { value: 'auto', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]} />
            </Row>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">最近截图</h2>
              {history.length > 0 && <button className="link" type="button" onClick={clearHistory}>清空</button>}
            </div>
            {history.length > 0 && (
              <div className="save-path">
                <FolderOpen size={12} aria-hidden />
                <span title={saveDirHint}>{saveDirHint}</span>
              </div>
            )}
            {history.length === 0 ? (
              <p className="empty">还没有截图。点上面的按钮截一张试试。</p>
            ) : (
              <div className="thumbs">
                {history.map((item) => (
                  <div key={item.id} className="thumb-wrap">
                    <button type="button" className="thumb" title={`${item.w} × ${item.h}px${item.path ? '\n' + item.path : ''}`} onClick={() => setPreview(item)}>
                      <img src={item.thumb} alt="截图缩略图" />
                      <span className="thumb-dims">{item.w}×{item.h}</span>
                    </button>
                    <button type="button" className="thumb-copy" title="复制原图到剪贴板" aria-label="复制原图到剪贴板" onClick={() => copyImage(item)}>
                      <Copy size={12} aria-hidden />
                    </button>
                    {item.downloadId != null && (
                      <button type="button" className="thumb-open" title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => showInFolder(item)}>
                        <FolderOpen size={12} aria-hidden />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">本站自动隐藏</h2>
              {site && <span className="site-host" title={site.url}>{site.host}</span>}
            </div>
            {!site ? (
              <p className="empty">当前页面不支持（仅 http/https 网页可用）。</p>
            ) : granted ? (
              <>
                <div className="site-on">
                  <ShieldCheck size={16} aria-hidden />
                  <span>已启用 · 打开本站会自动隐藏规则中的元素</span>
                </div>
                <button className="link site-off" type="button" onClick={onDisableSite}>
                  <PowerOff size={12} aria-hidden /> 停用本站
                </button>
              </>
            ) : (
              <>
                <p className="site-desc">授权后，本站每次加载都会自动隐藏你标记过的元素。不授予「所有网站」权限，只授权当前站点。</p>
                <button className="grant-btn" type="button" onClick={onEnableSite} disabled={busy}>
                  <Power size={14} aria-hidden /> {busy ? '启用中…' : '启用本站自动隐藏'}
                </button>
              </>
            )}
          </section>

          <button className="cta cta-hide" type="button" onClick={onPick} disabled={!site || !granted || picking}>
            <span className="cta-ico"><MousePointer2 {...iconProps} /></span>
            <span className="cta-label">{picking ? '准备中…' : '拾取元素隐藏'}</span>
            <Plus size={15} aria-hidden />
          </button>
          {!granted && site && <p className="hint-line">先启用本站自动隐藏，才能拾取元素。</p>}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">本站规则</h2>
              {rules.length > 0 && (
                <span className="head-actions">
                  <button className="link" type="button" onClick={reapplyRules}>重新应用</button>
                  <button className="link" type="button" onClick={clearRules}>清空</button>
                </span>
              )}
            </div>
            {!site ? (
              <p className="empty">当前页面不支持。</p>
            ) : rules.length === 0 ? (
              <p className="empty">还没有规则。点上面的「拾取元素隐藏」，选中页面上不想看的内容。</p>
            ) : (
              <div className="rule-list">
                {rules.map((rule) => {
                  const p = probes[rule.id];
                  // 诊断：匹配 0 = 选择器失效；匹配>0 但仍可见 = 未生效
                  let status: { text: string; kind: 'ok' | 'stale' | 'miss' } | null = null;
                  if (p && p.matches >= 0 && rule.enabled !== false) {
                    if (p.matches === 0) status = { text: '当前页匹配 0 个 · 选择器已失效，建议重新拾取', kind: 'stale' };
                    else if (p.visible > 0) status = { text: `匹配 ${p.matches} 个，仍有 ${p.visible} 个未隐藏`, kind: 'miss' };
                    else status = { text: `匹配 ${p.matches} 个 · 已全部隐藏${p.viaAnchor ? '（靠文本匹配）' : ''}`, kind: 'ok' };
                  }
                  return (
                    <div key={rule.id} className={'rule-item' + (rule.enabled === false ? ' off' : '')}>
                      <button
                        className="rule-power"
                        type="button"
                        title={rule.enabled === false ? '启用规则' : '临时禁用规则'}
                        aria-label={rule.enabled === false ? '启用规则' : '临时禁用规则'}
                        onClick={() => toggleRule(rule)}
                      >
                        {rule.enabled === false ? <ShieldOff size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                      </button>
                      <div className="rule-main">
                        <code className="rule-selector" title={rule.selector}>{rule.selector}</code>
                        <span className="rule-meta">
                          {rule.label}
                          {rule.scope === 'shadow' ? ' · Shadow DOM' : ''}
                          {rule.enabled === false ? ' · 已禁用' : ''}
                        </span>
                        {status && (
                          <span className={'rule-status ' + status.kind}>{status.text}</span>
                        )}
                      </div>
                      <button className="rule-del" type="button" title="删除规则" aria-label="删除规则" onClick={() => deleteRule(rule.host, rule.id)}>
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">所有站点</h2>
              {allHosts.length > 0 && (
                <button className="link" type="button" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? '收起' : `${allHosts.length} 个站点`}
                </button>
              )}
            </div>
            {allHosts.length === 0 ? (
              <p className="empty">还没有任何站点的隐藏规则。</p>
            ) : showAll ? (
              <div className="all-hosts">
                {allHosts.map((h) => (
                  <div key={h} className="host-group">
                    <div className="host-name"><Globe2 size={12} aria-hidden /> {h}</div>
                    {(allRules[h] || []).map((rule) => (
                      <div key={rule.id} className="host-rule">
                        <code title={rule.selector}>{rule.selector}</code>
                        <button className="rule-del" type="button" title="删除规则" aria-label="删除规则" onClick={() => deleteRule(h, rule.id)}>
                          <Trash2 size={12} aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">点右上角展开，查看和管理所有站点的规则。</p>
            )}
          </section>
        </>
      )}

      <footer className="ft">
        <span className="ver">v{version} · {granted ? '按站授权' : '截图无需 host 权限'}</span>
        <a className="link" href="https://github.com" target="_blank" rel="noreferrer noopener">帮助</a>
      </footer>

      <Dialog.Root open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="lb-overlay" />
          <Dialog.Popup className="lb-content">
            <Dialog.Title className="sr-only">截图预览</Dialog.Title>
            {preview && <img src={preview.thumb} alt="截图预览" />}
            <div className="lb-meta">{preview ? `${preview.w} × ${preview.h}px` : ''}</div>
            <Dialog.Close className="lb-close" aria-label="关闭">
              <X size={13} strokeWidth={2.2} aria-hidden />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {toast && <div className={'toast' + (toast.warn ? ' warn' : '')}>{toast.msg}</div>}
    </div>
  );
}
