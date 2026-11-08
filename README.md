# Anywhere Plamo

選択した文章をショートカットで翻訳する、Linux・macOS向けの非公式PLaMoクライアントです。PLaMo 3 Translate 0.8Bを端末上で動かし、モデル取得後はオフラインで翻訳できます。

## セットアップ

Mac（macOS 13.3以降）では[Releases](https://github.com/romanohu/anywhere-plamo/releases/latest)から、Apple Silicon用の`aarch64.dmg`またはIntel用の`x64.dmg`を取得し、アプリを「アプリケーション」へ移動してください。

Mac版はアドホック署名のみで未公証です。初回起動がブロックされた場合は「システム設定 → プライバシーとセキュリティ → このまま開く」から許可してください。

### ソースから起動

Node.js 24、Rust 1.90以上、Python 3.12以上、CMake、C/C++コンパイラと[TauriのOS別依存](https://v2.tauri.app/start/prerequisites/)が必要です。

Ubuntu / Debianの追加パッケージ:

```sh
sudo apt install build-essential cmake pkg-config libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

macOSではXcode Command Line ToolsとCMakeを用意してください。

リポジトリのディレクトリで実行します。

```sh
git clone https://github.com/romanohu/anywhere-plamo.git
cd anywhere-plamo
npm ci
npm run runtime:build
npm run tauri dev
```

推論エンジンは初回に取得・ビルドされます。既定ではLinuxはCPU、macOSはMetalを使用します。

配布用ファイルを作る場合:

```sh
python3 scripts/collect-licenses.py
npm run tauri build
```

成果物は`src-tauri/target/release/bundle/`に生成されます。

## 使い方

1. 初回起動時に「ダウンロード」から利用条件を確認し、モデルを取得します（約570 MB）。
2. 翻訳先を選び、原文を入力・貼り付けて「翻訳」を押します。`Ctrl+Enter`（Macは`⌘+Enter`）でも翻訳できます。
3. 他のアプリの文章を選択して`Ctrl+Shift+J`（Macは`⌘+Shift+J`）を押すと、その文章を翻訳します。

ショートカットは「設定」でキー表示を押し、使いたい組み合わせを入力して「保存」します。設定は次回起動時も引き継ぎます。Ctrl・Alt・Command/Superを含む組み合わせ、またはF1〜F24を指定できます。

「選択した文章の日英を自動切替」をオンにすると、日本語の選択文は英語、英語の選択文は日本語へ翻訳します。文字種による簡易判定で、判定できない文章は選択中の翻訳先を使います。

「別ウィンドウで翻訳」をオンにすると、ショートカット翻訳を専用の小窓に表示します。翻訳後に外側をクリックすると閉じます。初期状態はオフです。

Macでは「OCRレンズ」を開き、タイトルバーやウィンドウの端で半透明の枠を移動・拡縮し、「更新」（`⌘+Enter`）で枠内の文字を翻訳できます。画像やPDFも読み取れます。「原文」で背後の画面に切り替え、`Esc`で通常画面に戻ります。初回は画面収録の許可が必要です。レンズは1つの画面内に置いてください。画面の変化には自動追従しないため、スクロール後は再度「更新」します。

「起動時にモデルを先読み」を有効にすると、初回の翻訳が速くなる代わりに待機中もメモリを使います。オフへの変更は次回起動から反映されます。アプリを終了するには、設定の「終了」を使います。

ウィンドウを閉じてもメニューバー／トレイに常駐し、ショートカットを使えます（トレイを利用できる環境のみ）。画面を出さずに起動するには、Macでは`open -a "Anywhere Plamo" --args --background`、Linuxでは`anywhere-plamo --background`を使います。

Macでは「システム設定 → プライバシーとセキュリティ → アクセシビリティ」でアプリを許可してください。PDFなどで選択文字を直接取得できない場合は、コピー操作で取得して元のクリップボードを復元します。

WaylandではOSのキーボード設定で、次のコマンドにキーを割り当てます。AppImageの場合は実行ファイルの絶対パスに置き換えてください。

```sh
anywhere-plamo --translate-selection
```

選択文字の取得はデスクトップ環境と元アプリの対応に依存します。取得できない場合は、コピーして「貼り付け」を使ってください。

## ライセンス

Built with PLaMo. アプリ: [MIT](LICENSE) · モデル: [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) · [第三者ライセンス](THIRD_PARTY_NOTICES.md)
