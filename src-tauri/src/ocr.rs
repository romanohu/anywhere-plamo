use super::{check_text_limit, Region, TextBlock};
use std::{path::Path, process::Stdio, time::Duration};
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
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Ocr {
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
            #[cfg(windows)]
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW, retaining the JSON pipes.
            let mut child = command
                .arg(runtime.join("ocr-models"))
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
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".into()),
            result = tokio::time::timeout(Duration::from_secs(60), worker.as_mut().unwrap().read(path)) => {
                result.unwrap_or_else(|_| Err("文字認識がタイムアウトしました。範囲を小さくして再試行してください。".into()))
            }
        };
        if result.is_err() {
            // Discard the pending response on cancellation/error. The next request
            // starts a fresh worker, so stale results cannot reach another frame.
            if let Some(mut stopped) = worker.take() {
                let _ = stopped.child.kill().await;
            }
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
