import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const script = html.match(/<script[^>]+src="([^"]+)"/)[1];
const bundle = readFileSync(new URL(`../dist${script}`, import.meta.url), 'utf8');

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('UI did not reach the expected state');
}

async function fixture(t, options = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: `http://localhost/${options.lensSelect ? '?lens-select' : options.lens ? '?lens' : options.popup ? '?popup' : ''}`, runScripts: 'outside-only', virtualConsole: console });
  const { window } = dom;
  const frames = [];
  window.requestAnimationFrame = callback => { if (options.manualFrames) frames.push(callback); else queueMicrotask(() => callback(0)); return 0; };
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (options.lens && !options.autoLens) window.localStorage.setItem('lens-auto', 'false');
  const lensTimers = new Map();
  let lensTimerId = 0;
  let lensDelay;
  if (options.autoLens || options.camera) {
    window.setTimeout = (callback, delay) => { lensDelay = delay; const id = ++lensTimerId; lensTimers.set(id, callback); return id; };
    window.clearTimeout = id => lensTimers.delete(id);
  }
  if (options.preload !== undefined) window.localStorage.setItem('preload-model', String(options.preload));
  if (options.autoDirection !== undefined) window.localStorage.setItem('auto-direction', String(options.autoDirection));
  if (options.target) window.localStorage.setItem('target-language', options.target);
  let now = 0;
  if (options.manualClock || options.camera) window.performance.now = () => now;
  const byId = id => window.document.getElementById(id);
  const cameraStreams = [];
  const cameraRequests = [];
  const cameraEncodings = [];
  let cameraPixel = 0;
  let finishCamera;
  let finishCameraRead;
  if (options.camera) {
    Object.defineProperty(window.document, 'hidden', { configurable: true, value: false });
    window.localStorage.setItem('camera-auto', String(!!options.autoCamera));
    Object.defineProperties(byId('camera-video'), { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
    byId('camera-video').play = async () => {};
    window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, resetTransform() {}, getImageData() { return { data: new window.Uint8ClampedArray(64 * 48 * 4).fill(cameraPixel) }; } });
    window.HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('Synchronous camera encoding blocks the UI'); };
    window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      const finish = () => callback(options.cameraEncodeNull ? null : new window.Blob(['test'], { type }));
      cameraEncodings.push({ width: this.width, height: this.height, type, finish });
      if (!options.holdCameraEncode) finish();
    };
    Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: async constraints => {
      cameraRequests.push(constraints);
      if (options.cameraError) throw new window.DOMException('Denied', options.cameraError);
      const track = Object.assign(new window.EventTarget(), { stopped: 0, stop() { this.stopped++; } });
      const stream = { getTracks: () => [track], track };
      cameraStreams.push(stream);
      if (options.holdCamera) return new Promise(resolve => { finishCamera = () => resolve(stream); });
      return stream;
    } } });
  }
  const captureResult = result => result.kind !== 'text' ? result : {
    ...result, blocks: (result.blocks ?? (result.text.trim() ? [{ text: result.text, x: .1, y: .2, width: .6, height: .1 }] : []))
      .map(block => ({ ...block, regions: block.regions ?? [{ x: block.x, y: block.y, width: block.width, height: block.height }] })),
  };
  byId('lens-region').getBoundingClientRect = () => ({ x: 1, y: 49, width: 638, height: 340 });
  byId('lens-status').parentElement.getBoundingClientRect = () => ({ height: 18 });
  // JSDOM does not implement native dialog presentation. Its open state is enough for these tests.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [];
  const listeners = new Map();
  const state = {
    modelId: '0.8b-q4',
    models: [
      { id: '0.8b-q2', name: '最小 · 0.8B Q2_K', description: '容量優先。精度が下がります。', size: 410138816, ready: false },
      { id: '0.8b-q3', name: '軽量 · 0.8B Q3_K_M', description: '軽量', size: 486385856, ready: false },
      { id: '0.8b-q4', name: '標準 · 0.8B Q4_K_M', description: '標準', size: 573126848, ready: options.modelReady ?? true },
      { id: '2b-q4', name: '品質重視 · 2B Q4_K_M', description: 'メモリ使用量と待ち時間が増えます。', size: 1807203040, ready: false },
    ],
    modelReady: options.modelReady ?? true, runtimeAvailable: true,
    shortcutAvailable: true, wayland: false, resident: true,
    shortcut: 'Ctrl+Shift+KeyJ', defaultShortcut: 'Ctrl+Shift+KeyJ', shortcutSupported: true, shortcutPopup: false,
    lensShortcut: 'Ctrl+Shift+KeyL', defaultLensShortcut: 'Ctrl+Shift+KeyL', lensShortcutAvailable: true, lensPassthrough: false,
    lensOpenShortcut: 'Ctrl+Shift+KeyO', defaultLensOpenShortcut: 'Ctrl+Shift+KeyO', lensOpenShortcutAvailable: true,
    lensSupported: !!options.lens, ocrAvailable: true, lensUsesSelection: false,
    ...options.status,
  };
  let clipboard = options.clipboard ?? 'Hello, world.';
  let dictionary = options.dictionary ? options.dictionary.map(entry => ({ ...entry })) : [];
  let request = 1;
  let pending = options.pending ? { request, ...options.pending } : null;
  let rejectOperation;
  let finishOperation;
  let channel;
  let finishClipboard;
  let finishCancellation;
  let finishPending;
  let finishRecording;
  let finishCapture;
  const statusRequests = [];
  const channels = [];
  let korean = { ready: false, enabled: false, ...options.korean };
  const native = {
    core: {
      Channel: class { onmessage = () => {}; },
      invoke: async (command, args) => {
        calls.push({ command, args });
        switch (command) {
          case 'get_status': {
            const status = { ...state };
            if (options.holdStatus) return new Promise(resolve => { statusRequests.push(() => resolve(status)); });
            return status;
          }
          case 'get_korean_ocr': return { ...korean };
          case 'set_korean_ocr':
            if (options.koreanError) throw options.koreanError;
            korean.enabled = args.enabled;
            return { ...korean };
          case 'remove_korean_ocr': korean = { ready: false, enabled: false }; return { ...korean };
          case 'download_korean_ocr':
            channel = args.onEvent;
            return new Promise((resolve, reject) => {
              finishOperation = () => { korean = { ready: true, enabled: true }; resolve({ ...korean }); };
              rejectOperation = reject;
            });
          case 'check_update':
            if (options.updateError) throw options.updateError;
            return options.updateVersion ?? null;
          case 'install_update':
            args.onEvent.onmessage({ kind: 'download', received: 50, total: 100 });
            if (options.installError) throw options.installError;
            args.onEvent.onmessage({ kind: 'installing' });
            return;
          case 'open_lens': return;
          case 'start_screen_lens':
            if (options.screenLensError) throw options.screenLensError;
            return;
          case 'apply_lens_selection': return !!options.selectedLens;
          case 'confirm_lens_selection': return;
          case 'set_lens_passthrough':
            if (options.passthroughError) throw options.passthroughError;
            state.lensPassthrough = args.enabled;
            listeners.get('lens-passthrough-changed')?.({ payload: args.enabled });
            return args.enabled;
          case 'capture_lens':
            if (options.captureError) throw options.captureError;
            if (options.holdCapture) return new Promise(resolve => { finishCapture = resolve; });
            return captureResult(options.captureResults?.shift() ?? { kind: 'text', text: options.ocrText ?? 'Text in an image.' });
          case 'recognize_camera': {
            if (options.cameraReadError) throw options.cameraReadError;
            const blocks = options.cameraBlocks ?? [{ text: 'Hello, world.', x: .1, y: .2, width: .6, height: .1 }];
            if (options.holdCameraRead) return new Promise((resolve, reject) => { finishCameraRead = () => resolve(blocks); rejectOperation = reject; });
            return blocks;
          }
          case 'set_shortcut_recording':
            if (args.recording && options.holdRecording) return new Promise(resolve => { finishRecording = resolve; });
            return;
          case 'set_shortcut':
            if (options.shortcutError) throw options.shortcutError;
            if (args.lensOpen) { state.lensOpenShortcut = args.shortcut; state.lensOpenShortcutAvailable = true; }
            else if (args.lens) { state.lensShortcut = args.shortcut; state.lensShortcutAvailable = true; }
            else { state.shortcut = args.shortcut; state.shortcutAvailable = true; }
            return { ...state };
          case 'set_shortcut_popup':
            if (options.popupError) throw options.popupError;
            state.shortcutPopup = args.enabled;
            return { ...state };
          case 'get_dictionary': return dictionary;
          case 'set_dictionary':
            if (options.dictionaryError) throw options.dictionaryError;
            dictionary = args.entries;
            return dictionary;
          case 'prepare_engine':
            if (options.prepareError) throw options.prepareError;
            return;
          case 'read_clipboard':
            if (options.holdClipboard) return new Promise(resolve => { finishClipboard = resolve; });
            return clipboard;
          case 'write_clipboard': clipboard = args.text; return;
          case 'take_pending_clipboard': {
            const value = pending; pending = null;
            if (options.holdPending) return new Promise(resolve => { finishPending = () => resolve(value); });
            return value;
          }
          case 'translate':
            channel = args.onEvent;
            channels.push(channel);
            channel.onmessage({ kind: 'loading' });
            if (options.holdTranslation) return new Promise((resolve, reject) => { finishOperation = resolve; rejectOperation = reject; });
            if (options.translationOutputs?.length) {
              channel.onmessage({ kind: 'token', text: options.translationOutputs.shift() });
              return { truncated: !!options.truncated };
            }
            channel.onmessage({ kind: 'token', text: 'こんにちは、' });
            channel.onmessage({ kind: 'token', text: '世界。' });
            return { truncated: !!options.truncated };
          case 'set_translation_model':
            if (options.modelError) throw options.modelError;
            state.modelId = args.id;
            state.modelReady = state.models.find(model => model.id === args.id).ready;
            listeners.get('translation-model-changed')?.({ payload: null });
            return;
          case 'download_model':
            channel = args.onEvent;
            return new Promise((resolve, reject) => {
              finishOperation = () => { state.modelReady = true; state.models.find(model => model.id === state.modelId).ready = true; resolve(); };
              rejectOperation = reject;
            });
          case 'cancel_operation':
            if (options.cancelError) throw options.cancelError;
            if (options.holdCancellation) return new Promise(resolve => { finishCancellation = resolve; });
            rejectOperation?.('CANCELLED'); return;
          case 'hide_window': case 'quit_app': case 'open_model_license': case 'finish_popup_request': return;
          default: throw new Error(`Unexpected command: ${command}`);
        }
      },
    },
    event: { listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); } },
  };
  if (!options.browser) window.__TAURI__ = native;
  window.eval(bundle);
  await until(() => options.browser || options.lensSelect || calls.some(call => call.command === (options.lens ? 'apply_lens_selection' : 'take_pending_clipboard')));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  return {
    window, byId, calls, state, channels,
    cameraStreams, cameraRequests, cameraEncodings,
    finishCameraEncode(index = cameraEncodings.length - 1) { cameraEncodings[index].finish(); },
    finishCamera() { finishCamera(); },
    finishCameraRead() { finishCameraRead(); },
    cameraFrame(value) { cameraPixel = value; },
    paint() { frames.splice(0).forEach(callback => callback(0)); },
    advance(milliseconds) { now += milliseconds; },
    input(text) { byId('source').value = text; byId('source').dispatchEvent(new window.Event('input')); },
    click(id) { byId(id).focus(); byId(id).click(); },
    async record() { byId('shortcut-record').focus(); byId('shortcut-record').click(); await until(() => byId('shortcut-record').getAttribute('aria-pressed') === 'true'); },
    key(code, modifiers = {}) {
      const event = new window.KeyboardEvent('keydown', { code, key: code.replace(/^Key/, ''), bubbles: true, cancelable: true, ...modifiers });
      window.document.dispatchEvent(event);
      return event;
    },
    send(event) { channel.onmessage(event); },
    finish(value) { finishOperation(value); },
    fail(error) { rejectOperation(error); },
    clipboard: () => clipboard,
    finishClipboard(text) { finishClipboard(text); },
    finishCancellation() { finishCancellation(); },
    finishPending() { finishPending(); },
    finishRecording() { finishRecording(); },
    finishCapture(text) { finishCapture(captureResult({ kind: 'text', text })); },
    finishStatus() { statusRequests.shift()(); },
    async tickLens() {
      const pending = [...lensTimers.values()]; lensTimers.clear();
      pending.forEach(callback => callback());
      await new Promise(resolve => setTimeout(resolve, 5));
    },
    lensDelay: () => lensDelay,
    showWindow() { listeners.get('window-shown')?.({ payload: null }); },
    modelChanged() { listeners.get('translation-model-changed')?.({ payload: null }); },
    ocrChanged() { listeners.get('ocr-settings-changed')?.({ payload: null }); },
    passthrough(enabled) { state.lensPassthrough = enabled; listeners.get('lens-passthrough-changed')?.({ payload: enabled }); },
    lensShortcutChanged() { listeners.get('lens-shortcut-changed')?.({ payload: null }); },
    moveLens() { listeners.get('lens-changed')?.({ payload: null }); },
    shortcutPressed(shortcut) { listeners.get('shortcut-pressed')?.({ payload: shortcut }); },
    closeWindow() { listeners.get('window-hidden')?.({ payload: null }); },
    request(text, selection = true) { pending = { text, selection, request: ++request }; listeners.get('clipboard-request')?.({ payload: null }); return request; },
    requestError(error) { pending = { text: null, error, request: ++request }; listeners.get('clipboard-request')?.({ payload: null }); return request; },
  };
}

