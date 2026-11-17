import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

async function backend() {
  const calls = [];
  const context = createContext({ window: { __TAURI__: { core: {
    Channel: class {},
    invoke(command, args) {
      return new Promise((resolve, reject) => calls.push({ command, args, resolve, reject }));
    },
  } } } });
  const module = new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../gui/web/backend.ts', import.meta.url), 'utf8')), { context });
  await module.link(() => { throw new Error('The bridge has no imports'); });
  await module.evaluate();
  return { translate: module.namespace.translateBlocks, calls };
}

test('a document sends its ordered blocks through one native batch and receives indexed results', async () => {
  const { translate, calls } = await backend();
  const events = [];
  const pending = translate(['First paragraph.', 'Second paragraph.'], 'ja', true, () => true, event => events.push(event));
  assert.equal(calls.length, 1);
  const { command, args, resolve } = calls[0];
  assert.equal(command, 'translate_blocks');
  assert.deepEqual(args.texts, ['First paragraph.', 'Second paragraph.']);
  assert.equal(args.target, 'ja');
  assert.equal(args.options.document, true);
  assert.equal(args.options.continueOnTruncation, false);
  const result = { kind: 'finished', index: 1, text: '二つ目の段落。', truncated: false };
  args.onEvent.onmessage(result);
  assert.deepEqual(events, [result]);
  resolve();
  await pending;
  args.onEvent.onmessage({ ...result, text: 'late result' });
  assert.equal(events.length, 1);
});

test('closing or replacing a view ignores in-flight events and skips jobs that have become stale', async () => {
  const { translate, calls } = await backend();
  let current = true;
  let received = 0;
  const pending = translate(['Hello.'], 'ko', false, () => current, () => received++);
  current = false;
  calls[0].args.onEvent.onmessage({ kind: 'token', index: 0, text: 'stale' });
  calls[0].resolve();
  await pending;
  await translate(['Another.'], 'ko', false, () => current, () => received++);
  await translate([], 'ko', false, () => true, () => received++);
  assert.equal(received, 0);
  assert.equal(calls.length, 1);
});

test('a failed batch cannot write into a subsequent request, which can continue past truncated blocks', async () => {
  const { translate, calls } = await backend();
  const events = [];
  const first = translate(['Old.'], 'ja', false, () => true, event => events.push(event));
  const rejected = assert.rejects(first, /CANCELLED/);
  calls[0].reject(new Error('CANCELLED'));
  await rejected;
  const second = translate(['New.'], 'ja', false, () => true, event => events.push(event), true);
  calls[0].args.onEvent.onmessage({ kind: 'token', index: 0, text: 'late' });
  calls[1].args.onEvent.onmessage({ kind: 'token', index: 0, text: 'new' });
  calls[1].resolve();
  await second;
  assert.deepEqual(events.map(event => event.text), ['new']);
  assert.equal(calls[1].args.options.continueOnTruncation, true);
});
