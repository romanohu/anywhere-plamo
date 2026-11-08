fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/lens.m");
        cc::Build::new()
            .file("src/lens.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-mmacosx-version-min=13.3")
            .compile("plamo_lens");
        for framework in [
            "AppKit",
            "ScreenCaptureKit",
            "Vision",
            "CoreMedia",
            "CoreVideo",
            "CoreGraphics",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
