//! Browser automation Tauri commands — Playwright-based visual browser for
//! agent automation.
//!
//! Spawns a Node.js Playwright controller process that manages a Chromium
//! browser instance. The browser window is VISIBLE by default so the user
//! can see what the agent does in real-time.
//!
//! Commands:
//! - `browser_playwright_open` — launches a Playwright controller process
//!   and opens a visible Chromium window
//! - `browser_playwright_navigate` — navigates to a URL
//! - `browser_playwright_click` — clicks an element
//! - `browser_playwright_fill` — fills an input field
//! - `browser_playwright_screenshot` — takes a screenshot (returns description)
//! - `browser_playwright_snapshot` — gets accessibility snapshot
//! - `browser_playwright_close` — closes the browser and kills the process
//!
//! Communication with the Playwright controller is via stdin/stdout JSON
//! (one JSON message per line), similar to the MCP stdio transport.
//!
//! Recipe execution (Mission D — generic web publishing, `browser_recipe_*`
//! commands) lives in the sibling `browser_recipe` module: it drives the
//! SAME controller process and `instances()` map defined here (hence the
//! `pub(super)` visibility below), keyed by a caller-chosen `session_id`
//! instead of the hardcoded `BROWSER_INSTANCE_ID` so a recipe session never
//! collides with a manual browsing session. The controller script itself
//! (below) gained two actions for that module: `openPersistent` and
//! `runStep`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(super) struct BrowserState {
    pub(super) child: Child,
}

/// Tree-kills the controller process (and therefore its Chromium child — see
/// below) on drop, so every removal path gets the same cleanup, not just
/// `browser_playwright_close`'s own explicit handling. Tree-kill (`taskkill
/// /T /F`, not a plain `Child::kill()`) is the whole reason this impl
/// exists: `self.child` is the NODE.JS Playwright controller process, which
/// launches Chromium as ITS OWN child — a plain single-process kill would
/// leave the visible Chromium window running as an orphan. Mirrors
/// `commands::util::tree_kill_args`'s own rationale, the same helper
/// `kill_tracked_agent_pids` / `TeamsSidecar::stop` / `McpServerState::drop` use.
impl Drop for BrowserState {
    fn drop(&mut self) {
        let pid = self.child.id();
        #[cfg(target_os = "windows")]
        {
            let _ = crate::commands::util::quiet_command("taskkill")
                .args(crate::commands::util::tree_kill_args(pid))
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type BrowserMap = HashMap<String, BrowserState>;

static BROWSER_INSTANCES: std::sync::OnceLock<Arc<Mutex<BrowserMap>>> = std::sync::OnceLock::new();

/// Shared by `browser_recipe` (`pub(super)`: visible throughout `commands`
/// and its descendant modules) so recipe sessions live in this SAME map,
/// just under a different key than `BROWSER_INSTANCE_ID` — one shared
/// registry, one shared cleanup path (`kill_browser_instance`, `Drop`).
pub(super) fn instances() -> &'static Arc<Mutex<BrowserMap>> {
    BROWSER_INSTANCES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Best-effort tree-kill of the running Playwright browser controller (and
/// therefore its Chromium child) — called from the app-exit hook
/// (`run_exit_cleanup`, lib.rs) so a visible browser automation window
/// doesn't survive the IDE closing. Draining the map is enough:
/// `BrowserState`'s own `Drop` impl (above) does the actual tree-kill for
/// the entry removed this way. Poison-safe like
/// `commands::agent::kill_tracked_agent_pids`: a poisoned lock is logged and
/// skipped, never propagated or panicked.
///
/// Entries are drained into a local `Vec` under a brief lock, then the
/// guard is dropped BEFORE that `Vec` (and therefore its `BrowserState`) is
/// dropped. `Drop` runs `taskkill /T /F` via a blocking `.output()` call
/// plus `kill()`/`wait()` — holding the lock across that (as a plain
/// `map.clear()` under the lock previously did) would block any concurrent
/// command that also needs `instances()`'s lock until the tree-kill
/// finishes.
pub(crate) fn kill_browser_instance() {
    let drained: Vec<(String, BrowserState)> = match instances().lock() {
        Ok(mut map) => map.drain().collect(),
        Err(e) => {
            log::warn!("kill_browser_instance: lock poisoned: {}", e);
            return;
        }
    };
    let count = drained.len();
    // Dropping `drained` here (outside the lock) is what actually runs the
    // controller's tree-kill — see this function's own doc comment.
    drop(drained);
    if count > 0 {
        log::info!("app exit: stopped {} browser controller process(es)", count);
    }
}

const BROWSER_INSTANCE_ID: &str = "default";

/// The Node.js Playwright controller script content. This is written to a
/// temp file and executed with `node`. It communicates via stdin/stdout
/// JSON lines.
const PLAYWRIGHT_CONTROLLER_SCRIPT: &str = r#"
const { chromium } = require('playwright');
const readline = require('readline');

let browser = null;
let context = null; // set instead of `browser` for persistent-profile sessions
let page = null;

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Bounds a promise to `ms`, rejecting instead of hanging forever. Used by
// the 'runStep' handler so every recipe step is time-bounded even for
// Playwright APIs that don't take their own `timeout` option (e.g. upload,
// assert). A small margin over the caller's own internal timeout avoids a
// race between the two rejecting at nearly the same instant.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`step timed out after ${ms}ms`)), ms);
    }),
  ]);
}

