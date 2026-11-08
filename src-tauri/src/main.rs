#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod lens;
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
    Reading,
    Token { text: String },
}

#[derive(Clone, Serialize)]
struct PendingClipboard {
    request: u64,
    text: Option<String>,
    error: Option<String>,
    selection: bool,
}

#[derive(Default)]
struct WindowRequests {
    current: u64,
    value: Option<PendingClipboard>,
    dismissible: bool,
}

#[derive(Default)]
struct PendingRequests {
    main: WindowRequests,
    popup: WindowRequests,
    reading_selection: bool,
}

impl PendingRequests {
    fn window(&mut self, label: &str) -> &mut WindowRequests {
        if label == "popup" {
            &mut self.popup
        } else {
            &mut self.main
        }
    }

    fn begin(&mut self, label: &str, selection: bool) -> Option<u64> {
        if selection && self.reading_selection {
            return None;
        }
        self.reading_selection |= selection;
        let window = self.window(label);
        window.current += 1;
        window.value = None;
        window.dismissible = false;
        Some(window.current)
    }

    fn deliver(&mut self, label: &str, value: PendingClipboard) -> bool {
        if value.selection {
            self.reading_selection = false;
        }
        let window = self.window(label);
        if value.request != window.current {
            return false;
        }
        window.value = Some(value);
        true
    }

    fn finish_popup(&mut self, request: u64) {
        if request != 0 && self.popup.current == request {
            self.popup.dismissible = true;
        }
    }

    fn close_popup(&mut self) {
        self.popup.current += 1;
        self.popup.value = None;
        self.popup.dismissible = false;
    }
}

type LensBounds = (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, f64);

struct AppState {
    directory: PathBuf,
    binary: PathBuf,
    ocr_runtime: PathBuf,
    lens_open: AtomicBool,
    lens_passthrough: AtomicBool,
    lens_bounds: Mutex<Option<LensBounds>>,
    lens_watch: Mutex<lens::Watch>,
    engine: tokio::sync::Mutex<Option<engine::Engine>>,
    preparation: CancellationToken,
    operation: Mutex<Option<CancellationToken>>,
    popup_operation: Mutex<Option<CancellationToken>>,
    lens_operation: Mutex<Option<CancellationToken>>,
    download: tokio::sync::Mutex<()>,
    pending: Mutex<PendingRequests>,
    shortcut: Mutex<shortcut::State>,
    lens_shortcut: Mutex<shortcut::State>,
    shortcut_recording: Mutex<Option<String>>,
    shortcut_popup: AtomicBool,
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
    fn operation(&self, label: &str) -> &Mutex<Option<CancellationToken>> {
        match label {
            "popup" => &self.popup_operation,
            "lens" => &self.lens_operation,
            _ => &self.operation,
        }
    }

