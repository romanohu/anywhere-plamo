// Run against an installed debug APK with the model ready and a stationary,
// readable English camera scene. Uses real camera/OCR/translation, without mocks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const adb = process.env.ADB || 'adb';
const app = 'app.anywhere_plamo.mobile';
const output = path.resolve(process.argv[2] || '.runtime-build/verification/android-camera');
const timeout = Number(process.env.CAMERA_TEST_TIMEOUT || 1800000);
const checks = [];
fs.mkdirSync(output, { recursive: true });
for (const name of ['main', 'permission', 'manual', 'original', 'automatic', 'failure']) {
  fs.rmSync(path.join(output, `${name}.png`), { force: true });
}
fs.writeFileSync(path.join(output, 'results.json'), '[]\n');
function device(...args) { return execFileSync(adb, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
function check(name, details) {
  checks.push({ name, details });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(`PASS ${name}`, details ?? '');
}
function screenshot(name) { fs.writeFileSync(path.join(output, `${name}.png`), device('exec-out', 'screencap', '-p')); }

console.log('Starting the Android app');
device('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
let socket;
const deadline = Date.now() + 180000;
while (!socket && Date.now() < deadline) {
  try {
    const pid = device('shell', 'pidof', app).toString().trim();
    assert.match(pid, /^\d+$/);
    device('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
    const tabs = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const tab = tabs.find(tab => tab.url === 'http://tauri.localhost/');
    assert.ok(tab, 'App WebView is not ready');
    const candidate = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { candidate.onopen = resolve; candidate.onerror = reject; });
    socket = candidate;
  } catch { await delay(2000); }
}
assert.ok(socket, 'Cannot connect to the app WebView; inspect logcat and the emulator SIMD diagnostic');
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) pending.get(message.id)?.(message);
};
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 60000);
    pending.set(id, message => {
      clearTimeout(timer); pending.delete(id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function js(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression, limit = timeout) {
  const end = Date.now() + limit;
  let last;
  while (Date.now() < end) {
    if (await js(expression)) return;
    const status = await js('document.getElementById("camera-status")?.textContent ?? "起動中"');
    if (status !== last) { console.log('Camera:', status); last = status; }
    await delay(2000);
  }
  throw new Error(`Timed out waiting for ${expression}; camera status: ${last}`);
}
async function tap(id) {
  console.log('Tap:', id);
  const point = await js(`(() => { const e = document.getElementById(${JSON.stringify(id)});
    if (e.disabled || e.hidden) throw new Error('Button unavailable: ' + e.id);
    e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error('Button not visible: ' + e.id);
    return { x: (r.x + r.width / 2) * devicePixelRatio, y: (r.y + r.height / 2) * devicePixelRatio }; })()`);
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) })).json();
  const origin = JSON.parse(tabs.find(tab => tab.webSocketDebuggerUrl === socket.url).description);
  device('shell', 'input', 'tap', String(Math.round(origin.screenX + point.x)), String(Math.round(origin.screenY + point.y)));
}