// Runs one recipe step. Returns a human-readable detail string on success,
// throws on failure. Never echoes step.value/step.filePath back in the
// detail string — those may carry a credential resolved from an env var
// on the Rust side (see browser_recipe_step), and must never appear in
// output that could end up logged or displayed.
async function runRecipeStepKind(step, timeoutMs) {
  switch (step.kind) {
    case 'navigate': {
      if (!step.url) throw new Error('navigate requires "url"');
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return `navigated to ${page.url()}`;
    }
    case 'waitFor': {
      if (step.text) {
        await page.getByText(step.text).first().waitFor({ timeout: timeoutMs, state: 'visible' });
      } else if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: timeoutMs, state: 'visible' });
      } else {
        throw new Error('waitFor requires "selector" or "text"');
      }
      return 'condition met';
    }
    case 'click': {
      if (step.selector) {
        await page.click(step.selector, { timeout: timeoutMs });
      } else if (step.text) {
        await page.getByText(step.text).first().click({ timeout: timeoutMs });
      } else {
        throw new Error('click requires "selector" or "text"');
      }
      return 'clicked';
    }
    case 'fill': {
      if (!step.selector) throw new Error('fill requires "selector"');
      await page.fill(step.selector, step.value ?? '', { timeout: timeoutMs });
      return 'filled';
    }
    case 'upload': {
      if (!step.selector) throw new Error('upload requires "selector"');
      if (!step.filePath) throw new Error('upload requires "filePath"');
      await page.setInputFiles(step.selector, step.filePath, { timeout: timeoutMs });
      return 'file attached';
    }
    case 'assert': {
      const locator = step.selector ? page.locator(step.selector) : null;
      let passed = false;
      if (step.expect === 'visible' && locator) {
        passed = await locator.first().isVisible().catch(() => false);
      } else if (step.expect === 'hidden' && locator) {
        passed = !(await locator.first().isVisible().catch(() => false));
      } else if (step.expect === 'textContains' && step.text) {
        const body = await page.evaluate(() => document.body?.innerText || '');
        passed = body.includes(step.text);
      } else {
        throw new Error('assert requires a supported "expect" + matching field');
      }
      if (!passed) throw new Error(`assertion failed: ${step.expect}`);
      return 'assertion passed';
    }
    default:
      throw new Error(`Unknown step kind: ${step.kind}`);
  }
}

