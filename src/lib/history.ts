// 历史项：缩略图存 chrome.storage.local（小），原图存扩展 IndexedDB（经 background 中转，剪贴板复制用）
export interface HistoryItem {
  id: string;
  thumb: string;
  w: number;
  h: number;
  name: string;
  at: number;
  downloadId?: number | null;
  path?: string;
}

/** 从 background 读取原图 dataUrl（用于复制到剪贴板） */
export async function getFullImage(id: string): Promise<string | null> {
  try {
    const res: any = await browser.runtime.sendMessage({ type: 'capx:get-image', id });
    return res?.ok ? (res.dataUrl || null) : null;
  } catch {
    return null;
  }
}

/** 清空所有原图（配合「清空历史」） */
export async function clearFullImages(): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'capx:clear-images' });
  } catch {
    /* 忽略 */
  }
}

/** 把 dataUrl 写入剪贴板（需在用户手势回调中调用） */
export async function copyDataUrlToClipboard(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const mime = blob.type || 'image/png';
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
    return true;
  } catch {
    return false;
  }
}
