mod camera;
mod dictionary;
#[path = "mobile_engine.rs"]
mod engine;
mod model;
mod ocr_model;
mod screen_lens;
#[allow(dead_code)]
mod protocol;

use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressEvent {
    Download { received: u64, total: u64 },
    Verifying,
    Loading,
    Reading,
    Token { text: String },
}

struct AppState {
    directory: PathBuf,
    engine: Arc<Mutex<Option<engine::Engine>>>,
    preparation: Mutex<Option<CancellationToken>>,
    operation: Mutex<Option<CancellationToken>>,
    download: tokio::sync::Mutex<()>,
    dictionary_path: PathBuf,
    dictionary: Mutex<Vec<dictionary::Entry>>,
    ocr: MobileOcr,
    screen: Mutex<Option<CancellationToken>>,
}

struct Operation<'a> {
    slot: &'a Mutex<Option<CancellationToken>>,
    token: CancellationToken,
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = None;
        }
    }
}
impl AppState {
    fn begin(&self, _label: &str) -> Result<Operation<'_>, String> {
        let mut slot = self
            .operation
            .lock()
            .map_err(|_| "処理状態を取得できません。")?;
        if slot.is_some() {
            return Err("別の処理が実行中です。完了後に再試行してください。".into());
        }
        let token = CancellationToken::new();
        *slot = Some(token.clone());
        Ok(Operation {
            slot: &self.operation,
            token,
        })
    }
    fn cancel(&self) {
        if let Ok(slot) = self.operation.lock() {
            if let Some(token) = slot.as_ref() {
                token.cancel();
            }
        }
    }
}

struct MobileOcr {
    app: tauri::AppHandle,
    directory: PathBuf,
    enabled: AtomicBool,
    gate: tokio::sync::Mutex<()>,
}
impl MobileOcr {
    fn model_directory(&self) -> &std::path::Path {
        &self.directory
    }
    fn korean_status(&self) -> ocr_model::Status {
        ocr_model::Status {
            ready: ocr_model::ready(&self.directory),
            enabled: self.enabled.load(Ordering::Relaxed),
        }
    }
    async fn set_korean(&self, enabled: bool) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        ocr_model::save_enabled(&self.directory, enabled).await?;
        self.enabled.store(enabled, Ordering::Relaxed);
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<tauri_plugin_plamo_ocr::Ocr>().release()
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[tauri::command]
fn get_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "platform": "android", "modelReady": model::ready(&state.directory), "runtimeAvailable": true,
        "ocrAvailable": true, "lensSupported": true, "shortcutAvailable": false,
        "shortcut": "", "defaultShortcut": "", "shortcutSupported": false, "shortcutPopup": false,
        "wayland": false, "resident": false, "lensUsesSelection": false, "lensShortcut": "",
        "defaultLensShortcut": "", "lensShortcutAvailable": false, "lensOpenShortcut": "",
        "defaultLensOpenShortcut": "", "lensOpenShortcutAvailable": false, "lensPassthrough": false
    })
}

#[tauri::command]
async fn download_model(
    state: tauri::State<'_, AppState>,
    on_event: Channel<ProgressEvent>,
) -> Result<(), String> {
    let operation = state.begin("main")?;
    let _guard = state.download.lock().await;
    if model::ready(&state.directory) {
        return Ok(());
    }
    model::download(&state.directory, &on_event, &operation.token).await
}

#[tauri::command]
async fn prepare_engine(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if !model::ready(&state.directory) {
        return Err("設定画面から翻訳モデルをダウンロードしてください。".into());
    }
    let cancel = CancellationToken::new();
    {
        let mut preparing = state
            .preparation
            .lock()
            .map_err(|_| "処理状態を取得できません。")?;
        if preparing.is_some() {
            return Ok(());
        }
        *preparing = Some(cancel.clone());
    }
    let engine = state.engine.clone();
    let path = model::path(&state.directory);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut engine = engine
            .lock()
            .map_err(|_| "翻訳エンジンを準備できません。")?;
        if engine.is_none() {
            *engine = Some(engine::Engine::start(&path, &cancel)?);
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string());
    if let Ok(mut preparing) = state.preparation.lock() {
        *preparing = None;
    }
    result?
}

