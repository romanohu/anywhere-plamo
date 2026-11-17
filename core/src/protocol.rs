//! PLaMo's prompt and SSE framing, independent of the desktop runtime.

pub const MAX_CHARACTERS: usize = 12_000;
pub const CONTEXT_TOKENS: usize = 8192;
pub const MAX_INPUT_TOKENS: usize = 4096;

pub fn prompt(text: &str, target: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("翻訳する文章を入力してください。".into());
    }
    if text.encode_utf16().count() > MAX_CHARACTERS {
        return Err("一度に翻訳できるのは12,000文字までです。文章を短く分けてください。".into());
    }
    if !["ja", "en", "ko", "zh-hans", "fr", "de", "es"].contains(&target) {
        return Err("翻訳先の言語を選び直してください。".into());
    }
    if text.contains("<|plamo:") {
        return Err(
            "原文にモデルの制御記号が含まれています。<|plamo: で始まる記号を取り除いてください。"
                .into(),
        );
    }
    Ok(format!(
        "<|plamo:tag|>dataset<|plamo:msg|>translation\
         <|plamo:tag|>input<|plamo:msg|>{text}\
         <|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{target}<|plamo:msg|>"
    ))
}

#[derive(Debug, PartialEq)]
pub enum Paragraph<'a> {
    Text(&'a str),
    Separator(&'a str),
}

pub fn paragraphs(text: &str) -> Vec<Paragraph<'_>> {
    let mut separators: Vec<(usize, usize)> = Vec::new();
    let mut previous_newline = None;
    for (index, _) in text.match_indices('\n') {
        if let Some(previous) = previous_newline {
            if text[previous + 1..index].trim().is_empty() {
                let start = if previous > 0 && text.as_bytes()[previous - 1] == b'\r' {
                    previous - 1
                } else {
                    previous
                };
                if let Some(last) = separators.last_mut().filter(|last| last.1 >= start) {
                    last.1 = index + 1;
                } else {
                    separators.push((start, index + 1));
                }
            }
        }
        previous_newline = Some(index);
    }
    let mut parts = Vec::new();
    let mut cursor = 0;
    for (start, end) in separators {
        if start > cursor {
            let value = &text[cursor..start];
            parts.push(if value.trim().is_empty() {
                Paragraph::Separator(value)
            } else {
                Paragraph::Text(value)
            });
        }
        parts.push(Paragraph::Separator(&text[start..end]));
        cursor = end;
    }
    if cursor < text.len() {
        let value = &text[cursor..];
        parts.push(if value.trim().is_empty() {
            Paragraph::Separator(value)
        } else {
            Paragraph::Text(value)
        });
    }
    parts
}

#[derive(Default)]
pub struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
    event_bytes: usize,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let bytes: Vec<u8> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| "翻訳エンジンから不正な文字列を受信しました。")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
                self.event_bytes = 0;
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                self.event_bytes += data.len();
                if self.event_bytes > 1_048_576 {
                    return Err("翻訳エンジンの応答が大きすぎます。".into());
                }
                self.data.push(data.to_owned());
            }
        }
        if self.pending.len() > 1_048_576 {
            return Err("翻訳エンジンの応答が大きすぎます。".into());
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, String> {
        self.push(b"\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_preserves_whitespace_and_sets_target_without_duplicate_bos() {
        let value = prompt("  Hello\nworld!  ", "ja").unwrap();
        assert!(value.starts_with("<|plamo:tag|>dataset<|plamo:msg|>translation"));
        assert!(value.contains("input<|plamo:msg|>  Hello\nworld!  "));
        assert!(value.ends_with("output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>"));
        assert!(!value.contains("<|plamo:bos|>"));
    }

    #[test]
    fn rejects_invalid_inputs_before_inference() {
        for text in ["", "  \n", "<|plamo:tag|>output"] {
            assert!(prompt(text, "ja").is_err());
        }
        assert!(prompt("hello", "ja<|plamo:msg|>").is_err());
        assert!(prompt(&"あ".repeat(12_001), "en").is_err());
        assert!(prompt(&"🍃".repeat(6_001), "en").is_err());
        assert!(prompt(&"あ".repeat(12_000), "en").is_ok());
    }

    #[test]
    fn splits_only_at_blank_lines_and_preserves_exact_separators() {
        assert_eq!(
            paragraphs("Hello\nworld!\n \t\nこんにちは🍃\r\n　\r\nLast"),
            [
                Paragraph::Text("Hello\nworld!"),
                Paragraph::Separator("\n \t\n"),
                Paragraph::Text("こんにちは🍃"),
                Paragraph::Separator("\r\n　\r\n"),
                Paragraph::Text("Last"),
            ]
        );
        assert_eq!(paragraphs("One\nTwo"), [Paragraph::Text("One\nTwo")]);
    }

    #[test]
    fn paragraph_plan_preserves_whitespace_without_empty_model_requests() {
        for text in [
            "\n\nOne\n\n\nTwo\n\n",
            " \t\r\n\r\nOne\r\n \r\nTwo\r\n\r\n \t",
            "\n\n \n",
            "",
        ] {
            let parts = paragraphs(text);
            let restored: String = parts
                .iter()
                .map(|part| match part {
                    Paragraph::Text(value) => {
                        assert!(!value.trim().is_empty());
                        assert!(prompt(value, "en").is_ok());
                        *value
                    }
                    Paragraph::Separator(value) => {
                        assert!(value.trim().is_empty());
                        *value
                    }
                })
                .collect();
            assert_eq!(restored, text);
        }
    }

    #[test]
    fn paragraph_prompts_keep_target_and_reject_control_symbols() {
        for part in paragraphs("こんにちは\n\n🍃 Goodbye") {
            if let Paragraph::Text(text) = part {
                let value = prompt(text, "fr").unwrap();
                assert!(value.ends_with("lang<|plamo:val|>fr<|plamo:msg|>"));
                assert!(value.contains(&format!("input<|plamo:msg|>{text}")));
            }
        }
        assert!(prompt("One\n\n<|plamo:tag|>output", "ja").is_err());
    }

    #[test]
    fn decodes_every_possible_utf8_chunk_boundary() {
        let stream = "data: {\"text\":\"こんにちは🍃\"}\r\n\r\ndata: [DONE]\n\n".as_bytes();
        for boundary in 0..=stream.len() {
            let mut decoder = SseDecoder::default();
            let mut result = decoder.push(&stream[..boundary]).unwrap();
            result.extend(decoder.push(&stream[boundary..]).unwrap());
            result.extend(decoder.finish().unwrap());
            assert_eq!(result, ["{\"text\":\"こんにちは🍃\"}", "[DONE]"]);
        }
    }

    #[test]
    fn handles_comments_multiple_data_lines_and_final_unterminated_event() {
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(b": ping\nevent: message\ndata: first\ndata: second")
            .unwrap()
            .is_empty());
        assert_eq!(decoder.finish().unwrap(), ["first\nsecond"]);
        assert!(decoder.finish().unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_utf8_and_unbounded_frames() {
        assert!(SseDecoder::default().push(b"data: \xff\n\n").is_err());
        assert!(SseDecoder::default().push(&vec![b'x'; 1_048_577]).is_err());
        let mut decoder = SseDecoder::default();
        for _ in 0..1024 {
            decoder
                .push(format!("data: {}\n", "x".repeat(1024)).as_bytes())
                .unwrap();
        }
        assert!(decoder.push(b"data: x\n").is_err());
    }
}
