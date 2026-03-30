export function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
