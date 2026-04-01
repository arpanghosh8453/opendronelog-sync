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

# Copy all Android launcher resources (PNG + XML) from source icons into generated res,
# preserving relative paths. This keeps adaptive icon resources in sync for AAB builds.
if [[ -d "$SOURCE_ANDROID_DIR" ]]; then
  while IFS= read -r source_file; do
    rel_path="${source_file#"$SOURCE_ANDROID_DIR/"}"
    target="$ANDROID_RES_DIR/$rel_path"
    mkdir -p "$(dirname "$target")"
    cp -f "$source_file" "$target"
  done < <(find "$SOURCE_ANDROID_DIR" -type f)
fi

# Ensure generated adaptive icon layers never fall back to Tauri defaults.
mkdir -p "$ANDROID_RES_DIR/drawable-v24" "$ANDROID_RES_DIR/drawable"
cat > "$ANDROID_RES_DIR/drawable-v24/ic_launcher_foreground.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android"
  android:gravity="center"
  android:src="@mipmap/ic_launcher_foreground" />
EOF

cat > "$ANDROID_RES_DIR/drawable/ic_launcher_background.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="#FFFFFF" />
</shape>
EOF

echo "Synced generated Android launcher icon assets under: $ANDROID_RES_DIR"
