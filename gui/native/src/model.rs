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
    if state.lens_open.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("OCRレンズを閉じてからモデルを変更してください。".into());
    }
    state.translation.try_reset(|| {
        if selected(&state.directory).id == id {
            return Ok(false);
        }
        select(&state.directory, id)?;
        Ok(true)
    })
}
