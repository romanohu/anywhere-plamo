fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let target = std::env::var("TARGET").unwrap();
        let runtime = std::path::PathBuf::from("resources/android").join(&target);
        assert!(
            runtime.join("libllama.a").is_file(),
            "Run npm run android:prepare before building Android."
        );
        for model in ["PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx"] {
            assert!(
                std::path::Path::new("ocr-mobile/android/src/main/assets/ocr")
                    .join(model)
                    .is_file(),
                "Run npm run android:prepare before building Android."
            );
        }
        println!("cargo:rerun-if-changed=src/translation.cpp");
        println!("cargo:rerun-if-changed=resources/android");
        cc::Build::new()
            .cpp(true)
            .std("c++17")
            .cpp_link_stdlib("c++_static")
            .include("resources/android/include")
            .file("src/translation.cpp")
            .compile("plamo_translation");
        println!("cargo:rustc-link-search=native={}", runtime.display());
        for library in ["llama", "ggml", "ggml-cpu", "ggml-base"] {
            println!("cargo:rustc-link-lib=static={library}");
        }
        println!("cargo:rustc-link-lib=log");
        println!("cargo:rustc-link-lib=android");
        println!("cargo:rustc-link-lib=c++abi");
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
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
            "CoreMedia",
            "CoreVideo",
            "CoreGraphics",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
