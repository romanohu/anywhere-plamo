use serde::Deserialize;

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

// Called on a worker. AppKit geometry is read on the main thread by the native bridge.
#[cfg(target_os = "macos")]
pub fn capture(window: usize, region: Region) -> Result<String, String> {
    use std::ffi::{c_char, c_void, CStr};
    unsafe extern "C" {
        fn plamo_lens_capture(
            window: *mut c_void,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
        ) -> *mut c_char;
        fn plamo_lens_free(value: *mut c_char);
    }
    #[derive(Deserialize)]
    struct Response {
        text: Option<String>,
        error: Option<String>,
    }
    region.validate()?;
    let response = unsafe {
        let value = plamo_lens_capture(
            window as *mut c_void,
            region.x,
            region.y,
            region.width,
            region.height,
        );
        if value.is_null() {
            return Err("画面を読み取れませんでした。".into());
        }
        let response = serde_json::from_slice::<Response>(CStr::from_ptr(value).to_bytes());
        plamo_lens_free(value);
        response.map_err(|_| "文字認識の結果を取得できませんでした。")?
    };
    if let Some(error) = response.error {
        return Err(error);
    }
    Ok(response.text.unwrap_or_default())
}

#[cfg(not(target_os = "macos"))]
pub fn capture(_window: usize, region: Region) -> Result<String, String> {
    region.validate()?;
    Err("OCRレンズはMacで利用できます。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
