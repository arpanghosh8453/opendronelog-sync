//! Android background sync and opt-in saved login for OpenDronelog Sync.
//!
//! All real work happens in the Kotlin side (`android/`): a foreground service that
//! starts on boot, watches the log folder and uploads finished logs, plus an
//! Android Keystore-backed password store used only to re-login after a 401.
//! These Rust commands just forward calls from the web UI to that Kotlin plugin.
//! On desktop every command returns an "only available on Android" error.

use serde_json::Value;
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.opendronelog.bgsync";

#[cfg(target_os = "android")]
struct BgSync<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
async fn forward<R: Runtime>(app: &AppHandle<R>, method: &str, payload: Value) -> Result<Value, String> {
    let handle = app.state::<BgSync<R>>();
    handle
        .0
        .run_mobile_plugin_async::<Value>(method, payload)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn forward<R: Runtime>(_app: &AppHandle<R>, _method: &str, _payload: Value) -> Result<Value, String> {
    Err("Background sync is only available on Android".to_string())
}

fn payload_or_empty(payload: Option<Value>) -> Value {
    payload.unwrap_or_else(|| Value::Object(Default::default()))
}

#[tauri::command]
async fn configure<R: Runtime>(app: AppHandle<R>, payload: Option<Value>) -> Result<Value, String> {
    forward(&app, "configure", payload_or_empty(payload)).await
}

#[tauri::command]
async fn get_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "getStatus", payload_or_empty(None)).await
}

#[tauri::command]
async fn relogin<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "relogin", payload_or_empty(None)).await
}

#[tauri::command]
async fn clear_password<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "clearPassword", payload_or_empty(None)).await
}

#[tauri::command]
async fn request_storage_access<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "requestStorageAccess", payload_or_empty(None)).await
}

#[tauri::command]
async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "syncNow", payload_or_empty(None)).await
}

#[tauri::command]
async fn find_log_folders<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "findLogFolders", payload_or_empty(None)).await
}

#[tauri::command]
async fn grant_folder_access<R: Runtime>(app: AppHandle<R>, payload: Option<Value>) -> Result<Value, String> {
    forward(&app, "grantFolderAccess", payload_or_empty(payload)).await
}

#[tauri::command]
async fn scan_folder<R: Runtime>(app: AppHandle<R>, payload: Option<Value>) -> Result<Value, String> {
    forward(&app, "scanFolder", payload_or_empty(payload)).await
}

#[tauri::command]
async fn upload_file<R: Runtime>(app: AppHandle<R>, payload: Option<Value>) -> Result<Value, String> {
    forward(&app, "uploadFile", payload_or_empty(payload)).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bgsync")
        .invoke_handler(tauri::generate_handler![
            configure,
            get_status,
            relogin,
            clear_password,
            request_storage_access,
            sync_now,
            find_log_folders,
            grant_folder_access,
            scan_folder,
            upload_file
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "BgSyncPlugin")?;
                _app.manage(BgSync(handle));
            }
            Ok(())
        })
        .build()
}
