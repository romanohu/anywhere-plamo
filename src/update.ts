import { invoke, isDesktop, progressChannel } from './backend';

type Progress = { kind: 'download'; received: number; total: number | null } | { kind: 'installing' };

export function initUpdate(): void {
  const button = document.getElementById('update-button') as HTMLButtonElement;
  const message = document.getElementById('update-message')!;
  function show(text: string): void {
    message.textContent = text;
    message.scrollIntoView({ block: 'nearest' });
  }
  let available = false;
  button.disabled = !isDesktop;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!available) {
        show('確認中…');
        const version = await invoke<string | null>('check_update');
        available = version !== null;
        button.textContent = available ? '更新して再起動' : '更新を確認';
        show(version ? `v${version} に更新できます。再起動すると入力中の文章は消去されます。` : '最新バージョンです。');
      } else {
        show('ダウンロード中…');
        const onEvent = progressChannel<Progress>(event => {
          show(event.kind === 'installing' ? '更新を適用中…' : event.total
            ? `ダウンロード中… ${Math.min(100, Math.floor(event.received / event.total * 100))}%`
            : `ダウンロード中… ${(event.received / 1024 / 1024).toFixed(1)} MB`);
        });
        await invoke('install_update', { onEvent });
        show('再起動中…');
        return;
      }
    } catch (error) {
      available = false;
      button.textContent = '更新を確認';
      show(error instanceof Error ? error.message : String(error));
    }
    button.disabled = false;
  });
}
