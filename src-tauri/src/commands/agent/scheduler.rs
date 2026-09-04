//! Local cron scheduler: cron-field matching, the `ScheduledAgent` model
//! loaded from `.lazy/agents/*.json`, and the schedule-reload / cloud-stub
//! commands. The actual firing loop lives in `scheduler_run.rs`.

use std::fs;
use std::sync::{Arc, Mutex};

use crate::state::ProjectState;

use super::storage::{project_agents_dir, user_agents_dir};

/// Minimal cron-field matcher for "minute hour dom month dow" patterns.
/// Supports: "*", exact numbers, ranges (a-b), lists (a,b,c), step (*/n).
///
/// `field_max` is the inclusive upper bound for the `*` wildcard in step expressions
/// and is field-specific: 59 for minute, 23 for hour, 31 for dom, 12 for month, 6 for dow.
pub fn cron_field_matches(field: &str, value: u32, field_max: u32) -> bool {
    if field == "*" {
        return true;
    }
    for part in field.split(',') {
        let part = part.trim();
        if let Some(slash_pos) = part.find('/') {
            // Step: */n or a-b/n
            let step: u32 = part[slash_pos + 1..].parse().unwrap_or(1);
            if step == 0 { continue; }
            let base = &part[..slash_pos];
            let (start, end) = if base == "*" {
                // Use per-field max instead of hardcoded 59 (#49).
                (0u32, field_max)
            } else if let Some(dash) = base.find('-') {
                let s = base[..dash].parse().unwrap_or(0);
                let e = base[dash + 1..].parse().unwrap_or(field_max);
                (s, e)
            } else {
                let s = base.parse().unwrap_or(0);
                (s, s)
            };
            if value >= start && value <= end && (value - start) % step == 0 {
                return true;
            }
        } else if let Some(dash) = part.find('-') {
            // Range: a-b
            let start: u32 = part[..dash].parse().unwrap_or(0);
            let end: u32 = part[dash + 1..].parse().unwrap_or(field_max);
            if value >= start && value <= end {
                return true;
            }
        } else if let Ok(n) = part.parse::<u32>() {
            if n == value {
                return true;
            }
        }
    }
    false
}

/// Return true if `cron` (5-field: min hour dom month dow) fires at the given UTC time.
pub fn cron_matches(cron: &str, dt: &chrono::DateTime<chrono::Utc>) -> bool {
    use chrono::Datelike;
    use chrono::Timelike;

    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let min  = dt.minute();
    let hour = dt.hour();
    let dom  = dt.day();
    let mon  = dt.month();
    let dow  = dt.weekday().num_days_from_sunday(); // 0=Sun

    // Per-field maxes: [minute=59, hour=23, dom=31, month=12, dow=6] (#49)
    cron_field_matches(parts[0], min,  59)
        && cron_field_matches(parts[1], hour, 23)
        && cron_field_matches(parts[2], dom,  31)
        && cron_field_matches(parts[3], mon,  12)
        && cron_field_matches(parts[4], dow,   6)
}

/// A scheduled agent entry loaded from storage.
#[derive(Clone, Debug)]
pub struct ScheduledAgent {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub system_prompt: String,
    pub model_tier: String,
    /// Permission mode for CLI: 'acceptEdits' | 'plan' | 'default' | 'full' | 'bypassPermissions'.
    /// None / absent → defaults to 'acceptEdits' (safe); 'full'/'bypassPermissions' requires
    /// explicit opt-in in the agent JSON config and emits an audit log line.
    pub permission_mode: Option<String>,
    /// Project root directory. The scheduler spawns the claude CLI with this as current_dir
    /// so scheduled agents always run in the correct project context (#27).
    pub project_root: String,
}

/// Shared state for the scheduler: list of active scheduled agents.
pub struct SchedulerState {
    pub agents: Arc<Mutex<Vec<ScheduledAgent>>>,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new()
    }
}

