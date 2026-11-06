import { invoke, isDesktop, onClipboardRequest, progressChannel } from './backend';
import type { AppStatus } from './backend';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const source = element<HTMLTextAreaElement>('source');
const target = element<HTMLSelectElement>('target');
const result = element<HTMLParagraphElement>('translation');
const empty = element<HTMLDivElement>('empty-result');
const translateButton = element<HTMLButtonElement>('translate-button');
const pasteButton = element<HTMLButtonElement>('paste-button');
const clearButton = element<HTMLButtonElement>('clear-button');
const copyButton = element<HTMLButtonElement>('copy-button');
const dialog = element<HTMLDialogElement>('settings-dialog');
const downloadButton = element<HTMLButtonElement>('download-button');
const preloadModel = element<HTMLInputElement>('preload-model');
const statusText = element<HTMLSpanElement>('translation-status');
const message = element<HTMLDivElement>('message');
const mac = /Mac/.test(navigator.platform);
let status: AppStatus = { modelReady: false, runtimeAvailable: false, shortcutAvailable: false, wayland: false, resident: false };
let busy = false;
let downloading = false;
let cancelling = false;
let generation = 0;
let copyTimer: ReturnType<typeof setTimeout>;
let initialized = false;
let readingMode = false;
let pendingSelection: string | null = null;
let cancelRequest: Promise<void> | null = null;
let takingPending = false;
let takePendingAgain = false;
let selectionGeneration = 0;
let pendingReadGeneration = 0;
let preparationRequested = false;

try {
  const saved = localStorage.getItem('target-language');
  if (saved && Array.from(target.options).some(option => option.value === saved)) target.value = saved;
  preloadModel.checked = localStorage.getItem('preload-model') !== 'false';
} catch { /* Preferences are optional when browser storage is unavailable. */ }

element('modifier-key').textContent = mac ? '⌘' : 'Ctrl';

function showError(error: unknown): void {
  message.textContent = error instanceof Error ? error.message : String(error);
  message.hidden = false;
}

function updateControls(): void {
  const hasText = source.value.trim().length > 0;
  translateButton.disabled = cancelling || downloading || (!busy && (!hasText || !isDesktop));
  translateButton.classList.toggle('is-busy', busy);
  element('translate-label').textContent = cancelling ? '中断中…' : busy ? '中断する' : '翻訳する';
  element('translate-arrow').textContent = busy ? '■' : '→';
  source.readOnly = busy || cancelling || readingMode;
  target.disabled = busy || cancelling;
  pasteButton.disabled = busy || cancelling || downloading;
  clearButton.disabled = busy || cancelling || !source.value;
  copyButton.disabled = busy || !result.textContent;
  downloadButton.disabled = busy || cancelling || downloading || !status.runtimeAvailable;
  element('character-count').textContent = `${source.value.length.toLocaleString()} / 12,000`;
}

function setReadingMode(enabled: boolean): void {
  readingMode = enabled;
  document.body.classList.toggle('reading-mode', enabled);
  element('reading-actions').hidden = !enabled;
  element('source-panel').hidden = enabled;
  element('toggle-original').setAttribute('aria-expanded', 'false');
  element('toggle-original').textContent = '原文を表示';
  updateControls();
}

function resetResult(): void {
  generation++;
  result.textContent = '';
  result.hidden = true;
  empty.hidden = false;
  element('copy-label').textContent = 'コピー';
  statusText.textContent = '翻訳する準備ができたら、ボタンを押してください';
  statusText.title = '';
  message.hidden = true;
  updateControls();
}

async function refreshStatus(): Promise<void> {
  status = await invoke<AppStatus>('get_status');
  element('model-status').classList.toggle('ready', status.modelReady && status.runtimeAvailable);
  element('model-status-text').textContent = !status.runtimeAvailable ? '初期設定が必要' : status.modelReady ? 'オフライン翻訳' : 'モデル未準備';
  element('setup-banner').hidden = status.modelReady && status.runtimeAvailable;
  element('model-tag').textContent = status.modelReady ? '準備完了' : '未準備';
  element('download-section').hidden = status.modelReady;
  downloadButton.disabled = !status.runtimeAvailable;
  element('download-message').textContent = !status.runtimeAvailable
    ? '推論エンジンが見つかりません。開発中は npm run runtime:build を実行し、アプリを再起動してください。'
    : status.modelReady ? 'モデルの準備ができました。ネット接続なしで翻訳できます。' : '';
  if (status.shortcutAvailable) {
    element('shortcut-display').textContent = `${mac ? '⌘' : 'Ctrl'} + Shift + J`;
    element('shortcut-description').textContent = mac
      ? '他のアプリで文章を選択して、このショートカットを押すと翻訳します。初回はmacOSのアクセシビリティ許可が必要です。'
      : '他のアプリで文章を選択して、このショートカットを押すと翻訳します。コピー操作は不要です。';
  } else {
    element('shortcut-display').textContent = 'anywhere-plamo --translate-selection';
    element('shortcut-description').textContent = status.wayland
      ? 'OSのキーボード設定で下のコマンドに好きなキーを割り当て、文章を選択してから押してください。選択文字の取得はデスクトップ環境と元のアプリの対応が必要です。'
      : 'ショートカットを登録できませんでした。OSのキーボード設定で下のコマンドを登録し、文章を選択してから押してください。';
  }
  element('shortcut-note').textContent = status.resident
    ? '閉じる・Escでウィンドウを隠します。終了はトレイメニュー、または下のボタンから。'
    : '常駐アイコンを利用できないため、閉じるボタンでアプリを終了します。コマンドから再び開けます。';
  updateControls();
  prepareEngine();
}