    fn begin(&self, label: &str) -> Result<Operation<'_>, String> {
        let operation = self.operation(label);
        let mut slot = operation.lock().map_err(|_| "処理状態を取得できません。")?;
        if slot.is_some() {
            return Err("別の処理が実行中です。完了後に再試行してください。".into());
        }
        let token = CancellationToken::new();
        *slot = Some(token.clone());
        if label == "popup" {
            if let Ok(mut pending) = self.pending.lock() {
                pending.popup.dismissible = false;
            }
        }
        Ok(Operation {
            slot: operation,
            token,
        })
    }

    fn cancel(&self, label: &str) {
        if let Ok(slot) = self.operation(label).lock() {
            if let Some(token) = slot.as_ref() {
                token.cancel();
            }
        }
    }

    fn stop_recording(&self, label: &str) {
        if let Ok(mut recording) = self.shortcut_recording.lock() {
            if recording.as_deref() == Some(label) {
                *recording = None;
            }
        }
    }

    fn close_popup(&self) {
        self.cancel("popup");
        if let Ok(mut pending) = self.pending.lock() {
            pending.close_popup();
        }
    }

    fn finish_popup(&self, request: u64) {
        if let Ok(operation) = self.popup_operation.lock() {
            if operation.is_none() {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.finish_popup(request);
                }
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
    shortcut_popup: bool,
    lens_supported: bool,
    ocr_available: bool,
    lens_uses_selection: bool,
    lens_shortcut: String,
    default_lens_shortcut: String,
    lens_shortcut_available: bool,
    lens_passthrough: bool,
}

#[tauri::command]
fn get_status(state: tauri::State<'_, AppState>) -> AppStatus {
    let shortcut = state.shortcut.lock().expect("shortcut state poisoned");
    let lens_shortcut = state
        .lens_shortcut
        .lock()
        .expect("lens shortcut state poisoned");
    AppStatus {
        model_ready: model::ready(&state.directory),
        runtime_available: state.binary.is_file(),
        shortcut_available: shortcut.available,
        shortcut: shortcut::label(shortcut.binding),
        default_shortcut: shortcut::label(shortcut::default()),
        shortcut_supported: shortcut.supported,
        wayland: state.wayland,
        resident: state.resident.load(Ordering::Relaxed),
        shortcut_popup: state.shortcut_popup.load(Ordering::Relaxed),
        lens_supported: cfg!(any(target_os = "macos", target_os = "linux")),
        ocr_available: lens::ready(&state.ocr_runtime),
        lens_uses_selection: state.wayland,
        lens_shortcut: shortcut::label(lens_shortcut.binding),
        default_lens_shortcut: shortcut::label(shortcut::default_lens()),
        lens_shortcut_available: lens_shortcut.available,
        lens_passthrough: state.lens_passthrough.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn set_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    shortcut: String,
    lens: Option<bool>,
) -> Result<AppStatus, String> {
    let next = shortcut::parse(&shortcut)?;
    // A failed re-registration must not strand an input-transparent window.
    if lens.unwrap_or(false) && state.lens_passthrough.load(Ordering::Relaxed) {
        apply_lens_passthrough(&app, false)?;
    }
    {
        // Keep both bindings locked in the same order when checking conflicts/saving.
        let mut selection = state
            .shortcut
            .lock()
            .map_err(|_| "ショートカットの状態を取得できません。")?;
        let mut lens_shortcut = state
            .lens_shortcut
            .lock()
            .map_err(|_| "ショートカットの状態を取得できません。")?;
        let (current, other) = if lens.unwrap_or(false) {
            (&mut *lens_shortcut, &*selection)
        } else {
            (&mut *selection, &*lens_shortcut)
        };
        if !current.supported {
            return Err(shortcut::UNAVAILABLE.into());
        }
        if next == other.binding {
            return Err("もう一方のショートカットと異なるキーを選んでください。".into());
        }
        let pending = shortcut::PendingSave::new(
            &state.settings,
            if lens.unwrap_or(false) {
                other.binding
            } else {
                next
            },
            if lens.unwrap_or(false) {
                next
            } else {
                other.binding
            },
            state.shortcut_popup.load(Ordering::Relaxed),
        )?;
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
    if lens.unwrap_or(false) {
        if let Some(window) = app.get_webview_window("lens") {
            let _ = window.emit("lens-shortcut-changed", ());
        }
    }
    Ok(get_status(state))
}

#[tauri::command]
fn set_shortcut_popup(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<AppStatus, String> {
    {
        // Share the shortcut lock so either setting preserves the other's value.
        let shortcut = state
            .shortcut
            .lock()
            .map_err(|_| "ショートカットの状態を取得できません。")?;
        let lens_shortcut = state
            .lens_shortcut
            .lock()
            .map_err(|_| "ショートカットの状態を取得できません。")?;
        shortcut::PendingSave::new(
            &state.settings,
            shortcut.binding,
            lens_shortcut.binding,
            enabled,
        )?
        .commit()?;
        state.shortcut_popup.store(enabled, Ordering::Relaxed);
    }
    Ok(get_status(state))
}

#[tauri::command]
fn set_shortcut_recording(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    recording: bool,
) {
    if recording {
        if let Ok(mut owner) = state.shortcut_recording.lock() {
            *owner = Some(window.label().to_owned());
        }
    } else {
        state.stop_recording(window.label());
    }
}

#[tauri::command]
async fn download_model(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    on_event: Channel<ProgressEvent>,
) -> Result<(), String> {
    let operation = state.begin(window.label())?;
    let _download = tokio::select! {
        biased;
        _ = operation.token.cancelled() => return Err("CANCELLED".into()),
        download = state.download.lock() => download,
    };
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    text: String,
    target: String,
    on_event: Channel<ProgressEvent>,
) -> Result<engine::TranslationResult, String> {
    protocol::prompt(&text, &target)?;
    let operation = state.begin(window.label())?;
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
fn cancel_operation(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) {
    state.cancel(window.label());
}

fn apply_lens_passthrough(app: &tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let state = app.state::<AppState>();
    if enabled
        && (!state.lens_open.load(Ordering::Relaxed)
            || !state.lens_shortcut.lock().is_ok_and(|key| key.available))
    {
        return Err(
            "クリック透過には、設定で有効なレンズ用ショートカットを登録してください。".into(),
        );
    }
    let window = app
        .get_webview_window("lens")
        .ok_or("レンズを開いてください。")?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())?;
    if let Err(error) = window.set_focusable(!enabled) {
        let _ = window.set_ignore_cursor_events(state.lens_passthrough.load(Ordering::Relaxed));
        return Err(error.to_string());
    }
    state.lens_passthrough.store(enabled, Ordering::Relaxed);
    let _ = window.emit("lens-passthrough-changed", enabled);
    Ok(enabled)
}

#[tauri::command]
fn set_lens_passthrough(window: tauri::WebviewWindow, enabled: bool) -> Result<bool, String> {
    if window.label() != "lens" {
        return Err("OCRレンズから実行してください。".into());
    }
    apply_lens_passthrough(window.app_handle(), enabled)
}

#[tauri::command]
async fn open_lens(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if app.get_webview_window("lens").is_none() {
            tauri::WebviewWindowBuilder::new(
                &app,
                "lens",
                tauri::WebviewUrl::App("index.html?lens".into()),
            )
            .title("Anywhere Plamo — OCRレンズ")
            .inner_size(640.0, 420.0)
            .min_inner_size(400.0, 240.0)
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .always_on_top(true)
            .visible(false)
            .center()
            .build()
            .map_err(|error| error.to_string())?;
        }
        let window = app
            .get_webview_window("lens")
            .ok_or("レンズを開けませんでした。")?;
        apply_lens_passthrough(&app, false)?;
        window.show().map_err(|error| error.to_string())?;
        app.state::<AppState>()
            .lens_open
            .store(true, Ordering::Relaxed);
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(main) = app.get_webview_window("main") {
            main.hide().map_err(|error| error.to_string())?;
        }
        let _ = window.emit("window-shown", ());
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("OCRレンズはMac・Linuxで利用できます。".into())
    }
}

#[tauri::command]
async fn capture_lens(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    region: lens::CaptureArea,
    automatic: Option<bool>,
    reset: Option<bool>,
    on_event: Channel<ProgressEvent>,
) -> Result<lens::CaptureResult, String> {
    if window.label() != "lens" {
        return Err("OCRレンズから実行してください。".into());
    }
    let operation = state.begin("lens")?;
    if reset.unwrap_or(false) {
        *state
            .lens_watch
            .lock()
            .map_err(|_| "画面の状態を取得できません。")? = lens::Watch::default();
    }
    lens::capture(
        window,
        region,
        state.wayland,
        &state.ocr_runtime,
        &operation.token,
        automatic.unwrap_or(false).then_some(&state.lens_watch),
        || {
            let _ = on_event.send(ProgressEvent::Reading);
        },
    )
    .await
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Option<PendingClipboard>, String> {
    Ok(state
        .pending
        .lock()
        .map_err(|_| "クリップボードの状態を取得できません。")?
        .window(window.label())
        .value
        .take())
}

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show(app: &tauri::AppHandle) {
    show_window(app, "main");
}

fn handle_launch(app: &tauri::AppHandle, args: &[String]) {
    if args.iter().any(|arg| arg == "--translate-selection") {
        translate_selection(app);
    } else if args.iter().any(|arg| arg == "--translate-clipboard") {
        translate_clipboard(app);
    } else if !args.iter().any(|arg| arg == "--background")
        || !app.state::<AppState>().resident.load(Ordering::Relaxed)
    {
        // Without a tray, keep the window available so the app can be reopened.
        show(app);
    }
}

fn translate_clipboard(app: &tauri::AppHandle) {
    let Some(request) = begin_request(app, "main", false) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let value = read_clipboard(app.clone()).await;
        deliver_text(&app, "main", request, value, false);
    });
}

fn translate_selection(app: &tauri::AppHandle) {
    let label = if app
        .state::<AppState>()
        .shortcut_popup
        .load(Ordering::Relaxed)
    {
        "popup"
    } else {
        "main"
    };
    // A repeated shortcut must not replace an in-flight Copy with a busy error
    // and focus this window while the source app is still supplying its text.
    let Some(request) = begin_request(app, label, true) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Read while the source app still has focus; only then show our window.
        let value = tauri::async_runtime::spawn_blocking(selection::read)
            .await
            .unwrap_or_else(|_| Err("選択した文字を取得できませんでした。".into()));
        deliver_text(&app, label, request, value, true);
    });
}

