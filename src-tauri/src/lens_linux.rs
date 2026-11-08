use super::{write_image, Region};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;
use x11rb::{connection::Connection as _, protocol::xproto::ConnectionExt as _};

struct RestoreWindow<'a> {
    window: &'a tauri::WebviewWindow,
}

impl Drop for RestoreWindow<'_> {
    fn drop(&mut self) {
        let window = self.window.clone();
        let _ = self.window.run_on_main_thread(move || {
            // Check on the UI thread so a concurrent close cannot reopen the lens.
            if window
                .state::<crate::AppState>()
                .lens_open
                .load(Ordering::Relaxed)
            {
                let _ = window.show();
            }
        });
    }
}

pub async fn capture(
    window: &tauri::WebviewWindow,
    region: Region,
    selection: bool,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let bounds = if selection {
        None
    } else {
        let origin = window.inner_position().map_err(|error| error.to_string())?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        Some((
            origin.x + (region.x * scale).round() as i32,
            origin.y + (region.y * scale).round() as i32,
            (region.width * scale).round() as u32,
            (region.height * scale).round() as u32,
        ))
    };
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    window.hide().map_err(|error| error.to_string())?;
    let restore = RestoreWindow { window };
    // Let the compositor remove the lens before reading the underlying pixels.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("CANCELLED".into()),
        _ = tokio::time::sleep(Duration::from_millis(120)) => {}
    }
    let token = cancel.clone();
    let path = path.to_owned();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let image = if let Some((x, y, width, height)) = bounds {
            capture_x11(x, y, width, height)?
        } else {
            let file = portal_screenshot(&token)?;
            let mut reader = image::ImageReader::open(file)
                .and_then(|reader| reader.with_guessed_format())
                .map_err(|_| "選択した画像を開けませんでした。")?;
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(16384);
            limits.max_image_height = Some(16384);
            limits.max_alloc = Some(256 * 1024 * 1024);
            reader.limits(limits);
            reader
                .decode()
                .map_err(|_| "選択した画像を読み取れませんでした。")?
                .to_rgb8()
        };
        if token.is_cancelled() {
            return Err("CANCELLED".into());
        }
        write_image(&path, image)
    })
    .await
    .map_err(|error| error.to_string())?;
    drop(restore);
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    result
}

fn capture_x11(x: i32, y: i32, width: u32, height: u32) -> Result<image::RgbImage, String> {
    let (connection, screen) =
        x11rb::connect(None).map_err(|_| "X11の画面に接続できませんでした。")?;
    let screen = &connection.setup().roots[screen];
    let geometry = connection
        .get_geometry(screen.root)
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?;
    if x < 0
        || y < 0
        || x > i16::MAX as i32
        || y > i16::MAX as i32
        || width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || x as u64 + width as u64 > geometry.width as u64
        || y as u64 + height as u64 > geometry.height as u64
    {
        return Err("レンズ全体を画面内に置いて、もう一度更新してください。".into());
    }
    let (pixels, visual_id) = x11rb::image::Image::get(
        &connection,
        screen.root,
        x as i16,
        y as i16,
        width as u16,
        height as u16,
    )
    .map_err(|_| "画面を取得できませんでした。範囲を変えて再試行してください。")?;
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == visual_id)
        .filter(|visual| visual.red_mask != 0 && visual.green_mask != 0 && visual.blue_mask != 0)
        .ok_or("この画面の色形式には対応していません。")?;
    let channel = |pixel: u32, mask: u32| -> u8 {
        (((pixel & mask) >> mask.trailing_zeros()) as u64 * 255
            / (mask >> mask.trailing_zeros()) as u64) as u8
    };
    Ok(image::RgbImage::from_fn(width, height, |x, y| {
        let pixel = pixels.get_pixel(x as u16, y as u16);
        image::Rgb([
            channel(pixel, visual.red_mask),
            channel(pixel, visual.green_mask),
            channel(pixel, visual.blue_mask),
        ])
    }))
}

