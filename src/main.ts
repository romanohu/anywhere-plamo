import { invoke, isDesktop, onClipboardRequest, onShortcutPressed, onWindowHidden, progressChannel } from './backend';
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
const shortcutRecord = element<HTMLButtonElement>('shortcut-record');
const shortcutSave = element<HTMLButtonElement>('shortcut-save');
const shortcutReset = element<HTMLButtonElement>('shortcut-reset');
const shortcutMessage = element('shortcut-message');
const mac = /Mac/.test(navigator.platform);
let status: AppStatus = { modelReady: false, runtimeAvailable: false, shortcutAvailable: false, shortcut: '', defaultShortcut: '', shortcutSupported: false, wayland: false, resident: false };
let shortcutDraft = '';
let recordingShortcut = false;
let startingShortcut = false;
let savingShortcut = false;
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
  element('translate-label').textContent = cancelling ? '中断中…' : busy ? '中断' : '翻訳';
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
  statusText.textContent = '';
  statusText.title = '';
  message.hidden = true;
  updateControls();
}

async function refreshStatus(): Promise<void> {
  status = await invoke<AppStatus>('get_status');
  element('setup-banner').hidden = status.modelReady && status.runtimeAvailable;
  element('model-tag').textContent = status.modelReady ? '準備完了' : '未準備';
  element('download-section').hidden = status.modelReady;
  downloadButton.disabled = !status.runtimeAvailable;
  element('download-message').textContent = !status.runtimeAvailable
    ? '翻訳エンジンが見つかりません。アプリを再インストールしてください。' : '';
  if (!recordingShortcut && !savingShortcut) shortcutDraft = status.shortcut;
  renderShortcut();
  updateControls();
  prepareEngine();
}

function renderShortcut(): void {
  shortcutRecord.disabled = !status.shortcutSupported || savingShortcut;
  shortcutRecord.setAttribute('aria-pressed', String(recordingShortcut && !startingShortcut));
  element('shortcut-display').textContent = startingShortcut ? '準備中…' : recordingShortcut ? 'キーを押してください…'
    : !status.shortcutSupported ? 'OSで設定' : shortcutDraft.split('+').map(key => {
      if (key === 'Super') return mac ? '⌘' : 'Super';
      if (key === 'Alt' && mac) return 'Option';
      return key.replace(/^Key([A-Z])$/, '$1').replace(/^Digit([0-9])$/, '$1');
    }).join(' + ');
  shortcutSave.hidden = shortcutReset.hidden = !status.shortcutSupported;
  shortcutSave.disabled = savingShortcut || recordingShortcut || (shortcutDraft === status.shortcut && status.shortcutAvailable);
  shortcutReset.disabled = savingShortcut || recordingShortcut || (shortcutDraft === status.defaultShortcut && status.shortcut === status.defaultShortcut && status.shortcutAvailable);
  element('shortcut-description').textContent = status.shortcutSupported
    ? '他のアプリで選択した文章を翻訳します。'
    : isDesktop ? 'OSのキーボード設定で、次のコマンドにキーを割り当ててください。' : 'デスクトップアプリで設定できます。';
  element('shortcut-note').textContent = !status.shortcutSupported && isDesktop ? 'anywhere-plamo --translate-selection'
    : mac ? 'macOSのアクセシビリティ許可が必要です。' : '';
  element('shortcut-help').hidden = !status.shortcutSupported;
}

function openSettings(): void {
  shortcutDraft = status.shortcut;
  stopShortcutRecording();
  shortcutMessage.textContent = status.shortcutSupported && !status.shortcutAvailable ? 'このキーを登録できませんでした。別のキーを設定してください。' : '';
  renderShortcut();
  dialog.showModal();
}

function stopShortcutRecording(): void {
  if (!recordingShortcut) return;
  recordingShortcut = false;
  if (!startingShortcut) {
    void invoke('set_shortcut_recording', { recording: false }).catch(error => { shortcutMessage.textContent = String(error); });
  }
}

