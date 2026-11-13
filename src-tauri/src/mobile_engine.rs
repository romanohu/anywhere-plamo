use crate::{protocol, ProgressEvent};
use std::{
    ffi::{c_char, c_void, CString},
    path::Path,
    ptr::NonNull,
};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

#[path = "translation_cache.rs"]
mod cache;

unsafe extern "C" {
    fn plamo_load(
        path: *const c_char,
        cancel: extern "C" fn(*mut c_void) -> bool,
        data: *mut c_void,
    ) -> *mut c_void;
    fn plamo_free(engine: *mut c_void);
    fn plamo_tokens(engine: *mut c_void, prompt: *const c_char, length: i32) -> i32;
    fn plamo_translate(
        engine: *mut c_void,
        prompt: *const c_char,
        length: i32,
        emit: extern "C" fn(*const u8, usize, *mut c_void) -> bool,
        cancel: extern "C" fn(*mut c_void) -> bool,
        data: *mut c_void,
    ) -> i32;
}

pub struct Engine {
    handle: NonNull<c_void>,
    cache: cache::TranslationCache,
}
// All access, including destruction, is serialized by AppState.engine.
unsafe impl Send for Engine {}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            plamo_free(self.handle.as_ptr());
        }
    }
}

#[derive(serde::Serialize)]
pub struct TranslationResult {
    pub truncated: bool,
}

struct Stream<'a> {
    cancel: &'a CancellationToken,
    channel: &'a Channel<ProgressEvent>,
    pending: Vec<u8>,
    output: String,
    failed: bool,
}

extern "C" fn cancelled(data: *mut c_void) -> bool {
    unsafe { &*data.cast::<CancellationToken>() }.is_cancelled()
}

extern "C" fn stream_cancelled(data: *mut c_void) -> bool {
    let stream = unsafe { &*data.cast::<Stream<'_>>() };
    stream.failed || stream.cancel.is_cancelled()
}

extern "C" fn emit(bytes: *const u8, length: usize, data: *mut c_void) -> bool {
    let stream = unsafe { &mut *data.cast::<Stream<'_>>() };
    if stream.cancel.is_cancelled() {
        return false;
    }
    stream
        .pending
        .extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
    let valid = match std::str::from_utf8(&stream.pending) {
        Ok(_) => stream.pending.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => {
            stream.failed = true;
            return false;
        }
    };
    if valid > 0 {
        let text = String::from_utf8(stream.pending[..valid].to_vec()).unwrap();
        stream.output.push_str(&text);
        stream.pending.drain(..valid);
        if stream.channel.send(ProgressEvent::Token { text }).is_err() {
            stream.failed = true;
            return false;
        }
    }
    true
}

impl Engine {
    pub fn start(model: &Path, cancel: &CancellationToken) -> Result<Self, String> {
        let path = CString::new(model.to_str().ok_or("モデルのパスが無効です。")?)
            .map_err(|_| "モデルのパスが無効です。")?;
        let pointer = unsafe {
            plamo_load(
                path.as_ptr(),
                cancelled,
                (cancel as *const CancellationToken).cast_mut().cast(),
            )
        };
        let handle = NonNull::new(pointer).ok_or_else(|| {
            if cancel.is_cancelled() {
                "CANCELLED"
            } else {
                "モデルを読み込めません。空きメモリを確認してください。"
            }
            .to_owned()
        })?;
        Ok(Self {
            handle,
            cache: cache::TranslationCache::default(),
        })
    }

    fn length(&self, prompt: &str) -> Result<usize, String> {
        let count = unsafe {
            plamo_tokens(
                self.handle.as_ptr(),
                prompt.as_ptr().cast(),
                prompt.len() as i32,
            )
        };
        if count <= 0 {
            return Err("原文の長さを確認できません。".into());
        }
        Ok(count as usize)
    }

    pub fn translate(
        &mut self,
        text: &str,
        target: &str,
        channel: &Channel<ProgressEvent>,
        cancel: &CancellationToken,
    ) -> Result<TranslationResult, String> {
        let prompt = protocol::prompt(text, target)?;
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        if let Some(text) = self.cache.get(text, target) {
            channel
                .send(ProgressEvent::Token { text })
                .map_err(|_| "画面との接続が切れました。")?;
            return Ok(TranslationResult { truncated: false });
        }
        let mut chunks = Vec::new();
        if self.length(&prompt)? <= protocol::MAX_INPUT_TOKENS {
            chunks.push((prompt, false));
        } else {
            for part in protocol::paragraphs(text) {
                match part {
                    protocol::Paragraph::Separator(value) => chunks.push((value.to_owned(), true)),
                    protocol::Paragraph::Text(value) => {
                        let prompt = protocol::prompt(value, target)?;
                        if self.length(&prompt)? > protocol::MAX_INPUT_TOKENS {
                            return Err(
                                "1段落が長すぎます。空行を入れて、さらに短い段落に分けてください。"
                                    .into(),
                            );
                        }
                        chunks.push((prompt, false));
                    }
                }
            }
        }
        let mut stream = Stream {
            cancel,
            channel,
            pending: Vec::new(),
            output: String::new(),
            failed: false,
        };
        for (chunk, separator) in chunks {
            let data = (&mut stream as *mut Stream<'_>).cast();
            let result = if separator {
                if emit(chunk.as_ptr(), chunk.len(), data) {
                    0
                } else {
                    2
                }
            } else {
                unsafe {
                    plamo_translate(
                        self.handle.as_ptr(),
                        chunk.as_ptr().cast(),
                        chunk.len() as i32,
                        emit,
                        stream_cancelled,
                        data,
                    )
                }
            };
            if cancel.is_cancelled() {
                return Err("CANCELLED".into());
            }
            if stream.failed || !stream.pending.is_empty() || result > 1 {
                return Err(
                    "訳文を生成できませんでした。文章を短くして再試行してください。".into(),
                );
            }
            if result == 1 {
                return Ok(TranslationResult { truncated: true });
            }
        }
        if !stream.output.trim().is_empty() {
            self.cache.insert(text, target, stream.output);
        }
        Ok(TranslationResult { truncated: false })
    }
}
