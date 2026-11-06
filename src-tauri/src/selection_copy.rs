//! Copy fallback for apps whose accessibility tree omits selected PDF text.

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use objc2::{
    rc::{autoreleasepool, Retained},
    runtime::ProtocolObject,
};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSString};
use std::{
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
static COPYING: Mutex<()> = Mutex::new(());

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventPostToPid(pid: i32, event: CFTypeRef);
    fn CGEventSourceFlagsState(state: i32) -> u64;
}

struct Snapshot {
    generation: isize,
    items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>>,
}

impl Snapshot {
    fn read(board: &NSPasteboard) -> Result<Self, String> {
        let generation = board.changeCount();
        let mut saved = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items {
                let clone = NSPasteboardItem::new();
                for data_type in item.types() {
                    // Materialize every representation, including promised data.
                    // If even one is unavailable, leave the clipboard untouched.
                    let data = item
                        .dataForType(&data_type)
                        .ok_or_else(|| super::UNAVAILABLE.to_owned())?;
                    if !clone.setData_forType(&data, &data_type) {
                        return Err(super::UNAVAILABLE.into());
                    }
                }
                saved.push(ProtocolObject::from_retained(clone));
            }
        } else if board.types().is_some_and(|types| types.count() != 0) {
            return Err(super::UNAVAILABLE.into());
        }
        if board.changeCount() != generation {
            return Err(super::UNAVAILABLE.into());
        }
        Ok(Self {
            generation,
            items: saved,
        })
    }

    fn restore(&self, board: &NSPasteboard, copied_generation: isize) -> Result<(), String> {
        // Do not overwrite a later copy from the user or another application.
        // NSPasteboard has no atomic compare-and-write operation.
        if board.changeCount() != copied_generation {
            return Ok(());
        }
        let items = NSArray::from_retained_slice(&self.items);
        board.clearContents();
        if !self.items.is_empty() && !board.writeObjects(&items) {
            return Err(
                "クリップボードを元に戻せませんでした。必要な内容をもう一度コピーしてください。"
                    .into(),
            );
        }
        Ok(())
    }
}

fn capture(
    board: &NSPasteboard,
    copy: impl FnOnce() -> Result<(), String>,
    source_is_focused: impl Fn() -> bool,
    timeout: Duration,
) -> Result<String, String> {
    let saved = Snapshot::read(board)?;
    if !source_is_focused() || board.changeCount() != saved.generation {
        return Err(super::UNAVAILABLE.into());
    }
    copy()?;
    let deadline = Instant::now() + timeout;
    let mut copied_generation = None;
    let result = loop {
        // A first change after focus moved may be a real copy in another app.
        // Do not claim that generation and later restore over the user's data.
        if !source_is_focused() {
            break Err(super::UNAVAILABLE.into());
        }
        let generation = board.changeCount();
        if copied_generation.is_some_and(|copied| copied != generation) {
            break Err(super::UNAVAILABLE.into());
        }
        if generation != saved.generation {
            copied_generation = Some(generation);
            let text = board.stringForType(&NSString::from_str("public.utf8-plain-text"));
            if board.changeCount() != generation || !source_is_focused() {
                break Err(super::UNAVAILABLE.into());
            }
            if text.is_some_and(|text| !text.to_string().trim().is_empty()) {
                // Chromium supplies text, rich formats, and source metadata
                // sequentially under one ownership. Let that short write burst
                // finish before restoring, then verify the generation again.
                sleep(Duration::from_millis(40));
                if board.changeCount() != generation || !source_is_focused() {
                    break Err(super::UNAVAILABLE.into());
                }
                let text = board
                    .stringForType(&NSString::from_str("public.utf8-plain-text"))
                    .map(|text| text.to_string())
                    .filter(|text| !text.trim().is_empty());
                if board.changeCount() != generation {
                    break Err(super::UNAVAILABLE.into());
                }
                break text.ok_or_else(|| super::UNAVAILABLE.to_owned());
            }
            // Copy can clear the board before it supplies the text. Wait for
            // data in this generation, without accepting a later ownership.
        }
        if !source_is_focused() || Instant::now() >= deadline {
            break Err(super::UNAVAILABLE.into());
        }
        sleep(POLL_INTERVAL);
    };
    if let Some(generation) = copied_generation {
        saved.restore(board, generation)?;
    }
    result
}

