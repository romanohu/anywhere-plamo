# Anywhere Plamo

選択した文章を、ショートカットひとつで翻訳する小さなアプリ。PLaMo 3 Translate 0.8Bを使った、非公式のデスクトップクライアントです。

**文章を選ぶ → ショートカットを押す → 訳文を読む。** 初回にモデルを取得すれば、以後の翻訳はオフラインで動作します。

## このバージョン

Linux・macOS向けのv0.1実装です。翻訳画面、モデル取得、ローカル推論、常駐、選択文字の翻訳を含みます。**Linux x64では実アプリと実モデルでの動作を確認済みです。** macOSの実機検証とAndroid対応は次の段階です。

- 日本語・英語・韓国語・中国語（簡体字）・フランス語・ドイツ語・スペイン語への翻訳。原文の言語はモデルが判定します。
- 訳文のストリーミング表示、中断、コピー。
- 選択翻訳は訳文を中心に表示し、「原文を表示」「編集画面へ」で原文を確認・編集できます。翻訳中に別の文章を選んで呼び出すと、現在の翻訳を中断して最新の選択に切り替えます。
- モデル取得済みの場合は起動時にバックグラウンドで読み込み、初回翻訳の待ち時間を減らします。読み込み後は終了までメモリを使用します。設定の「起動時にモデルを先読み」をオフにすると、次回起動から初回翻訳時の読み込みに戻ります。
- ライト／ダーク表示はOSの設定に追従。
- 翻訳履歴を保存しません。保存するのはモデルと翻訳先・先読みの設定のみです。
- クラウド翻訳への自動切り替え、アカウント登録、APIキーの入力はありません。

## 使い方

1. アプリを開き、「準備する」からモデルの利用条件を確認してダウンロードします（約570 MB）。
2. 翻訳先を選んでおき、ブラウザやエディタなど元のアプリに戻ります。
3. 翻訳したい文章をマウスなどで選択します。
4. `Ctrl+Shift+J`（Macは `⌘+Shift+J`）を押すと、翻訳画面が開いて訳文を表示します。

事前のコピーは不要です。選択文字を取得してから画面を開き、通常のクリップボードの内容は変更しません。LinuxはPRIMARY selection、MacはアクセシビリティAPIを利用します。Macでは初回に「システム設定 → プライバシーとセキュリティ → アクセシビリティ」でAnywhere Plamoを許可してください。

選択文字の取得に対応しないアプリでは、文章をコピーして翻訳画面の「貼り付け」→「翻訳する」（`Ctrl+Enter`／`⌘+Enter`）を使えます。訳文は「コピー」で取り出せます。トレイの「コピーした文章を翻訳」と`--translate-clipboard`も利用できます。

閉じる・`Esc`でウィンドウを隠します。完全に終了するには、トレイメニューまたは設定画面の「アプリを終了」を使います。翻訳中の`Esc`は翻訳を中断します。トレイを作成できない環境では、閉じるボタンでアプリを終了します。GNOMEではトレイ表示にAppIndicator拡張が必要な場合があります。アイコンが見えない場合もアプリを再度起動すると既存の画面が開きます。

### Linux / Wayland

OSのキーボード設定に、次のコマンドを登録してください。

```sh
anywhere-plamo --translate-selection
```

AppImageの場合は、`anywhere-plamo`の代わりにAppImageの絶対パスを指定します。文章を選択してから登録したキーを押すと翻訳します。選択文字の取得にはコンポジタのext-data-controlまたはwlr-data-control v2以降と、元アプリのPRIMARY selection対応が必要です。対応しない環境では取得エラーを表示します。画面の前面表示もデスクトップ環境の制約を受けます。初期版ではGlobalShortcuts portalの自動登録は実装していません。

## 開発