test('browser preview clearly disables translation and model download', async t => {
  const f = await fixture(t, { browser: true });
  f.input('Test');
  assert.equal(f.byId('setup-heading').textContent, '画面プレビュー');
  assert.equal(f.byId('shortcut-record').disabled, true);
  assert.equal(f.byId('shortcut-popup').disabled, true);
  assert.equal(f.byId('translate-button').disabled, true);
  assert.equal(f.byId('dictionary-button').hidden, true);
  f.click('setup-open');
  assert.equal(f.byId('settings-dialog').open, true);
  assert.equal(f.byId('download-button').disabled, true);
  assert.equal(f.byId('update-button').disabled, true);
  assert.equal(f.calls.length, 0);
});

test('model selection downloads only the chosen weights and reuses installed models', async t => {
  const f = await fixture(t);
  const select = f.byId('translation-model');
  assert.equal(select.value, '0.8b-q4');
  assert.equal(select.options.length, 4);
  const choose = id => { select.value = id; select.dispatchEvent(new f.window.Event('change')); };
  choose('2b-q4');
  await until(() => !select.disabled && f.state.modelId === '2b-q4');
  assert.equal(f.byId('download-section').hidden, false);
  assert.match(f.byId('setup-banner').textContent, /1\.81 GB/);
  assert.equal(f.byId('camera-button').disabled, true);
  assert.equal(f.calls.some(call => call.command === 'download_model'), false);
  f.click('download-button');
  assert.equal(select.disabled, true);
  choose('0.8b-q2');
  assert.equal(select.value, '2b-q4');
  f.finish();
  await until(() => !select.disabled && f.byId('download-section').hidden);
  assert.equal(f.byId('camera-button').disabled, false);
  choose('0.8b-q4');
  await until(() => !select.disabled && f.state.modelId === '0.8b-q4');
  assert.equal(f.byId('download-section').hidden, true);
  choose('2b-q4');
  await until(() => !select.disabled && f.state.modelId === '2b-q4');
  assert.equal(f.byId('download-section').hidden, true);
  assert.equal(f.calls.filter(call => call.command === 'download_model').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 4);
});

test('failed model changes retain the active model and show the reason', async t => {
  const f = await fixture(t, { modelError: 'OCRレンズを閉じてからモデルを変更してください。' });
  const select = f.byId('translation-model');
  select.value = '0.8b-q3';
  select.dispatchEvent(new f.window.Event('change'));
  await until(() => !select.disabled);
  assert.equal(select.value, '0.8b-q4');
  assert.equal(f.state.modelReady, true);
  assert.match(f.byId('download-message').textContent, /レンズを閉じて/);
});

test('model changes are blocked while translating and reflected across windows', async t => {
  const f = await fixture(t, { holdTranslation: true });
  f.input('Hello'); f.click('translate-button');
  await until(() => f.channels.length === 1);
  assert.equal(f.byId('translation-model').disabled, true);
  f.send({ kind: 'token', text: '古いモデルの訳文' });
  f.finish({ truncated: false });
  await until(() => !f.byId('translation-model').disabled);
  f.state.modelId = '0.8b-q3';
  f.state.modelReady = false;
  f.modelChanged();
  await until(() => f.byId('translation-model').value === '0.8b-q3');
  assert.equal(f.byId('translation').textContent, '');
  assert.equal(f.byId('download-section').hidden, false);
});

test('updates are checked only on request and installed only after the second click', async t => {
  const f = await fixture(t, { updateVersion: '0.2.2' });
  f.click('settings-button');
  assert.equal(f.calls.some(call => call.command === 'check_update'), false);
  f.click('update-button');
  await until(() => !f.byId('update-button').disabled);
  assert.match(f.byId('update-message').textContent, /0\.2\.2/);
  assert.equal(f.calls.some(call => call.command === 'install_update'), false);
  assert.equal(f.byId('update-button').textContent, '更新して再起動');
  f.click('update-button');
  f.click('update-button');
  await until(() => f.byId('update-message').textContent === '再起動中…');
  assert.equal(f.calls.filter(call => call.command === 'install_update').length, 1);
  assert.equal(f.byId('update-button').disabled, true);
});

test('an update failure leaves a retry and requires a new check before installation', async t => {
  const f = await fixture(t, { updateVersion: '0.2.2', installError: '署名を検証できませんでした' });
  f.click('update-button');
  await until(() => !f.byId('update-button').disabled);
  f.click('update-button');
  await until(() => !f.byId('update-button').disabled);
  assert.match(f.byId('update-message').textContent, /署名/);
  assert.equal(f.byId('update-button').textContent, '更新を確認');
  f.click('update-button');
  await until(() => !f.byId('update-button').disabled);
  assert.equal(f.calls.filter(call => call.command === 'check_update').length, 2);
  assert.equal(f.calls.filter(call => call.command === 'install_update').length, 1);
});

test('missing updates and network errors do not offer installation', async t => {
  for (const options of [{}, { updateError: '接続できませんでした' }]) {
    const f = await fixture(t, options);
    f.click('update-button');
    await until(() => !f.byId('update-button').disabled);
    assert.equal(f.byId('update-message').textContent, options.updateError ?? '最新バージョンです。');
    assert.equal(f.byId('update-button').textContent, '更新を確認');
  }
  const popup = await fixture(t, { popup: true });
  assert.equal(popup.byId('update-section').hidden, true);
});

test('shortcut recording saves a key combination through the native settings command', async t => {
  const f = await fixture(t);
  f.input('Keep this original');
  f.click('settings-button');
  await f.record();
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'true');
  const event = f.key('KeyT', { ctrlKey: true, altKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Alt + T');
  assert.equal(f.byId('shortcut-save').disabled, false);
  assert.equal(f.calls.some(call => call.command === 'set_shortcut'), false);
  f.click('shortcut-save');
  await until(() => f.byId('shortcut-message').textContent === '保存しました');
  assert.equal(f.calls.find(call => call.command === 'set_shortcut').args.shortcut, 'Ctrl+Alt+KeyT');
  assert.equal(f.byId('source').value, 'Keep this original');
  f.click('settings-close');
  f.click('settings-button');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Alt + T');
  assert.equal(f.byId('shortcut-save').disabled, true);
});

test('recording rejects typing keys, allows function keys, and Escape cancels without hiding the app', async t => {
  const f = await fixture(t);
  f.click('settings-button');
  await f.record();
  f.key('KeyA', { shiftKey: true });
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'true');
  assert.match(f.byId('shortcut-message').textContent, /組み合わせ/);
  f.key('Escape');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
  assert.equal(f.byId('settings-dialog').open, true);
  assert.equal(f.calls.some(call => call.command === 'hide_window'), false);
  await f.record();
  f.key('F8');
  f.click('shortcut-save');
  await until(() => f.state.shortcut === 'F8');
});

test('shortcut conflicts preserve the active binding and keep the candidate available to edit', async t => {
  const f = await fixture(t, { shortcutError: 'このキーは使われています。' });
  f.click('settings-button');
  await f.record();
  f.key('KeyT', { ctrlKey: true });
  f.click('shortcut-save');
  await until(() => f.byId('shortcut-message').textContent.includes('使われています'));
  assert.equal(f.state.shortcut, 'Ctrl+Shift+KeyJ');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + T');
  assert.equal(f.byId('shortcut-save').disabled, false);
  f.click('settings-close');
  f.click('settings-button');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
});

for (const closing of ['settings', 'window']) {
test(`closing ${closing} while native recording starts clears capture after the request settles`, async t => {
  const f = await fixture(t, { holdRecording: true });
  f.click('settings-button');
  f.click('shortcut-record');
  if (closing === 'window') f.closeWindow();
  else f.click('settings-close');
  f.finishRecording();
  await until(() => f.calls.some(call => call.command === 'set_shortcut_recording' && call.args.recording === false));
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'false');
  f.shortcutPressed('Ctrl+Shift+KeyJ');
  assert.equal(f.byId('settings-dialog').open, false);
});
}

test('modified Tab and Escape can be recorded without dismissing settings', async t => {
  const f = await fixture(t);
  f.click('settings-button');
  for (const code of ['Tab', 'Escape']) {
    await f.record();
    assert.equal(f.key(code, { ctrlKey: true, altKey: true }).defaultPrevented, true);
    assert.equal(f.byId('shortcut-display').textContent, `Ctrl + Alt + ${code}`);
    assert.equal(f.byId('settings-dialog').open, true);
  }
});

test('the current OS-registered shortcut can be recorded and is ignored outside recording', async t => {
  const f = await fixture(t);
  f.click('settings-button');
  await f.record();
  f.byId('shortcut-record').dispatchEvent(new f.window.FocusEvent('blur'));
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'true');
  f.shortcutPressed('Ctrl+Shift+KeyJ');
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'false');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
  assert.equal(f.byId('shortcut-save').disabled, true);
  await f.record();
  f.key('KeyT', { ctrlKey: true });
  f.shortcutPressed('Ctrl+Shift+KeyJ');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + T');
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
  await f.record();
  f.byId('preload-model').focus();
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'false');
});

test('saved shortcuts are displayed on startup and can be reset to the platform default', async t => {
  const f = await fixture(t, { status: { shortcut: 'Alt+KeyY' } });
  f.click('settings-button');
  assert.equal(f.byId('shortcut-display').textContent, 'Alt + Y');
  f.click('shortcut-reset');
  await until(() => f.byId('shortcut-message').textContent === '保存しました');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
  assert.equal(f.byId('shortcut-reset').disabled, true);
});

test('an unavailable shortcut can be retried without changing its keys', async t => {
  const f = await fixture(t, { status: { shortcutAvailable: false } });
  f.click('settings-button');
  assert.equal(f.byId('shortcut-save').disabled, false);
  f.click('shortcut-save');
  await until(() => f.state.shortcutAvailable);
  assert.equal(f.byId('shortcut-save').disabled, true);
});

test('separate shortcut windows are off by default and persist only after native settings succeed', async t => {
  const f = await fixture(t);
  assert.equal(f.byId('shortcut-popup').checked, false);
  f.click('settings-button');
  f.click('shortcut-popup');
  await until(() => !f.byId('shortcut-popup').disabled);
  assert.equal(f.state.shortcutPopup, true);
  assert.equal(f.byId('shortcut-popup').checked, true);
  assert.deepEqual(f.calls.filter(call => call.command === 'set_shortcut_popup').map(call => call.args.enabled), [true]);
  f.click('shortcut-popup');
  await until(() => !f.byId('shortcut-popup').disabled);
  assert.equal(f.state.shortcutPopup, false);
  f.state.shortcutPopup = true;
  f.click('settings-close');
  f.click('settings-button');
  await until(() => f.byId('shortcut-popup').checked);
});

test('failed popup settings restore the saved option and report the error', async t => {
  const f = await fixture(t, { popupError: '設定を保存できませんでした。', status: { shortcutPopup: true } });
  assert.equal(f.byId('shortcut-popup').checked, true);
  f.click('shortcut-popup');
  await until(() => !f.byId('shortcut-popup').disabled);
  assert.equal(f.byId('shortcut-popup').checked, true);
  assert.equal(f.state.shortcutPopup, true);
  assert.equal(f.byId('shortcut-message').textContent, '設定を保存できませんでした。');
});

test('the dictionary dialog loads saved entries and persists additions through the native command', async t => {
  const f = await fixture(t, { dictionary: [{ term: 'dragon', replacement: 'りゅう', enabled: true }] });
  assert.equal(f.byId('dictionary-button').hidden, false);
  f.click('dictionary-button');
  await until(() => f.byId('dictionary-dialog').open);
  assert.equal(f.byId('dictionary-entries').children.length, 1);
  f.byId('dictionary-term').value = 'PLaMo';
  f.byId('dictionary-replacement').value = 'プラモ';
  f.click('dictionary-add');
  assert.equal(f.byId('dictionary-message').textContent, '');
  assert.equal(f.byId('dictionary-entries').children.length, 2);
  f.click('dictionary-save');
  await until(() => f.byId('dictionary-message').textContent === '保存しました');
  assert.deepEqual(Array.from(f.calls.find(call => call.command === 'set_dictionary').args.entries, entry => ({ ...entry })), [
    { term: 'dragon', replacement: 'りゅう', enabled: true },
    { term: 'PLaMo', replacement: 'プラモ', enabled: true },
  ]);
  f.byId('dictionary-close').click();
  f.click('dictionary-button');
  await until(() => f.byId('dictionary-dialog').open && f.byId('dictionary-entries').children.length === 2);
  const replacement = f.byId('dictionary-entries').querySelector('.dictionary-replacement');
  replacement.value = 'りゅうきち';
  replacement.dispatchEvent(new f.window.Event('input'));
  f.click('dictionary-save');
  await until(() => f.byId('dictionary-message').textContent === '保存しました');
  assert.deepEqual(Array.from(f.calls.findLast(call => call.command === 'set_dictionary').args.entries, entry => ({ ...entry })), [
    { term: 'dragon', replacement: 'りゅうきち', enabled: true },
    { term: 'PLaMo', replacement: 'プラモ', enabled: true },
  ]);
});

