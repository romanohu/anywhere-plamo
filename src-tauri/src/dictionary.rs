//! A user glossary whose terms are replaced before translation, independent
//! of the desktop runtime.

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const SAVE_ERROR: &str = "辞書を保存できませんでした。";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub term: String,
    pub replacement: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

pub fn load(path: &Path) -> Vec<Entry> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Entry>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.term.is_empty())
        .collect()
}

pub struct PendingSave {
    temporary: PathBuf,
    destination: PathBuf,
}

impl PendingSave {
    pub fn new(path: &Path, entries: &[Entry]) -> Result<Self, String> {
        let directory = path.parent().ok_or(SAVE_ERROR)?;
        fs::create_dir_all(directory).map_err(|_| SAVE_ERROR)?;
        let pending = Self {
            temporary: directory.join(format!(".dictionary-{}.tmp", uuid::Uuid::new_v4())),
            destination: path.to_owned(),
        };
        let bytes = serde_json::to_vec(entries).map_err(|_| SAVE_ERROR)?;
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

/// Apply the enabled entries to the source text. Longer terms win when
/// several match at the same position, and alphanumerical terms only match
/// on word boundaries so "cat" never rewrites "category".
pub fn apply(text: &str, entries: &[Entry]) -> String {
    let mut terms: Vec<&Entry> = entries
        .iter()
        .filter(|entry| entry.enabled && !entry.term.is_empty())
        .collect();
    terms.sort_by_key(|entry| std::cmp::Reverse(entry.term.chars().count()));
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let Some((offset, character)) = text[cursor..].char_indices().next() else {
            break;
        };
        let position = cursor + offset;
        match terms.iter().find(|entry| matches(position, entry, text)) {
            Some(entry) => {
                result.push_str(&entry.replacement);
                cursor = position + entry.term.len();
            }
            None => {
                result.push(character);
                cursor = position + character.len_utf8();
            }
        }
    }
    result
}

fn matches(position: usize, entry: &Entry, text: &str) -> bool {
    if !text[position..].starts_with(entry.term.as_str()) {
        return false;
    }
    // An alphanumerical edge requires a non-word neighbour, so CJK text
    // without spaces still replaces while English words stay intact.
    let starts_word = entry.term.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let ends_word = entry
        .term
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    let previous_word = text[..position]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    let next_word = text[position + entry.term.len()..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    (!starts_word || !previous_word) && (!ends_word || !next_word)
}

#[cfg(test)]
mod tests {
    use super::{apply, load, Entry, PendingSave};
    use std::fs;

    fn entry(term: &str, replacement: &str) -> Entry {
        Entry {
            term: term.into(),
            replacement: replacement.into(),
            enabled: true,
        }
    }

    #[test]
    fn registered_terms_are_replaced_and_longer_terms_win() {
        let entries = [entry("dragon", "りゅう"), entry("a dragon", "りゅうきち")];
        assert_eq!(apply("a dragon and a cat", &entries), "りゅうきち and a cat");
        let entries = [entry("New York", "ニューヨーク"), entry("New York City", "NYC")];
        assert_eq!(apply("New York City", &entries), "NYC");
        assert_eq!(apply("New York State", &entries), "ニューヨーク State");
    }

    #[test]
    fn alphanumerical_terms_respect_word_boundaries_but_cjk_does_not() {
        let entries = [entry("cat", "ねこ")];
        assert_eq!(apply("a cat, category cats", &entries), "a ねこ, category cats");
        assert_eq!(apply("キャットcatとdog", &entries), "キャットねことdog");
        let entries = [entry("PLaMo", "プラモ")];
        assert_eq!(apply("(PLaMo)です", &entries), "(プラモ)です");
    }

    #[test]
    fn disabled_or_empty_entries_are_ignored() {
        let entries = [
            Entry {
                enabled: false,
                ..entry("dragon", "りゅう")
            },
            entry("", "空"),
        ];
        assert_eq!(apply("a dragon", &entries), "a dragon");
    }

    #[test]
    fn replacements_are_not_rescanned_as_dictionary_terms() {
        let entries = [entry("りゅう", "dragon"), entry("dragon", "りゅう")];
        assert_eq!(apply("りゅうとdragon", &entries), "dragonとりゅう");
    }

    #[test]
    fn the_dictionary_is_atomic_and_survives_a_roundtrip() {
        let directory =
            std::env::temp_dir().join(format!("plamo-dictionary-{}", uuid::Uuid::new_v4()));
        let path = directory.join("dictionary.json");
        assert!(load(&path).is_empty());
        let entries = vec![entry("dragon", "りゅう"), entry("PLaMo", "プラモ")];
        let pending = PendingSave::new(&path, &entries).unwrap();
        assert!(!path.exists());
        pending.commit().unwrap();
        assert_eq!(load(&path), entries);
        drop(PendingSave::new(&path, &[]).unwrap());
        assert_eq!(load(&path), entries);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::write(&path, "not json").unwrap();
        assert!(load(&path).is_empty());
        fs::remove_dir_all(&directory).unwrap();
    }
}