fn portal_screenshot(cancel: &CancellationToken) -> Result<PathBuf, String> {
    use dbus::{
        arg::{PropMap, Variant},
        blocking::Connection,
        message::MatchRule,
    };
    let connection =
        Connection::new_session().map_err(|_| "画面選択サービスに接続できませんでした。")?;
    let token = format!("plamo_{}", uuid::Uuid::new_v4().simple());
    let sender = connection
        .unique_name()
        .trim_start_matches(':')
        .replace('.', "_");
    let request = Arc::new(Mutex::new(format!(
        "/org/freedesktop/portal/desktop/request/{sender}/{token}"
    )));
    let response = Arc::new(Mutex::new(None));
    let response_copy = response.clone();
    let request_copy = request.clone();
    let rule = MatchRule::new_signal("org.freedesktop.portal.Request", "Response")
        .with_sender("org.freedesktop.portal.Desktop");
    connection
        .add_match(rule, move |value: (u32, PropMap), _, message| {
            if message
                .path()
                .is_some_and(|path| path.to_string() == *request_copy.lock().unwrap())
            {
                *response_copy.lock().unwrap() = Some(value);
            }
            true
        })
        .map_err(|error| error.to_string())?;
    let proxy = connection.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(5),
    );
    let mut options = PropMap::new();
    options.insert("handle_token".into(), Variant(Box::new(token)));
    options.insert("interactive".into(), Variant(Box::new(true)));
    options.insert("modal".into(), Variant(Box::new(false)));
    let (handle,): (dbus::Path<'static>,) = proxy.method_call(
        "org.freedesktop.portal.Screenshot", "Screenshot", ("", options),
    ).map_err(|_| "画面を選択できません。xdg-desktop-portalとデスクトップ環境用のバックエンドを確認してください。")?;
    *request.lock().unwrap() = handle.to_string();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if cancel.is_cancelled() || Instant::now() >= deadline {
            let proxy = connection.with_proxy(
                "org.freedesktop.portal.Desktop",
                handle.clone(),
                Duration::from_secs(1),
            );
            let _: Result<(), _> = proxy.method_call("org.freedesktop.portal.Request", "Close", ());
            return Err(if cancel.is_cancelled() {
                "CANCELLED"
            } else {
                "画面選択がタイムアウトしました。もう一度更新してください。"
            }
            .into());
        }
        connection
            .process(Duration::from_millis(100))
            .map_err(|_| "画面選択サービスとの接続が切れました。")?;
        if let Some((code, result)) = response.lock().unwrap().take() {
            return match code {
                0 => dbus::arg::prop_cast::<String>(&result, "uri")
                    .and_then(|uri| reqwest::Url::parse(uri).ok())
                    .and_then(|uri| uri.to_file_path().ok())
                    .ok_or_else(|| "選択した画像の保存先を取得できませんでした。".into()),
                1 => Err("CANCELLED".into()),
                _ => Err("画面を選択できませんでした。もう一度更新してください。".into()),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[tokio::test]
    #[ignore = "requires bundled OCR and a dedicated 24-bit X11 test display"]
    async fn x11_captures_pixels_and_reads_text() {
        use x11rb::protocol::xproto::{CreateGCAux, Rectangle};
        let (connection, screen) = x11rb::connect(None).unwrap();
        let screen = &connection.setup().roots[screen];
        let gc = connection.generate_id().unwrap();
        connection
            .create_gc(gc, screen.root, &CreateGCAux::new().foreground(0x123456))
            .unwrap();
        connection
            .poly_fill_rectangle(
                screen.root,
                gc,
                &[Rectangle {
                    x: 20,
                    y: 30,
                    width: 100,
                    height: 80,
                }],
            )
            .unwrap();
        connection.get_input_focus().unwrap().reply().unwrap();
        let image = capture_x11(25, 35, 50, 40).unwrap();
        assert_eq!(image.dimensions(), (50, 40));
        assert!(image.pixels().all(|pixel| pixel.0 == [0x12, 0x34, 0x56]));
        assert!(capture_x11(-1, 0, 100, 100).is_err());
        assert!(capture_x11(screen.width_in_pixels as i32 - 10, 0, 100, 100).is_err());
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for (name, expected) in [("english", "Local translation"), ("japanese", "画像")] {
            let source = image::open(root.join(format!("../tests/fixtures/ocr-{name}.png")))
                .unwrap()
                .to_rgb8();
            let (mut pixels, _) = x11rb::image::Image::get(
                &connection,
                screen.root,
                0,
                0,
                source.width() as u16,
                source.height() as u16,
            )
            .unwrap();
            for (x, y, pixel) in source.enumerate_pixels() {
                pixels.put_pixel(
                    x as u16,
                    y as u16,
                    (pixel[0] as u32) << 16 | (pixel[1] as u32) << 8 | pixel[2] as u32,
                );
            }
            pixels.put(&connection, screen.root, gc, 30, 40).unwrap();
            connection.get_input_focus().unwrap().reply().unwrap();
            let captured = capture_x11(30, 40, source.width(), source.height()).unwrap();
            let file = super::super::CaptureFile::new().unwrap();
            write_image(&file.path, captured).unwrap();
            let text = super::super::recognize(
                &root.join("resources/runtime"),
                &file.path,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert!(text.contains(expected), "{name}: {text}");
        }
    }

    #[test]
    #[ignore = "requires a private D-Bus session: dbus-run-session cargo test portal_handles -- --ignored"]
    fn portal_handles_immediate_responses_and_closes_cancelled_requests() {
        use dbus::{
            arg::{PropMap, Variant},
            blocking::{stdintf::org_freedesktop_dbus::RequestNameReply, Connection},
            channel::{MatchingReceiver, Sender},
            message::MatchRule,
        };
        for code in [Some(0u32), Some(1u32), None] {
            let cancel = CancellationToken::new();
            let token = cancel.clone();
            let (ready, wait) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let connection = Connection::new_session().unwrap();
                assert_eq!(
                    connection
                        .request_name("org.freedesktop.portal.Desktop", false, false, true)
                        .unwrap(),
                    RequestNameReply::PrimaryOwner,
                    "Use a private D-Bus session, never the desktop session"
                );
                let done = Arc::new(AtomicBool::new(false));
                let finished = done.clone();
                connection.start_receive(MatchRule::new_method_call(), Box::new(move |message, connection| {
                    match message.member().as_ref().map(|member| member.as_ref()) {
                        Some("Screenshot") => {
                            let (parent, options): (String, PropMap) = message.read2().unwrap();
                            assert!(parent.is_empty());
                            assert_eq!(dbus::arg::prop_cast::<bool>(&options, "interactive"), Some(&true));
                            let handle_token = dbus::arg::prop_cast::<String>(&options, "handle_token").unwrap();
                            let sender = message.sender().unwrap().trim_start_matches(':').replace('.', "_");
                            let path = dbus::Path::new(format!("/org/freedesktop/portal/desktop/request/{sender}/{handle_token}")).unwrap();
                            connection.send(message.method_return().append1(path.clone())).unwrap();
                            if let Some(code) = code {
                                let mut result = PropMap::new();
                                result.insert("uri".into(), Variant(Box::new("file:///tmp/selected%20image.png".to_owned())));
                                let signal = dbus::Message::new_signal(path.to_string(), "org.freedesktop.portal.Request", "Response").unwrap().append2(code, result);
                                connection.send(signal).unwrap();
                                finished.store(true, Ordering::Relaxed);
                            } else {
                                token.cancel();
                            }
                        }
                        Some("Close") => {
                            connection.send(message.method_return()).unwrap();
                            finished.store(true, Ordering::Relaxed);
                        }
                        _ => {}
                    }
                    true
                }));
                ready.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !done.load(Ordering::Relaxed) {
                    assert!(
                        Instant::now() < deadline,
                        "portal request was not completed/closed"
                    );
                    connection.process(Duration::from_millis(20)).unwrap();
                }
                connection.channel().flush();
            });
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            let result = portal_screenshot(&cancel);
            server.join().unwrap();
            if code == Some(0) {
                assert_eq!(result.unwrap(), PathBuf::from("/tmp/selected image.png"));
            } else {
                assert_eq!(result.unwrap_err(), "CANCELLED");
            }
        }
    }
}