// Circuit breaker: checked after every step regardless of the step's own
// outcome, since an unexpected screen (captcha, identity check, layout
// change) can appear even when the step technically "succeeded". Guards
// are pure data supplied by the recipe — this function has no built-in
// notion of what "unexpected" looks like for any given site.
async function firstTrippedGuard(guards) {
  for (const g of guards) {
    try {
      let matched = false;
      if (g.selector) {
        matched = await page.locator(g.selector).first().isVisible().catch(() => false);
      } else if (g.textContains) {
        const body = await page.evaluate(() => document.body?.innerText || '');
        matched = body.includes(g.textContains);
      }
      if (matched) return g.label || 'unnamed guard';
    } catch {
      // A guard check that itself throws must never crash the step.
    }
  }
  return null;
}

async function handleMessage(msg) {
  const { id, action, params } = msg;
  try {
    let result;
    switch (action) {
      case 'open': {
        if (browser) { await browser.close(); browser = null; page = null; }
        browser = await chromium.launch({ headless: params.headless === true });
        page = await browser.newPage();
        result = { status: 'opened' };
        break;
      }
      case 'openPersistent': {
        // Persistent-profile session (Mission D): reuses `params.userDataDir`
        // across process runs so cookies/login survive — "une connexion,
        // puis session maintenue chaude" instead of logging in every time.
        if (browser) { await browser.close(); browser = null; }
        if (context) { await context.close(); context = null; }
        context = await chromium.launchPersistentContext(params.userDataDir, {
          headless: params.headless === true,
          viewport: { width: 1280, height: 800 },
        });
        page = context.pages()[0] || await context.newPage();
        result = { status: 'opened', persistent: true };
        break;
      }
      case 'runStep': {
        if (!page) throw new Error('Browser not open');
        const step = params.step || {};
        const guards = Array.isArray(params.guards) ? params.guards : [];
        const timeoutMs = Number.isFinite(step.timeoutMs) && step.timeoutMs > 0 ? step.timeoutMs : 10000;

        let detail;
        let stepError = null;
        try {
          detail = await withTimeout(runRecipeStepKind(step, timeoutMs), timeoutMs + 2000);
        } catch (e) {
          stepError = e && e.message ? e.message : String(e);
        }

        const guardTripped = await firstTrippedGuard(guards);

        // Bounded viewport screenshot as evidence for every key step (proof
        // of state reached) — never full-page, keeps payload/memory small.
        let screenshotBase64 = null;
        try {
          const buf = await page.screenshot({ type: 'png' });
          screenshotBase64 = buf.toString('base64');
        } catch {
          // Screenshot capture is best-effort; its absence must not hide
          // a step's real ok/error outcome.
        }

        result = {
          ok: !stepError && !guardTripped,
          detail: stepError ? null : detail,
          error: stepError,
          guardTripped,
          screenshotBase64,
        };
        break;
      }
      case 'navigate': {
        if (!page) throw new Error('Browser not open');
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title();
        result = { title, url: page.url() };
        break;
      }
      case 'click': {
        if (!page) throw new Error('Browser not open');
        if (params.ref) {
          // Playwright snapshot ref mode — use locator by ref
          await page.locator(`[data-ref="${params.ref}"]`).click();
        } else if (params.text) {
          await page.getByText(params.text).first().click();
        } else if (params.selector) {
          await page.click(params.selector);
        } else {
          throw new Error('No selector, text, or ref provided');
        }
        result = { status: 'clicked' };
        break;
      }
      case 'fill': {
        if (!page) throw new Error('Browser not open');
        await page.fill(params.selector, params.value);
        result = { status: 'filled' };
        break;
      }
      case 'screenshot': {
        if (!page) throw new Error('Browser not open');
        // We don't return the screenshot bytes — the user sees it in the
        // visible browser window. We return a description of the page state.
        const title = await page.title();
        const url = page.url();
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
        result = { title, url, bodyText };
        break;
      }
      case 'snapshot': {
        if (!page) throw new Error('Browser not open');
        // Get accessibility snapshot
        const snapshot = await page.accessibility.snapshot();
        const lines = [];
        function walk(node, depth) {
          if (!node) return;
          const indent = '  '.repeat(depth);
          const ref = node.ref ? `[ref=${node.ref}]` : '';
          const role = node.role || '?';
          const name = node.name ? ` "${node.name}"` : '';
          lines.push(`${indent}${role}${name} ${ref}`);
          if (node.children) {
            for (const child of node.children) walk(child, depth + 1);
          }
        }
        walk(snapshot, 0);
        result = { snapshot: lines.join('\n') };
        break;
      }
      case 'close': {
        if (browser) { await browser.close(); browser = null; }
        if (context) { await context.close(); context = null; }
        page = null;
        result = { status: 'closed' };
        break;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, error: err.message }) + '\n');
  }
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg).catch((err) => {
      process.stdout.write(JSON.stringify({ id: msg.id, error: String(err) }) + '\n');
    });
  } catch (e) {
    // ignore malformed input
  }
});

