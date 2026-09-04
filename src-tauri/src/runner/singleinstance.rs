/* runner/singleinstance.rs — Single-instance guard for lazy-runnerd.

   Reuses the BrainSidecar lock pattern: an RAII lock file + state file
   under <app_local_data_dir>/lazy-runnerd/. If a stale runner is found
   (pid no longer alive), it's reclaimed.
*/

use std::fs;
use std::path::{Path, PathBuf};
use std::process;

pub struct SingleInstanceGuard {
    lock_file: PathBuf,
    _file: fs::File,
}

impl SingleInstanceGuard {
    /// Attempt to acquire the single-instance lock.
    /// Returns Ok(guard) if this is the only instance, or Err if another
    /// live instance is already running.
    pub fn acquire(dir: &Path) -> Result<Self, String> {
        let lock_file = dir.join("runner.lock");

        // Check for stale instance
        let state_file = dir.join("state.json");
        if let Ok(content) = fs::read_to_string(&state_file) {
            let v: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
            if let Some(pid) = v.get("pid").and_then(|p| p.as_u64()) {
                if is_pid_alive(pid as u32) {
                    return Err(format!("lazy-runnerd already running (pid {})", pid));
                }
                // Stale — reclaim
            }
        }

        // Create/truncate lock file
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&lock_file)
            .map_err(|e| format!("Failed to create lock file: {}", e))?;

        // Write our pid
        let pid = process::id();
        let state = serde_json::json!({ "pid": pid });
        let _ = fs::write(&state_file, state.to_string());

        Ok(SingleInstanceGuard { lock_file, _file: file })
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        // Clean up lock file on exit
        let _ = fs::remove_file(&self.lock_file);
    }
}

fn is_pid_alive(pid: u32) -> bool {
    // On Windows: OpenProcess would be the right call, but sysinfo is already
    // a dependency. On Unix: kill(pid, 0) == 0 means alive.
    #[cfg(windows)]
    {
        use sysinfo::{System, Pid, ProcessesToUpdate};
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        sys.process(Pid::from(pid as usize)).is_some()
    }
    #[cfg(not(windows))]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