Node.js 24、Rust 1.90以上、Python 3.12以上、CMake、C/C++コンパイラと[TauriのOS別依存](https://v2.tauri.app/start/prerequisites/)が必要です。

Ubuntu / Debianの例:

```sh
sudo apt install build-essential cmake pkg-config libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

macOSではXcode Command Line ToolsとCMakeをインストールしてください。Apple SiliconではMetalを利用し、Linux配布版は追加のGPUドライバを必要としないCPUビルドを使用します。実行速度と必要メモリは端末・文章量によって異なります。

```sh
npm install
npm run runtime:build
npm run tauri dev
```

`runtime:build`は固定したllama.cppのコミットを取得・ビルドし、推論エンジンを`src-tauri/resources/runtime/`に配置します。モデル本体は利用者がアプリ内から取得します。

GPU向けのビルドを試す場合は、対応する開発環境とドライバを用意してバックエンドを指定します。既定はLinuxでCPU、macOSでMetalです。バックエンドごとにビルド先を分離し、最後に成功したビルドがアプリに同梱されます。

```sh
npm run runtime:build -- --backend cuda    # Linux / NVIDIA、CUDA Toolkitが必要
npm run runtime:build -- --backend vulkan  # Vulkan SDK相当の開発依存が必要
npm run runtime:build -- --backend cpu     # CPU版に戻す（Macでも指定可能）
```

CUDA・Vulkan版のGPU実行は、この変更では未検証です。CPU版のビルド・推論は検証しています。

既存の互換llama-serverを使う開発者は、`ANYWHERE_PLAMO_LLAMA_SERVER`に実行ファイルの絶対パスを設定できます。接続先の外部サーバーを指定する設定はありません。

画面だけを確認する場合:

```sh
npm run dev
```

ブラウザでは画面プレビューであることを表示し、翻訳やダウンロードは実行しません。

### 検証

```sh
npm run build
npm run test:ui
npm run test:protocol
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

UIテストはネイティブ接続を模擬し、貼り付け・翻訳・コピー・中断・ダウンロードの状態遷移を確認します。翻訳品質やネイティブ連携の実機テストを置き換えるものではありません。

2026-11-06の変更ではUIテスト26件、Rustテスト19件、型チェックと整形チェックを通過しています。Linuxの実アプリ・実モデルによる22項目の検証では、先読みの重複起動防止、連続した翻訳要求の切り替え、4,096トークンを超える入力の段落処理、過長段落の出力前の拒否、コンパクト表示、7言語への翻訳とX11での選択取得を確認しました。リリース版の`.deb`も生成し、展開した配布物からの起動・翻訳・コピー・終了を確認しています。Waylandの取得パイプはタイムアウト・転送量の単体テストを実施していますが、コンポジタとの交渉部分はライブラリに依存し、Wayland実環境とMac実機は引き続き未検証です。

### 待ち時間と翻訳品質の確認

```sh
npm run benchmark -- --model /path/to/plamo-3-translate-0.8b-Q4_K_M.gguf \
  --output .runtime-build/benchmark.json
```

固定した6種類の評価文で、モデル読み込み・最初の文字・完了までの時間と実際の訳文を保存します。`--threads`、`--threads-batch`、`--device`、`--runs`で条件を変更できます。スレッド数を省略するとllama.cppの既定値を使います。アプリの8スレッド制限と比較する場合は`--threads 8`を指定してください。新しい推論プロセスで測定しますが、OSのファイルキャッシュは消しません。GUIや選択文字の取得時間は含みません。アプリ上では完了時間にマウスを重ねると最初の文字までの時間も確認できます。

2026-11-06、Core Ultra 7 265KF・CPU版・Q4_K_Mで、llama.cppの既定スレッド設定から生成／入力処理とも8スレッドにすると、短文は約0.18秒から0.13秒、3段落は約1.02秒から0.74秒になりました。モデル読み込みは約1.35秒、推論プロセスの最大RSSは約968 MiBでした（アプリ画面のメモリは含みません）。同じ固定文での測定例であり、他の端末での速度を保証するものではありません。アプリは利用可能な論理CPU数が8を超える場合に生成スレッド数を8に抑え、入力処理も同じスレッド数を使います。`LLAMA_ARG_THREADS`による明示指定を優先します。

評価文と確認点は`tests/translation-cases.json`にあります。実行成功だけでは翻訳品質の合格になりません。今回、0.8Bモデルの箇条書き評価で「ドアを施錠しない」という条件が逆転する誤訳と、長い連番の評価で番号の取り違えを確認しました。否定・数値・固有名詞などは、保存された訳文と確認点を照合してください。

2026-11-05にLinux x64（Pop!_OS 24.04、XvfbによるX11仮想画面、WebKitGTK 2.50.4）で以下を確認しました。モデルは公式のQ4_K_M版（573,116,288バイト）です。

- デバッグ／リリースビルド、`.deb`の生成と、展開した配布物からの起動・翻訳。
- アプリ内でのモデル取得、中止、不完全ファイルの削除、再取得、SHA-256検証。
- 7言語への実翻訳、OSクリップボードの貼り付け・コピー、翻訳の中断と再実行。
- 別のGTKアプリでマウス選択 → `Ctrl+Shift+J`による翻訳。事前コピーなし・通常のクリップボードを保持。
- 未選択時にエラーを表示し、古いクリップボードの文章を翻訳しないこと。
- `--translate-selection`／`--translate-clipboard`による既存プロセスへの入力、終了時の推論プロセス停止。
- 画面のスクリーンショット確認、型チェック、UIテスト12件、`cargo test`の5件、`cargo fmt --check`。

訳文の例は、`Hello, world.` → `こんにちは、世界。`、`今日は良い天気ですね。` → `The weather is nice today, isn't it?`。翻訳品質の網羅的な評価ではありません。Macの選択取得モジュールはApple Siliconターゲットで型チェック済みですが、macOSの実動作、Wayland上の連携、実デスクトップのトレイ表示は未検証です。

Linuxで同じ実動作テストを実行するには、通常の開発依存に加え`xvfb`・`xauth`・`dbus-x11`・`webkit2gtk-driver`・`xdotool`・`python3-gi`・`gir1.2-gtk-3.0`を用意します。[TauriのWebDriver](https://v2.tauri.app/develop/tests/webdriver/)を使い、ネイティブ接続やモデルの応答は模擬しません。

```sh
cargo install tauri-driver --locked
npm run runtime:build
npm run tauri build -- --debug --no-bundle
WEBKIT_DISABLE_DMABUF_RENDERER=1 xvfb-run -a dbus-run-session -- python3 scripts/test-desktop.py
```

初回は約570 MBをダウンロードします。テスト専用のモデル・ログ・スクリーンショットは`.runtime-build/desktop-test/`に保存します。`--app`で検証対象の実行ファイル、`--work-dir`で保存先を変更できます。仮想画面・専用D-Busセッションで実行し、通常利用中のアプリやクリップボードと分離してください。

## ビルド・GitHubでの配布

```sh
npm run runtime:build
npm run tauri build
```

成果物は`src-tauri/target/release/bundle/`に生成されます。Linuxは`.deb` / `.AppImage`、macOSは`.app` / `.dmg`を想定しています。

`.github/workflows/build.yml`はLinux x64とMac（Apple Silicon）の検証・ビルドを実行し、インストーラをActionsの成果物として保存します。`v*`タグのpush時はGitHub Releaseの**下書き**に添付します。実機検証後に公開してください。Intel MacはそのMac上でビルドできますが、初期CIの対象には含めていません。

macOSのDeveloper ID署名・公証は未設定です。一般配布時には署名を追加してください。検証時の依存バージョンは`package-lock.json`と`src-tauri/Cargo.lock`に固定しています。

## 仕組みとデータ

- UI: Tauri 2 + TypeScript（フロントエンドフレームワークなし）。
- 推論: アプリが管理するllama.cppの子プロセス。モデル取得済みなら起動時に先読みし、アプリ終了時に停止します。先読みに失敗した場合は翻訳時に再試行します。
- モデル: PFN公式の[plamo-3-translate-0.8b-Q4_K_M.gguf](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)。公式APIで確定したリビジョンから取得し、SHA-256・サイズを検証した後に保存します。中断時の不完全なファイルは削除します。
- 翻訳入力: [PFML3](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF#usage)をRust側で組み立てます。原文のモデル制御記号は受け付けません。
- 通信: 翻訳時は`127.0.0.1`のランダムポートのみ。毎回生成するAPIキーを付け、HTTPプロキシを経由しません。原文・訳文はログ出力しません。
- 外部通信: モデル取得時にHugging Faceとその配信先にアクセスします。ライセンスを開く操作ではブラウザが起動します。
- 上限: 原文12,000 UTF-16単位。4,096入力トークンを超える場合は空行を境に段落ごとに翻訳し、空行を保持します。各段落は独立して翻訳するため、段落をまたぐ用語や文体の一貫性は保証しません。1段落でも上限を超える場合は、訳文の出力前に分割を案内します。1回の推論は入出力合計8,192トークンまで。出力上限や接続切断で途中終了した場合は、後続の段落へ進まず未完了であることを表示します。

モデルはTauriのアプリデータディレクトリ内の`models/`に保存します。Linuxは通常`~/.local/share/app.anywhere-plamo.desktop/models/`、Macは`~/Library/Application Support/app.anywhere-plamo.desktop/models/`です。

## Android

Androidは未実装です。次の段階では、共通の画面に`ACTION_PROCESS_TEXT`と共有Intentによる入力を追加し、llama.cppをAndroid NDKのライブラリとして組み込みます。デスクトップ用子プロセスはAndroidでは使用しません。現時点で`tauri android`によるビルドには対応していません。

## ライセンス

自作アプリコードは[MIT](LICENSE)。モデルの権利は含みません。

PLaMoモデルは[PLaMo Community License](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF#license)に従います。個人・非商用利用は事前登録なしで無償、商用利用には売上規模に応じた登録・契約条件があります。モデルの後ダウンロード方式でも、その条件は適用されます。モデル重みはGitHubリポジトリやインストーラに同梱しません。

llama.cppと同梱コードのライセンス文書は推論エンジンと一緒に配布します。依存関係については[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)も参照してください。

Built with PLaMo. PFN公式のアプリではありません。

CPUスレッド設定や最新の翻訳要求を優先する動作、段落処理の検討では、[tanakh/plamo-translate-desktop](https://github.com/tanakh/plamo-translate-desktop)を参考にしています。
