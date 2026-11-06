"""Run the prompt/framing tests without downloading desktop dependencies."""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="anywhere-plamo-tests-") as directory:
    binary = pathlib.Path(directory) / "protocol-tests"
    subprocess.run([
        "rustc", "--edition=2021", "--test",
        str(root / "src-tauri/src/protocol.rs"), "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
