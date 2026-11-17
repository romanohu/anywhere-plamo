//! A user glossary passed to PLaMo alongside the source text, independent of
//! the desktop runtime.

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

/// The enabled entries that occur in the source text, as (term, replacement)
/// pairs for PLaMo's glossary. Longer terms win when several match at the same
/// position, and alphanumerical terms only match on word boundaries so "cat"
/// never matches "category".
pub fn glossary(text: &str, entries: &[Entry]) -> Vec<(String, String)> {
    // PLaMo's glossary needs a target term, so entries without one are skipped.
    let mut terms: Vec<&Entry> = entries
        .iter()
        .filter(|entry| entry.enabled && !entry.term.is_empty() && !entry.replacement.is_empty())
        .collect();
    terms.sort_by_key(|entry| std::cmp::Reverse(entry.term.chars().count()));
    let mut found: Vec<(String, String)> = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some((offset, character)) = text[cursor..].char_indices().next() else {
            break;
        };
        let position = cursor + offset;
        match terms.iter().find(|entry| matches(position, entry, text)) {
            Some(entry) => {
                if !found.iter().any(|(term, _)| *term == entry.term) {
                    found.push((entry.term.clone(), entry.replacement.clone()));
                }
                cursor = position + entry.term.len();
            }
            None => cursor = position + character.len_utf8(),
        }
    }
    found
}

fn matches(position: usize, entry: &Entry, text: &str) -> bool {
    if !text[position..].starts_with(entry.term.as_str()) {
        return false;
    }
    // An alphanumerical edge requires a non-word neighbour, so CJK text
    // without spaces still replaces while English words stay intact.
    let starts_word = entry
        .term
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
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
    use super::{glossary, load, Entry, PendingSave};
    use std::fs;

    fn entry(term: &str, replacement: &str) -> Entry {
        Entry {
            term: term.into(),
            replacement: replacement.into(),
            enabled: true,
        }
    }

    fn pairs(values: &[(&str, &str)]) -> Vec<(String, String)> {
        values
            .iter()
            .map(|(t, r)| (t.to_string(), r.to_string()))
            .collect()
    }

    #[test]
    fn terms_in_the_source_are_listed_once_and_longer_terms_win() {
        let entries = [entry("dragon", "りゅう"), entry("a dragon", "りゅうきち")];
        assert_eq!(
            glossary("a dragon and a cat", &entries),
            pairs(&[("a dragon", "りゅうきち")])
        );
        let entries = [
            entry("New York", "ニューヨーク"),
            entry("New York City", "NYC"),
        ];
        assert_eq!(
            glossary("New York City", &entries),
            pairs(&[("New York City", "NYC")])
        );
        assert_eq!(
            glossary("New York State, New York", &entries),
            pairs(&[("New York", "ニューヨーク")])
        );
        assert!(glossary("Tokyo", &entries).is_empty());
    }

    #[test]
    fn alphanumerical_terms_respect_word_boundaries_but_cjk_does_not() {
        let entries = [entry("cat", "ねこ")];
        assert!(glossary("category cats", &entries).is_empty());
        assert_eq!(
            glossary("キャットcatとdog", &entries),
            pairs(&[("cat", "ねこ")])
        );
        let entries = [entry("PLaMo", "プラモ")];
        assert_eq!(
            glossary("(PLaMo)です", &entries),
            pairs(&[("PLaMo", "プラモ")])
        );
    }

    #[test]
    fn disabled_or_empty_entries_are_ignored() {
        let entries = [
            Entry {
                enabled: false,
                ..entry("dragon", "りゅう")
            },
            entry("", "空"),
            entry("cat", ""),
        ];
        assert!(glossary("a dragon and a cat", &entries).is_empty());
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
