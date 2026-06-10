#!/usr/bin/env bash
set -u

SCRIPT_NAME="$(basename "$0")"
SERIAL=""
LINES=120

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME [-s SERIAL] [--lines N]

Checks one USB-connected tablet for local clock server health without curl.

Options:
  -s, --serial SERIAL   Specific adb serial (optional)
      --lines N         Number of recent app log lines to show (default: 120)
  -h, --help            Show help

Before running:
  Plug in exactly one target device via USB (or pass --serial).
EOF
}

is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

list_connected_serials() {
  adb devices | awk 'NR>1 && /\tdevice$/ {print $1}'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--serial)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --serial" >&2; exit 1; }
      SERIAL="$1"
      ;;
    --lines)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --lines" >&2; exit 1; }
      is_number "$1" || { echo "--lines must be numeric" >&2; exit 1; }
      LINES="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

ADB=(adb)
if [[ -n "$SERIAL" ]]; then
  if ! list_connected_serials | grep -Fxq "$SERIAL"; then
    echo "Provided serial not found: $SERIAL" >&2
    echo "Connected devices:" >&2
    adb devices >&2
    echo "Tip: copy an exact serial from the first column above and pass --serial <that-value>." >&2
    exit 1
  fi
  ADB=(adb -s "$SERIAL")
fi

if [[ -z "$SERIAL" ]]; then
  count=$(adb devices | awk 'NR>1 && /\tdevice$/ {n++} END {print n+0}')
  if [[ "$count" -eq 0 ]]; then
    echo "No adb device connected." >&2
    exit 1
  fi
  if [[ "$count" -gt 1 ]]; then
    echo "Multiple adb devices connected. Re-run with --serial." >&2
    adb devices
    exit 1
  fi
fi

echo "== Device =="
"${ADB[@]}" shell getprop ro.product.model | tr -d '\r'
"${ADB[@]}" shell getprop ro.serialno | tr -d '\r'

echo
echo "== Wi-Fi IPv4 =="
"${ADB[@]}" shell "ip -4 addr show wlan0 | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p'"

echo
echo "== Port 8765 Listener =="
"${ADB[@]}" shell "ss -ltn 2>/dev/null | grep 8765 || netstat -ltn 2>/dev/null | grep 8765 || true"

echo
echo "== Local HTTP probe via nc =="
"${ADB[@]}" shell "printf 'GET /api/info HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' | nc -w 3 127.0.0.1 8765 | head -n 1"

echo
echo "== Recent app logs (WvClock/ClockServer) =="
"${ADB[@]}" shell "logcat -d -s WvClock ClockServer | tail -n ${LINES}"
