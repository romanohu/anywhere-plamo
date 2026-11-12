"""Check release metadata with real Tauri signatures and a disposable test key."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_update', ROOT / 'scripts/build-update.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class UpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.directory = pathlib.Path(cls.temporary.name)
        cls.cli = [shutil.which('npm') or 'npm', 'run', 'tauri', '--']
        key = cls.directory / 'test.key'
        subprocess.run([*cls.cli, 'signer', 'generate', '--ci', '-p', '', '-w', str(key)],
                       cwd=ROOT, check=True, capture_output=True)
        cls.config = {'version': '0.2.2', 'plugins': {'updater': {'pubkey': key.with_suffix('.key.pub').read_text().strip()}}}
        cls.artifact = cls.directory / 'test.AppImage'
        cls.artifact.write_bytes(b'\x7fELFtest update')
        subprocess.run([*cls.cli, 'signer', 'sign', '-f', str(key), '-p', '', '--app-version', '0.2.2', str(cls.artifact)],
                       cwd=ROOT, check=True, capture_output=True)
        cls.signature = pathlib.Path(str(cls.artifact) + '.sig').read_text().strip()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_manifest_uses_signed_version_and_encoded_download_name(self):
        result = release.manifest(self.config, 'darwin-aarch64', 'App Name.app.tar.gz', self.signature)
        self.assertEqual(result['version'], '0.2.2')
        self.assertEqual(result['platforms']['darwin-aarch64']['url'],
                         'https://github.com/romanohu/anywhere-plamo/releases/download/v0.2.2/App%20Name.app.tar.gz')
        merged = release.manifest(self.config, 'linux-x86_64', 'test.AppImage', self.signature, result)
        self.assertEqual(set(merged['platforms']), {'darwin-aarch64', 'linux-x86_64'})

    def test_rejects_mismatched_key_version_or_release(self):
        production = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
        with self.assertRaisesRegex(ValueError, 'key does not match'):
            release.check_signature(self.signature, production['plugins']['updater']['pubkey'], '0.2.2')
        with self.assertRaisesRegex(ValueError, 'signed version'):
            release.check_signature(self.signature, self.config['plugins']['updater']['pubkey'], '0.2.3')
        with self.assertRaisesRegex(ValueError, 'same version'):
            release.manifest(self.config, 'linux-x86_64', 'test.AppImage', self.signature, {'version': '0.2.1'})


if __name__ == '__main__':
    unittest.main()