fn begin_request(app: &tauri::AppHandle, label: &str, selection: bool) -> Option<u64> {
    app.state::<AppState>()
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.begin(label, selection))
}

fn deliver_text(
    app: &tauri::AppHandle,
    label: &'static str,
    request: u64,
    value: Result<String, String>,
    selection: bool,
) {
    let pending = match value {
        Ok(text) => PendingClipboard {
            request,
            text: Some(text),
            error: None,
            selection,
        },
        Err(error) => PendingClipboard {
            request,
            text: None,
            error: Some(error),
            selection,
        },
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(state) = handle.try_state::<AppState>() {
            let delivered = state.pending.lock().is_ok_and(|mut slot| {
                // Publish and focus together on the UI thread. Queuing window
                // operations separately could steal focus from a newer read.
                slot.deliver(label, pending)
            });
            if delivered {
                show_window(&handle, label);
                let _ = handle.emit_to(label, "clipboard-request", ());
            }
        }
    });
}

#[tauri::command]
fn hide_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.stop_recording(window.label());
    if window.label() == "popup" {
        state.close_popup();
    }
    if window.label() == "lens" {
        apply_lens_passthrough(window.app_handle(), false)?;
        state.lens_open.store(false, Ordering::Relaxed);
        state.cancel("lens");
    }
    if matches!(window.label(), "popup" | "lens") || state.resident.load(Ordering::Relaxed) {
        window.hide().map_err(|error| error.to_string())?;
        let _ = window.emit_to(window.label(), "window-hidden", ());
        if window.label() == "lens" {
            show(window.app_handle());
        }
    }
    Ok(())
}