function prepareEngine(): void {
  if (preloadModel.checked && status.modelReady && status.runtimeAvailable && !preparationRequested) {
    preparationRequested = true;
    void invoke('prepare_engine').catch(() => { /* Translation retries if background preparation fails. */ });
  }
}

function translatePendingSelection(): void {
  if (busy || downloading || cancelRequest || takingPending || pendingSelection === null) return;
  source.value = pendingSelection;
  pendingSelection = null;
  setReadingMode(true);
  resetResult();
  if (dialog.open && status.modelReady) dialog.close();
  void translate();
}

async function cancel(clearPending = true): Promise<void> {
  if (clearPending) { pendingSelection = null; selectionGeneration++; }
  if (cancelRequest) return cancelRequest.catch(() => {});
  if (cancelling) return;
  cancelling = true;
  updateControls();
  const request = invoke<void>('cancel_operation');
  cancelRequest = request;
  try { await request; } catch (error) {
    cancelling = false;
    showError(pendingSelection === null ? error : `中断できませんでした。現在の翻訳が終わり次第、最新の選択を翻訳します。\n${String(error)}`);
  } finally {
    cancelRequest = null;
    if (!busy && !downloading) cancelling = false;
    updateControls();
    translatePendingSelection();
  }
}

async function translate(): Promise<void> {
  if (busy) return cancel();
  if (cancelling || downloading || !source.value.trim()) return;
  if (!status.modelReady || !status.runtimeAvailable) { dialog.showModal(); return; }
  resetResult();
  busy = true;
  cancelling = false;
  const run = ++generation;
  const started = performance.now();
  let firstToken: number | null = null;
  let acceptingEvents = true;
  statusText.textContent = 'モデルを準備中…';
  updateControls();
  try {
    const channel = progressChannel(event => {
      if (run !== generation || !acceptingEvents) return;
      if (event.kind === 'loading') statusText.textContent = 'モデルを読み込み中…';
      if (event.kind === 'token' && event.text.length > 0) {
        if (firstToken === null && event.text.trim().length > 0) {
          firstToken = performance.now();
          statusText.title = `最初の文字まで ${((firstToken - started) / 1000).toFixed(1)}秒`;
        }
        empty.hidden = true;
        result.hidden = false;
        result.textContent += event.text;
        statusText.textContent = '翻訳中…';
      }
    });
    const response = await invoke<{ truncated: boolean }>('translate', {
      text: source.value, target: target.value, onEvent: channel,
    });
    statusText.textContent = `${((performance.now() - started) / 1000).toFixed(1)}秒 · 翻訳完了`;
    if (response.truncated) {
      statusText.textContent = '訳文が途中で止まりました';
      showError('訳文の長さの上限に達しました。原文を短く分けて翻訳してください。');
    }
  } catch (error) {
    statusText.textContent = cancelling || String(error) === 'CANCELLED' ? '翻訳を中断しました' : '翻訳できませんでした';
    if (!cancelling && String(error) !== 'CANCELLED') showError(error);
  } finally {
    acceptingEvents = false;
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    statusText.title = `${firstToken === null ? '文字の出力なし' : `最初の文字まで ${((firstToken - started) / 1000).toFixed(1)}秒`} · 処理終了まで ${elapsed}秒`;
    busy = false;
    cancelling = cancelRequest !== null;
    updateControls();
    translatePendingSelection();
  }
}

function validInput(value: string): boolean {
  if (!value.trim()) { showError('文章がありません。文章を選択またはコピーしてからお試しください。'); return false; }
  if (value.length > 12000) { showError('入力は12,000文字分までです。絵文字などは複数文字分に数えます。文章を短く分けてください。'); return false; }
  return true;
}

async function paste(): Promise<void> {
  if (busy || cancelling || downloading) return;
  const requested = generation;
  try {
    const value = isDesktop ? await invoke<string>('read_clipboard') : await navigator.clipboard.readText();
    if (busy || cancelling || downloading || requested !== generation || !validInput(value)) return;
    source.value = value;
    setReadingMode(false);
    resetResult();
    source.focus();
  } catch (error) { if (requested === generation) showError(error); }
}

