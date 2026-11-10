const COMMANDS: &[&str] = &[
    "configure",
    "get_status",
    "relogin",
    "clear_password",
    "request_storage_access",
    "sync_now",
    "find_log_folders",
    "grant_folder_access",
    "scan_folder",
    "upload_file",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
