//! PLaMo translation logic that does not depend on the desktop or mobile runtime.

pub mod dictionary;
pub mod engine;
pub mod model;
pub mod protocol;
pub mod translation_cache;

use serde::Serialize;

/// Progress shared by model downloads and streaming translations.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressEvent {
    Download { received: u64, total: u64 },
    Verifying,
    Loading,
    Reading,
    Token { text: String },
}

/// Receives progress; an error means the receiver is gone and the work should stop.
pub type Progress<'a> = &'a (dyn Fn(ProgressEvent) -> Result<(), ()> + Send + Sync);
