use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufWriter, Write},
};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "linux")]
#[path = "lens_linux.rs"]
mod linux;

#[path = "ocr.rs"]
mod ocr;
pub use ocr::Ocr;

#[derive(Default)]
pub struct Watch {
    frame: Option<([u8; 32], Instant)>,
    recognized: bool,
    waiting_since: Option<Instant>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureResult {
    Changed,
    Unchanged,
    Text {
        text: String,
        blocks: Vec<TextBlock>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TextBlock {
    text: String,
    // Fractions of the captured image, independent of Retina scale/downsampling.
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    regions: Vec<Region>,
}

impl Watch {
    fn observe(&mut self, hash: [u8; 32], now: Instant) -> Option<CaptureResult> {
        let same = self.frame.is_some_and(|(previous, _)| previous == hash);
        if same && self.recognized {
            return Some(CaptureResult::Unchanged);
        }
        let waiting = *self.waiting_since.get_or_insert(now);
        let settled = same
            && self
                .frame
                .is_some_and(|(_, since)| now.duration_since(since) >= Duration::from_millis(100));
        if !same {
            self.frame = Some((hash, now));
            self.recognized = false;
        }
        // A blinking caret or animation in a large region must not postpone OCR forever.
        if settled || now.duration_since(waiting) >= Duration::from_millis(800) {
            self.waiting_since = None;
            None
        } else {
            Some(CaptureResult::Changed)
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Region {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Deserialize)]
pub struct CaptureArea {
    #[serde(flatten)]
    region: Region,
    #[serde(rename = "bottomInset")]
    bottom_inset: f64,
}

impl Region {
    fn validate(self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| !value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || !(16.0..=8192.0).contains(&self.width)
            || !(16.0..=8192.0).contains(&self.height)
        {
            return Err("読み取り範囲が無効です。レンズを広げて再試行してください。".into());
        }
        Ok(())
    }
}

pub fn ready(runtime: &Path) -> bool {
    [
        "ocr/ocr-worker",
        "ocr-models/PP-OCRv6_det_small.onnx",
        "ocr-models/PP-OCRv6_rec_small.onnx",
    ]
    .iter()
    .all(|file| runtime.join(file).is_file())
}

struct CaptureFile {
    directory: PathBuf,
    path: PathBuf,
}

impl CaptureFile {
    fn new() -> Result<Self, String> {
        use std::os::unix::fs::DirBuilderExt;
        let directory =
            std::env::temp_dir().join(format!("anywhere-plamo-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "読み取り用の一時ファイルを作成できません。")?;
        Ok(Self {
            path: directory.join("capture.ppm"),
            directory,
        })
    }
}

impl Drop for CaptureFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

// PPM preserves capture pixels without platform-dependent image encoders.
fn write_image(path: &Path, image: image::RgbImage) -> Result<(), String> {
    let image = if image.width().max(image.height()) > 4096 {
        image::DynamicImage::ImageRgb8(image)
            .resize(4096, 4096, image::imageops::FilterType::Triangle)
            .to_rgb8()
    } else {
        image
    };
    let mut file =
        BufWriter::new(File::create(path).map_err(|_| "読み取り画像を保存できません。")?);
    write!(file, "P6\n{} {}\n255\n", image.width(), image.height())
        .and_then(|_| file.write_all(image.as_raw()))
        .and_then(|_| file.flush())
        .map_err(|_| "読み取り画像を保存できません。".into())
}

pub async fn capture(
    window: tauri::WebviewWindow,
    area: CaptureArea,
    selection: bool,
    ocr: (&Ocr, &Path),
    cancel: &CancellationToken,
    watch: Option<&Mutex<Watch>>,
    on_read: impl FnOnce(),
) -> Result<CaptureResult, String> {
    let (ocr, runtime) = ocr;
    let region = area.region;
    region.validate()?;
    if !area.bottom_inset.is_finite() || !(0.0..=8192.0).contains(&area.bottom_inset) {
        return Err("読み取り範囲が無効です。".into());
    }
    if watch.is_some() && selection {
        return Err("Waylandでは「更新」で画面を選択してください。".into());
    }
    if !ready(runtime) {
        return Err("文字認識エンジンが見つかりません。アプリを再インストールしてください。ソース版では npm run ocr:build を実行してください。".into());
    }
    let file = CaptureFile::new()?;
    #[cfg(target_os = "macos")]
    let captured_height = {
        let _ = selection;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |view| {
                let _ = sender.send(view.inner() as usize);
            })
            .map_err(|error| error.to_string())?;
        let native = receiver.await.map_err(|error| error.to_string())?;
        let path = file.path.clone();
        let token = cancel.clone();
        tauri::async_runtime::spawn_blocking(move || capture_macos(native, area, &path, &token))
            .await
            .map_err(|error| error.to_string())??
    };
    #[cfg(target_os = "linux")]
    linux::capture(
        &window,
        region,
        selection,
        watch.is_some(),
        &file.path,
        cancel,
    )
    .await?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("このOSでは画面の読み取りに対応していません。".into());
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    if let Some(watch) = watch {
        use sha2::{Digest, Sha256};
        let bytes = tokio::fs::read(&file.path)
            .await
            .map_err(|_| "読み取り画像を開けません。")?;
        let hash = Sha256::digest(&bytes).into();
        if let Some(result) = watch
            .lock()
            .map_err(|_| "画面の状態を取得できません。")?
            .observe(hash, Instant::now())
        {
            return Ok(result);
        }
    }
    on_read();
    let blocks = ocr.recognize(runtime, &file.path, cancel).await?;
    #[cfg(target_os = "macos")]
    let blocks = fit_capture_height(blocks, captured_height / region.height);
    if let Some(watch) = watch {
        watch
            .lock()
            .map_err(|_| "画面の状態を取得できません。")?
            .recognized = true;
    }
    let text = blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(CaptureResult::Text { text, blocks })
}

#[cfg(any(target_os = "macos", test))]
fn fit_capture_height(mut blocks: Vec<TextBlock>, fraction: f64) -> Vec<TextBlock> {
    // Keep OCR positions relative to the requested DOM region when AppKit clips its bottom.
    for block in &mut blocks {
        block.y *= fraction;
        block.height *= fraction;
        for region in &mut block.regions {
            region.y *= fraction;
            region.height *= fraction;
        }
    }
    blocks
}

fn check_text_limit(blocks: &[TextBlock]) -> Result<(), String> {
    if blocks
        .iter()
        .map(|block| block.text.encode_utf16().count() + 2)
        .sum::<usize>()
        .saturating_sub(2)
        > crate::protocol::MAX_CHARACTERS
    {
        return Err("文字が多すぎます。読み取る範囲を小さくしてください。".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_macos(
    window: usize,
    area: CaptureArea,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<f64, String> {
    use std::ffi::{c_char, c_void, CStr, CString};
    unsafe extern "C" {
        fn plamo_lens_capture(
            window: *mut c_void,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            bottom_inset: f64,
            path: *const c_char,
            cancelled: extern "C" fn(*const c_void) -> bool,
            context: *const c_void,
        ) -> *mut c_char;
        fn plamo_lens_free(value: *mut c_char);
    }
    extern "C" fn cancelled(context: *const c_void) -> bool {
        // The native bridge calls this only synchronously on this worker.
        unsafe { &*context.cast::<CancellationToken>() }.is_cancelled()
    }
    #[derive(Deserialize)]
    struct Response {
        error: Option<String>,
        height: Option<f64>,
    }
    let path = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "画像の保存先が無効です。")?;
    let region = area.region;
    let response = unsafe {
        let value = plamo_lens_capture(
            window as *mut c_void,
            region.x,
            region.y,
            region.width,
            region.height,
            area.bottom_inset,
            path.as_ptr(),
            cancelled,
            (cancel as *const CancellationToken).cast(),
        );
        if value.is_null() {
            return Err("画面を読み取れませんでした。".into());
        }
        let response = serde_json::from_slice::<Response>(CStr::from_ptr(value).to_bytes());
        plamo_lens_free(value);
        response.map_err(|_| "画面の取得結果を読み取れませんでした。")?
    };
    if let Some(error) = response.error {
        return Err(error);
    }
    response
        .height
        .filter(|height| height.is_finite() && *height > 0.0 && *height <= region.height)
        .ok_or_else(|| "画面の取得範囲を読み取れませんでした。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_blocks() -> Vec<TextBlock> {
        vec![TextBlock {
            text: "Hello world.".into(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.1,
            regions: vec![Region {
                x: 0.1,
                y: 0.1,
                width: 0.4,
                height: 0.025,
            }],
        }]
    }

    #[test]
    fn watch_waits_for_settled_frames_and_skips_recognized_images() {
        let mut watch = Watch::default();
        let start = Instant::now();
        assert!(matches!(
            watch.observe([1; 32], start),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([1; 32], start + Duration::from_millis(99)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(100)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(199)),
            Some(CaptureResult::Changed)
        ));
        assert!(watch
            .observe([2; 32], start + Duration::from_millis(200))
            .is_none());
        watch.recognized = true;
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_secs(10)),
            Some(CaptureResult::Unchanged)
        ));
        assert!(matches!(
            watch.observe([3; 32], start + Duration::from_secs(11)),
            Some(CaptureResult::Changed)
        ));
        assert!(!watch.recognized);
    }

    #[test]
    fn continuous_motion_cannot_postpone_ocr_indefinitely() {
        let mut watch = Watch::default();
        let start = Instant::now();
        for frame in 0..8 {
            assert!(matches!(
                watch.observe(
                    [frame; 32],
                    start + Duration::from_millis(frame as u64 * 100)
                ),
                Some(CaptureResult::Changed)
            ));
        }
        assert!(watch
            .observe([8; 32], start + Duration::from_millis(800))
            .is_none());
        watch.recognized = true;
        assert!(matches!(
            watch.observe([8; 32], start + Duration::from_secs(10)),
            Some(CaptureResult::Unchanged)
        ));
        assert!(matches!(
            watch.observe([9; 32], start + Duration::from_secs(11)),
            Some(CaptureResult::Changed)
        ));
        assert!(watch
            .observe([9; 32], start + Duration::from_millis(11100))
            .is_none());
    }

    #[test]
    fn clipping_the_capture_bottom_preserves_ocr_positions_in_the_lens() {
        let blocks = layout_blocks();
        let fitted = fit_capture_height(layout_blocks(), 0.9);
        for (before, after) in blocks.iter().zip(fitted) {
            assert_eq!((before.x, before.width), (after.x, after.width));
            assert_eq!(before.text, after.text);
            assert!((before.y * 720.0 - after.y * 800.0).abs() < 0.001);
            assert!((before.height * 720.0 - after.height * 800.0).abs() < 0.001);
            for (before, after) in before.regions.iter().zip(after.regions) {
                assert_eq!((before.x, before.width), (after.x, after.width));
                assert!((before.y * 720.0 - after.y * 800.0).abs() < 0.001);
                assert!((before.height * 720.0 - after.height * 800.0).abs() < 0.001);
            }
        }
    }

    #[test]
    fn capture_requires_a_finite_bounded_region() {
        let region = Region {
            x: 2.0,
            y: 48.0,
            width: 600.0,
            height: 300.0,
        };
        assert!(region.validate().is_ok());
        for invalid in [
            Region { x: -1.0, ..region },
            Region {
                y: f64::NAN,
                ..region
            },
            Region {
                width: f64::INFINITY,
                ..region
            },
            Region {
                height: 0.0,
                ..region
            },
            Region {
                width: 8193.0,
                ..region
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn captures_are_private_and_removed_on_drop() {
        use std::os::unix::fs::PermissionsExt;
        let file = CaptureFile::new().unwrap();
        let directory = file.directory.clone();
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        write_image(
            &file.path,
            image::RgbImage::from_pixel(2, 1, image::Rgb([10, 20, 30])),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(&file.path).unwrap(),
            b"P6\n2 1\n255\n\x0a\x14\x1e\x0a\x14\x1e"
        );
        drop(file);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn cancelling_ocr_stops_the_child_process() {
        use std::os::unix::fs::PermissionsExt;
        let file = CaptureFile::new().unwrap();
        std::fs::create_dir(file.directory.join("ocr")).unwrap();
        let executable = file.directory.join("ocr/ocr-worker");
        std::fs::write(&executable, "#!/bin/sh\necho $$ > \"$1\"\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cancel = CancellationToken::new();
        let runtime = file.directory.clone();
        let path = file.path.clone();
        let pid_file = runtime.join("ocr-models");
        let token = cancel.clone();
        let ocr = std::sync::Arc::new(Ocr::default());
        let operation = ocr.clone();
        let task = tokio::spawn(async move { operation.recognize(&runtime, &path, &token).await });
        let pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = value.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
        .to_string();
        cancel.cancel();
        assert_eq!(task.await.unwrap().unwrap_err(), "CANCELLED");
        tokio::time::timeout(Duration::from_secs(3), async {
            while std::process::Command::new("kill")
                .args(["-0", pid.trim()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled OCR process remained alive");
        std::fs::write(
            &executable,
            "#!/bin/sh\nwhile read -r request; do echo '{\"blocks\":[]}'; done\n",
        )
        .unwrap();
        for _ in 0..2 {
            assert!(ocr
                .recognize(&file.directory, &file.path, &CancellationToken::new())
                .await
                .unwrap()
                .is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "requires npm run ocr:build"]
    async fn bundled_ocr_keeps_ruby_prose_together_at_different_widths() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let runtime = root.join("resources/runtime");
        let ocr = Ocr::default();
        // Public-domain Rashomon, rendered with its ruby at narrow/wide widths:
        // https://www.aozora.gr.jp/cards/000879/files/127_15260.html
        for (name, scale) in [
            ("narrow", 1.0),
            ("wide", 1.0),
            ("narrow", 1.5),
            ("wide", 1.5),
            ("narrow", 2.0),
            ("wide", 2.0),
            ("serif-wide", 1.0),
            ("serif-wide", 1.5),
            ("serif-wide", 2.0),
            ("serif-large", 1.0),
            ("serif-large", 1.5),
            ("serif-large", 2.0),
        ] {
            let image = image::open(root.join(format!("../tests/fixtures/ocr-ruby-{name}.png")))
                .unwrap()
                .to_rgb8();
            let image = image::imageops::resize(
                &image,
                (image.width() as f64 * scale) as u32,
                (image.height() as f64 * scale) as u32,
                image::imageops::FilterType::Triangle,
            );
            let file = CaptureFile::new().unwrap();
            write_image(&file.path, image).unwrap();
            let blocks = ocr
                .recognize(&runtime, &file.path, &CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(
                blocks.len(),
                if name == "wide" { 4 } else { 2 },
                "{name} {scale}: {blocks:?}"
            );
            assert!(
                blocks[0].text.starts_with("ある日の暮方の事である"),
                "{name}: {blocks:?}"
            );
            assert!(blocks[0].text.contains("待っていた"));
            assert!(blocks[1].text.starts_with("広い門の下には"));
            assert!(blocks[1].text.contains("ほかには誰もいない"));
            assert!(!blocks
                .iter()
                .any(|block| block.text.contains("らしょうもん")
                    || block.text.contains("すざくおおじ")));
            assert!(blocks[0].y + blocks[0].height < blocks[1].y);
            assert!(blocks[1].regions.len() >= 2);
            if name == "wide" {
                assert!(blocks[2].text.starts_with("何故かと云うと"));
                assert!(blocks[3].text.starts_with("その代り"));
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires npm run ocr:build"]
    async fn bundled_ocr_reads_japanese_and_english_images() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let runtime = root.join("resources/runtime");
        let ocr = Ocr::default();
        assert!(ready(&runtime), "Run npm run ocr:build first");
        for (name, expected) in [
            ("english", "Local translation"),
            ("japanese", "画像"),
            ("columns", "speech bubble"),
            ("vertical", "画像の文字を翻訳します日本語を英語に変換する"),
        ] {
            let image = image::open(root.join(format!("../tests/fixtures/ocr-{name}.png")))
                .unwrap()
                .to_rgb8();
            let file = CaptureFile::new().unwrap();
            write_image(&file.path, image).unwrap();
            let text = ocr
                .recognize(&runtime, &file.path, &CancellationToken::new())
                .await
                .unwrap();
            assert!(
                text.iter().any(|block| block.text.contains(expected)),
                "{name}: {text:?}"
            );
            for block in &text {
                assert!(!block.regions.is_empty());
                assert!(
                    block.regions.iter().all(|region| region.width > 0.0
                        && region.height > 0.0
                        && region.x >= 0.0
                        && region.y >= 0.0
                        && region.x + region.width <= 1.0
                        && region.y + region.height <= 1.0),
                    "{name}: {block:?}"
                );
            }
            if name == "columns" {
                assert_eq!(text.len(), 5, "{text:?}");
                assert_eq!(text[0].text, "Read this speech bubble. Keep its lines together. Local translation is useful.");
                assert_eq!(
                    text[1].text,
                    "This is another speaker. Do not mix these words with the text on the left."
                );
                assert!(text[2].text.starts_with("The last speaker replies."));
                assert!(text[0].x + text[0].width < text[1].x);
                assert!(text[1].x + text[1].width < text[2].x);
                assert!(text[3].y > text[0].y + text[0].height);
            } else if name == "vertical" {
                assert_eq!(text.len(), 2, "{text:?}");
                assert_eq!(text[1].text, "今日は良い天気ですね明日も晴れるでしょう");
                assert!(text[0].x > text[1].x + text[1].width);
                assert!(text.iter().all(|block| block.height > block.width * 3.0));
            }
        }
    }
}
