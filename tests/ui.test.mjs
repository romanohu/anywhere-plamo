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
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', virtualConsole: console });
  const { window } = dom;
  if (options.preload !== undefined) window.localStorage.setItem('preload-model', String(options.preload));
  let now = 0;
  if (options.manualClock) window.performance.now = () => now;
  const byId = id => window.document.getElementById(id);
  // JSDOM does not implement native dialog presentation. Its open state is enough for these tests.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [];
  const listeners = new Map();
  const state = {
    modelReady: options.modelReady ?? true, runtimeAvailable: true,
    shortcutAvailable: true, wayland: false, resident: true,
    shortcut: 'Ctrl+Shift+KeyJ', defaultShortcut: 'Ctrl+Shift+KeyJ', shortcutSupported: true,
    ...options.status,
  };
  let clipboard = options.clipboard ?? 'Hello, world.';
  let pending = options.pending ?? null;
  let rejectOperation;
  let finishOperation;
  let channel;
  let finishClipboard;
  let finishCancellation;
  let finishPending;
  let finishRecording;
  const channels = [];
  const native = {
    core: {
      Channel: class { onmessage = () => {}; },
      invoke: async (command, args) => {
        calls.push({ command, args });
        switch (command) {
          case 'get_status': return { ...state };
          case 'set_shortcut_recording':
            if (args.recording && options.holdRecording) return new Promise(resolve => { finishRecording = resolve; });
            return;
          case 'set_shortcut':
            if (options.shortcutError) throw options.shortcutError;
            state.shortcut = args.shortcut;
            state.shortcutAvailable = true;
            return { ...state };
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
            channel.onmessage({ kind: 'token', text: 'こんにちは、' });
            channel.onmessage({ kind: 'token', text: '世界。' });
            return { truncated: !!options.truncated };
          case 'download_model':
            channel = args.onEvent;
            return new Promise((resolve, reject) => {
              finishOperation = () => { state.modelReady = true; resolve(); };
              rejectOperation = reject;
            });
          case 'cancel_operation':
            if (options.cancelError) throw options.cancelError;
            if (options.holdCancellation) return new Promise(resolve => { finishCancellation = resolve; });
            rejectOperation?.('CANCELLED'); return;
          case 'hide_window': case 'quit_app': case 'open_model_license': return;
          default: throw new Error(`Unexpected command: ${command}`);
        }
      },
    },
    event: { listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); } },
  };
  if (!options.browser) window.__TAURI__ = native;
  window.eval(bundle);
  await until(() => options.browser || calls.some(call => call.command === 'take_pending_clipboard'));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  return {
    window, byId, calls, state, channels,
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
    shortcutPressed(shortcut) { listeners.get('shortcut-pressed')?.({ payload: shortcut }); },
    closeWindow() { listeners.get('window-hidden')?.({ payload: null }); },
    request(text) { pending = { text }; listeners.get('clipboard-request')?.({ payload: null }); },
    requestError(error) { pending = { text: null, error }; listeners.get('clipboard-request')?.({ payload: null }); },
  };
}

test('browser preview clearly disables translation and model download', async t => {
  const f = await fixture(t, { browser: true });
  f.input('Test');
  assert.equal(f.byId('setup-heading').textContent, '画面プレビュー');
  assert.equal(f.byId('shortcut-record').disabled, true);
  assert.equal(f.byId('translate-button').disabled, true);
  f.click('setup-open');
  assert.equal(f.byId('settings-dialog').open, true);
  assert.equal(f.byId('download-button').disabled, true);
  assert.equal(f.calls.length, 0);
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