test('dictionary drafts reject empty and duplicate terms and deletions only affect the draft', async t => {
  const f = await fixture(t);
  f.click('dictionary-button');
  await until(() => f.byId('dictionary-dialog').open);
  assert.equal(f.byId('dictionary-empty').hidden, false);
  f.click('dictionary-add');
  assert.equal(f.byId('dictionary-message').textContent, '原語を入力してください。');
  f.byId('dictionary-term').value = 'cat';
  f.byId('dictionary-replacement').value = 'ねこ';
  f.click('dictionary-add');
  f.byId('dictionary-term').value = 'cat';
  f.click('dictionary-add');
  assert.equal(f.byId('dictionary-message').textContent, 'この原語は登録済みです。既存の訳語を編集してください。');
  assert.equal(f.byId('dictionary-entries').children.length, 1);
  f.byId('dictionary-entries').querySelector('.dictionary-delete').click();
  assert.equal(f.byId('dictionary-entries').children.length, 0);
  assert.equal(f.byId('dictionary-empty').hidden, false);
  assert.equal(f.calls.some(call => call.command === 'set_dictionary'), false);
});

test('dictionary Enter registration waits for Japanese conversion to settle', async t => {
  const f = await fixture(t);
  f.click('dictionary-button');
  await until(() => f.byId('dictionary-dialog').open);
  f.byId('dictionary-term').value = 'りゅう';
  f.byId('dictionary-replacement').value = 'dragon';
  const keydown = (init = {}) => f.byId('dictionary-term').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  // The Enter that confirms the conversion is marked composing and must not register.
  keydown({ isComposing: true, keyCode: 229 });
  assert.equal(f.byId('dictionary-entries').children.length, 0);
  // WebKit reports the committing Enter as a plain keydown after compositionend.
  f.byId('dictionary-term').dispatchEvent(new f.window.Event('compositionend'));
  keydown();
  assert.equal(f.byId('dictionary-entries').children.length, 0);
  // The second Enter registers the term.
  await new Promise(resolve => setTimeout(resolve, 2));
  keydown();
  await until(() => f.byId('dictionary-entries').children.length === 1);
  assert.deepEqual(Array.from(f.byId('dictionary-entries').children, row => row.querySelector('.dictionary-term').textContent), ['りゅう']);
});

test('dictionary save failures are reported and the draft stays editable', async t => {
  const f = await fixture(t, { dictionaryError: '辞書を保存できませんでした。' });
  f.click('dictionary-button');
  await until(() => f.byId('dictionary-dialog').open);
  f.byId('dictionary-term').value = 'dragon';
  f.byId('dictionary-replacement').value = 'りゅう';
  f.click('dictionary-add');
  f.click('dictionary-save');
  await until(() => f.byId('dictionary-message').textContent === '辞書を保存できませんでした。');
  f.byId('dictionary-entries').querySelector('.dictionary-delete').click();
  f.click('dictionary-save');
  await until(() => f.calls.filter(call => call.command === 'set_dictionary').length === 2);
  assert.deepEqual(Array.from(f.calls.at(-1).args.entries, entry => ({ ...entry })), []);
});

test('a shortcut popup becomes dismissible only after its translation has finished', async t => {
  const f = await fixture(t, { popup: true, holdTranslation: true, pending: { text: 'Popup selection', selection: true } });
  await until(() => f.calls.some(call => call.command === 'translate'));
  assert.equal(f.window.document.body.classList.contains('popup'), true);
  assert.equal(f.byId('source-panel').hidden, true);
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  f.send({ kind: 'token', text: '小窓の訳文' });
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  f.finish({ truncated: false });
  await until(() => f.calls.some(call => call.command === 'finish_popup_request'));
  assert.equal(f.calls.find(call => call.command === 'finish_popup_request').args.request, 1);
  assert.equal(f.byId('translation').textContent, '小窓の訳文');
});

test('a newer popup request waits for cancellation and its own result before becoming dismissible', async t => {
  const f = await fixture(t, { popup: true, holdTranslation: true, holdCancellation: true, pending: { text: 'First', selection: true } });
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.request('Second');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  const newest = f.request('Newest');
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  f.fail('CANCELLED');
  await until(() => f.byId('translation-status').textContent === '翻訳を中断しました');
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  f.finishCancellation();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.byId('source').value, 'Newest');
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  f.finish({ truncated: false });
  await until(() => f.calls.some(call => call.command === 'finish_popup_request'));
  assert.deepEqual(f.calls.filter(call => call.command === 'finish_popup_request').map(call => call.args.request), [newest]);
});

test('hiding the popup discards a queued replacement without affecting its next use', async t => {
  const f = await fixture(t, { popup: true, holdTranslation: true, holdCancellation: true, pending: { text: 'First', selection: true } });
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.request('Queued before closing');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  f.closeWindow();
  f.fail('CANCELLED');
  f.finishCancellation();
  await until(() => !f.byId('translate-button').disabled);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  const request = f.request('Selection after reopening');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  f.finish({ truncated: false });
  await until(() => f.calls.some(call => call.command === 'finish_popup_request'));
  assert.equal(f.calls.find(call => call.command === 'finish_popup_request').args.request, request);
});

test('hiding the popup invalidates a selection that is still being read', async t => {
  const f = await fixture(t, { popup: true, holdPending: true, pending: { text: 'Already reading', selection: true } });
  f.closeWindow();
  f.finishPending();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  assert.equal(f.byId('source').value, '');
  f.request('After reopening');
  f.finishPending();
  await until(() => f.calls.some(call => call.command === 'finish_popup_request'));
  assert.equal(f.byId('source').value, 'After reopening');
});

test('popup selection errors become dismissible after an older translation settles', async t => {
  const f = await fixture(t, { popup: true, holdTranslation: true, pending: { text: 'First', selection: true } });
  await until(() => f.calls.some(call => call.command === 'translate'));
  const request = f.requestError('選択文字を取得できませんでした。');
  await until(() => !f.byId('message').hidden);
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
  f.finish({ truncated: false });
  await until(() => f.calls.some(call => call.command === 'finish_popup_request'));
  assert.equal(f.calls.find(call => call.command === 'finish_popup_request').args.request, request);
  assert.equal(f.byId('message').textContent, '選択文字を取得できませんでした。');
});

test('popup requests refresh shared language preferences and model readiness without duplicate preloading', async t => {
  const f = await fixture(t, { popup: true, modelReady: false, target: 'fr' });
  f.state.modelReady = true;
  f.window.localStorage.setItem('target-language', 'de');
  f.window.localStorage.setItem('auto-direction', 'true');
  f.window.localStorage.setItem('preload-model', 'false');
  f.request('日本語の文章');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'en');
  assert.equal(f.byId('preload-model').checked, false);
  assert.equal(f.byId('setup-banner').hidden, true);
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
  f.window.localStorage.setItem('auto-direction', 'false');
  f.request('Another selection');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'de');
  assert.equal(f.window.localStorage.getItem('target-language'), 'de');
});

test('main-window shortcut requests pick up preferences changed in the popup', async t => {
  const f = await fixture(t, { target: 'fr' });
  f.input('Keep this manual draft');
  f.window.localStorage.setItem('target-language', 'de');
  f.window.localStorage.setItem('auto-direction', 'true');
  f.request('日本語の文章');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'en');
  f.window.localStorage.setItem('auto-direction', 'false');
  f.request('Another selection');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'de');
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
});

test('Wayland shows the OS command without offering unsupported shortcut registration', async t => {
  const f = await fixture(t, { status: { wayland: true, shortcutSupported: false, shortcutAvailable: false } });
  f.click('settings-button');
  assert.equal(f.byId('shortcut-record').disabled, true);
  assert.equal(f.byId('shortcut-save').hidden, true);
  assert.equal(f.byId('shortcut-reset').hidden, true);
  assert.equal(f.byId('shortcut-note').textContent, 'anywhere-plamo --translate-selection');
});

test('closing or tabbing away cancels recording and never consumes translation shortcuts', async t => {
  const f = await fixture(t);
  f.input('Hello');
  f.click('settings-button');
  await f.record();
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.byId('shortcut-record').getAttribute('aria-pressed'), 'false');
  await f.record();
  f.key('Enter', { ctrlKey: true });
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Enter');
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
  f.click('settings-close');
  f.click('settings-button');
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
});

test('paste, translate, copy and clear operate on the current text', async t => {
  const f = await fixture(t);
  assert.equal(f.byId('translate-button').disabled, true);
  f.click('paste-button');
  await until(() => f.byId('source').value === 'Hello, world.');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('translation').textContent, 'こんにちは、世界。');
  assert.equal(f.calls.find(call => call.command === 'translate').args.target, 'ja');
  f.click('copy-button');
  await until(() => f.clipboard() === 'こんにちは、世界。');
  f.click('clear-button');
  assert.equal(f.byId('source').value, '');
  assert.equal(f.byId('translation').textContent, '');
  assert.equal(f.byId('copy-button').disabled, true);
});

test('streamed text is plain text, editing is locked, and cancellation restores controls', async t => {
  const f = await fixture(t, { holdTranslation: true });
  f.input('Original');
  f.click('translate-button');
  await until(() => f.calls.some(call => call.command === 'translate'));
  assert.equal(f.byId('source').readOnly, true);
  assert.equal(f.byId('paste-button').disabled, true);
  f.send({ kind: 'token', text: '<img src=x onerror=alert(1)>一部の訳文' });
  assert.equal(f.byId('translation').querySelector('img'), null);
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent === '翻訳を中断しました');
  assert.equal(f.byId('source').readOnly, false);
  assert.equal(f.byId('translate-button').disabled, false);
  assert.equal(f.byId('copy-button').disabled, false);
  assert.equal(f.byId('message').hidden, true);
  f.input('New original');
  assert.equal(f.byId('translation').textContent, '');
});

test('target changes clear stale output and persist only the preference', async t => {
  const f = await fixture(t);
  f.input('A private sentence');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  f.byId('target').value = 'en';
  f.byId('target').dispatchEvent(new f.window.Event('change'));
  assert.equal(f.byId('translation').textContent, '');
  assert.equal(f.window.localStorage.getItem('target-language'), 'en');
  assert.equal(f.window.localStorage.length, 1);
});

test('download cancellation and failure both allow retry; verified success enables translation', async t => {
  const f = await fixture(t, { modelReady: false });
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
  f.click('setup-open');
  f.click('download-button');
  f.send({ kind: 'download', received: 50, total: 100 });
  assert.equal(f.byId('progress-bar').value, 50);
  f.click('download-cancel');
  await until(() => f.byId('download-section').hidden === false);
  assert.match(f.byId('download-message').textContent, /中止/);
  f.click('download-button');
  f.fail('Connection interrupted');
  await until(() => f.byId('download-section').hidden === false);
  assert.equal(f.byId('download-message').textContent, 'Connection interrupted');
  f.click('download-button');
  f.send({ kind: 'verifying' });
  assert.equal(f.byId('download-label').textContent, 'ファイルを確認中…');
  f.finish();
  await until(() => f.byId('model-tag').textContent === '準備完了');
  assert.equal(f.byId('setup-banner').hidden, true);
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
});

test('a pending shortcut request translates after startup status has loaded', async t => {
  const f = await fixture(t, { pending: { text: 'From another application' } });
  await until(() => f.calls.some(call => call.command === 'translate'));
  assert.equal(f.byId('source').value, 'From another application');
  assert.equal(f.byId('settings-dialog').open, false);
  assert.equal(f.window.document.body.classList.contains('popup'), false);
  assert.equal(f.calls.some(call => call.command === 'finish_popup_request'), false);
});

test('automatic direction is off by default and preserves the selected language', async t => {
  const f = await fixture(t, { target: 'fr' });
  assert.equal(f.byId('auto-direction').checked, false);
  for (const text of ['日本語です。', 'English text.']) {
    const count = f.calls.filter(call => call.command === 'translate').length;
    f.request(text);
    await until(() => f.calls.filter(call => call.command === 'translate').length > count);
    assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'fr');
  }
});