rl.on('close', () => {
  if (browser) { browser.close().catch(() => {}); }
  if (context) { context.close().catch(() => {}); }
  process.exit(0);
});
"#;

/// Writes the Playwright controller script to a temp file and returns its
/// path. `pub(super)`: also called by the sibling `browser_recipe` module.
pub(super) fn write_controller_script() -> Result<std::path::PathBuf, String> {
    let temp_dir = std::env::temp_dir();
    let script_path = temp_dir.join("lazy-playwright-controller.js");
    std::fs::write(&script_path, PLAYWRIGHT_CONTROLLER_SCRIPT)
        .map_err(|e| format!("Failed to write Playwright controller script: {}", e))?;
    Ok(script_path)
}

/// Sends a JSON message to the Playwright controller's stdin and reads the
/// response from stdout. `pub(super)`: also called by the sibling
/// `browser_recipe` module (same controller process, same JSON-line
/// transport, different `action`/`params`).
pub(super) fn send_and_receive(
    state: &mut BrowserState,
    message: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    let stdin = state
        .child
        .stdin
        .as_mut()
        .ok_or_else(|| "Playwright controller stdin not available".to_string())?;

    stdin
        .write_all(message.as_bytes())
        .map_err(|e| format!("Failed to write to controller: {}", e))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush: {}", e))?;

    let stdout = state
        .child
        .stdout
        .as_mut()
        .ok_or_else(|| "Playwright controller stdout not available".to_string())?;

    let mut reader = BufReader::new(stdout);
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Playwright controller timed out after {}ms", timeout_ms));
        }

        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from controller: {}", e))?;

        if bytes_read == 0 {
            return Err("Playwright controller closed stdout".to_string());
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        return Ok(trimmed.to_string());
    }
}

/// Opens a Playwright browser (visible Chromium window).
#[tauri::command]
pub fn browser_playwright_open(headless: bool) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;

    // Close existing instance if any
    if let Some(mut old) = map.remove(BROWSER_INSTANCE_ID) {
        let _ = old.child.kill();
        let _ = old.child.wait();
    }

    let script_path = write_controller_script()?;

    let child = Command::new("node")
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Playwright controller: {}", e))?;

    map.insert(
        BROWSER_INSTANCE_ID.to_string(),
        BrowserState { child },
    );

    // Send the "open" command
    let map_ref = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map_ref
        .get(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Failed to get browser state".to_string())?;

    // We need a mutable reference, so drop the read lock and get a write lock
    drop(map_ref);

    let mut map_mut = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map_mut
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser instance not found".to_string())?;

    let msg = serde_json::json!({
        "id": 1,
        "action": "open",
        "params": { "headless": headless }
    });
    let response = send_and_receive(state, &msg.to_string(), 30000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse controller response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Playwright open failed: {}", err));
    }

    Ok("Browser opened".to_string())
}

/// Navigates the browser to a URL.
#[tauri::command]
pub fn browser_playwright_navigate(url: String) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser not open. Call browser_open first.".to_string())?;

    let msg = serde_json::json!({
        "id": 2,
        "action": "navigate",
        "params": { "url": url }
    });
    let response = send_and_receive(state, &msg.to_string(), 30000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Navigation failed: {}", err));
    }

    let result = parsed.get("result").cloned().unwrap_or(serde_json::Value::Null);
    Ok(result.to_string())
}

