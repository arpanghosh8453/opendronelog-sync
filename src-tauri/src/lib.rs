use notify::{Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use reqwest::multipart;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
const MAX_SCAN_FILES: usize = 2000;
const MAX_SCAN_DURATION: Duration = Duration::from_secs(8);

#[derive(Default)]
struct AppState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileEntry {
    name: String,
    path: String,
    size: u64,
    modified_ms: u64,
    hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadSyncResponse {
    success: bool,
    status_code: u16,
    message: String,
    file_hash: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFolderChangeEvent {
    path: String,
    kind: String,
}

fn normalize_extension_set(exts: &[String]) -> std::collections::HashSet<String> {
    exts.iter()
        .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn debug_log(message: &str) {
    eprintln!("[odl-sync][rust] {}", message);
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed reading {}: {}", path.display(), e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn has_allowed_extension(path: &Path, allowed_extensions: &std::collections::HashSet<String>) -> bool {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    allowed_extensions.contains(&extension)
}

fn is_relevant_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    )
}

#[tauri::command]
fn start_sync_watcher(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    folder_path: String,
    allowed_extensions: Vec<String>,
) -> Result<bool, String> {
    debug_log(&format!(
        "start_sync_watcher called folder={} extensions={}",
        folder_path,
        allowed_extensions.join(",")
    ));

    let root = PathBuf::from(folder_path.trim());
    if !root.exists() {
        debug_log("start_sync_watcher failed: folder does not exist");
        return Err("Selected sync folder does not exist".to_string());
    }
    if !root.is_dir() {
        debug_log("start_sync_watcher failed: path is not directory");
        return Err("Selected sync path is not a directory".to_string());
    }

    let allowed = Arc::new(normalize_extension_set(&allowed_extensions));
    let root_dir = Arc::new(root.clone());
    let last_emit_at = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(2)));

    let app_for_events = app.clone();
    let allowed_for_events = Arc::clone(&allowed);
    let root_for_events = Arc::clone(&root_dir);
    let last_emit_for_events = Arc::clone(&last_emit_at);

    let mut watcher = RecommendedWatcher::new(
        move |event_result: notify::Result<Event>| {
            let event = match event_result {
                Ok(v) => v,
                Err(e) => {
                    debug_log(&format!("watcher event error: {}", e));
                    return;
                }
            };

            if !is_relevant_event(&event) {
                return;
            }

            let mut changed_path = String::new();
            let mut matched = false;

            for path in &event.paths {
                if !path.starts_with(root_for_events.as_path()) {
                    continue;
                }

                let is_remove = matches!(event.kind, EventKind::Remove(_));
                if is_remove || has_allowed_extension(path, &allowed_for_events) {
                    changed_path = path.to_string_lossy().to_string();
                    matched = true;
                    break;
                }
            }

            if !matched {
                return;
            }

            // Debounce watcher burst events to avoid excessive rescans.
            if let Ok(mut last_emit) = last_emit_for_events.lock() {
                if last_emit.elapsed() < Duration::from_millis(750) {
                    return;
                }
                *last_emit = Instant::now();
            }

            let _ = app_for_events.emit(
                "sync-folder-changed",
                SyncFolderChangeEvent {
                    path: changed_path,
                    kind: format!("{:?}", event.kind),
                },
            );
            debug_log(&format!("watcher emitted sync-folder-changed kind={:?}", event.kind));
        },
        NotifyConfig::default().with_poll_interval(Duration::from_secs(2)),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(root_dir.as_path(), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch folder: {}", e))?;

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Watcher lock poisoned".to_string())?;
    *guard = Some(watcher);

    debug_log("start_sync_watcher success");

    Ok(true)
}

#[tauri::command]
fn stop_sync_watcher(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Watcher lock poisoned".to_string())?;
    *guard = None;
    debug_log("stop_sync_watcher success");
    Ok(true)
}

#[tauri::command]
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn pick_sync_folder_native() -> Result<Option<String>, String> {
    debug_log("pick_sync_folder_native called");
    let picked = rfd::FileDialog::new().set_title("Select Sync Folder").pick_folder();
    let result = picked.map(|p| p.to_string_lossy().to_string());
    debug_log(&format!("pick_sync_folder_native result={}", result.as_deref().unwrap_or("<cancelled>")));
    Ok(result)
}

#[tauri::command]
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn pick_sync_folder_native() -> Result<Option<String>, String> {
    debug_log("pick_sync_folder_native unsupported on this platform");
    Ok(None)
}

#[tauri::command]
fn scan_sync_folder(folder_path: String, allowed_extensions: Vec<String>) -> Result<Vec<LocalFileEntry>, String> {
    debug_log(&format!(
        "scan_sync_folder called folder={} extensions={}",
        folder_path,
        allowed_extensions.join(",")
    ));
    let root = PathBuf::from(folder_path.trim());
    if !root.exists() {
        debug_log("scan_sync_folder failed: folder does not exist");
        return Err("Selected sync folder does not exist".to_string());
    }
    if !root.is_dir() {
        debug_log("scan_sync_folder failed: path is not directory");
        return Err("Selected sync path is not a directory".to_string());
    }

    let ext_set = normalize_extension_set(&allowed_extensions);
    let mut files = Vec::new();

    let started_at = Instant::now();
    let mut scanned_allowed = 0usize;
    let mut scanned_total = 0usize;
    let mut skipped_errors = 0usize;

    let entries = std::fs::read_dir(&root)
        .map_err(|e| format!("Failed to read sync folder {}: {}", root.display(), e))?;

    for entry in entries {
        if started_at.elapsed() > MAX_SCAN_DURATION {
            debug_log(&format!(
                "scan_sync_folder cut short by timeout after {}ms scanned_total={} allowed={} collected={}",
                started_at.elapsed().as_millis(),
                scanned_total,
                scanned_allowed,
                files.len()
            ));
            break;
        }

        if scanned_total >= MAX_SCAN_FILES {
            debug_log(&format!(
                "scan_sync_folder cut short by file limit={} scanned_total={} allowed={} collected={}",
                MAX_SCAN_FILES,
                scanned_total,
                scanned_allowed,
                files.len()
            ));
            break;
        }

        let entry = match entry {
            Ok(v) => v,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };

        scanned_total += 1;

        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };

        if !file_type.is_file() {
            continue;
        }

        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|v| v.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        if !ext_set.contains(&extension) {
            continue;
        }

        scanned_allowed += 1;

        let metadata = match std::fs::metadata(&path) {
            Ok(v) => v,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };

        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let hash = match file_hash(&path) {
            Ok(v) => v,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };

        files.push(LocalFileEntry {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string(),
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
            modified_ms,
            hash,
        });
    }

    files.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    debug_log(&format!(
        "scan_sync_folder success count={} scanned_total={} allowed={} skipped_errors={} elapsed_ms={}",
        files.len(),
        scanned_total,
        scanned_allowed,
        skipped_errors,
        started_at.elapsed().as_millis()
    ));
    Ok(files)
}

#[tauri::command]
async fn upload_sync_file(
    server_url: String,
    profile: String,
    session_token: Option<String>,
    file_path: String,
) -> Result<UploadSyncResponse, String> {
    debug_log(&format!(
        "upload_sync_file called server={} profile={} file={}",
        server_url,
        profile,
        file_path
    ));
    let clean_base = server_url.trim().trim_end_matches('/');
    if clean_base.is_empty() {
        debug_log("upload_sync_file failed: missing server URL");
        return Err("Missing server URL".to_string());
    }

    let file_path = PathBuf::from(file_path.trim());
    if !file_path.exists() {
        debug_log("upload_sync_file failed: file missing");
        return Err(format!("File does not exist: {}", file_path.display()));
    }

    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file {}: {}", file_path.display(), e))?;
    let hash = file_hash(&file_path)?;

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("log.bin")
        .to_string();

    let file_part = multipart::Part::bytes(bytes).file_name(file_name);
    let form = multipart::Form::new().part("file", file_part);

    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{}/api/import", clean_base))
        .header("X-Profile", profile)
        .multipart(form);

    if let Some(token) = session_token {
        if !token.trim().is_empty() {
            request = request.header("X-Session", token);
        }
    }

    let response = request.send().await.map_err(|e| format!("Upload request failed: {}", e))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| "".to_string());

    debug_log(&format!("upload_sync_file response status={} file={}", status.as_u16(), file_path.display()));

    Ok(UploadSyncResponse {
        success: status.is_success(),
        status_code: status.as_u16(),
        message: if body.is_empty() {
            status
                .canonical_reason()
                .unwrap_or("Unknown response")
                .to_string()
        } else {
            body
        },
        file_hash: hash,
    })
}

