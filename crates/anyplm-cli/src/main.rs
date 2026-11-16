//! `plm`: PLaMo translation from the command line. It shares the Anywhere Plamo
//! app's models, dictionary and GPU detection, so both see the same setup.

use anyplm_core::{dictionary, engine, model, protocol, ProgressEvent};
use std::{
    io::{IsTerminal, Read, Write},
    path::PathBuf,
    process::ExitCode,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncBufReadExt;
use tokio_util::sync::CancellationToken;

const USAGE: &str = "使い方:
  plm [--to 言語] [--no-dict] [--server パス]
      対話モード。1 行入力するたびに訳す。:to <言語> / :auto / :help / :quit、Ctrl+D で終了
  plm -p [文章…] [--to 言語] [--no-dict] [--server パス]
      訳を出力して終了する。文章を省くと標準入力から読む
  plm desktop                アプリ（GUI）を起動する
  plm tui                    端末の全画面で使う（準備中）
  plm models                 モデルの一覧（* は選択中、✓ はダウンロード済み）
  plm models use <ID>        使うモデルを選ぶ（アプリと共通の設定）
  plm models download [ID]   モデルをダウンロードする（ID を省くと選択中のモデル）

  --to       翻訳先: ja, en, ko, zh-hans, fr, de, es。省くと日本語は英語へ、英語は日本語へ訳す
  --no-dict  アプリの辞書を使わない
  --server   llama-server の場所（既定では環境変数 ANYWHERE_PLAMO_LLAMA_SERVER、plm と同じフォルダの順に探す）";

const REPL_HELP: &str = "  :to <言語>  翻訳先を固定する（ja, en, ko, zh-hans, fr, de, es）
  :auto       翻訳先を自動判定に戻す
  :quit       終了する（Ctrl+D でも終了）
  翻訳中の Ctrl+C はその翻訳だけを止める";

enum Error {
    Usage(String),
    Failed(String),
    Cancelled,
}

fn usage(message: impl Into<String>) -> Error {
    Error::Usage(message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::Failed(message.into())
}

fn cancelled_or(error: String) -> Error {
    if error == "CANCELLED" {
        Error::Cancelled
    } else {
        Error::Failed(error)
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("plm: 実行環境を準備できません: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(&args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Usage(message)) => {
            eprintln!("plm: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Error::Failed(message)) => {
            eprintln!("plm: {message}");
            ExitCode::FAILURE
        }
        Err(Error::Cancelled) => {
            eprintln!("plm: 中断しました。");
            ExitCode::from(130)
        }
    }
}

async fn run(args: &[String]) -> Result<(), Error> {
    match args.first().map(String::as_str) {
        Some("desktop") => desktop(),
        Some("tui") => Err(failed("plm tui はまだ実装していません。")),
        Some("models") => models(&args[1..]).await,
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(())
        }
        _ => {
            let options = Options::parse(args)?;
            if options.print {
                print_once(options).await
            } else if !options.words.is_empty() {
                Err(usage("文章を訳して終了するには -p を付けてください。"))
            } else {
                repl(options).await
            }
        }
    }
}

struct Options {
    print: bool,
    words: Vec<String>,
    target: Option<String>,
    server: Option<String>,
    use_dictionary: bool,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, Error> {
        let mut options = Options {
            print: false,
            words: Vec::new(),
            target: None,
            server: None,
            use_dictionary: true,
        };
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-p" | "--print" => options.print = true,
                "--to" => {
                    options.target = Some(
                        args.next()
                            .ok_or_else(|| usage("--to のあとに言語を指定してください。"))?
                            .clone(),
                    )
                }
                "--server" => {
                    options.server = Some(
                        args.next()
                            .ok_or_else(|| usage("--server のあとに場所を指定してください。"))?
                            .clone(),
                    )
                }
                "--no-dict" => options.use_dictionary = false,
                "-" => {}
                option if option.starts_with('-') => {
                    return Err(usage(format!("不明なオプション: {option}")))
                }
                word => options.words.push(word.to_owned()),
            }
        }
        Ok(options)
    }
}

/// The app's Tauri app_data_dir, so models, the dictionary and GPU detection are shared.
fn data_dir() -> Result<PathBuf, Error> {
    dirs::data_dir()
        .map(|directory| directory.join("app.anywhere-plamo.desktop"))
        .ok_or_else(|| failed("データの保存先が見つかりません。"))
}

fn server(flag: Option<&str>) -> Result<PathBuf, Error> {
    if let Some(path) = flag {
        let path = PathBuf::from(path);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(failed(format!(
                "llama-server が見つかりません: {}",
                path.display()
            )))
        };
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    std::env::var_os("ANYWHERE_PLAMO_LLAMA_SERVER")
        .map(PathBuf::from)
        .into_iter()
        .chain(beside.iter().flat_map(|directory| {
            [
                directory.join(engine::EXECUTABLE),
                directory.join("resources/runtime").join(engine::EXECUTABLE),
            ]
        }))
        // Development builds use the runtime built for the app.
        .chain(cfg!(debug_assertions).then(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../src-tauri/resources/runtime")
                .join(engine::EXECUTABLE)
        }))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            failed("llama-server が見つかりません。--server か ANYWHERE_PLAMO_LLAMA_SERVER で場所を指定してください。")
        })
}

