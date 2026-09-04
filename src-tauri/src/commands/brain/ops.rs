//! Readable status of long-running brain subprocesses (dream / graph
//! rebuild / recompose / auto-index).
//!
//! Hung `lazybrain.js` children used to be invisible: no event, no file,
//! no command — only a Task Manager PID at 100% CPU. This module is the
//! ops surface for that class of work. The TS side (`opsOrphanWatch.ts`)
//! polls `brain_ops_status` on the manager wakeup tick and wakes
//! LazyManager when phase is `timed_out` (or running past budget).

use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const OPS_STATUS_FILENAME: &str = "ops-status.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrainOpsStatus {
    pub updated_at: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain_path: Option<String>,
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn idle_status() -> BrainOpsStatus {
    BrainOpsStatus {
        updated_at: now_iso(),
        phase: "idle".to_string(),
        step: None,
        pid: None,
        timeout_secs: None,
        detail: None,
        brain_path: None,
    }
}

fn snapshot_slot() -> &'static Mutex<BrainOpsStatus> {
    static SLOT: OnceLock<Mutex<BrainOpsStatus>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(idle_status()))
}

pub(crate) fn current_ops_status() -> BrainOpsStatus {
    snapshot_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| idle_status())
}

fn persist(status: &BrainOpsStatus) {
    if let Ok(mut guard) = snapshot_slot().lock() {
        *guard = status.clone();
    }
    let Some(brain_path) = status.brain_path.as_deref() else {
        return;
    };
    if brain_path.is_empty() {
        return;
    }
    let dir = Path::new(brain_path).join("_cache");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(OPS_STATUS_FILENAME);
    if let Ok(json) = serde_json::to_string_pretty(status) {
        let _ = fs::write(path, json);
    }
}

pub(crate) fn record_ops_running(brain_path: &str, step: &str, pid: u32, timeout_secs: u64) {
    persist(&BrainOpsStatus {
        updated_at: now_iso(),
        phase: "running".to_string(),
        step: Some(step.to_string()),
        pid: Some(pid),
        timeout_secs: Some(timeout_secs),
        detail: None,
        brain_path: Some(brain_path.to_string()),
    });
}

pub(crate) fn record_ops_timed_out(brain_path: &str, step: &str, pid: u32, timeout_secs: u64) {
    persist(&BrainOpsStatus {
        updated_at: now_iso(),
        phase: "timed_out".to_string(),
        step: Some(step.to_string()),
        pid: Some(pid),
        timeout_secs: Some(timeout_secs),
        detail: Some(format!("{step} killed after {timeout_secs}s")),
        brain_path: Some(brain_path.to_string()),
    });
}

pub(crate) fn record_ops_idle(brain_path: &str) {
    persist(&BrainOpsStatus {
        updated_at: now_iso(),
        phase: "idle".to_string(),
        step: None,
        pid: None,
        timeout_secs: None,
        detail: None,
        brain_path: Some(brain_path.to_string()),
    });
}

/// Clear a running snapshot without erasing a timeout that just happened.
pub(crate) fn record_ops_idle_unless_timed_out(brain_path: &str) {
    if current_ops_status().phase == "timed_out" {
        return;
    }
    record_ops_idle(brain_path);
}

/// Snapshot of in-flight (or last) brain subprocesses. Readable from TS via
/// `invoke('brain_ops_status')` and from disk at
/// `<brain>/_cache/ops-status.json`. Not connected to the manager engine.
#[tauri::command]
pub(crate) fn brain_ops_status() -> BrainOpsStatus {
    current_ops_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_status_json_uses_camel_case() {
        let status = BrainOpsStatus {
            updated_at: "2026-09-03T00:00:00Z".to_string(),
            phase: "running".to_string(),
            step: Some("dream".to_string()),
            pid: Some(4242),
            timeout_secs: Some(600),
            detail: None,
            brain_path: Some("/tmp/brain".to_string()),
        };
        let json = serde_json::to_string(&status).expect("serialize");
        assert!(json.contains("\"updatedAt\""), "got {json}");
        assert!(json.contains("\"timeoutSecs\""), "got {json}");
        assert!(json.contains("\"brainPath\""), "got {json}");
        assert!(!json.contains("\"updated_at\""));
        eprintln!("ops_status_json_uses_camel_case PASSED");
    }

    #[test]
    fn record_ops_roundtrip_writes_cache_file() {
        let tmp = tempfile::TempDir::new().expect("TempDir");
        let brain = tmp.path().to_str().unwrap();
        record_ops_running(brain, "dream", 99, 600);
        let path = tmp.path().join("_cache").join(OPS_STATUS_FILENAME);
        assert!(path.exists(), "expected {}", path.display());
        let parsed: BrainOpsStatus =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(parsed.phase, "running");
        assert_eq!(parsed.step.as_deref(), Some("dream"));
        assert_eq!(parsed.pid, Some(99));
        record_ops_idle(brain);
        let idle: BrainOpsStatus =
            serde_json::from_str(&fs::read_to_string(&path).expect("read idle")).expect("json");
        assert_eq!(idle.phase, "idle");
        eprintln!("record_ops_roundtrip_writes_cache_file PASSED");
    }
}
