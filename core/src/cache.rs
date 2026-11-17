use std::collections::VecDeque;

// Session-only, shared by all windows. Bound both entry count and UTF-8 bytes.
#[derive(Default)]
pub(super) struct TranslationCache(pub(super) VecDeque<(String, String, String)>);

impl TranslationCache {
    pub(super) fn get(&mut self, text: &str, target: &str) -> Option<String> {
        let index = self
            .0
            .iter()
            .position(|(source, language, _)| source == text && language == target)?;
        let entry = self.0.remove(index)?;
        let output = entry.2.clone();
        self.0.push_back(entry);
        Some(output)
    }

    pub(super) fn insert(&mut self, text: &str, target: &str, output: String) {
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
