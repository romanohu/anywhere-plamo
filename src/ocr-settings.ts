import { invoke, isDesktop, progressChannel } from './backend';

type Status = { ready: boolean; enabled: boolean };

export function initOcrSettings(): void {
  const toggle = document.getElementById('korean-ocr') as HTMLInputElement;
  const download = document.getElementById('korean-download') as HTMLButtonElement;
  const remove = document.getElementById('korean-remove') as HTMLButtonElement;
  const cancel = document.getElementById('korean-cancel') as HTMLButtonElement;
  const message = document.getElementById('korean-message')!;
  let state: Status = { ready: false, enabled: false };
  let busy = false;
  let downloading = false;
  function render(): void {
    toggle.checked = state.enabled;
    toggle.disabled = !isDesktop || busy || !state.ready;
    download.hidden = state.ready || downloading;
    download.disabled = !isDesktop || busy;
    remove.hidden = !state.ready || state.enabled;
    remove.disabled = busy;
    cancel.hidden = !downloading;
  }
  async function refresh(): Promise<void> {
    try { state = await invoke<Status>('get_korean_ocr'); render(); }
    catch (error) { message.textContent = String(error); }
  }
  async function change(command: string, args?: Record<string, unknown>): Promise<void> {
    busy = true;
    downloading = command === 'download_korean_ocr';
    message.textContent = downloading ? 'ダウンロード中…' : '変更中…';
    cancel.disabled = false;
    render();
    try {
      state = await invoke<Status>(command, args);
      message.textContent = '';
    } catch (error) {
      message.textContent = String(error) === 'CANCELLED' ? 'ダウンロードを中止しました' : String(error);
      await refresh();
    } finally { busy = false; downloading = false; render(); }
  }
  toggle.addEventListener('change', () => { void change('set_korean_ocr', { enabled: toggle.checked }); });
  remove.addEventListener('click', () => { void change('remove_korean_ocr'); });
  download.addEventListener('click', () => {
    const onEvent = progressChannel(event => {
      if (downloading && event.kind === 'download') message.textContent = `ダウンロード中… ${Math.floor(event.received / event.total * 100)}%`;
    });
    void change('download_korean_ocr', { onEvent });
  });
  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    void invoke('cancel_operation').catch(error => { message.textContent = String(error); cancel.disabled = false; });
  });
  document.getElementById('settings-button')!.addEventListener('click', () => { if (isDesktop && !busy) void refresh(); });
  render();
  if (isDesktop) void refresh();
}
