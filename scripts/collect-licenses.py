"""Copy Cargo dependency license files into the app's bundled resources."""
import json
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--format-version=1", "--manifest-path", str(root / "src-tauri/Cargo.toml"),
], text=True))
destination = root / "src-tauri/resources/runtime/rust-licenses"
destination.mkdir(parents=True, exist_ok=True)
index = []
for package in metadata["packages"]:
    if package["source"] is None:
        continue
    source = pathlib.Path(package["manifest_path"]).parent
    folder = destination / f'{package["name"]}-{package["version"]}'
    candidates = [file for file in source.iterdir()
                  if file.is_file() and file.name.lower().startswith(("license", "copying", "notice"))]
    if package.get("license_file"):
        candidates.append(source / package["license_file"])
    for file in candidates:
        if file.is_file():
            folder.mkdir(exist_ok=True)
            shutil.copy2(file, folder / file.name)
    index.append({"name": package["name"], "version": package["version"],
                  "license": package["license"], "repository": package["repository"]})
(destination / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
