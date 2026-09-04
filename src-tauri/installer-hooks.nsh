; Custom NSIS installer hooks for Lazy.
;
; Why this exists:
; The app spawns a LazyBrain sidecar (resources/node.exe) that loads
; better_sqlite3.node and keeps the brain SQLite DB open. If that sidecar is
; still running (e.g. the app crashed, was force-closed, or an orphan survived
; a previous session), Windows locks those files and the installer fails with
; "error opening file for writing ... better_sqlite3.node".
;
; The default Tauri template only kills the main binary (lazy-ide.exe), never
; the node sidecar. These hooks kill ANY process running from the install dir
; ($INSTDIR) right before files are written, then again before uninstall.
;
; Scoped strictly to $INSTDIR so the user's other node.exe processes
; (e.g. C:\Program Files\nodejs\node.exe) are never touched.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing LazyBrain sidecar processes (if any) before install..."
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=$\'SilentlyContinue$\'; Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.ToLower().StartsWith(($\'$INSTDIR$\').ToLower()) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing LazyBrain sidecar processes (if any) before uninstall..."
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=$\'SilentlyContinue$\'; Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.ToLower().StartsWith(($\'$INSTDIR$\').ToLower()) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
