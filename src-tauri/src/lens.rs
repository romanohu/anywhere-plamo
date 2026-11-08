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

#[derive(Default)]
pub struct Watch {
    frame: Option<([u8; 32], Instant)>,
    recognized: bool,
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

#[derive(Debug, Serialize)]
pub struct TextBlock {
    text: String,
    // Fractions of the captured image, independent of Retina scale/downsampling.
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    regions: Vec<Region>,
    #[serde(skip)]
    lines: Vec<OcrLine>,
}

#[derive(Debug, Clone)]
struct OcrLine {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    confidence: f64,
    words: usize,
    max_gap: f64,
}

impl OcrLine {
    fn right(&self) -> f64 {
        self.x + self.width
    }
    fn bottom(&self) -> f64 {
        self.y + self.height
    }
    fn center_y(&self) -> f64 {
        self.y + self.height / 2.0
    }
    fn score(&self) -> f64 {
        self.confidence / self.words.max(1) as f64
    }
    fn vertical(&self) -> bool {
        self.height > self.width * 1.8 && self.text.chars().filter(|ch| cjk(*ch)).count() > 1
    }
    fn region(&self, width: f64, height: f64) -> Region {
        Region {
            x: self.x / width,
            y: self.y / height,
            width: self.width / width,
            height: self.height / height,
        }
    }
}

impl Watch {
    fn observe(&mut self, hash: [u8; 32], now: Instant) -> Option<CaptureResult> {
        match self.frame {
            Some((previous, _)) if previous == hash && self.recognized => {
                Some(CaptureResult::Unchanged)
            }
            Some((previous, since))
                if previous == hash && now.duration_since(since) >= Duration::from_millis(200) =>
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
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
        "tessdata/jpn_vert.traineddata",
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
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |view| {
                let _ = sender.send(view.inner() as usize);
            })
            .map_err(|error| error.to_string())?;
        let native = receiver.await.map_err(|error| error.to_string())?;
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
    let blocks = recognize(runtime, &file.path, cancel).await?;
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

async fn recognize(
    runtime: &Path,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<TextBlock>, String> {
    let blocks = recognize_page(runtime, path, cancel, "3", "eng+jpn+jpn_vert").await?;
    let lines: Vec<_> = blocks.iter().flat_map(|block| &block.lines).collect();
    // Normal documents and vertical Japanese retain Tesseract's reading order.
    // Sparse layouts need a separate pass: page segmentation can interleave
    // neighbouring speech balloons, especially with small handwritten lettering.
    let small_uncertain = lines
        .iter()
        .any(|line| line.height < 18.0 && line.score() < 75.0);
    let mixed_columns = lines.iter().any(|line| line.max_gap > line.height * 2.5);
    if lines.iter().any(|line| line.vertical()) || !(small_uncertain || mixed_columns) {
        return Ok(blocks);
    }
    let image = image::open(path)
        .map_err(|_| "読み取り画像を開けません。")?
        .to_rgb8();
    let (width, height) = image.dimensions();
    let scale = (4096.0 / width.max(height) as f64).min(2.0);
    let file = CaptureFile::new()?;
    write_image(
        &file.path,
        image::imageops::resize(
            &image,
            (width as f64 * scale) as u32,
            (height as f64 * scale) as u32,
            image::imageops::FilterType::Triangle,
        ),
    )?;
    let sparse = recognize_page(runtime, &file.path, cancel, "11", "eng+jpn").await?;
    let mut groups = group_lines(sparse.into_iter().flat_map(|block| block.lines).collect());
    // Recognize each independent region as a paragraph. This avoids asking the
    // translator to repair text interleaved across unrelated balloons/columns.
    let mut result = Vec::new();
    for group in &mut groups {
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        group.sort_by(|a, b| a.center_y().total_cmp(&b.center_y()));
        let left = group
            .iter()
            .map(|line| line.x)
            .fold(f64::INFINITY, f64::min)
            / scale;
        let top = group
            .iter()
            .map(|line| line.y)
            .fold(f64::INFINITY, f64::min)
            / scale;
        let right = group.iter().map(OcrLine::right).fold(0.0, f64::max) / scale;
        let bottom = group.iter().map(OcrLine::bottom).fold(0.0, f64::max) / scale;
        let x = left.floor().max(0.0) as u32;
        let y = top.floor().max(0.0) as u32;
        let w = (right.ceil() as u32).min(width).saturating_sub(x);
        let h = (bottom.ceil() as u32).min(height).saturating_sub(y);
        if w == 0 || h == 0 {
            continue;
        }
        let crop = image::imageops::crop_imm(&image, x, y, w, h).to_image();
        let factor = (4000.0 / w.max(h) as f64).min(3.0);
        let enlarged = image::imageops::resize(
            &crop,
            (w as f64 * factor) as u32,
            (h as f64 * factor) as u32,
            image::imageops::FilterType::Triangle,
        );
        let mut padded = image::RgbImage::from_pixel(
            enlarged.width() + 20,
            enlarged.height() + 20,
            image::Rgb([255; 3]),
        );
        image::imageops::replace(&mut padded, &enlarged, 10, 10);
        write_image(&file.path, padded)?;
        let source: String = group
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let letters = source.chars().filter(|ch| ch.is_alphabetic()).count();
        let latin = source.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
        let language = if latin * 5 >= letters * 4 {
            "eng"
        } else {
            "jpn+eng"
        };
        let refined = recognize_page(runtime, &file.path, cancel, "6", language).await?;
        let text = refined
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if text.trim().is_empty() {
            continue;
        }
        result.push(TextBlock {
            text,
            x: x as f64 / width as f64,
            y: y as f64 / height as f64,
            width: w as f64 / width as f64,
            height: h as f64 / height as f64,
            regions: group
                .iter()
                .map(|line| line.region(width as f64 * scale, height as f64 * scale))
                .collect(),
            lines: Vec::new(),
        });
    }
    check_text_limit(&result)?;
    Ok(if result.is_empty() { blocks } else { result })
}

fn group_lines(mut lines: Vec<OcrLine>) -> Vec<Vec<OcrLine>> {
    lines.retain(|line| {
        line.text.chars().filter(|ch| ch.is_alphanumeric()).count() >= 2 && line.score() >= 35.0
    });
    if lines.is_empty() {
        return Vec::new();
    }
    let mut heights: Vec<_> = lines.iter().map(|line| line.height).collect();
    heights.sort_by(f64::total_cmp);
    let height = heights[heights.len() / 2];
    lines.retain(|line| line.height <= height * 2.2);
    // Join fragments on the same baseline, without crossing the gutter between columns.
    lines.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut i = 0;
    while i < lines.len() {
        let mut j = i + 1;
        while j < lines.len() {
            let a = &lines[i];
            let b = &lines[j];
            let overlap = a.bottom().min(b.bottom()) - a.y.max(b.y);
            let gap = b.x - a.right();
            if overlap >= a.height.min(b.height) * 0.6 && gap >= 0.0 && gap <= height * 1.5 {
                let b = lines.remove(j);
                let a = &mut lines[i];
                let right = a.right().max(b.right());
                let bottom = a.bottom().max(b.bottom());
                append_text(&mut a.text, &b.text, false);
                a.y = a.y.min(b.y);
                a.width = right - a.x;
                a.height = bottom - a.y;
                a.confidence += b.confidence;
                a.words += b.words;
            } else {
                j += 1;
            }
        }
        i += 1;
    }
    lines.sort_by(|a, b| {
        a.center_y()
            .total_cmp(&b.center_y())
            .then(a.x.total_cmp(&b.x))
    });
    let mut groups: Vec<Vec<OcrLine>> = Vec::new();
    for line in lines {
        let closest = groups
            .iter()
            .enumerate()
            .filter_map(|(index, group)| {
                let previous = group.last()?;
                let distance = line.center_y() - previous.center_y();
                let overlap = line.right().min(previous.right()) - line.x.max(previous.x);
                (distance > 0.0
                    && distance <= height * 1.8
                    && overlap >= line.width.min(previous.width) * 0.5)
                    .then_some((index, distance))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((index, _)) = closest {
            groups[index].push(line);
        } else {
            groups.push(vec![line]);
        }
    }
    groups
}

async fn recognize_page(
    runtime: &Path,
    path: &Path,
    cancel: &CancellationToken,
    segmentation: &str,
    language: &str,
) -> Result<Vec<TextBlock>, String> {
    use tokio::io::AsyncReadExt;
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    let mut child = tokio::process::Command::new(runtime.join("tesseract"))
        .arg(path)
        .arg("stdout")
        .arg("--tessdata-dir")
        .arg(runtime.join("tessdata"))
        .args(["-l", language, "--oem", "1", "--psm", segmentation])
        .args(["-c", "tessedit_create_tsv=1"])
        .env("OMP_THREAD_LIMIT", "2")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "文字認識エンジンを起動できません。アプリを再インストールしてください。")?;
    // TSV adds geometry and hierarchy to every word, in addition to UTF-8 text.
    let limit = crate::protocol::MAX_CHARACTERS * 256;
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
    parse_tsv(&text)
}

fn parse_tsv(tsv: &str) -> Result<Vec<TextBlock>, String> {
    let invalid = "文字認識の位置情報を取得できませんでした。";
    let mut size = None;
    let mut blocks: Vec<TextBlock> = Vec::new();
    let mut paragraph = None;
    let mut line = "";
    for row in tsv.lines().skip(1) {
        let fields: Vec<_> = row.splitn(12, '\t').collect();
        if fields.len() != 12 {
            return Err(invalid.into());
        }
        if !matches!(fields[0], "1" | "3" | "5") {
            continue;
        }
        let number = |index: usize| -> Result<f64, String> {
            fields[index]
                .parse::<u32>()
                .map(f64::from)
                .map_err(|_| invalid.into())
        };
        let (x, y, width, height) = (number(6)?, number(7)?, number(8)?, number(9)?);
        if fields[0] == "1" {
            if size.is_some() || width == 0.0 || height == 0.0 {
                return Err(invalid.into());
            }
            size = Some((width, height));
            continue;
        }
        let (page_width, page_height) = size.ok_or(invalid)?;
        if x + width > page_width || y + height > page_height {
            return Err(invalid.into());
        }
        let key = (fields[1], fields[2], fields[3]);
        if fields[0] == "3" {
            paragraph = Some(key);
            line = "";
            blocks.push(TextBlock {
                text: String::new(),
                x: x / page_width,
                y: y / page_height,
                width: width / page_width,
                height: height / page_height,
                regions: Vec::new(),
                lines: Vec::new(),
            });
        } else {
            if paragraph != Some(key) {
                return Err(invalid.into());
            }
            let block = blocks.last_mut().ok_or(invalid)?;
            let word = fields[11].trim();
            if word.is_empty() {
                continue;
            }
            if line != fields[4] {
                block.lines.push(OcrLine {
                    text: String::new(),
                    x,
                    y,
                    width,
                    height,
                    confidence: 0.0,
                    words: 0,
                    max_gap: 0.0,
                });
            }
            let row = block.lines.last_mut().ok_or(invalid)?;
            row.max_gap = row.max_gap.max(x - row.right());
            let right = row.right().max(x + width);
            let bottom = row.bottom().max(y + height);
            row.x = row.x.min(x);
            row.y = row.y.min(y);
            row.width = right - row.x;
            row.height = bottom - row.y;
            row.confidence += fields[10].parse::<f64>().unwrap_or(0.0).clamp(0.0, 100.0);
            row.words += 1;
            append_text(&mut row.text, word, false);
            append_text(&mut block.text, word, line != fields[4]);
            line = fields[4];
        }
    }
    let (width, height) = size.ok_or(invalid)?;
    for block in &mut blocks {
        block.regions = block
            .lines
            .iter()
            .map(|line| line.region(width, height))
            .collect();
    }
    blocks.retain(|block| !block.text.is_empty() && block.width > 0.0 && block.height > 0.0);
    check_text_limit(&blocks)?;
    Ok(blocks)
}

fn cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3000..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af | 0xff00..=0xffef | 0x20000..=0x323af)
}

fn append_text(text: &mut String, word: &str, wrapped: bool) {
    if let (Some(left), Some(right)) = (text.chars().last(), word.chars().next()) {
        if !cjk(left) && !cjk(right) && !(wrapped && left == '-') {
            text.push(' ');
        }
    }
    text.push_str(word);
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

    fn layout_tsv() -> String {
        concat!(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n",
            "1\t1\t0\t0\t0\t0\t0\t0\t1000\t800\t-1\t\n",
            "3\t1\t1\t1\t0\t0\t100\t80\t400\t60\t-1\t\n",
            "5\t1\t1\t1\t1\t1\t100\t80\t80\t20\t96\tHello\n",
            "5\t1\t1\t1\t2\t1\t100\t120\t80\t20\t96\tworld.\n",
            "3\t1\t2\t1\t0\t0\t600\t400\t300\t60\t-1\t\n",
            "5\t1\t2\t1\t1\t1\t600\t400\t40\t20\t96\t画像\n",
            "5\t1\t2\t1\t2\t1\t600\t440\t80\t20\t96\tの文字です。\n",
        ).into()
    }

    #[test]
    fn ocr_preserves_paragraph_positions_without_visual_line_breaks() {
        let blocks = parse_tsv(&layout_tsv()).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "Hello world.");
        assert_eq!(blocks[1].text, "画像の文字です。");
        assert_eq!(
            (blocks[0].x, blocks[0].y, blocks[0].width, blocks[0].height),
            (0.1, 0.1, 0.4, 0.075)
        );
        assert_eq!((blocks[1].x, blocks[1].y), (0.6, 0.5));
        let result = serde_json::to_value(CaptureResult::Text {
            text: "Hello world.\n\n画像の文字です。".into(),
            blocks,
        })
        .unwrap();
        assert_eq!(result["kind"], "text");
        assert_eq!(result["blocks"][1]["text"], "画像の文字です。");
        assert_eq!(
            result["blocks"][0]["regions"][1],
            serde_json::json!({"x": 0.1, "y": 0.15, "width": 0.08, "height": 0.025})
        );
    }

    #[test]
    fn ocr_rejects_invalid_geometry_and_oversized_text_but_accepts_empty_pages() {
        let tsv = layout_tsv();
        assert!(parse_tsv("").is_err());
        assert!(parse_tsv(&tsv.replace("1000\t800", "0\t800")).is_err());
        assert!(parse_tsv(&tsv.replace("600\t400\t300", "900\t400\t300")).is_err());
        assert!(parse_tsv(&tsv.replace("Hello", &"😀".repeat(6001)))
            .unwrap_err()
            .contains("多すぎ"));
        let page = tsv.lines().take(2).collect::<Vec<_>>().join("\n");
        assert!(parse_tsv(&page).unwrap().is_empty());
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
            watch.observe([1; 32], start + Duration::from_millis(199)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(200)),
            Some(CaptureResult::Changed)
        ));
        assert!(matches!(
            watch.observe([2; 32], start + Duration::from_millis(399)),
            Some(CaptureResult::Changed)
        ));
        assert!(watch
            .observe([2; 32], start + Duration::from_millis(400))
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
            let text = recognize(&runtime, &file.path, &CancellationToken::new())
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
