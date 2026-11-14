import { invoke, progressChannel } from './backend';
import { readingOrder, splitDocumentText, wrapText, type DocumentBlock } from './document-layout';
import type { LocalPdf } from './document-pdf';

export function initDocument(available: () => boolean): { close: () => Promise<void>; readonly active: boolean } {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>('document-dialog');
  const input = element<HTMLInputElement>('document-file');
  const canvas = element<HTMLCanvasElement>('document-canvas');
  const stage = element('document-stage');
  const view = element('document-view');
  const overlay = element('document-overlay');
  const target = element<HTMLSelectElement>('document-target');
  const pageInput = element<HTMLInputElement>('document-page');
  const original = element<HTMLButtonElement>('document-original');
  const translate = element<HTMLButtonElement>('document-translate');
  const message = element('document-status');
  const detail = element('document-detail');
  let pdf: LocalPdf | null = null;
  let file: File | null = null;
  let page = 1, count = 1, rotation = 0, zoom = 1, generation = 0;
  let work: Promise<void> | null = null;
  let cancellation: Promise<void> | null = null;
  let nativePending = false;
  let blocks: DocumentBlock[] = [], outputs: string[] = [];
  let selected = -1;
  let showingOriginal = false;
  let layoutFrame: number | null = null;
  target.replaceChildren(...Array.from(element<HTMLSelectElement>('target').options, option => option.cloneNode(true)));

  function controls(): void {
    const busy = !!work || !!cancellation;
    for (const id of ['document-open', 'document-page', 'document-target', 'document-rotate', 'document-ocr']) {
      element<HTMLButtonElement>(id).disabled = busy || (id !== 'document-open' && !file);
    }
    element<HTMLButtonElement>('document-previous').disabled = busy || page <= 1;
    element<HTMLButtonElement>('document-next').disabled = busy || page >= count;
    translate.disabled = !!cancellation || (!work && !blocks.length);
    translate.textContent = work ? '中止' : '訳し直す';
    original.disabled = !outputs.some(Boolean);
    element<HTMLButtonElement>('document-copy').disabled = !outputs.some(Boolean);
    element('document-ocr').hidden = !pdf;
    pageInput.value = String(page); pageInput.max = String(count);
    element('document-pages').textContent = `/ ${count}`;
  }

  function clear(): void {
    blocks = []; outputs = []; overlay.replaceChildren(); selected = -1;
    detail.hidden = true;
    element('document-source').textContent = ''; element('document-output').textContent = '';
  }

  function showDetail(index: number): void {
    selected = index; detail.hidden = false;
    element('document-source').textContent = blocks[index].text;
    element('document-output').textContent = outputs[index] ?? '';
    element('document-output').focus();
  }

  function background(block: DocumentBlock): string {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return '#fff';
    // Sample just outside the text, rather than painting white over dark pages.
    const colors: number[][] = [];
    for (const region of block.regions) {
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(region.y * canvas.height) - 2));
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(region.x * canvas.width)));
      const pixel = context.getImageData(x, y, 1, 1).data;
      colors.push([pixel[0], pixel[1], pixel[2]]);
    }
    const color = [0, 1, 2].map(i => colors.map(c => c[i]).sort((a, b) => a - b)[Math.floor(colors.length / 2)] ?? 255);
    return `rgb(${color.join(',')})`;
  }

  function layout(): void {
    layoutFrame = null;
    if (!dialog.open || !canvas.width) return;
    const width = Math.max(200, view.clientWidth - 24) * zoom;
    stage.style.width = `${width}px`;
    element('document-zoom').textContent = `${Math.round(zoom * 100)}%`;
    const height = width * canvas.height / canvas.width;
    const context = canvas.getContext('2d');
    if (!context) return;
    const fragment = document.createDocumentFragment();
    for (const [index, block] of blocks.entries()) {
      if (!outputs[index]) continue;
      const regionWidth = Math.max(1, block.width * width), regionHeight = Math.max(1, block.height * height);
      let font = Math.max(8, block.font * height * .92);
      let lines: string[] = [];
      const minimum = Math.max(8, font * .65);
      for (;;) {
        context.font = `${font}px -apple-system, BlinkMacSystemFont, "Noto Sans CJK JP", sans-serif`;
        lines = wrapText(outputs[index], regionWidth, text => context.measureText(text).width);
        if (lines.length * font * 1.2 <= regionHeight || font <= minimum) break;
        font = Math.max(minimum, font - .5);
      }
      const maxLines = Math.max(1, Math.floor(regionHeight / (font * 1.2)));
      const clipped = lines.length > maxLines;
      if (clipped) {
        lines = lines.slice(0, maxLines);
        let last = lines[maxLines - 1];
        while (last && context.measureText(last + '…').width > regionWidth) last = Array.from(last).slice(0, -1).join('');
        lines[maxLines - 1] = last + '…';
      }
      const color = background(block);
      const dark = color.slice(4, -1).split(',').map(Number).reduce((a, b) => a + b, 0) < 384;
      for (const region of block.regions) {
        const mask = document.createElement('span'); mask.className = 'document-mask';
        const bleed = Math.max(1, block.font * height * .25);
        mask.style.cssText = `left:calc(${region.x * 100}% - ${bleed}px);top:calc(${region.y * 100}% - ${bleed}px);width:calc(${region.width * 100}% + ${bleed * 2}px);height:calc(${region.height * 100}% + ${bleed * 2}px);background:${color}`;
        fragment.append(mask);
      }
      const button = document.createElement('button'); button.className = 'document-block';
      button.style.cssText = `left:${block.x * 100}%;top:${block.y * 100}%;width:${regionWidth}px;height:${regionHeight}px;font-size:${font}px;color:${dark ? '#fff' : '#161616'};background:${color}`;
      button.textContent = lines.join('\n'); button.title = clipped ? 'クリックして全文を表示' : 'クリックして原文と訳文を表示';
      button.setAttribute('aria-label', outputs[index]);
      button.addEventListener('click', () => showDetail(index)); fragment.append(button);
    }
    overlay.replaceChildren(fragment); overlay.hidden = showingOriginal;
  }

  function paint(): void { if (layoutFrame === null) layoutFrame = requestAnimationFrame(layout); }

  async function stop(): Promise<void> {
    generation++;
    if (cancellation) return cancellation;
    if (!work) return;
    const pending = work;
    cancellation = (async () => {
      if (nativePending) await invoke('cancel_operation').catch(() => {});
      await pending;
    })().finally(() => { cancellation = null; controls(); });
    controls(); await cancellation;
  }

  async function close(): Promise<void> {
    if (dialog.open) dialog.close();
    const closingPdf = pdf; pdf = null;
    const destroying = closingPdf?.destroy().catch(() => {});
    await stop(); await destroying;
    if (!dialog.open) { clear(); file = null; canvas.width = canvas.height = 0; }
  }

  function run(task: (run: number) => Promise<void>): void {
    if (work || cancellation) return;
    const run = ++generation;
    work = Promise.resolve().then(() => task(run)).catch(error => {
      if (run !== generation || !dialog.open) return;
      message.textContent = String(error).includes('PasswordException') ? 'パスワード保護されたPDFです。解除したファイルを開いてください。'
        : String(error) === 'CANCELLED' ? '中止しました' : String(error).replace(/^Error: /, '');
    }).finally(() => { work = null; controls(); });
    controls();
  }

  function current(run: number): boolean { return run === generation && dialog.open; }

  async function recognize(run: number): Promise<DocumentBlock[]> {
    message.textContent = '文字を読み取り中…';
    const data = await new Promise<string>((resolve, reject) => canvas.toBlob(blob => {
      if (!blob) { reject(new Error('画像を読み込めません。')); return; }
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    }, 'image/png'));
    if (!current(run)) return [];
    nativePending = true;
    try {
      const result = await invoke<(Omit<DocumentBlock, 'font'>)[]>('recognize_camera', { image: data });
      return readingOrder(result.map(block => ({ ...block, font: Math.min(...block.regions.map(r => r.height)) * .9 })));
    } finally { nativePending = false; }
  }

  async function translateBlocks(run: number): Promise<void> {
    for (const [index, block] of blocks.entries()) {
      if (!current(run)) return;
      if (outputs[index]) continue;
      message.textContent = `翻訳中… ${index + 1} / ${blocks.length}`;
      const parts: string[] = [];
      for (const chunk of splitDocumentText(block.text)) {
        if (!current(run)) return;
        let text = '';
        const channel = progressChannel(event => { if (current(run) && event.kind === 'token') text += event.text; });
        nativePending = true;
        try {
          const response = await invoke<{ truncated: boolean }>('translate', { text: chunk, target: target.value, onEvent: channel });
          if (!current(run)) return;
          if (response.truncated) throw new Error('訳文が途中で止まりました。別のモデルで訳し直してください。');
          if (!text.trim()) throw new Error('訳文を取得できませんでした。訳し直してください。');
          parts.push(text.trim());
        } finally { nativePending = false; }
      }
      if (!current(run)) return;
      outputs[index] = parts.join('\n');
      if (selected === index) element('document-output').textContent = outputs[index];
      paint(); controls();
    }
    if (current(run)) message.textContent = blocks.length ? '翻訳完了' : '文字が見つかりませんでした';
  }

  async function readPage(run: number, forceOcr = false): Promise<void> {
    clear(); message.textContent = 'ページを読み込み中…';
    if (pdf) blocks = await pdf.page(page, canvas, rotation);
    else if (file) {
      const image = new Image(); const url = URL.createObjectURL(file);
      try {
        image.src = url; await image.decode();
        if (!current(run)) return;
        if (image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) throw new Error('画像が大きすぎます。32メガピクセル以下にしてください。');
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale);
        canvas.width = rotation % 180 ? h : w; canvas.height = rotation % 180 ? w : h;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.save(); context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 180);
        context.drawImage(image, -w / 2, -h / 2, w, h); context.restore();
      } finally { URL.revokeObjectURL(url); }
    }
    if (!current(run)) return;
    paint();
    if (!blocks.length || forceOcr) blocks = await recognize(run);
    if (!current(run)) return;
    if (blocks.reduce((total, block) => total + block.text.length, 0) > 100_000) throw new Error('このページは文字が多すぎます。');
    await translateBlocks(run);
  }

  function openFile(chosen: File): void {
    if (!available() || work || cancellation) return;
    if (!dialog.open) { target.value = element<HTMLSelectElement>('target').value; dialog.showModal(); }
    run(async run => {
      await pdf?.destroy(); pdf = null; file = null; clear(); canvas.width = canvas.height = 0;
      if (!current(run)) return;
      if (!/\.(pdf|png|jpe?g|webp)$/i.test(chosen.name)) throw new Error('PDF・PNG・JPEG・WebPを開けます。');
      if (chosen.size > 64 * 1024 * 1024) throw new Error('ファイルは64 MB以下にしてください。');
      file = chosen; page = count = 1; rotation = 0; zoom = 1;
      showingOriginal = false; original.setAttribute('aria-pressed', 'false');
      element('document-title').textContent = chosen.name;
      message.textContent = 'ファイルを開いています…';
      if (/\.pdf$/i.test(chosen.name)) {
        const { LocalPdf } = await import('./document-pdf');
        if (!current(run)) return;
        const data = await chosen.arrayBuffer();
        if (!current(run)) return;
        pdf = new LocalPdf(data); count = await pdf.count();
      }
      if (current(run)) { controls(); await readPage(run); }
    });
  }

  function changePage(next: number): void {
    if (work || cancellation) return;
    if (!Number.isInteger(next) || next < 1 || next > count || next === page) { controls(); return; }
    page = next; view.scrollTop = 0; run(run => readPage(run));
  }

  element('document-button').addEventListener('click', () => { if (available()) input.click(); });
  element('document-open').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const chosen = input.files?.[0]; input.value = ''; if (chosen) openFile(chosen); });
  for (const name of ['dragover', 'drop']) document.addEventListener(name, event => {
    const drag = event as DragEvent;
    if (!drag.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (!available() || work || cancellation) { drag.dataTransfer.dropEffect = 'none'; return; }
    drag.dataTransfer.dropEffect = 'copy';
    if (name === 'drop') {
      if (drag.dataTransfer.files.length !== 1) { if (dialog.open) message.textContent = 'ファイルを1つずつ開いてください。'; return; }
      openFile(drag.dataTransfer.files[0]);
    }
  });
  element('document-close').addEventListener('click', () => { void close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  element('document-previous').addEventListener('click', () => changePage(page - 1));
  element('document-next').addEventListener('click', () => changePage(page + 1));
  pageInput.addEventListener('change', () => changePage(Number(pageInput.value)));
  target.addEventListener('change', () => { outputs = []; paint(); run(translateBlocks); });
  element('document-rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; run(run => readPage(run)); });
  element('document-ocr').addEventListener('click', () => run(run => readPage(run, true)));
  original.addEventListener('click', () => { showingOriginal = !showingOriginal; original.setAttribute('aria-pressed', String(showingOriginal)); overlay.hidden = showingOriginal; });
  translate.addEventListener('click', () => {
    if (work) { void stop().then(() => { message.textContent = '中止しました'; }); return; }
    outputs = []; paint(); run(translateBlocks);
  });
  for (const [id, amount] of [['document-zoom-out', -.25], ['document-zoom-in', .25]] as const) element(id).addEventListener('click', () => { zoom = Math.max(.5, Math.min(3, zoom + amount)); paint(); });
  element('document-zoom').addEventListener('click', () => { zoom = 1; paint(); });
  element('document-detail-close').addEventListener('click', () => { detail.hidden = true; selected = -1; });
  element('document-copy').addEventListener('click', async () => {
    try { await invoke('write_clipboard', { text: outputs.filter(Boolean).join('\n\n') }); message.textContent = 'このページの訳文をコピーしました'; }
    catch (error) { message.textContent = String(error); }
  });
  window.addEventListener('resize', paint);
  return { close, get active() { return dialog.open || !!work || !!cancellation; } };
}
