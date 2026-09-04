/// Test runner module: detects the project's test tool and runs it.
///
/// Detection priority (files present in repo_path):
///   1. package.json with a "test" script → npm test
///   2. Cargo.toml → cargo test
///   3. pyproject.toml or pytest.ini → pytest
///
/// Returns a TestRunResult with best-effort pass/fail counts parsed from output.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::io::{BufRead, BufReader};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::ffi::OsStr;

use crate::commands::util::join_drain_thread_bounded;

fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// How long the post-timeout/post-completion cleanup waits for each drain
/// thread (stdout, stderr) to finish, before giving up on it — see
/// `join_drain_thread_bounded`'s doc comment (commands/util.rs). Applied
/// independently per stream.
const DRAIN_JOIN_BOUND: Duration = Duration::from_secs(2);

/// Move whatever lines are currently queued in `rx` into `buf` (one `\n`-
/// terminated line each) without blocking — used to drain a reader thread's
/// mpsc channel on every wake of the poll loop in `run`, and once more for
/// any trailing lines after that loop exits.
fn drain_available(rx: &std::sync::mpsc::Receiver<String>, buf: &mut String) {
    while let Ok(line) = rx.try_recv() {
        buf.push_str(&line);
        buf.push('\n');
    }
}

/// A single test failure.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TestFailure {
    pub name: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

/// Result returned by run_tests.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TestRunResult {
    pub ok: bool,
    pub tool: String,
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub failures: Vec<TestFailure>,
    pub raw: String,
}

/// Detect the test tool for a given repo path.
/// Returns (tool_name, command, args) or an error string.
fn detect_tool(repo_path: &str) -> Result<(&'static str, &'static str, Vec<String>), String> {
    let dir = Path::new(repo_path);

    // 1. package.json with a "test" script
    let pkg = dir.join("package.json");
    if pkg.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let has_test = v.get("scripts")
                    .and_then(|s| s.get("test"))
                    .and_then(|t| t.as_str())
                    .map(|t| !t.is_empty() && t != "echo \"Error: no test specified\" && exit 1")
                    .unwrap_or(false);
                if has_test {
                    // Use npm.cmd on Windows, npm elsewhere
                    let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
                    return Ok(("npm", npm, vec!["test".to_string(), "--".to_string()]));
                }
            }
        }
    }

    // 2. Cargo.toml → cargo test
    if dir.join("Cargo.toml").exists() {
        return Ok(("cargo", "cargo", vec!["test".to_string()]));
    }

    // 3. pyproject.toml or pytest.ini → pytest
    if dir.join("pyproject.toml").exists() || dir.join("pytest.ini").exists() {
        return Ok(("pytest", "pytest", vec!["-v".to_string()]));
    }

    Err(format!(
        "run_tests: no recognised test tool found in '{}'",
        repo_path
    ))
}

/// Path-jail: repo_path must be an existing directory (no traversal).
fn validate_repo_path(repo_path: &str) -> Result<(), String> {
    let p = Path::new(repo_path);
    if !p.is_dir() {
        return Err(format!("run_tests: '{}' is not a directory", repo_path));
    }
    // Reject obvious path traversal attempts
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("run_tests: canonicalize failed: {}", e))?;
    if canonical.to_string_lossy().contains("..") {
        return Err(format!("run_tests: path traversal rejected: {}", repo_path));
    }
    Ok(())
}

