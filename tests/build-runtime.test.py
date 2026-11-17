"""Check CUDA architecture detection for runtime builds."""
import importlib.util
import os
import pathlib
import subprocess
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_runtime', ROOT / 'scripts/build-runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class CudaArchitectureTests(unittest.TestCase):
    def test_parses_and_deduplicates_compute_capabilities(self):
        self.assertEqual(runtime.parse_compute_caps('8.9\n8.6\n8.9\n'), '89;86')
        self.assertEqual(runtime.parse_compute_caps('[N/A]\n\n'), '')

    def test_environment_overrides_detection(self):
        with mock.patch.dict(os.environ, {'CUDAARCHS': '75'}), mock.patch.object(runtime.subprocess, 'run') as run:
            self.assertEqual(runtime.cuda_architectures(), '75')
        run.assert_not_called()

    def test_searches_known_locations_when_path_has_none(self):
        found = subprocess.CompletedProcess([], 0, stdout='8.9\n')
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(runtime.shutil, 'which', return_value=None), \
                mock.patch.object(runtime.os.path, 'isfile', side_effect=lambda path: path == '/usr/lib/wsl/lib/nvidia-smi'), \
                mock.patch.object(runtime.subprocess, 'run', return_value=found) as run:
            self.assertEqual(runtime.cuda_architectures(), '89')
        self.assertEqual(run.call_args.args[0][0], '/usr/lib/wsl/lib/nvidia-smi')

    def test_falls_back_to_default_without_gpu(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(runtime.shutil, 'which', return_value='/usr/bin/nvidia-smi'), \
                mock.patch.object(runtime.os.path, 'isfile', return_value=True), \
                mock.patch.object(runtime.subprocess, 'run', side_effect=subprocess.CalledProcessError(9, 'nvidia-smi')):
            self.assertEqual(runtime.cuda_architectures(), '')


if __name__ == '__main__':
    unittest.main()
