import { invoke } from "@tauri-apps/api/core";
import type { LocalFileEntry, UploadSyncResponse } from "../types";

/** Status reported by the Android background sync plugin (src-tauri/plugins/tauri-plugin-bgsync). */
export interface BgSyncStatus {
  autoSync: boolean;
  serviceRunning: boolean;
  rememberPassword: boolean;
  hasSavedPassword: boolean;
  needsLogin: boolean;
  storageAccess: boolean;
  androidVersion: string;
  pilotFolder: string;
  pilotFolderExists: boolean;
  lastSyncAt: number;
  lastSyncOk: boolean;
  lastSyncMessage: string;
}

export interface BgSyncConfig {
  serverUrl: string;
  profile: string;
  sessionToken: string;
  folder: string;
  autoSync: boolean;
  rememberPassword: boolean;
  /** Only pass right after a successful manual login with "remember password" ticked. */
  password?: string;
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export async function configureBgSync(config: BgSyncConfig): Promise<BgSyncStatus> {
  return invoke<BgSyncStatus>("plugin:bgsync|configure", { payload: config });
}

export async function getBgSyncStatus(): Promise<BgSyncStatus> {
  return invoke<BgSyncStatus>("plugin:bgsync|get_status");
}

/** One re-login attempt with the saved password. Resolves to the new session token. */
export async function reloginWithSavedPassword(): Promise<string> {
  const result = await invoke<{ session: string }>("plugin:bgsync|relogin");
  return result.session ?? "";
}

export async function clearSavedPassword(): Promise<BgSyncStatus> {
  return invoke<BgSyncStatus>("plugin:bgsync|clear_password");
}

export async function requestStorageAccess(): Promise<BgSyncStatus> {
  return invoke<BgSyncStatus>("plugin:bgsync|request_storage_access");
}

export interface FoundLogFolder {
  path: string;
  /** False when Android blocks this app from reading it (DJI Fly's Android/data folder on Android 11+). */
  readable: boolean;
  /** Number of .txt files directly in the folder. */
  logCount: number;
  newestLogMs: number;
  /** e.g. DJIFlightRecord_2025-06-15_[13-36-13].txt (Pilot 2) or FlightRecord_2026-11-04_[13-03-25].txt (DJI Fly); empty when the folder has no logs yet. */
  newestLogName: string;
  /** DJI app the folder belongs to, e.g. com.dji.industry.pilot (Pilot 2) or dji.go.v5 (DJI Fly). */
  app: string;
}

/** Searches internal storage and SD cards for DJI FlightRecord folders, best match first. */
export async function findLogFolders(): Promise<{ folders: FoundLogFolder[]; storageAccess: boolean }> {
  return invoke("plugin:bgsync|find_log_folders");
}

const NATIVE_FOLDER_KEY = "odlSyncNativeFolderUri";

/**
 * Opens Android's folder picker at `path` (e.g. DJI Fly's blocked FlightRecord folder) so the user can
 * allow access once. Resolves to the content:// tree URI to use as the sync folder.
 */
export async function grantFolderAccess(path: string): Promise<string> {
  const result = await invoke<{ folder: string }>("plugin:bgsync|grant_folder_access", { payload: { path } });
  try {
    localStorage.setItem(NATIVE_FOLDER_KEY, result.folder);
  } catch {
    // no-op: only affects which scanner the dashboard uses
  }
  return result.folder;
}

/** True when `folder` is a picker grant made by grantFolderAccess (read natively, not via android-fs). */
export function isNativeFolder(folder: string): boolean {
  try {
    return Boolean(folder) && localStorage.getItem(NATIVE_FOLDER_KEY) === folder;
  } catch {
    return false;
  }
}

/** Lists a picker-granted folder's files with SHA-256 hashes. */
export async function scanNativeFolder(folder: string, extensions: string[]): Promise<LocalFileEntry[]> {
  const result = await invoke<{ files: LocalFileEntry[] }>("plugin:bgsync|scan_folder", {
    payload: { folder, extensions },
  });
  return result.files ?? [];
}

/** Uploads one file from a picker-granted folder with the stored session. */
export async function uploadNativeFile(path: string): Promise<UploadSyncResponse> {
  return invoke<UploadSyncResponse>("plugin:bgsync|upload_file", { payload: { path } });
}

export async function backgroundSyncNow(): Promise<BgSyncStatus> {
  return invoke<BgSyncStatus>("plugin:bgsync|sync_now");
}
