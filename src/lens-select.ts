import { invoke } from './backend';

export async function initLensSelect(): Promise<void> {
  document.body.classList.add('lens-select-mode');
  const surface = document.getElementById('lens-select')!;
  const box = document.getElementById('lens-select-box')!;
  const hint = document.getElementById('lens-select-hint')!;
  const instruction = 'ドラッグで範囲指定 · Enterで翻訳 · Escで取消';
  let start: { x: number; y: number } | null = null;
  let region: { x: number; y: number; width: number; height: number } | null = null;
  let busy = false;
  surface.hidden = false;
  const reset = (): void => {
    start = region = null;
    busy = false;
    box.hidden = true;
    hint.textContent = instruction;
  };
  reset();
  surface.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0) return;
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    start = { x: event.clientX, y: event.clientY };
    region = null;
    box.hidden = true;
    hint.textContent = instruction;
  });
  const drag = (event: PointerEvent): void => {
    if (!start || busy) return;
    const x = Math.max(0, Math.min(innerWidth, event.clientX));
    const y = Math.max(0, Math.min(innerHeight, event.clientY));
    region = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
    Object.assign(box.style, { left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, height: `${region.height}px` });
    box.hidden = false;
  };
  surface.addEventListener('pointermove', drag);
  surface.addEventListener('pointerup', event => { drag(event); start = null; });
  surface.addEventListener('pointercancel', reset);
  document.addEventListener('keydown', event => {
    // A hidden webview may miss Enter's keyup after opening the lens, and mark
    // the next press as repeat. The pending confirmation already blocks doubles.
    if (busy || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void invoke('hide_window').catch(error => { hint.textContent = String(error); });
    } else if (event.key === 'Enter' && !start) {
      event.preventDefault();
      if (!region || region.width < 320 || region.height < 80) {
        hint.textContent = 'もう少し広い範囲を囲んでください。';
        return;
      }
      busy = true;
      void invoke('confirm_lens_selection', { region }).catch(error => { busy = false; hint.textContent = String(error); });
    }
  });
  await window.__TAURI__?.event.listen('window-hidden', reset);
}
