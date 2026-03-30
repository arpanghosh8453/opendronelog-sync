import type { ProfileInfo, SwitchProfileResponse } from "../types";

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  profile?: string;
  sessionToken?: string;
}

const REQUEST_TIMEOUT_MS = 12000;

function makeHeaders(opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (opts.profile) headers["X-Profile"] = opts.profile;
  if (opts.sessionToken) headers["X-Session"] = opts.sessionToken;

  return headers;
}

async function requestJson<T>(serverUrl: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: makeHeaders(opts),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`);
    }
    throw new Error(`Network request failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let text = "Request failed";
    try {
      text = await response.text();
    } catch {
      // no-op
    }
    throw new Error(`HTTP ${response.status} on ${path}: ${text}`);
  }

  return (await response.json()) as T;
}

export async function listProfiles(serverUrl: string): Promise<ProfileInfo[]> {
  return requestJson<ProfileInfo[]>(serverUrl, "/api/profiles");
}

export async function switchProfile(
  serverUrl: string,
  profile: string,
  password: string,
): Promise<SwitchProfileResponse> {
  return requestJson<SwitchProfileResponse>(serverUrl, "/api/profiles/switch", {
    method: "POST",
    body: {
      name: profile,
      password: password || null,
    },
  });
}

export async function getAllowedExtensions(
  serverUrl: string,
  profile: string,
  sessionToken: string,
): Promise<string[]> {
  const result = await requestJson<{ extensions: string[] }>(serverUrl, "/api/allowed_log_extensions", {
    profile,
    sessionToken,
  });
  return result.extensions ?? [];
}

export async function getServerFileHashes(
  serverUrl: string,
  profile: string,
  sessionToken: string,
): Promise<Set<string>> {
  const flights = await requestJson<Array<Record<string, unknown>>>(serverUrl, "/api/flights", {
    profile,
    sessionToken,
  });

  const hashes = new Set<string>();
  for (const flight of flights) {
    const camel = flight.fileHash;
    const snake = flight.file_hash;
    const value = typeof camel === "string" ? camel : typeof snake === "string" ? snake : "";
    if (value) hashes.add(value);
  }
  return hashes;
}

export async function getSyncBlacklist(
  serverUrl: string,
  profile: string,
  sessionToken: string,
): Promise<Set<string>> {
  const result = await requestJson<{ hashes: string[] }>(serverUrl, "/api/sync/blacklist", {
    profile,
    sessionToken,
  });
  return new Set(result.hashes ?? []);
}