test('automatic direction switches selected Japanese and English without changing the manual preference', async t => {
  const f = await fixture(t, { autoDirection: true, target: 'fr' });
  assert.equal(f.byId('auto-direction').checked, true);
  for (const [text, language] of [
    ['日本語の文章です。', 'en'], ['翻訳', 'en'], ['AIで翻訳する', 'en'], ['ｶﾀｶﾅ', 'en'],
    ['Hello, world.', 'ja'], ['123!? 😀', 'fr'], ['Привет world', 'fr'],
  ]) {
    const count = f.calls.filter(call => call.command === 'translate').length;
    f.request(text);
    await until(() => f.calls.filter(call => call.command === 'translate').length > count);
    assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, language);
    assert.equal(f.byId('target').value, language);
    assert.equal(f.window.localStorage.getItem('target-language'), 'fr');
  }
});

test('automatic direction never applies to pasted text, manual edits, or tray clipboard requests', async t => {
  const f = await fixture(t, { autoDirection: true, target: 'fr', clipboard: '日本語のクリップボード' });
  f.request('日本語の選択');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('target').value, 'en');
  f.click('edit-source');
  f.input('Manual English');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'fr');
  f.request('Another selection');
  await until(() => f.byId('target').value === 'ja');
  f.click('paste-button');
  await until(() => f.byId('source').value === '日本語のクリップボード');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'fr');
  f.request('日本語のトレイ操作', false);
  await until(() => f.byId('source').value === '日本語のトレイ操作');
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'fr');
});

test('automatic direction preference persists and applies to the latest queued selection', async t => {
  const f = await fixture(t, { holdTranslation: true, holdCancellation: true, target: 'fr' });
  f.click('auto-direction');
  assert.equal(f.window.localStorage.getItem('auto-direction'), 'true');
  f.input('Manual text');
  f.click('translate-button');
  f.request('日本語です。');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  f.request('Newest English text');
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  f.fail('CANCELLED');
  f.finishCancellation();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  const latest = f.calls.filter(call => call.command === 'translate').at(-1).args;
  assert.equal(latest.text, 'Newest English text');
  assert.equal(latest.target, 'ja');
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  f.click('auto-direction');
  assert.equal(f.window.localStorage.getItem('auto-direction'), 'false');
  f.request('日本語です。');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 3);
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'fr');
});

test('oversized clipboard input is rejected without truncating the existing original', async t => {
  const f = await fixture(t, { clipboard: 'x'.repeat(12001) });
  f.input('Keep this original');
  f.click('paste-button');
  await until(() => !f.byId('message').hidden);
  assert.equal(f.byId('source').value, 'Keep this original');
  assert.match(f.byId('message').textContent, /12,000/);
});

test('length-limited output is explicitly marked incomplete', async t => {
  const f = await fixture(t, { truncated: true });
  f.input('Some text');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent === '訳文が途中で止まりました');
  assert.equal(f.byId('message').hidden, false);
  assert.equal(f.byId('copy-button').disabled, false);
});

test('a delayed clipboard read cannot replace the original during translation', async t => {
  const f = await fixture(t, { holdClipboard: true, holdTranslation: true });
  f.input('Translate this');
  f.click('paste-button');
  f.click('translate-button');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.finishClipboard('Late clipboard result');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.byId('source').value, 'Translate this');
  f.send({ kind: 'token', text: '訳文' });
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('translation').textContent, '訳文');
});

test('a native clipboard error is shown without retrying or translating other clipboard text', async t => {
  const error = 'クリップボードから文章を取得できませんでした。';
  const f = await fixture(t, { pending: { text: null, error } });
  await until(() => f.calls.some(call => call.command === 'take_pending_clipboard'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.byId('message').hidden, false);
  assert.equal(f.byId('message').textContent, error);
  assert.equal(f.calls.some(call => call.command === 'read_clipboard'), false);
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
  assert.equal(f.byId('source').value, '');
});

test('shortcut errors are visible when settings was left open', async t => {
  const f = await fixture(t);
  f.input('Keep this original');
  for (const request of [() => f.requestError('選択文字を取得できませんでした。'), () => f.request('x'.repeat(12001))]) {
    f.click('settings-button');
    request();
    await until(() => !f.byId('settings-dialog').open);
    assert.equal(f.byId('message').hidden, false);
    assert.equal(f.byId('source').value, 'Keep this original');
    assert.equal(f.calls.some(call => call.command === 'translate'), false);
  }
});

test('a failed cancellation leaves the running translation cancellable', async t => {
  const f = await fixture(t, { holdTranslation: true, cancelError: '中断要求を送信できませんでした。' });
  f.input('Original');
  f.click('translate-button');
  f.click('translate-button');
  await until(() => !f.byId('message').hidden);
  assert.equal(f.byId('translate-button').disabled, false);
  assert.equal(f.byId('translate-label').textContent, '中断');
  assert.equal(f.byId('source').readOnly, true);
  f.send({ kind: 'token', text: '訳文' });
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
});

test('translation failure preserves the original and permits retry', async t => {
  const f = await fixture(t, { holdTranslation: true });
  f.input('Retry this');
  f.click('translate-button');
  f.send({ kind: 'token', text: '途切れた訳文' });
  f.fail('翻訳中に接続が切れました。');
  await until(() => f.byId('translation-status').textContent === '翻訳できませんでした');
  assert.equal(f.byId('source').value, 'Retry this');
  assert.equal(f.byId('source').readOnly, false);
  f.click('translate-button');
  assert.equal(f.byId('translation').textContent, '');
  f.send({ kind: 'token', text: '再試行した訳文' });
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('translation').textContent, '再試行した訳文');
  assert.equal(f.byId('message').hidden, true);
});

test('latest shortcut waits for translation and cancellation to settle, ignoring stale streamed text', async t => {
  const f = await fixture(t, { holdTranslation: true, holdCancellation: true });
  f.input('Original');
  f.click('translate-button');
  f.send({ kind: 'token', text: '古い訳文' });
  f.request('Second selection');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  f.request('Newest selection');
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  f.fail('CANCELLED');
  await until(() => f.byId('translation-status').textContent === '翻訳を中断しました');
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.byId('source').readOnly, true);
  f.channels[0].onmessage({ kind: 'token', text: '遅れた古い文字' });
  assert.equal(f.byId('translation').textContent, '古い訳文');
  f.finishCancellation();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'translate')[1].args.text, 'Newest selection');
  assert.equal(f.calls.filter(call => call.command === 'cancel_operation').length, 1);
  assert.equal(f.byId('translation').textContent, '');
  f.channels[0].onmessage({ kind: 'token', text: '遅れた古い文字' });
  f.send({ kind: 'token', text: '最新の訳文' });
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('translation').textContent, '最新の訳文');
});

test('requests during an acknowledged cancellation do not send another cancellation or overlap translations', async t => {
  const f = await fixture(t, { holdTranslation: true, holdCancellation: true });
  f.input('Original');
  f.click('translate-button');
  f.request('Second');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  f.finishCancellation();
  f.request('Newest');
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'cancel_operation').length, 1);
  f.fail('CANCELLED');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.byId('source').value, 'Newest');
});

test('pending reads are serialized and coalesce rapid requests before starting a replacement', async t => {
  const f = await fixture(t, { holdPending: true, holdTranslation: true });
  await until(() => f.calls.some(call => call.command === 'take_pending_clipboard'));
  f.finishPending();
  await new Promise(resolve => setTimeout(resolve, 5));
  f.input('Original');
  f.click('translate-button');
  f.request('Second');
  f.request('Newest');
  assert.equal(f.calls.filter(call => call.command === 'take_pending_clipboard').length, 2);
  f.finishPending();
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  f.finishPending();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.byId('source').value, 'Newest');
});

test('failed replacement cancellation waits for completion and then translates the latest selection', async t => {
  const f = await fixture(t, { holdTranslation: true, cancelError: '中断失敗' });
  f.input('Original');
  f.click('translate-button');
  f.request('Second');
  await until(() => !f.byId('message').hidden);
  assert.match(f.byId('message').textContent, /終わり次第/);
  assert.equal(f.byId('translate-button').disabled, false);
  f.request('Newest');
  await until(() => f.calls.filter(call => call.command === 'cancel_operation').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  f.finish({ truncated: false });
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.byId('source').value, 'Newest');
});

test('manual Escape during replacement cancellation clears the queued translation', async t => {
  const f = await fixture(t, { holdTranslation: true, holdCancellation: true });
  f.input('Original');
  f.click('translate-button');
  f.request('Queued selection');
  await until(() => f.calls.some(call => call.command === 'cancel_operation'));
  f.window.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape' }));
  f.fail('CANCELLED');
  f.finishCancellation();
  await until(() => f.byId('source').readOnly === false);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'cancel_operation').length, 1);
  assert.equal(f.byId('source').value, 'Original');
});

test('invalid and failed selections leave the running translation intact', async t => {
  const f = await fixture(t, { holdTranslation: true });
  f.input('Original');
  f.click('translate-button');
  f.request('😀'.repeat(6001));
  await until(() => !f.byId('message').hidden);
  assert.match(f.byId('message').textContent, /12,000/);
  assert.match(f.byId('message').textContent, /複数文字分/);
  f.requestError('選択文字を取得できませんでした。');
  await until(() => f.byId('message').textContent === '選択文字を取得できませんでした。');
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
  assert.equal(f.byId('source').value, 'Original');
});

test('shortcut reading mode reveals the original accessibly and returns to editing without losing text', async t => {
  const f = await fixture(t, { pending: { text: 'Selected original' } });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.window.document.body.classList.contains('reading-mode'), true);
  assert.equal(f.byId('source-panel').hidden, true);
  assert.equal(f.byId('toggle-original').getAttribute('aria-expanded'), 'false');
  f.click('toggle-original');
  assert.equal(f.byId('source-panel').hidden, false);
  assert.equal(f.byId('toggle-original').getAttribute('aria-expanded'), 'true');
  assert.equal(f.byId('source').readOnly, true);
  f.click('toggle-original');
  assert.equal(f.byId('source-panel').hidden, true);
  f.click('edit-source');
  assert.equal(f.window.document.body.classList.contains('reading-mode'), false);
  assert.equal(f.byId('reading-actions').hidden, true);
  assert.equal(f.byId('source-panel').hidden, false);
  assert.equal(f.byId('source').readOnly, false);
  assert.equal(f.byId('source').value, 'Selected original');
  assert.equal(f.byId('translation').textContent, 'こんにちは、世界。');
  assert.equal(f.window.document.activeElement, f.byId('source'));
});

test('timing records first visible text and completion separately', async t => {
  const f = await fixture(t, { holdTranslation: true, manualClock: true });
  f.input('Original');
  f.click('translate-button');
  f.advance(300);
  f.send({ kind: 'token', text: '' });
  assert.equal(f.byId('translation').hidden, true);
  assert.equal(f.byId('translation-status').title, '');
  f.send({ kind: 'token', text: '\n\n' });
  assert.equal(f.byId('translation-status').title, '');
  f.advance(400);
  f.send({ kind: 'token', text: '訳文' });
  assert.equal(f.byId('translation-status').title, '最初の文字まで 0.7秒');
  f.advance(1200);
  f.send({ kind: 'token', text: 'の続き' });
  f.finish({ truncated: false });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.byId('translation-status').textContent, '1.9秒 · 翻訳完了');
  assert.equal(f.byId('translation-status').title, '最初の文字まで 0.7秒 · 処理終了まで 1.9秒');
});

test('manual cancellation also discards shortcut reads that were already pending', async t => {
  const f = await fixture(t, { holdPending: true, holdTranslation: true });
  await until(() => f.calls.some(call => call.command === 'take_pending_clipboard'));
  f.finishPending();
  await new Promise(resolve => setTimeout(resolve, 5));
  f.input('Original');
  f.click('translate-button');
  f.request('Already reading');
  f.request('Already queued');
  f.window.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape' }));
  await until(() => f.byId('translation-status').textContent === '翻訳を中断しました');
  f.finishPending();
  await until(() => f.calls.filter(call => call.command === 'take_pending_clipboard').length === 3);
  f.finishPending();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.byId('source').value, 'Original');
  f.request('Selection after cancel');
  f.finishPending();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.byId('source').value, 'Selection after cancel');
});

test('background preparation runs once and a failure does not block startup or translation', async t => {
  const f = await fixture(t, { prepareError: 'Preparation failed', pending: { text: 'Selected text' } });
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.byId('message').hidden, true);
  f.click('translate-button');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
});

test('preload opt-out skips preparation and enabling it persists the preference and prepares once', async t => {
  const f = await fixture(t, { preload: false });
  assert.equal(f.byId('preload-model').checked, false);
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
  f.click('preload-model');
  assert.equal(f.window.localStorage.getItem('preload-model'), 'true');
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
  f.click('preload-model');
  assert.equal(f.window.localStorage.getItem('preload-model'), 'false');
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
  f.click('preload-model');
  assert.equal(f.calls.filter(call => call.command === 'prepare_engine').length, 1);
});