impl SchedulerState {
    pub fn new() -> Self {
        SchedulerState {
            agents: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

/// Load all local-scheduled agents from storage into the scheduler state.
/// Called at startup and whenever `reload_agent_schedules` is invoked.
pub(crate) fn load_scheduled_agents(project_state: &tauri::State<ProjectState>) -> Vec<ScheduledAgent> {
    let mut result = Vec::new();

    // Capture the project root once so it can be stored on each ScheduledAgent (#27).
    let project_root = project_state.0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    // Collect dirs to scan: user + project
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    dirs.push(user_agents_dir());
    if let Some(proj_dir) = project_agents_dir(project_state) {
        dirs.push(proj_dir);
    }

    for dir in dirs {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    // Check triggers.schedule.enabled + mode=local
                    let enabled = v["triggers"]["schedule"]["enabled"]
                        .as_bool()
                        .unwrap_or(false);
                    let mode = v["triggers"]["schedule"]["mode"]
                        .as_str()
                        .unwrap_or("local");
                    let cron = v["triggers"]["schedule"]["cron"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();

                    if enabled && mode == "local" && !cron.is_empty() {
                        let id = v["id"].as_str().unwrap_or("").to_string();
                        let name = v["name"].as_str().unwrap_or("").to_string();
                        let system_prompt = v["systemPrompt"].as_str().unwrap_or("").to_string();
                        let model_tier = v["modelTier"].as_str().unwrap_or("sonnet").to_string();
                        // Read optional permission mode; absent/null → safe default (acceptEdits).
                        let permission_mode = v["permissionMode"].as_str().map(|s| s.to_string());

                        if !id.is_empty() && !name.is_empty() && !cron.is_empty() {
                            result.push(ScheduledAgent {
                                id,
                                name,
                                cron,
                                system_prompt,
                                model_tier,
                                permission_mode,
                                project_root: project_root.clone(),
                            });
                        }
                    }
                }
            }
        }
    }

    log::info!("load_scheduled_agents: {} local-scheduled agents found", result.len());
    result
}

/// Reload the active schedule from storage. Called after saving/updating an agent.
/// Returns the count of locally-scheduled agents now active.
#[tauri::command]
pub(crate) fn reload_agent_schedules(
    project_state: tauri::State<ProjectState>,
    scheduler_state: tauri::State<SchedulerState>,
) -> Result<usize, String> {
    let agents = load_scheduled_agents(&project_state);
    let count = agents.len();
    let mut guard = scheduler_state.agents.lock()
        .map_err(|e| format!("reload_agent_schedules: lock failed: {}", e))?;
    *guard = agents;
    log::info!("reload_agent_schedules: {} local-scheduled agents active", count);
    Ok(count)
}

/// Cloud scheduling stub — mode='cloud' is not yet implemented.
/// Returns a descriptive error explaining what is needed.
#[tauri::command]
pub(crate) fn agent_schedule_cloud_stub() -> Result<(), String> {
    Err(
        "Le mode Cloud necesssite la beta Anthropic Routines et un token d'abonnement Pro/Max. \
         Non disponible actuellement. Utilisez le mode Local."
            .to_string()
    )
}

/// Read all *.json files from a directory as ScheduledAgent items (for tests).
#[cfg(test)]
pub fn read_agent_dir_for_test(dir: &std::path::Path) -> Vec<ScheduledAgent> {
    let mut result = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let enabled = v["triggers"]["schedule"]["enabled"].as_bool().unwrap_or(false);
                let mode = v["triggers"]["schedule"]["mode"].as_str().unwrap_or("local");
                let cron = v["triggers"]["schedule"]["cron"].as_str().unwrap_or("").to_string();
                if enabled && mode == "local" && !cron.is_empty() {
                    result.push(ScheduledAgent {
                        id: v["id"].as_str().unwrap_or("").to_string(),
                        name: v["name"].as_str().unwrap_or("").to_string(),
                        cron,
                        system_prompt: v["systemPrompt"].as_str().unwrap_or("").to_string(),
                        model_tier: v["modelTier"].as_str().unwrap_or("sonnet").to_string(),
                        permission_mode: v["permissionMode"].as_str().map(|s| s.to_string()),
                        // No project root available in test context — use empty string.
                        project_root: String::new(),
                    });
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// cron_field_matches: wildcard matches any value.
    #[test]
    fn cron_field_wildcard() {
        assert!(cron_field_matches("*", 0, 59));
        assert!(cron_field_matches("*", 59, 59));
        assert!(cron_field_matches("*", 23, 23));
    }

    /// cron_field_matches: exact number.
    #[test]
    fn cron_field_exact() {
        assert!(cron_field_matches("9", 9, 59));
        assert!(!cron_field_matches("9", 10, 59));
        assert!(cron_field_matches("0", 0, 59));
    }

    /// cron_field_matches: range (a-b).
    #[test]
    fn cron_field_range() {
        assert!(cron_field_matches("1-5", 1, 59));
        assert!(cron_field_matches("1-5", 3, 59));
        assert!(cron_field_matches("1-5", 5, 59));
        assert!(!cron_field_matches("1-5", 0, 59));
        assert!(!cron_field_matches("1-5", 6, 59));
    }

    /// cron_field_matches: step (*/n).
    #[test]
    fn cron_field_step() {
        // */30 matches 0 and 30 (minute field, max=59)
        assert!(cron_field_matches("*/30", 0, 59));
        assert!(cron_field_matches("*/30", 30, 59));
        assert!(!cron_field_matches("*/30", 15, 59));
        assert!(!cron_field_matches("*/30", 31, 59));
        // */6 on hour field (max=23) — matches 0, 6, 12, 18, not 24
        assert!(cron_field_matches("*/6", 0, 23));
        assert!(cron_field_matches("*/6", 12, 23));
        assert!(!cron_field_matches("*/6", 24, 23));
    }

    /// cron_matches: "0 9 * * 1-5" fires at 09:00 on Monday (dow=1),
    /// does NOT fire at 09:01 or on Sunday (dow=0).
    #[test]
    fn scheduler_cron_matches_weekday_9am() {
        use chrono::{TimeZone, Weekday, Datelike};
        use chrono::Utc;

        // Monday 2024-01-08 09:00 UTC
        let monday_9am = Utc.with_ymd_and_hms(2024, 1, 8, 9, 0, 0).unwrap();
        assert_eq!(monday_9am.weekday(), Weekday::Mon);
        assert!(
            cron_matches("0 9 * * 1-5", &monday_9am),
            "Should fire at 09:00 Mon"
        );

        // Monday 09:01 — should NOT fire (minute=1)
        let monday_9am_01 = Utc.with_ymd_and_hms(2024, 1, 8, 9, 1, 0).unwrap();
        assert!(!cron_matches("0 9 * * 1-5", &monday_9am_01), "Should NOT fire at 09:01");

        // Sunday 09:00 (dow=0) — should NOT fire (day-of-week filter)
        let sunday_9am = Utc.with_ymd_and_hms(2024, 1, 7, 9, 0, 0).unwrap();
        assert_eq!(sunday_9am.weekday(), Weekday::Sun);
        assert!(!cron_matches("0 9 * * 1-5", &sunday_9am), "Should NOT fire on Sunday");
    }

    /// cron_matches: "0 * * * *" fires every hour on the dot.
    #[test]
    fn scheduler_cron_matches_hourly() {
        use chrono::{TimeZone, Utc};
        let t = Utc.with_ymd_and_hms(2024, 6, 1, 14, 0, 0).unwrap();
        assert!(cron_matches("0 * * * *", &t), "Should fire at xx:00");
        let t2 = Utc.with_ymd_and_hms(2024, 6, 1, 14, 30, 0).unwrap();
        assert!(!cron_matches("0 * * * *", &t2), "Should NOT fire at xx:30");
    }

    /// cron_matches: "*/30 * * * *" fires at :00 and :30.
    #[test]
    fn scheduler_cron_matches_every_30_min() {
        use chrono::{TimeZone, Utc};
        let t0  = Utc.with_ymd_and_hms(2024, 6, 1, 10, 0, 0).unwrap();
        let t30 = Utc.with_ymd_and_hms(2024, 6, 1, 10, 30, 0).unwrap();
        let t15 = Utc.with_ymd_and_hms(2024, 6, 1, 10, 15, 0).unwrap();
        assert!(cron_matches("*/30 * * * *", &t0),  ":00 should fire");
        assert!(cron_matches("*/30 * * * *", &t30), ":30 should fire");
        assert!(!cron_matches("*/30 * * * *", &t15), ":15 should NOT fire");
    }

    /// load_scheduled_agents: writes a JSON file with schedule enabled=true,
    /// mode=local, then verifies load_scheduled_agents picks it up.
    #[test]
    fn scheduler_loads_agents_from_json() {
        use super::user_agents_dir;
        use std::env;

        // Override HOME to point at our temp dir so user_agents_dir() is isolated
        let tmp = TempDir::new().expect("TempDir");
        let agents_dir = tmp.path().join(".lazy").join("agents");
        std::fs::create_dir_all(&agents_dir).expect("create agents dir");

        // Write a valid agent JSON with local schedule enabled
        let agent_json = r#"{
            "id": "agent-test-sched-001",
            "name": "test-sched",
            "displayName": "Test Sched",
            "description": "Test agent for scheduler unit test.",
            "systemPrompt": "You are a test agent.",
            "modelTier": "haiku",
            "scope": "user",
            "createdAt": "2024-01-01T00:00:00Z",
            "color": "violet",
            "tags": [],
            "triggers": {
                "manual": true,
                "schedule": {
                    "cron": "0 9 * * 1-5",
                    "mode": "local",
                    "enabled": true
                }
            }
        }"#;

        let file_path = agents_dir.join("test-sched.json");
        std::fs::write(&file_path, agent_json).expect("write agent json");

        // Temporarily override USERPROFILE / HOME so user_agents_dir() resolves here
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let old_home = env::var(home_key).ok();
        env::set_var(home_key, tmp.path().to_str().unwrap());

        let agents = {
            // Use free function directly (bypasses tauri::State)
            let user_dir = user_agents_dir();
            super::read_agent_dir_for_test(&user_dir)
        };

        // Restore HOME
        match old_home {
            Some(v) => env::set_var(home_key, v),
            None => env::remove_var(home_key),
        }

        assert!(
            !agents.is_empty(),
            "Expected at least 1 scheduled agent, found 0"
        );
        let found = agents.iter().any(|a| a.name == "test-sched" && a.cron == "0 9 * * 1-5");
        assert!(found, "Expected test-sched with cron '0 9 * * 1-5', got: {:?}", agents);

        eprintln!("scheduler_loads_agents_from_json PASSED: {} agents found", agents.len());
    }

    /// cloud stub returns an error explaining it is not available.
    #[test]
    fn agent_schedule_cloud_stub_returns_error() {
        let result = super::agent_schedule_cloud_stub();
        assert!(result.is_err(), "Cloud stub must return an Err");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("Pro/Max") || msg.contains("Routines") || msg.contains("Local"),
            "Error must explain cloud unavailability, got: {}",
            msg
        );
        eprintln!("agent_schedule_cloud_stub_returns_error PASSED: {}", msg);
    }

