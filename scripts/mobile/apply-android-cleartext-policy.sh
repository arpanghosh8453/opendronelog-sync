#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRADLE_FILE="$ROOT_DIR/src-tauri/gen/android/app/build.gradle.kts"

# Default to allowing cleartext on release so self-hosted LAN http://ip:port works.
# Set ODLS_ANDROID_RELEASE_CLEARTEXT=false to disable in security-focused builds.
RELEASE_CLEARTEXT="${ODLS_ANDROID_RELEASE_CLEARTEXT:-true}"

if [[ "$RELEASE_CLEARTEXT" != "true" && "$RELEASE_CLEARTEXT" != "false" ]]; then
  echo "Invalid ODLS_ANDROID_RELEASE_CLEARTEXT value: $RELEASE_CLEARTEXT (expected true or false)" >&2
  exit 1
fi

if [[ ! -f "$GRADLE_FILE" ]]; then
  echo "Android Gradle file not found yet: $GRADLE_FILE"
  echo "Run 'npm run tauri -- android init' first."
  exit 0
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

awk -v release_value="$RELEASE_CLEARTEXT" '
BEGIN {
  in_release = 0
  release_has_placeholder = 0
}
{
  if ($0 ~ /getByName\("release"\) \{/) {
    in_release = 1
    release_has_placeholder = 0
    print
    next
  }

  if (in_release && $0 ~ /manifestPlaceholders\["usesCleartextTraffic"\]/) {
    print "            manifestPlaceholders[\"usesCleartextTraffic\"] = \"" release_value "\""
    release_has_placeholder = 1
    next
  }

  if (in_release && $0 ~ /isMinifyEnabled = true/ && !release_has_placeholder) {
    print "            manifestPlaceholders[\"usesCleartextTraffic\"] = \"" release_value "\""
    release_has_placeholder = 1
  }

  if (in_release && $0 ~ /^        }$/) {
    in_release = 0
  }

  print
}
' "$GRADLE_FILE" > "$TMP_FILE"

mv "$TMP_FILE" "$GRADLE_FILE"

echo "Applied Android release cleartext policy: usesCleartextTraffic=$RELEASE_CLEARTEXT"
echo "Updated: $GRADLE_FILE"
