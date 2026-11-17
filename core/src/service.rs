use crate::{
    dictionary,
    engine::{Engine, TranslationResult},
    protocol,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::sync::{Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

pub struct Settings<'a> {
    pub binary: &'a Path,
    pub model: &'a Path,
    pub target: &'a str,
    pub dictionary: &'a [dictionary::Entry],
}

pub enum Event {
    Loading,
    Token(String),
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchEvent {
    Started {
        index: usize,
    },
    Loading {
        index: usize,
    },
    Token {
        index: usize,
        text: String,
    },
    Finished {
        index: usize,
        text: String,
        truncated: bool,
    },
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchOptions {
    pub document: bool,
    pub continue_on_truncation: bool,
}

struct Loaded {
    binary: PathBuf,
    model: PathBuf,
    engine: Engine,
}

#[derive(Default)]
pub struct Service {
    engine: Mutex<Option<Loaded>>,
}

impl Service {
    async fn lock(
        &self,
        cancel: &CancellationToken,
    ) -> Result<MutexGuard<'_, Option<Loaded>>, String> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED".into()),
            engine = self.engine.lock() => Ok(engine),
        }
    }

    async fn load<'a>(
        slot: &'a mut Option<Loaded>,
        binary: &Path,
        model: &Path,
        cancel: &CancellationToken,
        emit: &mut (dyn FnMut(Event) -> Result<(), String> + Send),
    ) -> Result<&'a mut Engine, String> {
        if !slot.as_mut().is_some_and(|loaded| {
            loaded.binary == binary && loaded.model == model && loaded.engine.alive()
        }) {
            *slot = None;
            emit(Event::Loading)?;
            let engine = Engine::start(binary, model, cancel).await?;
            *slot = Some(Loaded {
                binary: binary.into(),
                model: model.into(),
                engine,
            });
        }
        Ok(&mut slot.as_mut().unwrap().engine)
    }

    pub async fn prepare(
        &self,
        binary: &Path,
        model: &Path,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let mut slot = self.lock(cancel).await?;
        Self::load(&mut slot, binary, model, cancel, &mut |_| Ok(())).await?;
        Ok(())
    }

    pub async fn stop(&self) {
        *self.engine.lock().await = None;
    }

    // Keep model selection and cache invalidation atomic with respect to inference.
    // A failed settings write leaves the existing model usable.
    pub fn try_reset(&self, update: impl FnOnce() -> Result<bool, String>) -> Result<(), String> {
        let mut slot = self
            .engine
            .try_lock()
            .map_err(|_| "翻訳・モデルの準備が終わってから切り替えてください。")?;
        if update()? {
            *slot = None;
        }
        Ok(())
    }

    pub async fn translate(
        &self,
        settings: &Settings<'_>,
        text: &str,
        emit: &mut (dyn FnMut(Event) -> Result<(), String> + Send),
        cancel: &CancellationToken,
    ) -> Result<TranslationResult, String> {
        let text = dictionary::apply(text, settings.dictionary);
        protocol::prompt(&text, settings.target)?;
        let mut slot = self.lock(cancel).await?;
        let engine = Self::load(&mut slot, settings.binary, settings.model, cancel, emit).await?;
        engine
            .translate(
                &text,
                settings.target,
                &mut |text| emit(Event::Token(text)),
                cancel,
            )
            .await
    }

    pub async fn translate_many(
        &self,
        settings: &Settings<'_>,
        texts: &[String],
        options: &BatchOptions,
        emit: &mut (dyn FnMut(BatchEvent) -> Result<(), String> + Send),
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if texts.len() > 2048
            || texts
                .iter()
                .map(|text| text.encode_utf16().count())
                .sum::<usize>()
                > 100_000
        {
            return Err("文字が多すぎます。読み取る範囲を小さくしてください。".into());
        }
        // Validate every input before producing any partial results.
        let chunks: Vec<Vec<String>> = texts
            .iter()
            .map(|text| {
                if options.document {
                    split_document(text)
                } else {
                    vec![text.clone()]
                }
            })
            .collect();
        for parts in &chunks {
            if parts.is_empty() {
                return Err("翻訳する文章を入力してください。".into());
            }
            for part in parts {
                protocol::prompt(
                    &dictionary::apply(part, settings.dictionary),
                    settings.target,
                )?;
            }
        }
        for (index, parts) in chunks.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err("CANCELLED".into());
            }
            emit(BatchEvent::Started { index })?;
            let mut translated = Vec::new();
            let mut truncated = false;
            for part in parts {
                let mut output = String::new();
                let result = self
                    .translate(
                        settings,
                        part,
                        &mut |event| match event {
                            Event::Loading => emit(BatchEvent::Loading { index }),
                            Event::Token(text) => {
                                output.push_str(&text);
                                emit(BatchEvent::Token { index, text })
                            }
                        },
                        cancel,
                    )
                    .await?;
                if cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                if output.trim().is_empty() {
                    return Err("訳文を取得できませんでした。訳し直してください。".into());
                }
                truncated |= result.truncated;
                translated.push(if options.document {
                    output.trim().to_owned()
                } else {
                    output
                });
                if truncated {
                    break;
                }
            }
            emit(BatchEvent::Finished {
                index,
                text: translated.join("\n"),
                truncated,
            })?;
            if truncated && !options.continue_on_truncation {
                break;
            }
            // Each paragraph releases the shared engine, allowing other callers
            // (e.g. a shortcut during document translation) to take their turn.
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}

