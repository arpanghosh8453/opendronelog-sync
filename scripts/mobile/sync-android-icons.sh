#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ICON="$ROOT_DIR/public/favicon.png"
TAURI_ICON="$ROOT_DIR/src-tauri/icons/icon.png"
SOURCE_ANDROID_DIR="$ROOT_DIR/src-tauri/icons/android"
ANDROID_RES_DIR="$ROOT_DIR/src-tauri/gen/android/app/src/main/res"

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Source icon not found: $SOURCE_ICON" >&2
  exit 1
fi

cp -f "$SOURCE_ICON" "$TAURI_ICON"
echo "Synced Tauri source icon: $TAURI_ICON"

# Keep source Android launcher assets in sync as well.
if [[ -d "$SOURCE_ANDROID_DIR" ]]; then
  while IFS= read -r target; do
    cp -f "$SOURCE_ICON" "$target"
  done < <(find "$SOURCE_ANDROID_DIR" -type f \( -name 'ic_launcher.png' -o -name 'ic_launcher_round.png' -o -name 'ic_launcher_foreground.png' \))
  echo "Synced source Android launcher assets under: $SOURCE_ANDROID_DIR"
fi

if [[ ! -d "$ANDROID_RES_DIR" ]]; then
  echo "Android generated resources not found yet. Run android init/build first."
  exit 0
fi

while IFS= read -r target; do
  cp -f "$SOURCE_ICON" "$target"
done < <(find "$ANDROID_RES_DIR" -type f \( -name 'ic_launcher.png' -o -name 'ic_launcher_round.png' -o -name 'ic_launcher_foreground.png' \))

rm -f "$ANDROID_RES_DIR/mipmap-anydpi-v26/ic_launcher.xml" "$ANDROID_RES_DIR/mipmap-anydpi-v26/ic_launcher_round.xml"

echo "Synced generated Android launcher icon assets under: $ANDROID_RES_DIR"
