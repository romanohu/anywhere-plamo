use crate::{dictionary, engine, model, protocol, recognize_file, AppState, ProgressEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Manager,
};
use tokio_util::sync::CancellationToken;

#[derive(Default, Deserialize)]
#[serde(default)]
struct Frame {
    stopped: bool,
    unchanged: bool,
    revision: i32,
    target: String,
    path: Option<PathBuf>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Block {
    text: String,
    #[serde(default)]
    source: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

async fn native(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    app.state::<tauri_plugin_plamo_ocr::Ocr>()
        .screen(command, args)
        .await
}

#[tauri::command]
pub async fn start_screen_lens(app: tauri::AppHandle, target: String) -> Result<(), String> {
    protocol::prompt("screen", &target)?;
    let state = app.state::<AppState>();
    if !model::ready(&state.directory) {
        return Err("設定画面から翻訳モデルをダウンロードしてください。".into());
    }
    if state
        .operation
        .lock()
        .map_err(|_| "処理状態を取得できません。")?
        .is_some()
    {
        return Err("現在の翻訳が終わってからレンズを開いてください。".into());
    }
    let stop = CancellationToken::new();
    let existing = {
        let mut slot = state
            .screen
            .lock()
            .map_err(|_| "レンズを開始できません。")?;
        if slot.is_some() {
            true
        } else {
            *slot = Some(stop.clone());
            false
        }
    };
    if existing {
        return native(&app, "resumeScreen", json!({})).await.map(|_| ());
    }
    if let Err(error) = native(&app, "startScreen", json!({ "target": target })).await {
        *state
            .screen
            .lock()
            .map_err(|_| "レンズを開始できません。")? = None;
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        let result = run(&app, &stop).await;
        stop.cancel();
        let _ = native(&app, "stopScreen", json!({ "error": result.err() })).await;
        if let Ok(mut slot) = app.state::<AppState>().screen.lock() {
            *slot = None;
        }
    });
    Ok(())
}

async fn translate(
    app: &tauri::AppHandle,
    text: &str,
    target: &str,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let text = state
        .dictionary
        .lock()
        .map(|entries| dictionary::apply(text, &entries))
        .map_err(|_| "辞書を読み込めません。")?;
    protocol::prompt(&text, target)?;
    let engine = state.engine.clone();
    let path = model::path(&state.directory);
    let cancel = cancel.clone();
    let target = target.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let output = Arc::new(Mutex::new(String::new()));
        let sink = output.clone();
        let channel = Channel::<ProgressEvent>::new(move |body| {
            if let InvokeResponseBody::Json(body) = body {
                if let Ok(event) = serde_json::from_str::<Value>(&body) {
                    if event["kind"] == "token" {
                        if let (Some(text), Ok(mut output)) = (event["text"].as_str(), sink.lock())
                        {
                            output.push_str(text);
                        }
                    }
                }
            }
            Ok(())
        });
        let mut engine = engine
            .lock()
            .map_err(|_| "翻訳エンジンを準備できません。")?;
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        if engine.is_none() {
            *engine = Some(engine::Engine::start(&path, &cancel)?);
        }
        let result = engine
            .as_mut()
            .unwrap()
            .translate(&text, &target, &channel, &cancel)?;
        if result.truncated {
            return Err("訳文が長すぎます。枠を狭めてください。".into());
        }
        let text = output.lock().map_err(|_| "訳文を取得できません。")?.clone();
        Ok(text)
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn read(
    app: &tauri::AppHandle,
    frame: &Frame,
    cancel: &CancellationToken,
) -> Result<Vec<Block>, String> {
    let path = frame.path.as_ref().ok_or("画面を取得できません。")?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("screen-lens")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(&directory)
    {
        return Err("画面の保存先が無効です。".into());
    }
    let mut blocks: Vec<Block> = serde_json::from_value(recognize_file(app, path, cancel).await?)
        .map_err(|_| "文字認識の結果を取得できません。")?;
    if blocks.len() > 128
        || blocks
            .iter()
            .map(|block| block.text.chars().count())
            .sum::<usize>()
            > 12000
    {
        return Err("文字が多すぎます。枠を狭めてください。".into());
    }
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    native(
        app,
        "screenResult",
        json!({ "revision": frame.revision, "blocks": [], "message": "翻訳中…" }),
    )
    .await?;
    for block in &mut blocks {
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        block.source = block.text.clone();
        block.text = translate(app, &block.source, &frame.target, cancel).await?;
    }
    Ok(blocks)
}

async fn run(app: &tauri::AppHandle, stop: &CancellationToken) -> Result<(), String> {
    let mut queued = None;
    loop {
        if stop.is_cancelled() {
            return Ok(());
        }
        let frame: Frame = match queued.take() {
            Some(frame) => frame,
            None => serde_json::from_value(native(app, "screenFrame", json!({})).await?)
                .map_err(|error| error.to_string())?,
        };
        if frame.stopped {
            return Ok(());
        }
        if frame.unchanged || frame.path.is_none() {
            tokio::time::sleep(Duration::from_millis(900)).await;
            continue;
        }
        let cancel = stop.child_token();
        let mut pending = Box::pin(read(app, &frame, &cancel));
        let mut interval = tokio::time::interval(Duration::from_millis(350));
        let result = loop {
            tokio::select! {
                result = &mut pending => break result,
                _ = interval.tick() => {
                    let current = native(app, "screenState", json!({})).await
                        .and_then(|value| serde_json::from_value::<Frame>(value).map_err(|error| error.to_string()));
                    let current = match current {
                        Ok(current) => current,
                        Err(error) => { cancel.cancel(); let _ = pending.await; return Err(error); }
                    };
                    if current.stopped || current.revision != frame.revision || stop.is_cancelled() {
                        cancel.cancel();
                        let _ = pending.await;
                        if current.stopped { return Ok(()); }
                        break Err("CANCELLED".into());
                    }
                }
            }
        };
        match result {
            Ok(blocks) => {
                // Recheck the captured scene before showing a result. A page may
                // scroll while OCR/model inference is in progress.
                let latest: Frame =
                    serde_json::from_value(native(app, "screenFrame", json!({})).await?)
                        .map_err(|error| error.to_string())?;
                if latest.stopped {
                    return Ok(());
                }
                if latest.revision != frame.revision || !latest.unchanged {
                    queued = Some(latest);
                    continue;
                }
                let message = if blocks.is_empty() {
                    "文字が見つかりません"
                } else {
                    "自動更新中"
                };
                native(
                    app,
                    "screenResult",
                    json!({ "revision": frame.revision, "blocks": blocks, "message": message }),
                )
                .await?;
            }
            Err(error) if error == "CANCELLED" => {}
            Err(error) => {
                native(
                    app,
                    "screenResult",
                    json!({ "revision": frame.revision, "blocks": [], "message": error }),
                )
                .await?;
            }
        }
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
}
