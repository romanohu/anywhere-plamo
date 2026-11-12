"""Layout regressions; run with .runtime-build/ocr-venv/bin/python tests/ocr.test.py."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ocr_worker', ROOT / 'scripts/ocr-worker.py')
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


def line(text, box, size=14, vertical=False):
    return dict(text=text, box=box, size=size, vertical=vertical)


class LayoutTests(unittest.TestCase):
    def test_expanded_detector_boxes_do_not_make_ruby_as_tall_as_body(self):
        image = ocr.cv2.imread(str(ROOT / 'tests/fixtures/ocr-ruby-narrow.png'))
        boxes = [[305, 3, 419, 29], [73, 20, 525, 46]]
        geometry = ocr.ink_geometry(image, boxes)
        lines = [line(text, box, size, vertical) for text, (box, size, vertical)
                 in zip(['げにんらしょうもん', 'ある日の暮方の事である。一人の下人が羅生門の下で雨やみを'], geometry)]
        self.assertEqual(ocr.remove_ruby(lines), [lines[1]])
        self.assertLess(lines[0]['box'][3], lines[1]['box'][1])

    def test_same_size_kana_and_smaller_caption_below_body_are_preserved(self):
        body = line('本文の漢字を読みます。', [10, 30, 210, 44])
        heading = line('これはみだしです', [10, 10, 150, 24])
        caption = line('小さな脚注', [10, 60, 70, 68], 8)
        self.assertEqual(ocr.remove_ruby([heading, body, caption]), [heading, body, caption])

    def test_ruby_misread_as_latin_is_still_removed_by_position_and_size(self):
        body = line('本文の漢字を読みます。', [10, 30, 210, 44])
        ruby = line('LU', [40, 17, 54, 25], 8)
        self.assertEqual(ocr.remove_ruby([ruby, body]), [body])

    def test_vertical_ruby_is_removed_without_erasing_the_adjacent_body_column(self):
        right = line('日本語を翻訳します', [80, 10, 100, 200], 20, True)
        left = line('本文を読みます', [40, 10, 60, 170], 20, True)
        ruby = line('にほんご', [104, 10, 112, 42], 8, True)
        self.assertEqual(ocr.remove_ruby([right, left, ruby]), [right, left])
        self.assertEqual(ocr.group_lines([right, left]), [[right, left]])

    def test_prose_keeps_indentation_and_joins_wrapped_lines(self):
        lines = [line('一つ目の段落に書かれている文章です。', [26, 10, 600, 24]),
                 line('二つ目の段落の文章がここから始まります。', [26, 50, 600, 64]),
                 line('途中で折り返しても同じ段落として読みます。', [10, 90, 600, 104])]
        self.assertEqual(ocr.group_lines(lines), [[lines[0]], lines[1:]])

    def test_balloons_share_a_reading_row_but_separate_speakers(self):
        lines = [line('LEFT START', [10, 18, 110, 28], 8), line('LEFT END', [10, 32, 110, 42], 8),
                 line('RIGHT START', [210, 14, 310, 24], 8), line('RIGHT END', [210, 28, 310, 38], 8),
                 line('NEW SPEAKER', [210, 52, 310, 62], 8)]
        self.assertEqual(ocr.group_lines(lines), [lines[:2], lines[2:4], [lines[4]]])

    def test_spaces_between_english_lines_and_no_spaces_between_japanese_lines(self):
        self.assertEqual(ocr.join_text('A sentence', 'continues.'), 'A sentence continues.')
        self.assertEqual(ocr.join_text('文章の', '続き。'), '文章の続き。')

    def test_network_connections_are_disabled(self):
        with self.assertRaises(RuntimeError):
            ocr.socket.create_connection(('example.com', 443))
        with self.assertRaises(RuntimeError):
            ocr.socket.getaddrinfo('example.com', 443)

    def test_korean_selection_preserves_confident_japanese_and_english(self):
        self.assertTrue(ocr.prefer_korean('', 0., '안녕하세요', .99))
        self.assertTrue(ocr.prefer_korean('WiFi', .99, 'WiFi 비밀번호를 입력하세요', .98))
        self.assertFalse(ocr.prefer_korean('日本語の文章です。', .99, '한국어', .96))
        self.assertFalse(ocr.prefer_korean('Read this text.', .98, 'Read this text.', .99))
        self.assertFalse(ocr.prefer_korean('本文', .6, '한국어', .7))
        self.assertEqual(ocr.join_text('한국어 문장을', '번역합니다.'), '한국어 문장을 번역합니다.')


if __name__ == '__main__':
    unittest.main()