test('preload opt-out also applies after downloading without preventing translation', async t => {
  const f = await fixture(t, { preload: false, modelReady: false });
  f.click('setup-open');
  f.click('download-button');
  f.finish();
  await until(() => f.byId('model-tag').textContent === '準備完了');
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
  f.input('Translate on demand');
  f.click('translate-button');
  await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.some(call => call.command === 'prepare_engine'), false);
});

for (const failure of ['read error', 'oversized input']) {
  test(`a newer selection with ${failure} discards an older queued replacement and preserves the error`, async t => {
    const f = await fixture(t, { holdTranslation: true, holdCancellation: true });
    f.input('Original');
    f.click('translate-button');
    f.request('Older queued selection');
    await until(() => f.calls.some(call => call.command === 'cancel_operation'));
    if (failure === 'read error') f.requestError('新しい選択を取得できませんでした。');
    else f.request('x'.repeat(12001));
    await until(() => !f.byId('message').hidden);
    const error = f.byId('message').textContent;
    f.fail('CANCELLED');
    f.finishCancellation();
    await until(() => f.byId('translate-button').disabled === false);
    assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
    assert.equal(f.byId('source').value, 'Original');
    assert.equal(f.byId('message').hidden, false);
    assert.equal(f.byId('message').textContent, error);
  });
}

test('OCR lens entry is available only on supported desktop main windows', async t => {
  const mac = await fixture(t, { status: { lensSupported: true } });
  assert.equal(mac.byId('lens-button').hidden, false);
  mac.click('lens-button');
  await until(() => mac.calls.some(call => call.command === 'open_lens'));
  const linux = await fixture(t, { status: { lensSupported: true, wayland: true } });
  assert.equal(linux.byId('lens-button').hidden, false);
  const unsupported = await fixture(t);
  assert.equal(unsupported.byId('lens-button').hidden, true);
  const popup = await fixture(t, { popup: true, status: { lensSupported: true } });
  assert.equal(popup.byId('lens-button').hidden, true);
});

test('manual lens captures only its viewport on request and translates into the selected language', async t => {
  const f = await fixture(t, { lens: true, target: 'en', ocrText: '画像の文字です。' });
  assert.equal(f.window.document.body.classList.contains('lens-mode'), true);
  assert.equal(f.byId('lens').hidden, false);
  assert.equal(f.byId('lens-target').value, 'en');
  assert.equal(f.calls.some(call => ['capture_lens', 'translate', 'prepare_engine', 'take_pending_clipboard'].includes(call.command)), false);
  f.key('Enter', { metaKey: true });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.deepEqual({ ...f.calls.find(call => call.command === 'capture_lens').args.region }, { x: 1, y: 49, width: 638, height: 340, bottomInset: 19 });
  const request = f.calls.find(call => call.command === 'translate');
  assert.equal(request.args.text, '画像の文字です。');
  assert.equal(request.args.target, 'en');
  assert.equal(f.byId('lens-translation').textContent, 'こんにちは、世界。');
  assert.equal(f.byId('lens-result').hidden, false);
  f.click('lens-original');
  assert.equal(f.byId('lens-result').hidden, true);
  f.click('lens-original');
  assert.equal(f.byId('lens-result').hidden, false);
  f.byId('lens-target').value = 'ja';
  f.byId('lens-target').dispatchEvent(new f.window.Event('change'));
  assert.equal(f.byId('lens-translation').textContent, '');
  assert.equal(f.window.localStorage.getItem('lens-target'), 'ja');
  assert.equal(f.window.localStorage.getItem('target-language'), 'en');
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
});

test('clicking inside the lens toggles the overlay without interfering with text selection', async t => {
  const f = await fixture(t, { lens: true });
  f.click('lens-region');
  assert.equal(f.byId('lens-original').getAttribute('aria-pressed'), 'false');
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  const paragraph = f.byId('lens-translation').querySelector('.lens-block');
  paragraph.click();
  assert.equal(f.byId('lens-result').hidden, true);
  assert.equal(f.byId('lens-original').textContent, '訳文');
  f.click('lens-region');
  assert.equal(f.byId('lens-result').hidden, false);
  const selected = f.window.getSelection();
  const range = f.window.document.createRange();
  range.selectNodeContents(paragraph);
  selected.removeAllRanges();
  selected.addRange(range);
  assert.equal(selected.toString(), paragraph.textContent);
  paragraph.click();
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(selected.toString(), paragraph.textContent);
  selected.removeAllRanges();
  paragraph.dispatchEvent(new f.window.MouseEvent('click', { button: 2, bubbles: true }));
  f.click('lens-status');
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
});

test('unchanged OCR translations are not overlaid or retried on every automatic update', async t => {
  const f = await fixture(t, { lens: true, autoLens: true, translationOutputs: ['  UNREADABLE\nENGLISH. ', '日本語の訳文'], captureResults: [
    { kind: 'text', text: 'Unreadable English.' }, { kind: 'unchanged' },
    { kind: 'changed' }, { kind: 'text', text: 'Unreadable English.' },
    { kind: 'changed' }, { kind: 'text', text: 'A readable sentence.' },
  ] });
  await f.tickLens();
  assert.equal(f.byId('lens-translation').textContent, '');
  assert.equal(f.byId('lens-result').hidden, true);
  assert.equal(f.byId('lens-original').disabled, true);
  assert.equal(f.byId('lens-status').textContent, '自動更新中');
  await f.tickLens();
  assert.equal(f.byId('lens-status').textContent, '自動更新中');
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.byId('lens-translation').textContent, '');
  assert.equal(f.byId('lens-status').textContent, '自動更新中');
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.byId('lens-status').textContent, '自動更新中');
  assert.equal(f.byId('lens-translation').textContent, '日本語の訳文');
});

test('copied prefixes stay hidden until translated text arrives and unchanged blocks remain transparent', async t => {
  const blocks = ['NASA launches a rocket.', '12345'].map((text, index) => ({ text, x: .1, y: .1 + index * .4, width: .5, height: .1 }));
  const f = await fixture(t, { lens: true, holdTranslation: true, captureResults: [{ kind: 'text', text: blocks.map(block => block.text).join('\n\n'), blocks }] });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text: 'NASA' });
  assert.equal(f.byId('lens-result').hidden, true);
  f.send({ kind: 'token', text: 'がロケットを打ち上げます。' });
  await until(() => !f.byId('lens-result').hidden);
  f.finish({ truncated: false });
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  f.send({ kind: 'token', text: '12345' });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-refresh').textContent === '更新');
  assert.match(f.byId('lens-status').textContent, /^更新しました/);
  assert.equal(f.byId('lens-translation').textContent, 'NASAがロケットを打ち上げます。');
  assert.equal(f.byId('lens-original').disabled, false);
});

test('Wayland keeps the captured original accessible even if the model copies every block', async t => {
  const f = await fixture(t, { lens: true, ocrText: 'SOURCE', translationOutputs: ['source'], status: { lensUsesSelection: true, wayland: true } });
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.byId('lens-result').hidden, true);
  assert.equal(f.byId('lens-original').disabled, false);
  f.click('lens-region');
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(f.byId('lens-source').hidden, false);
  assert.equal(f.byId('lens-source').textContent, 'SOURCE');
});

test('lens permission failures, empty OCR and oversized regions leave a retryable transparent view', async t => {
  for (const options of [{ captureError: '画面収録を許可してください。' }, { ocrText: '   ' }, { ocrText: 'a'.repeat(12001) }]) {
    const f = await fixture(t, { lens: true, ...options });
    f.click('lens-refresh');
    await until(() => f.calls.some(call => call.command === 'capture_lens') && f.byId('lens-refresh').textContent === '更新');
    assert.equal(f.byId('lens-refresh').disabled, false);
    assert.equal(f.byId('lens-result').hidden, true);
    assert.equal(f.calls.some(call => call.command === 'translate'), false);
    assert.match(f.byId('lens-status').textContent, /許可|見つかりません|多すぎ/);
  }
});

test('lens anchors paragraphs separately and repositions cached translations without repeating inference', async t => {
  const blocks = [
    { text: 'First paragraph without visual wraps.', x: .1, y: .1, width: .4, height: .1 },
    { text: 'Second paragraph.', x: .1, y: .6, width: .4, height: .1 },
  ];
  const moved = blocks.map(block => ({ ...block, y: block.y + .1 }));
  const f = await fixture(t, { lens: true, autoLens: true, captureResults: [
    { kind: 'text', text: blocks.map(block => block.text).join('\n\n'), blocks },
    { kind: 'changed' },
    { kind: 'text', text: blocks.map(block => block.text).join('\n\n'), blocks: moved },
  ] });
  await f.tickLens();
  assert.deepEqual(f.calls.filter(call => call.command === 'translate').map(call => call.args.text), blocks.map(block => block.text));
  const positions = [...f.byId('lens-translation').querySelectorAll('.lens-block')].map(node => parseFloat(node.style.top));
  assert.equal(positions[1] - positions[0], 170);
  await f.tickLens();
  await f.tickLens();
  const paragraphs = [...f.byId('lens-translation').querySelectorAll('.lens-block')];
  assert.equal(paragraphs.length, 2);
  assert.equal(parseFloat(paragraphs[0].style.top) - positions[0], 34);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 2);
  assert.equal(f.byId('lens-result').hidden, false);
});

test('lens ignores unchanged resize events and stops wheel overscroll without cancelling OCR', async t => {
  const f = await fixture(t, { lens: true, holdCapture: true });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'capture_lens'));
  f.window.dispatchEvent(new f.window.Event('resize'));
  const wheel = new f.window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
  f.byId('lens-region').dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
  f.finishCapture('Same screen.');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  const paragraph = f.byId('lens-translation').querySelector('.lens-block');
  Object.defineProperties(paragraph, { clientHeight: { value: 50 }, scrollHeight: { value: 150 } });
  const scroll = () => {
    const event = new f.window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    paragraph.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(scroll(), false);
  paragraph.scrollTop = 100;
  assert.equal(scroll(), true);
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
});

test('lens reuses earlier pages after scrolling back but refresh and language changes translate again', async t => {
  const page = text => ({ kind: 'text', text, blocks: [{ text, x: .1, y: .1, width: .5, height: .1 }] });
  const f = await fixture(t, { lens: true, autoLens: true,
    captureResults: ['First page.', 'Second page.', 'First page.', 'First page.', 'First page.'].map(page) });
  await f.tickLens();
  await f.tickLens();
  await f.tickLens();
  assert.deepEqual(f.calls.filter(call => call.command === 'translate').map(call => call.args.text), ['First page.', 'Second page.']);
  assert.equal(f.byId('lens-result').hidden, false);
  f.click('lens-refresh');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 3 && f.byId('lens-status').textContent === '自動更新中');
  f.byId('lens-target').value = 'en';
  f.byId('lens-target').dispatchEvent(new f.window.Event('change'));
  await f.tickLens();
  const calls = f.calls.filter(call => call.command === 'translate');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].args.target, 'en');
});

test('closing during a paragraph translation prevents remaining paragraphs and late tokens', async t => {
  const blocks = ['First', 'Second'].map((text, index) => ({ text, x: .1, y: .1 + index * .4, width: .5, height: .1 }));
  const f = await fixture(t, { lens: true, holdTranslation: true, captureResults: [{ kind: 'text', text: 'First\n\nSecond', blocks }] });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text: '最初の訳文' });
  f.closeWindow();
  f.send({ kind: 'token', text: '遅れた訳文' });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-refresh').textContent === '更新');
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  assert.equal(f.byId('lens-translation').textContent, '');
});

test('lens checks model readiness on each manual update, including after a download in the main window', async t => {
  const f = await fixture(t, { lens: true, modelReady: false });
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.includes('準備してください'));
  assert.equal(f.calls.some(call => call.command === 'capture_lens'), false);
  f.state.modelReady = true;
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
});

test('automatic lens reuses readiness until settings, an explicit refresh or the visible session change', async t => {
  const f = await fixture(t, { lens: true, autoLens: true,
    captureResults: Array.from({ length: 20 }, () => ({ kind: 'unchanged' })) });
  const checks = () => f.calls.filter(call => call.command === 'get_status').length;
  await f.tickLens();
  const initial = checks();
  for (let index = 0; index < 4; index++) await f.tickLens();
  f.moveLens();
  await f.tickLens();
  assert.equal(checks(), initial, 'settled frames and movement do not reread model receipts');
  f.ocrChanged();
  await f.tickLens();
  assert.equal(checks(), initial + 1);
  f.modelChanged();
  await f.tickLens();
  assert.equal(checks(), initial + 2);
  f.click('lens-refresh');
  await f.tickLens();
  assert.equal(checks(), initial + 3);
  f.closeWindow();
  f.showWindow();
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.tickLens();
  assert.equal(checks(), initial + 4);
  await f.tickLens();
  assert.equal(checks(), initial + 4);
});

