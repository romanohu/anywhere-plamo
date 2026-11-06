#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod model;
mod protocol;
mod selection;
mod shortcut;

use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressEvent {
    Download { received: u64, total: u64 },
    Verifying,
    Loading,
    Token { text: String },
}

#[derive(Clone, Serialize)]
struct PendingClipboard {
    text: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct PendingRequests {
    current: u64,
    value: Option<PendingClipboard>,
}

impl PendingRequests {
    fn begin(&mut self) -> u64 {
        self.current += 1;
        self.value = None;
        self.current
    }

    fn deliver(&mut self, request: u64, value: PendingClipboard) -> bool {
        if request != self.current {
            return false;
        }
        self.value = Some(value);
        true
    }
}

struct AppState {
    directory: PathBuf,
    binary: PathBuf,
    engine: tokio::sync::Mutex<Option<engine::Engine>>,
    preparation: CancellationToken,
    operation: Mutex<Option<CancellationToken>>,
    pending: Mutex<PendingRequests>,
    shortcut: Mutex<shortcut::State>,
    shortcut_recording: AtomicBool,
    settings: PathBuf,
    resident: AtomicBool,
    wayland: bool,
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
    fn begin(&self) -> Result<Operation<'_>, String> {
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

    async fn lock_engine(
        &self,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<engine::Engine>>, String> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".into()),
            engine = self.engine.lock() => Ok(engine),
        }
    }

