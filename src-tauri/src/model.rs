use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::ProgressEvent;

const REPOSITORY: &str = "pfnet/plamo-3-translate-0.8b-GGUF";
pub const FILENAME: &str = "plamo-3-translate-0.8b-Q4_K_M.gguf";

#[derive(Deserialize)]
struct Repository {
    sha: String,
    siblings: Vec<RepositoryFile>,
}

#[derive(Deserialize)]
struct RepositoryFile {
    rfilename: String,
    lfs: Option<Lfs>,
}

#[derive(Deserialize)]
struct Lfs {
    sha256: String,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    revision: String,
    sha256: String,
    size: u64,
}

pub fn path(directory: &Path) -> PathBuf {
    directory.join(FILENAME)
}

pub fn ready(directory: &Path) -> bool {
    let Ok(bytes) = std::fs::read(directory.join("model.json")) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_slice::<Receipt>(&bytes) else {
        return false;
    };
    std::fs::metadata(path(directory))
        .is_ok_and(|metadata| metadata.len() == receipt.size && receipt.size > 0)
}

pub async fn download(
    directory: &Path,
    channel: &Channel<ProgressEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("保存先を作成できません: {error}"))?;
    let partial = directory.join(format!("{FILENAME}.part"));
    let receipt_partial = directory.join("model.json.part");
    // Cancellation drops the network future and removes the incomplete file.
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("CANCELLED".to_owned()),
        result = download_inner(directory, &partial, &receipt_partial, channel) => result,
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        let _ = tokio::fs::remove_file(&receipt_partial).await;
    }
    result
}

async fn download_inner(
    directory: &Path,
    partial: &Path,
    receipt_partial: &Path,
    channel: &Channel<ProgressEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .user_agent("Anywhere-Plamo/0.1.0")
        .build()
        .map_err(|error| error.to_string())?;
    let repository = client
        .get(format!(
            "https://huggingface.co/api/models/{REPOSITORY}?blobs=true"
        ))
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(network_error)?
        .json::<Repository>()
        .await
        .map_err(network_error)?;
    let lfs = repository
        .siblings
        .into_iter()
        .find(|file| file.rfilename == FILENAME)
        .and_then(|file| file.lfs)
        .ok_or("公式配布先からモデルの検証情報を取得できませんでした。")?;
    if repository.sha.len() != 40
        || !repository.sha.bytes().all(|b| b.is_ascii_hexdigit())
        || lfs.sha256.len() != 64
        || !lfs.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || lfs.size == 0
        || lfs.size > 2_000_000_000
    {
        return Err("モデルの検証情報が不正です。".into());
    }
    // Resolve the exact revision whose checksum was obtained above, never a moving main URL.
    let url = format!(
        "https://huggingface.co/{REPOSITORY}/resolve/{}/{FILENAME}",
        repository.sha
    );
    let mut response = client
        .get(url)
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
    let mut last_report = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        received += chunk.len() as u64;
        if received > lfs.size {
            return Err("モデルのサイズが検証情報と一致しません。".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(storage_error)?;
        if last_report.elapsed().as_millis() >= 100 || received == lfs.size {
            channel
                .send(ProgressEvent::Download {
                    received,
                    total: lfs.size,
                })
                .map_err(|_| "画面との接続が切れました。")?;
            last_report = std::time::Instant::now();
        }
    }
    channel
        .send(ProgressEvent::Verifying)
        .map_err(|_| "画面との接続が切れました。")?;
    if received != lfs.size || format!("{:x}", hash.finalize()) != lfs.sha256.to_lowercase() {
        return Err("モデルの検証に失敗しました。もう一度ダウンロードしてください。".into());
    }
    file.flush().await.map_err(storage_error)?;
    file.sync_all().await.map_err(storage_error)?;
    drop(file);
    let receipt = Receipt {
        revision: repository.sha,
        sha256: lfs.sha256,
        size: lfs.size,
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|error| error.to_string())?;
    tokio::fs::write(receipt_partial, bytes)
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(partial, path(directory))
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(receipt_partial, directory.join("model.json"))
        .await
        .map_err(storage_error)?;
    Ok(())
}

fn network_error(error: reqwest::Error) -> String {
    format!(
        "モデルを取得できませんでした。接続を確認して再試行してください。({})",
        error.without_url()
    )
}

fn storage_error(error: std::io::Error) -> String {
    format!("モデルを保存できません。空き容量と保存先の権限を確認してください。({error})")
}