/// A loaded model plus the settings shared by `plm -p` and the interactive mode.
struct Session {
    directory: PathBuf,
    binary: PathBuf,
    exact_server: bool,
    use_dictionary: bool,
    engine: Option<engine::Engine>,
}

impl Session {
    fn new(options: &Options) -> Result<Self, Error> {
        let directory = data_dir()?;
        if !model::ready(&directory.join("models")) {
            return Err(failed(
                "翻訳モデルがありません。plm models download で取得してください。",
            ));
        }
        Ok(Session {
            binary: server(options.server.as_deref())?,
            exact_server: options.server.is_some(),
            use_dictionary: options.use_dictionary,
            directory,
            engine: None,
        })
    }

    async fn load(&mut self, cancel: &CancellationToken) -> Result<(), Error> {
        if self.engine.as_mut().is_some_and(|engine| engine.alive()) {
            return Ok(());
        }
        self.engine = None;
        let model = model::path(&self.directory.join("models"));
        // An explicit --server is used as given instead of switching to the GPU build.
        let engine = if self.exact_server {
            engine::Engine::start(&self.binary, &model, cancel).await
        } else {
            let marker = self.directory.join("gpu-runtime");
            engine::start_best(&self.binary, &model, &marker, cancel).await
        };
        self.engine = Some(engine.map_err(cancelled_or)?);
        Ok(())
    }

    /// Streams the translation to stdout, ending with exactly one newline.
    async fn translate(
        &mut self,
        text: &str,
        target: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let target = match target {
            Some(target) => target,
            None => protocol::auto_target(text)
                .ok_or_else(|| usage("翻訳先を判定できません。--to で指定してください。"))?,
        };
        // Read each time so dictionary edits in the app apply right away.
        let glossary = if self.use_dictionary {
            dictionary::glossary(
                text,
                &dictionary::load(&self.directory.join("dictionary.json")),
            )
        } else {
            Vec::new()
        };
        // Reject bad input before waiting for the model to load.
        protocol::prompt_with_glossary(text, target, &glossary).map_err(failed)?;
        self.load(cancel).await?;
        let ends_with_newline = AtomicBool::new(true);
        let print = |event| {
            if let ProgressEvent::Token { text } = event {
                ends_with_newline.store(text.ends_with('\n'), Ordering::Relaxed);
                let mut out = std::io::stdout().lock();
                out.write_all(text.as_bytes())
                    .and_then(|_| out.flush())
                    .map_err(drop)?;
            }
            Ok(())
        };
        let engine = self
            .engine
            .as_mut()
            .ok_or_else(|| failed("翻訳エンジンが見つかりません。"))?;
        let result = engine
            .translate(text, target, &glossary, &print, cancel)
            .await;
        if !ends_with_newline.load(Ordering::Relaxed) {
            println!();
        }
        if result.map_err(cancelled_or)?.truncated {
            return Err(failed(
                "訳文が長さの上限で途中で止まりました。原文を短く分けてください。",
            ));
        }
        Ok(())
    }
}

fn cancel_on_ctrl_c() -> CancellationToken {
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    // Cancelling lets the engine drop and stop llama-server instead of leaving it running.
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            token.cancel();
        }
    });
    cancel
}

async fn print_once(options: Options) -> Result<(), Error> {
    let text = if options.words.is_empty() {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| failed(format!("標準入力を読めません: {error}")))?;
        text
    } else {
        options.words.join(" ")
    };
    let mut session = Session::new(&options)?;
    session
        .translate(&text, options.target.as_deref(), &cancel_on_ctrl_c())
        .await
}

async fn repl(options: Options) -> Result<(), Error> {
    let mut session = Session::new(&options)?;
    let mut target = options.target.clone();
    let describe = |target: &Option<String>| target.clone().unwrap_or_else(|| "自動".into());
    eprintln!(
        "plm 対話モード（翻訳先: {}）。:help で使い方、Ctrl+D で終了。モデルを読み込み中…",
        describe(&target)
    );
    let cancel = cancel_on_ctrl_c();
    session.load(&cancel).await?;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    loop {
        eprint!("> ");
        let line = tokio::select! {
            line = lines.next_line() => line.map_err(|error| failed(format!("入力を読めません: {error}")))?,
            _ = tokio::signal::ctrl_c() => {
                eprintln!("\n（終了するには Ctrl+D か :quit）");
                continue;
            }
        };
        let Some(line) = line else {
            eprintln!();
            return Ok(());
        };
        let line = line.trim();
        match line
            .split_once(' ')
            .map_or((line, ""), |(command, rest)| (command, rest.trim()))
        {
            ("", _) => continue,
            (":quit" | ":q" | ":exit", _) => return Ok(()),
            (":help" | ":h", _) => eprintln!("{REPL_HELP}"),
            (":auto", _) => {
                target = None;
                eprintln!("翻訳先: 自動");
            }
            (":to", language) if !language.is_empty() => {
                // Validate the code with a throwaway prompt before switching.
                match protocol::prompt("x", language) {
                    Ok(_) => {
                        target = Some(language.to_owned());
                        eprintln!("翻訳先: {language}");
                    }
                    Err(message) => eprintln!("{message}"),
                }
            }
            (command, _) if command.starts_with(':') => {
                eprintln!("不明なコマンド: {command}（:help で一覧）")
            }
            _ => {
                let cancel = CancellationToken::new();
                let result = tokio::select! {
                    result = session.translate(line, target.as_deref(), &cancel) => result,
                    _ = tokio::signal::ctrl_c() => {
                        cancel.cancel();
                        Err(Error::Cancelled)
                    }
                };
                match result {
                    Ok(()) => {}
                    Err(Error::Cancelled) => {
                        // The partial translation stopped mid-line; keep the next one on its own line.
                        println!();
                        eprintln!("（中断しました）");
                    }
                    Err(Error::Usage(message) | Error::Failed(message)) => eprintln!("{message}"),
                }
            }
        }
    }
}

