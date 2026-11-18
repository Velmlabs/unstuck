#!/usr/bin/env bash
# Installs the Android SDK pieces this app builds with into $ANDROID_HOME (default ~/android-sdk).
# Needs Java 17+ and network access to dl.google.com.
set -euo pipefail
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL "https://dl.google.com/android/repository/$TOOLS_ZIP" -o "$tmp/tools.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-35" "build-tools;35.0.0" >/dev/null
echo "Android SDK ready in $ANDROID_HOME (set ANDROID_HOME or sdk.dir in local.properties)"