#[tauri::command]
async fn translate(
    state: tauri::State<'_, AppState>,
    text: String,
    target: String,
    on_event: Channel<ProgressEvent>,
) -> Result<engine::TranslationResult, String> {
    let text = state
        .dictionary
        .lock()
        .map(|entries| dictionary::apply(&text, &entries))
        .map_err(|_| "辞書を読み込めません。")?;
    protocol::prompt(&text, &target)?;
    let operation = state.begin("main")?;
    if !model::ready(&state.directory) {
        return Err("設定画面から翻訳モデルをダウンロードしてください。".into());
    }
    let engine = state.engine.clone();
    let cancel = operation.token.clone();
    let path = model::path(&state.directory);
    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = engine
            .lock()
            .map_err(|_| "翻訳エンジンを準備できません。")?;
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        if engine.is_none() {
            on_event
                .send(ProgressEvent::Loading)
                .map_err(|_| "画面との接続が切れました。")?;
            *engine = Some(engine::Engine::start(&path, &cancel)?);
        }
        engine
            .as_mut()
            .unwrap()
            .translate(&text, &target, &on_event, &cancel)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_operation(state: tauri::State<'_, AppState>) {
    state.cancel();
}

#[tauri::command]
async fn recognize_camera(
    app: tauri::AppHandle,
    image: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let operation = state.begin("main")?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let capture =
        tauri::async_runtime::spawn_blocking(move || camera::Capture::new(&cache, &image))
            .await
            .map_err(|error| error.to_string())??;
    recognize_file(&app, &capture.path, &operation.token).await
}

async fn recognize_file(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let _guard = state.ocr.gate.lock().await;
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    let korean = state
        .ocr
        .enabled
        .load(Ordering::Relaxed)
        .then(|| ocr_model::path(&state.ocr.directory));
    let ocr = app.state::<tauri_plugin_plamo_ocr::Ocr>();
    let mut pending = Box::pin(ocr.recognize(
        path.to_str().ok_or("画像のパスが無効です。")?,
        korean.as_deref().and_then(std::path::Path::to_str),
    ));
    tokio::select! {
        // Dispatch recognition before cancellation, even if already cancelled.
        biased;
        result = &mut pending => result,
        _ = cancel.cancelled() => {
            let _ = ocr.cancel().await;
            // Keep the private image alive until native inference has actually stopped.
            let _ = pending.await;
            Err("CANCELLED".into())
        }
    }
}

#[tauri::command]
fn get_dictionary(state: tauri::State<'_, AppState>) -> Vec<dictionary::Entry> {
    state
        .dictionary
        .lock()
        .map(|entries| entries.clone())
        .unwrap_or_default()
}
#[tauri::command]
fn set_dictionary(
    state: tauri::State<'_, AppState>,
    entries: Vec<dictionary::Entry>,
) -> Result<Vec<dictionary::Entry>, String> {
    let mut normalized: Vec<dictionary::Entry> = Vec::new();
    for mut entry in entries {
        entry.term = entry.term.trim().into();
        entry.replacement = entry.replacement.trim().into();
        if !entry.term.is_empty() && !normalized.iter().any(|value| value.term == entry.term) {
            normalized.push(entry);
        }
    }
    dictionary::PendingSave::new(&state.dictionary_path, &normalized)?.commit()?;
    *state
        .dictionary
        .lock()
        .map_err(|_| "辞書を保存できません。")? = normalized.clone();
    Ok(normalized)
}
#[tauri::command]
fn take_pending_clipboard() -> Option<String> {
    None
}
#[tauri::command]
fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|error| error.to_string())
}
#[tauri::command]
fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}
#[tauri::command]
fn open_model_license(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<tauri_plugin_plamo_ocr::Ocr>().open_license()
}

#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .manage(camera::PermissionOrigin::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_plamo_ocr::init())
        .on_page_load(camera::page_load)
        .on_permission_request(camera::permission)
        .invoke_handler(tauri::generate_handler![
            get_status,
            download_model,
            prepare_engine,
            translate,
            cancel_operation,
            recognize_camera,
            screen_lens::start_screen_lens,
            get_dictionary,
            set_dictionary,
            take_pending_clipboard,
            read_clipboard,
            write_clipboard,
            open_model_license,
            ocr_model::get_korean_ocr,
            ocr_model::set_korean_ocr,
            ocr_model::download_korean_ocr,
            ocr_model::remove_korean_ocr
        ])
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            let dictionary_path = directory.join("dictionary.json");
            let ocr_directory = directory.join("ocr-models");
            app.manage(AppState {
                dictionary: Mutex::new(dictionary::load(&dictionary_path)),
                dictionary_path,
                directory: directory.join("models"),
                engine: Arc::new(Mutex::new(None)),
                operation: Mutex::new(None),
                screen: Mutex::new(None),
                preparation: Mutex::new(None),
                download: tokio::sync::Mutex::new(()),
                ocr: MobileOcr {
                    app: app.handle().clone(),
                    enabled: AtomicBool::new(ocr_model::enabled(&ocr_directory)),
                    directory: ocr_directory,
                    gate: tokio::sync::Mutex::new(()),
                },
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Suspended) {
                let state = window.state::<AppState>();
                state.cancel();
                if let Ok(preparing) = state.preparation.lock() {
                    if let Some(token) = preparing.as_ref() {
                        token.cancel();
                    }
                }
                let _ = window.emit("window-hidden", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Anywhere Plamo");
}