/// Parse npm/jest output for pass/fail counts and failures.
///
/// Jest summary line: "Tests:       2 failed, 5 passed, 7 total"
/// Mocha:            "  2 passing" / "  1 failing"
/// Vitest:           similar to Jest
fn parse_npm_results(raw: &str) -> (u32, u32, u32, Vec<TestFailure>) {
    let mut total = 0u32;
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut failures: Vec<TestFailure> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();

        // Jest-style: "Tests:  2 failed, 5 passed, 7 total"
        // Strip the "Tests:" prefix then split on comma
        if let Some(after_tests) = trimmed.strip_prefix("Tests:") {
            for part in after_tests.split(',') {
                let p = part.trim();
                if let Some(n) = extract_leading_number(p) {
                    if p.contains("failed") { failed = n; }
                    else if p.contains("passed") { passed = n; }
                    else if p.contains("total") { total = n; }
                }
            }
        }
        // Mocha: "  2 passing"
        else if trimmed.ends_with("passing") || trimmed.contains("passing (") {
            if let Some(n) = extract_leading_number(trimmed) {
                passed = n;
            }
        }
        // Mocha: "  1 failing"
        else if trimmed.ends_with("failing") || trimmed.contains("failing (") {
            if let Some(n) = extract_leading_number(trimmed) {
                failed = n;
            }
        }

        // Jest failure: "  ● TestSuite › test name"
        if trimmed.starts_with("● ") && trimmed.contains(" › ") {
            let name = trimmed.trim_start_matches("● ").to_string();
            failures.push(TestFailure {
                name,
                message: String::new(),
                file: None,
                line: None,
            });
        }
    }

    if total == 0 {
        total = passed + failed;
    }
    (total, passed, failed, failures)
}

/// Parse cargo test output for pass/fail counts and failures.
///
/// Cargo summary: "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured"
/// Per-test:      "test foo::bar ... FAILED" or "test foo::bar ... ok"
fn parse_cargo_results(raw: &str) -> (u32, u32, u32, Vec<TestFailure>) {
    let mut total = 0u32;
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut failures: Vec<TestFailure> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();

        // Summary line: "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; ..."
        // After "test result: FAILED.", the rest uses "N label" pairs separated by ";"
        if trimmed.starts_with("test result:") {
            // Split on semicolon; each part is like "3 passed" or " 2 failed"
            // Also split on ". " to skip "test result: FAILED."
            let after_prefix = if let Some(dot) = trimmed.find(". ") {
                &trimmed[dot + 2..]
            } else {
                trimmed
            };
            for part in after_prefix.split(';') {
                let p = part.trim();
                if let Some(n) = extract_leading_number(p) {
                    if p.contains("passed") { passed = n; }
                    else if p.contains("failed") { failed = n; }
                }
            }
            total = passed + failed;
        }

        // Per-test failure: "test path::name ... FAILED"
        if trimmed.starts_with("test ") && trimmed.ends_with("FAILED") {
            // Remove "test " prefix and " ... FAILED" suffix
            let name = trimmed
                .trim_start_matches("test ")
                .trim_end_matches("FAILED")
                .trim()
                .trim_end_matches("...")
                .trim()
                .to_string();
            failures.push(TestFailure {
                name,
                message: String::new(),
                file: None,
                line: None,
            });
        }
    }

    (total, passed, failed, failures)
}

/// Parse pytest output for pass/fail counts and failures.
///
/// Pytest summary: "====== 2 failed, 5 passed in 0.12s ======"
/// Per-test FAIL:  "FAILED test_foo.py::test_bar - AssertionError: ..."
fn parse_pytest_results(raw: &str) -> (u32, u32, u32, Vec<TestFailure>) {
    let mut total = 0u32;
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut failures: Vec<TestFailure> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();

        // Summary line: "=== 2 failed, 5 passed in 0.12s ==="
        if trimmed.starts_with("=") && (trimmed.contains("passed") || trimmed.contains("failed")) {
            for part in trimmed.split(',') {
                let p = part.trim().trim_start_matches('=').trim();
                if let Some(n) = extract_leading_number(p) {
                    if p.contains("passed") { passed = n; }
                    else if p.contains("failed") { failed = n; }
                }
            }
            // Also handle "X passed in" format
            if let Some(n) = extract_leading_number(trimmed.trim_start_matches('=').trim()) {
                if trimmed.contains("passed") && failed == 0 {
                    passed = n;
                }
            }
            total = passed + failed;
        }

        // Per-test failure: "FAILED test_foo.py::test_bar - AssertionError"
        if trimmed.starts_with("FAILED ") {
            let rest = trimmed.trim_start_matches("FAILED ").trim();
            let (name, message) = if let Some(dash) = rest.find(" - ") {
                (rest[..dash].to_string(), rest[dash + 3..].to_string())
            } else {
                (rest.to_string(), String::new())
            };

            // Try to parse file and line from "path/file.py::test_name"
            let (file, line_no) = parse_pytest_location(&name);

            failures.push(TestFailure {
                name,
                message,
                file,
                line: line_no,
            });
        }
    }

    (total, passed, failed, failures)
}

