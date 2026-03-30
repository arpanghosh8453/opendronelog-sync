#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ANDROID_DIR="$ROOT_DIR/src-tauri/icons/android"
ANDROID_RES_DIR="$ROOT_DIR/src-tauri/gen/android/app/src/main/res"

if [[ ! -d "$SOURCE_ANDROID_DIR" ]]; then
  echo "Source Android icon directory not found: $SOURCE_ANDROID_DIR" >&2
  exit 1
fi

if [[ ! -d "$ANDROID_RES_DIR" ]]; then
  echo "Android generated resources not found yet. Run android init/build first."
  exit 0
fi

for dir in mipmap-anydpi-v26 mipmap-hdpi mipmap-mdpi mipmap-xhdpi mipmap-xxhdpi mipmap-xxxhdpi values; do
  if [[ -d "$SOURCE_ANDROID_DIR/$dir" ]]; then
    mkdir -p "$ANDROID_RES_DIR/$dir"
    cp -f "$SOURCE_ANDROID_DIR/$dir"/* "$ANDROID_RES_DIR/$dir/"
  fi
done

echo "Synced Android launcher icons to: $ANDROID_RES_DIR"
