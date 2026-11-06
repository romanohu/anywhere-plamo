# Anywhere Plamo

選択した文章をショートカットで翻訳する、Linux・macOS向けの非公式PLaMoクライアントです。PLaMo 3 Translate 0.8Bを端末上で動かし、モデル取得後はオフラインで翻訳できます。

## セットアップ

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

成果物は`src-tauri/target/release/bundle/`に生成されます。macOSの署名・公証は未設定です。

## 使い方

1. 初回起動時に「ダウンロード」から利用条件を確認し、モデルを取得します（約570 MB）。
2. 翻訳先を選び、原文を入力・貼り付けて「翻訳」を押します。`Ctrl+Enter`（Macは`⌘+Enter`）でも翻訳できます。
3. 他のアプリの文章を選択して`Ctrl+Shift+J`（Macは`⌘+Shift+J`）を押すと、その文章を翻訳します。

ショートカットは「設定」でキー表示を押し、使いたい組み合わせを入力して「保存」します。設定は次回起動時も引き継ぎます。Ctrl・Alt・Command/Superを含む組み合わせ、またはF1〜F24を指定できます。

「起動時にモデルを先読み」を有効にすると、初回の翻訳が速くなる代わりに待機中もメモリを使います。オフへの変更は次回起動から反映されます。アプリを終了するには、設定の「終了」を使います。

Macでは「システム設定 → プライバシーとセキュリティ → アクセシビリティ」でアプリを許可してください。

WaylandではOSのキーボード設定で、次のコマンドにキーを割り当てます。AppImageの場合は実行ファイルの絶対パスに置き換えてください。

```sh
anywhere-plamo --translate-selection
```

選択文字の取得はデスクトップ環境と元アプリの対応に依存します。取得できない場合は、コピーして「貼り付け」を使ってください。

## ライセンス

Built with PLaMo. アプリ: [MIT](LICENSE) · モデル: [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) · [第三者ライセンス](THIRD_PARTY_NOTICES.md)

モデルの業務・商用利用（社内利用を含む）には、事前登録またはPFNとの別契約が必要です。

開発では[tanakh/plamo-translate-desktop](https://github.com/tanakh/plamo-translate-desktop)を参考にしています。
