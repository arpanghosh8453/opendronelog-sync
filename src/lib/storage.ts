const KEY = "odl-sync-config-v1";

export interface AppConfig {
  serverUrl: string;
  activeProfile: string;
  sessionToken: string;
  syncFolder: string;
  theme: "light" | "dark";
  /** Android only: keep syncing in a background service that also starts on boot. */
  autoSync: boolean;
  /** Android only: keep the profile password (Keystore-encrypted, native side) to re-login after a 401. */
  rememberPassword: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  serverUrl: "",
  activeProfile: "",
  sessionToken: "",
  syncFolder: "",
  theme: "dark",
  autoSync: false,
  rememberPassword: false,
};

export function loadConfig(): AppConfig {
  const raw = localStorage.getItem(KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      serverUrl: parsed.serverUrl ?? "",
      activeProfile: parsed.activeProfile ?? "",
      sessionToken: parsed.sessionToken ?? "",
      syncFolder: parsed.syncFolder ?? "",
      theme: parsed.theme === "light" ? "light" : "dark",
      autoSync: parsed.autoSync === true,
      rememberPassword: parsed.rememberPassword === true,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}
