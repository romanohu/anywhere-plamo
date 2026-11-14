"""Bundle the offline PaddleOCR worker for the host architecture."""
import hashlib
import json
import pathlib
import platform
import shutil
import subprocess
import sys
import urllib.request
import venv

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / ".runtime-build"
OUTPUT = ROOT / "src-tauri/resources/runtime"
PACKAGES = {"rapidocr": "3.10.0", "onnxruntime": "1.23.2", "opencv-python-headless": "4.11.0.86",
            "numpy": "2.2.6", "Pillow": "12.0.0", "pyinstaller": "6.22.0"}
MODELS = {"det": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
          "rec": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"}
KOREAN_SHA256 = 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b'


def download(name, url, checksum):
    path = WORK / name
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        temporary = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(url, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != checksum:
            raise SystemExit(f"Checksum mismatch: {name}")
        temporary.replace(path)
    return path


def main():
    if platform.system() not in {"Linux", "Darwin", "Windows"}:
        raise SystemExit("Build OCR on Linux, macOS or Windows.")
    if not (3, 12) <= sys.version_info[:2] <= (3, 13):
        raise SystemExit("Build OCR with Python 3.12 or 3.13.")
    WORK.mkdir(exist_ok=True)
    environment = WORK / "ocr-venv"
    python = environment / ("Scripts/python.exe" if platform.system() == "Windows" else "bin/python")
    executable = "ocr-worker.exe" if platform.system() == "Windows" else "ocr-worker"
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    # OpenCV variants share the cv2 namespace. Remove both the old GUI wheel and
    # any overlapping variant before installing the pinned headless dependency.
    opencv = json.loads(subprocess.check_output([str(python), "-c", '''
import importlib.metadata as m,json
print(json.dumps([d.metadata['Name'] for d in m.distributions() if d.metadata['Name'].lower().replace('_','-') in
    {'opencv-python','opencv-python-headless','opencv-contrib-python','opencv-contrib-python-headless'}]))
'''], text=True))
    if any(name.lower().replace('_', '-') != 'opencv-python-headless' for name in opencv):
        subprocess.run([str(python), "-m", "pip", "uninstall", "-y", *opencv], check=True)
    check = "import importlib.metadata as m,json; print(json.dumps({k:m.version(k) for k in " + repr(list(PACKAGES)) + "}))"
    installed = subprocess.run([str(python), "-c", check], capture_output=True, text=True)
    if installed.returncode or json.loads(installed.stdout) != PACKAGES:
        subprocess.run([str(python), "-m", "pip", "install", *[f"{k}=={v}" for k, v in PACKAGES.items()]], check=True)
    models = OUTPUT / "ocr-models"
    models.mkdir(parents=True, exist_ok=True)
    for task, checksum in MODELS.items():
        name = f"PP-OCRv6_{task}_small.onnx"
        cached = download(name, f"https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/{task}/{name}", checksum)
        shutil.copy2(cached, models / name)
    korean = 'korean_PP-OCRv5_rec_mobile.onnx'
    # Korean recognition is an optional in-app download, not a bundled weight.
    (models / korean).unlink(missing_ok=True)
    (models / 'KOREAN_NOTICE.txt').write_text(
        'Korean PP-OCRv5 mobile: copyright Baidu / PaddleOCR rights holders, Apache-2.0.\n'
        'Upstream: https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec\n'
        'ONNX conversion: RapidAI/RapidOCR v3.10.0, korean_PP-OCRv5_rec_mobile.onnx\n'
        f'SHA256: {KOREAN_SHA256}\n'
        'Apache-2.0 license text is included under ocr/licenses/rapidocr-3.10.0/.\n', encoding='utf-8')
    package = pathlib.Path(subprocess.check_output(
        [str(python), "-X", "utf8", "-c", "import rapidocr,pathlib;print(pathlib.Path(rapidocr.__file__).parent)"], text=True, encoding="utf-8").strip())
    subprocess.run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
                    "--name", "ocr-worker", "--distpath", str(WORK / "ocr-dist"),
                    "--workpath", str(WORK / "ocr-freeze"), "--specpath", str(WORK),
                    "--add-data", f"{package / 'config.yaml'}:rapidocr",
                    "--add-data", f"{package / 'default_models.yaml'}:rapidocr",
                    "--collect-data", "onnxruntime",
                    "--copy-metadata", "rapidocr", "--copy-metadata", "onnxruntime",
                    str(ROOT / "scripts/ocr-worker.py")], check=True)
    bundle = WORK / "ocr-dist/ocr-worker"
    # Keep all dependency license files, including native libraries' notices.
    subprocess.run([str(python), "-c", '''
import importlib.metadata as m,json,pathlib,shutil,sys,sysconfig
out=pathlib.Path(sys.argv[1]);out.mkdir(exist_ok=True)
index=[]
for dist in m.distributions():
    name=dist.metadata['Name'];version=dist.version
    index.append({'name':name,'version':version,'license':dist.metadata.get('License-Expression') or dist.metadata.get('License')})
    for file in dist.files or []:
        if any(part.lower().startswith(('license','copying','notice','model_licenses')) for part in file.parts):
            source=pathlib.Path(dist.locate_file(file))
            if source.is_file():
                target=out/(name+'-'+version)/str(file);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
license=pathlib.Path(sysconfig.get_path('stdlib'))/'LICENSE.txt'
if not license.is_file(): license=pathlib.Path(sys.base_prefix)/'LICENSE.txt'
if license.is_file(): shutil.copy2(license,out/'Python-LICENSE.txt')
(out/'index.json').write_text(json.dumps(index,indent=2)+'\\n')
''', str(bundle / "licenses")], check=True)
    # Smoke test the frozen executable, with the same pipe protocol as the app.
    request = ''.join(json.dumps({'path': str(ROOT / f'tests/fixtures/ocr-{name}.png')}) + '\n'
                      for name in ['japanese', 'english'])
    smoke = subprocess.run([str(bundle / executable), str(models)], input=request,
                           capture_output=True, text=True, encoding="utf-8", check=True, timeout=60)
    responses = [json.loads(line)['blocks'] for line in smoke.stdout.splitlines()]
    if len(responses) != 2 or not any('画像' in block['text'] for block in responses[0]) or not all(
            any(word in block['text'] for block in responses[1]) for word in ['Local translation']):
        raise SystemExit("Bundled OCR smoke test failed.")
    destination = OUTPUT / "ocr"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(bundle, destination, symlinks=True)
    (OUTPUT / "OCR_VERSION").write_text(
        "PP-OCRv6 small (RapidOCR 3.10.0 / ONNX Runtime 1.23.2)\n" +
        "\n".join(f"{task} {checksum}" for task, checksum in MODELS.items()) +
        f"\noptional-korean-rec {KOREAN_SHA256}\n", encoding="utf-8")
    # Remove obsolete bundled OCR files when updating an existing source checkout.
    for name in ["tesseract", "tessdata", "tesseract-LICENSE", "leptonica-LICENSE"]:
        old = OUTPUT / name
        if old.is_dir():
            shutil.rmtree(old)
        elif old.exists():
            old.unlink()
    print(f"OCR ready: {destination / executable}")


if __name__ == "__main__":
    main()
