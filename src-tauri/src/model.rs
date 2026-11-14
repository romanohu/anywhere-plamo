use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{ipc::Channel, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::ProgressEvent;

pub struct Model {
    pub id: &'static str,
    name: &'static str,
    description: &'static str,
    repository: &'static str,
    filename: &'static str,
    size: u64,
}

const MODELS: [Model; 4] = [
    Model {
        id: "0.8b-q2",
        name: "最小 · 0.8B Q2_K",
        description: "容量を優先。標準より翻訳精度が下がります。",
        repository: "pfnet/plamo-3-translate-0.8b-GGUF",
        filename: "plamo-3-translate-0.8b-Q2_K.gguf",
        size: 410_138_816,
    },
    Model {
        id: "0.8b-q3",
        name: "軽量 · 0.8B Q3_K_M",
        description: "標準より小さく、精度とのバランスを取ります。",
        repository: "pfnet/plamo-3-translate-0.8b-GGUF",
        filename: "plamo-3-translate-0.8b-Q3_K_M.gguf",
        size: 486_385_856,
    },
    Model {
        id: "0.8b-q4",
        name: "標準 · 0.8B Q4_K_M",
        description: "これまでの標準モデルです。",
        repository: "pfnet/plamo-3-translate-0.8b-GGUF",
        filename: "plamo-3-translate-0.8b-Q4_K_M.gguf",
        size: 573_126_848,
    },
    Model {
        id: "2b-q4",
        name: "品質重視 · 2B Q4_K_M",
        description: "より高い翻訳精度を重視。メモリ使用量と待ち時間が増えます。",
        repository: "pfnet/plamo-3-translate-2b-GGUF",
        filename: "plamo-3-translate-2b-Q4_K_M.gguf",
        size: 1_807_203_040,
    },
];

#[derive(Serialize)]
pub struct Choice {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    size: u64,
    ready: bool,
}

pub fn choices(directory: &Path) -> Vec<Choice> {
    MODELS
        .iter()
        .map(|model| Choice {
            id: model.id,
            name: model.name,
            description: model.description,
            size: model.size,
            ready: model.ready(directory),
        })
        .collect()
}

pub fn selected(directory: &Path) -> &'static Model {
    std::fs::read(directory.join("selected-model.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
        .and_then(|id| MODELS.iter().find(|model| model.id == id))
        .unwrap_or(&MODELS[2])
}

pub fn select(directory: &Path, id: &str) -> Result<(), String> {
    if !MODELS.iter().any(|model| model.id == id) {
        return Err("選択したモデルは利用できません。".into());
    }
    std::fs::create_dir_all(directory).map_err(storage_error)?;
    let partial = directory.join("selected-model.json.part");
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::File::create(&partial).map_err(storage_error)?;
        file.write_all(&serde_json::to_vec(id).map_err(|error| error.to_string())?)
            .map_err(storage_error)?;
        file.sync_all().map_err(storage_error)?;
        drop(file);
        std::fs::rename(&partial, directory.join("selected-model.json")).map_err(storage_error)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    result
}

#[tauri::command]
pub async fn set_translation_model(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    let state = window.state::<crate::AppState>();
    switch(&state, &id)?;
    let _ = window.app_handle().emit("translation-model-changed", ());
    Ok(())
}

pub(crate) fn switch(state: &crate::AppState, id: &str) -> Result<(), String> {
    let _operation = state.begin("main")?;
    #[cfg(not(target_os = "android"))]
    let (_popup, _lens) = {
        let popup = state
            .popup_operation
            .lock()
            .map_err(|_| "処理状態を取得できません。")?;
        let lens = state
            .lens_operation
            .lock()
            .map_err(|_| "処理状態を取得できません。")?;
        if popup.is_some() || lens.is_some() {
            return Err("翻訳が終わってからモデルを変更してください。".into());
        }
        (popup, lens)
    };
    let _download = state
        .download
        .try_lock()
        .map_err(|_| "ダウンロードが終わってからモデルを変更してください。")?;
    #[cfg(not(target_os = "android"))]
    if state.lens_open.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("OCRレンズを閉じてからモデルを変更してください。".into());
    }
    #[cfg(target_os = "android")]
    let _screen = {
        let screen = state
            .screen
            .lock()
            .map_err(|_| "レンズの状態を取得できません。")?;
        if screen.is_some() {
            return Err("画面OCRレンズを閉じてからモデルを変更してください。".into());
        }
        screen
    };
    let mut engine = state
        .engine
        .try_lock()
        .map_err(|_| "翻訳・モデルの準備が終わってから切り替えてください。")?;
    if selected(&state.directory).id == id {
        return Ok(());
    }
    select(&state.directory, id)?;
    // Release both the old weights and their translation cache before reuse.
    *engine = None;
    Ok(())
}

impl Model {
    fn path(&self, directory: &Path) -> PathBuf {
        directory.join(self.filename)
    }

    fn receipt(&self, directory: &Path) -> PathBuf {
        // Reuse the receipt from releases before model selection was available.
        directory.join(if self.id == "0.8b-q4" {
            "model.json".to_owned()
        } else {
            format!("{}.json", self.filename)
        })
    }

    fn ready(&self, directory: &Path) -> bool {
        let Ok(bytes) = std::fs::read(self.receipt(directory)) else {
            return false;
        };
        let Ok(receipt) = serde_json::from_slice::<Receipt>(&bytes) else {
            return false;
        };
        if receipt
            .filename
            .as_deref()
            .is_some_and(|name| name != self.filename)
            || (receipt.filename.is_none() && self.id != "0.8b-q4")
        {
            return false;
        }
        std::fs::metadata(self.path(directory))
            .is_ok_and(|metadata| metadata.len() == receipt.size && receipt.size > 0)
    }
}

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
    #[serde(default)]
    filename: Option<String>,
    revision: String,
    sha256: String,
    size: u64,
}

