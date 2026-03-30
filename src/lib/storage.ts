const KEY = "odl-sync-config-v1";

export interface AppConfig {
  serverUrl: string;
  activeProfile: string;
  sessionToken: string;
  syncFolder: string;
  theme: "light" | "dark";
}

const DEFAULT_CONFIG: AppConfig = {
  serverUrl: "",
  activeProfile: "",
  sessionToken: "",
  syncFolder: "",
  theme: "dark",
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
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}
