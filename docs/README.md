# ドキュメント

[プロジェクトの紹介](../README.md) · [アプリのダウンロード](https://github.com/romanohu/anywhere-plamo/releases/latest)

- [セットアップ](#セットアップ)
- [ソースから起動・ビルド](#ソースから起動)
- [Android版](#android開発版)
- [使い方](#使い方)
- [ライセンス](#ライセンス)

## セットアップ

Mac版は[Releases](https://github.com/romanohu/anywhere-plamo/releases/latest)からApple Silicon用の`aarch64.dmg`を取得し、アプリを「アプリケーション」へ移動してください。macOS 13.4以降に対応しています。その他のOS・アーキテクチャの配布状況は各リリースを確認してください。

Mac版はアドホック署名のみで未公証です。初回起動がブロックされた場合は「システム設定 → プライバシーとセキュリティ → このまま開く」から許可してください。

### ソースから起動

Node.js 24、Rust 1.90以上、Python 3.12または3.13、CMake、C/C++コンパイラと[TauriのOS別依存](https://v2.tauri.app/start/prerequisites/)が必要です。

Ubuntu / Debianの追加パッケージ:

```sh
sudo apt install build-essential cmake pkg-config python3-venv libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

macOSではXcode Command Line ToolsとCMakeを用意してください。

Windows 11 x64版は開発中で、実機動作は未確認です。Visual Studio Build Toolsの「C++によるデスクトップ開発」、WebView2、Visual C++再頒布可能パッケージを用意してください。以下の`npm run runtime:build`は`py -3.12 scripts/build-runtime.py`に置き換えます。CPUが既定で、Vulkan SDKを用意すれば`--backend vulkan`でGPU版をビルドできます。

リポジトリのディレクトリで実行します。

```sh
git clone https://github.com/romanohu/anywhere-plamo.git
cd anywhere-plamo
npm ci
npm run runtime:build
npm run tauri dev
```

推論エンジンとPaddleOCRの小型モデル・実行環境（日本語・英語、日本語の縦書きを含む）は初回に取得・ビルドされます。配布版ではPythonのインストールは不要です。既存のソース版は `npm run ocr:build` でOCRデータを更新してください。翻訳の推論は既定でLinux・WindowsはCPU、macOSはMetalを使用します。OCRは各OSともCPUで動きます。

配布用ファイルを作る場合:

```sh
python3 scripts/collect-licenses.py
npm run tauri build
```

成果物は`src-tauri/target/release/bundle/`に生成されます。アプリ内更新用の配布物とMacの継続した署名については[更新の配布手順](updating.md)を参照してください。

Windowsでは`py -3.12 scripts/collect-licenses.py`の後、`npm run tauri -- build --bundles nsis`でインストーラーを作ります。画面取得・選択翻訳・表示倍率を実機で確認してから配布してください。

### Android（開発版）

Android 9以降のARM64端末向けAPKは[Releases](https://github.com/romanohu/anywhere-plamo/releases)から取得できます。

Android版のビルドには、上記に加えてJDK 17以上、Android SDK（API 36・Build Tools 36.0.0）、NDK r28以上、Ninjaが必要です。`JAVA_HOME`・`ANDROID_HOME`・`NDK_HOME`を設定して実行します。Android 9以降の64bit端末が対象です。実機での動作・発熱は未確認です。

```sh
rustup target add aarch64-linux-android
npm ci
npm run android:prepare
npm run tauri -- android build --debug --apk --target aarch64
```

検証用APKは`src-tauri/gen/android/app/build/outputs/apk/universal/debug/`に生成されます。翻訳モデルは初回起動後に取得します。Android版は文章の入力・貼り付け、カメラ翻訳、他のアプリに重ねる画面OCRレンズに対応します。レンズは初回に重ね表示と画面共有を許可して使います。

署名付きAPKの作成は[Android配布手順](android-testing.md#配布用apk)を参照してください。

## 使い方

1. 初回は「ダウンロード」から利用条件を確認し、モデルを取得します（標準は約573 MB）。
2. 翻訳先を選び、原文を入力・貼り付けて「翻訳」を押します。`Ctrl+Enter`（Macは`⌘+Enter`）でも実行できます。
3. 他のアプリでは文章を選択し、`Ctrl+Shift+J`（Macは`⌘+Shift+J`）で翻訳します。取得できない場合は、コピーして「貼り付け」を使ってください。

「辞書」から原語と訳語を登録すると、翻訳の前に原文中の語句を訳語へ置き換えてから翻訳します。訳語は翻訳先の言語で書いてください。メイン画面・選択翻訳・OCRレンズのすべての翻訳に反映されます（変更は「保存」で確定します）。

韓国語OCRは設定の「ダウンロードして有効化」から追加できます（約14 MB）。使わないときはオフにすると負荷を減らせます。オフにしてもモデルは残り、再ダウンロードせずオンにできます。「モデルを削除」で保存容量も解放できます。

「OCRレンズ」を開き、枠を画像やPDFに合わせると自動翻訳します（Mac・X11）。「自動」で停止・再開、「更新」で手動取得、「原文」で翻訳前の内容を確認し、`Esc`で閉じます。Waylandでは「更新」から画面の範囲を選択します。

「カメラ」は2モードです。「自動」は映像が落ち着くと訳文を重ねて更新し、「撮影」は画像を止めて翻訳します。「原文」で重ね表示を切り替え、撮影後の「文章を開く」で原文を編集できます。カメラの許可が必要です。画像は端末内で処理し、読み取り後の一時画像は削除します。

Mac・X11では「透過」で背後のアプリをクリック・スクロールできます。`Ctrl+Shift+L`（Macは`⌘+Shift+L`）で切り替え・解除できます。

「設定 → 更新を確認」で新しい版を取得できます（更新対応版の初回導入と配布側の準備が必要）。

「設定」では、ショートカット、選択文の日英自動切替、別ウィンドウ表示、モデルの先読みを変更できます。トレイ対応環境ではウィンドウを閉じても常駐するため、終了は「設定 → 終了」から行います。

「設定 → 翻訳モデル」で、最小（0.8B Q2_K・約410 MB）、軽量（0.8B Q3_K_M・約486 MB）、標準（0.8B Q4_K_M・約573 MB）、品質重視（2B Q4_K_M・約1.81 GB）を切り替えられます。最小は精度が下がり、2Bはメモリ使用量と待ち時間が増えます。未取得のモデルは選んでダウンロードしてください。取得済みのモデルは保持され、再ダウンロードせず切り替えられます。OCRレンズは閉じてから切り替えます。

- **Mac**: 「システム設定 → プライバシーとセキュリティ」で、選択翻訳にはアクセシビリティ、OCRには画面収録を許可してください。レンズ全体を1つの画面内に収めます。
- **Linux**: X11の自動更新にはコンポジター、WaylandのOCRには`xdg-desktop-portal`と対応バックエンドが必要です。Waylandの選択翻訳は、OSのキーボード設定に`anywhere-plamo --translate-selection`を登録します。AppImageは実行ファイルの絶対パスに置き換えてください。

## ライセンス

Built with PLaMo. アプリ: [MIT](../LICENSE) · モデル: [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) · [第三者ライセンス](../THIRD_PARTY_NOTICES.md)
