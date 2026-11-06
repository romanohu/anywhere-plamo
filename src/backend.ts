export interface AppStatus {
  modelReady: boolean;
  runtimeAvailable: boolean;
  shortcutAvailable: boolean;
  wayland: boolean;
  resident: boolean;
}

export type ProgressEvent =
  | { kind: 'download'; received: number; total: number }
  | { kind: 'verifying' }
  | { kind: 'loading' }
  | { kind: 'token'; text: string };

interface NativeChannel<T> { onmessage: (message: T) => void }
interface TauriBridge {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    Channel: new <T>() => NativeChannel<T>;
  };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

declare global { interface Window { __TAURI__?: TauriBridge } }

export const isDesktop = !!window.__TAURI__;

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI__) return Promise.reject(new Error('翻訳はデスクトップアプリで利用できます。この画面はブラウザプレビューです。'));
  return window.__TAURI__.core.invoke<T>(command, args);
}

export function progressChannel(onmessage: (event: ProgressEvent) => void): NativeChannel<ProgressEvent> {
  if (!window.__TAURI__) throw new Error('デスクトップアプリから実行してください。');
  const channel = new window.__TAURI__.core.Channel<ProgressEvent>();
  channel.onmessage = onmessage;
  return channel;
}

export async function onClipboardRequest(handler: () => void): Promise<void> {
  await window.__TAURI__?.event.listen('clipboard-request', handler);
}