#[tauri::command]
async fn upload_sync_file_bytes(
    server_url: String,
    profile: String,
    session_token: Option<String>,
    file_name: String,
    file_bytes: Vec<u8>,
) -> Result<UploadSyncResponse, String> {
    debug_log(&format!(
        "upload_sync_file_bytes called server={} profile={} file={} size={}",
        server_url,
        profile,
        file_name,
        file_bytes.len()
    ));

    let clean_base = server_url.trim().trim_end_matches('/');
    if clean_base.is_empty() {
        debug_log("upload_sync_file_bytes failed: missing server URL");
        return Err("Missing server URL".to_string());
    }

    if file_bytes.is_empty() {
        return Err("Selected mobile file is empty or unavailable".to_string());
    }

    let hash = bytes_hash(&file_bytes);
    let safe_name = if file_name.trim().is_empty() {
        "mobile-log.bin".to_string()
    } else {
        file_name
    };

    let file_part = multipart::Part::bytes(file_bytes).file_name(safe_name);
    let form = multipart::Form::new().part("file", file_part);

    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{}/api/import", clean_base))
        .header("X-Profile", profile)
        .multipart(form);

    if let Some(token) = session_token {
        if !token.trim().is_empty() {
            request = request.header("X-Session", token);
        }
    }

    let response = request.send().await.map_err(|e| format!("Upload request failed: {}", e))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| "".to_string());

    Ok(UploadSyncResponse {
        success: status.is_success(),
        status_code: status.as_u16(),
        message: if body.is_empty() {
            status
                .canonical_reason()
                .unwrap_or("Unknown response")
                .to_string()
        } else {
            body
        },
        file_hash: hash,
    })
}

#[tauri::command]
fn get_default_mobile_sync_folder(app: AppHandle) -> Result<String, String> {
    debug_log("get_default_mobile_sync_folder called");
    let mut dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("Unable to access document directory: {}", e))?;
    dir.push("opendronelog-sync");
    dir.push("sync");

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Unable to create sync folder {}: {}", dir.display(), e))?;

    debug_log(&format!("get_default_mobile_sync_folder resolved {}", dir.display()));
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_android_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_sync_folder,
            upload_sync_file,
            upload_sync_file_bytes,
            get_default_mobile_sync_folder,
            pick_sync_folder_native,
            start_sync_watcher,
            stop_sync_watcher
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
