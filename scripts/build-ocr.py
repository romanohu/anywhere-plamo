"""Build the offline OCR runtime for the host Linux/macOS architecture."""
import hashlib
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / ".runtime-build"
OUTPUT = ROOT / "src-tauri/resources/runtime"
TESSERACT = "7e548e6eff172f38f97664afe7f7ce40db36c8d6"  # 5.5.4
LEPTONICA = "13275a278eb55b5746e33f95fbf5a2c8f604b3ab"  # 1.87.0
TESSDATA = "87416418657359cb625c412a48b6e1d6d41c29bd"


def download(name, url, checksum):
    path = WORK / name
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        urllib.request.urlretrieve(url, path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        raise SystemExit(f"Checksum mismatch: {name}")
    return path


def main():
    if platform.system() not in {"Linux", "Darwin"}:
        raise SystemExit("Build OCR on Linux or macOS.")
    if not shutil.which("cmake"):
        raise SystemExit("CMake and a C/C++ compiler are required.")
    WORK.mkdir(exist_ok=True)
    for project, owner, revision, checksum in [
        ("tesseract", "tesseract-ocr", TESSERACT, "445603ab1d0a63df552e193a600d9d5c4021aff36e144f3091af149e5efb381a"),
        ("leptonica", "DanBloomberg", LEPTONICA, "e72242133adf678e8584081a506ca3a665c8f6f6de8c3fe7b47d1d5fcf9a4ce4"),
    ]:
        archive = download(f"{project}.tar.gz", f"https://github.com/{owner}/{project}/archive/{revision}.tar.gz", checksum)
        if not (WORK / f"{project}-{revision}").exists():
            with tarfile.open(archive) as source:
                source.extractall(WORK, filter="data")
    common = ["-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF"]
    if platform.system() == "Darwin":
        common += ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3"]
    prefix = WORK / "ocr-prefix"
    parallel = str(min(os.cpu_count() or 2, 8))
    lept = WORK / f"leptonica-{LEPTONICA}"
    tess = WORK / f"tesseract-{TESSERACT}"
    # PPM input keeps the executable independent of system image codecs.
    subprocess.run(["cmake", "-S", str(lept), "-B", str(WORK / "ocr-leptonica"), *common,
                    f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DBUILD_PROG=OFF", "-DSW_BUILD=OFF",
                    *[f"-DENABLE_{codec}=OFF" for codec in ("ZLIB", "PNG", "GIF", "JPEG", "TIFF", "WEBP", "OPENJPEG")]], check=True)
    subprocess.run(["cmake", "--build", str(WORK / "ocr-leptonica"), "--parallel", parallel], check=True)
    subprocess.run(["cmake", "--install", str(WORK / "ocr-leptonica")], check=True)
    build = WORK / "ocr-tesseract"
    subprocess.run(["cmake", "-S", str(tess), "-B", str(build), *common,
                    f"-DCMAKE_PREFIX_PATH={prefix}", "-DENABLE_NATIVE=OFF", "-DOPENMP_BUILD=OFF",
                    "-DBUILD_TRAINING_TOOLS=OFF", "-DBUILD_TESTS=OFF", "-DGRAPHICS_DISABLED=ON",
                    "-DDISABLED_LEGACY_ENGINE=ON", "-DDISABLE_TIFF=ON", "-DDISABLE_CURL=ON",
                    "-DDISABLE_ARCHIVE=ON"], check=True)
    subprocess.run(["cmake", "--build", str(build), "--target", "tesseract",
                    "--config", "Release", "--parallel", parallel], check=True)
    data = OUTPUT / "tessdata"
    data.mkdir(parents=True, exist_ok=True)
    for name, checksum in [
        ("eng.traineddata", "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"),
        ("jpn.traineddata", "1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d"),
        ("LICENSE", "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"),
    ]:
        cached = download("tessdata-LICENSE" if name == "LICENSE" else name,
                          f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{TESSDATA}/{name}", checksum)
        shutil.copy2(cached, data / name)
    shutil.copy2(build / "bin/tesseract", OUTPUT / "tesseract")
    if platform.system() == "Darwin":
        subprocess.run(["codesign", "--force", "--sign", "-", str(OUTPUT / "tesseract")], check=True)
    shutil.copy2(tess / "LICENSE", OUTPUT / "tesseract-LICENSE")
    shutil.copy2(lept / "leptonica-license.txt", OUTPUT / "leptonica-LICENSE")
    (OUTPUT / "OCR_VERSION").write_text(
        f"tesseract {TESSERACT}\nleptonica {LEPTONICA}\ntessdata_fast {TESSDATA}\n", encoding="utf-8")
    print(f"OCR ready: {OUTPUT / 'tesseract'}")


if __name__ == "__main__":
    main()