try {
  await wait('document.title === "Anywhere Plamo" && document.getElementById("camera-button")?.disabled === false', 180000);
  await wait('!document.hidden && document.hasFocus()', 180000);
  assert.equal(await js('document.getElementById("target").value'), 'ja', 'Select Japanese before this test');
  if (await js('document.getElementById("camera-dialog").open')) await tap('camera-close');
  if (process.env.CAMERA_TEST_LOW_RES === '1') {
    // Only lower the requested camera format; still use the native permission
    // dialog and getUserMedia stream, followed by real OCR and translation.
    await js(`(() => { const media = navigator.mediaDevices;
      window.testGetUserMedia = media.getUserMedia;
      const acquire = media.getUserMedia.bind(media);
      media.getUserMedia = options => acquire({ ...options, video: { ...options.video,
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 5 } } });
    })()`);
  }
  const initialCaptures = new Set(device('shell', 'run-as', app, 'find', 'cache', '-name', 'capture.png').toString().trim().split('\n'));
  screenshot('main');
  check('WebView starts and the local model is ready');
  await tap('camera-button');
  // Accept the actual Android runtime permission dialog if this is the first use.
  const permissionDeadline = Date.now() + 120000;
  while (Date.now() < permissionDeadline) {
    if (await js('document.getElementById("camera-video").readyState >= 2')) break;
    let xml = '';
    try {
      device('shell', 'rm', '-f', '/sdcard/plamo-camera-test.xml');
      device('shell', 'uiautomator', 'dump', '/sdcard/plamo-camera-test.xml');
      xml = device('shell', 'cat', '/sdcard/plamo-camera-test.xml').toString();
    } catch { /* The permission controller can be between windows while opening. */ }
    const allow = xml.match(/<node\b[^>]*resource-id="[^"]*:id\/permission_allow_foreground_only_button"[^>]*>/)?.[0];
    if (allow) {
      screenshot('permission');
      const bounds = allow.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
      device('shell', 'input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
      check('Camera permission accepted through the Android dialog');
      break;
    }
    await delay(2000);
  }
  await wait('document.getElementById("camera-video").readyState >= 2 && document.getElementById("camera-video").srcObject !== null');
  await tap('camera-manual');
  await wait('document.getElementById("camera-manual").getAttribute("aria-pressed") === "true"');
  await wait('!document.getElementById("camera-capture").disabled');
  await js('window.testCameraTrack = document.getElementById("camera-video").srcObject.getVideoTracks()[0]; true');
  await tap('camera-capture');
  await wait('document.getElementById("camera-status").textContent === "翻訳完了"');
  assert.equal(await js('window.testCameraTrack.readyState'), 'ended');
  assert.equal(await js('document.getElementById("camera-preview").hidden'), false);
  const translated = await js('document.getElementById("camera-overlay").textContent');
  assert.match(translated, /[\u3040-\u30ff\u3400-\u9fff]/);
  screenshot('manual');
  check('Manual capture freezes the image, releases the camera and shows Japanese', translated);
  await tap('camera-original');
  await wait('document.getElementById("camera-overlay").hidden');
  screenshot('original');
  await tap('camera-original');
  await wait('!document.getElementById("camera-overlay").hidden');
  check('Original/translation toggle');
  await tap('camera-text');
  await wait('!document.getElementById("camera-dialog").open');
  const source = await js('document.getElementById("source").value');
  assert.ok(source.trim());
  if (process.env.CAMERA_EXPECTED_SOURCE) assert.ok(source.toLowerCase().includes(process.env.CAMERA_EXPECTED_SOURCE.toLowerCase()), source);
  check('Recognized text opens in the editable main window', source);
  await wait('!document.getElementById("camera-button").disabled');
  await tap('camera-button');
  await wait('!document.getElementById("camera-capture").disabled');
  await tap('camera-capture');
  await wait('document.getElementById("camera-status").textContent === "翻訳完了"');
  await tap('camera-retry');
  await wait('!document.getElementById("camera-capture").disabled && document.getElementById("camera-preview").hidden');
  check('Retake returns to the live camera');
  await tap('camera-auto');
  await wait('document.getElementById("camera-status").textContent === "自動更新中"');
  assert.match(await js('document.getElementById("camera-overlay").textContent'), /[\u3040-\u30ff\u3400-\u9fff]/);
  assert.equal(await js('document.getElementById("camera-video").srcObject.getVideoTracks()[0].readyState'), 'live');
  assert.equal(await js('document.getElementById("camera-capture").hidden'), true);
  screenshot('automatic');
  check('Automatic mode overlays translation without a capture tap and keeps the camera live');
  await js('window.testCameraTrack = document.getElementById("camera-video").srcObject.getVideoTracks()[0]; true');
  device('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await delay(3000);
  device('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  await wait('!document.hidden && document.hasFocus()', 180000);
  await wait('!document.getElementById("camera-dialog").open');
  assert.equal(await js('window.testCameraTrack.readyState'), 'ended');
  check('Backgrounding closes the camera and releases its track');
  await tap('camera-button');
  await wait('document.getElementById("camera-video").srcObject !== null');
  await js('window.testCameraTrack = document.getElementById("camera-video").srcObject.getVideoTracks()[0]; true');
  await tap('camera-close');
  await wait('!document.getElementById("camera-dialog").open');
  assert.equal(await js('window.testCameraTrack.readyState'), 'ended');
  let files;
  const cleanupDeadline = Date.now() + timeout;
  do {
    files = device('shell', 'run-as', app, 'find', 'cache', '-name', 'capture.png').toString().trim()
      .split('\n').filter(file => file && !initialCaptures.has(file)).join('\n');
    if (!files) break;
    await delay(1000);
  } while (Date.now() < cleanupDeadline);
  assert.equal(files, '');
  check('Closing releases the camera and leaves no new OCR image');
  console.log('ANDROID CAMERA CHECKS PASSED');
} catch (error) {
  screenshot('failure');
  throw error;
} finally {
  if (process.env.CAMERA_TEST_LOW_RES === '1') {
    await js(`if (window.testGetUserMedia) {
      navigator.mediaDevices.getUserMedia = window.testGetUserMedia;
      delete window.testGetUserMedia;
    }`).catch(() => {});
  }
  socket.close();
  device('forward', '--remove', 'tcp:9222');
}