test('late readiness responses cannot override changed model or OCR settings', async t => {
  for (const setting of ['modelReady', 'ocrAvailable']) {
    const options = { lens: true, autoLens: true };
    const f = await fixture(t, options);
    options.holdStatus = true;
    await f.tickLens();
    f.state[setting] = false;
    if (setting === 'modelReady') f.modelChanged();
    else f.ocrChanged();
    options.holdStatus = false;
    f.finishStatus();
    await f.tickLens();
    await f.tickLens();
    assert.equal(f.calls.some(call => call.command === 'capture_lens'), false);
    assert.equal(f.byId('lens-auto').getAttribute('aria-pressed'), 'false');
    assert.match(f.byId('lens-status').textContent, setting === 'modelReady' ? /準備してください/ : /ocr:build/);
    f.state[setting] = true;
    f.click('lens-refresh');
    await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  }
});

test('automatic lens preserves backend errors and rechecks readiness before retrying', async t => {
  const options = { lens: true, autoLens: true };
  const f = await fixture(t, options);
  await f.tickLens();
  const checks = f.calls.filter(call => call.command === 'get_status').length;
  options.captureError = '文字認識エンジンが見つかりません。';
  await f.tickLens();
  assert.equal(f.byId('lens-status').textContent, options.captureError);
  assert.equal(f.byId('lens-auto').getAttribute('aria-pressed'), 'false');
  const captures = f.calls.filter(call => call.command === 'capture_lens').length;
  f.state.runtimeAvailable = false;
  f.click('lens-auto');
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'get_status').length, checks + 1);
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, captures);
  assert.match(f.byId('lens-status').textContent, /準備してください/);
});

test('moving or resizing the lens discards late OCR without translating or refreshing automatically', async t => {
  for (const resize of [false, true]) {
    const f = await fixture(t, { lens: true, holdCapture: true });
    f.click('lens-refresh');
    await until(() => f.calls.some(call => call.command === 'capture_lens'));
    if (resize) { f.window.innerWidth += 100; f.window.dispatchEvent(new f.window.Event('resize')); }
    else f.moveLens();
    await until(() => f.calls.some(call => call.command === 'cancel_operation'));
    f.finishCapture('Obsolete image text');
    await until(() => f.byId('lens-refresh').textContent === '更新');
    assert.equal(f.calls.some(call => call.command === 'translate'), false);
    assert.equal(f.byId('lens-result').hidden, true);
    assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
    assert.match(f.byId('lens-status').textContent, /範囲を変更/);
  }
});

test('lens movement cancels streaming, ignores late tokens and waits for cancellation before another capture', async t => {
  const f = await fixture(t, { lens: true, holdTranslation: true, holdCancellation: true });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text: '<b>plain text</b>' });
  assert.equal(f.byId('lens-translation').querySelector('b'), null);
  f.moveLens();
  f.send({ kind: 'token', text: 'stale' });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-refresh').textContent === '中断中…');
  assert.equal(f.byId('lens-refresh').disabled, true);
  assert.equal(f.byId('lens-translation').textContent, '');
  f.key('Enter', { metaKey: true });
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
  f.finishCancellation();
  await until(() => !f.byId('lens-refresh').disabled);
  f.click('lens-refresh');
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  f.channels[0].onmessage({ kind: 'token', text: 'old request' });
  assert.equal(f.byId('lens-translation').textContent, '');
  f.send({ kind: 'token', text: 'new result' });
  f.finish({ truncated: true });
  await until(() => f.byId('lens-status').textContent.includes('上限'));
  assert.equal(f.byId('lens-translation').textContent, 'new result');
});

test('Escape closes the lens, cancels pending OCR and never dispatches manual-window shortcuts', async t => {
  const f = await fixture(t, { lens: true, holdCapture: true });
  f.key('Enter', { metaKey: true });
  await until(() => f.calls.some(call => call.command === 'capture_lens'));
  f.key('Escape');
  await until(() => f.calls.some(call => call.command === 'hide_window'));
  f.closeWindow();
  f.finishCapture('Old image');
  await until(() => f.byId('lens-refresh').textContent === '更新');
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
  assert.equal(f.byId('lens-result').hidden, true);
  assert.equal(f.byId('settings-dialog').open, false);
});


test('Wayland lens uses OS selection and preserves results when the portal restores its window', async t => {
  const f = await fixture(t, { lens: true, holdCapture: true, status: { lensUsesSelection: true, wayland: true } });
  assert.match(f.byId('lens-status').textContent, /OSの画面選択/);
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'capture_lens'));
  f.moveLens();
  f.window.dispatchEvent(new f.window.Event('resize'));
  f.finishCapture('Selected image text.');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
  assert.equal(f.calls.find(call => call.command === 'translate').args.text, 'Selected image text.');
  f.click('lens-region');
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(f.byId('lens-source').hidden, false);
  assert.equal(f.byId('lens-source').textContent, 'Selected image text.');
  assert.equal(f.byId('lens-translation').hidden, true);
  f.click('lens-source');
  assert.equal(f.byId('lens-translation').hidden, false);
});

test('missing OCR runtime is reported before capturing and can be retried after setup', async t => {
  const f = await fixture(t, { lens: true, status: { ocrAvailable: false } });
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.includes('ocr:build'));
  assert.equal(f.calls.some(call => call.command === 'capture_lens'), false);
  assert.equal(f.byId('lens-refresh').disabled, false);
  f.state.ocrAvailable = true;
  f.click('lens-refresh');
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
});

test('automatic lens waits for stable frames, skips unchanged images and reuses identical OCR text', async t => {
  const f = await fixture(t, { lens: true, autoLens: true, captureResults: [
    { kind: 'changed' }, { kind: 'changed' }, { kind: 'text', text: 'First image' },
    { kind: 'unchanged' }, { kind: 'changed' }, { kind: 'text', text: 'First image' },
    { kind: 'changed' }, { kind: 'text', text: 'Second image' },
  ] });
  assert.equal(f.byId('lens-auto').getAttribute('aria-pressed'), 'true');
  assert.equal(f.lensDelay(), 120);
  await f.tickLens();
  assert.equal(f.lensDelay(), 120);
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 0);
  await f.tickLens();
  assert.equal(f.byId('lens-source').textContent, 'First image');
  assert.equal(f.byId('lens-status').textContent, '自動更新中');
  assert.equal(f.lensDelay(), 350);
  assert.equal(f.calls.find(call => call.command === 'capture_lens').args.automatic, true);
  assert.equal(f.calls.filter(call => call.command === 'capture_lens')[1].args.reset, false);
  await f.tickLens();
  assert.equal(f.byId('lens-result').hidden, false);
  await f.tickLens();
  assert.equal(f.byId('lens-result').hidden, true);
  await f.tickLens();
  assert.equal(f.byId('lens-result').hidden, false);
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 2);
  assert.equal(f.byId('lens-source').textContent, 'Second image');
});

test('lens distinguishes waiting from OCR and ignores late progress after moving', async t => {
  const options = { lens: true, autoLens: true, captureResults: [{ kind: 'changed' }] };
  const f = await fixture(t, options);
  await f.tickLens();
  assert.match(f.byId('lens-status').textContent, /画面が止まるのを待っています/);
  options.holdCapture = true;
  await f.tickLens();
  const channel = f.calls.filter(call => call.command === 'capture_lens').at(-1).args.onEvent;
  channel.onmessage({ kind: 'reading' });
  assert.equal(f.byId('lens-status').textContent, '文字を読み取り中…');
  f.moveLens();
  const message = f.byId('lens-status').textContent;
  channel.onmessage({ kind: 'reading' });
  assert.equal(f.byId('lens-status').textContent, message);
  f.finishCapture('Obsolete image');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.some(call => call.command === 'translate'), false);
});

test('automatic lens stops on toggle/close, resumes on reopen and retranslates for a new target', async t => {
  const f = await fixture(t, { lens: true, autoLens: true });
  await f.tickLens();
  f.click('lens-auto');
  const count = f.calls.length;
  await f.tickLens();
  assert.equal(f.calls.length, count);
  assert.equal(f.window.localStorage.getItem('lens-auto'), 'false');
  f.click('lens-auto');
  await f.tickLens();
  f.byId('lens-target').value = 'en';
  f.byId('lens-target').dispatchEvent(new f.window.Event('change'));
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'translate').at(-1).args.target, 'en');
  f.closeWindow();
  const captures = f.calls.filter(call => call.command === 'capture_lens').length;
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, captures);
  f.showWindow();
  // Reopening now waits for the native selection geometry before scheduling OCR.
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, captures + 1);
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').at(-1).args.reset, true);
});

test('automatic lens serializes work and cancels stale results before resuming after movement', async t => {
  const f = await fixture(t, { lens: true, autoLens: true, holdTranslation: true, holdCancellation: true });
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
  f.moveLens();
  f.send({ kind: 'token', text: 'obsolete' });
  f.finish({ truncated: false });
  await f.tickLens();
  assert.equal(f.byId('lens-translation').textContent, '');
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
  f.finishCancellation();
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 2);
  f.click('lens-auto');
  f.finish({ truncated: false });
  f.finishCancellation();
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 2);
});

test('automatic lens pauses on errors and never opens repeated Wayland selection dialogs', async t => {
  const failed = await fixture(t, { lens: true, autoLens: true, captureError: '画面収録を許可してください。' });
  await failed.tickLens();
  await failed.tickLens();
  assert.equal(failed.calls.filter(call => call.command === 'capture_lens').length, 1);
  assert.equal(failed.byId('lens-auto').getAttribute('aria-pressed'), 'false');
  assert.match(failed.byId('lens-status').textContent, /許可/);
  const wayland = await fixture(t, { lens: true, autoLens: true, status: { lensUsesSelection: true, wayland: true } });
  await wayland.tickLens();
  assert.equal(wayland.byId('lens-auto').disabled, true);
  assert.equal(wayland.calls.some(call => call.command === 'capture_lens'), false);
  wayland.click('lens-refresh');
  await until(() => wayland.calls.some(call => call.command === 'translate'));
  assert.equal(wayland.calls.find(call => call.command === 'capture_lens').args.automatic, false);
});

test('automatic lens never treats a truncated translation as a complete cached result', async t => {
  const f = await fixture(t, { lens: true, autoLens: true, truncated: true, captureResults: [
    { kind: 'text', text: 'Long text' }, { kind: 'changed' }, { kind: 'text', text: 'Long text' },
  ] });
  await f.tickLens();
  await f.tickLens();
  await f.tickLens();
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 2);
  assert.match(f.byId('lens-status').textContent, /上限/);
});

test('region selection normalizes a reverse drag and confirms only on Enter', async t => {
  const f = await fixture(t, { lensSelect: true });
  const surface = f.byId('lens-select');
  const pointer = (type, x, y) => surface.dispatchEvent(new f.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  pointer('pointerdown', 800, 500);
  pointer('pointermove', 100, 160);
  pointer('pointerup', 100, 160);
  assert.equal(f.calls.length, 0);
  assert.equal(f.byId('lens-select-box').style.width, '700px');
  f.key('Enter');
  await until(() => f.calls.some(call => call.command === 'confirm_lens_selection'));
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args.region)), { x: 100, y: 160, width: 700, height: 340 });
  f.key('Enter');
  assert.equal(f.calls.filter(call => call.command === 'confirm_lens_selection').length, 1);
  f.closeWindow();
  assert.equal(f.byId('lens-select-box').hidden, true);
  pointer('pointerdown', 50, 50);
  pointer('pointerup', 600, 250);
  f.key('Enter', { repeat: true });
  await until(() => f.calls.filter(call => call.command === 'confirm_lens_selection').length === 2);
});

test('empty or tiny region selection does not run OCR and Escape cancels', async t => {
  const f = await fixture(t, { lensSelect: true });
  f.key('Enter');
  assert.match(f.byId('lens-select-hint').textContent, /広い範囲/);
  assert.equal(f.calls.length, 0);
  f.key('Escape');
  await until(() => f.calls.some(call => call.command === 'hide_window'));
  assert.equal(f.calls.some(call => call.command === 'capture_lens'), false);
});

test('a confirmed screen region starts the first translation even with automatic refresh disabled', async t => {
  const f = await fixture(t, { lens: true, selectedLens: true });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.calls.filter(call => call.command === 'capture_lens').length, 1);
  assert.equal(f.calls.find(call => call.command === 'capture_lens').args.automatic, false);
});

test('a late native resize retries the selected region instead of losing its initial translation', async t => {
  const f = await fixture(t, { lens: true, selectedLens: true, holdTranslation: true });
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.moveLens();
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  f.finish({ truncated: false });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.window.localStorage.getItem('lens-auto'), 'false');
});

test('manual cancellation stops the selected region without retrying its initial translation', async t => {
  const f = await fixture(t, { lens: true, selectedLens: true, holdTranslation: true });
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.click('lens-refresh');
  await until(() => f.byId('lens-refresh').textContent === '更新');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 1);
});

