use super::{check_text_limit, Region, TextBlock};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

pub const EXECUTABLE: &str = if cfg!(windows) {
    "ocr/ocr-worker.exe"
} else {
    "ocr/ocr-worker"
};

#[derive(Default)]
pub struct Ocr {
    worker: Mutex<Option<Worker>>,
    model_directory: PathBuf,
    korean: AtomicBool,
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Ocr {
    pub fn new(model_directory: PathBuf) -> Self {
        Self {
            korean: AtomicBool::new(crate::ocr_model::enabled(&model_directory)),
            model_directory,
            worker: Mutex::new(None),
        }
    }

    pub fn model_directory(&self) -> &Path {
        &self.model_directory
    }

    pub fn korean_status(&self) -> crate::ocr_model::Status {
        crate::ocr_model::Status {
            ready: crate::ocr_model::ready(&self.model_directory),
            enabled: self.korean.load(Ordering::Relaxed),
        }
    }

    pub async fn set_korean(&self, enabled: bool) -> Result<(), String> {
        let mut worker = self.worker.lock().await;
        crate::ocr_model::save_enabled(&self.model_directory, enabled).await?;
        if self.korean.swap(enabled, Ordering::Relaxed) != enabled {
            // Restart to release ONNX allocations, including its thread pools.
            if let Some(mut worker) = worker.take() {
                let _ = worker.child.kill().await;
            }
        }
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(mut worker) = self.worker.lock().await.take() {
            let _ = worker.child.kill().await;
        }
    }

    pub async fn recognize(
        &self,
        runtime: &Path,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<TextBlock>, String> {
        let mut worker = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("CANCELLED".into()),
            worker = self.worker.lock() => worker,
        };
        if worker.is_none() {
            let mut command = Command::new(runtime.join(EXECUTABLE));
            command.arg(runtime.join("ocr-models"));
            if self.korean.load(Ordering::Relaxed) {
                command.arg(crate::ocr_model::path(&self.model_directory));
            }
            #[cfg(windows)]
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW, retaining the JSON pipes.
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| "文字認識エンジンを起動できません。npm run ocr:build またはアプリの再インストールを試してください。")?;
            *worker = Some(Worker {
                input: child.stdin.take().expect("piped OCR input"),
                output: BufReader::new(child.stdout.take().expect("piped OCR output")),
                child,
            });
        }
        // Own the process across await points. If this future is dropped (rather
        // than its token being cancelled), kill_on_drop must discard its pending
        // response too; otherwise the next frame could receive the previous OCR.
        let mut running = worker.take().unwrap();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".into()),
            result = tokio::time::timeout(Duration::from_secs(60), running.read(path)) => {
                result.unwrap_or_else(|_| Err("文字認識がタイムアウトしました。範囲を小さくして再試行してください。".into()))
            }
        };
        if result.is_err() {
            // Discard the pending response on cancellation/error. The next request
            // starts a fresh worker, so stale results cannot reach another frame.
            let _ = running.child.kill().await;
        } else {
            *worker = Some(running);
        }
        result
    }
}

impl Worker {
    async fn read(&mut self, path: &Path) -> Result<Vec<TextBlock>, String> {
        let error = "文字認識の結果を取得できませんでした。OCRデータを更新して再試行してください。";
        let mut request =
            serde_json::to_vec(&serde_json::json!({"path": path})).map_err(|_| error)?;
        request.push(b'\n');
        self.input.write_all(&request).await.map_err(|_| error)?;
        self.input.flush().await.map_err(|_| error)?;
        let limit = crate::protocol::MAX_CHARACTERS * 256;
        let mut bytes = Vec::new();
        (&mut self.output)
            .take(limit as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| error)?;
        if bytes.len() > limit {
            return Err("文字が多すぎます。読み取る範囲を小さくしてください。".into());
        }
        parse_response(&bytes)
    }
}

