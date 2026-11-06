"""Run the real Linux desktop app through tauri-driver (no mocked IPC)."""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=ROOT / 'src-tauri/target/debug/anywhere-plamo')
parser.add_argument('--work-dir', type=Path, default=ROOT / '.runtime-build/desktop-test')
args = parser.parse_args()
if sys.platform != 'linux':
    parser.error('This test requires Linux, Xvfb, WebKitWebDriver and xdotool.')
APP = args.app.resolve()
WORK = args.work_dir.resolve()
WORK.mkdir(parents=True, exist_ok=True)
DRIVER = shutil.which('tauri-driver')
if not DRIVER or not APP.is_file():
    parser.error('Build the app and install tauri-driver before running this test.')
DATA = WORK / 'app-data'
DATA.mkdir(exist_ok=True)
MODEL = DATA / 'app.anywhere-plamo.desktop/models'
REPORT = []

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]
PORT = port()
NATIVE_PORT = port()
URL = f'http://127.0.0.1:{PORT}'
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SESSION = None
WINDOWS = {}
WINDOW_LABEL = 'main'
WINDOW_TITLES = {'main': 'Anywhere Plamo', 'popup': 'Anywhere Plamo — 選択翻訳'}

def request(method, path, body=None):
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method=method)
    try:
        with HTTP.open(req, timeout=45) as r:
            result = json.load(r)['value']
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()) from e
    if isinstance(result, dict) and 'error' in result:
        raise RuntimeError(result)
    return result

def js(script, *args):
    return request('POST', f'/session/{SESSION}/execute/sync', {'script': script, 'args': list(args)})

def wait(script, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if js('return ' + script):
            return
        time.sleep(0.1)
    raise AssertionError('Timed out: ' + script + '\n' + str(js('return document.body.innerText')))

def text(id):
    return js('return document.getElementById(arguments[0]).textContent', id)

def select_window(label):
    global WINDOW_LABEL
    if label not in WINDOWS:
        for handle in request('GET', f'/session/{SESSION}/window/handles'):
            request('POST', f'/session/{SESSION}/window', {'handle': handle})
            wait("document.getElementById('source') !== null")
            role = js("return new URLSearchParams(location.search).has('popup') ? 'popup' : 'main'")
            WINDOWS[role] = handle
    assert label in WINDOWS, WINDOWS
    request('POST', f'/session/{SESSION}/window', {'handle': WINDOWS[label]})
    WINDOW_LABEL = label

def window_id(label=None):
    title = WINDOW_TITLES[label or WINDOW_LABEL]
    return subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'], env=env, text=True).strip()

def window_visible(label):
    return subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(WINDOW_TITLES[label]) + '$'], env=env, capture_output=True).returncode == 0

def click(id):
    # Xvfb has no window manager to focus the app when WebDriver clicks it.
    window = window_id()
    subprocess.run(['xdotool', 'windowfocus', '--sync', window], env=env, check=True)
    element = request('POST', f'/session/{SESSION}/element', {'using': 'css selector', 'value': '#' + id})
    key = element['element-6066-11e4-a52e-4f735466cecf']
    request('POST', f'/session/{SESSION}/element/{key}/click', {})

def invoke(command, args=None):
    value = request('POST', f'/session/{SESSION}/execute/async', {'script': 'const done=arguments[arguments.length-1];window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));', 'args': [command, args or {}]})
    assert value['ok'], value
    return value.get('value')

def check(name, detail=None):
    REPORT.append({'check': name, 'detail': detail})
    print('PASS', name, json.dumps(detail, ensure_ascii=False) if detail is not None else '', flush=True)

