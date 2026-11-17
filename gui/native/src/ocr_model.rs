use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{ipc::Channel, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::{AppState, ProgressEvent};

pub const FILENAME: &str = "korean_PP-OCRv5_rec_mobile.onnx";
const SIZE: u64 = 13_488_748;
const SHA256: &str = "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b";
const URL: &str = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx";

pub fn path(directory: &Path) -> PathBuf {
    directory.join(FILENAME)
}

pub fn ready(directory: &Path) -> bool {
    std::fs::metadata(path(directory)).is_ok_and(|file| file.len() == SIZE)
}

pub fn enabled(directory: &Path) -> bool {
    directory.join("korean.enabled").is_file() && ready(directory)
}

pub async fn save_enabled(directory: &Path, enabled: bool) -> Result<(), String> {
    let marker = directory.join("korean.enabled");
    if enabled {
        let bytes = tokio::fs::read(path(directory))
            .await
            .map_err(storage_error)?;
        verify(&bytes)?;
        tokio::fs::write(marker, b"").await.map_err(storage_error)
    } else {
        remove(&marker).await
    }
}

fn verify(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != SIZE || format!("{:x}", Sha256::digest(bytes)) != SHA256 {
        return Err("韓国語OCRモデルを検証できません。削除して再ダウンロードしてください。".into());
    }
    Ok(())
}

async fn remove(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}

async fn download(
    directory: &Path,
    channel: &Channel<ProgressEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(storage_error)?;
    let partial = directory.join(format!("{FILENAME}.part"));
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED".into()),
        result = download_inner(directory, &partial, channel) => result,
    };
    if result.is_err() {
        let _ = remove(&partial).await;
    }
    result
}

async fn download_inner(
    directory: &Path,
    partial: &Path,
    channel: &Channel<ProgressEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .user_agent(concat!("Anywhere-Plamo/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(network_error)?;
    let mut response = client
        .get(URL)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(network_error)?;
    let mut file = tokio::fs::File::create(partial)
        .await
        .map_err(storage_error)?;
    let mut hash = Sha256::new();
    let mut received = 0;
    let mut reported = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        received += chunk.len() as u64;
        if received > SIZE {
            return Err("韓国語OCRモデルのサイズが一致しません。".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(storage_error)?;
        if reported.elapsed().as_millis() >= 100 || received == SIZE {
            channel
                .send(ProgressEvent::Download {
                    received,
                    total: SIZE,
                })
                .map_err(|_| "画面との接続が切れました。")?;
            reported = std::time::Instant::now();
        }
    }
    if received != SIZE || format!("{:x}", hash.finalize()) != SHA256 {
        return Err("韓国語OCRモデルを検証できません。再試行してください。".into());
    }
    file.flush().await.map_err(storage_error)?;
    file.sync_all().await.map_err(storage_error)?;
    drop(file);
    tokio::fs::rename(partial, path(directory))
        .await
        .map_err(storage_error)
}

#[derive(serde::Serialize)]
pub struct Status {
    pub ready: bool,
    pub enabled: bool,
}

#[tauri::command]
pub fn get_korean_ocr(state: tauri::State<'_, AppState>) -> Status {
    state.ocr.korean_status()
}

fn changed(app: &tauri::AppHandle) -> Status {
    let state = app.state::<AppState>();
    let _ = app.emit("ocr-settings-changed", ());
    state.ocr.korean_status()
}

#[tauri::command]
pub async fn set_korean_ocr(window: tauri::WebviewWindow, enabled: bool) -> Result<Status, String> {
    let state = window.state::<AppState>();
    let _operation = state.begin(window.label())?;
    let _download = state.download.lock().await;
    state.ocr.set_korean(enabled).await?;
    Ok(changed(window.app_handle()))
}

#[tauri::command]
pub async fn download_korean_ocr(
    window: tauri::WebviewWindow,
    on_event: Channel<ProgressEvent>,
) -> Result<Status, String> {
    let state = window.state::<AppState>();
    let operation = state.begin(window.label())?;
    let _download = tokio::select! {
        biased;
        _ = operation.token.cancelled() => return Err("CANCELLED".into()),
        download = state.download.lock() => download,
    };
    if !state.ocr.korean_status().ready {
        download(state.ocr.model_directory(), &on_event, &operation.token).await?;
    }
    if operation.token.is_cancelled() {
        return Err("CANCELLED".into());
    }
    state.ocr.set_korean(true).await?;
    Ok(changed(window.app_handle()))
}

#[tauri::command]
pub async fn remove_korean_ocr(window: tauri::WebviewWindow) -> Result<Status, String> {
    let state = window.state::<AppState>();
    let _operation = state.begin(window.label())?;
    let _download = state.download.lock().await;
    if state.ocr.korean_status().enabled {
        return Err("韓国語OCRをオフにしてから削除してください。".into());
    }
    remove(&path(state.ocr.model_directory())).await?;
    Ok(changed(window.app_handle()))
}

fn storage_error(error: std::io::Error) -> String {
    format!("韓国語OCRモデルを保存・変更できません。({error})")
}
fn network_error(error: reqwest::Error) -> String {
    format!(
        "韓国語OCRモデルを取得できません。接続を確認してください。({})",
        error.without_url()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "downloads the optional Korean model from its pinned URL"]
    async fn downloads_verified_korean_model() {
        let dir = std::env::temp_dir().join(format!("plamo-ocr-download-{}", uuid::Uuid::new_v4()));
        let result = download(&dir, &Channel::new(|_| Ok(())), &CancellationToken::new()).await;
        if result.is_ok() {
            assert!(ready(&dir));
            assert!(!enabled(&dir));
            save_enabled(&dir, true).await.unwrap();
            assert!(enabled(&dir));
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result.unwrap();
    }

    #[tokio::test]
    async fn missing_corrupt_or_cancelled_download_never_enables_korean() {
        let dir = std::env::temp_dir().join(format!("plamo-ocr-{}", uuid::Uuid::new_v4()));
        assert!(!enabled(&dir));
        assert!(save_enabled(&dir, true).await.is_err());
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(path(&dir), vec![0; SIZE as usize])
            .await
            .unwrap();
        assert!(save_enabled(&dir, true).await.is_err());
        assert!(!enabled(&dir));
        assert!(verify(b"partial download").is_err());
        let cancel = CancellationToken::new();
        cancel.cancel();
        tokio::fs::write(dir.join(format!("{FILENAME}.part")), b"interrupted")
            .await
            .unwrap();
        assert_eq!(
            download(&dir, &Channel::new(|_| Ok(())), &cancel)
                .await
                .unwrap_err(),
            "CANCELLED"
        );
        assert!(!dir.join(format!("{FILENAME}.part")).exists());
        save_enabled(&dir, false).await.unwrap();
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