/// Clicks an element in the browser.
#[tauri::command]
pub fn browser_playwright_click(
    selector: Option<String>,
    text: Option<String>,
    ref_id: Option<String>,
) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser not open".to_string())?;

    let mut params = serde_json::json!({});
    if let Some(s) = selector { params["selector"] = serde_json::Value::String(s); }
    if let Some(t) = text { params["text"] = serde_json::Value::String(t); }
    if let Some(r) = ref_id { params["ref"] = serde_json::Value::String(r); }

    let msg = serde_json::json!({
        "id": 3,
        "action": "click",
        "params": params
    });
    let response = send_and_receive(state, &msg.to_string(), 15000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Click failed: {}", err));
    }

    Ok("Clicked".to_string())
}

/// Fills an input field.
#[tauri::command]
pub fn browser_playwright_fill(selector: String, value: String) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser not open".to_string())?;

    let msg = serde_json::json!({
        "id": 4,
        "action": "fill",
        "params": { "selector": selector, "value": value }
    });
    let response = send_and_receive(state, &msg.to_string(), 15000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Fill failed: {}", err));
    }

    Ok("Filled".to_string())
}

/// Takes a screenshot (returns page description, the actual screenshot is
/// visible in the browser window).
#[tauri::command]
pub fn browser_playwright_screenshot(full_page: bool) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser not open".to_string())?;

    let msg = serde_json::json!({
        "id": 5,
        "action": "screenshot",
        "params": { "full_page": full_page }
    });
    let response = send_and_receive(state, &msg.to_string(), 15000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Screenshot failed: {}", err));
    }

    let result = parsed.get("result").cloned().unwrap_or(serde_json::Value::Null);
    Ok(result.to_string())
}

/// Gets an accessibility snapshot of the page.
#[tauri::command]
pub fn browser_playwright_snapshot() -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(BROWSER_INSTANCE_ID)
        .ok_or_else(|| "Browser not open".to_string())?;

    let msg = serde_json::json!({
        "id": 6,
        "action": "snapshot",
        "params": {}
    });
    let response = send_and_receive(state, &msg.to_string(), 15000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Snapshot failed: {}", err));
    }

    let snapshot = parsed
        .get("result")
        .and_then(|r| r.get("snapshot"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    Ok(snapshot.to_string())
}

/// Closes the browser and kills the controller process.
#[tauri::command]
pub fn browser_playwright_close() -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(mut state) = map.remove(BROWSER_INSTANCE_ID) {
        // Best-effort graceful close first (lets Playwright close the
        // Chromium window cleanly). `state` then drops at the end of this
        // block regardless of whether that succeeded — `BrowserState::drop`
        // (tree-kill) runs either way, so a stuck/unresponsive controller
        // can never leak the browser process.
        let msg = serde_json::json!({
            "id": 7,
            "action": "close",
            "params": {}
        });
        let _ = send_and_receive(&mut state, &msg.to_string(), 5000);
    }

    Ok("Browser closed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A poisoned-lock `BROWSER_INSTANCES` map must degrade gracefully (log
    /// + return) rather than panic — this runs from the app-exit hook,
    /// where a panic would be especially unwelcome. Mirrors
    /// `commands::mcp::kill_all_mcp_servers_handles_poisoned_lock_without_panicking`'s
    /// own recipe, including `clear_poison()` afterward: `instances()` is a
    /// process-wide `OnceLock` singleton, so leaving it poisoned would leak
    /// into any other test sharing this static within the same test binary.
    #[test]
    fn kill_browser_instance_handles_poisoned_lock_without_panicking() {
        use std::panic;

        let inner = Arc::clone(instances());
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — kill_browser_instance logs a warning and returns.
        kill_browser_instance();
        inner.clear_poison();
        eprintln!("kill_browser_instance_handles_poisoned_lock_without_panicking PASSED");
    }
}
