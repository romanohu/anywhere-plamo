import { invoke, isDesktop, onWindowHidden, progressChannel } from './backend';
import type { AppStatus } from './backend';

type TextBlock = { text: string; x: number; y: number; width: number; height: number };
type CaptureResult = { kind: 'changed' } | { kind: 'unchanged' } | { kind: 'text'; text: string; blocks: TextBlock[] };

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
  let translations = new Map<string, string>();
  const updateKey = /Mac/.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter';
  const instruction = (): string => selection ? '「更新」でOSの画面選択を開きます' : auto ? '枠内の文字を自動で翻訳します' : '読み取りたい範囲に枠を合わせて「更新」';
  let generation = 0;
  let showingOriginal = false;
  let cancellation: Promise<void> | null = null;
  const backdrops = new WeakMap<HTMLElement, { element: HTMLElement; width: number; height: number }>();

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
    status.title = text;
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

  function placeBlocks(blocks: TextBlock[]): HTMLElement[] {
    translation.replaceChildren();
    const rect = region.getBoundingClientRect();
    return blocks.map(block => {
      const paragraph = document.createElement('p');
      paragraph.className = 'lens-block';
      paragraph.dir = 'auto';
      if (!selection) {
        // Expand into free space, but leave neighbouring columns/paragraphs clear.
        const right = Math.min(1, ...blocks.filter(other => other.x >= block.x + block.width
          && other.y < block.y + block.height && other.y + other.height > block.y).map(other => other.x));
        const bottom = Math.min(1, ...blocks.filter(other => other.y >= block.y + block.height
          && other.x < right && other.x + other.width > block.x).map(other => other.y));
        const left = Math.max(0, block.x * rect.width - 5);
        const top = Math.max(0, block.y * rect.height - 3);
        const height = Math.max(0, bottom * rect.height - top - 3);
        const backdrop = document.createElement('div');
        backdrop.className = 'lens-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');
        Object.assign(backdrop.style, { left: `${left}px`, top: `${top}px` });
        translation.append(backdrop);
        backdrops.set(paragraph, { element: backdrop, width: Math.min(right * rect.width - left - 3, block.width * rect.width + 10), height: Math.min(height, block.height * rect.height + 6) });
        Object.assign(paragraph.style, {
          position: 'absolute', left: `${left}px`, top: `${top}px`,
          width: 'max-content', maxWidth: `${Math.max(0, right * rect.width - left - 3)}px`,
          maxHeight: `${height}px`,
        });
      }
      translation.append(paragraph);
      return paragraph;
    });
  }

  function fitBlock(paragraph: HTMLElement): void {
    if (selection || !paragraph.getClientRects().length) return;
    paragraph.style.fontSize = '16px';
    for (let size = 15; size >= 12 && paragraph.scrollHeight > paragraph.clientHeight + 1; size--) {
      paragraph.style.fontSize = `${size}px`;
    }
    const backdrop = backdrops.get(paragraph);
    if (backdrop) {
      const { width, height } = paragraph.getBoundingClientRect();
      const maxWidth = Math.max(width, backdrop.width), maxHeight = Math.max(height, backdrop.height);
      const minWidth = Math.min(width, backdrop.width), minHeight = Math.min(height, backdrop.height);
      // Union of the source and translation rectangles, without painting the empty
      // corner of an L-shaped union (e.g. vertical source / horizontal translation).
      const corner = width >= backdrop.width && height >= backdrop.height || width <= backdrop.width && height <= backdrop.height;
      const points = corner ? `0 0, 100% 0, 100% 100%, 0 100%`
        : `0 0, ${maxWidth}px 0, ${maxWidth}px ${minHeight}px, ${minWidth}px ${minHeight}px, ${minWidth}px ${maxHeight}px, 0 ${maxHeight}px`;
      Object.assign(backdrop.element.style, { width: `${maxWidth}px`, height: `${maxHeight}px`, clipPath: `polygon(${points})` });
    }
  }

  function invalidate(text: string): void {
    clearTimeout(timer);
    generation++;
    reset = true;
    pollDelay = 200;
    translations.clear();
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
      translations.clear();
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
      translating = true;
      const paragraphs = placeBlocks(capture.blocks);
      const nextTranslations = new Map<string, string>();
      let truncated = false;
      message('翻訳中…');
      render();
      for (const [index, block] of capture.blocks.entries()) {
        const paragraph = paragraphs[index];
        const cached = nextTranslations.get(block.text) ?? translations.get(block.text);
        if (cached) {
          paragraph.textContent = cached;
          render();
          fitBlock(paragraph);
          nextTranslations.set(block.text, cached);
          continue;
        }
        const channel = progressChannel(event => {
          if (run !== generation || !busy) return;
          if (event.kind === 'loading') message('モデルを読み込み中…');
          if (event.kind === 'token') {
            paragraph.textContent += event.text;
            message('翻訳中…');
            render();
            fitBlock(paragraph);
          }
        });
        const outcome = await invoke<{ truncated: boolean }>('translate', { text: block.text, target: target.value, onEvent: channel });
        if (run !== generation) return;
        truncated ||= outcome.truncated;
        if (!outcome.truncated) nextTranslations.set(block.text, paragraph.textContent ?? '');
      }
      translations = nextTranslations;
      message(truncated ? '訳文が上限に達しました。範囲を小さくして更新してください。' : watching ? '自動更新中' : `更新しました · ${updateKey}で再読取`);
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
  original.addEventListener('click', () => {
    showingOriginal = !showingOriginal;
    render();
    if (!showingOriginal) translation.querySelectorAll<HTMLElement>('.lens-block').forEach(fitBlock);
  });
  element('lens-close').addEventListener('click', () => { void close(); });
  target.addEventListener('change', () => {
    invalidate(auto ? instruction() : '「更新」で選んだ言語に翻訳');
    try { localStorage.setItem('lens-target', target.value); } catch { /* Optional preference. */ }
  });
  const moved = (): void => { if (!selection) invalidate(auto ? '範囲が決まると自動で翻訳します' : '範囲を変更しました。「更新」で再読取'); };
  let viewport = [window.innerWidth, window.innerHeight];
  window.addEventListener('resize', () => {
    const current = [window.innerWidth, window.innerHeight];
    if (current[0] === viewport[0] && current[1] === viewport[1]) return;
    viewport = current;
    moved();
  });
  // Stop trackpad gestures at a text box's edges instead of rubber-banding the
  // entire webview and shifting the screen coordinates of the capture region.
  document.addEventListener('wheel', event => {
    let box = event.target instanceof Element ? event.target.closest<HTMLElement>('.lens-block, #lens-source, .lens-selection #lens-translation') : null;
    if (selection && box?.classList.contains('lens-block')) box = translation;
    const canScroll = box && ((event.deltaY < 0 && box.scrollTop > 0)
      || (event.deltaY > 0 && box.scrollTop + box.clientHeight < box.scrollHeight - 1));
    if (event.ctrlKey || event.deltaX || !canScroll) event.preventDefault();
  }, { passive: false });
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
    result.classList.toggle('lens-selection', selection);
    if (selection) auto = false;
    message(instruction());
    if (!ready) message('OCRレンズはMac・Linuxで利用できます。');
    render();
    schedule();
  } catch (error) { message(String(error), true); }
}
