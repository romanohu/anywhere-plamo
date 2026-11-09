use super::{TOO_LONG, UNAVAILABLE};
use std::time::{Duration, Instant};
use windows::{
    core::w,
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
        System::{Com::*, DataExchange::*, Memory::*},
        UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn read() -> Result<String, String> {
    let foreground = unsafe { GetForegroundWindow() };
    let mut process = 0;
    unsafe { GetWindowThreadProcessId(foreground, Some(&mut process)) };
    if foreground.is_invalid() || process == std::process::id() {
        return Err(UNAVAILABLE.into());
    }
    if let Ok(text) = accessible_selection(process) {
        if !text.trim().is_empty() && unsafe { GetForegroundWindow() } == foreground {
            return Ok(text);
        }
    }
    copy_selection(foreground)
}

fn accessible_selection(process: u32) -> windows::core::Result<String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let _com = Com;
        let automation: IUIAutomation2 =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
        automation.SetConnectionTimeout(800)?;
        automation.SetTransactionTimeout(800)?;
        automation.SetAutoSetFocus(false)?;
        let element = automation.GetFocusedElement()?;
        if element.CurrentProcessId()? as u32 != process {
            return Ok(String::new());
        }
        let pattern: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId)?;
        let ranges = pattern.GetSelection()?;
        let count = ranges.Length()?;
        if count > 128 {
            return Err(windows::core::Error::from_hresult(
                windows::Win32::Foundation::E_BOUNDS,
            ));
        }
        let mut text = String::new();
        for index in 0..count {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(
                &ranges
                    .GetElement(index)?
                    .GetText(crate::protocol::MAX_CHARACTERS as i32 + 1)?
                    .to_string(),
            );
            if text.encode_utf16().count() > crate::protocol::MAX_CHARACTERS {
                break; // The shared validator reports the length limit.
            }
        }
        Ok(text)
    }
}

struct ClipboardWindow(HWND);
impl Drop for ClipboardWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

struct Clipboard;
impl Clipboard {
    fn open(owner: HWND) -> Result<Self, String> {
        let started = Instant::now();
        loop {
            if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                return Ok(Self);
            }
            if started.elapsed() >= Duration::from_millis(250) {
                return Err(UNAVAILABLE.into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

struct SavedFormat(u32, HGLOBAL);
impl Drop for SavedFormat {
    fn drop(&mut self) {
        if !self.1.is_invalid() {
            let _ = unsafe { GlobalFree(Some(self.1)) };
        }
    }
}

fn clipboard_bytes(format: u32, limit: usize) -> Result<Vec<u8>, String> {
    unsafe {
        let handle = HGLOBAL(GetClipboardData(format).map_err(|_| UNAVAILABLE)?.0);
        let length = GlobalSize(handle);
        if length == 0 || length > limit {
            return Err(UNAVAILABLE.into());
        }
        let pointer = GlobalLock(handle);
        if pointer.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), length).to_vec();
        let _ = GlobalUnlock(handle);
        Ok(bytes)
    }
}

fn save_clipboard() -> Result<Vec<SavedFormat>, String> {
    let mut saved = Vec::new();
    let mut format = 0;
    let mut remaining = 32 * 1024 * 1024;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }
        // These formats contain GDI handles/owner callbacks, not HGLOBAL bytes.
        // Do not issue Copy if the original clipboard cannot be restored safely.
        if matches!(
            format,
            2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x83 | 0x8e | 0x200..=0x3ff
        ) {
            return Err(UNAVAILABLE.into());
        }
        let bytes = clipboard_bytes(format, remaining)?;
        remaining -= bytes.len();
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| UNAVAILABLE)?;
            let saved_format = SavedFormat(format, handle);
            let pointer = GlobalLock(handle);
            if pointer.is_null() {
                return Err(UNAVAILABLE.into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(handle);
            saved.push(saved_format);
        }
    }
    Ok(saved)
}

fn restore_clipboard(
    owner: HWND,
    sequence: u32,
    mut saved: Vec<SavedFormat>,
) -> Result<(), String> {
    let _clipboard = Clipboard::open(owner)?;
    unsafe {
        // A later user copy takes precedence over our saved clipboard.
        if GetClipboardSequenceNumber() != sequence {
            return Ok(());
        }
        EmptyClipboard().map_err(|_| UNAVAILABLE)?;
        for format in &mut saved {
            SetClipboardData(format.0, Some(HANDLE(format.1 .0))).map_err(|_| UNAVAILABLE)?;
            format.1 = HGLOBAL::default(); // Ownership was transferred to Windows.
        }
    }
    Ok(())
}

fn copy_selection(foreground: HWND) -> Result<String, String> {
    let started = Instant::now();
    // Wait for the shortcut chord to be released, without releasing the user's keys.
    while [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, VK_C]
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
    {
        if started.elapsed() >= Duration::from_secs(1) {
            return Err("ショートカットのキーを離して、もう一度試してください。".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let owner = ClipboardWindow(unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .map_err(|_| UNAVAILABLE)?
    });
    let clipboard = Clipboard::open(owner.0)?;
    let saved = save_clipboard()?;
    let before = unsafe { GetClipboardSequenceNumber() };
    drop(clipboard);
    if unsafe { GetForegroundWindow() } != foreground {
        return Err(UNAVAILABLE.into());
    }
    let key = |code, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let inputs = [
        key(VK_CONTROL, KEYBD_EVENT_FLAGS::default()),
        key(VK_C, KEYBD_EVENT_FLAGS::default()),
        key(VK_C, KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    let inserted = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if inserted > 0 && inserted < inputs.len() as u32 {
        unsafe { SendInput(&inputs[2..], size_of::<INPUT>() as i32) };
    }
    if inserted < 2 {
        return Err("選択文字のコピーが許可されませんでした。管理者として動くアプリでは、コピーして「貼り付け」を使ってください。".into());
    }
    let started = Instant::now();
    loop {
        if unsafe { GetForegroundWindow() } != foreground {
            return Err(UNAVAILABLE.into());
        }
        if unsafe { GetClipboardSequenceNumber() } != before {
            break;
        }
        if started.elapsed() >= Duration::from_secs(1) {
            return Err(UNAVAILABLE.into());
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let clipboard = Clipboard::open(owner.0)?;
    let mut owner_process = 0;
    unsafe {
        GetWindowThreadProcessId(
            GetClipboardOwner().unwrap_or_default(),
            Some(&mut owner_process),
        )
    };
    let mut foreground_process = 0;
    unsafe { GetWindowThreadProcessId(foreground, Some(&mut foreground_process)) };
    // Never translate or restore a clipboard written by an unrelated application.
    if owner_process != foreground_process {
        return Err(UNAVAILABLE.into());
    }
    let result = clipboard_bytes(13, 32 * 1024 * 1024).and_then(|bytes| {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .take(crate::protocol::MAX_CHARACTERS + 1)
            .collect();
        if units.len() > crate::protocol::MAX_CHARACTERS {
            return Err(TOO_LONG.into());
        }
        String::from_utf16(&units).map_err(|_| UNAVAILABLE.into())
    });
    // Delayed rendering may advance the sequence while GetClipboardData runs.
    let copied = unsafe { GetClipboardSequenceNumber() };
    drop(clipboard);
    restore_clipboard(owner.0, copied, saved)?;
    result
}
