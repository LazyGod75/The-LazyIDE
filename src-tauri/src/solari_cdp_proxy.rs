//! solari_cdp_proxy — local WebSocket proxy that strips `Origin` before
//! forwarding to `wss://api.getsolari.com` (C72).
//!
//! Solari's CDP gateway 403s any WebSocket handshake that carries an Origin
//! header. Browser WebSockets always send Origin, so Vite's `/solari-cdp`
//! proxy strips it in DEV. Packaged Tauri has no Vite, so this module binds
//! `127.0.0.1:<ephemeral>` and mirrors that Origin-strip behaviour.

use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, connect, Error as WsError};

const UPSTREAM_HOST: &str = "api.getsolari.com";
const UPSTREAM_BASE: &str = "wss://api.getsolari.com";

/// Shared handle exposing the bound local port to Tauri commands.
#[derive(Clone)]
pub struct SolariCdpProxyState {
    pub port: u16,
}

/// Bind `127.0.0.1:0`, spawn the accept loop, return the listening port.
pub fn start_solari_cdp_proxy() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("solari_cdp_proxy bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("solari_cdp_proxy local_addr failed: {e}"))?
        .port();

    thread::Builder::new()
        .name("solari-cdp-proxy".into())
        .spawn(move || accept_loop(listener))
        .map_err(|e| format!("solari_cdp_proxy spawn failed: {e}"))?;

    log::info!("solari_cdp_proxy listening on ws://127.0.0.1:{port}");
    Ok(port)
}

fn accept_loop(listener: TcpListener) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(move || {
                    if let Err(err) = handle_client(stream) {
                        log::warn!("solari_cdp_proxy client error: {err}");
                    }
                });
            }
            Err(err) => log::warn!("solari_cdp_proxy accept error: {err}"),
        }
    }
}

fn handle_client(stream: TcpStream) -> Result<(), String> {
    let path_q = Arc::new(Mutex::new(String::from("/")));
    let path_for_cb = Arc::clone(&path_q);
    let callback = move |req: &Request, response: Response| {
        let path = req.uri().path();
        let query = req.uri().query();
        let full = match query {
            Some(q) if !q.is_empty() => format!("{path}?{q}"),
            _ => path.to_string(),
        };
        if let Ok(mut slot) = path_for_cb.lock() {
            *slot = full;
        }
        Ok(response)
    };
    let mut local = accept_hdr(stream, callback).map_err(|e| format!("local accept: {e}"))?;
    let path = path_q
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "/".into());

    let upstream_url = format!("{UPSTREAM_BASE}{path}");
    let mut req = upstream_url
        .into_client_request()
        .map_err(|e| format!("upstream request: {e}"))?;
    // Critical: strip Origin so Solari accepts the handshake (mirrors Vite).
    req.headers_mut().remove("Origin");
    req.headers_mut().remove("origin");
    req.headers_mut().insert(
        "Host",
        UPSTREAM_HOST
            .parse()
            .map_err(|e| format!("host header: {e}"))?,
    );

    let (mut upstream, _) = connect(req).map_err(|e| format!("upstream connect: {e}"))?;

    // Non-blocking poll loop — avoids the half-duplex stall of two blocking readers.
    // Local is a plain TcpStream: set_nonblocking works directly.
    let _ = local.get_mut().set_nonblocking(true);
    // Upstream is MaybeTlsStream<TcpStream>: reach through the TLS layer to
    // set nonblocking on the underlying TcpStream. native-tls buffers decrypted
    // records internally, so a WouldBlock from the socket is propagated up as
    // an Io(WouldBlock) error by tungstenite's read() — exactly what the poll
    // loop below expects.
    match upstream.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(ref mut s) => {
            let _ = s.set_nonblocking(true);
        }
        tungstenite::stream::MaybeTlsStream::NativeTls(ref mut tls) => {
            let _ = tls.get_mut().set_nonblocking(true);
        }
        _ => {}
    }

    loop {
        let mut progress = false;

        match local.read() {
            Ok(msg) => {
                progress = true;
                if msg.is_close() {
                    let _ = upstream.close(None);
                    break;
                }
                if let Err(err) = upstream.send(msg) {
                    return Err(format!("upstream send: {err}"));
                }
            }
            Err(WsError::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(WsError::ConnectionClosed) | Err(WsError::AlreadyClosed) => break,
            Err(err) => return Err(format!("local read: {err}")),
        }

        match upstream.read() {
            Ok(msg) => {
                progress = true;
                if msg.is_close() {
                    let _ = local.close(None);
                    break;
                }
                if let Err(err) = local.send(msg) {
                    return Err(format!("local send: {err}"));
                }
            }
            Err(WsError::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(WsError::ConnectionClosed) | Err(WsError::AlreadyClosed) => break,
            Err(err) => return Err(format!("upstream read: {err}")),
        }

        if !progress {
            thread::sleep(Duration::from_millis(2));
        }
    }
    Ok(())
}

/// Tauri command — returns `ws://127.0.0.1:<port>` for the frontend CDP base.
#[tauri::command]
pub fn solari_cdp_proxy_base(state: tauri::State<'_, Arc<SolariCdpProxyState>>) -> String {
    format!("ws://127.0.0.1:{}", state.port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_and_reports_port() {
        let port = start_solari_cdp_proxy().expect("bind");
        assert!(port > 0);
        let _ = TcpStream::connect(("127.0.0.1", port));
    }
}