fn desktop() -> Result<(), Error> {
    const APP: &str = if cfg!(windows) {
        "anywhere-plamo.exe"
    } else {
        "anywhere-plamo"
    };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|directory| directory.join(APP)));
    let app = std::env::var_os("ANYWHERE_PLAMO_APP")
        .map(PathBuf::from)
        .into_iter()
        // A debug app needs the dev server, so debug builds look for the release app instead.
        .chain(beside.filter(|_| !cfg!(debug_assertions)))
        .chain(cfg!(debug_assertions).then(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../src-tauri/target/release")
                .join(APP)
        }))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            failed("アプリが見つかりません。ANYWHERE_PLAMO_APP で場所を指定するか、npm run tauri build -- --no-bundle でビルドしてください。")
        })?;
    let mut command = std::process::Command::new(&app);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Detach so closing the terminal does not close the app.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command
        .spawn()
        .map_err(|error| failed(format!("アプリを起動できません: {error}")))?;
    // Report an app that dies at once (e.g. missing libraries) instead of returning silently.
    for _ in 0..15 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(failed(format!(
                    "アプリがすぐに終了しました（{status}）。devbox の中から実行しているか確認してください。"
                )))
            }
            // A second launch hands over to the running app and exits cleanly.
            Ok(Some(_)) => return Ok(()),
            _ => {}
        }
    }
    Ok(())
}

async fn models(args: &[String]) -> Result<(), Error> {
    let models = data_dir()?.join("models");
    match args.first().map(String::as_str) {
        None => {
            let selected = model::selected(&models).id;
            for choice in model::choices(&models) {
                println!(
                    "{} {} {:<8} {}（{} MB）",
                    if choice.id == selected { "*" } else { " " },
                    if choice.ready { "✓" } else { " " },
                    choice.id,
                    choice.name,
                    choice.size / 1_000_000
                );
            }
            Ok(())
        }
        Some("use") => {
            let id = args
                .get(1)
                .ok_or_else(|| usage("モデルの ID を指定してください。"))?;
            model::select(&models, id).map_err(failed)
        }
        Some("download") => {
            if let Some(id) = args.get(1) {
                model::select(&models, id).map_err(failed)?;
            }
            if model::ready(&models) {
                eprintln!("{} はダウンロード済みです。", model::selected(&models).id);
                return Ok(());
            }
            let terminal = std::io::stderr().is_terminal();
            let report = move |event| {
                match event {
                    ProgressEvent::Download { received, total } if terminal => eprint!(
                        "\rダウンロード中 {:>3}%（{} / {} MB）",
                        received * 100 / total.max(1),
                        received / 1_000_000,
                        total / 1_000_000
                    ),
                    ProgressEvent::Verifying => eprintln!("\nファイルを確認中…"),
                    _ => {}
                }
                Ok(())
            };
            model::download(&models, &report, &cancel_on_ctrl_c())
                .await
                .map_err(cancelled_or)?;
            eprintln!("{} をダウンロードしました。", model::selected(&models).id);
            Ok(())
        }
        Some(other) => Err(usage(format!("不明な models のコマンド: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::{Error, Options};

    fn parse(args: &[&str]) -> Result<Options, Error> {
        Options::parse(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn options_split_flags_from_text_in_any_order() {
        let options = parse(&["--to", "fr", "-p", "Hello", "world", "--no-dict"])
            .ok()
            .unwrap();
        assert!(options.print && !options.use_dictionary);
        assert_eq!(options.target.as_deref(), Some("fr"));
        assert_eq!(options.words, ["Hello", "world"]);
        let options = parse(&[]).ok().unwrap();
        assert!(!options.print && options.words.is_empty() && options.use_dictionary);
        // A lone "-" means stdin and is not text.
        assert!(parse(&["-p", "-"]).ok().unwrap().words.is_empty());
    }

    #[test]
    fn options_reject_unknown_flags_and_missing_values() {
        assert!(matches!(parse(&["--frob"]), Err(Error::Usage(_))));
        assert!(matches!(parse(&["-p", "--to"]), Err(Error::Usage(_))));
        assert!(matches!(parse(&["--server"]), Err(Error::Usage(_))));
    }
}
