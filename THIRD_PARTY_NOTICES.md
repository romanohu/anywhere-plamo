# Third-party notices

The MIT license in this repository covers Anywhere Plamo's original source code.

| Component | License | Source |
| --- | --- | --- |
| Tauri and its official plugins | MIT / Apache-2.0 | https://github.com/tauri-apps |
| llama.cpp | MIT; vendored components retain their own notices | https://github.com/ggml-org/llama.cpp |
| PLaMo 3 Translate model | PLaMo Community License | https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF |

The model is downloaded separately from PFN's official distribution. It is not
relicensed under MIT. Users must follow the model's license, including its
commercial-use terms.

`scripts/build-runtime.py` copies llama.cpp's LICENSE and the license/notice files
under its vendor and ggml directories into the bundled runtime directory.
`scripts/collect-licenses.py` collects license texts for Rust dependencies into
the same directory before release builds. Those notices must accompany the binary.

Built with PLaMo. Anywhere Plamo is an independent project and is not an official
Preferred Networks application.
