# 開発

作業は `dev` で進めます。GitHub Actionsは手動実行のみとし、停止中のコミットには `[skip ci]` を含めます。

## 構成

- `gui/web/`: HTML・TypeScript・CSS。入力、選択翻訳、OCRレンズ、カメラ、PDFの画面と表示レイアウト。
- `gui/native/`: Tauriアプリ。ウィンドウ、ショートカット、画面取得、OCRワーカー、モデル取得、設定保存、更新。
- `core/`: GUIに依存しないRustライブラリ。推論エンジンの起動・再利用、辞書適用、キャッシュ、文章の分割と一括翻訳。
- `scripts/`: ランタイムの準備、配布用ビルド、実画面の検証。
- `tests/`: 画面・OCR・更新の回帰テストと共通の入力データ。

画面は `gui/web/backend.ts` からTauriのコマンドを呼び、ネイティブ側が `plamo-core::Service` に翻訳を依頼します。コアにはモデルと実行ファイルのパス、翻訳先、辞書を渡します。進捗はコールバック、中断は `CancellationToken` で扱い、ウィンドウやTauriの型は渡しません。各ウィンドウの処理状態と中断操作はネイティブ側が管理します。

画像やPDFの読み取り・配置は各機能が担当し、コアには文字列を渡します。長いPDF本文の分割と複数領域の順次翻訳はコアで処理します。推論は共有し、文章の区切りで他のウィンドウの要求も処理できます。

## ローカル確認

リポジトリのルートで実行します。起動・配布用ビルドは[セットアップ](README.md#ソースから起動)を参照してください。

```sh
npm run build
npm run test:ui
npm run test:protocol
cargo fmt --all --check
cargo test --workspace
```

コアだけならGUI用のシステムライブラリなしでテストできます。

```sh
cargo test -p plamo-core
```

既存のランタイムとモデルを指定すると、画面なしで実際の翻訳・辞書・キャッシュ・中断・再読み込みを確認できます。テストはモデルをダウンロードしません。

```sh
PLAMO_RUNTIME=/absolute/path/to/llama-server \
PLAMO_MODEL=/absolute/path/to/model.gguf \
cargo test -p plamo-core --test headless -- --ignored --nocapture
```
