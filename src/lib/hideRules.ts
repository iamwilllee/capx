// 持久化隐藏规则：按站点（hostname）分组，存在扩展本地。
// 与截图功能完全独立；规则只在用户授权的站点上自动应用。

const KEY = 'capxHideRules';

export interface HideRule {
  id: string;
  host: string;
  /** CSS 选择器（light 用 document.querySelectorAll，shadow 在各 shadowRoot 内查询） */
  selector: string;
  scope: 'light' | 'shadow';
  /** 人类可读的简短描述 */
  label: string;
  /** 元素标签名，配合 anchor 做兜底匹配 */
  tag?: string;
  /** 文本锚点：选择器失效（匹配 0 个）时用它找回元素 */
  anchor?: string;
  createdAt: number;
  /** 创建时命中的元素数量 */
  matches: number;
  /** 临时禁用（不删规则，只是不生效） */
  enabled: boolean;
}

export type HideRuleMap = Record<string, HideRule[]>;

async function loadAll(): Promise<HideRuleMap> {
  const res = await browser.storage.local.get({ [KEY]: {} as HideRuleMap });
  return (res[KEY] as HideRuleMap) || {};
}

async function writeAll(all: HideRuleMap): Promise<void> {
  await browser.storage.local.set({ [KEY]: all });
}

export async function getRulesForHost(host: string): Promise<HideRule[]> {
  const all = await loadAll();
  return all[host] || [];
}

export async function getAllRules(): Promise<HideRuleMap> {
  return loadAll();
}

export async function addHideRule(rule: HideRule): Promise<void> {
  const all = await loadAll();
  const list = all[rule.host] || (all[rule.host] = []);
  if (list.some((r) => r.selector === rule.selector && r.scope === rule.scope)) return;
  list.push(rule);
  await writeAll(all);
}

export async function removeHideRule(host: string, id: string): Promise<void> {
  const all = await loadAll();
  const list = all[host];
  if (!list) return;
  all[host] = list.filter((r) => r.id !== id);
  if (!all[host].length) delete all[host];
  await writeAll(all);
}

export async function setRuleEnabled(host: string, id: string, enabled: boolean): Promise<void> {
  const all = await loadAll();
  const rule = (all[host] || []).find((r) => r.id === id);
  if (!rule) return;
  rule.enabled = enabled;
  await writeAll(all);
}

export async function clearHideRules(host?: string): Promise<void> {
  if (!host) {
    await browser.storage.local.remove(KEY);
    return;
  }
  const all = await loadAll();
  delete all[host];
  await writeAll(all);
}

export function newRuleId(): string {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
