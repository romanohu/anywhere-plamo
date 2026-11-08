import { invoke, isDesktop, onWindowHidden, progressChannel } from './backend';
import type { AppStatus } from './backend';

type CaptureResult = { kind: 'changed' } | { kind: 'unchanged' } | { kind: 'text'; text: string };

export async function initLens(): Promise<void> {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const refresh = element<HTMLButtonElement>('lens-refresh');
  const automatic = element<HTMLButtonElement>('lens-auto');
  const original = element<HTMLButtonElement>('lens-original');
  const target = element<HTMLSelectElement>('lens-target');
  const region = element('lens-region');
  const result = element('lens-result');
  const translation = element('lens-translation');
  const source = element('lens-source');
  const status = element('lens-status');
  let ready = false;
  let busy = false;
  let translating = false;
  let selection = false;
  let auto = true;
  let visible = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollDelay = 200;
  let reset = true;
  let lastText = '';
  let lastTranslation = '';
  const updateKey = /Mac/.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter';
  const instruction = (): string => selection ? '「更新」でOSの画面選択を開きます' : auto ? '枠内の文字を自動で翻訳します' : '読み取りたい範囲に枠を合わせて「更新」';
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
    auto = localStorage.getItem('lens-auto') !== 'false';
  } catch { /* Preferences are optional. */ }

  function message(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  function render(): void {
    refresh.textContent = cancellation ? '中断中…' : busy && (!auto || translating) ? '中断' : '更新';
    refresh.disabled = !ready || !!cancellation;
    target.disabled = busy && !auto || !!cancellation;
    automatic.disabled = !ready || selection;
    automatic.setAttribute('aria-pressed', String(auto));
    automatic.title = selection ? 'Waylandでは手動更新を使ってください' : '画面が変わると自動で翻訳';
    original.disabled = !translation.textContent;
    original.textContent = showingOriginal ? '訳文' : '原文';
    original.setAttribute('aria-pressed', String(showingOriginal));
    source.hidden = !selection || !showingOriginal;
    translation.hidden = selection && showingOriginal;
    result.hidden = (!selection && showingOriginal) || !translation.textContent;
  }

  function schedule(): void {
    clearTimeout(timer);
    if (ready && auto && visible && !busy && !cancellation) timer = setTimeout(() => { void update(true); }, pollDelay);
  }

  function saveAuto(): void {
    try { localStorage.setItem('lens-auto', String(auto)); } catch { /* Optional preference. */ }
  }

  function invalidate(text: string): void {
    clearTimeout(timer);
    generation++;
    reset = true;
    pollDelay = 200;
    lastText = '';
    lastTranslation = '';
    translation.textContent = '';
    source.textContent = '';
    showingOriginal = false;
    message(text);
    if (busy && !cancellation) {
      cancellation = invoke<void>('cancel_operation')
        .catch(error => { auto = false; message(String(error), true); })
        .finally(() => { cancellation = null; render(); schedule(); });
    }
    render();
    schedule();
  }

  async function update(background = false): Promise<void> {
    if (!ready || cancellation || !visible) return;
    if (busy) {
      if (!background) { auto = false; saveAuto(); invalidate('中断しました'); }
      return;
    }
    clearTimeout(timer);
    const run = ++generation;
    const watching = auto;
    busy = true;
    translating = false;
    if (!background) {
      reset = true;
      lastText = '';
      translation.textContent = '';
      source.textContent = '';
      showingOriginal = false;
      message(selection ? 'OSの画面選択で読み取る範囲を選んでください' : '文字を読み取り中…');
      render();
    }
    try {
      const app = await invoke<AppStatus>('get_status');
      if (run !== generation) return;
      if (!app.modelReady || !app.runtimeAvailable) {
        throw new Error('通常の翻訳画面でモデルと翻訳エンジンを準備してください。');
      }
      if (!app.ocrAvailable) {
        throw new Error('文字認識エンジンが見つかりません。アプリを再インストールしてください。ソース版では npm run ocr:build を実行してください。');
      }
      const rect = region.getBoundingClientRect();
      const capture = await invoke<CaptureResult>('capture_lens', {
        region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        automatic: watching, reset,
      });
      if (run !== generation) return;
      reset = false;
      // Confirm a changed frame promptly; sample settled screens less often.
      pollDelay = capture.kind === 'changed' ? 200 : 350;
      if (capture.kind === 'unchanged') return;
      if (capture.kind === 'changed') {
        translation.textContent = '';
        source.textContent = '';
        message('画面が止まるのを待っています…');
        return;
      }
      const text = capture.text;
      if (!text.trim()) {
        translation.textContent = '';
        source.textContent = '';
        message(watching ? '文字が見つかりません。画面の変化を待っています' : '文字が見つかりませんでした。範囲を変えて更新してください。');
        return;
      }
      if (text.length > 12000) throw new Error('文字が多すぎます。読み取る範囲を小さくしてください。');
      source.textContent = text;
      if (watching && text === lastText && lastTranslation) {
        translation.textContent = lastTranslation;
        message('自動更新中');
        return;
      }
      translating = true;
      translation.textContent = '';
      message('翻訳中…');
      render();
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
      lastText = outcome.truncated ? '' : text;
      lastTranslation = translation.textContent ?? '';
      message(outcome.truncated ? '訳文が上限に達しました。範囲を小さくして更新してください。' : watching ? '自動更新中' : `更新しました · ${updateKey}で再読取`);
    } catch (error) {
      if (run === generation) {
        const detail = error instanceof Error ? error.message : String(error);
        auto = false;
        // A failed capture pauses polling instead of repeating permission dialogs/errors.
        message(detail === 'CANCELLED' ? '中断しました' : detail, detail !== 'CANCELLED');
      }
    } finally {
      busy = false;
      translating = false;
      render();
      schedule();
    }
  }

  async function close(): Promise<void> {
    visible = false;
    invalidate(instruction());
    try { await invoke('hide_window'); } catch (error) { message(String(error), true); }
  }

  refresh.addEventListener('click', () => { void update(); });
  automatic.addEventListener('click', () => {
    auto = !auto;
    saveAuto();
    if (auto || busy) invalidate(instruction());
    else { clearTimeout(timer); message('自動更新を停止しました'); render(); }
  });
  original.addEventListener('click', () => { showingOriginal = !showingOriginal; render(); });
  element('lens-close').addEventListener('click', () => { void close(); });
  target.addEventListener('change', () => {
    invalidate(auto ? instruction() : '「更新」で選んだ言語に翻訳');
    try { localStorage.setItem('lens-target', target.value); } catch { /* Optional preference. */ }
  });
  const moved = (): void => { if (!selection) invalidate(auto ? '範囲が決まると自動で翻訳します' : '範囲を変更しました。「更新」で再読取'); };
  window.addEventListener('resize', moved);
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.repeat) return;
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void update(); }
    // Keep CSS coordinates aligned with native points when capturing the viewport.
    else if ((event.metaKey || event.ctrlKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
  });
  document.addEventListener('visibilitychange', () => {
    if (!auto) return;
    visible = !document.hidden;
    invalidate(instruction());
  });
  if (!isDesktop) { message('OCRレンズはMac・Linuxのデスクトップアプリで利用できます。'); return; }
  try {
    await window.__TAURI__!.event.listen('lens-changed', moved);
    await onWindowHidden(() => { visible = false; invalidate(instruction()); });
    await window.__TAURI__!.event.listen('window-shown', () => { visible = true; invalidate(instruction()); });
    const app = await invoke<AppStatus>('get_status');
    ready = app.lensSupported;
    selection = app.lensUsesSelection;
    if (selection) auto = false;
    message(instruction());
    if (!ready) message('OCRレンズはMac・Linuxで利用できます。');
    render();
    schedule();
  } catch (error) { message(String(error), true); }
}
