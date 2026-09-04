// Windows desktop `tauri build` embeds version resources via rc.exe (Windows SDK).
// If rc.exe is missing the build fails HERE — that is an environment gap, not a
// reason to delete the subprocess timeouts in capture.rs / maintenance.rs.
// Install the Windows SDK (Desktop development with C++) so those timeouts ship
// in the packaged binary. Do not skip this script: `tauri::generate_context!`
// depends on it.
fn main() {
  tauri_build::build()
}
