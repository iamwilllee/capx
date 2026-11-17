// AI 助手配置：用户自带 API Key，只存本机；调用在 background 完成。
import type { Candidate } from './aiLocal';

export type Provider = 'openai' | 'deepseek' | 'anthropic' | 'custom';

export interface AiConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string; // custom 用
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o-mini',
  baseUrl: '',
};

export const PROVIDER_PRESETS: Record<Exclude<Provider, 'custom'>, { name: string; base: string; model: string; origin: string }> = {
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', origin: 'https://api.openai.com/*' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', origin: 'https://api.deepseek.com/*' },
  anthropic: { name: 'Anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', origin: 'https://api.anthropic.com/*' },
};

const KEY = 'capxAiConfig';

export async function loadAiConfig(): Promise<AiConfig> {
  const res = await browser.storage.local.get({ [KEY]: DEFAULT_AI_CONFIG });
  return { ...DEFAULT_AI_CONFIG, ...(res[KEY] as Partial<AiConfig>) };
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  await browser.storage.local.set({ [KEY]: cfg });
}

export function apiOrigin(cfg: AiConfig): string | null {
  if (cfg.provider === 'custom') {
    try { return new URL(cfg.baseUrl).origin + '/*'; } catch { return null; }
  }
  return PROVIDER_PRESETS[cfg.provider].origin;
}

export interface AiDecision { id: number; reason: string }

const SYSTEM_PROMPT = `你在帮用户清理网页上不想看的内容。我会给你一份页面元素清单，每个元素有编号 id、标签、class、可见文本片段、定位方式和位置尺寸。

请挑出属于「广告 / 推广 / 赞助 / 弹窗 / 悬浮条 / 推荐位 / 侧边广告 / Cookie 提示 / 订阅框」这类干扰内容的元素。

严格规则：
- 只返回干扰元素的 id，不要返回正文、文章、评论、帖子、导航菜单、按钮或用户想看的信息。
- 拿不准就不要选，宁可漏掉也不要误伤。
- 只返回 JSON，不要任何解释文字，格式：{"items":[{"id":12,"reason":"顶部广告横幅"},{"id":34,"reason":"右侧推荐"}]}
- 如果没有符合条件的元素，返回 {"items":[]}`;

/** 在 background 里调用（popup 通过消息触发） */
export async function callLlm(cfg: AiConfig, nodes: unknown[]): Promise<AiDecision[]> {
  const isAnthropic = cfg.provider === 'anthropic';
  const base = cfg.provider === 'custom' ? cfg.baseUrl.replace(/\/$/, '') : PROVIDER_PRESETS[cfg.provider].base;
  const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`;

  const userContent = JSON.stringify(nodes);
  let resp: Response;
  if (isAnthropic) {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } else {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${t.slice(0, 160)}`);
  }
  const data = await resp.json() as any;
  let text = '';
  if (isAnthropic) {
    text = (data?.content || []).map((b: any) => b?.text || '').join('');
  } else {
    text = data?.choices?.[0]?.message?.content || '';
  }
  return parseDecisions(text);
}

function parseDecisions(text: string): AiDecision[] {
  try {
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1].trim();
    const obj = JSON.parse(s);
    const items = Array.isArray(obj?.items) ? obj.items : [];
    return items
      .filter((x: any) => Number.isFinite(Number(x?.id)))
      .map((x: any) => ({ id: Number(x.id), reason: String(x.reason || 'AI 判定为干扰内容').slice(0, 40) }));
  } catch {
    return [];
  }
}

export interface AiPreview extends Candidate {
  reason: string;
}
