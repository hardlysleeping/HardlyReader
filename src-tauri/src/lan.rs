//! Serving the app to the rest of the house.
//!
//! The reader is a web app: the same bundle runs in the desktop shell, in a
//! browser, and on a phone. This is the piece that makes the last one possible —
//! a small HTTP server over the assets already compiled into the binary, so a
//! phone on the same network can open the reader and add it to its home screen.
//!
//! Three rules keep it honest:
//!
//! * It serves the shell and nothing else. The posts, the session and the server
//!   address stay in whichever browser opened it, exactly as they do in a tab.
//! * It is off unless asked for, and it stops when the window closes.
//! * It answers on one port, chosen by the user, and says which address it is on
//!   so nobody has to guess an IP.
//!
//! Deliberately plain HTTP: this is a home network, and a self-signed certificate
//! that every phone refuses is worse than a URL that works.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tiny_http::{Header, Response, Server};

/// The default port. Uncommon enough not to collide with a dev server, easy to
/// say out loud.
pub const DEFAULT_PORT: u16 = 8450;

/// What a path resolves to: the bytes and the mime type, or nothing.
type Lookup = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

struct Running {
    url: String,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct LanState(Mutex<Option<Running>>);

/// The address this machine has on the network, or None if it is offline.
///
/// A UDP socket is connected and never used: `connect` on UDP sends nothing, it
/// only asks the routing table which interface would reach the outside world —
/// which is exactly the address a phone on the same network can reach.
fn lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// Starts a server on `port` and returns the stop flag, or the reason it could
/// not bind. Split out from the Tauri command so it can be tested over a socket
/// with no window and no webview.
fn spawn(port: u16, lookup: Lookup) -> Result<Arc<AtomicBool>, String> {
    let server = Server::http(("0.0.0.0", port))
        .map_err(|error| format!("port {port} could not be opened: {error}"))?;
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));

    let flag = Arc::clone(&stop);
    std::thread::spawn(move || {
        // A short poll so a stop request is noticed promptly without a second
        // socket whose only job is to wake the loop.
        while !flag.load(Ordering::Relaxed) {
            let request = match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => request,
                Ok(None) => continue,
                Err(_) => break,
            };
            answer(&lookup, request);
        }
    });

    Ok(stop)
}

/// Starts the server if it is not already running, and returns the URL to open.
#[tauri::command]
pub fn lan_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanState>,
    port: Option<u16>,
) -> Result<String, String> {
    let mut slot = state.0.lock().map_err(|_| "the server is in a bad state".to_string())?;
    if let Some(running) = slot.as_ref() {
        return Ok(running.url.clone());
    }

    let port = port.unwrap_or(DEFAULT_PORT);
    // The lookup is the whole of the app's knowledge: the assets Tauri compiled
    // into this binary. Nothing is read from the disk beside the binary.
    let resolver = app.asset_resolver();
    let lookup: Lookup = Arc::new(move |path: &str| {
        resolver
            .get(path.to_string())
            .map(|asset| (asset.bytes.to_vec(), asset.mime_type))
    });

    let stop = spawn(port, lookup)?;
    let ip = lan_ip().map(|ip| ip.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let url = format!("http://{ip}:{port}/");

    *slot = Some(Running { url: url.clone(), stop });
    Ok(url)
}

#[tauri::command]
pub fn lan_stop(state: tauri::State<'_, LanState>) -> Result<(), String> {
    stop(&state)
}

/// Stops the server. Also called when the window goes away: a reader that was
/// shared for a minute should not still be shared after it is closed.
pub fn stop(state: &LanState) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "the server is in a bad state".to_string())?;
    if let Some(running) = slot.take() {
        running.stop.store(true, Ordering::Relaxed);
        // The thread is detached on purpose: it holds one socket, it is asleep in
        // a 200ms poll, and joining it would block whatever turned it off.
    }
    Ok(())
}