fn parse_response(bytes: &[u8]) -> Result<Vec<TextBlock>, String> {
    #[derive(serde::Deserialize)]
    struct Response {
        blocks: Vec<TextBlock>,
    }
    let invalid = "文字認識の位置情報を取得できませんでした。";
    let response: Response = serde_json::from_slice(bytes).map_err(|_| invalid)?;
    let valid = |r: &Region| {
        [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
            && r.x >= 0.0
            && r.y >= 0.0
            && r.width > 0.0
            && r.height > 0.0
            && r.x + r.width <= 1.000001
            && r.y + r.height <= 1.000001
    };
    for block in &response.blocks {
        if block.text.trim().is_empty()
            || !valid(&Region {
                x: block.x,
                y: block.y,
                width: block.width,
                height: block.height,
            })
            || block.regions.is_empty()
            || !block.regions.iter().all(valid)
        {
            return Err(invalid.into());
        }
    }
    check_text_limit(&response.blocks)?;
    Ok(response.blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_request_discards_its_worker_and_pending_response() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("plamo-ocr-abort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("ocr")).unwrap();
        let executable = directory.join(EXECUTABLE);
        std::fs::write(
            &executable,
            "#!/bin/sh\nread -r request\necho $$ > \"$1\"\nexec sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ocr = std::sync::Arc::new(Ocr::default());
        let operation = ocr.clone();
        let runtime = directory.clone();
        let task = tokio::spawn(async move {
            operation
                .recognize(
                    &runtime,
                    &runtime.join("capture.png"),
                    &CancellationToken::new(),
                )
                .await
        });
        let pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(directory.join("ocr-models")) {
                    if let Ok(pid) = value.trim().parse::<u32>() {
                        break pid.to_string();
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(ocr.worker.lock().await.is_none());
        tokio::time::timeout(Duration::from_secs(3), async {
            while std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("aborted OCR worker remained alive");
        std::fs::write(
            &executable,
            "#!/bin/sh\nwhile read -r request; do echo '{\"blocks\":[]}'; done\n",
        )
        .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            ocr.recognize(
                &directory,
                &directory.join("next.png"),
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("next request reused the aborted worker")
        .unwrap();
        assert!(result.is_empty());
        ocr.stop().await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires bundled OCR and ANYWHERE_PLAMO_KOREAN_MODEL pointing to the optional weight"]
    async fn korean_toggle_releases_worker_and_preserves_japanese_and_english() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let directory =
            std::env::temp_dir().join(format!("plamo-ocr-toggle-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::copy(
            std::env::var_os("ANYWHERE_PLAMO_KOREAN_MODEL").unwrap(),
            crate::ocr_model::path(&directory),
        )
        .await
        .unwrap();
        let ocr = Ocr::new(directory.clone());
        assert!(!ocr.korean_status().enabled);
        let runtime = root.join("resources/runtime");
        let image = root.join("../tests/fixtures/ocr-korean-mixed.png");
        let cancel = CancellationToken::new();
        for enabled in [false, true, false] {
            ocr.set_korean(enabled).await.unwrap();
            assert!(ocr.worker.lock().await.is_none());
            assert_eq!(Ocr::new(directory.clone()).korean_status().enabled, enabled);
            let blocks = ocr.recognize(&runtime, &image, &cancel).await.unwrap();
            let text = blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            assert!(
                text.contains("Local translation") && text.contains("画像"),
                "{text}"
            );
            assert_eq!(
                text.contains("한국어 문장을 일본어로 번역합니다"),
                enabled,
                "{text}"
            );
        }
        ocr.stop().await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[test]
    fn validates_worker_geometry_text_limits_and_empty_pages() {
        let region = serde_json::json!({"x":0.1,"y":0.2,"width":0.5,"height":0.1});
        let mut block = region.clone();
        block["text"] = "本文です。".into();
        block["regions"] = serde_json::json!([region]);
        let encode = |block: &serde_json::Value| {
            serde_json::to_vec(&serde_json::json!({"blocks":[block]})).unwrap()
        };
        assert_eq!(
            parse_response(&encode(&block)).unwrap()[0].text,
            "本文です。"
        );
        assert!(parse_response(br#"{"blocks":[]}"#).unwrap().is_empty());
        assert!(parse_response(br#"{"error":"failed"}"#).is_err());
        block["x"] = 0.9.into();
        assert!(parse_response(&encode(&block)).is_err());
        block["x"] = 0.1.into();
        block["regions"][0]["height"] = (-0.1).into();
        assert!(parse_response(&encode(&block)).is_err());
        block["regions"][0]["height"] = 0.1.into();
        block["text"] = "😀".repeat(6001).into();
        assert!(parse_response(&encode(&block))
            .unwrap_err()
            .contains("多すぎ"));
    }
}