test('lens opening shortcut settings save independently, reset and show a Wayland command', async t => {
  const f = await fixture(t);
  f.click('settings-button');
  const action = f.byId('shortcut-action');
  action.value = 'lensOpen'; action.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + O');
  assert.equal(f.byId('selection-shortcut-options').hidden, true);
  await f.record();
  f.key('KeyO', { ctrlKey: true, altKey: true });
  f.click('shortcut-save');
  await until(() => f.byId('shortcut-message').textContent === '保存しました');
  assert.equal(f.state.lensOpenShortcut, 'Ctrl+Alt+KeyO');
  assert.equal(f.state.shortcut, 'Ctrl+Shift+KeyJ');
  assert.equal(f.state.lensShortcut, 'Ctrl+Shift+KeyL');
  assert.equal(f.calls.find(call => call.command === 'set_shortcut').args.lensOpen, true);
  f.click('shortcut-reset');
  await until(() => f.state.lensOpenShortcut === f.state.defaultLensOpenShortcut);
  f.state.shortcutSupported = false;
  f.click('settings-close'); f.click('settings-button');
  await until(() => f.byId('shortcut-note').textContent === 'anywhere-plamo --toggle-lens');
  assert.equal(f.byId('shortcut-record').disabled, true);
});

test('lens shortcut settings save independently and can be reset', async t => {
  const f = await fixture(t);
  f.click('settings-button');
  const action = f.byId('shortcut-action');
  action.value = 'lens'; action.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + L');
  assert.equal(f.byId('selection-shortcut-options').hidden, true);
  await f.record();
  f.key('KeyL', { ctrlKey: true, altKey: true });
  f.click('shortcut-save');
  await until(() => f.byId('shortcut-message').textContent === '保存しました');
  assert.equal(f.state.shortcut, 'Ctrl+Shift+KeyJ');
  assert.equal(f.calls.find(call => call.command === 'set_shortcut').args.lens, true);
  f.click('shortcut-reset');
  await until(() => f.state.lensShortcut === f.state.defaultLensShortcut);
  action.value = 'selection'; action.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.byId('shortcut-display').textContent, 'Ctrl + Shift + J');
  assert.equal(f.byId('selection-shortcut-options').hidden, false);
});

test('native passthrough events update the recovery hint without cancelling OCR', async t => {
  const f = await fixture(t, { lens: true, autoLens: true, holdCapture: true });
  await f.tickLens();
  f.click('lens-passthrough');
  await until(() => f.byId('lens-passthrough').getAttribute('aria-pressed') === 'true');
  assert.equal(f.byId('lens-passthrough-hint').hidden, false);
  assert.match(f.byId('lens-passthrough-hint').textContent, /Ctrl \+ Shift \+ Lで解除/);
  assert.equal(f.byId('lens-status').hidden, true);
  f.finishCapture('This is an image.');
  await until(() => f.byId('lens-status').textContent === '自動更新中');
  assert.equal(f.byId('lens-passthrough-hint').hidden, false);
  f.passthrough(false);
  assert.equal(f.byId('lens-status').hidden, false);
  assert.equal(f.byId('lens-passthrough').getAttribute('aria-pressed'), 'false');
  assert.equal(f.calls.filter(call => call.command === 'set_lens_passthrough').length, 1);
  assert.equal(f.calls.some(call => call.command === 'cancel_operation'), false);
});

for (const status of [{ lensShortcutAvailable: false }, { lensUsesSelection: true }]) {
  test(`passthrough requires a working global recovery key ${JSON.stringify(status)}`, async t => {
    const f = await fixture(t, { lens: true, status });
    assert.equal(f.byId('lens-passthrough').disabled, true);
    f.click('lens-passthrough');
    assert.equal(f.calls.some(call => call.command === 'set_lens_passthrough'), false);
  });
}

test('passthrough errors retain interactive mode and shortcut changes refresh the hint', async t => {
  const f = await fixture(t, { lens: true, passthroughError: '透過を変更できませんでした。' });
  f.click('lens-passthrough');
  await until(() => f.byId('lens-status').textContent.includes('変更できません'));
  assert.equal(f.byId('lens-passthrough').getAttribute('aria-pressed'), 'false');
  assert.equal(f.byId('lens-passthrough-hint').hidden, true);
  f.state.lensShortcut = 'Alt+KeyL';
  f.lensShortcutChanged();
  await until(() => f.byId('lens-passthrough').title.includes('Alt + L'));
});


test('lens retries copied uppercase lettering once without changing the captured source', async t => {
  const text = 'IDO NOT!! 1 HATE THIS PLACE! IREALLY DO!';
  const f = await fixture(t, { lens: true, ocrText: text, target: 'ja', holdTranslation: true });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text });
  f.finish({ truncated: false });
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  assert.equal(f.calls.filter(call => call.command === 'translate')[1].args.text, 'Ido not!! 1 hate this place! Ireally do!');
  const requests = f.calls.filter(call => call.command === 'translate');
  assert.notEqual(requests[0].args.onEvent, requests[1].args.onEvent, 'each native IPC attempt needs a fresh channel');
  assert.equal(f.byId('lens-source').textContent, text);
  f.send({ kind: 'token', text: 'ここは大嫌いです！' });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.byId('lens-translation').textContent, 'ここは大嫌いです！');
});

test('lens never loops when the sentence-case retry is copied too', async t => {
  const text = 'UPPERCASE LETTERING';
  const f = await fixture(t, { lens: true, ocrText: text, target: 'ja', holdTranslation: true });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text });
  f.finish({ truncated: false });
  await until(() => f.calls.filter(call => call.command === 'translate').length === 2);
  f.send({ kind: 'token', text: text.toLowerCase() });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.calls.filter(call => call.command === 'translate').length, 2);
  assert.equal(f.byId('lens-translation').textContent, '');
});

test('Korean OCR downloads only on request, can be disabled without deleting, and re-enabled offline', async t => {
  const f = await fixture(t);
  await until(() => f.calls.some(call => call.command === 'get_korean_ocr'));
  assert.equal(f.calls.some(call => call.command === 'download_korean_ocr'), false);
  assert.equal(f.byId('korean-ocr').checked, false);
  assert.equal(f.byId('korean-ocr').disabled, true);
  f.click('korean-download');
  await until(() => f.calls.some(call => call.command === 'download_korean_ocr'));
  f.send({ kind: 'download', received: 50, total: 100 });
  assert.match(f.byId('korean-message').textContent, /50%/);
  f.finish();
  await until(() => f.byId('korean-ocr').checked);
  assert.equal(f.byId('korean-download').hidden, true);
  f.click('korean-ocr');
  await until(() => !f.byId('korean-remove').hidden);
  assert.equal(f.byId('korean-download').hidden, true);
  f.click('korean-ocr');
  await until(() => f.byId('korean-ocr').checked && !f.byId('korean-ocr').disabled);
  assert.equal(f.calls.filter(call => call.command === 'download_korean_ocr').length, 1);
  f.click('korean-ocr');
  await until(() => !f.byId('korean-remove').hidden);
  f.click('korean-remove');
  await until(() => !f.byId('korean-download').hidden);
  assert.equal(f.byId('korean-ocr').disabled, true);
});

test('cancelled Korean download stays off and allows retry', async t => {
  const f = await fixture(t);
  f.click('korean-download');
  await until(() => f.calls.some(call => call.command === 'download_korean_ocr'));
  f.click('korean-cancel');
  await until(() => f.byId('korean-message').textContent.includes('中止しました'));
  assert.equal(f.byId('korean-ocr').checked, false);
  assert.equal(f.byId('korean-download').disabled, false);
  assert.equal(f.byId('korean-cancel').hidden, true);
});

test('Korean toggle failure restores saved state', async t => {
  const f = await fixture(t, { korean: { ready: true, enabled: true }, koreanError: '保存できません' });
  await until(() => f.byId('korean-ocr').checked);
  f.click('korean-ocr');
  await until(() => f.byId('korean-message').textContent.includes('保存できません'));
  assert.equal(f.byId('korean-ocr').checked, true);
  assert.equal(f.byId('korean-remove').hidden, true);
});

test('lens batches streamed text per frame and discards paints after a move', async t => {
  const f = await fixture(t, { lens: true, holdTranslation: true, manualFrames: true });
  f.click('lens-refresh');
  await until(() => f.calls.some(call => call.command === 'translate'));
  f.send({ kind: 'token', text: '最初' });
  f.send({ kind: 'token', text: 'の訳文' });
  assert.equal(f.byId('lens-translation').textContent, '');
  f.paint();
  assert.equal(f.byId('lens-translation').textContent, '最初の訳文');
  f.send({ kind: 'token', text: 'の続き' });
  f.finish({ truncated: false });
  await until(() => f.byId('lens-status').textContent.startsWith('更新しました'));
  assert.equal(f.byId('lens-translation').textContent, '最初の訳文の続き', 'completion flushes even when frames are throttled');
  f.moveLens();
  f.paint();
  assert.equal(f.byId('lens-translation').textContent, '');
});
test('manual camera freezes, translates separate blocks, toggles originals and opens editable text', async t => {
  const f = await fixture(t, { camera: true, cameraBlocks: [
    { text: 'Hello', x: .1, y: .2, width: .3, height: .1 },
    { text: 'Goodbye', x: .6, y: .5, width: .3, height: .1 },
  ], translationOutputs: ['こんにちは', 'さようなら'] });
  f.click('camera-button');
  await until(() => !f.byId('camera-capture').disabled);
  assert.equal(f.cameraRequests[0].audio, false);
  f.click('camera-capture');
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.cameraStreams[0].track.stopped, 1);
  assert.equal(f.byId('camera-preview').hidden, false);
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1);
  assert.deepEqual(f.calls.filter(c => c.command === 'translate').map(c => c.args.text), ['Hello', 'Goodbye']);
  assert.equal(f.byId('camera-overlay').children.length, 2);
  assert.equal(f.byId('camera-overlay').children[0].style.left, '10%');
  f.click('camera-original');
  assert.equal(f.byId('camera-overlay').hidden, true);
  f.click('camera-original');
  assert.equal(f.byId('camera-overlay').hidden, false);
  f.click('camera-text');
  await until(() => f.byId('source').value === 'Hello\n\nGoodbye');
  assert.equal(f.byId('camera-dialog').open, false);
});

test('late camera permissions cannot restart a closed or hidden camera', async t => {
  for (const hide of [false, true]) {
    const f = await fixture(t, { camera: true, holdCamera: true });
    f.click('camera-button');
    await until(() => f.cameraRequests.length === 1);
    if (hide) f.closeWindow(); else f.click('camera-close');
    f.finishCamera();
    await until(() => f.cameraStreams[0].track.stopped === 1);
    assert.equal(f.byId('camera-dialog').open, false);
    assert.equal(f.calls.some(c => c.command === 'recognize_camera'), false);
  }
});

test('camera permission failure stays retryable without invoking OCR', async t => {
  const options = { camera: true, cameraError: 'NotAllowedError' };
  const f = await fixture(t, options);
  f.click('camera-button');
  await until(() => f.byId('camera-status').textContent.includes('カメラを許可'));
  assert.equal(f.byId('camera-retry').hidden, false);
  options.cameraError = null;
  f.click('camera-retry');
  await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-close');
  assert.equal(f.cameraStreams[0].track.stopped, 1);
  assert.equal(f.calls.some(c => c.command === 'recognize_camera'), false);
});

test('Android camera permission pause keeps the request open, then backgrounding stops the camera', async t => {
  const f = await fixture(t, { camera: true, holdCamera: true, status: { platform: 'android' } });
  f.click('camera-button');
  await until(() => f.cameraRequests.length === 1);
  f.closeWindow();
  assert.equal(f.byId('camera-dialog').open, true);
  Object.defineProperty(f.window.document, 'hidden', { configurable: true, value: true });
  f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
  assert.equal(f.byId('camera-dialog').open, true);
  Object.defineProperty(f.window.document, 'hidden', { configurable: true, value: false });
  f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
  f.finishCamera();
  await until(() => !f.byId('camera-capture').disabled);
  f.closeWindow();
  assert.equal(f.cameraStreams[0].track.stopped, 1);
  assert.equal(f.byId('camera-dialog').open, false);
});

test('Android releases a late camera permission when the app remains in the background', async t => {
  const f = await fixture(t, { camera: true, holdCamera: true, status: { platform: 'android' } });
  f.click('camera-button');
  await until(() => f.cameraRequests.length === 1);
  Object.defineProperty(f.window.document, 'hidden', { value: true });
  f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
  f.finishCamera();
  await until(() => f.cameraStreams[0].track.stopped === 1);
  assert.equal(f.byId('camera-dialog').open, false);
  assert.equal(f.calls.some(c => c.command === 'recognize_camera'), false);
});

