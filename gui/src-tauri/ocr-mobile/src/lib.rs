use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Wry,
};

pub struct Ocr(PluginHandle<Wry>);

impl Ocr {
    pub async fn recognize(&self, path: &str, korean: Option<&str>) -> Result<serde_json::Value, String> {
        let result: serde_json::Value = self
            .0
            .run_mobile_plugin_async(
                "recognize",
                serde_json::json!({ "path": path, "korean": korean }),
            )
            .await
            .map_err(|error| error.to_string())?;
        result
            .get("blocks")
            .filter(|blocks| blocks.is_array())
            .cloned()
            .ok_or_else(|| "文字認識の結果を取得できません。".into())
    }

    pub async fn cancel(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<()>("cancel", ())
            .await
            .map_err(|error| error.to_string())
    }

    pub fn release(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("release", ())
            .map_err(|error| error.to_string())
    }

    pub fn open_license(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("openLicense", ())
            .map_err(|error| error.to_string())
    }

    pub async fn screen(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        self.0
            .run_mobile_plugin_async(command, args)
            .await
            .map_err(|error| error.to_string())
    }
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("plamo-ocr")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.plamo.ocr", "OcrPlugin")?;
            app.manage(Ocr(handle));
            Ok(())
        })
        .build()
}
