import { invoke, isDesktop, onWindowHidden, progressChannel } from './backend';
import type { AppStatus } from './backend';

type TextRect = { x: number; y: number; width: number; height: number };
type TextBlock = TextRect & { text: string; regions: TextRect[] };
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
  let pollDelay = 120;
  let reset = true;
  let translations = new Map<string, string>();
  const comparable = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const updateKey = /Mac/.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter';
  const instruction = (): string => selection ? '「更新」でOSの画面選択を開きます' : auto ? '枠内の文字を自動で翻訳します' : '読み取りたい範囲に枠を合わせて「更新」';
  let generation = 0;
  let showingOriginal = false;
  let cancellation: Promise<void> | null = null;
  const placements = new WeakMap<HTMLElement, { left: number; width: number; top: number; height: number; fontSize: number; vertical: boolean }>();

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
    original.disabled = !(selection ? source.textContent : translation.textContent);
    original.textContent = showingOriginal ? '訳文' : '原文';
    original.setAttribute('aria-pressed', String(showingOriginal));
    source.hidden = !selection || !showingOriginal;
    translation.hidden = selection && showingOriginal;
    result.hidden = (!selection && showingOriginal) || !(selection && showingOriginal ? source.textContent : translation.textContent);
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
        const x = block.x * rect.width, sourceWidth = block.width * rect.width;
        const sourceHeight = block.height * rect.height;
        // Share gutters with neighbouring text instead of stretching to the window edge.
        const neighbours = blocks.filter(other => other !== block && other.y < block.y + block.height && other.y + other.height > block.y);
        const leftEdge = Math.max(0, ...neighbours.filter(other => other.x + other.width <= block.x)
          .map(other => (other.x + other.width + block.x) * rect.width / 2 + 6));
        const rightEdge = Math.min(rect.width, ...neighbours.filter(other => other.x >= block.x + block.width)
          .map(other => (block.x + block.width + other.x) * rect.width / 2 - 6));
        const vertical = block.regions.some(line => line.height * rect.height > line.width * rect.width * 1.8);
        const desiredWidth = vertical ? Math.max(sourceWidth + 10, Math.min(180, Math.sqrt(sourceWidth * sourceHeight))) : sourceWidth + 10;
        const width = Math.max(0, Math.min(desiredWidth, rightEdge - leftEdge));
        const left = Math.max(leftEdge, Math.min(rightEdge - width, vertical ? x + (sourceWidth - width) / 2 : x - 5));
        const top = Math.max(0, block.y * rect.height - 3);
        const bottom = Math.min(rect.height, ...blocks.filter(other => other.y >= block.y + block.height
          && other.x * rect.width < left + width && (other.x + other.width) * rect.width > left)
          .map(other => (block.y + block.height + other.y) * rect.height / 2 - 6));
        const sizes = block.regions.map(line => vertical ? line.width * rect.width : line.height * rect.height).sort((a, b) => a - b);
        placements.set(paragraph, { left, width, top, height: Math.min(sourceHeight + 6, bottom - top), vertical,
          fontSize: Math.max(12, Math.min(16, Math.round(sizes[Math.floor(sizes.length / 2)] * 1.3))) });
        Object.assign(paragraph.style, {
          position: 'absolute', left: `${left}px`, top: `${top}px`,
          width: 'max-content', maxWidth: `${width}px`,
          maxHeight: `${Math.max(0, bottom - top)}px`,
        });
      }
      translation.append(paragraph);
      return paragraph;
    });
  }

  function fitBlock(paragraph: HTMLElement): void {
    if (selection || !paragraph.getClientRects().length) return;
    const placement = placements.get(paragraph);
    if (!placement) return;
    paragraph.style.fontSize = `${placement.fontSize}px`;
    for (let size = placement.fontSize - 1; size >= 12 && paragraph.scrollHeight > Math.min(placement.height, paragraph.clientHeight) + 1; size--) {
      paragraph.style.fontSize = `${size}px`;
    }
    if (placement.vertical) {
      const { width, height } = paragraph.getBoundingClientRect();
      paragraph.style.left = `${placement.left + (placement.width - width) / 2}px`;
      paragraph.style.top = `${placement.top + Math.max(0, (placement.height - height) / 2)}px`;
    }
  }

  function invalidate(text: string): void {
    clearTimeout(timer);
    generation++;
    reset = true;
    pollDelay = 120;
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
      const onEvent = progressChannel(event => {
        if (event.kind === 'reading' && run === generation && busy) message('文字を読み取り中…');
      });
      const capture = await invoke<CaptureResult>('capture_lens', {
        region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          bottomInset: status.parentElement!.getBoundingClientRect().height + 1 },
        automatic: watching, reset, onEvent,
      });
      if (run !== generation) return;
      reset = false;
      // Confirm a changed frame promptly; sample settled screens less often.
      pollDelay = capture.kind === 'changed' ? 120 : 350;
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
        const input = comparable(block.text);
        const cached = nextTranslations.get(block.text) ?? translations.get(block.text);
        if (cached) {
          const same = comparable(cached) === input;
          paragraph.textContent = same ? '' : cached;
          render();
          fitBlock(paragraph);
          nextTranslations.set(block.text, cached);
          continue;
        }
        let output = '';
        const channel = progressChannel(event => {
          if (run !== generation || !busy) return;
          if (event.kind === 'loading') message('モデルを読み込み中…');
          if (event.kind === 'token') {
            output += event.text;
            // A copied prefix is not yet a translation; avoid flashing the OCR text.
            paragraph.textContent = input.startsWith(comparable(output)) ? '' : output;
            message('翻訳中…');
            render();
            fitBlock(paragraph);
          }
        });
        const outcome = await invoke<{ truncated: boolean }>('translate', { text: block.text, target: target.value, onEvent: channel });
        if (run !== generation) return;
        truncated ||= outcome.truncated;
        if (!outcome.truncated) nextTranslations.set(block.text, output);
        const same = comparable(output) === input;
        paragraph.textContent = same ? '' : output;
        render();
        fitBlock(paragraph);
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
  region.addEventListener('click', event => {
    if (event.button === 0 && !window.getSelection()?.toString()) original.click();
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