pub fn path(directory: &Path) -> PathBuf {
    selected(directory).path(directory)
}

pub fn ready(directory: &Path) -> bool {
    selected(directory).ready(directory)
}

pub async fn download(
    directory: &Path,
    channel: &Channel<ProgressEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("保存先を作成できません: {error}"))?;
    let model = selected(directory);
    let partial = directory.join(format!("{}.part", model.filename));
    let receipt_partial = model.receipt(directory).with_extension("json.part");
    // Cancellation drops the network future and removes the incomplete file.
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("CANCELLED".to_owned()),
        result = download_inner(model, directory, &partial, &receipt_partial, channel) => result,
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        let _ = tokio::fs::remove_file(&receipt_partial).await;
    }
    result
}

async fn download_inner(
    model: &Model,
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
            "https://huggingface.co/api/models/{}?blobs=true",
            model.repository
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
        .find(|file| file.rfilename == model.filename)
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
        "https://huggingface.co/{}/resolve/{}/{}",
        model.repository, repository.sha, model.filename
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
        filename: Some(model.filename.to_owned()),
        revision: repository.sha,
        sha256: lfs.sha256,
        size: lfs.size,
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|error| error.to_string())?;
    tokio::fs::write(receipt_partial, bytes)
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(partial, model.path(directory))
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(receipt_partial, model.receipt(directory))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("plamo-model-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn keeps_existing_download_and_isolates_other_models() {
        let dir = directory();
        std::fs::write(MODELS[2].path(&dir), b"old weights").unwrap();
        std::fs::write(
            dir.join("model.json"),
            br#"{"revision":"old","sha256":"old","size":11}"#,
        )
        .unwrap();
        assert_eq!(selected(&dir).id, "0.8b-q4");
        assert!(ready(&dir));
        for model in [&MODELS[0], &MODELS[1], &MODELS[3]] {
            select(&dir, model.id).unwrap();
            assert!(!ready(&dir));
            assert_eq!(path(&dir), model.path(&dir));
            std::fs::write(path(&dir), b"new weights").unwrap();
            let receipt = Receipt {
                filename: Some(model.filename.into()),
                revision: "new".into(),
                sha256: "new".into(),
                size: 11,
            };
            std::fs::write(model.receipt(&dir), serde_json::to_vec(&receipt).unwrap()).unwrap();
            assert!(ready(&dir));
        }
        assert!(choices(&dir).iter().all(|model| model.ready));
        select(&dir, "0.8b-q4").unwrap();
        assert!(ready(&dir));
        assert_eq!(std::fs::read(path(&dir)).unwrap(), b"old weights");
        assert!(select(&dir, "../../external-model").is_err());
        assert_eq!(selected(&dir).id, "0.8b-q4");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn failed_or_cancelled_download_does_not_enable_another_model() {
        let dir = directory();
        select(&dir, "2b-q4").unwrap();
        let model = selected(&dir);
        std::fs::write(model.path(&dir), b"partial").unwrap();
        let receipt = Receipt {
            filename: Some(MODELS[2].filename.into()),
            revision: "old".into(),
            sha256: "old".into(),
            size: 7,
        };
        std::fs::write(model.receipt(&dir), serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(!ready(&dir));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            download(&dir, &Channel::new(|_| Ok(())), &cancel)
                .await
                .unwrap_err(),
            "CANCELLED"
        );
        assert!(!ready(&dir));
        assert_eq!(selected(&dir).id, "2b-q4");
        assert!(!dir.join(format!("{}.part", model.filename)).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    #[ignore = "downloads official GGUF files and runs the local translation engine"]
    async fn official_models_translate_locally() {
        let dir = PathBuf::from(std::env::var("PLAMO_MODEL_TEST_DIR").unwrap());
        let binary = PathBuf::from(std::env::var("PLAMO_RUNTIME").unwrap());
        for model in &MODELS {
            select(&dir, model.id).unwrap();
            let cancel = CancellationToken::new();
            if !ready(&dir) {
                download(&dir, &Channel::new(|_| Ok(())), &cancel)
                    .await
                    .unwrap();
            }
            let mut engine = crate::engine::Engine::start(&binary, &path(&dir), &cancel)
                .await
                .unwrap();
            for (source, target) in [
                ("Please close the door quietly.", "ja"),
                ("明日の会議は午後三時からです。", "en"),
            ] {
                let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
                let sink = output.clone();
                let channel = Channel::<ProgressEvent>::new(move |body| {
                    if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                        if value["kind"] == "token" {
                            sink.lock()
                                .unwrap()
                                .push_str(value["text"].as_str().unwrap());
                        }
                    }
                    Ok(())
                });
                let result = engine
                    .translate(source, target, &channel, &cancel)
                    .await
                    .unwrap();
                let output = output.lock().unwrap();
                assert!(!result.truncated && !output.trim().is_empty() && output.trim() != source);
                if target == "ja" {
                    assert!(output
                        .chars()
                        .any(|c| ('\u{3040}'..='\u{30ff}').contains(&c)));
                } else {
                    assert!(output.chars().any(|c| c.is_ascii_alphabetic()));
                }
                println!("{} {}: {}", model.id, target, output.trim());
            }
        }
    }
}
