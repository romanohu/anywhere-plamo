import { invoke, isDesktop, onWindowHidden, progressChannel } from './backend';
import type { AppStatus } from './backend';

export async function initLens(): Promise<void> {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const refresh = element<HTMLButtonElement>('lens-refresh');
  const original = element<HTMLButtonElement>('lens-original');
  const target = element<HTMLSelectElement>('lens-target');
  const region = element('lens-region');
  const result = element('lens-result');
  const translation = element('lens-translation');
  const status = element('lens-status');
  let ready = false;
  let busy = false;
  let generation = 0;
  let showingOriginal = false;
  let cancellation: Promise<void> | null = null;

  document.body.classList.add('lens-mode');
  document.title = 'Anywhere Plamo — OCRレンズ';
  element('lens').hidden = false;
  target.replaceChildren(...Array.from(element<HTMLSelectElement>('target').options, option => option.cloneNode(true)));
  try {
    const saved = localStorage.getItem('lens-target') ?? localStorage.getItem('target-language');
    if (Array.from(target.options).some(option => option.value === saved)) target.value = saved!;
  } catch { /* Preferences are optional. */ }

  function message(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  function render(): void {
    refresh.textContent = cancellation ? '中断中…' : busy ? '中断' : '更新';
    refresh.disabled = !ready || !!cancellation;
    target.disabled = busy || !!cancellation;
    original.disabled = !translation.textContent;
    original.textContent = showingOriginal ? '訳文' : '原文';
    original.setAttribute('aria-pressed', String(showingOriginal));
    result.hidden = showingOriginal || !translation.textContent;
  }

  function invalidate(text: string): void {
    generation++;
    translation.textContent = '';
    showingOriginal = false;
    message(text);
    if (busy && !cancellation) {
      cancellation = invoke<void>('cancel_operation')
        .catch(error => { message(String(error), true); })
        .finally(() => { cancellation = null; render(); });
    }
    render();
  }

  async function update(): Promise<void> {
    if (!ready || cancellation) return;
    if (busy) { invalidate('中断しました'); return; }
    const run = ++generation;
    busy = true;
    translation.textContent = '';
    showingOriginal = false;
    message('文字を読み取り中…');
    render();
    try {
      const app = await invoke<AppStatus>('get_status');
      if (run !== generation) return;
      if (!app.modelReady || !app.runtimeAvailable) {
        throw new Error('通常の翻訳画面でモデルと翻訳エンジンを準備してください。');
      }
      const rect = region.getBoundingClientRect();
      const text = await invoke<string>('capture_lens', {
        region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      if (run !== generation) return;
      if (!text.trim()) { message('文字が見つかりませんでした。範囲を変えて更新してください。'); return; }
      if (text.length > 12000) { message('文字が多すぎます。読み取る範囲を小さくしてください。', true); return; }
      message('翻訳中…');
      const channel = progressChannel(event => {
        if (run !== generation || !busy) return;
        if (event.kind === 'loading') message('モデルを読み込み中…');
        if (event.kind === 'token') {
          translation.textContent += event.text;
          message('翻訳中…');
          render();
        }
      });
      const outcome = await invoke<{ truncated: boolean }>('translate', { text, target: target.value, onEvent: channel });
      if (run !== generation) return;
      message(outcome.truncated ? '訳文が上限に達しました。範囲を小さくして更新してください。' : '更新しました · ⌘+Enterで再読取');
    } catch (error) {
      if (run === generation) {
        const detail = error instanceof Error ? error.message : String(error);
        message(detail === 'CANCELLED' ? '中断しました' : detail, detail !== 'CANCELLED');
      }
    } finally {
      busy = false;
      render();
    }
  }

  async function close(): Promise<void> {
    invalidate('読み取りたい範囲に枠を合わせて「更新」');
    try { await invoke('hide_window'); } catch (error) { message(String(error), true); }
  }

  refresh.addEventListener('click', () => { void update(); });
  original.addEventListener('click', () => { showingOriginal = !showingOriginal; render(); });
  element('lens-close').addEventListener('click', () => { void close(); });
  target.addEventListener('change', () => {
    invalidate('「更新」で選んだ言語に翻訳');
    try { localStorage.setItem('lens-target', target.value); } catch { /* Optional preference. */ }
  });
  window.addEventListener('resize', () => { invalidate('範囲を変更しました。「更新」で再読取'); });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.repeat) return;
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void update(); }
    // Keep CSS coordinates aligned with native points when capturing the viewport.
    else if ((event.metaKey || event.ctrlKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
  });
  if (!isDesktop) { message('OCRレンズはMacのデスクトップアプリで利用できます。'); return; }
  try {
    await window.__TAURI__!.event.listen('lens-changed', () => { invalidate('範囲を変更しました。「更新」で再読取'); });
    await onWindowHidden(() => { invalidate('読み取りたい範囲に枠を合わせて「更新」'); });
    const app = await invoke<AppStatus>('get_status');
    ready = app.lensSupported;
    if (!ready) message('OCRレンズはMacで利用できます。');
    render();
  } catch (error) { message(String(error), true); }
}
