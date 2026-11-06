use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub const UNAVAILABLE: &str = "この環境ではショートカットを変更できません。";
const SAVE_ERROR: &str = "ショートカットを保存できませんでした。";

pub fn default() -> Shortcut {
    let modifier = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::KeyJ)
}

pub fn parse(value: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = value
        .trim()
        .parse()
        .map_err(|_| "キーの組み合わせを確認してください。")?;
    let function_key = matches!(
        shortcut.key,
        Code::F1
            | Code::F2
            | Code::F3
            | Code::F4
            | Code::F5
            | Code::F6
            | Code::F7
            | Code::F8
            | Code::F9
            | Code::F10
            | Code::F11
            | Code::F12
            | Code::F13
            | Code::F14
            | Code::F15
            | Code::F16
            | Code::F17
            | Code::F18
            | Code::F19
            | Code::F20
            | Code::F21
            | Code::F22
            | Code::F23
            | Code::F24
    );
    if !function_key
        && !shortcut
            .mods
            .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
    {
        return Err("Ctrl・Alt・Command/Superのいずれかを組み合わせてください。".into());
    }
    Ok(shortcut)
}

pub fn label(shortcut: Shortcut) -> String {
    let mut parts = Vec::new();
    for (modifier, name) in [
        (Modifiers::CONTROL, "Ctrl"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Super"),
    ] {
        if shortcut.mods.contains(modifier) {
            parts.push(name.to_owned());
        }
    }
    parts.push(shortcut.key.to_string());
    parts.join("+")
}

#[derive(Serialize, Deserialize)]
struct Settings {
    shortcut: String,
}

pub fn load(path: &Path) -> Shortcut {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .and_then(|settings| parse(&settings.shortcut).ok())
        .unwrap_or_else(default)
}

pub struct PendingSave {
    temporary: PathBuf,
    destination: PathBuf,
}

impl PendingSave {
    pub fn new(path: &Path, shortcut: Shortcut) -> Result<Self, String> {
        let directory = path.parent().ok_or(SAVE_ERROR)?;
        fs::create_dir_all(directory).map_err(|_| SAVE_ERROR)?;
        let pending = Self {
            temporary: directory.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4())),
            destination: path.to_owned(),
        };
        let bytes = serde_json::to_vec(&Settings {
            shortcut: label(shortcut),
        })
        .map_err(|_| SAVE_ERROR)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending.temporary)
            .map_err(|_| SAVE_ERROR)?;
        file.write_all(&bytes).map_err(|_| SAVE_ERROR)?;
        file.sync_all().map_err(|_| SAVE_ERROR)?;
        Ok(pending)
    }

    pub fn commit(self) -> Result<(), String> {
        fs::rename(&self.temporary, &self.destination).map_err(|_| SAVE_ERROR.into())
    }
}

impl Drop for PendingSave {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
    }
}

pub struct State {
    pub binding: Shortcut,
    pub available: bool,
    pub supported: bool,
}

impl State {
    pub fn change(
        &mut self,
        next: Shortcut,
        mut register: impl FnMut(Shortcut) -> Result<(), ()>,
        mut unregister: impl FnMut(Shortcut) -> Result<(), ()>,
        save: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.supported {
            return Err(UNAVAILABLE.into());
        }
        if next == self.binding && self.available {
            return Ok(());
        }
        register(next).map_err(|_| "このキーは使用できません。別の組み合わせを選んでください。")?;
        let remove_previous = self.available && next != self.binding;
        if remove_previous && unregister(self.binding).is_err() {
            let _ = unregister(next);
            return Err("前のショートカットを解除できませんでした。".into());
        }
        if let Err(error) = save() {
            if remove_previous {
                self.available = register(self.binding).is_ok();
            }
            let _ = unregister(next);
            return Err(error);
        }
        self.binding = next;
        self.available = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashSet};

    #[test]
    fn validation_preserves_typing_keys_and_accepts_standard_combinations() {
        for invalid in [
            "",
            "J",
            "Shift+J",
            "Enter",
            "Shift+Space",
            "Ctrl",
            "Ctrl+J+K",
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
        for valid in [
            "Ctrl+Alt+KeyT",
            "Super+Shift+Digit1",
            "Alt+ArrowUp",
            "F1",
            "Shift+F24",
        ] {
            let shortcut = parse(valid).unwrap();
            assert_eq!(parse(&label(shortcut)).unwrap(), shortcut);
        }
        assert_eq!(label(parse("shift+control+j").unwrap()), "Ctrl+Shift+KeyJ");
    }

    #[test]
    fn settings_are_atomic_and_invalid_saved_keys_use_default() {
        let directory =
            std::env::temp_dir().join(format!("plamo-shortcut-{}", uuid::Uuid::new_v4()));
        let path = directory.join("settings.json");
        assert_eq!(load(&path), default());
        let binding = parse("Ctrl+Alt+KeyT").unwrap();
        let pending = PendingSave::new(&path, binding).unwrap();
        assert!(!path.exists());
        pending.commit().unwrap();
        assert_eq!(load(&path), binding);
        drop(PendingSave::new(&path, default()).unwrap());
        assert_eq!(load(&path), binding);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::write(&path, r#"{"shortcut":"J"}"#).unwrap();
        assert_eq!(load(&path), default());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn changes_register_before_removing_previous_and_can_retry_a_startup_conflict() {
        let previous = default();
        let next = parse("Alt+KeyT").unwrap();
        let events = RefCell::new(Vec::new());
        let mut state = State {
            binding: previous,
            available: true,
            supported: true,
        };
        state
            .change(
                next,
                |key| {
                    events.borrow_mut().push(("register", key));
                    Ok(())
                },
                |key| {
                    events.borrow_mut().push(("unregister", key));
                    Ok(())
                },
                || {
                    events.borrow_mut().push(("save", next));
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            *events.borrow(),
            vec![("register", next), ("unregister", previous), ("save", next)]
        );
        assert_eq!(state.binding, next);
        state.available = false;
        events.borrow_mut().clear();
        state
            .change(
                next,
                |key| {
                    events.borrow_mut().push(("register", key));
                    Ok(())
                },
                |_| panic!("no old registration"),
                || Ok(()),
            )
            .unwrap();
        assert!(state.available);
        assert_eq!(*events.borrow(), vec![("register", next)]);
    }

    #[test]
    fn failed_changes_retain_the_previous_binding_and_settings() {
        for failure in ["register", "unregister", "save"] {
            let previous = default();
            let next = parse("Alt+KeyT").unwrap();
            let bindings = RefCell::new(HashSet::from([previous]));
            let saved = RefCell::new(previous);
            let mut state = State {
                binding: previous,
                available: true,
                supported: true,
            };
            assert!(state
                .change(
                    next,
                    |key| {
                        if failure == "register" && key == next {
                            return Err(());
                        }
                        bindings.borrow_mut().insert(key);
                        Ok(())
                    },
                    |key| {
                        if failure == "unregister" && key == previous {
                            return Err(());
                        }
                        bindings.borrow_mut().remove(&key);
                        Ok(())
                    },
                    || {
                        if failure == "save" {
                            return Err(SAVE_ERROR.into());
                        }
                        *saved.borrow_mut() = next;
                        Ok(())
                    }
                )
                .is_err());
            assert_eq!(state.binding, previous, "{failure}");
            assert!(state.available, "{failure}");
            assert_eq!(*saved.borrow(), previous, "{failure}");
            assert_eq!(*bindings.borrow(), HashSet::from([previous]), "{failure}");
        }
    }
}
