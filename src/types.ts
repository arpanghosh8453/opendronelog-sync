export interface ProfileInfo {
  name: string;
  hasPassword: boolean;
}

export interface SwitchProfileResponse {
  name: string;
  session: string | null;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  size: number;
  modifiedMs: number;
  hash: string;
}

export type FileSyncStatus = "imported" | "uploaded" | "blacklisted" | "pending" | "uploading" | "error";

export interface SyncItem extends LocalFileEntry {
  status: FileSyncStatus;
  message?: string;
}

export interface UploadSyncResponse {
  success: boolean;
  statusCode: number;
  message: string;
  fileHash: string;
}
