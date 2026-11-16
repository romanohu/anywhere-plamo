//! Model switching tied to the app's windows and state; the rest lives in anyplm-core.
pub use anyplm_core::model::*;
use tauri::{Emitter, Manager};

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
