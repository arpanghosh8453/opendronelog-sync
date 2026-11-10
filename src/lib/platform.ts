export function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * True for hosts that can't be reached from the public internet: this device,
 * private (RFC 1918), carrier-grade NAT (Tailscale), link-local and IPv6
 * unique-local addresses, and .local / .lan / .home.arpa / .internal names.
 * Keep in step with isLocalNetworkHost in OdlClient.kt and src-tauri/src/lib.rs.
 */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if ([".local", ".lan", ".home.arpa", ".internal"].some((s) => host.endsWith(s))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) {
    return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/**
 * Why a server address isn't safe to log in to, or null when it is.
 * https:// is always fine; plain http:// only for hosts on your own network,
 * because it sends the profile password and session unencrypted.
 */
export function serverUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter the full server address, for example https://logs.example.com.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol !== "http:") return "The server address must start with https://.";
  if (isLocalNetworkHost(parsed.hostname)) return null;
  return "Use https:// for this server. Plain http:// is only allowed for servers on your own network, because it sends your password unencrypted.";
}
