import { invoke, progressChannel } from './backend';

type Block = { text: string; x: number; y: number; width: number; height: number };

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
  let paused = false;
  let frozen = false;
  let text = '';
  let automatic = true;
  const translations = new Map<string, string>();
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
    stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    stage.style.setProperty('--camera-aspect', String(video.videoWidth / video.videoHeight));
    previous = recognized = null;
    stableSince = performance.now();
    overlay.replaceChildren();
    text = '';
    void cancelWork();
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
    overlay.replaceChildren();
    text = '';
    previous = recognized = null;
    await cancelWork();
    preview.width = preview.height = 0;
  }

  function moved(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
    let total = 0; let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      const difference = Math.abs(a[i] - b[i]) * .299 + Math.abs(a[i + 1] - b[i + 1]) * .587 + Math.abs(a[i + 2] - b[i + 2]) * .114;
      total += difference;
      if (difference > 24) changed++;
    }
    const pixels = a.length / 4;
    return total / pixels > 5 || changed / pixels > .045;
  }

  function poll(): void {
    if (!dialog.open || !stream || !automatic || paused || document.hidden) return;
    if (video.videoWidth && video.videoHeight && sampling) {
      sampling.drawImage(video, 0, 0, 64, 48);
      const pixels = sampling.getImageData(0, 0, 64, 48).data;
      const now = performance.now();
      if (previous && moved(previous, pixels) || recognized && moved(recognized, pixels)) {
        stableSince = now;
        recognized = null;
        overlay.replaceChildren();
        text = '';
        void cancelWork();
        message.textContent = 'カメラを静止すると翻訳します';
      } else if (now - stableSince >= 300 && !work && !cancellation && (!recognized || moved(recognized, pixels))) {
        recognized = pixels.slice();
        processFrame(false);
      }
      previous = pixels.slice();
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
    previous = recognized = null;
    text = '';
    overlay.replaceChildren();
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
      video.srcObject = stream;
      await video.play();
      if (run !== generation) return;
      cameraReady = true;
      stage.style.aspectRatio = `${video.videoWidth || 4} / ${video.videoHeight || 3}`;
      stage.style.setProperty('--camera-aspect', String((video.videoWidth || 4) / (video.videoHeight || 3)));
      sampling = sample.getContext('2d', { willReadFrequently: true });
      if (!sampling) throw new Error('撮影画像を作成できません。');
      message.textContent = automatic ? 'カメラを静止すると翻訳します' : '文字を画面に収めて撮影';
      stableSince = performance.now();
      render();
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

  function place(block: Block): HTMLSpanElement {
    const box = document.createElement('div');
    box.className = 'camera-block';
    box.style.left = `${block.x * 100}%`;
    box.style.top = `${block.y * 100}%`;
    box.style.maxWidth = `${(1 - block.x) * 100}%`;
    box.style.width = `${Math.min(1 - block.x, Math.max(block.width, .15)) * 100}%`;
    const available = stage.clientWidth || 480;
    box.style.fontSize = `${Math.max(11, Math.min(22, block.height * available / (preview.width / preview.height) * .65))}px`;
    const span = document.createElement('span');
    box.append(span);
    overlay.append(box);
    return span;
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
          preview.width = Math.round(video.videoWidth * scale);
          preview.height = Math.round(video.videoHeight * scale);
          const context = preview.getContext('2d');
          if (!context) throw new Error('撮影画像を作成できません。');
          context.drawImage(video, 0, 0, preview.width, preview.height);
          if (freeze) {
            frozen = true;
            stopCamera();
            video.hidden = true;
            preview.hidden = false;
          }
        }
        overlay.replaceChildren();
        message.textContent = '文字を読み取り中…';
        const blocks = await invoke<Block[]>('recognize_camera', { image: preview.toDataURL('image/png') });
        if (run !== generation || !dialog.open) return;
        text = blocks.map(block => block.text).join('\n\n');
        if (text.length > 12000 || blocks.length > 128) throw new Error('文字が多すぎます。範囲を狭めてください。');
        if (!text.trim()) { message.textContent = '文字が見つかりません'; return; }
        for (const block of blocks) {
          if (run !== generation) return;
          const key = `${language}\0${block.text}`;
          const span = place(block);
          if (translations.has(key)) { span.textContent = translations.get(key)!; continue; }
          message.textContent = '翻訳中…';
          let output = '';
          let accepting = true;
          const onEvent = progressChannel(event => {
            if (!accepting || run !== generation || event.kind !== 'token') return;
            output += event.text;
            span.textContent = output;
          });
          let result: { truncated: boolean };
          try { result = await invoke('translate', { text: block.text, target: language, onEvent }); }
          finally { accepting = false; }
          if (run !== generation) return;
          if (result.truncated) throw new Error('訳文が長すぎます。範囲を狭めてください。');
          if (output.trim()) {
            translations.set(key, output);
            let bytes = [...translations].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
            while (translations.size > 128 || bytes > 500000) {
              const key = translations.keys().next().value!;
              bytes -= key.length + translations.get(key)!.length;
              translations.delete(key);
            }
          }
        }
        if (run === generation) message.textContent = automatic ? '自動更新中' : '翻訳完了';
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
    await start();
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
      overlay.replaceChildren();
      recognized = null;
      if (frozen) { paused = false; processFrame(true); }
    })();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  dialog.addEventListener('close', () => { stopCamera(); void cancelWork(); });
  video.addEventListener('resize', resize);
  window.addEventListener('pagehide', () => { void close(); });
  return {
    close,
    // Android also pauses the activity while the camera permission prompt is open.
    // Keep that request alive; start() releases it if the app remains hidden.
    suspend() { if (stream || work || frozen || paused) void close(); },
    get active() { return dialog.open || work !== null || cancellation !== null; },
  };
}
