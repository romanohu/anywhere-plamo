use crate::{open_lens, AppState};
use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn validate(self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 320.0
            || self.height < 80.0
        {
            return Err("もう少し広い範囲を囲んでください。".into());
        }
        Ok(())
    }
}

pub enum Pending {
    Region {
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
    },
    Portal,
}

#[derive(Deserialize)]
pub struct Insets {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

pub async fn open(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<AppState>().wayland {
        *app.state::<AppState>()
            .lens_selection
            .lock()
            .map_err(|_| "範囲を設定できません。")? = Some(Pending::Portal);
        return open_lens(app).await;
    }
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("画面を取得できません。")?;
    if app.get_webview_window("lens-select").is_none() {
        tauri::WebviewWindowBuilder::new(
            &app,
            "lens-select",
            tauri::WebviewUrl::App("index.html?lens-select".into()),
        )
        .title("Anywhere Plamo — 範囲選択")
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    }
    let window = app
        .get_webview_window("lens-select")
        .ok_or("範囲選択を開けません。")?;
    window
        .set_position(*monitor.position())
        .map_err(|e| e.to_string())?;
    window
        .set_size(*monitor.size())
        .map_err(|e| e.to_string())?;
    window.emit("window-shown", ()).map_err(|e| e.to_string())?;
    for label in ["main", "popup"] {
        if let Some(other) = app.get_webview_window(label) {
            let _ = other.hide();
        }
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn confirm_lens_selection(
    window: tauri::WebviewWindow,
    region: Rect,
) -> Result<(), String> {
    if window.label() != "lens-select" || !window.is_visible().unwrap_or(false) {
        return Err("範囲選択から実行してください。".into());
    }
    region.validate()?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if (region.x + region.width) * scale > f64::from(size.width) + 1.0
        || (region.y + region.height) * scale > f64::from(size.height) + 1.0
    {
        return Err("画面内の範囲を選んでください。".into());
    }
    let app = window.app_handle();
    *app.state::<AppState>()
        .lens_selection
        .lock()
        .map_err(|_| "範囲を設定できません。")? = Some(Pending::Region {
        position: PhysicalPosition::new(
            origin.x + (region.x * scale).round() as i32,
            origin.y + (region.y * scale).round() as i32,
        ),
        size: PhysicalSize::new(
            (region.width * scale).round() as u32,
            (region.height * scale).round() as u32,
        ),
    });
    window.hide().map_err(|e| e.to_string())?;
    let _ = window.emit("window-hidden", ());
    if let Err(error) = open_lens(app.clone()).await {
        if let Ok(mut selection) = app.state::<AppState>().lens_selection.lock() {
            *selection = None;
        }
        let _ = window.show();
        let _ = window.set_focus();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn apply_lens_selection(
    window: tauri::WebviewWindow,
    insets: Insets,
) -> Result<bool, String> {
    if window.label() != "lens" {
        return Err("OCRレンズから実行してください。".into());
    }
    let state = window.state::<AppState>();
    // The new webview can finish loading before open_lens has shown it.
    // Leave the region queued for the window-shown event in that case.
    if !state.lens_open.load(Ordering::Relaxed) {
        return Ok(false);
    }
    let selection = state
        .lens_selection
        .lock()
        .map_err(|_| "範囲を取得できません。")?
        .take();
    let Some(selection) = selection else {
        return Ok(false);
    };
    if let Pending::Region { position, size } = selection {
        // Measure the existing frame before moving it. Mixing positions from
        // before/after an asynchronous native move offsets the reading region.
        let previous_scale = window.scale_factor().map_err(|e| e.to_string())?;
        let origin = window.inner_position().map_err(|e| e.to_string())?;
        let outer = window.outer_position().map_err(|e| e.to_string())?;
        let scale = window
            .monitor_from_point(f64::from(position.x), f64::from(position.y))
            .map_err(|e| e.to_string())?
            .map_or(previous_scale, |monitor| monitor.scale_factor());
        if [insets.left, insets.top, insets.right, insets.bottom]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0 || *v > 500.0)
        {
            return Err("レンズの表示範囲を取得できません。".into());
        }
        window
            .set_min_size(Some(tauri::LogicalSize::new(320.0, 120.0)))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(
                f64::from(size.width) / scale + insets.left + insets.right,
                f64::from(size.height) / scale + insets.top + insets.bottom,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(
                position.x
                    - ((insets.left + f64::from(origin.x - outer.x) / previous_scale) * scale)
                        .round() as i32,
                position.y
                    - ((insets.top + f64::from(origin.y - outer.y) / previous_scale) * scale)
                        .round() as i32,
            ))
            .map_err(|e| e.to_string())?;
    }
    Ok(state.lens_open.load(Ordering::Relaxed))
}
