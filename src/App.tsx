import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  Moon,
  RefreshCw,
  Server,
  Settings,
  Sun,
  Upload,
  User,
} from "lucide-react";
import { getAllowedExtensions, getServerFileHashes, getSyncBlacklist, listProfiles, switchProfile } from "./lib/api";
import { normalizeServerUrl, isLikelyMobile, serverUrlProblem } from "./lib/platform";
import { loadConfig, saveConfig, type AppConfig } from "./lib/storage";
import {
  backgroundSyncNow,
  clearSavedPassword,
  configureBgSync,
  findLogFolders,
  getBgSyncStatus,
  grantFolderAccess,
  isNativeFolder,
  scanNativeFolder,
  uploadNativeFile,
  isAndroid,
  reloginWithSavedPassword,
  requestStorageAccess,
  type BgSyncStatus,
  type FoundLogFolder,
} from "./lib/bgsync";
import type { LocalFileEntry, ProfileInfo, SyncItem, UploadSyncResponse } from "./types";
import "./App.css";

type Screen = "server" | "login" | "folder" | "dashboard";

type SyncProgressState = {
  active: boolean;
  percent: number;
  label: string;
};

type InitProgressState = {
  percent: number;
  label: string;
};

const STATUS_ORDER = ["pending", "uploaded", "imported", "blacklisted"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
const MOBILE_SYNC_URI_KEY = "odlSyncMobileUri";

type AndroidFsUri = {
  uri: string;
  documentTopTreeUri: string | null;
};

type AndroidFsEntry = {
  type: "Dir" | "File";
  name: string;
  uri: AndroidFsUri;
  mimeType?: string;
};

type AndroidFsModule = {
  AndroidFs: {
    showOpenDirPicker: (options?: { localOnly?: boolean }) => Promise<AndroidFsUri | null>;
    persistPickerUriPermission: (uri: AndroidFsUri) => Promise<void>;
    checkPersistedPickerUriPermission: (uri: AndroidFsUri, state: string) => Promise<boolean>;
    readDir: (uri: AndroidFsUri, options?: { offset?: number; limit?: number }) => Promise<AndroidFsEntry[]>;
    readFile: (uri: AndroidFsUri) => Promise<Uint8Array>;
  };
  AndroidUriPermissionState: {
    ReadOrWrite: string;
  };
  isAndroid: () => boolean;
};

type MobileFilePayload = {
  name: string;
  bytes: Uint8Array;
};

function debugLog(event: string, details?: Record<string, unknown>): void {
  const payload = {
    t: new Date().toISOString(),
    event,
    ...(details ?? {}),
  };
  // Detailed logs for debugging auth/sync/picker issues.
  console.debug("[odl-sync]", payload);
}

function App() {
  const [config, setConfig] = useState<AppConfig>(loadConfig());
  const [screen, setScreen] = useState<Screen>("server");
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [password, setPassword] = useState("");
  const [serverInput, setServerInput] = useState(config.serverUrl);
  const [folderInput, setFolderInput] = useState(config.syncFolder);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>([]);
  const [files, setFiles] = useState<SyncItem[]>([]);
  // Whether the file list reflects a finished check, so an empty list isn't shown as "no logs".
  const [scanState, setScanState] = useState<"pending" | "ready" | "failed">("pending");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [uploadingPath, setUploadingPath] = useState<string>("");
  const [initializing, setInitializing] = useState(true);
  const [initProgress, setInitProgress] = useState<InitProgressState>({
    percent: 10,
    label: "Restoring saved settings...",
  });
  const [syncProgress, setSyncProgress] = useState<SyncProgressState>({
    active: false,
    percent: 0,
    label: "",
  });
  const [refreshActiveCount, setRefreshActiveCount] = useState(0);
  const [isSyncNowRunning, setIsSyncNowRunning] = useState(false);
  const [refreshQueueCount, setRefreshQueueCount] = useState(0);
  const [refreshClickIntent, setRefreshClickIntent] = useState(false);
  const [syncClickIntent, setSyncClickIntent] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<OrderedStatus, boolean>>({
    pending: true,
    uploaded: true,
    imported: true,
    blacklisted: true,
  });

  const scanInFlight = useRef(false);
  const refreshQueueRef = useRef(0);
  const watcherCleanupRef = useRef<null | (() => Promise<void>)>(null);
  const authContextRef = useRef("");
  const mobileFilePayloadByPathRef = useRef<Record<string, MobileFilePayload>>({});
  const recentlyUploadedHashesRef = useRef<Set<string>>(new Set());
  const mobile = useMemo(() => isLikelyMobile(), []);
  const android = useMemo(() => isAndroid(), []);
  const [bgStatus, setBgStatus] = useState<BgSyncStatus | null>(null);
  const [rememberInput, setRememberInput] = useState(config.rememberPassword);
  const refreshAfterReloginRef = useRef(false);
  const [foundFolders, setFoundFolders] = useState<FoundLogFolder[] | null>(null);
  const [searchingFolders, setSearchingFolders] = useState(false);
  const isRefreshInProgress = refreshClickIntent || syncProgress.active || refreshActiveCount > 0 || refreshQueueCount > 0;
  const isSyncInProgress = syncClickIntent || isSyncNowRunning || uploadingPath.length > 0;

  useEffect(() => {
    debugLog("ui.spinner.refresh.state", {
      isRefreshInProgress,
      syncProgressActive: syncProgress.active,
      syncProgressLabel: syncProgress.label,
      refreshActiveCount,
      refreshQueueCount,
      busy,
    });
  }, [isRefreshInProgress, syncProgress.active, syncProgress.label, refreshActiveCount, refreshQueueCount, busy]);

  useEffect(() => {
    debugLog("ui.spinner.sync.state", {
      isSyncInProgress,
      isSyncNowRunning,
      hasUploadingPath: uploadingPath.length > 0,
      busy,
    });
  }, [isSyncInProgress, isSyncNowRunning, uploadingPath, busy]);

  useEffect(() => {
    authContextRef.current = buildAuthContext(config.serverUrl, config.activeProfile, config.sessionToken);
  }, [config.serverUrl, config.activeProfile, config.sessionToken]);

  // Keep the Android background service's copy of the settings in step with the UI.
  useEffect(() => {
    if (!android) return;
    configureBgSync({
      serverUrl: config.serverUrl,
      profile: config.activeProfile,
      sessionToken: config.sessionToken,
      folder: config.syncFolder,
      autoSync: config.autoSync,
      rememberPassword: config.rememberPassword,
    })
      .then(setBgStatus)
      .catch((err) => debugLog("bgsync.configure.failed", { error: asError(err) }));
  }, [android, config.serverUrl, config.activeProfile, config.sessionToken, config.syncFolder, config.autoSync, config.rememberPassword]);

  // Refresh the background status whenever settings are opened, and when returning to the app
  // (e.g. from the "All files access" screen).
  useEffect(() => {
    if (!android) return;
    const update = () => {
      getBgSyncStatus()
        .then(setBgStatus)
        .catch(() => undefined);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [android, showSettings]);

  // On Android, look for the DJI log folder as soon as the folder screen opens with nothing chosen yet.
  useEffect(() => {
    if (android && screen === "folder" && !folderInput.trim()) {
      void findDjiFolders(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [android, screen]);

  // After an automatic re-login, rerun the sync check with the new token.
  useEffect(() => {
    if (!refreshAfterReloginRef.current || !config.sessionToken || screen !== "dashboard") return;
    refreshAfterReloginRef.current = false;
    void refreshSyncState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.sessionToken, screen]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", config.theme);
    saveConfig(config);
    debugLog("config.persist", {
      serverUrl: config.serverUrl,
      activeProfile: config.activeProfile,
      hasSession: Boolean(config.sessionToken),
      syncFolder: config.syncFolder,
      theme: config.theme,
    });
  }, [config]);

  useEffect(() => {
    debugLog("app.init.start");
    initializeApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const setup = async () => {
      if (screen !== "dashboard" || !config.syncFolder) {
        debugLog("watcher.stop.conditions", { screen, hasSyncFolder: Boolean(config.syncFolder) });
        await stopWatcherIfRunning();
        return;
      }

      if (mobile) {
        debugLog("watcher.polling.start", { intervalMs: 15000, reason: "mobile-fallback" });
        await stopWatcherIfRunning();
        const timer = window.setInterval(() => {
          debugLog("watcher.polling.tick");
          void refreshSyncState(false);
        }, 15000);
        watcherCleanupRef.current = async () => {
          window.clearInterval(timer);
        };
        return;
      }

      await stopWatcherIfRunning();

      const exts = await ensureAllowedExtensions();
      debugLog("watcher.desktop.setup", { folder: config.syncFolder, extensions: exts });
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen("sync-folder-changed", () => {
          debugLog("watcher.event.received");
          void refreshSyncState(false);
        });
      } catch {
        debugLog("watcher.event.listen.failed");
        // If event listener registration fails, fallback polling below.
      }

      try {
        await invoke("start_sync_watcher", {
          folderPath: config.syncFolder,
          allowedExtensions: exts,
        });
        debugLog("watcher.desktop.started", { folder: config.syncFolder });

        watcherCleanupRef.current = async () => {
          if (unlisten) unlisten();
          await invoke("stop_sync_watcher");
          debugLog("watcher.desktop.stopped");
        };
      } catch {
        debugLog("watcher.desktop.start.failed.fallbackPolling", { intervalMs: 15000 });
        if (unlisten) unlisten();
        const timer = window.setInterval(() => {
          debugLog("watcher.polling.tick");
          void refreshSyncState(false);
        }, 15000);
        watcherCleanupRef.current = async () => {
          window.clearInterval(timer);
        };
      }
    };

    void setup();

    return () => {
      void stopWatcherIfRunning();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, config.serverUrl, config.activeProfile, config.sessionToken, config.syncFolder, mobile]);

  async function stopWatcherIfRunning(): Promise<void> {
    if (!watcherCleanupRef.current) return;
    debugLog("watcher.cleanup.start");
    const cleanup = watcherCleanupRef.current;
    watcherCleanupRef.current = null;
    await cleanup();
    debugLog("watcher.cleanup.done");
  }

  /**
   * On a 401, try one re-login with the saved password (Android, opt-in only).
   * Returns true if a new session was obtained; the caller should then stop and let the
   * refresh-after-relogin effect rerun the sync check with the new token.
   */
  async function tryAutoRelogin(): Promise<boolean> {
    if (!android || !config.rememberPassword) return false;
    try {
      debugLog("session.autoRelogin.start");
      const token = await reloginWithSavedPassword();
      refreshAfterReloginRef.current = true;
      setConfig((prev) => ({ ...prev, sessionToken: token }));
      setMessage("Session expired and was renewed automatically.");
      debugLog("session.autoRelogin.done");
      return true;
    } catch (err) {
      debugLog("session.autoRelogin.failed", { error: asError(err) });
      getBgSyncStatus()
        .then(setBgStatus)
        .catch(() => undefined);
      return false;
    }
  }

  async function ensureAllowedExtensions(): Promise<string[]> {
    if (allowedExtensions.length) {
      return allowedExtensions;
    }
    debugLog("extensions.fetch.start");
    const exts = await getAllowedExtensions(config.serverUrl, config.activeProfile, config.sessionToken);
    setAllowedExtensions(exts);
    debugLog("extensions.fetch.done", { count: exts.length, extensions: exts });
    return exts;
  }

  async function initializeApp(): Promise<void> {
    try {
      setInitProgress({ percent: 12, label: "Checking server configuration..." });
      if (!config.serverUrl) {
        debugLog("app.init.noServerUrl");
        setScreen("server");
        return;
      }

      const normalized = normalizeServerUrl(config.serverUrl);
      const urlProblem = serverUrlProblem(normalized);
      if (urlProblem) {
        // Saved by an older version that allowed it: ask for a safe address instead.
        debugLog("app.init.unsafeServerUrl");
        setServerInput(normalized);
        setMessage(urlProblem);
        setScreen("server");
        return;
      }
      setInitProgress({ percent: 35, label: "Fetching profiles..." });
      try {
        debugLog("profiles.fetch.start", { serverUrl: normalized });
        const loadedProfiles = await listProfiles(normalized);
        setProfiles(loadedProfiles);
        setSelectedProfile(config.activeProfile || loadedProfiles[0]?.name || "");
        debugLog("profiles.fetch.done", { count: loadedProfiles.length });
      } catch (err) {
        debugLog("profiles.fetch.failed", { error: asError(err) });
        setScreen("server");
        setMessage(asError(err));
        return;
      }

      if (!config.activeProfile) {
        setScreen("login");
        return;
      }

      if (config.sessionToken) {
        setInitProgress({ percent: 58, label: "Validating saved session..." });
        try {
          const exts = await getAllowedExtensions(normalized, config.activeProfile, config.sessionToken);
          setAllowedExtensions(exts);
          debugLog("session.restore.valid", { extensionsCount: exts.length });
        } catch (err) {
          if (isUnauthorized(err)) {
            debugLog("session.restore.expired");
            if (await tryAutoRelogin()) {
              setScreen(config.syncFolder ? "dashboard" : "folder");
              setInitProgress({ percent: 100, label: "Ready" });
              return;
            }
            setConfig((prev) => ({ ...prev, sessionToken: "" }));
            setScreen("login");
            setMessage("Session expired. Please login again.");
            return;
          }
        }
      }

      setInitProgress({ percent: 78, label: "Restoring sync view..." });
      setScreen(config.syncFolder ? "dashboard" : "folder");
      if (config.syncFolder) {
        await refreshSyncState(false);
      }
      setInitProgress({ percent: 100, label: "Ready" });
    } finally {
      setInitializing(false);
    }
  }

  function enqueueRefresh(reason: string): void {
    refreshQueueRef.current += 1;
    setRefreshQueueCount(refreshQueueRef.current);
    debugLog("sync.refresh.queued", { reason, queue: refreshQueueRef.current });
  }

  function toggleGroup(status: OrderedStatus): void {
    setCollapsedGroups((prev) => ({
      ...prev,
      [status]: !prev[status],
    }));
  }

  async function handleManualRefresh(): Promise<void> {
    const clickTs = performance.now();
    debugLog("ui.spinner.refresh.click", {
      syncProgressActive: syncProgress.active,
      refreshActiveCount,
      refreshQueueCount,
      busy,
    });
    flushSync(() => {
      setRefreshClickIntent(true);
      if (!syncProgress.active) {
        setSyncProgress({ active: true, percent: 3, label: "Refresh queued..." });
      }
    });
    await waitForVisualCommit();
    debugLog("ui.spinner.refresh.paintFlushed", {
      elapsedMs: Math.round(performance.now() - clickTs),
    });
    try {
      await refreshSyncState(true);
    } finally {
      setRefreshClickIntent(false);
    }
  }

  async function handleSaveServerUrl(): Promise<void> {
    const clean = normalizeServerUrl(serverInput);
    if (!clean) {
      setMessage("Enter a valid server URL.");
      return;
    }
    const urlProblem = serverUrlProblem(clean);
    if (urlProblem) {
      setMessage(urlProblem);
      return;
    }
    debugLog("serverUrl.save.start", { value: clean });
    setBusy(true);
    setMessage("Connecting to server...");
    try {
      await stopWatcherIfRunning();
      const loadedProfiles = await listProfiles(clean);
      setProfiles(loadedProfiles);
      const defaultProfile = loadedProfiles[0]?.name || "";
      setSelectedProfile(defaultProfile);
      refreshQueueRef.current = 0;
      scanInFlight.current = false;
      setRefreshQueueCount(0);
      setRefreshActiveCount(0);
      setRefreshClickIntent(false);
      setSyncClickIntent(false);
      setSyncProgress({ active: false, percent: 0, label: "" });
      setAllowedExtensions([]);
      setFiles([]);
      setScanState("pending");
      setUploadingPath("");
      recentlyUploadedHashesRef.current.clear();
      setFolderInput("");
      setConfig((prev) => ({
        ...prev,
        serverUrl: clean,
        activeProfile: "",
        sessionToken: "",
        syncFolder: "",
      }));
      setPassword("");
      setMessage("");
      setScreen("login");
      debugLog("serverUrl.save.done", { profiles: loadedProfiles.length });
    } catch (err) {
      debugLog("serverUrl.save.failed", { error: asError(err) });
      setMessage(asError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(): Promise<void> {
    if (!selectedProfile) {
      setMessage("Choose a profile.");
      return;
    }

    setBusy(true);
    try {
      debugLog("login.start", { profile: selectedProfile, hasPassword: Boolean(password) });
      const result = await switchProfile(config.serverUrl, selectedProfile, password);
      const nextToken = result.session ?? "";
      const remember = android && rememberInput && Boolean(password);
      if (android) {
        // Hand the password to the native side (Keystore-encrypted) only when the user opted in.
        // Not remembering clears any previously saved password.
        try {
          setBgStatus(
            await configureBgSync({
              serverUrl: config.serverUrl,
              profile: result.name,
              sessionToken: nextToken,
              folder: config.syncFolder,
              autoSync: config.autoSync,
              rememberPassword: remember,
              password: remember ? password : undefined,
            }),
          );
        } catch (err) {
          debugLog("bgsync.savePassword.failed", { error: asError(err) });
        }
      }
      setConfig((prev) => ({
        ...prev,
        activeProfile: result.name,
        sessionToken: nextToken,
        rememberPassword: remember,
      }));
      const exts = await getAllowedExtensions(config.serverUrl, result.name, nextToken);
      setAllowedExtensions(exts);
      debugLog("login.done", { profile: result.name, hasSession: Boolean(nextToken), extensionsCount: exts.length });
      setPassword("");
      setMessage("");
      setScreen(config.syncFolder ? "dashboard" : "folder");
      if (config.syncFolder) {
        await refreshSyncState(false);
      }
    } catch (err) {
      debugLog("login.failed", { error: asError(err) });
      setMessage(asError(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder(): Promise<void> {
    debugLog("folder.pick.start", { mobile });
    if (mobile) {
      try {
        const androidFs = await loadAndroidFsModule();
        if (androidFs?.isAndroid()) {
          const pickedUri = await androidFs.AndroidFs.showOpenDirPicker({ localOnly: false });
          if (pickedUri) {
            await androidFs.AndroidFs.persistPickerUriPermission(pickedUri);
            setMobileSyncUri(pickedUri);
            setFolderInput(pickedUri.uri);
            debugLog("folder.pick.mobile.saf.done", { uri: pickedUri.uri });
            return;
          }
        }

        const folder = await invoke<string>("get_default_mobile_sync_folder");
        setMobileSyncUri(null);
        setFolderInput(folder);
        debugLog("folder.pick.mobile.fallback.done", { folder });
      } catch (err) {
        debugLog("folder.pick.mobile.failed", { error: asError(err) });
        setMessage(asError(err));
      }
      return;
    }

    setBusy(true);
    try {
      const selected = await withTimeout(
        invoke<string | null>("pick_sync_folder_native"),
        12000,
        "Native folder picker timed out",
      );
      if (typeof selected === "string" && selected.trim()) {
        setFolderInput(selected);
        debugLog("folder.pick.desktop.done", { folder: selected });
      } else {
        debugLog("folder.pick.desktop.cancelled");
      }
    } catch (err) {
      const errorText = asError(err);
      debugLog("folder.pick.desktop.failed", { error: errorText });
      setMessage(`Folder picker failed on this Linux environment. Paste the folder path manually. ${errorText}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Looks for DJI FlightRecord folders on the controller. Picks the folder automatically when
   * there is exactly one readable match; otherwise lists them. `userAsked` asks for storage
   * access if it is missing (the automatic run on screen open never prompts).
   */
  async function findDjiFolders(userAsked: boolean): Promise<void> {
    if (!android) return;
    setSearchingFolders(true);
    try {
      const status = await getBgSyncStatus();
      setBgStatus(status);
      if (!status.storageAccess) {
        if (userAsked) {
          setBgStatus(await requestStorageAccess());
          setMessage('Allow "All files access" for OpenDronelog Sync, then tap "Find DJI log folder" again.');
        }
        return;
      }
      const { folders } = await findLogFolders();
      setFoundFolders(folders);
      const readable = folders.filter((f) => f.readable);
      const blocked = folders.filter((f) => !f.readable);
      if (readable.length >= 1) {
        // Best match first: most recent logs.
        setMobileSyncUri(null);
        setFolderInput(readable[0].path);
        const best = readable[0];
        const what =
          best.logCount > 0
            ? `${best.logCount} DJI flight log${best.logCount === 1 ? "" : "s"} (newest ${best.newestLogName})`
            : "an empty DJI log folder";
        setMessage(
          readable.length === 1
            ? `Found ${what} in ${best.path}. Tap Save Folder.`
            : `Found ${readable.length} possible folders. Picked the one with ${what}; choose another below if needed.`,
        );
      } else if (blocked.length) {
        setMessage(
          `Found ${describeApp(blocked[0].app)}'s log folder (${blocked[0].path}). Android needs you to allow access once: tap "Grant access" below, then "Allow access" in the picker.`,
        );
      } else if (userAsked) {
        setMessage("No DJI flight log folder found. Fly once so the DJI app creates it, or use Browse.");
      }
    } catch (err) {
      debugLog("folder.find.failed", { error: asError(err) });
      if (userAsked) setMessage(asError(err));
    } finally {
      setSearchingFolders(false);
    }
  }

  /** Asks Android's folder picker for access to a folder the app can't read directly (DJI Fly on Android 11+). */
  async function grantBlockedFolder(f: FoundLogFolder): Promise<void> {
    try {
      const folder = await grantFolderAccess(f.path);
      setMobileSyncUri(null);
      setFolderInput(folder);
      setMessage(`Access granted to ${describeApp(f.app)}'s log folder. Tap Save Folder.`);
    } catch (err) {
      setMessage(asError(err));
    }
  }

  async function saveFolder(): Promise<void> {
    if (!folderInput.trim()) {
      setMessage("Select or enter a sync folder.");
      return;
    }

    const selectedFolder = folderInput.trim();
    if (mobile && isContentUri(selectedFolder) && !getMobileSyncUri() && !isNativeFolder(selectedFolder)) {
      setMessage("Please browse and grant folder access again.");
      return;
    }

    if (!isContentUri(selectedFolder)) {
      setMobileSyncUri(null);
    }

    mobileFilePayloadByPathRef.current = {};
    recentlyUploadedHashesRef.current.clear();
    debugLog("folder.save.start", { folder: selectedFolder });
    setConfig((prev) => ({ ...prev, syncFolder: selectedFolder }));
    setMessage("");
    setScreen("dashboard");
    await refreshSyncState(true, selectedFolder);
    debugLog("folder.save.done", { folder: selectedFolder });
  }

  async function refreshSyncState(showBusy = true, overrideFolder?: string): Promise<SyncItem[]> {
    if (scanInFlight.current) {
      enqueueRefresh("refresh-in-flight");
      return [];
    }
    debugLog("sync.refresh.start", { showBusy, overrideFolder: overrideFolder ?? null });
    const requestAuthContext = buildAuthContext(config.serverUrl, config.activeProfile, config.sessionToken);
    scanInFlight.current = true;
    setRefreshActiveCount((v) => v + 1);
    setSyncProgress({ active: true, percent: 5, label: "Preparing sync check..." });
    if (showBusy) setBusy(true);

    try {
      const folderPath = overrideFolder ?? config.syncFolder;
      if (!folderPath) {
        setScreen("folder");
        setSyncProgress({ active: false, percent: 0, label: "" });
        return [];
      }

      setSyncProgress({ active: true, percent: 20, label: "Loading allowed extensions..." });
      debugLog("sync.refresh.allowedExtensions.request.start", {
        serverUrl: config.serverUrl,
        profile: config.activeProfile,
      });
      const exts = await ensureAllowedExtensions();
      debugLog("sync.refresh.allowedExtensions.request.done", { extensions: exts.length });
      setAllowedExtensions(exts);

      let localPromise: Promise<LocalFileEntry[]>;
      if (android && isNativeFolder(folderPath)) {
        // Folder granted through Android's picker (e.g. DJI Fly's logs): read it natively.
        setSyncProgress({ active: true, percent: 35, label: "Scanning DJI log folder..." });
        localPromise = scanNativeFolder(folderPath, exts).then((result) => {
          setSyncProgress({ active: true, percent: 60, label: "Fetched local files." });
          return result;
        });
      } else if (mobile && isContentUri(folderPath)) {
        localPromise = (async () => {
          setSyncProgress({ active: true, percent: 35, label: "Scanning selected mobile folder..." });
          const androidFs = await loadAndroidFsModule();
          const persistedUri = getMobileSyncUri();
          if (!androidFs?.isAndroid() || !persistedUri) {
            throw new Error("Mobile folder access not available. Please pick the folder again.");
          }

          const hasPermission = await androidFs.AndroidFs.checkPersistedPickerUriPermission(
            persistedUri,
            androidFs.AndroidUriPermissionState.ReadOrWrite,
          );
          if (!hasPermission) {
            throw new Error("Folder permission expired. Please browse and grant access again.");
          }

          const allowed = new Set(exts.map((e) => e.trim().replace(/^\./, "").toLowerCase()));
          const files: LocalFileEntry[] = [];
          const payloadByPath: Record<string, MobileFilePayload> = {};

          const walk = async (uri: AndroidFsUri): Promise<void> => {
            const entries = await androidFs.AndroidFs.readDir(uri);
            for (const entry of entries) {
              if (entry.type === "Dir") {
                await walk(entry.uri);
                continue;
              }
              if (entry.type !== "File" || !hasAllowedExtension(entry.name, allowed)) {
                continue;
              }

              const content = await androidFs.AndroidFs.readFile(entry.uri);
              const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
              const normalized = new Uint8Array(bytes.byteLength);
              normalized.set(bytes);
              const hash = await sha256Hex(normalized);

              payloadByPath[entry.uri.uri] = {
                name: entry.name,
                bytes: normalized,
              };

              files.push({
                name: entry.name,
                path: entry.uri.uri,
                size: normalized.byteLength,
                modifiedMs: Date.now(),
                hash,
              });
            }
          };

          await walk(persistedUri);
          files.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          mobileFilePayloadByPathRef.current = payloadByPath;
          setSyncProgress({ active: true, percent: 60, label: "Fetched mobile folder files." });
          return files;
        })();
      } else {
        setSyncProgress({ active: true, percent: 35, label: "Scanning local folder..." });
        await waitForVisualCommit();
        debugLog("sync.refresh.scan.request.start", {
          folderPath,
          extensions: exts,
        });
        localPromise = invoke<LocalFileEntry[]>("scan_sync_folder", {
          folderPath,
          allowedExtensions: exts,
        }).then((result) => {
          setSyncProgress({ active: true, percent: 60, label: "Fetched local files." });
          return result;
        });
      }

      const importedPromise = getServerFileHashes(config.serverUrl, config.activeProfile, config.sessionToken).then((result) => {
        setSyncProgress({ active: true, percent: 75, label: "Fetched imported file hashes." });
        return result;
      });

      const blacklistPromise = getSyncBlacklist(config.serverUrl, config.activeProfile, config.sessionToken).then((result) => {
        setSyncProgress({ active: true, percent: 90, label: "Fetched blacklist hashes." });
        return result;
      });

      const [localFiles, importedHashes, blacklistedHashes] = await Promise.all([
        localPromise,
        importedPromise,
        blacklistPromise,
      ]);

      if (requestAuthContext !== authContextRef.current) {
        debugLog("sync.refresh.staleResult.ignored", {
          requestAuthContext,
          currentAuthContext: authContextRef.current,
        });
        return [];
      }

      const nextItems = localFiles.map((f) => {
        if (f.path === uploadingPath) return { ...f, status: "uploading" as const };
        if (importedHashes.has(f.hash)) {
          recentlyUploadedHashesRef.current.delete(f.hash);
          return { ...f, status: "imported" as const };
        }
        if (blacklistedHashes.has(f.hash)) {
          recentlyUploadedHashesRef.current.delete(f.hash);
          return { ...f, status: "blacklisted" as const };
        }
        if (recentlyUploadedHashesRef.current.has(f.hash)) return { ...f, status: "uploaded" as const };
        return { ...f, status: "pending" as const };
      });

      setFiles(nextItems);
      setScanState("ready");
      setMessage("");
      setSyncProgress({ active: true, percent: 100, label: "Sync view ready." });
      debugLog("sync.refresh.done", {
        total: nextItems.length,
        imported: nextItems.filter((i) => i.status === "imported").length,
        blacklisted: nextItems.filter((i) => i.status === "blacklisted").length,
        pending: nextItems.filter((i) => i.status === "pending").length,
      });
      return nextItems;
    } catch (err) {
      if (isUnauthorized(err)) {
        if (requestAuthContext !== authContextRef.current) {
          debugLog("sync.refresh.staleUnauthorized.ignored", {
            requestAuthContext,
            currentAuthContext: authContextRef.current,
          });
          return [];
        }
        debugLog("sync.refresh.unauthorized");
        if (await tryAutoRelogin()) {
          return [];
        }
        setConfig((prev) => ({ ...prev, sessionToken: "" }));
        setScreen("login");
        setMessage("Session expired. Please login again.");
      } else {
        debugLog("sync.refresh.failed", { error: asError(err) });
        setScanState((prev) => (prev === "ready" ? prev : "failed"));
        setMessage(asError(err));
      }
      return [];
    } finally {
      if (showBusy) setBusy(false);
      scanInFlight.current = false;
      setRefreshActiveCount((v) => Math.max(v - 1, 0));
      window.setTimeout(() => {
        setSyncProgress({ active: false, percent: 0, label: "" });
      }, 250);

      if (refreshQueueRef.current > 0) {
        refreshQueueRef.current -= 1;
        setRefreshQueueCount(refreshQueueRef.current);
        debugLog("sync.refresh.dequeue", { remainingQueue: refreshQueueRef.current });
        void refreshSyncState(false);
      }
    }
  }

  async function syncNow(): Promise<void> {
    const clickTs = performance.now();
    debugLog("sync.manual.start");
    flushSync(() => {
      setSyncClickIntent(true);
      setIsSyncNowRunning(true);
      setBusy(true);
      if (!syncProgress.active) {
        setSyncProgress({ active: true, percent: 2, label: "Sync requested..." });
      }
    });
    setMessage("");

    try {
      await waitForVisualCommit();
      debugLog("ui.spinner.sync.paintFlushed", {
        elapsedMs: Math.round(performance.now() - clickTs),
      });
      const snapshot = await refreshSyncState(false);
      const pending = snapshot.filter((f) => f.status === "pending");
      if (!pending.length) {
        debugLog("sync.manual.noPending");
        setMessage("No pending files to upload.");
        return;
      }

      debugLog("sync.manual.pendingCount", { count: pending.length });

      for (const file of pending) {
        debugLog("sync.manual.upload.start", { file: file.path, hash: file.hash });
        setUploadingPath(file.path);
        setFiles((prev) => prev.map((item) => (item.path === file.path ? { ...item, status: "uploading" } : item)));

        const nativeFolder = android && isNativeFolder(config.syncFolder);
        const mobilePayload = mobileFilePayloadByPathRef.current[file.path];
        if (!nativeFolder && isContentUri(file.path) && !mobilePayload) {
          throw new Error(`Missing mobile file payload for ${file.name}. Refresh and try again.`);
        }

        const result = nativeFolder
          ? await uploadNativeFile(file.path)
          : isContentUri(file.path)
          ? await uploadMobileFile(
              config.serverUrl,
              config.activeProfile,
              config.sessionToken,
              file.name,
              mobilePayload ? mobilePayload.bytes : new Uint8Array(),
              file.hash,
            )
          : await invoke<UploadSyncResponse>("upload_sync_file", {
              serverUrl: config.serverUrl,
              profile: config.activeProfile,
              sessionToken: config.sessionToken,
              filePath: file.path,
            });

        if (result.statusCode === 401) {
          debugLog("sync.manual.upload.unauthorized", { file: file.path });
          if (await tryAutoRelogin()) {
            setMessage("Session was renewed automatically. Tap Sync Now again to finish uploading.");
            return;
          }
          setConfig((prev) => ({ ...prev, sessionToken: "" }));
          setScreen("login");
          setMessage("Session expired. Please login again.");
          return;
        }

        if (!result.success) {
          debugLog("sync.manual.upload.failed", { file: file.path, statusCode: result.statusCode, message: result.message });
          setFiles((prev) =>
            prev.map((item) =>
              item.path === file.path ? { ...item, status: "error", message: result.message } : item,
            ),
          );
        } else {
          debugLog("sync.manual.upload.done", { file: file.path, statusCode: result.statusCode });
          recentlyUploadedHashesRef.current.add(file.hash);
          setFiles((prev) =>
            prev.map((item) => (item.path === file.path ? { ...item, status: "uploaded", message: "Uploaded" } : item)),
          );
        }
      }

      setUploadingPath("");
      await refreshSyncState(false);
      setMessage("Sync complete.");
      debugLog("sync.manual.done");
    } catch (err) {
      debugLog("sync.manual.failed", { error: asError(err) });
      setMessage(asError(err));
    } finally {
      setUploadingPath("");
      setBusy(false);
      setIsSyncNowRunning(false);
      setSyncClickIntent(false);
    }
  }

  function resetLogin(): void {
    setFolderInput("");
    setAllowedExtensions([]);
    setFiles([]);
    setScanState("pending");
    setConfig((prev) => ({ ...prev, activeProfile: "", sessionToken: "", syncFolder: "" }));
    setScreen("login");
  }

  function renderServerScreen() {
    return (
      <section className="card">
        <h2><Server size={18} /> Server URL</h2>
        <p>Enter the hosted OpenDronelog server URL.</p>
        <input
          value={serverInput}
          onChange={(e) => setServerInput(e.target.value)}
          placeholder="https://your-opendronelog-server.example"
        />
        <button disabled={busy} onClick={() => void handleSaveServerUrl()}>Continue</button>
      </section>
    );
  }

  function renderLoginScreen() {
    const selected = profiles.find((p) => p.name === selectedProfile);
    return (
      <section className="card">
        <h2><User size={18} /> Profile Login</h2>
        <p>Select a profile and authenticate if it is protected.</p>
        <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}>
          <option value="">Select profile</option>
          {profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>{profile.name}</option>
          ))}
        </select>
        {selected?.hasPassword ? (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Profile password"
          />
        ) : null}
        {android && selected?.hasPassword ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={rememberInput}
              onChange={(e) => setRememberInput(e.target.checked)}
            />
            <span>
              Remember password on this device
              <small>
                Stored encrypted with the Android Keystore and only used to log in again when the session
                expires. If it's ever rejected, it's deleted and you'll be asked to log in.
              </small>
            </span>
          </label>
        ) : null}
        <button disabled={busy} onClick={() => void handleLogin()}>Login</button>
      </section>
    );
  }

  function renderFolderScreen() {
    return (
      <section className="card">
        <h2><Folder size={18} /> Sync Folder</h2>
        <p>{mobile ? "On mobile, use the app sync folder for reliable access." : "Choose the folder to watch for log files."}</p>
        <div className="row">
          <input value={folderInput} onChange={(e) => setFolderInput(e.target.value)} placeholder="/path/to/sync-folder" />
          <button className="ghost" onClick={() => void pickFolder()}>Browse</button>
        </div>
        {android ? (
          <div className="folder-finder">
            <button className="ghost" disabled={searchingFolders} onClick={() => void findDjiFolders(true)}>
              {searchingFolders ? <><span className="inline-spinner" aria-hidden="true" /> Searching…</> : "Find DJI log folder"}
            </button>
            {bgStatus && !bgStatus.storageAccess ? (
              <small className="hint">Needs "All files access" to read DJI's log folder.</small>
            ) : null}
            {foundFolders && foundFolders.length > 0 ? (
              <ul className="found-folders">
                {foundFolders.map((f) => (
                  <li key={f.path}>
                    <button
                      className={folderInput === f.path ? "" : "ghost"}
                      onClick={() => {
                        if (f.readable) {
                          setMobileSyncUri(null);
                          setFolderInput(f.path);
                        } else {
                          void grantBlockedFolder(f);
                        }
                      }}
                    >
                      {f.readable ? describeApp(f.app) : `Grant access (${describeApp(f.app)})`}
                    </button>
                    <small className="hint">
                      {f.path}
                      <br />
                      {!f.readable
                        ? 'Android blocks direct access. Tap "Grant access", then "Allow access" in the picker.'
                        : f.logCount === 0
                          ? "No DJI flight logs in here yet."
                          : `${f.logCount} DJI flight log${f.logCount === 1 ? "" : "s"} · newest: ${f.newestLogName} (${new Date(f.newestLogMs).toLocaleString()})`}
                    </small>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <button disabled={busy} onClick={() => void saveFolder()}>Save Folder</button>
      </section>
    );
  }

  function renderDashboard() {
    const grouped = groupByStatus(files);

    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Sync Dashboard</h2>
          <div className="actions">
            <button className="ghost" disabled={busy} onClick={handleManualRefresh}>
              {isRefreshInProgress
                ? <><span className="inline-spinner" aria-hidden="true" /> Refresh</>
                : <><RefreshCw size={16} /> Refresh</>}
            </button>
            <button disabled={busy} onClick={() => void syncNow()}>
              {isSyncInProgress ? <><span className="inline-spinner" aria-hidden="true" /> Sync Now</> : <><Upload size={16} /> Sync Now</>}
            </button>
          </div>
        </div>

        {syncProgress.active ? (
          <div className="sync-progress" aria-live="polite">
            <div className="sync-progress-row">
              <RefreshCw className="spin" size={14} />
              <span>{syncProgress.label}</span>
              <span>{syncProgress.percent}%</span>
            </div>
            <div className="sync-progress-track">
              <div className="sync-progress-fill" style={{ width: `${syncProgress.percent}%` }} />
            </div>
            {refreshQueueCount > 0 ? (
              <div className="refresh-queue">Queued refresh requests: {refreshQueueCount}</div>
            ) : null}
          </div>
        ) : null}

        <div className="meta">
          <span>Profile: {config.activeProfile}</span>
          <span title={config.syncFolder}>Folder: {displayFolder(config.syncFolder)}</span>
          <span>Allowed: {allowedExtensions.join(", ") || "-"}</span>
        </div>

        {files.length ? <p className="sync-summary">{syncSummary(files)}</p> : null}

        <div className="table">
          {files.length ? STATUS_ORDER.map((status) => {
            const items = grouped[status];
            if (!items.length) return null;

            return (
              <section key={status} className={`status-group status-group-${status}`}>
                <button className="status-group-title" onClick={() => toggleGroup(status)} type="button" aria-expanded={!collapsedGroups[status]}>
                  <span className={`status ${status}`}>{status}</span>
                  <span className="status-group-right">
                    <span>{items.length}</span>
                    {collapsedGroups[status] ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>

                {!collapsedGroups[status] ? (
                  <>
                    <div className="table-head">
                      <span className="col-file">File</span>
                      <span className="col-hash">Hash</span>
                      <span className="col-copy" aria-hidden="true"> </span>
                      <span className="col-status">Status</span>
                      <span className="col-size">Size</span>
                    </div>
                    {items.map((file) => (
                      <div key={file.path} className="table-row">
                        <span className="cell filename" data-label="File">{file.name}</span>
                        <span className="cell hash" data-label="Hash" title={file.hash}>{shortHash(file.hash)}</span>
                        <span className="cell cell-action" data-label="Copy Hash">
                          <button
                            className="hash-copy-btn ghost"
                            type="button"
                            title="Copy hash"
                            aria-label={`Copy hash for ${file.name}`}
                            onClick={() => void copyHash(file.hash, file.name, setMessage)}
                          >
                            <Copy size={14} />
                          </button>
                        </span>
                        <span className={`cell status ${file.status}`} data-label="Status">
                          {file.status === "uploading" ? <RefreshCw className="spin" size={14} /> : null}
                          <span>{file.status}</span>
                        </span>
                        <span className="cell size" data-label="Size">{formatBytes(file.size)}</span>
                      </div>
                    ))}
                  </>
                ) : null}
              </section>
            );
          }) : <p className="empty">{
            scanState === "pending"
              ? "Checking the folder and the server…"
              : scanState === "failed"
                ? "Couldn't finish checking the folder and the server. Tap Refresh to try again."
                : "No flight logs in this folder yet. If you've already flown, check the folder in Settings."
          }</p>}
        </div>
      </section>
    );
  }

  function renderBackgroundSettings() {
    const status = bgStatus;
    // Plain paths and picker-granted folders can both be read by the background service.
    const folderIsPath = Boolean(config.syncFolder);
    return (
      <div className="bg-settings">
        <h3>Background sync</h3>
        <label className="check-row">
          <input
            type="checkbox"
            checked={config.autoSync}
            disabled={!config.activeProfile}
            onChange={(e) => {
              const autoSync = e.target.checked;
              setConfig((prev) => ({ ...prev, autoSync }));
              if (autoSync && status && !status.storageAccess) {
                void requestStorageAccess().then(setBgStatus).catch((err) => setMessage(asError(err)));
              }
            }}
          />
          <span>
            Sync in the background and start when the controller turns on
            <small>Shows a small "OpenDronelog Sync" notification while running. Logs upload about 2 minutes after a flight ends.</small>
          </span>
        </label>

        {status ? (
          <ul className="bg-status">
            <li>
              Storage access: {status.storageAccess ? "granted" : "not granted"}
              {!status.storageAccess ? (
                <button
                  className="ghost"
                  onClick={() => void requestStorageAccess().then(setBgStatus).catch((err) => setMessage(asError(err)))}
                >
                  Grant all files access
                </button>
              ) : null}
            </li>
            {config.autoSync && !folderIsPath ? (
              <li className="warn">Background sync needs a sync folder. Use "Change Sync Folder", then "Find DJI log folder".</li>
            ) : null}
            <li>Service: {status.serviceRunning ? "running" : "stopped"}</li>
            <li>
              Saved password: {status.hasSavedPassword ? "yes (encrypted)" : "no"}
              {status.hasSavedPassword ? (
                <button
                  className="ghost"
                  onClick={() => {
                    setConfig((prev) => ({ ...prev, rememberPassword: false }));
                    setRememberInput(false);
                    void clearSavedPassword().then(setBgStatus).catch((err) => setMessage(asError(err)));
                  }}
                >
                  Forget password
                </button>
              ) : null}
            </li>
            {status.needsLogin ? (
              <li className="warn">Login needed: the session expired and there's no valid saved password. Use "Change Profile" to log in.</li>
            ) : null}
            <li className={status.lastSyncOk ? "" : "warn"}>
              Last background sync: {status.lastSyncMessage || "not run yet"}
            </li>
          </ul>
        ) : null}

        <button
          className="ghost"
          disabled={!config.activeProfile}
          onClick={() =>
            void backgroundSyncNow()
              .then((s) => {
                setBgStatus(s);
                setMessage("Background sync started.");
              })
              .catch((err) => setMessage(asError(err)))
          }
        >
          Run background sync now
        </button>
      </div>
    );
  }

  if (initializing && config.serverUrl) {
    return (
      <main className="app loading-main">
        <section className="card loading-screen" aria-live="polite">
          <div className="loading-row">
            <RefreshCw className="spin" size={20} />
            <span>{initProgress.label}</span>
            <span>{initProgress.percent}%</span>
          </div>
          <div className="sync-progress-track">
            <div className="sync-progress-fill" style={{ width: `${initProgress.percent}%` }} />
          </div>
          <p className="loading-subtext">Preparing profiles, session, and sync state...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app">

      <header className="topbar">
        <h1 className="brand"><img src="/favicon.png" alt="OpenDronelog logo" className="brand-logo" />OpenDronelog Sync</h1>
        <div className="actions">
          <button
            className="ghost"
            onClick={() => setConfig((prev) => ({ ...prev, theme: prev.theme === "dark" ? "light" : "dark" }))}
          >
            {config.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />} Theme
          </button>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            <Settings size={16} /> Settings
          </button>
        </div>
      </header>

      {showSettings ? (
        <section className="settings">
          <button className="ghost" onClick={() => setScreen("server")}>Change Server URL</button>
          <button className="ghost" onClick={resetLogin}>Change Profile</button>
          <button className="ghost" onClick={() => setScreen("folder")}>Change Sync Folder</button>
          {android ? renderBackgroundSettings() : null}
        </section>
      ) : null}

      {message ? <p className="message">{message}</p> : null}

      {screen === "server" ? renderServerScreen() : null}
      {screen === "login" ? renderLoginScreen() : null}
      {screen === "folder" ? renderFolderScreen() : null}
      {screen === "dashboard" ? renderDashboard() : null}
    </main>
  );
}

function describeApp(app: string): string {
  if (app === "com.dji.industry.pilot") return "DJI Pilot 2";
  if (app === "dji.go.v5") return "DJI Fly";
  if (app === "dji.go.v4") return "DJI GO 4";
  return app || "Log folder";
}

/** One line saying where the folder stands, so "everything uploaded" reads differently from "nothing found". */
function syncSummary(files: SyncItem[]): string {
  const count = (s: SyncItem["status"]) => files.filter((f) => f.status === s).length;
  const waiting = count("pending") + count("uploading");
  const logs = (n: number) => `${n} flight log${n === 1 ? "" : "s"}`;
  if (waiting > 0 && waiting === files.length) return `All ${logs(files.length)} in this folder are waiting to upload.`;
  if (waiting > 0) return `${logs(waiting)} waiting to upload, out of ${logs(files.length)} in this folder.`;
  return `All ${logs(files.length)} in this folder are on the server. Nothing new to upload.`;
}

/**
 * Readable name for a sync folder. Folder-picker grants are content:// tree URIs such as
 * content://com.android.externalstorage.documents/tree/primary%3AAndroid%2Fdata%2Fdji.go.v5%2Ffiles%2FFlightRecord,
 * shown as "DJI Fly · FlightRecord". Plain paths are returned as they are.
 */
function displayFolder(folder: string): string {
  const match = /^content:\/\/[^/]+\/tree\/([^/]+)/.exec(folder);
  if (!match) return folder;
  let docId: string;
  try {
    docId = decodeURIComponent(match[1]);
  } catch {
    return folder;
  }
  const colon = docId.indexOf(":");
  const volume = colon >= 0 ? docId.slice(0, colon) : "";
  const path = colon >= 0 ? docId.slice(colon + 1) : docId;
  const parts = path.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || "storage root";
  const appData = /^Android\/data\/([^/]+)\//.exec(path + "/");
  if (appData) return `${describeApp(appData[1])} · ${name}`;
  const storage = volume === "primary" ? "Internal storage" : volume ? `SD card (${volume})` : "Storage";
  return path ? `${storage} › ${parts.join(" › ")}` : storage;
}

function asError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function buildAuthContext(serverUrl: string, activeProfile: string, sessionToken: string): string {
  return `${serverUrl}::${activeProfile}::${sessionToken}`;
}

function isUnauthorized(err: unknown): boolean {
  return asError(err).includes("HTTP 401");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortHash(hash: string): string {
  if (!hash) return "-";
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

async function copyHash(hash: string, fileName: string, setMessage: (msg: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(hash);
    setMessage(`Hash copied for ${fileName}`);
  } catch {
    setMessage("Failed to copy hash");
  }
}

async function uploadMobileFile(
  serverUrl: string,
  profile: string,
  sessionToken: string,
  fileName: string,
  bytes: Uint8Array,
  fileHash: string,
): Promise<UploadSyncResponse> {
  if (!bytes.length) {
    return {
      success: false,
      statusCode: 0,
      message: "Selected mobile file is empty or unavailable",
      fileHash,
    };
  }

  const form = new FormData();
  const normalized = new Uint8Array(bytes);
  const rawBuffer = normalized.buffer.slice(
    normalized.byteOffset,
    normalized.byteOffset + normalized.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([rawBuffer], { type: "application/octet-stream" });
  form.append("file", blob, fileName || "mobile-log.bin");

  const response = await fetch(`${serverUrl}/api/import`, {
    method: "POST",
    headers: {
      "X-Profile": profile,
      "X-Session": sessionToken,
    },
    body: form,
  });

  const bodyText = await response.text().catch(() => "");
  return {
    success: response.ok,
    statusCode: response.status,
    message: bodyText || response.statusText || "Upload failed",
    fileHash,
  };
}

function isContentUri(pathOrUri: string): boolean {
  return pathOrUri.startsWith("content://");
}

function getMobileSyncUri(): AndroidFsUri | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(MOBILE_SYNC_URI_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AndroidFsUri;
    if (!parsed || typeof parsed.uri !== "string") return null;
    return {
      uri: parsed.uri,
      documentTopTreeUri:
        parsed.documentTopTreeUri === null || typeof parsed.documentTopTreeUri === "string"
          ? parsed.documentTopTreeUri
          : null,
    };
  } catch {
    return null;
  }
}

function setMobileSyncUri(uri: AndroidFsUri | null): void {
  if (typeof localStorage === "undefined") return;
  if (!uri) {
    localStorage.removeItem(MOBILE_SYNC_URI_KEY);
    return;
  }
  localStorage.setItem(MOBILE_SYNC_URI_KEY, JSON.stringify(uri));
}

async function loadAndroidFsModule(): Promise<AndroidFsModule | null> {
  try {
    const mod = await import("tauri-plugin-android-fs-api");
    return mod as unknown as AndroidFsModule;
  } catch {
    return null;
  }
}

function hasAllowedExtension(fileName: string, allowed: Set<string>): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return false;
  const ext = fileName.slice(dot + 1).trim().toLowerCase();
  return allowed.has(ext);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(bytes);
  const buffer = normalized.buffer.slice(
    normalized.byteOffset,
    normalized.byteOffset + normalized.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hashBytes = new Uint8Array(digest);
  let hex = "";
  for (const b of hashBytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function groupByStatus(items: SyncItem[]): Record<OrderedStatus, SyncItem[]> {
  const grouped: Record<OrderedStatus, SyncItem[]> = {
    pending: [],
    uploaded: [],
    imported: [],
    blacklisted: [],
  };

  for (const item of items) {
    if (item.status === "pending") grouped.pending.push(item);
    else if (item.status === "uploaded") grouped.uploaded.push(item);
    else if (item.status === "imported") grouped.imported.push(item);
    else if (item.status === "blacklisted") grouped.blacklisted.push(item);
  }

  return grouped;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function waitForVisualCommit(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export default App;