def screenshot(name):
    # WebKitWebDriver's snapshot can stall after focus moves to another app.
    # Capture the actual X11 window instead, including its visible rendering.
    import gi
    gi.require_version('Gdk', '3.0')
    gi.require_version('GdkX11', '3.0')
    from gi.repository import Gdk, GdkX11
    Gdk.init([])
    native_window = window_id()
    subprocess.run(['xdotool', 'windowraise', native_window], env=env, check=True)
    display = Gdk.Display.open(env['DISPLAY'])
    window = GdkX11.X11Window.foreign_new_for_display(display, int(native_window))
    time.sleep(0.1)
    image = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
    assert image, 'Could not capture the app window'
    image.savev(str(WORK / name), 'png', [], [])
    display.close()

def owned_processes():
    rows = subprocess.check_output(['ps', '-e', '-o', 'pid=,ppid='], text=True).splitlines()
    pairs = [tuple(map(int, row.split())) for row in rows]
    descendants = {driver.pid}
    while True:
        more = {pid for pid, parent in pairs if parent in descendants}
        if more <= descendants:
            break
        descendants.update(more)
    return descendants

def fill(value, target='ja'):
    js("const source=document.getElementById('source');source.value=arguments[0];source.dispatchEvent(new Event('input',{bubbles:true}));const target=document.getElementById('target');target.value=arguments[1];target.dispatchEvent(new Event('change',{bubbles:true}));", value, target)

def translated():
    wait("document.getElementById('translation-status').textContent.includes('翻訳完了') || document.getElementById('translation-status').textContent === '翻訳できませんでした'", 180)
    assert '翻訳完了' in text('translation-status'), text('message')
    output = text('translation')
    assert output.strip(), output
    return output
