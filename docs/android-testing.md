# AndroidのOCR検証

## 配布用APK

[Androidのビルド環境](README.md#android開発版)を用意し、[Tauriの署名手順](https://v2.tauri.app/distribute/sign/android/)に従って署名鍵を作成します。`src-tauri/gen/android/keystore.properties`に次を設定します（Gitの対象外です）。

```properties
storeFile=/絶対パス/release.jks
keyAlias=release
password=鍵のパスワード
```

```sh
npm run android:prepare
npm run tauri -- android build --apk --target aarch64
```

成果物は`src-tauri/gen/android/app/build/outputs/apk/universal/release/`です。署名設定がない場合は未署名APKになるため、公開前にAndroid SDKの`apksigner verify --verbose 対象.apk`で確認します。更新には同じ署名鍵が必要です。鍵とパスワードを安全な場所にバックアップし、GitやReleasesには含めないでください。デバッグ版とは署名が異なるため、デバッグ版からの導入はアンインストールが必要です。

## 画面操作の検証

デバッグAPKをインストールし、翻訳モデルの取得を済ませ、翻訳先を日本語にします。カメラには静止した、読みやすい英語を映します。実機の場合はUSBデバッグで接続してください。

```sh
ADB="$ANDROID_HOME/platform-tools/adb" node scripts/test-android-camera.mjs
```

このテストは画面のタッチ操作とAndroidの許可ダイアログを使います。カメラ、OCR、翻訳は置き換えません。「撮影」の画像固定・訳文・原文切替・文章を開く・撮り直し、「自動」の訳文重ね表示、バックグラウンド移行と閉じる操作でのカメラ解放、一時画像の削除を確認します。結果と画面画像は`.runtime-build/verification/android-camera/`に保存します。

`CAMERA_EXPECTED_SOURCE='Hello world'`で読み取り結果も確認できます。ソフトウェアエミュレーション向けの待ち時間は1段階30分で、`CAMERA_TEST_TIMEOUT`（ミリ秒）で変更できます。推論速度の評価には実機を使ってください。

エミュレーターでは起動時に`-camera-back imagefile:/絶対パス/tests/fixtures/camera-english.png -camera-front none`を指定すると、同じ英語画像をAndroidのカメラ経由で検証できます。これはWebViewの映像APIやOCRの置き換えではありません。

KVMなしの環境で映像処理が重い場合は、`CAMERA_TEST_LOW_RES=1`を指定すると、検証中の`getUserMedia`呼び出しの解像度・フレームレートだけを640×480・毎秒5フレーム以下に変更します。映像はAndroidのカメラAPIから取得します。実際の寸法はカメラの向きや対応解像度によって変わります。アプリの通常設定やOCR・翻訳処理は変更しません。WebView 124とエミュレーターのカメラでは、開始後の`applyConstraints`による解像度変更が完了しないため、開始時に指定しています。

今回のエミュレーターでは、初回のカメラ許可、960×1280での撮影・原文切替・文章を開く・撮り直しを確認しました。480×640・5fpsでは両モードの日本語表示、バックグラウンド移行と閉じる操作でのカメラ解放、今回の一時画像の削除まで確認しています。通常解像度の自動モードはソフトウェアエミュレーションの負荷で待ち時間上限を超えました。Android実機と実機の処理速度は未確認です。

## カメラUI・横向き・画面レンズ

`npm run build && npm run test:ui`では、長文を番号と全文一覧に分ける配置、重なり・枠外へのはみ出し、回転時の画像寸法、軽い明るさの変化による処理の維持、待ち時間の上限を検証します。小さな平行移動とノイズは生成画像で検証しており、実機での手ブレの評価とは分けています。

Androidの`PaddleOcrTest`は、通常の日本語・英語、90度・270度の英文、その読み取り座標、中断を実際の同梱OCRモデルで検証します。今回のAPI 35 x86_64エミュレーターでは2テストが通っています。

修正版では240×320・5fpsの実カメラ映像で、撮影・自動の両モードのOCRと日本語翻訳も確認しています。密な文章の縦画面・横画面の配置は、画像と翻訳結果を固定したWebViewで別途確認しています。

画面レンズは次を画面操作で確認します。

1. 「OCRレンズ」を開き、重ね表示を許可して画面全体の共有を開始する。
2. 別アプリの英文を日本語へ翻訳し、取得画像に上下の操作バーや訳文自身が含まれないことを確認する。
3. レンズ内のボタン・スクロールが背後のアプリへ届くことを確認する。
4. 枠の移動・サイズ変更、自動更新の停止・再開、原文・全文表示を切り替える。
5. 本体アプリへ戻ったときはレンズが隠れ、「OCRレンズ」から同じセッションへ戻れることを確認する。
6. レンズを閉じ、画面共有と常駐サービスが終了し、`cache/screen-lens`の撮影画像が残らないことを確認する。

上記の操作と別アプリの英文2行の翻訳をエミュレーターで確認しています。本体へ戻る操作を含む再確認では、Androidのウィンドウ再配置の応答待ちが約10秒になり、ANRダイアログが一度出ました。待機後も本体の応答・同じレンズの再表示・終了は確認できましたが、実機での再現有無は未確認です。

Android側で[重ね表示を禁止している画面](https://developer.android.com/security/fraud-prevention/activities?hl=en#hide_overlay_windows)ではレンズが隠れます。

画像・翻訳結果を固定したUIの描画確認と、実際の画面取得・OCR・翻訳は別々に検証しています。Android実機での手ブレ、発熱、端末ごとの描画速度は未確認です。

## WebViewが起動直後に落ちる場合

今回のLinux環境（KVMなし、Android Emulator 37.2.13、API 35 x86_64、WebView 124.0.6367.219）では、アプリを含まない最小WebViewでも`SIGTRAP`が再現しました。V8の初期データを検証するAdler-32計算が仮想CPUの`PHADDD`命令で誤った値になり、検証に失敗していました。

```sh
"$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android28-clang" \
  -O2 -mssse3 tests/android-emulator-simd.c -o /tmp/android-emulator-simd
"$ANDROID_HOME/platform-tools/adb" push /tmp/android-emulator-simd /data/local/tmp/
"$ANDROID_HOME/platform-tools/adb" shell /data/local/tmp/android-emulator-simd
```

正常時は`3 7 3 7`、不具合のある仮想CPUでは`3 7 10 14`になります。実機またはKVM対応環境を使うか、[QEMUの該当修正](https://github.com/qemu/qemu/commit/2dfbea1a872727fb747ca6adf2390e09956cdc6e)を含むエミュレーターが必要です。

今回の検証環境には、元の実行ファイルを保存したうえで、該当ヘルパーが入力をすべて読み終えてから結果を書き込む修正を適用しました。修正前後のハッシュと変更内容は検証出力の`emulator-fix.json`に記録しています。これはローカル検証ツールの修正で、APKには含まれません。

同環境ではSystem UIの`[Gesture Monitor] swipe-up`も操作待ちのタイムアウトを起こしました。Androidのナビゲーションを3ボタンに変更し、System UIを再起動すると画面操作を継続できました。アプリのクラッシュとは別の事象です。

別途、アプリのカメラ許可処理でUIスレッドから`webview.url()`を呼び、同じスレッドの応答待ちになる問題も再現しました。タイムアウト後にはWryの`GetUrl`応答で`SendError`が発生し、プロセスが終了します。Androidではネイティブのページ読み込み通知で確認したURLを使い、許可コールバック内でUIスレッドへの問い合わせを行わないようにしています。

Androidの許可ダイアログはActivityの一時停止に加えてWebViewの非表示通知も発生させます。許可待ちの間はカメラ画面を維持し、既に取得済みの映像・処理はバックグラウンド移行時に終了します。許可が遅れて返り、その時点でもバックグラウンドなら映像を解放します。
