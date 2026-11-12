"""Build signed updater files locally; never publish or run GitHub Actions."""
import argparse
import base64
import datetime
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent


def check_signature(signature, public_key, version):
    # Catch the wrong release key/version before publishing. Cryptographic
    # verification is performed by Tauri in the installed app, before replacement.
    lines = base64.b64decode(signature, validate=True).decode().splitlines()
    public = base64.b64decode(public_key, validate=True).decode().splitlines()
    key = base64.b64decode(public[1], validate=True)
    signed = base64.b64decode(lines[1], validate=True)
    if len(key) != 42 or len(signed) != 74 or key[2:10] != signed[2:10]:
        raise ValueError('The signing key does not match tauri.conf.json. Reuse the original release key.')
    if f'version:{version}' not in lines[2].split():
        raise ValueError('Missing signed version. Use the Tauri CLI installed by npm ci.')


def manifest(config, target, name, signature, previous=None):
    version = config['version']
    check_signature(signature, config['plugins']['updater']['pubkey'], version)
    if previous and previous['version'] != version:
        raise ValueError('Only manifests for the same version can be merged.')
    result = previous or {'version': version,
        'pub_date': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'platforms': {}}
    result['platforms'][target] = {
        'signature': signature,
        'url': f'https://github.com/romanohu/anywhere-plamo/releases/download/v{version}/{urllib.parse.quote(name)}',
    }
    return result


def sign_runtime(identity):
    runtime = ROOT / 'src-tauri/resources/runtime'
    # Sign native resources inside out; do not use --deep to create signatures.
    magic = {bytes.fromhex(value) for value in ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}
    for file in sorted(runtime.rglob('*'), key=lambda p: len(p.parts), reverse=True):
        if file.is_symlink():
            continue
        if file.is_file():
            with file.open('rb') as stream:
                native = stream.read(4) in magic
        else:
            native = file.suffix == '.framework'
        if native:
            subprocess.run(['codesign', '--force', '--sign', identity, str(file)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--merge', type=pathlib.Path, help='Same-version latest.json from another platform')
    options = parser.parse_args()
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    system = platform.system()
    architecture = {'arm64': 'aarch64', 'aarch64': 'aarch64', 'x86_64': 'x86_64', 'amd64': 'x86_64'}.get(platform.machine().lower())
    if not architecture or system not in {'Darwin', 'Linux', 'Windows'}:
        parser.error('Build on a supported Mac, Linux or Windows host.')
    if not os.environ.get('TAURI_SIGNING_PRIVATE_KEY'):
        parser.error('Set TAURI_SIGNING_PRIVATE_KEY to the original updater key file path.')
    previous = json.loads(options.merge.read_text()) if options.merge else None
    if previous and previous['version'] != config['version']:
        parser.error('--merge must use the same app version.')
    if system == 'Darwin':
        identity = os.environ.get('APPLE_SIGNING_IDENTITY', '').strip()
        if not identity or identity == '-':
            parser.error('Set APPLE_SIGNING_IDENTITY to a persistent code-signing certificate. See docs/updating.md.')
        sign_runtime(identity)
    subprocess.run([sys.executable, str(ROOT / 'scripts/collect-licenses.py')], cwd=ROOT, check=True)
    bundles, pattern, suffix = {
        'Darwin': ('app,dmg', 'macos/*.app.tar.gz', '.app.tar.gz'),
        'Linux': ('appimage', 'appimage/*.AppImage', '.AppImage'),
        'Windows': ('nsis', 'nsis/*.exe', '.exe'),
    }[system]
    started = time.time()
    build_env = os.environ.copy()
    if system == 'Linux':
        # PyInstaller sets this when running its worker. linuxdeploy also needs
        # the private library paths while inspecting the frozen OCR resources.
        libraries = sorted({str(file.parent) for file in (ROOT / 'src-tauri/resources/runtime/ocr').rglob('*.so*')})
        build_env['LD_LIBRARY_PATH'] = os.pathsep.join(filter(None, [build_env.get('LD_LIBRARY_PATH'), *libraries]))
    subprocess.run([shutil.which('npm') or 'npm', 'run', 'tauri', '--', 'build', '--bundles', bundles,
                    '--config', json.dumps({'bundle': {'createUpdaterArtifacts': True}})], cwd=ROOT, env=build_env, check=True)
    artifacts = [file for file in (ROOT / 'src-tauri/target/release/bundle').glob(pattern)
                 if pathlib.Path(str(file) + '.sig').is_file() and pathlib.Path(str(file) + '.sig').stat().st_mtime >= started]
    if len(artifacts) != 1:
        raise SystemExit('Expected one newly signed updater file in src-tauri/target/release/bundle.')
    artifact = artifacts[0]
    signature = pathlib.Path(str(artifact) + '.sig').read_text().strip()
    target = {'Darwin': 'darwin', 'Linux': 'linux', 'Windows': 'windows'}[system] + '-' + architecture
    name = f'Anywhere_Plamo_{config["version"]}_{target}{suffix}'
    result = manifest(config, target, name, signature, previous)
    if system == 'Darwin':
        app = artifact.parent / 'Anywhere Plamo.app'
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        subprocess.run(['codesign', '-d', '-r-', str(app)], check=True)
    output = ROOT / '.runtime-build/updates' / config['version']
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(artifact, output / name)
    (output / (name + '.sig')).write_text(signature + '\n')
    (output / 'latest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'Ready: {output}\nNo files have been uploaded.')


if __name__ == '__main__':
    main()
