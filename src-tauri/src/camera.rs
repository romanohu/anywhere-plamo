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
            image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(2048);
        limits.max_image_height = Some(2048);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|_| invalid)?;
        if image.width() < 16 || image.height() < 16 {
            return Err(invalid.into());
        }
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
        image
            .to_rgb8()
            .save(&capture.path)
            .map_err(|_| "撮影画像を保存できません。")?;
        Ok(capture)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub fn permission(
    webview: tauri::Webview,
    kind: tauri::webview::PermissionKind,
) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    let local = webview.url().is_ok_and(|url| {
        url.scheme() == "tauri"
            || matches!(
                url.host_str(),
                Some("tauri.localhost" | "localhost" | "127.0.0.1")
            )
    });
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
        let capture = Capture::new(&root, &encoded(32, 24)).unwrap();
        let path = capture.path.clone();
        assert_eq!(image::image_dimensions(&path).unwrap(), (32, 24));
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
        ] {
            assert!(Capture::new(&root, &value).is_err());
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }
}
