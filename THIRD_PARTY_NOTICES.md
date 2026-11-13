# Third-party notices

The MIT license in this repository covers Anywhere Plamo's original source code.

| Component | License | Source |
| --- | --- | --- |
| Tauri and its official plugins | MIT / Apache-2.0 | https://github.com/tauri-apps |
| llama.cpp | MIT; vendored components retain their own notices | https://github.com/ggml-org/llama.cpp |
| PaddleOCR PP-OCRv6 small / Korean PP-OCRv5 mobile / RapidOCR | Apache-2.0; upstream weights belong to Baidu / PaddleOCR rights holders | https://github.com/PaddlePaddle/PaddleOCR · https://github.com/RapidAI/RapidOCR |
| ONNX Runtime | MIT | https://github.com/microsoft/onnxruntime |
| Python and OCR dependencies | PSF-2.0 and their respective licenses (bundled in `ocr/licenses`) | https://www.python.org/ · https://pypi.org/project/rapidocr/ |
| PLaMo 3 Translate 0.8B GGUF (Q4_K_M) | [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) | https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF |

The model is downloaded separately from PFN's official distribution. It is not
relicensed under MIT. The [official model card](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF#license)
and the license state:

- Personal and non-commercial use is free and requires no registration.
- Business and commercial use, including internal organizational use, requires
  prior [PFN registration](https://forms.gle/mTL8tBLrMYXKNZD56) when the user's or
  its affiliates' revenue or sales in the latest fiscal year does not exceed
  JPY 1 billion. Above that threshold, a separate PFN license is required.
- Providing model materials (including outputs) to third parties requires a
  copy of the agreement and the attribution specified in Article 4. Publishing
  outputs requires identifying them as PLaMo outputs under Article 5.

The full model license governs; this summary does not replace it.

`scripts/build-runtime.py` copies llama.cpp's LICENSE and the license/notice files
under its vendor and ggml directories into the bundled runtime directory.
`scripts/build-ocr.py` bundles PP-OCRv6 small models converted to ONNX by RapidOCR,
a self-contained Python worker, and their license texts. RapidOCR’s
`MODEL_LICENSES.md` records the v6 model provenance and attribution; the Korean model
is an optional in-app download, attributed in `ocr-models/KOREAN_NOTICE.txt` and its [upstream model card](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec). Dependency and
native-library notices are included under `ocr/licenses`.
`scripts/collect-licenses.py` collects license texts for Rust dependencies into
the same directory before release builds. Those notices must accompany the binary.

Built with PLaMo. Anywhere Plamo is an independent project and is not an official
Preferred Networks application.
