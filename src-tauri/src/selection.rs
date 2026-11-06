//! Read the selection before bringing our window to the foreground.
//! The regular copy/paste clipboard is never read or overwritten here.

const UNAVAILABLE: &str = "選択した文字を取得できませんでした。文章を選択して、もう一度ショートカットを押してください。対応しないアプリでは、コピーして「貼り付け」を使えます。";
const TOO_LONG: &str = "一度に翻訳できるのは12,000文字までです。文章を短く分けてください。";

pub fn read() -> Result<String, String> {
    validate(read_platform()?)
}

fn validate(text: String) -> Result<String, String> {
    if text.encode_utf16().count() > crate::protocol::MAX_CHARACTERS {
        return Err(TOO_LONG.into());
    }
    if text.trim().is_empty() {
        return Err(UNAVAILABLE.into());
    }
    Ok(text)
}

#[cfg(target_os = "linux")]
fn read_platform() -> Result<String, String> {
    use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind};

    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland")
    {
        use wl_clipboard_rs::paste::{get_contents, ClipboardType, MimeType, Seat};

        // Do not fall back to an unrelated, potentially stale XWayland selection.
        let (pipe, _) = get_contents(ClipboardType::Primary, Seat::Unspecified, MimeType::Text)
            .map_err(|_| UNAVAILABLE.to_owned())?;
        return read_pipe(pipe, std::time::Duration::from_secs(2));
    }

    // arboard bounds an X11 owner's response and incremental-transfer inactivity.
    Clipboard::new()
        .and_then(|mut clipboard| {
            clipboard
                .get()
                .clipboard(LinuxClipboardKind::Primary)
                .text()
        })
        .map_err(|_| UNAVAILABLE.to_owned())
}

#[cfg(target_os = "linux")]
fn read_pipe(
    mut pipe: impl std::io::Read + std::os::fd::AsRawFd,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::{io::ErrorKind, time::Instant};

    const TIMED_OUT: &str =
        "選択した文字の取得がタイムアウトしました。文章をコピーして「貼り付け」を使ってください。";
    let fd = pipe.as_raw_fd();
    // The descriptor stays owned by pipe; nonblocking reads ensure even a
    // source that keeps its pipe open cannot strand this worker after poll.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(UNAVAILABLE.into());
    }
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TIMED_OUT.into());
        }
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // poll borrows one live descriptor and never outlives this stack value.
        let ready = unsafe {
            libc::poll(
                &mut pollfd,
                1,
                remaining.as_millis().clamp(1, i32::MAX as u128) as i32,
            )
        };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(UNAVAILABLE.into());
        }
        if ready == 0 {
            continue;
        }
        match pipe.read(&mut buffer) {
            Ok(0) => return String::from_utf8(bytes).map_err(|_| UNAVAILABLE.to_owned()),
            Ok(count) => {
                if bytes.len() + count > 4 * crate::protocol::MAX_CHARACTERS {
                    return Err(TOO_LONG.into());
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
            Err(_) => return Err(UNAVAILABLE.into()),
        }
    }
}

#[cfg(target_os = "macos")]
fn read_platform() -> Result<String, String> {
    macos::read()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_platform() -> Result<String, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::{
        base::{Boolean, CFType, CFTypeID, CFTypeRef, TCFType},
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
    };

    // ApplicationServices' AX objects are reference-counted Core Foundation types.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementGetTypeID() -> CFTypeID;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, timeout: f32) -> i32;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
    }

    fn attribute(element: &CFType, name: &str) -> Result<CFType, String> {
        let name = CFString::new(name);
        let mut value = std::ptr::null();
        // Both inputs are live CF objects; a successful Copy transfers ownership.
        let result = unsafe {
            AXUIElementCopyAttributeValue(
                element.as_CFTypeRef(),
                name.as_concrete_TypeRef(),
                &mut value,
            )
        };
        if result != 0 || value.is_null() {
            return Err(super::UNAVAILABLE.into());
        }
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }

    pub fn read() -> Result<String, String> {
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::new("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )]);
        // Ask the OS for permission only when the user invokes selection translation.
        if unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } == 0 {
            return Err("選択した文字を読むには、システム設定 → プライバシーとセキュリティ → アクセシビリティでAnywhere Plamoを許可してください。その後、元のアプリで文章を選択して再試行してください。".into());
        }
        let system = unsafe { AXUIElementCreateSystemWide() };
        if system.is_null() {
            return Err(super::UNAVAILABLE.into());
        }
        let system = unsafe { CFType::wrap_under_create_rule(system) };
        unsafe { AXUIElementSetMessagingTimeout(system.as_CFTypeRef(), 2.0) };
        let focused = attribute(&system, "AXFocusedUIElement")?;
        if focused.type_of() != unsafe { AXUIElementGetTypeID() } {
            return Err(super::UNAVAILABLE.into());
        }
        unsafe { AXUIElementSetMessagingTimeout(focused.as_CFTypeRef(), 2.0) };
        attribute(&focused, "AXSelectedText")?
            .downcast::<CFString>()
            .map(|text| text.to_string())
            .ok_or_else(|| super::UNAVAILABLE.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_limit_matches_the_utf16_input_limit() {
        assert!(validate("😀".repeat(crate::protocol::MAX_CHARACTERS / 2)).is_ok());
        assert_eq!(
            validate("😀".repeat(crate::protocol::MAX_CHARACTERS / 2 + 1)),
            Err(TOO_LONG.into())
        );
        assert_eq!(validate(" \n\t".into()), Err(UNAVAILABLE.into()));
    }

    #[cfg(target_os = "linux")]
    mod pipe {
        use super::*;
        use std::{
            io::{pipe, Write},
            time::{Duration, Instant},
        };

        #[test]
        fn preserves_utf8_split_across_reads() {
            let (reader, mut writer) = pipe().unwrap();
            let text = "日本語😀".repeat(2000);
            let bytes = text.clone().into_bytes();
            let source = std::thread::spawn(move || writer.write_all(&bytes).unwrap());
            assert_eq!(read_pipe(reader, Duration::from_secs(1)), Ok(text));
            source.join().unwrap();
        }

        #[test]
        fn rejects_oversized_transfers() {
            let (reader, mut writer) = pipe().unwrap();
            let source = std::thread::spawn(move || {
                writer
                    .write_all(&vec![b'a'; 4 * crate::protocol::MAX_CHARACTERS + 1])
                    .unwrap();
            });
            assert_eq!(
                read_pipe(reader, Duration::from_secs(1)),
                Err(TOO_LONG.into())
            );
            source.join().unwrap();
        }

        #[test]
        fn times_out_when_the_source_keeps_its_pipe_open() {
            let (reader, _writer) = pipe().unwrap();
            let started = Instant::now();
            let error = read_pipe(reader, Duration::from_millis(20)).unwrap_err();
            assert!(error.contains("タイムアウト"));
            assert!(started.elapsed() < Duration::from_secs(1));
        }

        #[test]
        fn arriving_bytes_do_not_extend_the_deadline() {
            let (reader, mut writer) = pipe().unwrap();
            let source = std::thread::spawn(move || {
                for _ in 0..200 {
                    if writer.write_all(b"a").is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
            let started = Instant::now();
            let error = read_pipe(reader, Duration::from_millis(30)).unwrap_err();
            assert!(error.contains("タイムアウト"));
            assert!(started.elapsed() < Duration::from_secs(1));
            source.join().unwrap();
        }
    }
}
