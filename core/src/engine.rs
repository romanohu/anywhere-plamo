use serde::Serialize;
use serde_json::{json, Value};
use std::{
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

use crate::{
    protocol::{self, SseDecoder},
    Progress, ProgressEvent,
};

pub const EXECUTABLE: &str = if cfg!(windows) {
    "llama-server.exe"
} else {
    "llama-server"
};

pub const GPU_EXECUTABLE: &str = if cfg!(windows) {
    "llama-server-cuda.exe"
} else {
    "llama-server-cuda"
};

/// Picks the CUDA server next to `cpu` when it can see a GPU, else `cpu`.
/// `marker` records a confirmed GPU so later launches skip the probe; without it the GPU is probed again.
pub async fn select_binary(cpu: &Path, marker: &Path) -> std::path::PathBuf {
    let gpu = cpu.with_file_name(GPU_EXECUTABLE);
    if !gpu.is_file() {
        return cpu.to_owned();
    }
    if marker.is_file() {
        return gpu;
    }
    let mut command = tokio::process::Command::new(&gpu);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
        .arg("--list-devices")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // A missing CUDA runtime fails to start; a missing GPU lists "(none)".
    let found = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .is_ok_and(|output| {
            output.is_ok_and(|output| {
                output.status.success() && lists_gpu(&String::from_utf8_lossy(&output.stdout))
            })
        });
    if !found {
        return cpu.to_owned();
    }
    let _ = std::fs::write(marker, "");
    gpu
}

/// Starts the CUDA server when the device has a GPU, else the CPU server at `cpu`.
/// A GPU that stops working falls back to the CPU server and is probed again next launch.
pub async fn start_best(
    cpu: &Path,
    model: &Path,
    marker: &Path,
    cancel: &CancellationToken,
) -> Result<Engine, String> {
    let binary = select_binary(cpu, marker).await;
    match Engine::start(&binary, model, cancel).await {
        Err(error) if binary != cpu && error != "CANCELLED" => {
            let _ = std::fs::remove_file(marker);
            Engine::start(cpu, model, cancel).await
        }
        result => result,
    }
}

fn lists_gpu(devices: &str) -> bool {
    devices
        .lines()
        .any(|line| line.trim_start().starts_with("CUDA") && line.contains(':'))
}

pub struct Engine {
    child: Child,
    url: String,
    key: String,
    client: reqwest::Client,
    cache: TranslationCache,
}

use crate::translation_cache::TranslationCache;

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
pub struct TranslationResult {
    pub truncated: bool,
}

enum TranslationChunk<'a> {
    Prompt { prompt: String, input_length: usize },
    Separator(&'a str),
}

impl Engine {
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn start(
        binary: &Path,
        model: &Path,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .map_err(|error| format!("ローカル接続を準備できません: {error}"))?
            .port();
        let key = uuid::Uuid::new_v4().to_string();
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(binary);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        // Drop only runs on a clean exit; also stop the server when the app is killed
        // (e.g. a dev rebuild), so it does not keep the model in memory. The signal follows
        // the spawning thread, which is a runtime worker that lives as long as the app.
        #[cfg(target_os = "linux")]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .arg("--model")
            .arg(model)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--api-key",
                &key,
                "--alias",
                "plamo-3-translate",
                "--ctx-size",
                "8192",
                "--parallel",
                "1",
                // The app caches final translations. Keep only the live slot's KV prefix,
                // rather than llama-server's additional (default 8 GiB) prompt snapshots.
                "--cache-ram",
                "0",
                "--no-warmup",
                "--log-disable",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if std::thread::available_parallelism().is_ok_and(|threads| threads.get() > 8)
            && std::env::var_os("LLAMA_ARG_THREADS").is_none()
        {
            command.args(["--threads", "8"]);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("翻訳エンジンを起動できません: {error}"))?;
        let mut engine = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            key,
            client,
            cache: TranslationCache::default(),
        };
        let started = Instant::now();
        loop {
            if !engine.alive() {
                return Err(
                    "翻訳エンジンが終了しました。モデル、空きメモリ、実行環境を確認してください。"
                        .into(),
                );
            }
            if started.elapsed() > Duration::from_secs(120) {
                return Err("モデルの読み込みがタイムアウトしました。空きメモリを確認して再試行してください。".into());
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err("CANCELLED".into()),
                result = engine.client.get(format!("{}/health", engine.url)).bearer_auth(&engine.key).timeout(Duration::from_secs(2)).send() => {
                    if result.is_ok_and(|response| response.status().is_success()) { return Ok(engine); }
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err("CANCELLED".into()),
                _ = tokio::time::sleep(Duration::from_millis(150)) => {}
            }
        }
    }

    pub async fn translate(
        &mut self,
        text: &str,
        target: &str,
        glossary: &[(String, String)],
        progress: Progress<'_>,
        cancel: &CancellationToken,
    ) -> Result<TranslationResult, String> {
        // The whole prompt keys the cache so a changed glossary is translated again.
        let key = protocol::prompt_with_glossary(text, target, glossary)?;
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        if let Some(output) = self.cache.get(&key, target) {
            progress(ProgressEvent::Token { text: output })
                .map_err(|_| "画面との接続が切れました。")?;
            return Ok(TranslationResult { truncated: false });
        }
        let mut output = String::new();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".into()),
            result = self.translate_text(text, target, glossary, progress, cancel, &mut output) => result,
        }?;
        if !result.truncated && !output.trim().is_empty() && !cancel.is_cancelled() {
            self.cache.insert(&key, target, output);
        }
        Ok(result)
    }

    async fn translate_text(
        &self,
        text: &str,
        target: &str,
        glossary: &[(String, String)],
        progress: Progress<'_>,
        cancel: &CancellationToken,
        output: &mut String,
    ) -> Result<TranslationResult, String> {
        let prompt = protocol::prompt_with_glossary(text, target, glossary)?;
        let input_length = self.input_length(&prompt).await?;
        if input_length <= protocol::MAX_INPUT_TOKENS {
            return self
                .translate_inner(&prompt, input_length, progress, output)
                .await;
        }
        let mut chunks = Vec::new();
        for part in protocol::paragraphs(text) {
            match part {
                protocol::Paragraph::Text(text) => {
                    let glossary: Vec<_> = glossary
                        .iter()
                        .filter(|(term, _)| text.contains(term.as_str()))
                        .cloned()
                        .collect();
                    let prompt = protocol::prompt_with_glossary(text, target, &glossary)?;
                    let input_length = self.input_length(&prompt).await?;
                    if input_length > protocol::MAX_INPUT_TOKENS {
                        return Err(
                            "1段落が長すぎます。空行を入れて、さらに短い段落に分けてください。"
                                .into(),
                        );
                    }
                    chunks.push(TranslationChunk::Prompt {
                        prompt,
                        input_length,
                    });
                }
                protocol::Paragraph::Separator(text) => {
                    chunks.push(TranslationChunk::Separator(text));
                }
            }
        }
        // Validate every paragraph before streaming any partial translation.
        for chunk in chunks {
            if cancel.is_cancelled() {
                return Err("CANCELLED".into());
            }
            match chunk {
                TranslationChunk::Prompt {
                    prompt,
                    input_length,
                } => {
                    let result = self
                        .translate_inner(&prompt, input_length, progress, output)
                        .await?;
                    if result.truncated {
                        return Ok(result);
                    }
                }
                TranslationChunk::Separator(text) => {
                    progress(ProgressEvent::Token {
                        text: text.to_owned(),
                    })
                    .map_err(|_| "画面との接続が切れました。")?;
                    output.push_str(text);
                }
            }
        }
        Ok(TranslationResult { truncated: false })
    }

    async fn input_length(&self, prompt: &str) -> Result<usize, String> {
        let tokens: Value = self
            .client
            .post(format!("{}/tokenize", self.url))
            .bearer_auth(&self.key)
            .json(&json!({ "content": prompt, "add_special": true, "parse_special": true }))
            .send()
            .await
            .map_err(connection_error)?
            .error_for_status()
            .map_err(connection_error)?
            .json()
            .await
            .map_err(connection_error)?;
        Ok(tokens["tokens"]
            .as_array()
            .map(Vec::len)
            .ok_or("原文の長さを確認できませんでした。")?)
    }

    async fn translate_inner(
        &self,
        prompt: &str,
        input_length: usize,
        progress: Progress<'_>,
        output: &mut String,
    ) -> Result<TranslationResult, String> {
        let mut response = self
            .client
            .post(format!("{}/v1/completions", self.url))
            .bearer_auth(&self.key)
            .json(&json!({
                "model": "plamo-3-translate", "prompt": prompt, "temperature": 0,
                "max_tokens": protocol::CONTEXT_TOKENS - input_length,
                "stop": ["<|plamo:tag|>", "<|plamo:bos|>"], "stream": true,
            }))
            .send()
            .await
            .map_err(connection_error)?
            .error_for_status()
            .map_err(connection_error)?;
        let mut decoder = SseDecoder::default();
        let mut completed = false;
        let mut truncated = false;
        let mut received_text = false;
        while let Some(chunk) = response.chunk().await.map_err(connection_error)? {
            for event in decoder.push(&chunk)? {
                Self::handle_event(
                    &event,
                    progress,
                    &mut completed,
                    &mut truncated,
                    &mut received_text,
                    output,
                )?;
                if completed {
                    break;
                }
            }
            if completed {
                break;
            }
        }
        if !completed {
            for event in decoder.finish()? {
                Self::handle_event(
                    &event,
                    progress,
                    &mut completed,
                    &mut truncated,
                    &mut received_text,
                    output,
                )?;
                if completed {
                    break;
                }
            }
        }
        if !completed {
            return Err("翻訳中に接続が切れました。もう一度お試しください。".into());
        }
        if !received_text {
            return Err(
                "訳文が生成されませんでした。文章や翻訳先を変更してお試しください。".into(),
            );
        }
        Ok(TranslationResult { truncated })
    }

    fn handle_event(
        event: &str,
        progress: Progress<'_>,
        completed: &mut bool,
        truncated: &mut bool,
        received_text: &mut bool,
        output: &mut String,
    ) -> Result<(), String> {
        if event == "[DONE]" {
            return if *completed {
                Ok(())
            } else {
                Err("翻訳中に接続が切れました。もう一度お試しください。".into())
            };
        }
        let value: Value = serde_json::from_str(event)
            .map_err(|_| "翻訳エンジンの応答を読み取れませんでした。")?;
        if value.get("error").is_some() {
            return Err(
                "翻訳エンジンでエラーが発生しました。文章を短くしてお試しください。".into(),
            );
        }
        let reason = &value["choices"][0]["finish_reason"];
        if !reason.is_null() && !matches!(reason.as_str(), Some("stop" | "length")) {
            return Err(
                "訳文を最後まで生成できませんでした。文章を短くしてお試しください。".into(),
            );
        }
        if let Some(text) = value["choices"][0]["text"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            *received_text = true;
            output.push_str(text);
            progress(ProgressEvent::Token {
                text: text.to_owned(),
            })
            .map_err(|_| "画面との接続が切れました。")?;
        }
        if let Some(reason) = reason.as_str() {
            *truncated = reason == "length";
            *completed = true;
        }
        Ok(())
    }
}

