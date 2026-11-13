"""Prepare the offline Android OCR assets and native translation library."""
import argparse
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = runpy.run_path(str(ROOT / "scripts/build-runtime.py"))
OCR = runpy.run_path(str(ROOT / "scripts/build-ocr.py"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['aarch64', 'x86_64'], action='append')
    args = parser.parse_args()
    ndk = Path(os.environ.get('NDK_HOME', ''))
    toolchain = ndk / 'build/cmake/android.toolchain.cmake'
    if not toolchain.is_file():
        raise SystemExit('Set NDK_HOME to an installed Android NDK (r28 or later).')
    llvm = next((ndk / 'toolchains/llvm/prebuilt').iterdir())
    source = RUNTIME['SOURCE']
    work = RUNTIME['WORK']
    work.mkdir(exist_ok=True)
    if not source.is_dir():
        archive = work / 'llama.cpp.tar.gz'
        urllib.request.urlretrieve(f"https://github.com/ggml-org/llama.cpp/archive/{RUNTIME['REVISION']}.tar.gz", archive)
        with tarfile.open(archive) as package:
            package.extractall(work, filter='data')
        archive.unlink()
    output = ROOT / 'src-tauri/resources/android'
    include = output / 'include'
    include.mkdir(parents=True, exist_ok=True)
    for directory in [source / 'include', source / 'ggml/include']:
        for header in directory.glob('*.h'):
            shutil.copy2(header, include / header.name)
    for target in args.target or ['aarch64']:
        triple = f'{target}-linux-android'
        abi = 'arm64-v8a' if target == 'aarch64' else 'x86_64'
        build = work / f'android-{target}'
        subprocess.run(['cmake', '-S', str(source), '-B', str(build), '-G', 'Ninja',
                        f'-DCMAKE_TOOLCHAIN_FILE={toolchain.resolve()}', f'-DANDROID_ABI={abi}',
                        '-DANDROID_PLATFORM=android-28', '-DANDROID_STL=c++_static',
                        '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
                        '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DGGML_LLAMAFILE=OFF',
                        '-DGGML_METAL=OFF', '-DLLAMA_OPENSSL=OFF', '-DLLAMA_BUILD_TESTS=OFF',
                        '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_APP=OFF', '-DLLAMA_BUILD_SERVER=OFF',
                        '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_BUILD_TOOLS=OFF', '-DLLAMA_CURL=OFF'], check=True)
        subprocess.run(['cmake', '--build', str(build), '--target', 'llama', '--parallel', str(min(os.cpu_count() or 2, 8))], check=True)
        destination = output / triple
        destination.mkdir(parents=True, exist_ok=True)
        for name in ['llama', 'ggml', 'ggml-base', 'ggml-cpu']:
            library = next(build.rglob(f'lib{name}.a'))
            shutil.copy2(library, destination / library.name)
        # Use the NDK's 16 KB aligned C++ runtime instead of the older OpenCV copy.
        jni = ROOT / 'src-tauri/gen/android/app/src/main/jniLibs' / abi
        jni.mkdir(parents=True, exist_ok=True)
        shutil.copy2(llvm / 'sysroot/usr/lib' / triple / 'libc++_shared.so', jni / 'libc++_shared.so')
    assets = ROOT / 'src-tauri/ocr-mobile/android/src/main/assets'
    models = assets / 'ocr'
    models.mkdir(parents=True, exist_ok=True)
    for task, checksum in OCR['MODELS'].items():
        name = f'PP-OCRv6_{task}_small.onnx'
        model = OCR['download'](name, f'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/{task}/{name}', checksum)
        shutil.copy2(model, models / name)
    licenses = assets / 'licenses'
    licenses.mkdir(exist_ok=True)
    shutil.copytree(ROOT / 'src-tauri/ocr-mobile/licenses', licenses, dirs_exist_ok=True)
    shutil.copy2(source / 'LICENSE', licenses / 'llama.cpp-LICENSE')
    shutil.copy2(ROOT / 'LICENSE', licenses / 'Anywhere-Plamo-LICENSE')
    shutil.copy2(llvm / 'NOTICE', licenses / 'LLVM-NOTICE')
    for base in [source / 'vendor', source / 'ggml']:
        for file in base.rglob('*'):
            if file.is_file() and file.name.lower().startswith(('license', 'copying', 'notice')):
                destination = licenses / 'llama-vendor' / file.relative_to(source)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, destination)
    # PaddleOCR / RapidOCR model notices are also kept in the Android package.
    for name in ['LICENSE', 'NOTICE']:
        path = ROOT / 'src-tauri/ocr-mobile' / name
        if path.exists():
            shutil.copy2(path, licenses / f'OCR-{name}')
    subprocess.run([sys.executable, str(ROOT / 'scripts/collect-licenses.py'), '--output', str(licenses / 'rust')], check=True)
    print('Android runtime and OCR models are ready.')


if __name__ == '__main__':
    main()
