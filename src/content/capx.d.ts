export function boot(settings?: Record<string, any>): { ok: boolean };
export function ping(): { ok: boolean; active: boolean; mode: string };
export function isIdle(): boolean;
