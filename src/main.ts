import { invoke, isDesktop, onClipboardRequest, onShortcutPressed, onWindowHidden, progressChannel } from './backend';
import type { AppStatus } from './backend';
import { initLens } from './lens';
import { initLensSelect } from './lens-select';
import { initUpdate } from './update';
import { initOcrSettings } from './ocr-settings';
import { initCamera } from './camera';
import { initDocument } from './document';

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
const dictionaryButton = element<HTMLButtonElement>('dictionary-button');
const dictionaryDialog = element<HTMLDialogElement>('dictionary-dialog');
const downloadButton = element<HTMLButtonElement>('download-button');
const modelSelect = element<HTMLSelectElement>('translation-model');
const preloadModel = element<HTMLInputElement>('preload-model');
const autoDirection = element<HTMLInputElement>('auto-direction');
const shortcutPopup = element<HTMLInputElement>('shortcut-popup');
const statusText = element<HTMLSpanElement>('translation-status');
const message = element<HTMLDivElement>('message');
const shortcutAction = element<HTMLSelectElement>('shortcut-action');
const shortcutRecord = element<HTMLButtonElement>('shortcut-record');
const shortcutSave = element<HTMLButtonElement>('shortcut-save');
const shortcutReset = element<HTMLButtonElement>('shortcut-reset');
const shortcutMessage = element('shortcut-message');
const dictionaryEntries = element<HTMLDivElement>('dictionary-entries');
const dictionaryEmpty = element('dictionary-empty');
const dictionaryTerm = element<HTMLInputElement>('dictionary-term');
const dictionaryReplacement = element<HTMLInputElement>('dictionary-replacement');
const dictionaryAdd = element<HTMLButtonElement>('dictionary-add');
const dictionarySave = element<HTMLButtonElement>('dictionary-save');
const dictionaryMessage = element('dictionary-message');
const mac = /Mac/.test(navigator.platform);
const popup = new URLSearchParams(location.search).has('popup');
const lens = new URLSearchParams(location.search).has('lens');
const lensSelect = new URLSearchParams(location.search).has('lens-select');
let status: AppStatus = { modelId: '0.8b-q4', models: [], modelReady: false, runtimeAvailable: false, shortcutAvailable: false, shortcut: '', defaultShortcut: '', shortcutSupported: false, shortcutPopup: false, wayland: false, resident: false, lensSupported: false, ocrAvailable: false, lensUsesSelection: false, lensShortcut: '', defaultLensShortcut: '', lensShortcutAvailable: false, lensOpenShortcut: '', defaultLensOpenShortcut: '', lensOpenShortcutAvailable: false, lensPassthrough: false };
let documents: ReturnType<typeof initDocument> | undefined;
let shortcutDraft = '';
let recordingShortcut = false;
let startingShortcut = false;
let savingShortcut = false;
let savingPopup = false;
let busy = false;
let downloading = false;
let changingModel = false;
let cancelling = false;
let openingScreenLens = false;
let generation = 0;
let copyTimer: ReturnType<typeof setTimeout>;
let initialized = false;
let readingMode = false;
let pendingSelection: { text: string; selection: boolean } | null = null;
let cancelRequest: Promise<void> | null = null;
let takingPending = false;
let takePendingAgain = false;
let selectionGeneration = 0;
let pendingReadGeneration = 0;
let preparationRequested = false;
let popupRequest: number | null = null;
let popupTerminal = false;
let manualTarget = target.value;
let dictionaryDraft: DictionaryEntry[] = [];
let dictionarySaving = false;
let camera: ReturnType<typeof initCamera> | null = null;

type DictionaryEntry = { term: string; replacement: string; enabled: boolean };

