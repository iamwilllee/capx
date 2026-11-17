export type Format = 'png' | 'jpg';
export type After = 'both' | 'copy';
export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  autoRestore: boolean;
  format: Format;
  after: After;
  color: string;
  editAfterCapture: boolean;
  /** 下载目录内的子文件夹（相对路径），空串 = 下载根目录 */
  saveDir: string;
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: Theme;
}

export const DEFAULTS: Settings = {
  autoRestore: true,
  format: 'png',
  after: 'both',
  color: '#22d3ee',
  editAfterCapture: false,
  saveDir: 'Capx',
  theme: 'auto',
};

export const COLORS = [
  { value: '#22d3ee', label: '青色' },
  { value: '#a78bfa', label: '紫色' },
  { value: '#4ade80', label: '绿色' },
  { value: '#f0976b', label: '橙色' },
];

/** 清洗/校验「保存子文件夹」输入：返回 ok=false 时 error 给出原因 */
export function sanitizeSaveDir(raw: string): { ok: boolean; value: string; error?: string } {
  let v = (raw || '').trim().replace(/\\/g, '/');
  v = v.replace(/[<>:"|?*\u0000-\u001f]/g, '');
  const parts = v.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) {
    return { ok: false, value: raw, error: '路径不能包含 . 或 ..' };
  }
  if (parts.some((p) => /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(p))) {
    return { ok: false, value: raw, error: '包含 Windows 保留名' };
  }
  v = parts.join('/');
  if (v.length > 120) {
    return { ok: false, value: raw, error: '路径过长（上限 120 字符）' };
  }
  return { ok: true, value: v };
}

/** 内容脚本启动时需要附带的快照（settings + firstRun） */
export interface StartPayload extends Settings {
  firstRun: boolean;
}

export async function loadSettings(): Promise<Settings> {
  const res = await browser.storage.sync.get(DEFAULTS as any);
  return { ...DEFAULTS, ...(res as Partial<Settings>) };
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  return browser.storage.sync.set({ [key]: value } as any);
}

export async function buildStartPayload(): Promise<StartPayload> {
  const settings = await loadSettings();
  const { capxOnboarded } = (await browser.storage.local.get({
    capxOnboarded: false,
  })) as { capxOnboarded: boolean };
  return { ...settings, firstRun: !capxOnboarded };
}

export function markOnboarded() {
  return browser.storage.local.set({ capxOnboarded: true } as any);
}