fn split_document(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut remaining = text.trim();
    while remaining.encode_utf16().count() > 2000 {
        let mut units = 0;
        let mut end = 0;
        let mut sentence = None;
        let mut space = None;
        for (index, ch) in remaining.char_indices() {
            units += ch.len_utf16();
            if units > 2000 {
                break;
            }
            end = index + ch.len_utf8();
            if units > 1000 {
                if ch == '\n' {
                    sentence = Some(index);
                }
                if "。！？.!?".contains(ch)
                    && remaining[end..]
                        .chars()
                        .next()
                        .is_some_and(char::is_whitespace)
                {
                    sentence = Some(end);
                }
                if ch == ' ' {
                    space = Some(index);
                }
            }
        }
        end = sentence.or(space).unwrap_or(end);
        chunks.push(remaining[..end].trim().to_owned());
        remaining = remaining[end..].trim_start();
    }
    if !remaining.is_empty() {
        chunks.push(remaining.to_owned());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_a_wait_does_not_cancel_the_owner_or_other_requests() {
        let service = Service::default();
        let owner = service.engine.lock().await;
        let cancel = CancellationToken::new();
        let waiting = service.lock(&cancel);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("must wait"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {}
        }
        assert!(service
            .try_reset(|| panic!("must not change selection while busy"))
            .is_err());
        cancel.cancel();
        assert_eq!(waiting.await.err().as_deref(), Some("CANCELLED"));
        drop(owner);
        assert!(service.lock(&CancellationToken::new()).await.is_ok());
    }

    #[test]
    fn document_chunks_preserve_unicode_and_bound_input() {
        let text = "This is a sentence. ".repeat(400) + &"😀".repeat(2000);
        let parts = split_document(&text);
        assert!(parts.len() > 3);
        assert!(parts.iter().all(|text| text.encode_utf16().count() <= 2000));
        let compact = |text: &str| {
            text.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
        };
        assert_eq!(compact(&parts.concat()), compact(&text));
    }

    #[tokio::test]
    async fn invalid_later_blocks_and_cancelled_jobs_never_start_inference() {
        let service = Service::default();
        let settings = Settings {
            binary: Path::new("missing-runtime"),
            model: Path::new("missing-model"),
            target: "ja",
            dictionary: &[],
        };
        let cancel = CancellationToken::new();
        let error = service
            .translate_many(
                &settings,
                &["Hello".into(), "<|plamo:tag|>".into()],
                &BatchOptions::default(),
                &mut |_| panic!("must validate the complete batch first"),
                &cancel,
            )
            .await
            .unwrap_err();
        assert!(error.contains("制御記号"));
        cancel.cancel();
        assert_eq!(
            service
                .translate_many(
                    &settings,
                    &["Hello".into()],
                    &BatchOptions::default(),
                    &mut |_| panic!("must not emit after cancellation"),
                    &cancel
                )
                .await
                .unwrap_err(),
            "CANCELLED"
        );
    }

    #[tokio::test]
    async fn progress_receiver_failure_stops_before_loading() {
        let service = Service::default();
        let settings = Settings {
            binary: Path::new("missing-runtime"),
            model: Path::new("missing-model"),
            target: "ja",
            dictionary: &[],
        };
        let result = service
            .translate(
                &settings,
                "Hello",
                &mut |_| Err("receiver closed".into()),
                &CancellationToken::new(),
            )
            .await;
        assert_eq!(result.err().as_deref(), Some("receiver closed"));
        assert!(service.engine.lock().await.is_none());
    }
}
