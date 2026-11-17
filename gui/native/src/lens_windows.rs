use super::{write_image, CaptureArea};
use std::{path::Path, ptr::null_mut};
use tokio_util::sync::CancellationToken;
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::{Dwm::DwmFlush, Gdi::*},
    UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::*},
};

pub fn exclude_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // Only our lens is excluded. The window underneath remains visible to GDI.
    unsafe { SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE) }
        .map_err(|_| "レンズを画面取得から除外できません。Windows 11の通常のデスクトップで再試行してください。".into())
}

pub async fn capture(
    window: &tauri::WebviewWindow,
    area: CaptureArea,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<f64, String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    let path = path.to_owned();
    let token = cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if token.is_cancelled() {
            return Err("CANCELLED".into());
        }
        let hwnd = HWND(handle as *mut _);
        let mut client = RECT::default();
        let mut origin = POINT::default();
        // Tauri uses per-monitor DPI awareness. DOM coordinates are CSS pixels;
        // client origin (not the decorated window origin) is in screen pixels.
        let scale = unsafe {
            GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
            ClientToScreen(hwnd, &mut origin)
                .ok()
                .map_err(|error| error.to_string())?;
            GetDpiForWindow(hwnd) as f64 / 96.0
        };
        if scale <= 0.0 {
            return Err("レンズの表示倍率を取得できません。".into());
        }
        let region = area.region;
        let left = (region.x * scale).round() as i32;
        let top = (region.y * scale).round() as i32;
        let right = ((region.x + region.width) * scale).round() as i32;
        let bottom = (((region.y + region.height) * scale).round() as i32)
            .min(client.bottom - (area.bottom_inset * scale).ceil() as i32);
        if left < 0 || top < 0 || right > client.right || right <= left || bottom <= top {
            return Err("レンズのサイズが変わりました。もう一度更新してください。".into());
        }
        let width = right - left;
        let height = bottom - top;
        if width as u64 * height as u64 > 64 * 1024 * 1024 {
            return Err("読み取る範囲を小さくしてください。".into());
        }
        let pixels = unsafe { capture_pixels(origin.x + left, origin.y + top, width, height) }?;
        if token.is_cancelled() {
            return Err("CANCELLED".into());
        }
        write_image(&path, pixels)?;
        Ok(height as f64 / scale)
    })
    .await
    .map_err(|error| error.to_string())?
}

struct CaptureResources {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        // The bitmap must be deselected before deleting it; release every handle
        // on capture failures as well as on the normal polling path.
        unsafe {
            if !self.previous.is_invalid() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.memory.is_invalid() {
                let _ = DeleteDC(self.memory);
            }
            if !self.screen.is_invalid() {
                ReleaseDC(None, self.screen);
            }
        }
    }
}

unsafe fn capture_pixels(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<image::RgbImage, String> {
    let error = "画面を取得できません。通常のデスクトップで再試行してください。";
    DwmFlush().map_err(|_| error)?;
    let mut resources = CaptureResources {
        screen: GetDC(None),
        memory: HDC::default(),
        bitmap: HBITMAP::default(),
        previous: HGDIOBJ::default(),
    };
    if resources.screen.is_invalid() {
        return Err(error.into());
    }
    resources.memory = CreateCompatibleDC(Some(resources.screen));
    if resources.memory.is_invalid() {
        return Err(error.into());
    }
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = null_mut();
    resources.bitmap = CreateDIBSection(
        Some(resources.memory),
        &info,
        DIB_RGB_COLORS,
        &mut bits,
        None,
        0,
    )
    .map_err(|_| error)?;
    resources.previous = SelectObject(resources.memory, HGDIOBJ(resources.bitmap.0));
    if bits.is_null() || resources.previous.is_invalid() {
        return Err(error.into());
    }
    BitBlt(
        resources.memory,
        0,
        0,
        width,
        height,
        Some(resources.screen),
        x,
        y,
        SRCCOPY | CAPTUREBLT,
    )
    .map_err(|_| error)?;
    GdiFlush().ok().map_err(|_| error)?;
    // A top-down 32-bit DIB has no row padding beyond width * 4.
    let bytes = std::slice::from_raw_parts(bits.cast::<u8>(), width as usize * height as usize * 4);
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for pixel in bytes.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    image::RgbImage::from_raw(width as u32, height as u32, rgb).ok_or_else(|| error.into())
}
