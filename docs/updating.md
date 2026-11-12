# アプリ内更新の配布手順

設定の「更新を確認」は GitHub Releases の `latest.json` を読みます。「更新して再起動」を押すと、署名とバージョンを検証してアプリを置き換えます。モデル・辞書・設定の保存先は変わりません。確認ボタンを押すまでは更新の通信を行いません。

v0.2.1 以前には更新機能がないため、この機能を含む版を最初の一度だけ手動でインストールします。ソースから起動した開発版はアプリ内更新の対象外です。Linux のアプリ内更新は AppImage 版が対象です。

## 鍵を用意する

更新ファイル用の秘密鍵と、Mac のアプリ署名用の証明書は別のものです。どちらもリリースのたびに作り直さず、安全な場所にバックアップしてください。秘密鍵や証明書の秘密部分をリポジトリや Releases に公開しないでください。

- 更新ファイルには、アプリに登録済みの公開鍵に対応する元の秘密鍵を使います。初回に用意したファイルは開発環境の `.runtime-build/updater/signing.key` にあります。Mac へ安全に移し、`TAURI_SIGNING_PRIVATE_KEY` にその絶対パスを指定します。新しい鍵を作ると既存アプリは更新を受け取れません。
- Mac では毎回同じ署名用証明書を使います。Developer ID Application がない場合、キーチェーンアクセスの「証明書アシスタント → 証明書を作成」で、固有の名前（例: `Anywhere Plamo Local`）、自己署名ルート、コード署名を選び、ログインキーチェーンに作成します。有効期間は継続して使える長さに設定し、証明書と秘密鍵を一緒に保存してください。`APPLE_SIGNING_IDENTITY` にその名前を指定します。

アドホック署名から切り替える初回は、アクセシビリティ・画面収録の再許可が必要になる場合があります。以後は同じ証明書・アプリ識別子・インストール先（`/Applications/Anywhere Plamo.app`）を使います。署名の変更や macOS の仕様による再確認までは防げません。自己署名は Apple の公証にはならず、初回の「このまま開く」操作が必要な場合があります。システム全体の証明書信頼設定や Gatekeeper を無効にする必要はありません。

## ローカルでビルドする

リリースするときに、`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` と設定画面のバージョンをそろえて上げます。同じバージョンの配布物に差し替えても、アプリは更新対象にしません。

Mac の例:

```sh
npm ci
npm run runtime:build
export TAURI_SIGNING_PRIVATE_KEY="/安全な場所/signing.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export APPLE_SIGNING_IDENTITY="Anywhere Plamo Local"
python3 scripts/build-update.py
```

Mac は `.app.tar.gz` と `.dmg`、Linux は AppImage、Windows は NSIS インストーラーを作ります。各 OS・アーキテクチャの実機でビルドしてください。Windows は Python の呼び出しを `py -3.12` に置き換え、環境変数を PowerShell などで設定します。スクリプトはアップロードや Actions の実行を行いません。

更新用ファイル、`.sig`、`latest.json` は `.runtime-build/updates/<version>/` に生成されます。初回インストール用の `.dmg` は `src-tauri/target/release/bundle/dmg/` にあります。複数の環境を配布するときは、別環境の同じバージョンの `latest.json` を `--merge /path/to/latest.json` で読み込んでビルドし、全環境の項目をまとめてください。

## 公開前に確認する

1. 古い版を起動したまま、次の版をビルドします。Mac は両方の `.app` に `codesign -d -r-` を実行し、`designated =>` の内容が同じことを確認します。アドホック署名からの初回移行では一致しません。
2. `v<version>` のドラフト Release に、各環境の更新ファイルと `.sig`、対応する `.dmg`、最後に統合済みの `latest.json` を添付します。ファイル名は変更しません。古い版が取得する前に一式がそろうよう、添付完了後に公開します。
3. 古い版の「更新を確認 → 更新して再起動」で更新し、モデル・設定・辞書、選択翻訳、OCR、Mac のアクセシビリティと画面収録を確認します。Mac の権限維持は Linux のテストでは確認できません。

参考: [Tauri Updater](https://v2.tauri.app/plugin/updater/)、[Apple のコード署名と権限の識別](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[自己署名証明書の作成](https://support.apple.com/guide/keychain-access/create-self-signed-certificates-kyca8916/mac)