/// Parse pytest test id "tests/test_foo.py::test_bar" into (Some(file), None).
fn parse_pytest_location(id: &str) -> (Option<String>, Option<u32>) {
    if let Some(sep) = id.find("::") {
        let file = id[..sep].to_string();
        return (Some(file), None);
    }
    (None, None)
}

/// Extract a leading integer from a string like "2 failed" → Some(2).
fn extract_leading_number(s: &str) -> Option<u32> {
    let trimmed = s.trim();
    let end = trimmed.find(|c: char| !c.is_ascii_digit()).unwrap_or(trimmed.len());
    trimmed[..end].parse().ok()
}

/// Run tests in a repository, detect the tool, parse results, return TestRunResult.
pub fn run(repo_path: &str) -> Result<TestRunResult, String> {
    validate_repo_path(repo_path)?;

    let (tool_name, binary, args) = detect_tool(repo_path)?;

    let start = Instant::now();

    // Build command
    let mut cmd = quiet_command(binary);
    cmd.args(&args)
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Timeout: 5 minutes for test runs
    let timeout = Duration::from_secs(300);

    let mut child = cmd.spawn()
        .map_err(|e| format!("run_tests: failed to spawn '{}': {}", binary, e))?;

    // Collect stdout + stderr into a single raw string with a timeout.
    // We read both streams by consuming them in the child output.
    let output = {
        let child_id = child.id();
        let deadline = start + timeout;

        // Reader threads just read-to-EOF and forward lines over an mpsc
        // channel each — no deadline logic inside them anymore. Deadline
        // enforcement lives solely in the poll loop below via
        // Instant::now()/try_wait(), so a single blocking `reader.lines()`
        // read that never returns (child produces no output for a while, or
        // a grandchild inherits the pipe and never closes it) can no longer
        // make the deadline check itself hang past `deadline` — the poll
        // loop just stops waiting on that channel and moves on.
        let (stdout_tx, stdout_rx) = std::sync::mpsc::channel::<String>();
        let stdout_reader = child.stdout.take().map(|stdout| std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().take(10000) {
                match line {
                    Ok(l) => { if stdout_tx.send(l).is_err() { break; } }
                    Err(_) => break,
                }
            }
        }));

        let (stderr_tx, stderr_rx) = std::sync::mpsc::channel::<String>();
        let stderr_reader = child.stderr.take().map(|stderr| std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().take(10000) {
                match line {
                    Ok(l) => { if stderr_tx.send(l).is_err() { break; } }
                    Err(_) => break,
                }
            }
        }));

        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();

        // Wait for child with timeout. stdout_rx.recv_timeout is this loop's
        // wake/sleep mechanism (was a flat 100ms std::thread::sleep) — lines
        // are drained the moment they arrive instead of only at the next
        // poll tick, while capping how long any single wait can block;
        // stderr is drained non-blockingly alongside on every wake.
        let exit_status = loop {
            match stdout_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => { stdout_buf.push_str(&line); stdout_buf.push('\n'); }
                Err(_) => {} // Timeout (normal) or Disconnected (reader done) — check below either way.
            }
            drain_available(&stderr_rx, &mut stderr_buf);

            if Instant::now() >= deadline {
                // Kill the whole process tree on timeout. Previously killed
                // only the top-level PID (no /T) — a grandchild (e.g. a
                // worker process spawned by npm/cargo/pytest) could survive
                // and keep holding the output pipes open.
                #[cfg(target_os = "windows")]
                {
                    let _ = quiet_command("taskkill")
                        .args(["/PID", &child_id.to_string(), "/T", "/F"])
                        .output();
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = unsafe { libc::kill(child_id as i32, libc::SIGKILL) };
                }
                let _ = child.wait();
                // Bounded join — a surviving grandchild could still hold a
                // pipe open, so this never waits past DRAIN_JOIN_BOUND per
                // stream; an abandoned reader thread is counted rather than
                // silently leaked (see join_drain_thread_bounded).
                if let Some(h) = stdout_reader {
                    let _ = join_drain_thread_bounded(h, DRAIN_JOIN_BOUND);
                }
                if let Some(h) = stderr_reader {
                    let _ = join_drain_thread_bounded(h, DRAIN_JOIN_BOUND);
                }
                drain_available(&stdout_rx, &mut stdout_buf);
                drain_available(&stderr_rx, &mut stderr_buf);
                return Err(format!("run_tests: timed out after {}s", timeout.as_secs()));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(e) => return Err(format!("run_tests: wait error: {}", e)),
            }
        };

        // Normal completion — bounded join (same rationale as the timeout
        // path above) then a final non-blocking drain for any trailing
        // lines the reader threads had already queued.
        if let Some(h) = stdout_reader {
            let _ = join_drain_thread_bounded(h, DRAIN_JOIN_BOUND);
        }
        if let Some(h) = stderr_reader {
            let _ = join_drain_thread_bounded(h, DRAIN_JOIN_BOUND);
        }
        drain_available(&stdout_rx, &mut stdout_buf);
        drain_available(&stderr_rx, &mut stderr_buf);

        (exit_status, stdout_buf, stderr_buf)
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let (exit_status, stdout_str, stderr_str) = output;

    // Combine stdout + stderr for display (stdout first, then stderr)
    let raw = format!("{}{}", stdout_str, stderr_str);

    // Parse results based on tool
    let (total, passed, failed, failures) = match tool_name {
        "npm" => parse_npm_results(&raw),
        "cargo" => parse_cargo_results(&raw),
        "pytest" => parse_pytest_results(&raw),
        _ => (0, 0, 0, Vec::new()),
    };

    Ok(TestRunResult {
        ok: exit_status.success(),
        tool: tool_name.to_string(),
        total,
        passed,
        failed,
        duration_ms,
        failures,
        raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cargo_summary_line() {
        let raw = "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out\n\
                   test foo::bar ... FAILED\n\
                   test foo::baz ... FAILED\n";
        let (total, passed, failed, failures) = parse_cargo_results(raw);
        assert_eq!(passed, 3);
        assert_eq!(failed, 2);
        assert_eq!(total, 5);
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().any(|f| f.name == "foo::bar"));
    }

    #[test]
    fn parse_cargo_all_pass() {
        let raw = "test result: ok. 5 passed; 0 failed; 0 ignored;\n";
        let (total, passed, failed, failures) = parse_cargo_results(raw);
        assert_eq!(passed, 5);
        assert_eq!(failed, 0);
        assert_eq!(total, 5);
        assert!(failures.is_empty());
    }

    #[test]
    fn parse_pytest_summary_line() {
        let raw = "FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n\
                   ====== 1 failed, 3 passed in 0.45s ======\n";
        let (total, passed, failed, failures) = parse_pytest_results(raw);
        assert_eq!(passed, 3);
        assert_eq!(failed, 1);
        assert_eq!(total, 4);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].name.contains("test_bar"));
        assert!(failures[0].message.contains("AssertionError"));
        assert_eq!(failures[0].file, Some("tests/test_foo.py".to_string()));
    }

    #[test]
    fn parse_npm_jest_summary() {
        let raw = "Tests:       2 failed, 5 passed, 7 total\n\
                   Test Suites: 1 failed, 2 total\n\
                   Time:        1.234 s\n\
                   ● MyModule › should work\n";
        let (total, passed, failed, failures) = parse_npm_results(raw);
        assert_eq!(total, 7);
        assert_eq!(passed, 5);
        assert_eq!(failed, 2);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].name.contains("MyModule"));
    }

    #[test]
    fn detect_tool_returns_error_for_empty_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = detect_tool(tmp.path().to_str().unwrap());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no recognised test tool"));
    }

    #[test]
    fn validate_path_rejects_nonexistent() {
        let result = validate_repo_path("/this/path/does/not/exist/12345");
        assert!(result.is_err());
    }
}