async function saveShortcut(value = shortcutDraft): Promise<void> {
  if (savingShortcut || !status.shortcutSupported) return;
  stopShortcutRecording();
  savingShortcut = true;
  shortcutMessage.textContent = '';
  renderShortcut();
  try {
    status = await invoke<AppStatus>('set_shortcut', { shortcut: value });
    shortcutDraft = status.shortcut;
    shortcutMessage.textContent = '保存しました';
  } catch (error) {
    shortcutMessage.textContent = String(error);
  } finally {
    savingShortcut = false;
    renderShortcut();
  }
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
  if (!status.modelReady || !status.runtimeAvailable) { openSettings(); return; }
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
element('settings-button').addEventListener('click', openSettings);
element('setup-open').addEventListener('click', openSettings);
element('settings-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  stopShortcutRecording();
  shortcutDraft = status.shortcut;
  renderShortcut();
});
shortcutRecord.addEventListener('click', async () => {
  if (startingShortcut) return;
  if (recordingShortcut) {
    stopShortcutRecording();
    shortcutMessage.textContent = '';
    renderShortcut();
    return;
  }
  recordingShortcut = true;
  startingShortcut = true;
  shortcutMessage.textContent = '';
  renderShortcut();
  try {
    await invoke('set_shortcut_recording', { recording: true });
    if (!recordingShortcut || !dialog.open) await invoke('set_shortcut_recording', { recording: false });
    else shortcutMessage.textContent = 'Escで取消';
  } catch (error) {
    recordingShortcut = false;
    shortcutMessage.textContent = String(error);
  } finally {
    startingShortcut = false;
    renderShortcut();
    if (recordingShortcut) shortcutRecord.focus();
  }
});
dialog.addEventListener('focusin', event => {
  if (!recordingShortcut || event.target === shortcutRecord) return;
  stopShortcutRecording();
  shortcutMessage.textContent = '';
  renderShortcut();
});
shortcutSave.addEventListener('click', () => { void saveShortcut(); });
shortcutReset.addEventListener('click', () => { void saveShortcut(status.defaultShortcut); });
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
  if (recordingShortcut) {
    if (startingShortcut) { event.preventDefault(); return; }
    if ((event.key === 'Tab' || event.key === 'Escape') && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.key === 'Escape') event.preventDefault();
      stopShortcutRecording();
      shortcutMessage.textContent = '';
      renderShortcut();
      return;
    }
    event.preventDefault();
    if (event.isComposing || event.repeat || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) return;
    if (!event.code || event.code === 'Unidentified' || (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code))) {
      shortcutMessage.textContent = `Ctrl・${mac ? 'Option・⌘' : 'Alt・Super'}と組み合わせるか、F1〜F24を押してください。`;
      return;
    }
    shortcutDraft = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', event.code].filter(Boolean).join('+');
    stopShortcutRecording();
    shortcutMessage.textContent = '保存で反映';
    renderShortcut();
    return;
  }
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
  renderShortcut();
  if (!isDesktop) {
    element('setup-banner').hidden = false;
    element('setup-heading').textContent = '画面プレビュー';
    element('setup-banner').querySelector('p')!.textContent = '翻訳・モデル取得・ショートカットはアプリで利用できます。';
    downloadButton.disabled = true;
    element<HTMLButtonElement>('quit-button').disabled = true;
    return;
  }
  try {
    await onClipboardRequest(() => { if (initialized) void takePending().catch(showError); });
    await onWindowHidden(() => { dialog.close(); });
    await onShortcutPressed(shortcut => {
      if (!recordingShortcut) return;
      shortcutDraft = shortcut;
      stopShortcutRecording();
      shortcutMessage.textContent = '';
      renderShortcut();
    });
    await refreshStatus();
    initialized = true;
    await takePending();
  } catch (error) { showError(error); }
}

void init();
