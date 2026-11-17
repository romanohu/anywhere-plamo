use plamo_core::{dictionary::Entry, BatchEvent, BatchOptions, Event, Service, Settings};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

// Deliberately outside the desktop crate: this executes the same service used by
// the GUI, without Tauri, a WebView, a display server, or mocked inference.
#[tokio::test]
#[ignore = "requires PLAMO_RUNTIME and PLAMO_MODEL pointing to existing local files"]
async fn real_model_batch_cache_dictionary_and_cancellation() {
    let binary = PathBuf::from(std::env::var_os("PLAMO_RUNTIME").expect("PLAMO_RUNTIME"));
    let model = PathBuf::from(std::env::var_os("PLAMO_MODEL").expect("PLAMO_MODEL"));
    let service = Service::default();
    let settings = Settings {
        binary: &binary,
        model: &model,
        target: "ja",
        dictionary: &[],
    };
    let texts = vec![
        "The meeting starts at ten. Please bring the report.".into(),
        "Please close the door quietly.".into(),
    ];
    let mut events = Vec::new();
    service
        .translate_many(
            &settings,
            &texts,
            &BatchOptions::default(),
            &mut |event| {
                events.push(event);
                Ok(())
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, BatchEvent::Loading { .. }))
            .count(),
        1
    );
    let outputs: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            BatchEvent::Finished {
                index,
                text,
                truncated,
            } => {
                assert!(!truncated);
                Some((*index, text.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        outputs.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        [0, 1]
    );
    for (index, text) in &outputs {
        assert_ne!(text, &texts[*index]);
        assert!(text.chars().any(|c| ('ぁ'..='ん').contains(&c)));
        println!("block {index}: {text}");
    }

    let mut cached = Vec::new();
    service
        .translate(
            &settings,
            &texts[0],
            &mut |event| {
                if let Event::Token(text) = event {
                    cached.push(text);
                } else {
                    panic!("already loaded");
                }
                Ok(())
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(cached, [outputs[0].1.clone()]);
    let dictionary = [Entry {
        term: "CODEWORD".into(),
        replacement: texts[0].clone(),
        enabled: true,
    }];
    let with_dictionary = Settings {
        dictionary: &dictionary,
        ..settings
    };
    let mut rewritten = String::new();
    service
        .translate(
            &with_dictionary,
            "CODEWORD",
            &mut |event| {
                if let Event::Token(text) = event {
                    rewritten.push_str(&text);
                }
                Ok(())
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(rewritten, outputs[0].1);

    assert_eq!(
        service
            .try_reset(|| Err("settings write failed".into()))
            .unwrap_err(),
        "settings write failed"
    );
    service
        .translate(
            &settings,
            &texts[0],
            &mut |event| {
                match event {
                    Event::Loading => {
                        panic!("a failed selection write must preserve the loaded model")
                    }
                    Event::Token(text) => assert_eq!(text, outputs[0].1),
                }
                Ok(())
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    let cancel = CancellationToken::new();
    let mut starts = 0;
    let result = service
        .translate_many(
            &settings,
            &texts,
            &BatchOptions::default(),
            &mut |event| {
                if matches!(event, BatchEvent::Started { .. }) {
                    starts += 1;
                }
                if matches!(event, BatchEvent::Finished { index: 0, .. }) {
                    cancel.cancel();
                }
                Ok(())
            },
            &cancel,
        )
        .await;
    assert_eq!(result.unwrap_err(), "CANCELLED");
    assert_eq!(starts, 1);

    let cancel = CancellationToken::new();
    let mut partial = String::new();
    let result = service.translate(&settings, "The library will reopen on Monday after three weeks of renovation. Visitors can borrow books as usual, but the reading room will remain closed until Friday.", &mut |event| {
        if let Event::Token(text) = event { partial.push_str(&text); cancel.cancel(); }
        Ok(())
    }, &cancel).await;
    assert_eq!(result.err().as_deref(), Some("CANCELLED"));
    assert!(!partial.is_empty());
    service.try_reset(|| Ok(true)).unwrap();
    let mut loads = 0;
    service
        .translate(
            &settings,
            &texts[0],
            &mut |event| {
                if matches!(event, Event::Loading) {
                    loads += 1;
                }
                Ok(())
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(loads, 1);
    service.stop().await;
}