fn connection_error(error: reqwest::Error) -> String {
    format!(
        "翻訳エンジンと通信できませんでした。もう一度お試しください。({})",
        error.without_url()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn gpu_probe_reads_llama_server_device_list() {
        assert!(lists_gpu(
            "Available devices:\n  CUDA0: NVIDIA GeForce RTX 4060 (7798 MiB, 3858 MiB free)\n"
        ));
        assert!(!lists_gpu("Available devices:\n  (none)\n"));
        assert!(!lists_gpu(""));
    }

    type Sink = Box<dyn Fn(ProgressEvent) -> Result<(), ()> + Send + Sync>;

    fn channel() -> (Sink, Arc<Mutex<Vec<String>>>) {
        let texts = Arc::new(Mutex::new(Vec::new()));
        let output = texts.clone();
        let channel: Sink = Box::new(move |event| {
            if let ProgressEvent::Token { text } = event {
                output.lock().unwrap().push(text);
            }
            Ok(())
        });
        (channel, texts)
    }

    #[test]
    fn streams_text_and_requires_a_known_finish_reason() {
        for reason in ["stop", "length"] {
            let (channel, texts) = channel();
            let mut output = String::new();
            let (mut completed, mut truncated, mut received) = (false, false, false);
            Engine::handle_event(
                r#"{"choices":[{"text":"こんにちは","finish_reason":null}]}"#,
                &channel,
                &mut completed,
                &mut truncated,
                &mut received,
                &mut output,
            )
            .unwrap();
            assert!(!completed);
            assert!(received);
            Engine::handle_event(
                &json!({"choices": [{"text": "🍃", "finish_reason": reason}]}).to_string(),
                &channel,
                &mut completed,
                &mut truncated,
                &mut received,
                &mut output,
            )
            .unwrap();
            assert!(completed);
            assert_eq!(truncated, reason == "length");
            assert_eq!(*texts.lock().unwrap(), ["こんにちは", "🍃"]);
            assert_eq!(output, "こんにちは🍃");
            Engine::handle_event(
                "[DONE]",
                &channel,
                &mut completed,
                &mut truncated,
                &mut received,
                &mut output,
            )
            .unwrap();
        }
    }

    #[test]
    fn done_without_a_finish_reason_rejects_partial_output() {
        let (channel, texts) = channel();
        let (mut completed, mut truncated, mut received) = (false, false, false);
        Engine::handle_event(
            r#"{"choices":[{"text":"partial translation","finish_reason":null}]}"#,
            &channel,
            &mut completed,
            &mut truncated,
            &mut received,
            &mut String::new(),
        )
        .unwrap();
        assert!(Engine::handle_event(
            "[DONE]",
            &channel,
            &mut completed,
            &mut truncated,
            &mut received,
            &mut String::new(),
        )
        .is_err());
        assert!(!completed);
        assert!(received);
        assert_eq!(*texts.lock().unwrap(), ["partial translation"]);
    }

    #[test]
    fn rejects_error_or_unknown_finish_events_before_sending_their_text() {
        for event in [
            r#"{"error":{"message":"failed"}}"#,
            r#"{"choices":[{"text":"incomplete","finish_reason":"error"}]}"#,
            r#"{"choices":[{"text":"incomplete","finish_reason":"content_filter"}]}"#,
            r#"{"choices":[{"text":"incomplete","finish_reason":42}]}"#,
        ] {
            let (channel, texts) = channel();
            let (mut completed, mut truncated, mut received) = (false, false, false);
            assert!(Engine::handle_event(
                event,
                &channel,
                &mut completed,
                &mut truncated,
                &mut received,
                &mut String::new(),
            )
            .is_err());
            assert!(!completed);
            assert!(!received);
            assert!(texts.lock().unwrap().is_empty());
        }
    }
}
