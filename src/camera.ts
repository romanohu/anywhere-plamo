import { invoke, progressChannel } from './backend';
import { cameraLayout, type CameraBlock } from './camera-layout';
import { cameraMotion } from './camera-motion';

type Block = CameraBlock;

export function initCamera(onText: (text: string, language: string) => void): { close: () => Promise<void>; suspend: () => void; readonly active: boolean } {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>('camera-dialog');
  const video = element<HTMLVideoElement>('camera-video');
  const preview = element<HTMLCanvasElement>('camera-preview');
  const stage = element('camera-stage');
  const overlay = element('camera-overlay');
  const capture = element<HTMLButtonElement>('camera-capture');
  const retry = element<HTMLButtonElement>('camera-retry');
  const automaticButton = element<HTMLButtonElement>('camera-auto');
  const manualButton = element<HTMLButtonElement>('camera-manual');
  const original = element<HTMLButtonElement>('camera-original');
  const openText = element<HTMLButtonElement>('camera-text');
  const target = element<HTMLSelectElement>('camera-target');
  const message = element('camera-status');
  const transcript = element<HTMLDetailsElement>('camera-transcript');
  const paragraphs = element('camera-paragraphs');
  const rotate = element<HTMLButtonElement>('camera-rotate');
  const sample = document.createElement('canvas');
  sample.width = 64; sample.height = 48;
  let sampling: CanvasRenderingContext2D | null = null;
  let stream: MediaStream | null = null;
  let cameraReady = false;
  let generation = 0;
  let work: Promise<void> | null = null;
  let cancellation: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: Uint8ClampedArray | null = null;
  let recognized: Uint8ClampedArray | null = null;
  let stableSince = 0;
  let waitingSince = 0;
  let changedFrames = 0;
  let rotation = 0;
  let blocks: Block[] = [];
  let outputs: string[] = [];
  let spans: HTMLSpanElement[] = [];
  let frozenBlocks: Block[] | null = null;
  let overlayFrame: number | null = null;
  let paused = false;
  let frozen = false;
  let text = '';
  let automatic = true;
  const translations = new Map<string, string>();
  let translationSize = 0;
  try { automatic = localStorage.getItem('camera-auto') !== 'false'; } catch { /* Optional preference. */ }
  target.replaceChildren(...Array.from(element<HTMLSelectElement>('target').options, option => option.cloneNode(true)));

  function render(): void {
    automaticButton.setAttribute('aria-pressed', String(automatic));
    manualButton.setAttribute('aria-pressed', String(!automatic));
    capture.hidden = automatic || frozen;
    capture.disabled = !stream || !!work || !!cancellation;
    retry.hidden = !paused && !frozen;
    retry.textContent = frozen ? '撮り直す' : '再開';
    openText.hidden = automatic || !text || !!work;
    original.disabled = !overlay.textContent;
    rotate.disabled = !!cancellation || (!stream && !frozen);
    transcript.hidden = !text;
  }

  function clearResults(): void {
    blocks = []; outputs = []; spans = [];
    overlay.replaceChildren(); paragraphs.replaceChildren();
    overlay.style.transform = '';
    transcript.open = false; transcript.hidden = true;
    text = '';
  }

  function layout(): void {
    overlayFrame = null;
    if (!dialog.open) return;
    for (const [index, span] of spans.entries()) {
      if (span.textContent !== outputs[index]) span.textContent = outputs[index];
    }
    const view = stage.parentElement!;
    const viewWidth = view.clientWidth, viewHeight = view.clientHeight;
    let width = stage.clientWidth || 480;
    let height = stage.clientHeight || width / (preview.width / preview.height || 4 / 3);
    if (viewWidth && viewHeight) {
      const aspect = Number(stage.style.getPropertyValue('--camera-aspect')) || 4 / 3;
      width = Math.min(viewWidth, viewHeight * aspect); height = width / aspect;
      stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    }
    const positions = cameraLayout(blocks, outputs, width, height);
    for (const [index, position] of positions.entries()) {
      const button = overlay.children[index] as HTMLButtonElement;
      if (!button) continue;
      button.style.cssText = `left:${position.x / width * 100}%;top:${position.y / height * 100}%;width:${position.width}px;height:${position.height}px;font-size:${position.font}px`;
      button.classList.toggle('is-marker', position.marker);
      button.textContent = outputs[index] ? position.marker ? String(index + 1) : outputs[index] : '';
      button.hidden = !outputs[index] || !!position.hidden;
      button.setAttribute('aria-label', `訳文 ${index + 1}: ${outputs[index] ?? ''}`);
    }
    // Measure all labels after all style writes. Interleaving these reads with
    // writes forces a separate browser layout for every OCR block.
    const overflowing = positions.map((position, index) => {
      const button = overlay.children[index] as HTMLButtonElement | undefined;
      return button && !button.hidden && !position.marker && button.clientHeight > 0 && button.scrollHeight > button.clientHeight;
    });
    for (const [index, position] of positions.entries()) {
      if (overflowing[index]) {
        const button = overlay.children[index] as HTMLButtonElement;
        button.classList.add('is-marker');
        button.style.width = '24px'; button.style.height = '24px';
        button.style.left = `${Math.min(position.x, Math.max(0, width - 24)) / width * 100}%`;
        button.style.top = `${Math.min(position.y, Math.max(0, height - 24)) / height * 100}%`;
        button.textContent = String(index + 1);
      }
    }
    if (stream && !frozen) {
      video.style.width = `${rotation % 180 ? height : width}px`;
      video.style.height = `${rotation % 180 ? width : height}px`;
      video.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }
  }

  function paint(): void {
    if (overlayFrame === null) overlayFrame = requestAnimationFrame(layout);
  }

  function stopCamera(): void {
    clearTimeout(timer);
    cameraReady = false;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  }

  function resize(): void {
    if (!cameraReady || !stream || frozen || !video.videoWidth || !video.videoHeight) return;
    const aspect = rotation % 180 ? video.videoHeight / video.videoWidth : video.videoWidth / video.videoHeight;
    stage.style.aspectRatio = String(aspect);
    stage.style.setProperty('--camera-aspect', String(aspect));
    previous = recognized = null;
    stableSince = waitingSince = performance.now();
    clearResults();
    void cancelWork();
    paint();
  }

  function cancelWork(): Promise<void> {
    generation++;
    if (!work) return cancellation ?? Promise.resolve();
    if (!cancellation) {
      const pending = work;
      cancellation = (async () => {
        await invoke('cancel_operation').catch(() => {});
        await pending;
      })().finally(() => { cancellation = null; render(); });
    }
    return cancellation;
  }

  async function close(): Promise<void> {
    stopCamera();
    if (dialog.open) dialog.close();
    clearResults();
    previous = recognized = null;
    frozenBlocks = null;
    translations.clear();
    translationSize = 0;
    await cancelWork();
    if (!dialog.open) preview.width = preview.height = 0;
  }

  function poll(): void {
    if (!dialog.open || !stream || !automatic || paused || document.hidden) return;
    if (transcript.open) { timer = setTimeout(poll, 150); return; }
    if (video.videoWidth && video.videoHeight && sampling) {
      sampling.drawImage(video, 0, 0, 64, 48);
      const pixels = sampling.getImageData(0, 0, 64, 48).data;
      const now = performance.now();
      const movement = previous && cameraMotion(previous, pixels);
      if (movement?.changed) stableSince = now;
      const difference = recognized && cameraMotion(recognized, pixels);
      changedFrames = difference?.changed ? changedFrames + 1 : 0;
      if (changedFrames >= 2) {
        recognized = null; changedFrames = 0;
        clearResults();
        void cancelWork();
        stableSince = waitingSince = now;
        message.textContent = '新しい範囲を読み取ります';
      } else if (difference && !difference.changed) {
        // Tiny hand motion should move the result, not restart OCR and translation.
        const x = rotation === 90 ? -difference.y : rotation === 270 ? difference.y : difference.x * (rotation === 180 ? -1 : 1);
        const y = rotation === 90 ? difference.x : rotation === 270 ? -difference.x : difference.y * (rotation === 180 ? -1 : 1);
        overlay.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
      }
      if (!recognized && !work && !cancellation && (now - stableSince >= 300 || now - waitingSince >= 1500)) {
        recognized = pixels;
        processFrame(false);
      }
      previous = pixels;
    }
    timer = setTimeout(poll, 150);
  }

  async function start(): Promise<void> {
    stopCamera();
    const pending = cancelWork();
    const opening = generation;
    await pending;
    if (opening !== generation) return;
    const run = ++generation;
    paused = frozen = false;
    frozenBlocks = null;
    previous = recognized = null;
    clearResults();
    overlay.hidden = false;
    original.setAttribute('aria-pressed', 'false');
    video.hidden = false;
    preview.hidden = true;
    message.textContent = 'カメラを準備中…';
    if (!dialog.open) dialog.showModal();
    render();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('この環境ではカメラを利用できません。');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 },
      } });
      if (run !== generation || !dialog.open || document.hidden) {
        acquired.getTracks().forEach(track => track.stop());
        if (run === generation && document.hidden) void close();
        return;
      }
      stream = acquired;
      acquired.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (stream !== acquired) return;
        stopCamera();
        paused = true;
        void cancelWork();
        message.textContent = 'カメラとの接続が切れました。再開してください。';
        render();
      }));
      video.srcObject = stream;
      await video.play();
      if (run !== generation) return;
      cameraReady = true;
      const aspect = rotation % 180 ? (video.videoHeight || 3) / (video.videoWidth || 4) : (video.videoWidth || 4) / (video.videoHeight || 3);
      stage.style.aspectRatio = String(aspect);
      stage.style.setProperty('--camera-aspect', String(aspect));
      sampling = sample.getContext('2d', { willReadFrequently: true });
      if (!sampling) throw new Error('撮影画像を作成できません。');
      message.textContent = automatic ? '文字にカメラを向けてください' : '文字を画面に収めて撮影';
      stableSince = waitingSince = performance.now();
      render();
      paint();
      if (automatic) poll();
    } catch (error) {
      if (run !== generation) return;
      stopCamera();
      paused = true;
      message.textContent = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'カメラを許可してください。端末の設定から変更できます。'
        : error instanceof DOMException && error.name === 'NotFoundError'
          ? 'カメラが見つかりません。' : error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function place(block: Block, index: number): void {
    const button = document.createElement('button');
    button.className = 'camera-block';
    button.type = 'button'; button.hidden = true;
    const paragraph = document.createElement('li');
    const source = document.createElement('small'); source.textContent = block.text;
    const span = document.createElement('span');
    paragraph.append(span, source); paragraphs.append(paragraph);
    button.addEventListener('click', () => {
      transcript.open = true;
      paragraph.scrollIntoView({ block: 'start', behavior: 'smooth' });
      paragraphs.querySelector('.selected')?.classList.remove('selected');
      paragraph.classList.add('selected');
    });
    overlay.append(button);
    outputs[index] = '';
    spans[index] = span;
  }

  function encodeFrame(): Promise<string> {
    return new Promise((resolve, reject) => {
      preview.toBlob(blob => {
        if (!blob) { reject(new Error('撮影画像を作成できません。')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('撮影画像を読み込めません。'));
        reader.readAsDataURL(blob);
      }, 'image/png');
    });
  }

  function processFrame(freeze: boolean): void {
    if ((!stream && !frozen) || work || cancellation) return;
    const run = ++generation;
    const language = target.value;
    work = (async () => {
      // Establish the in-flight promise before any synchronous capture error.
      await Promise.resolve();
      try {
        if (run !== generation || !dialog.open) return;
        if (!frozen) {
          if (!video.videoWidth || !video.videoHeight) throw new Error('映像の準備ができていません。再試行してください。');
          const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
          const width = Math.round(video.videoWidth * scale);
          const height = Math.round(video.videoHeight * scale);
          const rotatedWidth = rotation % 180 ? height : width;
          const rotatedHeight = rotation % 180 ? width : height;
          if (preview.width !== rotatedWidth) preview.width = rotatedWidth;
          if (preview.height !== rotatedHeight) preview.height = rotatedHeight;
          const context = preview.getContext('2d');
          if (!context) throw new Error('撮影画像を作成できません。');
          context.save();
          context.translate(preview.width / 2, preview.height / 2);
          context.rotate(rotation * Math.PI / 180);
          context.drawImage(video, -width / 2, -height / 2, width, height);
          context.restore();
          if (freeze) {
            frozen = true;
            stopCamera();
            video.hidden = true;
            preview.hidden = false;
          }
        }
        clearResults();
        message.textContent = '文字を読み取り中…';
        render();
        let found = frozen ? frozenBlocks : null;
        if (!found) {
          const image = await encodeFrame();
          if (run !== generation || !dialog.open) return;
          found = await invoke<Block[]>('recognize_camera', { image });
        }
        if (run !== generation || !dialog.open) return;
        if (frozen) frozenBlocks = found;
        blocks = found;
        text = blocks.map(block => block.text).join('\n\n');
        if (text.length > 12000 || blocks.length > 128) throw new Error('文字が多すぎます。範囲を狭めてください。');
        if (!text.trim()) { message.textContent = '文字が見つかりません'; return; }
        element('camera-count').textContent = String(blocks.length);
        render();
        for (const [index, block] of blocks.entries()) {
          if (run !== generation) return;
          const key = `${language}\0${block.text}`;
          place(block, index);
          if (translations.has(key)) { outputs[index] = translations.get(key)!; paint(); continue; }
          message.textContent = '翻訳中…';
          let output = '';
          let accepting = true;
          const onEvent = progressChannel(event => {
            if (!accepting || run !== generation || event.kind !== 'token') return;
            output += event.text;
            outputs[index] = output;
            paint();
          });
          let result: { truncated: boolean };
          try { result = await invoke('translate', { text: block.text, target: language, onEvent }); }
          finally { accepting = false; }
          if (run !== generation) return;
          if (result.truncated) throw new Error('訳文が長すぎます。範囲を狭めてください。');
          if (output.trim()) {
            translations.set(key, output);
            translationSize += key.length + output.length;
            while (translations.size > 128 || translationSize > 500000) {
              const key = translations.keys().next().value!;
              translationSize -= key.length + translations.get(key)!.length;
              translations.delete(key);
            }
          }
        }
        if (run === generation) { layout(); message.textContent = automatic ? '自動更新中' : '翻訳完了'; }
      } catch (error) {
        if (run !== generation) return;
        paused = true;
        message.textContent = String(error) === 'CANCELLED' ? '読み取りを中断しました' : error instanceof Error ? error.message : String(error);
      } finally { work = null; render(); }
    })();
    render();
  }

  async function setMode(value: boolean): Promise<void> {
    if (automatic === value) return;
    automatic = value;
    try { localStorage.setItem('camera-auto', String(value)); } catch { /* Optional preference. */ }
    render();
    if (frozen || !stream) { await start(); return; }
    clearTimeout(timer);
    clearResults();
    recognized = previous = null;
    const pending = cancelWork(); const run = generation;
    message.textContent = '切り替え中…';
    await pending;
    if (run !== generation || !dialog.open) return;
    paused = false;
    stableSince = waitingSince = performance.now();
    message.textContent = automatic ? '文字にカメラを向けてください' : '文字を画面に収めて撮影';
    render();
    if (automatic) poll();
  }

  element('camera-button').addEventListener('click', () => {
    target.value = element<HTMLSelectElement>('target').value;
    void start();
  });
  element('camera-close').addEventListener('click', () => { void close(); });
  capture.addEventListener('click', () => processFrame(true));
  retry.addEventListener('click', () => { void start(); });
  automaticButton.addEventListener('click', () => { void setMode(true); });
  manualButton.addEventListener('click', () => { void setMode(false); });
  rotate.addEventListener('click', () => {
    if (cancellation) return;
    void (async () => {
      const pending = cancelWork(); const run = generation;
      render();
      await pending;
      if (run !== generation || !dialog.open) return;
      if (frozen) {
        const copy = document.createElement('canvas'); copy.width = preview.width; copy.height = preview.height;
        copy.getContext('2d')?.drawImage(preview, 0, 0);
        preview.width = copy.height; preview.height = copy.width;
        const context = preview.getContext('2d');
        context?.translate(preview.width, 0); context?.rotate(Math.PI / 2); context?.drawImage(copy, 0, 0);
        context?.resetTransform();
        frozenBlocks = null;
        stage.style.aspectRatio = String(preview.width / preview.height);
        stage.style.setProperty('--camera-aspect', String(preview.width / preview.height));
        clearResults(); paused = false; processFrame(true);
      } else { rotation = (rotation + 90) % 360; resize(); }
    })();
  });
  original.addEventListener('click', () => {
    overlay.hidden = !overlay.hidden;
    original.setAttribute('aria-pressed', String(overlay.hidden));
  });
  openText.addEventListener('click', () => { const source = text; const language = target.value; void close().then(() => onText(source, language)); });
  target.addEventListener('change', () => {
    void (async () => {
      const pending = cancelWork();
      const run = generation;
      await pending;
      if (run !== generation || !dialog.open) return;
      clearResults();
      recognized = null;
      if (frozen) { paused = false; processFrame(true); }
    })();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  dialog.addEventListener('close', () => { stopCamera(); void cancelWork(); });
  video.addEventListener('resize', resize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(paint).observe(stage.parentElement!);
  transcript.addEventListener('toggle', paint);
  window.addEventListener('pagehide', () => { void close(); });
  return {
    close,
    // Android also pauses the activity while the camera permission prompt is open.
    // Keep that request alive; start() releases it if the app remains hidden.
    suspend() { if (stream || work || frozen || paused) void close(); },
    get active() { return dialog.open || work !== null || cancellation !== null; },
  };
}
