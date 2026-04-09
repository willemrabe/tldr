#!/usr/bin/env bash
# ------------------------------------------------------------------
# Autlaut — Install native messaging host
#
# Registers the native messaging host so the browser extension can
# start / stop the TTS server automatically.
#
# Usage:
#   ./install_host.sh <extension-id>
#
#   The extension ID is shown on chrome://extensions when developer
#   mode is enabled (e.g. "abcdefghijklmnopabcdefghijklmnop").
#
#   Optionally set PYTHON to the Python interpreter that has the
#   server dependencies installed:
#     PYTHON=/path/to/venv/bin/python ./install_host.sh <ext-id>
# ------------------------------------------------------------------

set -euo pipefail

HOST_NAME="com.autlaut.tts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/autlaut_host.py"

# --- Validate args ---

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo ""
  echo "Find your extension ID at chrome://extensions (enable Developer mode)."
  exit 1
fi

EXT_ID="$1"

if [[ ! "${EXT_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Warning: '${EXT_ID}' doesn't look like a standard extension ID."
  read -rp "Continue anyway? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 1
fi

# --- Resolve Python ---

PYTHON="${PYTHON:-$(command -v python3 || command -v python)}"
if [[ -z "$PYTHON" ]]; then
  echo "Error: could not find python3. Set PYTHON=/path/to/python."
  exit 1
fi

echo "Using Python: $PYTHON"

# Verify the interpreter can import the dependencies
if ! "$PYTHON" -c "import fastapi, kokoro, uvicorn" 2>/dev/null; then
  echo "Warning: $PYTHON is missing server dependencies (fastapi, kokoro, uvicorn)."
  echo "Install them first:  $PYTHON -m pip install -r $SCRIPT_DIR/requirements.txt"
  read -rp "Continue anyway? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 1
fi

# --- Make host script executable ---

chmod +x "$HOST_SCRIPT"

# --- Create a small launcher that uses the correct Python ---

LAUNCHER="$SCRIPT_DIR/autlaut_host_launcher.sh"
cat > "$LAUNCHER" <<LAUNCH
#!/usr/bin/env bash
exec "$PYTHON" "$HOST_SCRIPT"
LAUNCH
chmod +x "$LAUNCHER"

# --- Determine target directory ---

if [[ "$OSTYPE" == darwin* ]]; then
  # macOS — supports Chrome, Chromium, Brave, Edge
  TARGETS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  )
else
  # Linux
  TARGETS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
  )
fi

INSTALLED=0

for DIR in "${TARGETS[@]}"; do
  # Only install if the parent browser config dir exists
  PARENT="$(dirname "$DIR")"
  if [[ -d "$PARENT" ]]; then
    mkdir -p "$DIR"
    MANIFEST="$DIR/${HOST_NAME}.json"
    cat > "$MANIFEST" <<MANIFEST
{
  "name": "${HOST_NAME}",
  "description": "Autlaut TTS Server Manager",
  "path": "${LAUNCHER}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
MANIFEST
    echo "Installed: $MANIFEST"
    INSTALLED=1
  fi
done

if [[ "$INSTALLED" -eq 0 ]]; then
  echo "Error: could not find any Chromium-based browser config directory."
  echo "Create the directory manually and re-run, or copy the manifest yourself."
  exit 1
fi

echo ""
echo "Done! Reload the extension and the server will start automatically."