pub fn read(source_pid: i32, source_is_focused: impl Fn() -> bool) -> Result<String, String> {
    let _copying = COPYING
        .try_lock()
        .map_err(|_| super::UNAVAILABLE.to_owned())?;
    if source_pid <= 0 {
        return Err(super::UNAVAILABLE.into());
    }
    // The shortcut fires on key-down. Do not send Command+C while its physical
    // modifiers are still held (Control, Option, Shift, Command, or Fn).
    let deadline = Instant::now() + Duration::from_secs(1);
    while unsafe { CGEventSourceFlagsState(1) } & 0x009e_0000 != 0 {
        if !source_is_focused() || Instant::now() >= deadline {
            return Err(super::UNAVAILABLE.into());
        }
        sleep(POLL_INTERVAL);
    }
    autoreleasepool(|_| {
        capture(
            &NSPasteboard::generalPasteboard(),
            || {
                // Allocate both events before posting either, so allocation
                // failure cannot leave a synthetic key-down without a key-up.
                let event = |down| {
                    let raw = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 8, down) };
                    if raw.is_null() {
                        return Err(super::UNAVAILABLE.to_owned());
                    }
                    Ok(unsafe { CFType::wrap_under_create_rule(raw) })
                };
                let down = event(true)?;
                let up = event(false)?;
                for event in [&down, &up] {
                    // ANSI C (8), with only the Command modifier. Target the
                    // original app instead of whichever app becomes active.
                    unsafe {
                        CGEventSetFlags(event.as_CFTypeRef(), 0x0010_0000);
                        CGEventPostToPid(source_pid, event.as_CFTypeRef());
                    }
                }
                Ok(())
            },
            source_is_focused,
            Duration::from_secs(1),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSData;

    fn write(board: &NSPasteboard, formats: &[&[(&str, &[u8])]]) {
        let items = formats
            .iter()
            .map(|formats| {
                let item = NSPasteboardItem::new();
                for (kind, data) in *formats {
                    assert!(
                        item.setData_forType(&NSData::with_bytes(data), &NSString::from_str(kind))
                    );
                }
                ProtocolObject::from_retained(item)
            })
            .collect::<Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>>>();
        board.clearContents();
        assert!(board.writeObjects(&NSArray::from_retained_slice(&items)));
    }

    fn text(board: &NSPasteboard) -> Option<String> {
        board
            .stringForType(&NSString::from_str("public.utf8-plain-text"))
            .map(|value| value.to_string())
    }

    #[test]
    fn unchanged_clipboard_is_never_a_selection() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old clipboard")]]);
            let generation = board.changeCount();
            assert!(capture(&board, || Ok(()), || true, Duration::ZERO).is_err());
            assert_eq!(text(&board).as_deref(), Some("old clipboard"));
            assert_eq!(board.changeCount(), generation);
        });
    }

    #[test]
    fn fresh_copy_restores_all_formats_and_items() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(
                &board,
                &[
                    &[
                        ("public.utf8-plain-text", b"old"),
                        ("public.html", b"<b>old</b>"),
                    ],
                    &[("public.png", b"\x89PNG\x00binary")],
                ],
            );
            assert_eq!(
                capture(
                    &board,
                    || {
                        write(&board, &[&[("public.utf8-plain-text", b"selected PDF")]]);
                        Ok(())
                    },
                    || true,
                    Duration::ZERO,
                ),
                Ok("selected PDF".into())
            );
            let items = board.pasteboardItems().unwrap();
            assert_eq!(items.count(), 2);
            assert_eq!(text(&board).as_deref(), Some("old"));
            assert_eq!(
                items
                    .objectAtIndex(0)
                    .dataForType(&NSString::from_str("public.html"))
                    .unwrap()
                    .to_vec(),
                b"<b>old</b>"
            );
            assert_eq!(
                items
                    .objectAtIndex(1)
                    .dataForType(&NSString::from_str("public.png"))
                    .unwrap()
                    .to_vec(),
                b"\x89PNG\x00binary"
            );
        });
    }

    #[test]
    fn failed_text_capture_still_restores_clipboard() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old")]]);
            assert!(capture(
                &board,
                || {
                    write(&board, &[&[("public.png", b"image")]]);
                    Ok(())
                },
                || true,
                Duration::ZERO,
            )
            .is_err());
            assert_eq!(text(&board).as_deref(), Some("old"));
        });
    }

    #[test]
    fn fresh_copy_can_equal_the_previous_clipboard() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"same text")]]);
            assert_eq!(
                capture(
                    &board,
                    || {
                        write(&board, &[&[("public.utf8-plain-text", b"same text")]]);
                        Ok(())
                    },
                    || true,
                    Duration::ZERO,
                ),
                Ok("same text".into())
            );
        });
    }

    #[test]
    fn a_focus_change_rejects_the_result_and_restores_clipboard() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old")]]);
            let checks = std::cell::Cell::new(0);
            assert!(capture(
                &board,
                || {
                    write(&board, &[&[("public.utf8-plain-text", b"selected PDF")]]);
                    Ok(())
                },
                || {
                    checks.set(checks.get() + 1);
                    // Lose focus after the new generation was observed.
                    checks.get() < 3
                },
                Duration::ZERO,
            )
            .is_err());
            assert_eq!(text(&board).as_deref(), Some("old"));
        });
    }

    #[test]
    fn a_copy_after_focus_moves_is_not_claimed_or_overwritten() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old")]]);
            let focused = std::cell::Cell::new(true);
            assert!(capture(
                &board,
                || {
                    focused.set(false);
                    write(&board, &[&[("public.utf8-plain-text", b"user copy")]]);
                    Ok(())
                },
                || focused.get(),
                Duration::ZERO,
            )
            .is_err());
            assert_eq!(text(&board).as_deref(), Some("user copy"));
        });
    }

    #[test]
    fn waits_for_text_written_after_copy_clears_the_board() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old")]]);
            let copied = std::cell::Cell::new(false);
            let polls = std::cell::Cell::new(0);
            assert_eq!(
                capture(
                    &board,
                    || {
                        board.clearContents();
                        copied.set(true);
                        Ok(())
                    },
                    || {
                        if copied.get() {
                            polls.set(polls.get() + 1);
                            // Supply data only after capture has already read
                            // the newly cleared clipboard without any text.
                            if polls.get() == 2 {
                                assert!(board.setString_forType(
                                    &NSString::from_str("selected PDF"),
                                    &NSString::from_str("public.utf8-plain-text"),
                                ));
                            }
                        }
                        true
                    },
                    Duration::from_secs(1),
                ),
                Ok("selected PDF".into())
            );
            assert_eq!(text(&board).as_deref(), Some("old"));
        });
    }

    #[test]
    fn restoration_does_not_overwrite_a_later_copy() {
        autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write(&board, &[&[("public.utf8-plain-text", b"old")]]);
            let saved = Snapshot::read(&board).unwrap();
            write(&board, &[&[("public.utf8-plain-text", b"selected PDF")]]);
            let copied_generation = board.changeCount();
            write(&board, &[&[("public.utf8-plain-text", b"later user copy")]]);
            saved.restore(&board, copied_generation).unwrap();
            assert_eq!(text(&board).as_deref(), Some("later user copy"));
        });
    }
}