env = os.environ.copy()
env['XDG_DATA_HOME'] = str(DATA)
env['XDG_CONFIG_HOME'] = str(WORK / 'app-config')
env['XDG_CACHE_HOME'] = str(WORK / 'app-cache')
env['XDG_SESSION_TYPE'] = 'x11'
env.pop('WAYLAND_DISPLAY', None)
log = (WORK / 'desktop.log').open('w')
driver = subprocess.Popen([DRIVER, '--port', str(PORT), '--native-port', str(NATIVE_PORT)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
selection_source = None
try:
    for _ in range(100):
        try:
            request('GET', '/status')
            break
        except Exception:
            if driver.poll() is not None:
                raise RuntimeError('Driver stopped: ' + (WORK / 'desktop.log').read_text())
            time.sleep(0.1)
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'wry', 'tauri:options': {'application': str(APP), 'args': ['--background']}}}})
    SESSION = value['sessionId']
    request('POST', f'/session/{SESSION}/timeouts', {'script': 30000})
    select_window('main')
    status = invoke('get_status')
    wait("document.getElementById('model-tag').textContent === " + json.dumps('準備完了' if status['modelReady'] else '未準備'))
    assert status['runtimeAvailable'], status
    check('native application startup', status)
    if status['resident']:
        visible = lambda: window_visible('main')
        app_pids = {pid for pid in owned_processes() if Path(f'/proc/{pid}/exe').resolve() == APP}
        assert app_pids and not visible(), 'Background startup showed the window'
        result = subprocess.run([str(APP), '--background'], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        time.sleep(0.2)
        assert not visible(), 'A background relaunch showed the window'
        result = subprocess.run([str(APP)], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        for _ in range(100):
            if visible():
                break
            time.sleep(0.05)
        assert visible(), 'A normal relaunch did not restore the window'
        assert app_pids == {pid for pid in owned_processes() if Path(f'/proc/{pid}/exe').resolve() == APP}
        check('background launch stays hidden and normal relaunch restores the same process')
    saved_settings = json.loads((MODEL.parent / 'settings.json').read_text()) if (MODEL.parent / 'settings.json').exists() else {}
    assert status['shortcutPopup'] == saved_settings.get('shortcutPopup', False)
    click('settings-button')
    wait("document.getElementById('shortcut-popup').checked === " + json.dumps(status['shortcutPopup']))
    if status['shortcutPopup']:
        click('shortcut-popup')
        wait("!document.getElementById('shortcut-popup').checked && !document.getElementById('shortcut-popup').disabled")
    assert not invoke('get_status')['shortcutPopup']
    click('settings-close')
    check('selection popup is opt-in and existing settings keep the normal window')
    screenshot('startup.png')
    if not status['modelReady']:
        click('setup-open')
        click('download-button')
        wait("document.getElementById('progress-bar').value > 0 || document.getElementById('download-message').textContent.length > 0", 180)
        assert js("return document.getElementById('progress-bar').value > 0"), text('download-message')
        click('download-cancel')
        wait("document.getElementById('download-progress').hidden")
        assert '中止' in text('download-message'), text('download-message')
        assert not list(MODEL.glob('*.part'))
        check('download cancellation removes partial files')
        click('download-button')
        last = time.monotonic()
        deadline = time.monotonic() + 900
        while not invoke('get_status')['modelReady']:
            assert time.monotonic() < deadline, 'Model download timed out'
            assert not js("return !document.getElementById('download-section').hidden"), text('download-message')
            if time.monotonic() - last > 20:
                print('DOWNLOAD', text('download-label'), flush=True)
                last = time.monotonic()
            time.sleep(0.5)
        wait("document.getElementById('model-tag').textContent === '準備完了'")
        receipt = json.loads((MODEL / 'model.json').read_text())
        assert receipt['size'] > 500000000
        with (MODEL / 'plamo-3-translate-0.8b-Q4_K_M.gguf').open('rb') as model_file:
            assert hashlib.file_digest(model_file, 'sha256').hexdigest() == receipt['sha256']
        check('real model download, checksum and ready state', receipt)
        click('settings-close')
    invoke('prepare_engine')
    invoke('prepare_engine')
    engine_pids = {pid for pid in owned_processes() if Path(f'/proc/{pid}/exe').resolve().name == 'llama-server'}
    assert len(engine_pids) == 1, engine_pids
    check('background preparation and repeated preparation share one engine')
    fill('', 'ja')
    invoke('write_clipboard', {'text': 'Hello, world.'})
    click('paste-button')
    wait("document.getElementById('source').value === 'Hello, world.'")
    click('translate-button')
    output = translated()
    assert re.search('[ぁ-んァ-ン一-龯]', output), output
    check('English to Japanese via native clipboard', output)
    assert '最初の文字まで' in js("return document.getElementById('translation-status').title")
    check('first response and completion timings', js("return document.getElementById('translation-status').title"))
    click('copy-button')
    wait("document.getElementById('copy-label').textContent === 'コピーしました'")
    assert invoke('read_clipboard') == output
    check('copy writes the actual OS clipboard')
    screenshot('translation-ja.png')
    if status['shortcutSupported']:
        click('settings-button')
        if status['shortcut'] != status['defaultShortcut']:
            click('shortcut-reset')
            wait("document.getElementById('shortcut-message').textContent === '保存しました'")
        subprocess.run(['xdotool', 'windowfocus', '--sync', window_id()], env=env, check=True)
        click('shortcut-record')
        wait("document.getElementById('shortcut-record').getAttribute('aria-pressed') === 'true'")
        subprocess.run(['xdotool', 'key', 'ctrl+shift+j'], env=env, check=True)
        wait("document.getElementById('shortcut-record').getAttribute('aria-pressed') === 'false'")
        assert text('shortcut-display') == 'Ctrl + Shift + J'
        assert js("return document.getElementById('source').value") == 'Hello, world.'
        check('the currently registered shortcut can be recorded without triggering translation')
        click('shortcut-record')
        wait("document.getElementById('shortcut-record').getAttribute('aria-pressed') === 'true'")
        subprocess.run(['xdotool', 'key', 'ctrl+alt+t'], env=env, check=True)
        wait("document.getElementById('shortcut-display').textContent === 'Ctrl + Alt + T'")
        click('shortcut-save')
        wait("document.getElementById('shortcut-message').textContent === '保存しました'")
        status = invoke('get_status')
        assert status['shortcut'] == 'Ctrl+Alt+KeyT' and status['shortcutAvailable'], status
        settings_path = MODEL.parent / 'settings.json'
        assert json.loads(settings_path.read_text())['shortcut'] == status['shortcut']
        check('record and save a custom global shortcut through the UI', status['shortcut'])
        screenshot('settings-shortcut.png')
        try:
            invoke('set_shortcut', {'shortcut': 'KeyJ'})
        except RuntimeError as error:
            assert '組み合わせてください' in str(error), error
        else:
            raise AssertionError('An unmodified typing key was accepted')
        assert invoke('get_status')['shortcut'] == 'Ctrl+Alt+KeyT'
        assert json.loads(settings_path.read_text())['shortcut'] == 'Ctrl+Alt+KeyT'
        check('invalid shortcut leaves the current setting unchanged')
        click('settings-close')
        if status['resident']:
            click('settings-button')
            click('shortcut-record')
            wait("document.getElementById('shortcut-record').getAttribute('aria-pressed') === 'true'")
            invoke('hide_window')
            result = subprocess.run([str(APP)], env=env, capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, result.stderr
            wait("!document.getElementById('settings-dialog').open && document.getElementById('shortcut-record').getAttribute('aria-pressed') === 'false'")
            check('hiding and reopening the window cancels shortcut recording')
    fill('今日は良い天気ですね。', 'en')
    click('translate-button')
    if status['resident']:
        invoke('hide_window')
    output = translated()
    assert re.search('[A-Za-z]', output), output
    check('Japanese to English', output)
    if status['resident']:
        assert not visible(), 'Translation reopened the hidden window'
        result = subprocess.run([str(APP)], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        for _ in range(100):
            if visible():
                break
            time.sleep(0.05)
        assert visible()
        assert text('translation') == output
        check('translation completes in the background and survives reopening')
    for language in ('ko', 'zh-hans', 'fr', 'de', 'es'):
        fill('Thank you for your help.', language)
        click('translate-button')
        output = translated()
        check('translation target ' + language, output)
    # Fixed Q4_K_M tokenizer: 4,306 tokens together; 2,106 / 2,214 separately.
    records = [f'試料番号{i}は零下二十度で測定し、結果を記録しました。' for i in range(1, 221)]
    fill('\n'.join(records), 'en')
    click('translate-button')
    wait("document.getElementById('translation-status').textContent === '翻訳できませんでした'", 180)
    assert '1段落が長すぎます' in text('message'), text('message')
    assert text('translation') == ''
    check('oversized single paragraph is rejected before any output')
    fill('\n'.join(records[:110]) + '\n\n' + '\n'.join(records[110:]), 'en')
    click('translate-button')
    output = translated()
    paragraphs = output.split('\n\n')
    assert len(paragraphs) == 2 and '1' in paragraphs[0] and '111' in paragraphs[1], output[-500:]
    (WORK / 'long-translation.txt').write_text(output)
    check('long input translates both paragraphs and retains their separator', {'output_characters': len(output)})
    fill('The river flows through a quiet town. ' * 70)
    click('translate-button')
    wait("document.getElementById('source').readOnly")
    click('translate-button')
    wait("document.getElementById('translation-status').textContent === '翻訳を中断しました'", 30)
    assert not js("return document.getElementById('source').readOnly")
    fill('Good morning.')
    click('translate-button')
    output = translated()
    check('cancel real inference and translate again', output)
    invoke('write_clipboard', {'text': 'The meeting starts at ten.'})
    result = subprocess.run([str(APP), '--translate-clipboard'], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    wait("document.getElementById('source').value === 'The meeting starts at ten.'")
    output = translated()
    check('single-instance clipboard command', output)
    assert js("return document.body.classList.contains('reading-mode') && document.getElementById('source-panel').hidden")
    click('toggle-original')
    assert js("return !document.getElementById('source-panel').hidden")
    click('toggle-original')
    screenshot('translation-compact.png')
    click('edit-source')
    assert not js("return document.body.classList.contains('reading-mode')")
    check('compact translation, original disclosure and return to editing')
    fill('The river flows through a quiet town. ' * 250)
    click('translate-button')
    wait("document.getElementById('source').readOnly")
    invoke('write_clipboard', {'text': 'Please bring the report tomorrow.'})
    result = subprocess.run([str(APP), '--translate-clipboard'], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    wait("document.getElementById('source').value === 'Please bring the report tomorrow.'")
    output = translated()
    assert not js("return !document.getElementById('message').hidden"), text('message')
    check('a new request replaces an active translation', output)
    if status['shortcutAvailable']:
        sentinel = 'Previous clipboard contents must not be translated or changed.'
        invoke('write_clipboard', {'text': sentinel})
        selection_state = WORK / 'selection-state.json'
        selection_state.unlink(missing_ok=True)
        selection_source = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/selection-source.py'), str(selection_state)], env=env, stdout=log, stderr=log)
        for _ in range(100):
            if selection_state.exists():
                break
            time.sleep(0.1)
        bounds = json.loads(selection_state.read_text())
        window = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name', '^Anywhere Plamo selection test source$'], env=env, text=True).strip()
        y = str(bounds['y'] + bounds['height'] // 2)
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'mousemove', '--window', window, str(bounds['x'] + 10), y, 'sleep', '0.1', 'mousedown', '1', 'sleep', '0.1', 'mousemove', '--window', window, str(bounds['x'] + bounds['width'] - 10), y, 'sleep', '0.1', 'mouseup', '1'], env=env, check=True)
        for _ in range(100):
            if json.loads(selection_state.read_text())['selected'] == 'Please open the window.':
                break
            time.sleep(0.05)
        assert json.loads(selection_state.read_text())['selected'] == 'Please open the window.'
        click('settings-button')
        if not js("return document.getElementById('auto-direction').checked"):
            click('auto-direction')
        click('settings-close')
        fill('Waiting for the new shortcut.', 'fr')
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'key', 'ctrl+shift+j'], env=env, check=True)
        time.sleep(0.3)
        assert js("return document.getElementById('source').value") == 'Waiting for the new shortcut.'
        subprocess.run(['xdotool', 'key', 'ctrl+alt+t'], env=env, check=True)
        wait("document.getElementById('source').value === 'Please open the window.'")
        output = translated()
        assert invoke('read_clipboard') == sentinel
        assert js("return document.getElementById('target').value") == 'ja'
        assert js("return localStorage.getItem('target-language')") == 'fr'
        check('new shortcut translates the selection and the previous shortcut is released', output)
        check('English selection automatically uses Japanese and retains the manual target')
        fill('Waiting for selection command.', 'fr')
        subprocess.run(['xdotool', 'windowfocus', '--sync', window], env=env, check=True)
        result = subprocess.run([str(APP), '--translate-selection'], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        wait("document.getElementById('source').value === 'Please open the window.'")
        translated()
        assert invoke('read_clipboard') == sentinel
        check('selection command preserves the ordinary clipboard')
        result = subprocess.run([str(APP), '--translate-clipboard'], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        wait("document.getElementById('source').value === " + json.dumps(sentinel))
        translated()
        assert js("return document.getElementById('target').value") == 'fr'
        check('clipboard translation keeps the manual target when selection auto direction is enabled')
        selection_source.terminate()
        selection_source.wait(timeout=5)
        selection_state.unlink(missing_ok=True)
        japanese_selection = '今日は良い天気ですね。'
        selection_source = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/selection-source.py'), str(selection_state), japanese_selection], env=env, stdout=log, stderr=log)
        for _ in range(100):
            if selection_state.exists():
                break
            time.sleep(0.1)
        bounds = json.loads(selection_state.read_text())
        window = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name', '^Anywhere Plamo selection test source$'], env=env, text=True).strip()
        y = str(bounds['y'] + bounds['height'] // 2)
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'key', 'ctrl+a'], env=env, check=True)
        for _ in range(100):
            if json.loads(selection_state.read_text())['selected'] == japanese_selection:
                break
            time.sleep(0.05)
        assert json.loads(selection_state.read_text())['selected'] == japanese_selection
        subprocess.run(['xdotool', 'key', 'ctrl+alt+t'], env=env, check=True)
        wait("document.getElementById('source').value === " + json.dumps(japanese_selection))
        translated()
        assert js("return document.getElementById('target').value") == 'en'
        assert invoke('read_clipboard') == sentinel
        check('Japanese selection automatically uses English without changing the clipboard')
        click('settings-button')
        click('shortcut-popup')
        wait("document.getElementById('shortcut-popup').checked && !document.getElementById('shortcut-popup').disabled")
        assert invoke('get_status')['shortcutPopup']
        saved_settings = json.loads(settings_path.read_text())
        assert saved_settings['shortcutPopup'] and saved_settings['shortcut'] == 'Ctrl+Alt+KeyT'
        click('settings-close')
        check('enable the optional selection popup without changing the global shortcut')
        click('edit-source')
        manual_input = 'The river flows through a quiet town. ' * 250
        fill(manual_input, 'fr')
        click('translate-button')
        wait("document.getElementById('source').readOnly")
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'key', 'ctrl+alt+t'], env=env, check=True)
        select_window('popup')
        wait("document.getElementById('source').value === " + json.dumps(japanese_selection))
        assert window_visible('popup'), 'The enabled selection popup was not shown'
        subprocess.run(['xdotool', 'windowfocus', '--sync', window], env=env, check=True)
        time.sleep(0.2)
        assert window_visible('popup'), 'The popup hid while its translation was waiting'
        select_window('main')
        assert js("return document.getElementById('source').value") == manual_input
        assert js("return document.getElementById('source').readOnly"), 'The selection interrupted the manual translation'
        assert window_visible('main'), 'The manual window hid when focus moved outside'
        invoke('cancel_operation')
        wait("document.getElementById('translation-status').textContent === '翻訳を中断しました'")
        manual_result = text('translation')
        select_window('popup')
        output = translated()
        assert js("return document.getElementById('target').value") == 'en'
        assert invoke('read_clipboard') == sentinel
        assert window_visible('popup'), 'Finishing a translation hid the popup without a new focus change'
        check('selection popup waits independently and survives cancellation of the manual translation', output)
        screenshot('translation-popup.png')
        subprocess.run(['xdotool', 'windowfocus', '--sync', window_id('popup')], env=env, check=True)
        subprocess.run(['xdotool', 'windowfocus', '--sync', window], env=env, check=True)
        for _ in range(100):
            if not window_visible('popup'):
                break
            time.sleep(0.05)
        assert not window_visible('popup'), 'The completed popup stayed open after focus moved outside'
        assert window_visible('main'), 'Dismissing the popup hid the manual window'
        select_window('main')
        assert js("return document.getElementById('source').value") == manual_input
        assert text('translation') == manual_result
        assert text('translation-status') == '翻訳を中断しました'
        check('completed popup dismisses on outside focus and preserves the manual window contents')
        click('settings-button')
        click('shortcut-popup')
        wait("!document.getElementById('shortcut-popup').checked && !document.getElementById('shortcut-popup').disabled")
        assert not invoke('get_status')['shortcutPopup']
        click('settings-close')
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'key', 'ctrl+alt+t'], env=env, check=True)
        wait("document.getElementById('source').value === " + json.dumps(japanese_selection))
        translated()
        assert not window_visible('popup')
        check('disabling the optional popup restores selection translation in the normal window')
        click('settings-button')
        click('auto-direction')
        click('settings-close')
        subprocess.run(['xdotool', 'windowfocus', '--sync', window, 'mousemove', '--window', window, str(bounds['x'] + 10), y, 'sleep', '0.1', 'click', '1'], env=env, check=True)
        for _ in range(100):
            if json.loads(selection_state.read_text())['selected'] == '':
                break
            time.sleep(0.05)
        assert json.loads(selection_state.read_text())['selected'] == ''
        subprocess.run(['xdotool', 'key', 'ctrl+alt+t'], env=env, check=True)
        wait("!document.getElementById('message').hidden")
        assert '選択した文字' in text('message')
        assert js("return document.getElementById('source').value") == japanese_selection
        assert invoke('read_clipboard') == sentinel
        check('missing selection does not translate old clipboard contents')
        click('settings-button')
        click('shortcut-popup')
        wait("document.getElementById('shortcut-popup').checked && !document.getElementById('shortcut-popup').disabled")
        assert invoke('get_status')['shortcutPopup']
        click('settings-close')
        selection_source.terminate()
        selection_source.wait(timeout=5)
        selection_source = None
    screenshot('translation-final.png')
    expected_preferences = ['auto-direction', 'target-language'] if status['shortcutAvailable'] else ['target-language']
    assert js('return Object.keys(localStorage).sort()') == expected_preferences
    check('only preferences are stored in localStorage')
    owned = owned_processes()
    app_pids = {pid for pid in owned if Path(f'/proc/{pid}/exe').resolve() == APP}
    engine_pids = {pid for pid in owned if Path(f'/proc/{pid}/exe').resolve().name == 'llama-server'}
    assert app_pids and engine_pids, 'Expected live app and inference child'
    try:
        invoke('quit_app')
    except RuntimeError:
        pass
    for _ in range(100):
        if all((not Path(f'/proc/{pid}').exists() for pid in app_pids | engine_pids)):
            break
        time.sleep(0.1)
    assert all((not Path(f'/proc/{pid}').exists() for pid in app_pids | engine_pids)), 'App or inference process survived exit'
    check('quit stops the app and its inference process')
    request('DELETE', f'/session/{SESSION}')
    SESSION = None
    if status['shortcutSupported']:
        value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'wry', 'tauri:options': {'application': str(APP)}}}})
        SESSION = value['sessionId']
        request('POST', f'/session/{SESSION}/timeouts', {'script': 30000})
        WINDOWS.clear()
        select_window('main')
        status = invoke('get_status')
        assert status['shortcut'] == 'Ctrl+Alt+KeyT' and status['shortcutAvailable'], status
        click('settings-button')
        wait("document.getElementById('shortcut-display').textContent === 'Ctrl + Alt + T'")
        check('custom shortcut is registered and displayed after restarting the app')
        assert status['shortcutPopup']
        wait("document.getElementById('shortcut-popup').checked")
        check('the optional popup preference survives restarting the app')
        click('shortcut-reset')
        wait("document.getElementById('shortcut-message').textContent === '保存しました'")
        status = invoke('get_status')
        assert status['shortcut'] == status['defaultShortcut'] and status['shortcutAvailable'], status
        assert json.loads(settings_path.read_text())['shortcut'] == status['defaultShortcut']
        assert json.loads(settings_path.read_text())['shortcutPopup']
        check('restore the default shortcut through the UI')
        click('shortcut-popup')
        wait("!document.getElementById('shortcut-popup').checked && !document.getElementById('shortcut-popup').disabled")
        assert not invoke('get_status')['shortcutPopup']
        try:
            invoke('quit_app')
        except RuntimeError:
            pass
        SESSION = None
    print('ALL DESKTOP CHECKS PASSED', flush=True)
except Exception:
    if SESSION:
        try:
            screenshot('failure.png')
            print('UI STATE', js('return document.body.innerText'), flush=True)
        except Exception:
            pass
    raise
finally:
    if selection_source:
        selection_source.terminate()
        selection_source.wait(timeout=5)
    (WORK / 'results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
    if SESSION:
        try:
            invoke('quit_app')
        except Exception:
            pass
        try:
            request('DELETE', f'/session/{SESSION}')
        except Exception:
            pass
    try:
        os.killpg(driver.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    driver.wait(timeout=10)
    log.close()