    async fn start_engine(
        &self,
        engine: &mut Option<engine::Engine>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // Drop a stopped process before attempting another launch.
        *engine = None;
        *engine =
            Some(engine::Engine::start(&self.binary, &model::path(&self.directory), cancel).await?);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    model_ready: bool,
    runtime_available: bool,
    shortcut_available: bool,
    shortcut: String,
    default_shortcut: String,
    shortcut_supported: bool,
    wayland: bool,
    resident: bool,
}

#[tauri::command]
fn get_status(state: tauri::State<'_, AppState>) -> AppStatus {
    let shortcut = state.shortcut.lock().expect("shortcut state poisoned");
    AppStatus {
        model_ready: model::ready(&state.directory),
        runtime_available: state.binary.is_file(),
        shortcut_available: shortcut.available,
        shortcut: shortcut::label(shortcut.binding),
        default_shortcut: shortcut::label(shortcut::default()),
        shortcut_supported: shortcut.supported,
        wayland: state.wayland,
        resident: state.resident.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn set_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    shortcut: String,
) -> Result<AppStatus, String> {
    let next = shortcut::parse(&shortcut)?;
    {
        let mut current = state
            .shortcut
            .lock()
            .map_err(|_| "ショートカットの状態を取得できません。")?;
        if !current.supported {
            return Err(shortcut::UNAVAILABLE.into());
        }
        let pending = shortcut::PendingSave::new(&state.settings, next)?;
        current.change(
            next,
            |key| {
                if app.global_shortcut().is_registered(key) {
                    Ok(())
                } else {
                    app.global_shortcut().register(key).map_err(|_| ())
                }
            },
            |key| app.global_shortcut().unregister(key).map_err(|_| ()),
            || pending.commit(),
        )?;
    }
    Ok(get_status(state))
}

#[tauri::command]
fn set_shortcut_recording(state: tauri::State<'_, AppState>, recording: bool) {
    state.shortcut_recording.store(recording, Ordering::Relaxed);
}

#[tauri::command]
async fn download_model(
    state: tauri::State<'_, AppState>,
    on_event: Channel<ProgressEvent>,
) -> Result<(), String> {
    let operation = state.begin()?;
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
    if !state.binary.is_file() {
        return Err("翻訳エンジンが見つかりません。".into());
    }
    let mut engine = state.lock_engine(&state.preparation).await?;
    if !engine.as_mut().is_some_and(|engine| engine.alive()) {
        state.start_engine(&mut engine, &state.preparation).await?;
    }
    Ok(())
}

#[tauri::command]
async fn translate(
    state: tauri::State<'_, AppState>,
    text: String,
    target: String,
    on_event: Channel<ProgressEvent>,
) -> Result<engine::TranslationResult, String> {
    protocol::prompt(&text, &target)?;
    let operation = state.begin()?;
    if !model::ready(&state.directory) {
        return Err("設定画面から翻訳モデルをダウンロードしてください。".into());
    }
    let mut engine = state.lock_engine(&operation.token).await?;
    if !engine.as_mut().is_some_and(|engine| engine.alive()) {
        on_event
            .send(ProgressEvent::Loading)
            .map_err(|_| "画面との接続が切れました。")?;
        state.start_engine(&mut engine, &operation.token).await?;
    }
    engine
        .as_ref()
        .ok_or("翻訳エンジンが見つかりません。")?
        .translate(&text, &target, &on_event, &operation.token)
        .await
}

#[tauri::command]
fn cancel_operation(state: tauri::State<'_, AppState>) {
    state.cancel();
}

#[tauri::command]
async fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard().read_text().map_err(|_| {
            "クリップボードから文章を取得できませんでした。文章をコピーして再試行してください。"
                .to_owned()
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard()
            .write_text(text)
            .map_err(|_| "訳文をコピーできませんでした。".to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn take_pending_clipboard(
    state: tauri::State<'_, AppState>,
) -> Result<Option<PendingClipboard>, String> {
    Ok(state
        .pending
        .lock()
        .map_err(|_| "クリップボードの状態を取得できません。")?
        .value
        .take())
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn translate_clipboard(app: &tauri::AppHandle) {
    let Some(request) = begin_request(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let value = read_clipboard(app.clone()).await;
        deliver_text(&app, request, value);
    });
}

fn translate_selection(app: &tauri::AppHandle) {
    let Some(request) = begin_request(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Read while the source app still has focus; only then show our window.
        let value = tauri::async_runtime::spawn_blocking(selection::read)
            .await
            .unwrap_or_else(|_| Err("選択した文字を取得できませんでした。".into()));
        deliver_text(&app, request, value);
    });
}

fn begin_request(app: &tauri::AppHandle) -> Option<u64> {
    app.state::<AppState>()
        .pending
        .lock()
        .ok()
        .map(|mut pending| pending.begin())
}

fn deliver_text(app: &tauri::AppHandle, request: u64, value: Result<String, String>) {
    let pending = match value {
        Ok(text) => PendingClipboard {
            text: Some(text),
            error: None,
        },
        Err(error) => PendingClipboard {
            text: None,
            error: Some(error),
        },
    };
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut slot) = state.pending.lock() {
            // Checking and publishing under the same lock also keeps an older
            // completion from focusing the window during a newer selection read.
            if slot.deliver(request, pending) {
                show(app);
                let _ = app.emit("clipboard-request", ());
            }
        }
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.shortcut_recording.store(false, Ordering::Relaxed);
    if state.resident.load(Ordering::Relaxed) {
        if let Some(window) = app.get_webview_window("main") {
            window.hide().map_err(|error| error.to_string())?;
            let _ = window.emit("window-hidden", ());
        }
    }
    Ok(())
}

#[tauri::command]
async fn open_model_license() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        open::that("https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF#license").map_err(
            |_| "ブラウザを開けませんでした。READMEのモデルライセンスをご確認ください。".to_owned(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == "--translate-selection") {
                translate_selection(app);
            } else if args.iter().any(|arg| arg == "--translate-clipboard") {
                translate_clipboard(app);
            } else {
                show(app);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_shortcut,
            set_shortcut_recording,
            download_model,
            prepare_engine,
            translate,
            cancel_operation,
            read_clipboard,
            write_clipboard,
            take_pending_clipboard,
            hide_window,
            open_model_license,
            quit_app
        ])
        .setup(|app| {
            let app_directory = app.path().app_data_dir()?;
            let directory = app_directory.join("models");
            let settings = app_directory.join("settings.json");
            let binary = std::env::var_os("ANYWHERE_PLAMO_LLAMA_SERVER")
                .map(PathBuf::from)
                .unwrap_or(
                    app.path()
                        .resource_dir()?
                        .join("resources/runtime/llama-server"),
                );
            let binary = if cfg!(debug_assertions) && !binary.is_file() {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime/llama-server")
            } else {
                binary
            };
            let wayland = cfg!(target_os = "linux")
                && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland")
                    || std::env::var_os("WAYLAND_DISPLAY").is_some());
            app.manage(AppState {
                directory,
                binary,
                engine: tokio::sync::Mutex::new(None),
                preparation: CancellationToken::new(),
                operation: Mutex::new(None),
                pending: Mutex::new(PendingRequests::default()),
                shortcut: Mutex::new(shortcut::State {
                    binding: shortcut::load(&settings),
                    available: false,
                    supported: false,
                }),
                shortcut_recording: AtomicBool::new(false),
                settings,
                resident: AtomicBool::new(false),
                wayland,
            });
            let show_item = MenuItem::with_id(app, "show", "翻訳画面を開く", true, None::<&str>)?;
            let paste_item =
                MenuItem::with_id(app, "paste", "コピーした文章を翻訳", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &paste_item, &quit_item])?;
            let tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/32x32.png"
                ))?)
                .tooltip("Anywhere Plamo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show(app),
                    "paste" => translate_clipboard(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app);
            let state = app.state::<AppState>();
            state.resident.store(tray.is_ok(), Ordering::Relaxed);
            if !wayland {
                // The X11 hotkey backend must not be initialized on pure Wayland.
                // A failed hotkey setup should still leave the translator usable.
                let installed = app
                    .handle()
                    .plugin(
                        tauri_plugin_global_shortcut::Builder::new()
                            .with_handler(|app, key, event| {
                                if event.state == ShortcutState::Pressed {
                                    let handle = app.clone();
                                    let key = *key;
                                    // The X11 event worker also handles registration. Do not
                                    // block it on a window query while registration waits.
                                    let _ = app.run_on_main_thread(move || {
                                        let state = handle.state::<AppState>();
                                        // Ignore obsolete bindings if an OS cleanup failed.
                                        let active =
                                            state.shortcut.try_lock().is_ok_and(|current| {
                                                current.available && current.binding == key
                                            });
                                        if active {
                                            if state.shortcut_recording.load(Ordering::Relaxed) {
                                                let _ = handle
                                                    .emit("shortcut-pressed", shortcut::label(key));
                                            } else if !handle
                                                .get_webview_window("main")
                                                .is_some_and(|window| {
                                                    window.is_focused().unwrap_or(false)
                                                })
                                            {
                                                translate_selection(&handle);
                                            }
                                        }
                                    });
                                }
                            })
                            .build(),
                    )
                    .is_ok();
                let mut shortcut = state.shortcut.lock().expect("shortcut state poisoned");
                shortcut.supported = installed;
                shortcut.available =
                    installed && app.global_shortcut().register(shortcut.binding).is_ok();
            }
            if std::env::args().any(|arg| arg == "--translate-selection") {
                translate_selection(app.handle());
            } else if std::env::args().any(|arg| arg == "--translate-clipboard") {
                translate_clipboard(app.handle());
            } else {
                show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                state.shortcut_recording.store(false, Ordering::Relaxed);
                if state.resident.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("window-hidden", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize Anywhere Plamo");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app.state::<AppState>();
            state.cancel();
            state.preparation.cancel();
            tauri::async_runtime::block_on(async {
                *state.engine.lock().await = None;
            });
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{AppState, PendingClipboard, PendingRequests};
    use std::{path::PathBuf, sync::atomic::AtomicBool, sync::Mutex, time::Duration};
    use tokio_util::sync::CancellationToken;

    fn text(value: &str) -> PendingClipboard {
        PendingClipboard {
            text: Some(value.into()),
            error: None,
        }
    }

    #[test]
    fn a_late_read_cannot_replace_the_latest_request() {
        let mut pending = PendingRequests::default();
        let older = pending.begin();
        let newer = pending.begin();
        assert!(pending.deliver(newer, text("new selection")));
        assert!(!pending.deliver(older, text("old clipboard")));
        assert_eq!(
            pending.value.take().unwrap().text.as_deref(),
            Some("new selection")
        );
    }

    #[test]
    fn a_new_request_clears_undelivered_text_and_rejects_old_errors() {
        let mut pending = PendingRequests::default();
        let older = pending.begin();
        assert!(pending.deliver(older, text("old selection")));
        let newer = pending.begin();
        assert!(pending.value.is_none());
        assert!(!pending.deliver(
            older,
            PendingClipboard {
                text: None,
                error: Some("old failure".into()),
            }
        ));
        assert!(pending.value.is_none());
        assert!(pending.deliver(newer, text("new clipboard")));
    }

    #[tokio::test]
    async fn cancelling_a_translation_wait_does_not_cancel_preparation() {
        let state = AppState {
            directory: PathBuf::new(),
            binary: PathBuf::new(),
            engine: tokio::sync::Mutex::new(None),
            preparation: CancellationToken::new(),
            operation: Mutex::new(None),
            pending: Mutex::new(PendingRequests::default()),
            shortcut: Mutex::new(super::shortcut::State {
                binding: super::shortcut::default(),
                available: false,
                supported: false,
            }),
            shortcut_recording: AtomicBool::new(false),
            settings: PathBuf::new(),
            resident: AtomicBool::new(false),
            wayland: false,
        };
        let preparing = state.engine.lock().await;
        let operation = state.begin().unwrap();
        let waiting = state.lock_engine(&operation.token);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("translation must wait for preparation"),
            _ = tokio::time::sleep(Duration::from_millis(5)) => {}
        }
        state.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("cancellation must interrupt the wait");
        assert_eq!(result.err().as_deref(), Some("CANCELLED"));
        assert!(!state.preparation.is_cancelled());
        drop(preparing);
        assert!(state.lock_engine(&state.preparation).await.is_ok());
    }
}
