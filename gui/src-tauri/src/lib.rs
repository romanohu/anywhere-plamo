#[cfg(not(target_os = "android"))]
include!("desktop.rs");

#[cfg(target_os = "android")]
include!("mobile.rs");