test('automatic camera waits for stability, avoids unchanged work and cancels stale translations on movement', async t => {
  const f = await fixture(t, { camera: true, autoCamera: true, holdTranslation: true });
  f.click('camera-button');
  await until(() => f.byId('camera-video').srcObject);
  f.advance(150); await f.tickLens();
  assert.equal(f.calls.some(c => c.command === 'recognize_camera'), false);
  f.advance(200); await f.tickLens();
  await until(() => f.calls.some(c => c.command === 'translate'));
  f.send({ kind: 'token', text: '古い訳文' });
  f.cameraFrame(200); f.advance(150); await f.tickLens();
  assert.equal(f.calls.some(c => c.command === 'cancel_operation'), false, 'one shaken frame must not cancel translation');
  f.advance(150); await f.tickLens();
  await until(() => f.calls.some(c => c.command === 'cancel_operation'));
  assert.equal(f.byId('camera-overlay').textContent, '');
  f.send({ kind: 'token', text: '遅れた訳文' });
  assert.equal(f.byId('camera-overlay').textContent, '');
  f.advance(400); await f.tickLens();
  await until(() => f.calls.filter(c => c.command === 'translate').length === 2);
  f.send({ kind: 'token', text: '新しい訳文' }); f.finish({ truncated: false });
  await until(() => f.byId('camera-status').textContent === '自動更新中');
  f.advance(1000); await f.tickLens();
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 2);
  assert.equal(f.cameraStreams[0].track.stopped, 0);
  f.click('camera-close');
  assert.equal(f.cameraStreams[0].track.stopped, 1);
});

test('switching camera modes waits for OCR cancellation and ignores stale results', async t => {
  const options = { camera: true, autoCamera: true, holdCameraRead: true, holdCancellation: true };
  const f = await fixture(t, options);
  f.click('camera-button');
  await until(() => f.byId('camera-video').srcObject);
  f.advance(400); await f.tickLens();
  await until(() => f.calls.some(c => c.command === 'recognize_camera'));
  f.click('camera-manual');
  await until(() => f.calls.some(c => c.command === 'cancel_operation'));
  assert.equal(f.cameraRequests.length, 1);
  f.finishCameraRead(); f.finishCancellation();
  await until(() => !f.byId('camera-capture').disabled);
  assert.equal(f.cameraRequests.length, 1, 'mode switches keep the live camera open');
  assert.equal(f.calls.some(c => c.command === 'translate'), false);
  options.holdCameraRead = false;
  await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture');
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.cameraStreams.every(s => s.track.stopped === 1), true);
});

test('camera language changes retranslate frozen images and backgrounding stops live work', async t => {
  const f = await fixture(t, { camera: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
  f.byId('camera-target').value = 'ko';
  f.byId('camera-target').dispatchEvent(new f.window.Event('change'));
  await until(() => f.calls.filter(c => c.command === 'translate').length === 2);
  assert.equal(f.calls.filter(c => c.command === 'translate').at(-1).args.target, 'ko');
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1, 'a frozen image only needs OCR once');
  assert.equal(f.cameraEncodings.length, 1, 'changing target language reuses the frozen OCR result');
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  f.click('camera-auto'); await until(() => f.cameraStreams.length === 2);
  await until(() => f.byId('camera-video').srcObject);
  Object.defineProperty(f.window.document, 'hidden', { value: true });
  f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
  assert.equal(f.cameraStreams[1].track.stopped, 1);
  assert.equal(f.byId('camera-dialog').open, false);
});

test('automatic OCR errors pause instead of retrying indefinitely; empty images do not translate', async t => {
  for (const cameraReadError of ['読み取りエラー', null]) {
    const f = await fixture(t, { camera: true, autoCamera: true, cameraReadError, cameraBlocks: [] });
    f.click('camera-button'); await until(() => f.byId('camera-video').srcObject);
    f.advance(400); await f.tickLens();
    await until(() => f.byId('camera-status').textContent === (cameraReadError ?? '文字が見つかりません'));
    for (let i = 0; i < 3; i++) { f.advance(500); await f.tickLens(); }
    assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1);
    assert.equal(f.calls.some(c => c.command === 'translate'), false);
    f.click('camera-close');
  }
});

test('Android hides desktop-only settings while keeping camera, screen lens, clipboard and translation', async t => {
  const f = await fixture(t, { status: { platform: 'android', lensSupported: true } });
  assert.equal(f.byId('shortcut-section').hidden, true);
  assert.equal(f.byId('update-section').hidden, true);
  assert.equal(f.byId('quit-button').hidden, true);
  assert.equal(f.byId('lens-button').hidden, false);
  assert.equal(f.byId('camera-button').hidden, false);
  f.click('paste-button'); await until(() => f.byId('source').value);
  f.click('translate-button'); await until(() => f.byId('translation-status').textContent.includes('翻訳完了'));
  assert.equal(f.calls.some(c => c.command === 'check_update'), false);
});

test('Android screen lens releases the camera and passes the selected target to the native overlay', async t => {
  const f = await fixture(t, { camera: true, target: 'en', status: { platform: 'android', lensSupported: true } });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('lens-button');
  await until(() => f.calls.some(c => c.command === 'start_screen_lens'));
  assert.equal(f.cameraStreams[0].track.stopped, 1);
  assert.equal(f.byId('camera-dialog').open, false);
  assert.equal(f.calls.find(c => c.command === 'start_screen_lens').args.target, 'en');
  assert.equal(f.calls.some(c => c.command === 'open_lens'), false);
});

test('Android screen lens permission cancellation permits retry and missing model disables entry', async t => {
  const f = await fixture(t, { screenLensError: '画面共有をキャンセルしました。', status: { platform: 'android', lensSupported: true } });
  f.click('lens-button'); await until(() => !f.byId('lens-button').disabled);
  assert.equal(f.calls.filter(c => c.command === 'start_screen_lens').length, 1);
  f.click('lens-button'); await until(() => !f.byId('lens-button').disabled);
  assert.equal(f.calls.filter(c => c.command === 'start_screen_lens').length, 2);
  const missing = await fixture(t, { modelReady: false, status: { platform: 'android', lensSupported: true } });
  assert.equal(missing.byId('lens-button').disabled, true);
});

test('camera rotation swaps capture dimensions and can rotate a frozen image without reopening camera', async t => {
  const f = await fixture(t, { camera: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-rotate');
  await until(() => f.byId('camera-stage').style.getPropertyValue('--camera-aspect') === String(1080 / 1920));
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.byId('camera-preview').width, 1080);
  assert.equal(f.byId('camera-preview').height, 1920);
  f.click('camera-rotate'); await until(() => f.calls.filter(c => c.command === 'recognize_camera').length === 2);
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.byId('camera-preview').width, 1920);
  assert.equal(f.byId('camera-preview').height, 1080);
  assert.equal(f.cameraRequests.length, 1);
});

test('long camera paragraphs use numbered links to the complete transcript', async t => {
  const translation = 'これは長い文章の翻訳です。'.repeat(20);
  const f = await fixture(t, { camera: true, translationOutputs: [translation] });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
  const marker = f.byId('camera-overlay').firstElementChild;
  assert.ok(marker.classList.contains('is-marker'));
  assert.equal(marker.textContent, '1');
  marker.click();
  assert.equal(f.byId('camera-transcript').open, true);
  assert.equal(f.byId('camera-paragraphs').querySelector('span').textContent, translation);
});

test('automatic camera keeps in-flight translation through small exposure changes', async t => {
  const f = await fixture(t, { camera: true, autoCamera: true, holdTranslation: true });
  f.click('camera-button'); await until(() => f.byId('camera-video').srcObject);
  f.advance(350); await f.tickLens();
  await until(() => f.channels.length === 1);
  f.cameraFrame(12);
  for (let i = 0; i < 5; i++) { f.advance(150); await f.tickLens(); }
  assert.equal(f.calls.filter(c => c.command === 'cancel_operation').length, 0);
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1);
  f.send({ kind: 'token', text: 'こんにちは。' }); f.finish({ truncated: false });
  await until(() => f.byId('camera-status').textContent === '自動更新中');
});

test('automatic camera has a bounded initial wait even if motion never fully settles', async t => {
  const f = await fixture(t, { camera: true, autoCamera: true });
  f.click('camera-button'); await until(() => f.byId('camera-video').srcObject);
  for (let i = 0; i < 10; i++) { f.cameraFrame(i % 2 ? 0 : 200); f.advance(150); await f.tickLens(); }
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1);
});

test('closing during asynchronous camera encoding discards the image and releases the frame', async t => {
  const f = await fixture(t, { camera: true, holdCameraEncode: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.cameraEncodings.length === 1);
  assert.equal(f.cameraEncodings[0].type, 'image/png');
  assert.equal(f.cameraEncodings[0].width, 1920);
  assert.equal(f.cameraEncodings[0].height, 1080);
  f.click('camera-close');
  assert.equal(f.byId('camera-dialog').open, false);
  f.finishCameraEncode();
  await until(() => f.byId('camera-preview').width === 0);
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 0);
  assert.equal(f.cameraStreams[0].track.stopped, 1);
});

test('a language change during encoding discards the stale frame job before translating the new target', async t => {
  const f = await fixture(t, { camera: true, holdCameraEncode: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.cameraEncodings.length === 1);
  f.byId('camera-target').value = 'ko';
  f.byId('camera-target').dispatchEvent(new f.window.Event('change'));
  f.finishCameraEncode(0);
  await until(() => f.cameraEncodings.length === 2);
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 0);
  f.finishCameraEncode(1);
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.calls.filter(c => c.command === 'translate').length, 1);
  assert.equal(f.calls.find(c => c.command === 'translate').args.target, 'ko');
});

test('retaking during camera encoding waits for the old job and never recognizes the discarded frame', async t => {
  const f = await fixture(t, { camera: true, holdCameraEncode: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.cameraEncodings.length === 1);
  assert.equal(f.byId('camera-retry').hidden, false);
  f.click('camera-retry');
  f.finishCameraEncode();
  await until(() => f.cameraStreams.length === 2 && !f.byId('camera-capture').disabled);
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 0);
  f.click('camera-capture'); await until(() => f.cameraEncodings.length === 2);
  f.finishCameraEncode();
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 1);
});

test('camera encoding failure is retryable and never sends an invalid image to OCR', async t => {
  const options = { camera: true, cameraEncodeNull: true };
  const f = await fixture(t, options);
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture');
  await until(() => f.byId('camera-status').textContent === '撮影画像を作成できません。');
  assert.equal(f.calls.filter(c => c.command === 'recognize_camera').length, 0);
  assert.equal(f.byId('camera-retry').hidden, false);
  options.cameraEncodeNull = false;
  f.click('camera-retry'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
});

test('reopening the camera after a model change cannot reuse the previous model translation', async t => {
  const f = await fixture(t, { camera: true, translationOutputs: ['前のモデルの訳文', '新しいモデルの訳文'] });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
  f.click('camera-close'); await until(() => f.byId('camera-preview').width === 0);
  f.state.modelId = '0.8b-q3'; f.modelChanged();
  await until(() => f.byId('translation-model').value === '0.8b-q3');
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.byId('camera-status').textContent === '翻訳完了');
  assert.equal(f.calls.filter(c => c.command === 'translate').length, 2);
  assert.equal(f.byId('camera-paragraphs').querySelector('span').textContent, '新しいモデルの訳文');
});

test('camera streaming updates are batched until the next animation frame', async t => {
  const f = await fixture(t, { camera: true, holdTranslation: true, manualFrames: true });
  f.click('camera-button'); await until(() => !f.byId('camera-capture').disabled);
  f.click('camera-capture'); await until(() => f.channels.length === 1);
  f.paint();
  f.send({ kind: 'token', text: '翻訳' });
  f.send({ kind: 'token', text: 'を' });
  f.send({ kind: 'token', text: 'まとめて表示' });
  assert.equal(f.byId('camera-paragraphs').querySelector('span').textContent, '');
  f.paint();
  assert.equal(f.byId('camera-paragraphs').querySelector('span').textContent, '翻訳をまとめて表示');
  f.finish({ truncated: false });
  await until(() => f.byId('camera-status').textContent === '翻訳完了');
});

test('losing the camera device cancels work and allows reopening without stale results', async t => {
  const f = await fixture(t, { camera: true, autoCamera: true, holdTranslation: true });
  f.click('camera-button'); await until(() => f.byId('camera-video').srcObject);
  f.advance(350); await f.tickLens();
  await until(() => f.channels.length === 1);
  f.cameraStreams[0].track.dispatchEvent(new f.window.Event('ended'));
  await until(() => f.calls.some(c => c.command === 'cancel_operation'));
  assert.equal(f.byId('camera-video').srcObject, null);
  assert.match(f.byId('camera-status').textContent, /接続が切れました/);
  f.send({ kind: 'token', text: '古い映像の訳文' });
  assert.equal(f.byId('camera-paragraphs').querySelector('span').textContent, '');
  f.click('camera-retry'); await until(() => f.cameraStreams.length === 2 && f.byId('camera-video').srcObject);
  assert.equal(f.cameraStreams[0].track.stopped, 1);
});
