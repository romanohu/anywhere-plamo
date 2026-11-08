use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "linux", test))]
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

#[derive(Default)]
pub struct Watch {
    frame: Option<([u8; 32], Instant)>,
    recognized: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", content = "text", rename_all = "camelCase")]
pub enum CaptureResult {
    Changed,
    Unchanged,
    Text(String),
}

impl Watch {
    fn observe(&mut self, hash: [u8; 32], now: Instant) -> Option<CaptureResult> {
        match self.frame {
            Some((previous, _)) if previous == hash && self.recognized => {
                Some(CaptureResult::Unchanged)
            }
            Some((previous, since))
                if previous == hash && now.duration_since(since) >= Duration::from_millis(500) =>
            {
                None
            }
            Some((previous, _)) if previous == hash => Some(CaptureResult::Changed),
            _ => {
                self.frame = Some((hash, now));
                self.recognized = false;
                Some(CaptureResult::Changed)
            }
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
pub struct Region {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
        "tesseract",
        "tessdata/eng.traineddata",
        "tessdata/jpn.traineddata",
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

// PPM needs no platform image codecs in the bundled OCR executable.
#[cfg(any(target_os = "linux", test))]
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
    region: Region,
    selection: bool,
    runtime: &Path,
    cancel: &CancellationToken,
    watch: Option<&Mutex<Watch>>,
) -> Result<CaptureResult, String> {
    region.validate()?;
    if watch.is_some() && selection {
        return Err("Waylandでは「更新」で画面を選択してください。".into());
    }
    if !ready(runtime) {
        return Err("文字認識エンジンが見つかりません。アプリを再インストールしてください。ソース版では npm run ocr:build を実行してください。".into());
    }
    let file = CaptureFile::new()?;
    #[cfg(target_os = "macos")]
    {
        let _ = selection;
        let native = window.ns_window().map_err(|error| error.to_string())? as usize;
        let path = file.path.clone();
        let token = cancel.clone();
        tauri::async_runtime::spawn_blocking(move || capture_macos(native, region, &path, &token))
            .await
            .map_err(|error| error.to_string())??;
    }
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
    let text = recognize(runtime, &file.path, cancel).await?;
    if let Some(watch) = watch {
        watch
            .lock()
            .map_err(|_| "画面の状態を取得できません。")?
            .recognized = true;
    }
    Ok(CaptureResult::Text(text))
}

async fn recognize(
    runtime: &Path,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    let mut child = tokio::process::Command::new(runtime.join("tesseract"))
        .arg(path)
        .arg("stdout")
        .arg("--tessdata-dir")
        .arg(runtime.join("tessdata"))
        .args(["-l", "jpn+eng", "--oem", "1", "--psm", "3"])
        .env("OMP_THREAD_LIMIT", "2")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "文字認識エンジンを起動できません。アプリを再インストールしてください。")?;
    let limit = crate::protocol::MAX_CHARACTERS * 4;
    let stdout = child
        .stdout
        .take()
        .expect("piped OCR output")
        .take(limit as u64 + 1);
    let mut bytes = Vec::new();
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED"),
        result = tokio::time::timeout(Duration::from_secs(60), async {
            tokio::try_join!(child.wait(), async {
                let mut stdout = stdout;
                stdout.read_to_end(&mut bytes).await
            })
        }) => match result {
            Ok(result) => result.map(|(status, _)| status).map_err(|_| "文字認識の結果を取得できませんでした。"),
            Err(_) => Err("文字認識がタイムアウトしました。範囲を小さくして再試行してください。"),
        }
    };
    let status = match outcome {
        Ok(status) => status,
        Err(error) => {
            // Reap the process before releasing this operation for the next update.
            let _ = child.kill().await;
            return Err(error.into());
        }
    };
    if bytes.len() > limit {
        return Err("文字が多すぎます。読み取る範囲を小さくしてください。".into());
    }
    if !status.success() {
        return Err("文字を認識できませんでした。範囲を変えて再試行してください。".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "文字認識の結果を取得できませんでした。")?;
    if text.encode_utf16().count() > crate::protocol::MAX_CHARACTERS {
        return Err("文字が多すぎます。読み取る範囲を小さくしてください。".into());
    }
    Ok(text.trim().to_owned())
}

#[cfg(target_os = "macos")]
fn capture_macos(
    window: usize,
    region: Region,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    use std::ffi::{c_char, c_void, CStr, CString};
    unsafe extern "C" {
        fn plamo_lens_capture(
            window: *mut c_void,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
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
    }
    let path = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "画像の保存先が無効です。")?;
    let response = unsafe {
        let value = plamo_lens_capture(
            window as *mut c_void,
            region.x,
            region.y,
            region.width,
            region.height,
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_waits_for_settled_frames_and_skips_recognized_images() {
        let mut watch = Watch::default();
        let start = Instant::now();
        assert!(matches!(
            watch.observe([1; 32], start),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([1; 32], start + Duration::from_millis(400)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(450)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(650)),
            Some(CaptureResult::Changed)
        ));
        assert!(watch
            .observe([2; 32], start + Duration::from_millis(950))
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
        let executable = file.directory.join("tesseract");
        std::fs::write(&executable, "#!/bin/sh\necho $$ > \"$1\"\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cancel = CancellationToken::new();
        let runtime = file.directory.clone();
        let path = file.path.clone();
        let token = cancel.clone();
        let task = tokio::spawn(async move { recognize(&runtime, &path, &token).await });
        let pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(&file.path) {
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
    }

    #[tokio::test]
    #[ignore = "requires npm run ocr:build"]
    async fn bundled_ocr_reads_japanese_and_english_images() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let runtime = root.join("resources/runtime");
        assert!(ready(&runtime), "Run npm run ocr:build first");
        for (name, expected) in [("english", "Local translation"), ("japanese", "画像")] {
            let image = image::open(root.join(format!("../tests/fixtures/ocr-{name}.png")))
                .unwrap()
                .to_rgb8();
            let file = CaptureFile::new().unwrap();
            write_image(&file.path, image).unwrap();
            let text = recognize(&runtime, &file.path, &CancellationToken::new())
                .await
                .unwrap();
            assert!(text.contains(expected), "{name}: {text}");
        }
    }
}
