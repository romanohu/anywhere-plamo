"""Build a pinned llama.cpp server for the host architecture."""
import argparse
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

REVISION = "cd959bae99ff4bed22bef2604f45241c09bbb8c8"  # llama.cpp v0.9.0
ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / ".runtime-build"
SOURCE = WORK / f"llama.cpp-{REVISION}"
OUTPUT = ROOT / "src-tauri/resources/runtime"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('cpu', 'cuda', 'vulkan', 'metal'),
                        default='metal' if platform.system() == 'Darwin' else 'cpu')
    options = parser.parse_args()
    if platform.system() not in {"Linux", "Darwin", "Windows"}:
        raise SystemExit("Build on Linux, macOS or Windows.")
    if options.backend == 'metal' and platform.system() != 'Darwin':
        parser.error('Metal requires macOS.')
    if options.backend == 'cuda' and platform.system() not in {'Linux', 'Windows'}:
        parser.error('CUDA requires Linux or Windows.')
    if not shutil.which("cmake"):
        raise SystemExit("CMake is required. Install it, then run npm run runtime:build again.")
    WORK.mkdir(exist_ok=True)
    if not SOURCE.exists():
        archive = WORK / "llama.cpp.tar.gz"
        print(f"Downloading llama.cpp {REVISION}", flush=True)
        urllib.request.urlretrieve(
            f"https://github.com/ggml-org/llama.cpp/archive/{REVISION}.tar.gz", archive
        )
        with tarfile.open(archive) as source:
            source.extractall(WORK, filter="data")
        archive.unlink()

    build = WORK / f"build-{options.backend}"
    args = [
        "cmake", "-S", str(SOURCE), "-B", str(build),
        "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF",
        f"-DGGML_CUDA={'ON' if options.backend == 'cuda' else 'OFF'}",
        f"-DGGML_VULKAN={'ON' if options.backend == 'vulkan' else 'OFF'}",
        f"-DGGML_METAL={'ON' if options.backend == 'metal' else 'OFF'}",
        "-DLLAMA_OPENSSL=OFF", "-DLLAMA_BUILD_TESTS=OFF",
        "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_APP=OFF",
        "-DLLAMA_BUILD_SERVER=ON", "-DLLAMA_BUILD_UI=OFF",
        "-DLLAMA_USE_PREBUILT_UI=OFF", "-DLLAMA_SUBPROCESS=OFF",
    ]
    if platform.system() == "Darwin":
        args += ["-DGGML_METAL_EMBED_LIBRARY=ON", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3"]
    if platform.system() == "Windows":
        args += ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
    subprocess.run(args, check=True)
    subprocess.run(["cmake", "--build", str(build), "--target", "llama-server",
                    "--config", "Release", "--parallel", str(min(os.cpu_count() or 2, 8))], check=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    executable = "llama-server.exe" if platform.system() == "Windows" else "llama-server"
    binary = build / "bin" / executable
    if not binary.is_file():
        binary = build / "bin/Release" / executable
    shutil.copy2(binary, OUTPUT / executable)
    # CUDA builds can produce required runtime DLLs next to the executable.
    if platform.system() == "Windows":
        for library in binary.parent.glob("*.dll"):
            shutil.copy2(library, OUTPUT / library.name)
    if platform.system() == "Darwin":
        # Tauri signs app binaries, but does not sign executables in resources.
        subprocess.run(["codesign", "--force", "--sign", "-", str(OUTPUT / "llama-server")],
                       check=True)
    # Keep upstream notices with the distributed executable.
    shutil.copy2(SOURCE / "LICENSE", OUTPUT / "llama.cpp-LICENSE")
    licenses = OUTPUT / "vendor-licenses"
    licenses.mkdir(exist_ok=True)
    for base in (SOURCE / "vendor", SOURCE / "ggml"):
        for file in base.rglob("*"):
            if file.is_file() and file.name.lower().startswith(("license", "copying", "notice")):
                target = licenses / file.relative_to(SOURCE)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
    (OUTPUT / "VERSION").write_text(f"llama.cpp {REVISION}\nbackend {options.backend}\n", encoding="utf-8")
    print(f"Runtime ready: {OUTPUT / executable}")
    subprocess.run([sys.executable, str(ROOT / "scripts/build-ocr.py")], check=True)


if __name__ == "__main__":
    main()