/// Whether the server is up, and where it is.
#[tauri::command]
pub fn lan_status(state: tauri::State<'_, LanState>) -> Result<Option<String>, String> {
    let slot = state.0.lock().map_err(|_| "the server is in a bad state".to_string())?;
    Ok(slot.as_ref().map(|running| running.url.clone()))
}

fn answer(lookup: &Lookup, request: tiny_http::Request) {
    let raw = request.url().to_string();
    // Query strings are the page's business, not the file's.
    let path = raw.split(['?', '#']).next().unwrap_or("/");
    let path = path.trim_start_matches('/');
    let wanted = if path.is_empty() { "index.html" } else { path };

    // A single-page app: any path that is not a file is a route, so it gets the
    // shell and the router decides. Without this, refreshing on a route 404s.
    let asset = lookup(wanted).or_else(|| lookup("index.html"));

    match asset {
        Some((bytes, mime)) => {
            let header = Header::from_bytes(&b"Content-Type"[..], mime.as_bytes().to_vec())
                .expect("a literal header name and a mime type");
            let _ = request.respond(Response::from_data(bytes).with_header(header));
        }
        None => {
            let _ = request.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// A lookup over a map, standing in for the compiled-in assets.
    fn files() -> Lookup {
        let mut map: HashMap<String, (Vec<u8>, String)> = HashMap::new();
        map.insert(
            "index.html".into(),
            (b"<html>shell</html>".to_vec(), "text/html".to_string()),
        );
        map.insert(
            "app.js".into(),
            (b"console.log(1)".to_vec(), "text/javascript".to_string()),
        );
        Arc::new(move |path: &str| map.get(path).cloned())
    }

    /// A port from the kernel, so a test never collides with a real one.
    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        listener.local_addr().expect("an address").port()
    }

    fn get(port: u16, path: &str) -> (String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connected");
        write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .expect("request written");
        let mut text = String::new();
        stream.read_to_string(&mut text).expect("response read");
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
        (head.to_string(), body.to_string())
    }

    #[test]
    fn serves_a_file_with_its_type() {
        let port = free_port();
        let stop = spawn(port, files()).expect("server started");
        let (head, body) = get(port, "/app.js");
        stop.store(true, Ordering::Relaxed);
        assert!(head.contains("200 OK"), "{head}");
        assert!(
            head.to_lowercase().contains("content-type: text/javascript"),
            "{head}"
        );
        assert_eq!(body, "console.log(1)");
    }

    #[test]
    fn a_route_gets_the_shell_rather_than_a_404() {
        let port = free_port();
        let stop = spawn(port, files()).expect("server started");
        let (head, body) = get(port, "/feed/123?x=1");
        stop.store(true, Ordering::Relaxed);
        assert!(head.contains("200 OK"), "{head}");
        assert_eq!(body, "<html>shell</html>");
    }

    #[test]
    fn the_root_is_the_shell() {
        let port = free_port();
        let stop = spawn(port, files()).expect("server started");
        let (head, body) = get(port, "/");
        stop.store(true, Ordering::Relaxed);
        assert!(head.contains("200 OK"), "{head}");
        assert_eq!(body, "<html>shell</html>");
    }

    #[test]
    fn stopping_closes_the_socket() {
        let port = free_port();
        let stop = spawn(port, files()).expect("server started");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        stop.store(true, Ordering::Relaxed);
        // The loop wakes, notices, and drops the server, which releases the port.
        let mut still_open = true;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            if TcpStream::connect(("127.0.0.1", port)).is_err() {
                still_open = false;
                break;
            }
        }
        assert!(!still_open, "the port is still open after a stop");
    }

    #[test]
    fn a_port_already_in_use_is_refused_rather_than_moved() {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = probe.local_addr().expect("an address").port();
        drop(probe);
        let held = std::net::TcpListener::bind(("0.0.0.0", port)).expect("held");
        let refused = spawn(port, files());
        drop(held);
        assert!(refused.is_err(), "the server claimed a port that was in use");
    }
}
