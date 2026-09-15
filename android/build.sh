#!/usr/bin/env bash
#
# Builds a debug-signed APK using only the Android SDK command-line tools — no Gradle,
# no Maven, no Android Studio. The app depends on nothing but android.jar, so the whole
# pipeline is: aapt2 compile -> aapt2 link -> javac -> d8 -> zip -> zipalign -> apksigner.
#
# The version comes from AndroidManifest.xml (single source of truth), so bumping the app
# means editing the manifest (and app/build.gradle, which Gradle uses) — not this script.
#
# Usage:  ./build.sh
# Env:    ANDROID_SDK_ROOT (default /tmp/android/sdk), JAVA_HOME (default /tmp/android/jdk)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/tmp/android/sdk}}"
JT="${ANDROID_JAVA_HOME:-${JAVA_HOME:-/tmp/android/jdk}}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
APP="$HERE/app/src/main"
MANIFEST="$APP/AndroidManifest.xml"
OUT="$HERE/build"
DIST="$HERE/dist"
MIN_SDK=24
TARGET_SDK=34

for t in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$JT/bin/javac" "$JT/bin/keytool" "$PLATFORM" "$MANIFEST"; do
  [ -e "$t" ] || { echo "ERROR: missing tool or file: $t" >&2; exit 1; }
done

VERSION_CODE="$(grep -oE 'android:versionCode="[0-9]+"' "$MANIFEST" | grep -oE '[0-9]+' | head -1)"
VERSION_NAME="$(grep -oE 'android:versionName="[^"]+"' "$MANIFEST" | sed -E 's/.*="([^"]+)".*/\1/' | head -1)"
[ -n "$VERSION_CODE" ] && [ -n "$VERSION_NAME" ] || { echo "ERROR: versionCode/versionName not found in $MANIFEST" >&2; exit 1; }
NAME="titan-md-${VERSION_NAME}-debug.apk"

export JAVA_HOME="$JT"
export PATH="$JT/bin:$PATH"

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex" "$DIST"

echo "== 0/6  version ${VERSION_NAME} (${VERSION_CODE}) -> ${NAME}"
echo "== 1/6  aapt2 compile (resources)"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip"

echo "== 2/6  aapt2 link (resources + manifest)"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$MANIFEST" \
  -R "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "== 3/6  javac"
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
if ! "$JT/bin/javac" \
      -source 8 -target 8 \
      -bootclasspath "$PLATFORM" \
      -classpath "$PLATFORM" \
      -encoding UTF-8 \
      -d "$OUT/classes" \
      @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
  echo "javac failed:" >&2
  cat "$OUT/javac.log" >&2
  exit 1
fi
grep -v 'obsolete\|bootstrap class path' "$OUT/javac.log" || true

echo "== 4/6  d8 (dex)"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --lib "$PLATFORM" --min-api "$MIN_SDK" --output "$OUT/dex" @"$OUT/classes.txt"

echo "== 5/6  package classes.dex + zipalign"
python3 - "$OUT/base.apk" "$OUT/dex/classes.dex" <<'PY'
import os, shutil, sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
tmp = apk + ".tmp"
shutil.copyfile(apk, tmp)
with zipfile.ZipFile(tmp, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
os.replace(tmp, apk)
print("    classes.dex embedded")
PY
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "== 6/6  sign (debug keystore)"
KS="$HERE/debug.keystore"
if [ ! -e "$KS" ]; then
  echo "    generating $KS"
  "$JT/bin/keytool" -genkeypair \
    -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$DIST/$NAME" "$OUT/aligned.apk"

echo
"$BT/apksigner" verify --print-certs "$DIST/$NAME" | head -4
ls -lh "$DIST/$NAME" | awk '{print "built:", $9, $5}'
echo "APK: $DIST/$NAME"
