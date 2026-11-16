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


NVIDIA_SMI_PATHS = ("/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi",
                    r"C:\Windows\System32\nvidia-smi.exe")


def parse_compute_caps(output):
    """Turn nvidia-smi compute_cap lines such as '8.9' into a CMake list such as '89'."""
    caps = []
    for line in output.splitlines():
        major, dot, minor = line.strip().partition(".")
        if dot and major.isdigit() and minor.isdigit() and major + minor not in caps:
            caps.append(major + minor)
    return ";".join(caps)


def cuda_architectures():
    """CUDAARCHS if set, else the installed GPUs; searches known nvidia-smi locations when PATH has none."""
    if os.environ.get("CUDAARCHS"):
        return os.environ["CUDAARCHS"]
    for nvidia_smi in dict.fromkeys([shutil.which("nvidia-smi"), *NVIDIA_SMI_PATHS]):
        if not nvidia_smi or not os.path.isfile(nvidia_smi):
            continue
        try:
            output = subprocess.run([nvidia_smi, "--query-gpu=compute_cap", "--format=csv,noheader"],
                                    capture_output=True, text=True, check=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        if architectures := parse_compute_caps(output):
            return architectures
    print("No NVIDIA GPU found; building for ggml's default CUDA architectures.", flush=True)
    return ""


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
    # Target only the installed GPUs instead of ggml's slow multi-arch default when they can be found.
    if options.backend == 'cuda' and (architectures := cuda_architectures()):
        print(f"CUDA architectures: {architectures}", flush=True)
        args.append(f"-DCMAKE_CUDA_ARCHITECTURES={architectures}")
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
    # The CUDA server sits beside the CPU one; the app uses it when it can see a GPU, else falls back.
    installed = executable.replace("llama-server", "llama-server-cuda") if options.backend == "cuda" else executable
    shutil.copy2(binary, OUTPUT / installed)
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
    version = "VERSION-cuda" if options.backend == "cuda" else "VERSION"
    (OUTPUT / version).write_text(f"llama.cpp {REVISION}\nbackend {options.backend}\n", encoding="utf-8")
    print(f"Runtime ready: {OUTPUT / installed}")
    subprocess.run([sys.executable, str(ROOT / "scripts/build-ocr.py")], check=True)


if __name__ == "__main__":
    main()
