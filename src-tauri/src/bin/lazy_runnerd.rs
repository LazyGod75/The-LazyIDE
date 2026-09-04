/* bin/lazy_runnerd.rs — Entry point for the lazy-runnerd daemon.

   P6.a: Detached mission runtime. Owns native mission execution
   independently of the UI process. Survives UI crashes/closes.

   Usage: lazy_runnerd
   Environment: LAZY_RUNNER_DATA_DIR (defaults to platform local data dir)
*/

use std::sync::Arc;
use std::sync::Mutex;
use std::collections::HashMap;

use app_lib::runner::singleinstance::SingleInstanceGuard;
use app_lib::runner::server::RunnerServer;
use app_lib::runner::RunnerConfig;

fn main() {
    let data_dir = std::env::var("LAZY_RUNNER_DATA_DIR").unwrap_or_else(|_| {
        #[cfg(windows)]
        {
            let local_app = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
            format!("{}\\lazy-ide", local_app)
        }
        #[cfg(not(windows))]
        {
            format!("{}/.local/share/lazy-ide", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
        }
    });

    let data_path = std::path::PathBuf::from(&data_dir);
    eprintln!("[lazy-runnerd] Data dir: {}", data_path.display());

    // Single-instance guard
    let _guard = match SingleInstanceGuard::acquire(&data_path) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[lazy-runnerd] {}", e);
            std::process::exit(0);
        }
    };

    // Derive config (port, token)
    let config = RunnerConfig::from_data_dir(data_path);
    eprintln!("[lazy-runnerd] Port: {}, Token: {}...", config.port, &config.token[..8]);

    // Shared PID state
    let pid_state: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));

    // Start HTTP server (blocking)
    let server = RunnerServer::new(config.port, config.token, pid_state);
    server.run();
}
