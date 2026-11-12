use crate::AppState;
use serde::Serialize;
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct State(tokio::sync::Mutex<Option<Update>>);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Progress {
    Download { received: u64, total: Option<u64> },
    Installing,
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("更新は翻訳画面の設定から実行してください。".into());
    }
    if cfg!(debug_assertions) {
        return Err("ソースから起動した開発版は更新できません。配布版をご利用ください。".into());
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return Err("Linuxのアプリ内更新はAppImage版で利用できます。".into());
    }
    Ok(())
}

fn check_error(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound => {
            "更新情報はまだ公開されていません。時間をおいて再試行してください。".into()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "この環境向けの更新ファイルはまだ公開されていません。".into()
        }
        error => format!("更新を確認できませんでした。接続を確認して再試行してください。\n{error}"),
    }
}

#[tauri::command]
pub async fn check_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Option<String>, String> {
    require_main(&window)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新の処理中です。")?;
    *pending = None;
    let update = window
        .app_handle()
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(check_error)?
        .check()
        .await
        .map_err(check_error)?;
    if let Some(update) = &update {
        if update.download_url.scheme() != "https" {
            return Err("更新ファイルのURLが安全ではありません。".into());
        }
    }
    let version = update.as_ref().map(|update| update.version.clone());
    *pending = update;
    Ok(version)
}

#[tauri::command]
pub async fn install_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    on_event: Channel<Progress>,
) -> Result<(), String> {
    require_main(&window)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新の処理中です。")?;
    let mut update = pending.take().ok_or("先に更新を確認してください。")?;
    update.timeout = Some(Duration::from_secs(15 * 60));
    let mut received = 0;
    let bytes = update
        .download(
            |length, total| {
                received += length as u64;
                let _ = on_event.send(Progress::Download { received, total });
            },
            || {},
        )
        .await
        .map_err(|error| {
            format!("更新ファイルを取得・検証できませんでした。再度確認してください。\n{error}")
        })?;

    let app = window.app_handle();
    let app_state = app.state::<AppState>();
    app_state.updating.store(true, Ordering::SeqCst);
    for label in ["main", "popup", "lens"] {
        app_state.cancel(label);
    }
    app_state.preparation.cancel();
    // Release the bundled executables before replacing the app (especially on Windows).
    *app_state.engine.lock().await = None;
    app_state.ocr.stop().await;
    let _ = on_event.send(Progress::Installing);
    let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match result {
        Ok(Ok(())) => {
            app.request_restart();
            Ok(())
        }
        error => {
            app_state.updating.store(false, Ordering::SeqCst);
            let error = match error {
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
                _ => unreachable!(),
            };
            Err(format!(
                "更新を適用できませんでした。アプリを終了して再試行してください。\n{error}"
            ))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };
    use tauri_plugin_updater::UpdaterExt;

    #[tokio::test]
    async fn signed_updates_replace_only_the_app_and_reject_tampering() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/update-signed.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": fixture["pubkey"], "requireSignedVersion": true,
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let directory = std::env::temp_dir().join(format!("plamo-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("test.AppImage");
        let settings = directory.join("settings.json");
        std::fs::write(&settings, b"preserve user settings").unwrap();
        for version in ["9.0.0", "9.0.1"] {
            std::fs::write(&executable, b"old app").unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let body = serde_json::json!({"version": version, "platforms": {
                "linux-x86_64": {"url": "https://example.invalid/test.AppImage", "signature": fixture["signature"]}
            }}).to_string();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let update = app
                .updater_builder()
                .target("linux-x86_64")
                .executable_path(&executable)
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .endpoints(vec![format!("http://{address}/latest.json")
                    .parse()
                    .unwrap()])
                .unwrap()
                .build()
                .unwrap()
                .check()
                .await
                .unwrap()
                .unwrap();
            server.join().unwrap();
            let bytes = fixture["payload"].as_str().unwrap().as_bytes();
            assert!(update.install(b"tampered payload").is_err());
            assert_eq!(std::fs::read(&executable).unwrap(), b"old app");
            if version == "9.0.0" {
                update.install(bytes).unwrap();
                assert_eq!(std::fs::read(&executable).unwrap(), bytes);
            } else {
                assert!(matches!(
                    update.install(bytes),
                    Err(tauri_plugin_updater::Error::SignedVersionMismatch { .. })
                ));
                assert_eq!(std::fs::read(&executable).unwrap(), b"old app");
            }
            assert_eq!(std::fs::read(&settings).unwrap(), b"preserve user settings");
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