function loadPreferences(): void {
  try {
    const saved = localStorage.getItem('target-language');
    if (saved && Array.from(target.options).some(option => option.value === saved)) manualTarget = saved;
    preloadModel.checked = localStorage.getItem('preload-model') !== 'false';
    autoDirection.checked = localStorage.getItem('auto-direction') === 'true';
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
}
loadPreferences();
target.value = manualTarget;
document.body.classList.toggle('popup', popup);
if (popup) document.title = 'Anywhere Plamo — 選択翻訳';
dictionaryButton.hidden = popup;

element('modifier-key').textContent = mac ? '⌘' : 'Ctrl';

function showError(error: unknown): void {
  message.textContent = error instanceof Error ? error.message : String(error);
  message.hidden = false;
}

function updateControls(): void {
  const hasText = source.value.trim().length > 0;
  translateButton.disabled = changingModel || cancelling || downloading || (!busy && (!hasText || !isDesktop));
  translateButton.classList.toggle('is-busy', busy);
  element('translate-label').textContent = cancelling ? '中断中…' : busy ? '中断' : '翻訳';
  element('translate-arrow').textContent = busy ? '■' : '→';
  source.readOnly = busy || cancelling || readingMode;
  target.disabled = busy || cancelling;
  pasteButton.disabled = changingModel || busy || cancelling || downloading;
  clearButton.disabled = busy || cancelling || !source.value;
  copyButton.disabled = busy || !result.textContent;
  modelSelect.disabled = !isDesktop || changingModel || busy || cancelling || downloading;
  downloadButton.disabled = changingModel || busy || cancelling || downloading || !status.runtimeAvailable;
  element<HTMLButtonElement>('camera-button').disabled = changingModel || busy || cancelling || downloading || !status.ocrAvailable || !status.modelReady;
  element('document-button').hidden = popup || status.platform === 'android';
  element<HTMLButtonElement>('document-button').disabled = changingModel || busy || cancelling || downloading || !status.modelReady;
  if (status.platform === 'android') element<HTMLButtonElement>('lens-button').disabled = changingModel || openingScreenLens || busy || cancelling || downloading || !status.modelReady;
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
  const previousModel = status.modelId;
  status = await invoke<AppStatus>('get_status');
  if (previousModel !== status.modelId) {
    preparationRequested = false;
    await camera?.close();
    resetResult();
  }
  modelSelect.replaceChildren(...status.models.map(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.name} · ${modelSize(model.size)}${model.ready ? ' · 取得済み' : ''}`;
    return option;
  }));
  modelSelect.value = status.modelId;
  const model = status.models.find(model => model.id === status.modelId);
  element('model-description').textContent = model?.description ?? '';
  element('setup-banner').querySelector('p')!.textContent = model ? `${modelSize(model.size)}・初回のみ` : '';
  document.body.classList.toggle('mobile', status.platform === 'android');
  element('shortcut-section').hidden = status.platform === 'android';
  element('update-section').hidden = popup || status.platform === 'android';
  element('quit-button').hidden = status.platform === 'android';
  element('lens-button').hidden = !status.lensSupported || popup;
  element('camera-button').hidden = popup;
  element('setup-banner').hidden = status.modelReady && status.runtimeAvailable;
  element('model-tag').textContent = status.modelReady ? '準備完了' : '未準備';
  element('download-section').hidden = status.modelReady;
  downloadButton.disabled = !status.runtimeAvailable;
  element('download-message').textContent = !status.runtimeAvailable
    ? '翻訳エンジンが見つかりません。アプリを再インストールしてください。' : '';
  if (!recordingShortcut && !savingShortcut) shortcutDraft = currentShortcut().binding;
  renderShortcut();
  updateControls();
  prepareEngine();
}

function modelSize(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

async function selectModel(): Promise<void> {
  if (changingModel || downloading || busy || cancelling) { modelSelect.value = status.modelId; return; }
  const id = modelSelect.value;
  if (id === status.modelId) return;
  changingModel = true;
  updateControls();
  element('download-message').textContent = '';
  try {
    await camera?.close();
    await invoke('set_translation_model', { id });
    await refreshStatus();
  } catch (error) {
    modelSelect.value = status.modelId;
    element('download-message').textContent = String(error);
  } finally {
    changingModel = false;
    updateControls();
  }
}

function currentShortcut(): { binding: string; default: string; available: boolean } {
  if (shortcutAction.value === 'lensOpen') return { binding: status.lensOpenShortcut, default: status.defaultLensOpenShortcut, available: status.lensOpenShortcutAvailable };
  return shortcutAction.value === 'lens'
    ? { binding: status.lensShortcut, default: status.defaultLensShortcut, available: status.lensShortcutAvailable }
    : { binding: status.shortcut, default: status.defaultShortcut, available: status.shortcutAvailable };
}

function renderShortcut(): void {
  const current = currentShortcut();
  const forLens = shortcutAction.value === 'lens';
  const forLensOpen = shortcutAction.value === 'lensOpen';
  shortcutAction.disabled = savingShortcut || startingShortcut;
  element('selection-shortcut-options').hidden = forLens || forLensOpen;
  shortcutRecord.setAttribute('aria-label', forLensOpen ? 'OCRレンズ呼び出しのショートカットを変更' : forLens ? 'レンズのショートカットを変更' : '翻訳ショートカットを変更');
  shortcutPopup.disabled = !isDesktop || savingPopup;
  if (!savingPopup) shortcutPopup.checked = status.shortcutPopup;
  shortcutRecord.disabled = !status.shortcutSupported || savingShortcut;
  shortcutRecord.setAttribute('aria-pressed', String(recordingShortcut && !startingShortcut));
  element('shortcut-display').textContent = startingShortcut ? '準備中…' : recordingShortcut ? 'キーを押してください…'
    : !status.shortcutSupported ? 'OSで設定' : shortcutDraft.split('+').map(key => {
      if (key === 'Super') return mac ? '⌘' : 'Super';
      if (key === 'Alt' && mac) return 'Option';
      return key.replace(/^Key([A-Z])$/, '$1').replace(/^Digit([0-9])$/, '$1');
    }).join(' + ');
  shortcutSave.hidden = shortcutReset.hidden = !status.shortcutSupported;
  shortcutSave.disabled = savingShortcut || recordingShortcut || (shortcutDraft === current.binding && current.available);
  shortcutReset.disabled = savingShortcut || recordingShortcut || (shortcutDraft === current.default && current.binding === current.default && current.available);
  element('shortcut-description').textContent = status.shortcutSupported
    ? forLensOpen ? '範囲を囲み、Enterで翻訳します。同じキーでレンズを閉じます。' : forLens ? 'レンズ越しに背後のアプリを操作できます。同じキーで解除します。' : '他のアプリで選択した文章を翻訳します。'
    : forLens ? 'この環境ではクリック透過を利用できません。' : isDesktop ? 'OSのキーボード設定で、次のコマンドにキーを割り当ててください。' : 'デスクトップアプリで設定できます。';
  element('shortcut-note').textContent = forLens ? '' : !status.shortcutSupported && isDesktop ? `anywhere-plamo --${forLensOpen ? 'toggle-lens' : 'translate-selection'}`
    : mac && !forLensOpen ? 'macOSのアクセシビリティ許可が必要です。' : '';
  element('shortcut-help').hidden = !status.shortcutSupported;
}

function openSettings(): void {
  loadPreferences();
  shortcutDraft = currentShortcut().binding;
  stopShortcutRecording();
  shortcutMessage.textContent = status.shortcutSupported && !currentShortcut().available ? 'このキーを登録できませんでした。別のキーを設定してください。' : '';
  renderShortcut();
  dialog.showModal();
  if (isDesktop) void refreshStatus().catch(showError);
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
    status = await invoke<AppStatus>('set_shortcut', { shortcut: value, lens: shortcutAction.value === 'lens', lensOpen: shortcutAction.value === 'lensOpen' });
    shortcutDraft = currentShortcut().binding;
    shortcutMessage.textContent = '保存しました';
  } catch (error) {
    shortcutMessage.textContent = String(error);
  } finally {
    savingShortcut = false;
    renderShortcut();
  }
}

function prepareEngine(): void {
  if (!popup && preloadModel.checked && status.modelReady && status.runtimeAvailable && !preparationRequested) {
    preparationRequested = true;
    void invoke('prepare_engine').catch(() => { /* Translation retries if background preparation fails. */ });
  }
}

function renderDictionary(): void {
  dictionaryEmpty.hidden = dictionaryDraft.length > 0;
  dictionaryEntries.replaceChildren(...dictionaryDraft.map((entry, index) => {
    const row = document.createElement('div');
    row.className = 'dictionary-row';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = entry.enabled;
    enabled.setAttribute('aria-label', `${entry.term}を有効化`);
    enabled.addEventListener('change', () => { dictionaryDraft[index].enabled = enabled.checked; });
    const term = document.createElement('span');
    term.className = 'dictionary-term';
    term.textContent = entry.term;
    term.title = entry.term;
    const arrow = document.createElement('span');
    arrow.className = 'dictionary-arrow';
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    const replacement = document.createElement('input');
    replacement.className = 'dictionary-replacement';
    replacement.value = entry.replacement;
    replacement.maxLength = 1000;
    replacement.setAttribute('aria-label', `${entry.term}の訳語`);
    replacement.addEventListener('input', () => { dictionaryDraft[index].replacement = replacement.value; });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button dictionary-delete';
    remove.setAttribute('aria-label', `${entry.term}を削除`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    remove.addEventListener('click', () => {
      dictionaryDraft.splice(index, 1);
      dictionaryMessage.textContent = '';
      renderDictionary();
    });
    row.append(enabled, term, arrow, replacement, remove);
    return row;
  }));
}

async function openDictionary(): Promise<void> {
  dictionaryMessage.textContent = '';
  try {
    dictionaryDraft = await invoke<DictionaryEntry[]>('get_dictionary');
    dictionaryTerm.value = '';
    dictionaryReplacement.value = '';
    renderDictionary();
    dictionaryDialog.showModal();
  } catch (error) {
    showError(error);
  }
}

function addDictionaryEntry(): void {
  const term = dictionaryTerm.value.trim();
  const replacement = dictionaryReplacement.value.trim();
  if (!term) { dictionaryMessage.textContent = '原語を入力してください。'; return; }
  if (dictionaryDraft.some(entry => entry.term === term)) {
    dictionaryMessage.textContent = 'この原語は登録済みです。既存の訳語を編集してください。';
    return;
  }
  dictionaryDraft.push({ term, replacement, enabled: true });
  dictionaryTerm.value = '';
  dictionaryReplacement.value = '';
  dictionaryMessage.textContent = '';
  renderDictionary();
  dictionaryTerm.focus();
}

async function saveDictionary(): Promise<void> {
  if (dictionarySaving) return;
  dictionarySaving = true;
  dictionaryMessage.textContent = '';
  try {
    dictionaryDraft = await invoke<DictionaryEntry[]>('set_dictionary', { entries: dictionaryDraft });
    renderDictionary();
    dictionaryMessage.textContent = '保存しました';
  } catch (error) {
    dictionaryMessage.textContent = String(error);
  } finally {
    dictionarySaving = false;
  }
}

function finishPopupRequest(): void {
  if (!popup || !popupTerminal || popupRequest === null || busy || downloading || cancelling || pendingSelection || takingPending || cancelRequest) return;
  popupTerminal = false;
  void invoke('finish_popup_request', { request: popupRequest }).catch(showError);
}

function selectionTarget(text: string): 'ja' | 'en' | null {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) return 'en';
  // Only infer English when all letters are ASCII; leave other scripts unchanged.
  if (/[a-z]/i.test(text) && !/\p{L}/u.test(text.replace(/[a-z]/gi, ''))) return 'ja';
  return null;
}

function translatePendingSelection(): void {
  if (busy || downloading || cancelRequest || takingPending || pendingSelection === null) return;
  source.value = pendingSelection.text;
  target.value = autoDirection.checked && pendingSelection.selection
    ? selectionTarget(pendingSelection.text) ?? manualTarget : manualTarget;
  pendingSelection = null;
  setReadingMode(true);
  resetResult();
  if (dialog.open && status.modelReady) dialog.close();
  void translate();
}

async function cancel(clearPending = true): Promise<void> {
  if (clearPending) { pendingSelection = null; selectionGeneration++; popupTerminal = true; }
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
    finishPopupRequest();
  }
}

async function translate(): Promise<void> {
  if (busy) return cancel();
  if (changingModel || cancelling || downloading || !source.value.trim()) return;
  if (!status.modelReady || !status.runtimeAvailable) { openSettings(); return; }
  resetResult();
  busy = true;
  cancelling = false;
  const run = ++generation;
  const request = popupRequest;
  popupTerminal = false;
  const started = performance.now();
  let firstToken: number | null = null;
  let acceptingEvents = true;
  const output = document.createTextNode('');
  result.append(output);
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
        output.appendData(event.text);
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
    if (request === popupRequest) popupTerminal = true;
    finishPopupRequest();
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
    target.value = manualTarget;
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
      const pending = await invoke<{ text: string | null; error: string | null; selection: boolean; request: number } | null>('take_pending_clipboard');
      if (pending) {
        loadPreferences();
        if (popup) await refreshStatus();
      }
      if (readGeneration === selectionGeneration && pending) {
        if (popup) {
          popupRequest = pending.request;
          popupTerminal = true;
        }
        if (dialog.open && status.modelReady) dialog.close();
        pendingSelection = null;
        if (pending.error) showError(pending.error);
        else if (pending.text != null && validInput(pending.text)) {
          if (downloading) showError('モデルのダウンロード中です。完了後に、もう一度ショートカットを押してください。');
          else {
            pendingSelection = { text: pending.text, selection: pending.selection };
            popupTerminal = false;
            if (busy) void cancel(false);
          }
        }
      }
      readGeneration = pendingReadGeneration;
    } while (takePendingAgain);
  } finally {
    takingPending = false;
    translatePendingSelection();
    finishPopupRequest();
  }
}

async function download(): Promise<void> {
  if (changingModel || downloading || busy || cancelling) return;
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
    finishPopupRequest();
  }
}

source.addEventListener('input', () => { target.value = manualTarget; resetResult(); });
target.addEventListener('change', () => {
  manualTarget = target.value;
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
clearButton.addEventListener('click', () => { source.value = ''; target.value = manualTarget; resetResult(); source.focus(); });
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
dictionaryButton.addEventListener('click', () => { void openDictionary(); });
element('dictionary-close').addEventListener('click', () => dictionaryDialog.close());
dictionaryAdd.addEventListener('click', addDictionaryEntry);
dictionarySave.addEventListener('click', () => { void saveDictionary(); });
[dictionaryTerm, dictionaryReplacement].forEach(input => {
  // Japanese conversion commits on the first Enter and registers on the
  // second. WebKit reports the committing Enter as a plain keydown right
  // after compositionend, so swallow that one and let the next register.
  let ignoreNextEnter = false;
  input.addEventListener('compositionend', () => {
    ignoreNextEnter = true;
    setTimeout(() => { ignoreNextEnter = false; }, 0);
    input.addEventListener('keyup', () => { ignoreNextEnter = false; }, { once: true });
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    if (ignoreNextEnter) return;
    event.preventDefault();
    addDictionaryEntry();
  });
});
dictionaryDialog.addEventListener('close', () => { dictionaryMessage.textContent = ''; });
element('lens-button').addEventListener('click', () => {
  if (status.platform !== 'android') { void invoke('open_lens').catch(showError); return; }
  openingScreenLens = true;
  updateControls();
  void (async () => {
    await camera?.close();
    await invoke('start_screen_lens', { target: target.value });
  })().catch(showError).finally(() => { openingScreenLens = false; updateControls(); });
});
element('setup-open').addEventListener('click', openSettings);
element('settings-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  stopShortcutRecording();
  shortcutDraft = currentShortcut().binding;
  renderShortcut();
});
shortcutAction.addEventListener('change', () => {
  stopShortcutRecording();
  shortcutDraft = currentShortcut().binding;
  shortcutMessage.textContent = status.shortcutSupported && !currentShortcut().available ? 'このキーを登録できませんでした。別のキーを設定してください。' : '';
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
shortcutReset.addEventListener('click', () => { void saveShortcut(currentShortcut().default); });
shortcutPopup.addEventListener('change', async () => {
  savingPopup = true;
  shortcutMessage.textContent = '';
  renderShortcut();
  try {
    status = await invoke<AppStatus>('set_shortcut_popup', { enabled: shortcutPopup.checked });
  } catch (error) {
    shortcutMessage.textContent = String(error);
  } finally {
    savingPopup = false;
    renderShortcut();
  }
});
downloadButton.addEventListener('click', () => { void download(); });
modelSelect.addEventListener('change', () => { void selectModel(); });
preloadModel.addEventListener('change', () => {
  try { localStorage.setItem('preload-model', String(preloadModel.checked)); } catch { /* Optional preference. */ }
  prepareEngine();
});
autoDirection.addEventListener('change', () => {
  try { localStorage.setItem('auto-direction', String(autoDirection.checked)); } catch { /* Optional preference. */ }
});
element('download-cancel').addEventListener('click', () => { void cancel(); });
element('license-link').addEventListener('click', async () => {
  try {
    if (isDesktop) await invoke('open_model_license');
    else window.open('https://plamo.preferredai.jp/info/plamo-community-license-ja', '_blank', 'noopener,noreferrer');
  } catch (error) { element('download-message').textContent = String(error); }
});
element('quit-button').addEventListener('click', () => { void invoke('quit_app').catch(showError); });
document.addEventListener('keydown', event => {
  if (lens || lensSelect) return;
  if (element<HTMLDialogElement>('camera-dialog').open || documents?.active) return;
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
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !dialog.open && !dictionaryDialog.open) {
    event.preventDefault();
    void translate();
  }
  if (event.key === 'Escape' && !dialog.open && !dictionaryDialog.open) {
    event.preventDefault();
    if (busy || cancelling) void cancel();
    else if (isDesktop && status.platform !== 'android') {
      pendingSelection = null;
      selectionGeneration++;
      void invoke('hide_window').catch(showError);
    }
  }
});

async function init(): Promise<void> {
  if (popup) element('ocr-settings').hidden = true;
  else initOcrSettings();
  if (popup) element('update-section').hidden = true;
  else initUpdate();
  if (popup) setReadingMode(true);
  updateControls();
  renderShortcut();
  if (!isDesktop) {
    element('setup-banner').hidden = false;
    element('setup-heading').textContent = '画面プレビュー';
    element('setup-banner').querySelector('p')!.textContent = '翻訳・モデル取得・ショートカットはアプリで利用できます。';
    downloadButton.disabled = true;
    dictionaryButton.hidden = true;
    element<HTMLButtonElement>('quit-button').disabled = true;
    return;
  }
  try {
    if (!popup) documents = initDocument(() => status.platform !== 'android' && !busy && !cancelling && !downloading && !changingModel && !camera?.active && !dialog.open && !dictionaryDialog.open);
    if (!popup) camera = initCamera((text, language) => {
      setReadingMode(false);
      source.value = text;
      target.value = language;
      resetResult();
      void translate();
    });
    await window.__TAURI__!.event.listen('translation-model-changed', () => {
      void refreshStatus().catch(showError);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (status.platform === 'android') camera?.suspend();
      else void camera?.close();
    });
    await onClipboardRequest(() => {
      if (!initialized) return;
      if (documents?.active) void documents.close().then(takePending).catch(showError);
      else if (camera?.active) void camera.close().then(takePending).catch(showError);
      else void takePending().catch(showError);
    });
    await onWindowHidden(() => {
      void documents?.close();
      if (status.platform === 'android') camera?.suspend();
      else void camera?.close();
      dialog.close();
      if (popup) {
        pendingSelection = null;
        selectionGeneration++;
        popupRequest = null;
        popupTerminal = false;
      }
    });
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

if (lensSelect) void initLensSelect();
else if (lens) void initLens();
else void init();
