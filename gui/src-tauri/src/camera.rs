use base64::Engine;
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};

pub struct Capture {
    pub path: PathBuf,
    directory: PathBuf,
}

impl Capture {
    pub fn new(root: &Path, data: &str) -> Result<Self, String> {
        let invalid = "撮影画像を読み込めません。もう一度撮影してください。";
        if data.len() > 24 * 1024 * 1024 {
            return Err("画像が大きすぎます。".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.strip_prefix("data:image/png;base64,").ok_or(invalid)?)
            .map_err(|_| invalid)?;
        let mut reader =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(2048);
        limits.max_image_height = Some(2048);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|_| invalid)?;
        if image.width() < 16 || image.height() < 16 {
            return Err(invalid.into());
        }
        // Validate the entire image, then keep the lossless camera PNG as-is.
        // Re-encoding the decoded pixels adds CPU work and another full frame.
        drop(image);
        std::fs::create_dir_all(root).map_err(|_| "画像の保存先を作成できません。")?;
        let directory = root.join(format!("camera-{}", uuid::Uuid::new_v4()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder
            .create(&directory)
            .map_err(|_| "撮影画像を保存できません。")?;
        let capture = Self {
            path: directory.join("capture.png"),
            directory,
        };
        std::fs::write(&capture.path, bytes)
            .map_err(|_| "撮影画像を保存できません。")?;
        Ok(capture)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn local_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        )
}

#[cfg(target_os = "android")]
#[derive(Default)]
pub struct PermissionOrigin(std::sync::atomic::AtomicBool);

#[cfg(target_os = "android")]
pub fn page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    use tauri::Manager;
    if webview.label() == "main" {
        webview.state::<PermissionOrigin>().0.store(
            payload.event() == tauri::webview::PageLoadEvent::Finished && local_page(payload.url()),
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}

pub fn permission(
    webview: tauri::Webview,
    kind: tauri::webview::PermissionKind,
) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    // Android calls this from its UI thread. Querying webview.url() here waits
    // for that same thread and deadlocks; use the native page-load URL instead.
    #[cfg(target_os = "android")]
    let local = {
        use tauri::Manager;
        webview
            .state::<PermissionOrigin>()
            .0
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    #[cfg(not(target_os = "android"))]
    let local = webview.url().is_ok_and(|url| local_page(&url));
    if webview.label() == "main" && local && matches!(kind, PermissionKind::Camera) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(width: u32, height: u32) -> String {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::new(width, height));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        )
    }

    #[test]
    fn private_capture_is_removed_after_use_and_invalid_images_are_rejected() {
        let root = std::env::temp_dir().join(format!("camera-test-{}", uuid::Uuid::new_v4()));
        let input = encoded(32, 24);
        let capture = Capture::new(&root, &input).unwrap();
        let path = capture.path.clone();
        assert_eq!(image::image_dimensions(&path).unwrap(), (32, 24));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            base64::engine::general_purpose::STANDARD
                .decode(input.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&capture.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(capture);
        assert!(!path.exists());
        for value in [
            "https://example.com/image.png".to_owned(),
            "data:image/png;base64,aW52YWxpZA==".to_owned(),
            encoded(2049, 16),
            encoded(1, 1),
            input[..input.len() / 2].to_owned(),
        ] {
            assert!(Capture::new(&root, &value).is_err());
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }
}