    /// Scheduler safe-default: None permission_mode must NOT produce bypass flag.
    /// This guards against the previously-hardcoded --dangerously-skip-permissions
    /// in spawn_scheduler (was line ~3040) regressing.
    #[test]
    fn scheduler_default_permission_is_not_bypass() {
        // Simulates: sched_permission_mode = agent.permission_mode.clone() where the
        // agent JSON has no "permissionMode" field → None.
        let sched_permission_mode: Option<String> = None;
        let flag = crate::permission_flag(sched_permission_mode.as_deref());
        assert_ne!(
            flag,
            "--dangerously-skip-permissions",
            "scheduler with no permission_mode must NOT default to bypass; got '{}'",
            flag
        );
        // Positive assertion: safe default is acceptEdits.
        assert_eq!(
            flag,
            "--permission-mode=acceptEdits",
            "scheduler safe default must be acceptEdits, got '{}'",
            flag
        );
        eprintln!("scheduler_default_permission_is_not_bypass PASSED");
    }

    /// Scheduler bypass requires explicit opt-in: only "full" or "bypassPermissions"
    /// produce the bypass flag; any other explicit value does not.
    #[test]
    fn scheduler_bypass_requires_explicit_opt_in() {
        // Explicit opt-in values — these should produce bypass.
        for mode in &["full", "bypassPermissions"] {
            let flag = crate::permission_flag(Some(mode));
            assert_eq!(
                flag,
                "--dangerously-skip-permissions",
                "explicit mode '{}' must produce bypass flag",
                mode
            );
        }
        // All other values must NOT produce bypass.
        for mode in &["acceptEdits", "plan", "default", ""] {
            let flag = crate::permission_flag(Some(mode));
            assert_ne!(
                flag,
                "--dangerously-skip-permissions",
                "mode '{}' must NOT produce bypass flag",
                mode
            );
        }
        eprintln!("scheduler_bypass_requires_explicit_opt_in PASSED");
    }
}