#[tauri::command]
fn finish_popup_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: u64,
) {
    if window.label() != "popup" {
        return;
    }
    state.finish_popup(request);
}

#[tauri::command]
async fn open_model_license() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        open::that("https://plamo.preferredai.jp/info/plamo-community-license-ja").map_err(|_| {
            "ブラウザを開けませんでした。READMEのモデルライセンスをご確認ください。".to_owned()
        })
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
            // The plugin calls from a worker, potentially before setup finishes.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || handle_launch(&handle, &args));
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_shortcut,
            set_shortcut_popup,
            set_shortcut_recording,
            download_model,
            prepare_engine,
            translate,
            cancel_operation,
            open_lens,
            set_lens_passthrough,
            capture_lens,
            read_clipboard,
            write_clipboard,
            take_pending_clipboard,
            hide_window,
            finish_popup_request,
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
            let ocr_runtime = app.path().resource_dir()?.join("resources/runtime");
            let ocr_runtime = if cfg!(debug_assertions) && !lens::ready(&ocr_runtime) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime")
            } else {
                ocr_runtime
            };
            let wayland = cfg!(target_os = "linux")
                && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland")
                    || std::env::var_os("WAYLAND_DISPLAY").is_some());
            app.manage(AppState {
                directory,
                binary,
                ocr_runtime,
                lens_open: AtomicBool::new(false),
                lens_passthrough: AtomicBool::new(false),
                lens_bounds: Mutex::new(None),
                lens_watch: Mutex::new(lens::Watch::default()),
                engine: tokio::sync::Mutex::new(None),
                preparation: CancellationToken::new(),
                operation: Mutex::new(None),
                popup_operation: Mutex::new(None),
                lens_operation: Mutex::new(None),
                download: tokio::sync::Mutex::new(()),
                pending: Mutex::new(PendingRequests::default()),
                shortcut: Mutex::new(shortcut::State {
                    binding: shortcut::load(&settings),
                    available: false,
                    supported: false,
                }),
                lens_shortcut: Mutex::new(shortcut::State {
                    binding: shortcut::load_lens(&settings),
                    available: false,
                    supported: false,
                }),
                shortcut_recording: Mutex::new(None),
                shortcut_popup: AtomicBool::new(shortcut::load_popup(&settings)),
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
                                        let lens_active =
                                            state.lens_shortcut.try_lock().is_ok_and(|current| {
                                                current.available && current.binding == key
                                            });
                                        if active || lens_active {
                                            let recording = state
                                                .shortcut_recording
                                                .lock()
                                                .ok()
                                                .and_then(|owner| owner.clone());
                                            if let Some(label) = recording {
                                                let _ = handle.emit_to(
                                                    label,
                                                    "shortcut-pressed",
                                                    shortcut::label(key),
                                                );
                                            } else if lens_active {
                                                if state.lens_open.load(Ordering::Relaxed) {
                                                    let enabled = !state
                                                        .lens_passthrough
                                                        .load(Ordering::Relaxed);
                                                    match apply_lens_passthrough(&handle, enabled) {
                                                        Ok(false) => show_window(&handle, "lens"),
                                                        Ok(true) => {}
                                                        Err(error) => {
                                                            let _ = handle.emit_to(
                                                                "lens",
                                                                "lens-error",
                                                                error,
                                                            );
                                                        }
                                                    }
                                                }
                                            } else if !["main", "popup", "lens"].iter().any(
                                                |label| {
                                                    handle.get_webview_window(label).is_some_and(
                                                        |window| {
                                                            window.is_focused().unwrap_or(false)
                                                        },
                                                    )
                                                },
                                            ) {
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
                let mut lens_shortcut = state
                    .lens_shortcut
                    .lock()
                    .expect("lens shortcut state poisoned");
                lens_shortcut.supported = installed;
                lens_shortcut.available = installed
                    && lens_shortcut.binding != shortcut.binding
                    && app
                        .global_shortcut()
                        .register(lens_shortcut.binding)
                        .is_ok();
            }
            handle_launch(app.handle(), &std::env::args().collect::<Vec<_>>());
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(state) = window.try_state::<AppState>() else {
                return;
            };
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                state.stop_recording(window.label());
                if window.label() == "popup" {
                    state.close_popup();
                }
                if window.label() == "lens" {
                    let _ = apply_lens_passthrough(window.app_handle(), false);
                    state.lens_open.store(false, Ordering::Relaxed);
                    state.cancel("lens");
                }
                if matches!(window.label(), "popup" | "lens")
                    || state.resident.load(Ordering::Relaxed)
                {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit_to(window.label(), "window-hidden", ());
                    if window.label() == "lens" {
                        show(window.app_handle());
                    }
                } else {
                    // The hidden popup must not keep an app without a tray alive.
                    window.app_handle().exit(0);
                }
            } else if window.label() == "lens"
                && !state.wayland
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                )
            {
                // X11 sends configure events when hiding/restoring or restacking too.
                // Only a visible window's actual geometry change invalidates a capture.
                if window.is_visible().unwrap_or(false) {
                    if let (Ok(position), Ok(size), Ok(scale)) = (
                        window.inner_position(),
                        window.inner_size(),
                        window.scale_factor(),
                    ) {
                        let current = (position, size, scale);
                        let changed = state.lens_bounds.lock().is_ok_and(|mut bounds| {
                            bounds
                                .replace(current)
                                .is_some_and(|previous| previous != current)
                        });
                        if changed {
                            state.cancel("lens");
                            let _ = window.emit_to("lens", "lens-changed", ());
                        }
                    }
                }
            } else if window.label() == "popup"
                && matches!(event, tauri::WindowEvent::Focused(false))
            {
                let dismiss = state.popup_operation.lock().is_ok_and(|operation| {
                    operation.is_none()
                        && state
                            .pending
                            .lock()
                            .is_ok_and(|pending| pending.popup.dismissible)
                });
                if dismiss {
                    state.stop_recording("popup");
                    state.close_popup();
                    let _ = window.hide();
                    let _ = window.emit_to("popup", "window-hidden", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize Anywhere Plamo");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app.state::<AppState>();
            state.cancel("main");
            state.cancel("popup");
            state.cancel("lens");
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

    fn text(request: u64, value: &str) -> PendingClipboard {
        PendingClipboard {
            request,
            text: Some(value.into()),
            error: None,
            selection: false,
        }
    }

    #[test]
    fn a_late_read_cannot_replace_the_latest_request() {
        let mut pending = PendingRequests::default();
        let older = pending.begin("main", false).unwrap();
        let newer = pending.begin("main", true).unwrap();
        assert!(pending.deliver(
            "main",
            PendingClipboard {
                selection: true,
                ..text(newer, "new selection")
            }
        ));
        assert!(!pending.deliver("main", text(older, "old clipboard")));
        let value = pending.main.value.take().unwrap();
        assert_eq!(value.text.as_deref(), Some("new selection"));
        assert!(value.selection);
    }

    #[test]
    fn a_new_request_clears_undelivered_text_and_rejects_old_errors() {
        let mut pending = PendingRequests::default();
        let older = pending.begin("main", true).unwrap();
        assert!(pending.deliver(
            "main",
            PendingClipboard {
                selection: true,
                ..text(older, "old selection")
            }
        ));
        let newer = pending.begin("main", false).unwrap();
        assert!(pending.main.value.is_none());
        assert!(!pending.deliver(
            "main",
            PendingClipboard {
                request: older,
                text: None,
                error: Some("old failure".into()),
                selection: true,
            }
        ));
        assert!(pending.main.value.is_none());
        assert!(pending.deliver("main", text(newer, "new clipboard")));
    }

    #[test]
    fn repeated_shortcuts_do_not_interrupt_selection_capture() {
        let mut pending = PendingRequests::default();
        let request = pending.begin("popup", true).unwrap();
        assert!(pending.begin("main", true).is_none());
        assert!(pending.begin("popup", true).is_none());
        assert!(pending.deliver(
            "popup",
            PendingClipboard {
                selection: true,
                ..text(request, "selected PDF")
            }
        ));
        let next = pending.begin("main", true).unwrap();
        let clipboard = pending.begin("main", false).unwrap();
        assert!(!pending.deliver(
            "main",
            PendingClipboard {
                selection: true,
                ..text(next, "superseded selection")
            }
        ));
        assert!(pending.deliver("main", text(clipboard, "clipboard")));
        assert!(pending.begin("popup", true).is_some());
    }

    #[test]
    fn popup_and_manual_requests_are_independent() {
        let mut pending = PendingRequests::default();
        let popup = pending.begin("popup", true).unwrap();
        let main = pending.begin("main", false).unwrap();
        assert!(pending.deliver(
            "popup",
            PendingClipboard {
                selection: true,
                ..text(popup, "selection")
            }
        ));
        assert!(pending.deliver("main", text(main, "clipboard")));
        assert_eq!(
            pending.window("main").value.take().unwrap().text.as_deref(),
            Some("clipboard")
        );
        assert_eq!(
            pending
                .window("popup")
                .value
                .take()
                .unwrap()
                .text
                .as_deref(),
            Some("selection")
        );
        pending.finish_popup(popup);
        assert!(pending.popup.dismissible);
        pending.close_popup();
        pending.finish_popup(popup);
        assert!(!pending.popup.dismissible);
        let next = pending.begin("popup", true).unwrap();
        pending.finish_popup(popup);
        assert!(!pending.popup.dismissible);
        pending.finish_popup(next);
        assert!(pending.popup.dismissible);
    }

    fn state() -> AppState {
        AppState {
            directory: PathBuf::new(),
            binary: PathBuf::new(),
            ocr_runtime: PathBuf::new(),
            lens_open: AtomicBool::new(false),
            lens_passthrough: AtomicBool::new(false),
            lens_bounds: Mutex::new(None),
            lens_watch: Mutex::new(crate::lens::Watch::default()),
            engine: tokio::sync::Mutex::new(None),
            preparation: CancellationToken::new(),
            operation: Mutex::new(None),
            popup_operation: Mutex::new(None),
            lens_operation: Mutex::new(None),
            download: tokio::sync::Mutex::new(()),
            pending: Mutex::new(PendingRequests::default()),
            shortcut: Mutex::new(super::shortcut::State {
                binding: super::shortcut::default(),
                available: false,
                supported: false,
            }),
            lens_shortcut: Mutex::new(super::shortcut::State {
                binding: super::shortcut::default_lens(),
                available: false,
                supported: false,
            }),
            shortcut_recording: Mutex::new(None),
            shortcut_popup: AtomicBool::new(false),
            settings: PathBuf::new(),
            resident: AtomicBool::new(false),
            wayland: false,
        }
    }

    #[test]
    fn popup_lifecycle_and_cancellation_do_not_affect_the_manual_window() {
        let state = state();
        let request = state.pending.lock().unwrap().begin("popup", true).unwrap();
        let main = state.begin("main").unwrap();
        let popup = state.begin("popup").unwrap();
        assert!(state.begin("main").is_err());
        assert!(state.begin("popup").is_err());
        state.finish_popup(request);
        assert!(!state.pending.lock().unwrap().popup.dismissible);
        state.cancel("popup");
        assert!(popup.token.is_cancelled());
        assert!(!main.token.is_cancelled());
        drop(popup);
        state.finish_popup(request);
        assert!(state.pending.lock().unwrap().popup.dismissible);
        let popup = state.begin("popup").unwrap();
        assert!(!state.pending.lock().unwrap().popup.dismissible);
        state.finish_popup(request);
        assert!(!state.pending.lock().unwrap().popup.dismissible);
        state.cancel("main");
        assert!(main.token.is_cancelled());
        assert!(!popup.token.is_cancelled());
        *state.shortcut_recording.lock().unwrap() = Some("main".into());
        state.stop_recording("popup");
        assert_eq!(
            state.shortcut_recording.lock().unwrap().as_deref(),
            Some("main")
        );
        state.close_popup();
        assert!(popup.token.is_cancelled());
        drop(popup);
        state.finish_popup(request);
        assert!(!state.pending.lock().unwrap().popup.dismissible);
    }

    #[tokio::test]
    async fn lens_cancellation_releases_the_engine_wait_without_affecting_other_windows() {
        let state = state();
        let main = state.begin("main").unwrap();
        let popup = state.begin("popup").unwrap();
        let lens = state.begin("lens").unwrap();
        assert!(state.begin("lens").is_err());
        let engine = state.engine.lock().await;
        state.cancel("lens");
        assert!(lens.token.is_cancelled());
        assert!(!main.token.is_cancelled());
        assert!(!popup.token.is_cancelled());
        assert_eq!(
            state.lock_engine(&lens.token).await.err().as_deref(),
            Some("CANCELLED")
        );
        drop(lens);
        assert!(state.begin("lens").is_ok());
        drop(engine);
    }

    #[tokio::test]
    async fn cancelling_a_translation_wait_does_not_cancel_preparation() {
        let state = state();
        let preparing = state.engine.lock().await;
        let operation = state.begin("main").unwrap();
        let waiting = state.lock_engine(&operation.token);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("translation must wait for preparation"),
            _ = tokio::time::sleep(Duration::from_millis(5)) => {}
        }
        state.cancel("main");
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("cancellation must interrupt the wait");
        assert_eq!(result.err().as_deref(), Some("CANCELLED"));
        assert!(!state.preparation.is_cancelled());
        drop(preparing);
        assert!(state.lock_engine(&state.preparation).await.is_ok());
    }
}
