/* runner/server.rs — HTTP server for lazy-runnerd.

   Minimal HTTP server on 127.0.0.1 with bearer token auth.
   Endpoints:
   - GET  /health       → { pid, port, uptime, missions: N }
   - GET  /missions     → [{ id, lastSeq }]
   - POST /missions     → launch a mission (same fields as AgentRunRequest)
   - POST /missions/:id/kill → kill a running mission

   Uses tiny_http (blocking, no async-runtime entanglement — matches the
   codebase's "keep deps minimal" convention from sidecar.rs).
*/

use std::time::Instant;

use tiny_http::{Server, Request, Response, Header, StatusCode};

use super::RunnerPidState;

pub struct RunnerServer {
    port: u16,
    token: String,
    pid_state: RunnerPidState,
    start_time: Instant,
}

impl RunnerServer {
    pub fn new(port: u16, token: String, pid_state: RunnerPidState) -> Self {
        RunnerServer {
            port,
            token,
            pid_state,
            start_time: Instant::now(),
        }
    }

    /// Run the HTTP server (blocking — call from a dedicated thread).
    pub fn run(self) {
        let addr = format!("127.0.0.1:{}", self.port);
        let server = Server::http(&addr).unwrap_or_else(|e| {
            eprintln!("[lazy-runnerd] Failed to bind {}: {}", addr, e);
            std::process::exit(1);
        });

        eprintln!("[lazy-runnerd] Listening on {}", addr);

        let pid_state = self.pid_state.clone();
        let token = self.token.clone();
        let start_time = self.start_time;

        for request in server.incoming_requests() {
            handle_request(request, &token, &pid_state, start_time);
        }
    }
}

fn handle_request(
    request: Request,
    token: &str,
    pid_state: &RunnerPidState,
    start_time: Instant,
) {
    // Auth check
    if !check_auth(&request, token) {
        let resp = Response::empty(StatusCode::from(401));
        let _ = request.respond(resp);
        return;
    }

    let url = request.url().to_string();
    let method = request.method().as_str().to_string();

    match (method.as_str(), url.as_str()) {
        ("GET", "/health") => {
            let pid = std::process::id();
            let uptime = start_time.elapsed().as_secs();
            let mission_count = pid_state.lock()
                .map(|m| m.len())
                .unwrap_or(0);
            let body = serde_json::json!({
                "pid": pid,
                "port": 0, // TODO: actual port
                "uptime": uptime,
                "missions": mission_count,
            }).to_string();
            let _ = request.respond(Response::from_string(body)
                .with_header(Header::from_bytes("content-type", "application/json").unwrap()));
        }
        ("GET", "/missions") => {
            let missions: Vec<_> = pid_state.lock()
                .map(|m| {
                    m.iter().map(|(id, pid)| {
                        serde_json::json!({ "id": id, "pid": pid })
                    }).collect()
                })
                .unwrap_or_default();
            let body = serde_json::json!(missions).to_string();
            let _ = request.respond(Response::from_string(body)
                .with_header(Header::from_bytes("content-type", "application/json").unwrap()));
        }
        ("POST", "/missions") => {
            // TODO: P6.a — spawn the mission process (extracted from agent.rs)
            // For now, return 501 Not Implemented
            let _ = request.respond(Response::empty(StatusCode::from(501)));
        }
        ("POST", path) if path.ends_with("/kill") => {
            let mission_id = path
                .strip_prefix("/missions/")
                .and_then(|p| p.strip_suffix("/kill"))
                .unwrap_or("");
            let pid = pid_state.lock()
                .ok()
                .and_then(|mut m| m.remove(mission_id));
            if let Some(pid) = pid {
                // Tree-kill the process
                kill_process_tree(pid);
                let body = serde_json::json!({ "killed": true, "pid": pid }).to_string();
                let _ = request.respond(Response::from_string(body));
            } else {
                let _ = request.respond(Response::empty(StatusCode::from(404)));
            }
        }
        _ => {
            let _ = request.respond(Response::empty(StatusCode::from(404)));
        }
    }
}

fn check_auth(request: &Request, token: &str) -> bool {
    if let Some(auth_header) = request.headers().iter().find(|h| h.field.equiv("Authorization")) {
        let value = auth_header.value.as_str();
        if let Some(bearer) = value.strip_prefix("Bearer ") {
            return bearer == token;
        }
    }
    false
}

fn kill_process_tree(pid: u32) {
    // Reuse the same tree-kill pattern as agent.rs
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}
