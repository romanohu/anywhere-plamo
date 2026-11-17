//! GUI-independent desktop translation. The caller owns model files and supplies
//! cancellation tokens and fallible progress callbacks; no window or IPC types.
mod cache;
pub mod dictionary;
pub mod engine;
pub mod protocol;
mod service;

pub use service::{BatchEvent, BatchOptions, Event, Service, Settings};