async function takePending(): Promise<void> {
  if (takingPending) { takePendingAgain = true; pendingReadGeneration = selectionGeneration; return; }
  takingPending = true;
  let readGeneration = selectionGeneration;
  try {
    do {
      takePendingAgain = false;
      const pending = await invoke<{ text: string | null; error: string | null } | null>('take_pending_clipboard');
      if (readGeneration === selectionGeneration && pending) {
        pendingSelection = null;
        if (pending.error) showError(pending.error);
        else if (pending.text != null && validInput(pending.text)) {
          if (downloading) showError('モデルのダウンロード中です。完了後に、もう一度ショートカットを押してください。');
          else {
            pendingSelection = pending.text;
            if (busy) void cancel(false);
          }
        }
      }
      readGeneration = pendingReadGeneration;
    } while (takePendingAgain);
  } finally {
    takingPending = false;
    translatePendingSelection();
  }
}

async function download(): Promise<void> {
  if (downloading || busy || cancelling) return;
  downloading = true;
  cancelling = false;
  element('download-section').hidden = true;
  element('download-progress').hidden = false;
  element('download-message').textContent = '';
  element('download-label').textContent = '接続中…';
  element('download-percent').textContent = '0%';
  element<HTMLProgressElement>('progress-bar').value = 0;
  updateControls();
  try {
    const channel = progressChannel(event => {
      if (event.kind === 'download') {
        const percent = Math.min(100, (event.received / event.total) * 100);
        element('download-label').textContent = `${Math.round(event.received / 1_000_000)} / ${Math.round(event.total / 1_000_000)} MB`;
        element('download-percent').textContent = `${Math.round(percent)}%`;
        element<HTMLProgressElement>('progress-bar').value = percent;
      }
      if (event.kind === 'verifying') element('download-label').textContent = 'ファイルを確認中…';
    });
    await invoke('download_model', { onEvent: channel });
    await refreshStatus();
    message.hidden = true;
  } catch (error) {
    element('download-message').textContent = cancelling || String(error) === 'CANCELLED' ? 'ダウンロードを中止しました。もう一度やり直せます。' : String(error);
  } finally {
    downloading = false;
    cancelling = cancelRequest !== null;
    element('download-progress').hidden = true;
    element('download-section').hidden = status.modelReady;
    updateControls();
  }
}

source.addEventListener('input', resetResult);
target.addEventListener('change', () => {
  try { localStorage.setItem('target-language', target.value); } catch { /* Optional preference. */ }
  resetResult();
});
translateButton.addEventListener('click', () => { void translate(); });
pasteButton.addEventListener('click', () => { void paste(); });
element('toggle-original').addEventListener('click', () => {
  const panel = element('source-panel');
  panel.hidden = !panel.hidden;
  element('toggle-original').setAttribute('aria-expanded', String(!panel.hidden));
  element('toggle-original').textContent = panel.hidden ? '原文を表示' : '原文を隠す';
});
element('edit-source').addEventListener('click', () => { setReadingMode(false); source.focus(); });
clearButton.addEventListener('click', () => { source.value = ''; resetResult(); source.focus(); });
copyButton.addEventListener('click', async () => {
  try {
    if (isDesktop) await invoke('write_clipboard', { text: result.textContent ?? '' });
    else await navigator.clipboard.writeText(result.textContent ?? '');
    element('copy-label').textContent = 'コピーしました';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { element('copy-label').textContent = 'コピー'; }, 1800);
  } catch (error) { showError(error); }
});
element('settings-button').addEventListener('click', () => dialog.showModal());
element('setup-open').addEventListener('click', () => dialog.showModal());
element('settings-close').addEventListener('click', () => dialog.close());
downloadButton.addEventListener('click', () => { void download(); });
preloadModel.addEventListener('change', () => {
  try { localStorage.setItem('preload-model', String(preloadModel.checked)); } catch { /* Optional preference. */ }
  prepareEngine();
});
element('download-cancel').addEventListener('click', () => { void cancel(); });
element('license-link').addEventListener('click', async () => {
  try {
    if (isDesktop) await invoke('open_model_license');
    else window.open('https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF#license', '_blank', 'noopener,noreferrer');
  } catch (error) { element('download-message').textContent = String(error); }
});
element('quit-button').addEventListener('click', () => { void invoke('quit_app').catch(showError); });
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !dialog.open) {
    event.preventDefault();
    void translate();
  }
  if (event.key === 'Escape' && !dialog.open) {
    event.preventDefault();
    if (busy || cancelling) void cancel();
    else if (isDesktop) {
      pendingSelection = null;
      selectionGeneration++;
      void invoke('hide_window').catch(showError);
    }
  }
});

async function init(): Promise<void> {
  updateControls();
  if (!isDesktop) {
    element('model-status-text').textContent = '画面プレビュー';
    element('setup-banner').hidden = false;
    element('setup-heading').textContent = 'デスクトップアプリの画面プレビュー';
    element('setup-banner').querySelector('p')!.textContent = '翻訳・モデル取得・ショートカットはアプリで利用できます。';
    downloadButton.disabled = true;
    element<HTMLButtonElement>('quit-button').disabled = true;
    return;
  }
  try {
    await onClipboardRequest(() => { if (initialized) void takePending().catch(showError); });
    await refreshStatus();
    initialized = true;
    await takePending();
  } catch (error) { showError(error); }
}

void init();
