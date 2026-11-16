use std::collections::VecDeque;

// Session-only, shared by all windows. Bound both entry count and UTF-8 bytes.
#[derive(Default)]
pub struct TranslationCache(pub VecDeque<(String, String, String)>);

impl TranslationCache {
    pub fn get(&mut self, text: &str, target: &str) -> Option<String> {
        let index = self
            .0
            .iter()
            .position(|(source, language, _)| source == text && language == target)?;
        let entry = self.0.remove(index)?;
        let output = entry.2.clone();
        self.0.push_back(entry);
        Some(output)
    }

    pub fn insert(&mut self, text: &str, target: &str, output: String) {
        self.0.push_back((text.into(), target.into(), output));
        let mut bytes: usize = self
            .0
            .iter()
            .map(|(s, t, o)| s.len() + t.len() + o.len())
            .sum();
        while self.0.len() > 128 || bytes > 2 * 1024 * 1024 {
            if let Some((s, t, o)) = self.0.pop_front() {
                bytes -= s.len() + t.len() + o.len();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TranslationCache;

    #[test]
    fn translation_cache_separates_languages_and_bounds_memory() {
        let mut cache = TranslationCache::default();
        cache.insert("Hello", "ja", "こんにちは".into());
        cache.insert("Hello", "ko", "안녕하세요".into());
        assert_eq!(cache.get("Hello", "ja").as_deref(), Some("こんにちは"));
        assert!(cache.get("Hello", "en").is_none());
        assert!(cache.get("Hello!", "ja").is_none());
        for i in 0..127 {
            cache.insert(&i.to_string(), "ja", "訳文".into());
        }
        assert!(cache.get("Hello", "ko").is_none());
        assert!(cache.get("Hello", "ja").is_some());
        cache.insert("long", "ja", "x".repeat(2 * 1024 * 1024));
        assert!(cache.0.is_empty());
    }
}
