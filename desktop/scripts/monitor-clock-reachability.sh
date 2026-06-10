#!/usr/bin/env bash
set -u

SCRIPT_NAME="$(basename "$0")"
INPUT_FILE=""
PORT=8765
INTERVAL=5
DURATION=120
CSV_FILE=""

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME -f ips.txt [options]

Options:
  -f, --file PATH       Input list: IPv4 OR name<TAB>IPv4 per line
  -p, --port N          Port to test (default: 8765)
  -i, --interval N      Seconds between checks (default: 5)
  -d, --duration N      Total seconds to run (default: 120)
      --csv PATH        Optional CSV output path
  -h, --help            Show help

Example:
  $SCRIPT_NAME -f ips.txt -d 300 -i 5 --csv ../tmp/monitor.csv
EOF
}

is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

trim() {
  local s="$1"
  s="$(printf '%s\n' "$s" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  printf '%s\n' "$s"
}

is_ipv4() {
  local ip="$1"
  local a b c d octet
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS='.' read -r a b c d <<< "$ip"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]+$ ]] || return 1
    (( octet >= 0 && octet <= 255 )) || return 1
  done
  return 0
}

probe_tcp() {
  local ip="$1"
  local port="$2"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    nc -z -G 2 "$ip" "$port" >/dev/null 2>&1
  else
    nc -z -w 2 "$ip" "$port" >/dev/null 2>&1
  fi
}

probe_api() {
  local ip="$1"
  local port="$2"
  curl -sS --max-time 2 "http://${ip}:${port}/api/info" >/dev/null
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --file" >&2; exit 1; }
      INPUT_FILE="$1"
      ;;
    -p|--port)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --port" >&2; exit 1; }
      is_number "$1" || { echo "--port must be numeric" >&2; exit 1; }
      PORT="$1"
      ;;
    -i|--interval)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --interval" >&2; exit 1; }
      is_number "$1" || { echo "--interval must be numeric" >&2; exit 1; }
      INTERVAL="$1"
      ;;
    -d|--duration)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --duration" >&2; exit 1; }
      is_number "$1" || { echo "--duration must be numeric" >&2; exit 1; }
      DURATION="$1"
      ;;
    --csv)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --csv" >&2; exit 1; }
      CSV_FILE="$1"
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

[[ -n "$INPUT_FILE" ]] || { echo "--file is required" >&2; usage; exit 1; }
[[ -f "$INPUT_FILE" ]] || { echo "Input file not found: $INPUT_FILE" >&2; exit 1; }

NAMES=()
IPS=()
while IFS= read -r raw || [[ -n "$raw" ]]; do
  line="$(trim "$raw")"
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue

  if [[ "$line" == *$'\t'* ]]; then
    name="$(trim "${line%%$'\t'*}")"
    ip="$(trim "${line#*$'\t'}")"
    if [[ -z "$name" || -z "$ip" || "$ip" == *$'\t'* ]] || ! is_ipv4 "$ip"; then
      echo "Invalid line in $INPUT_FILE: $raw" >&2
      exit 1
    fi
    NAMES+=("$name")
    IPS+=("$ip")
  else
    if ! is_ipv4 "$line"; then
      echo "Invalid line in $INPUT_FILE: $raw" >&2
      exit 1
    fi
    NAMES+=("")
    IPS+=("$line")
  fi
done < "$INPUT_FILE"

[[ ${#IPS[@]} -gt 0 ]] || { echo "No devices in list." >&2; exit 1; }

EVER_UP=()
EVER_DOWN=()
for _ in "${IPS[@]}"; do
  EVER_UP+=(0)
  EVER_DOWN+=(0)
done

if [[ -n "$CSV_FILE" ]]; then
  printf 'timestamp,name,ip,tcp_open,api_ok\n' > "$CSV_FILE"
fi

echo "Monitoring ${#IPS[@]} devices for ${DURATION}s (interval ${INTERVAL}s) on port ${PORT}"

end_at=$(( $(date +%s) + DURATION ))
round=0
while [[ $(date +%s) -lt $end_at ]]; do
  round=$((round + 1))
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "[${ts}] round ${round}"

  for idx in "${!IPS[@]}"; do
    ip="${IPS[$idx]}"
    name="${NAMES[$idx]}"
    label="$ip"
    [[ -n "$name" ]] && label="${name} (${ip})"

    tcp_open="no"
    api_ok="no"

    if probe_tcp "$ip" "$PORT"; then
      tcp_open="yes"
      if probe_api "$ip" "$PORT"; then
        api_ok="yes"
      fi
    fi

    if [[ "$tcp_open" == "yes" && "$api_ok" == "yes" ]]; then
      EVER_UP[$idx]=1
      echo "  UP   ${label}"
    else
      EVER_DOWN[$idx]=1
      echo "  DOWN ${label} (tcp=${tcp_open}, api=${api_ok})"
    fi

    if [[ -n "$CSV_FILE" ]]; then
      safe_name="${name//\"/\"\"}"
      printf '"%s",%s,%s,%s,%s\n' "$safe_name" "$ip" "$ts" "$tcp_open" "$api_ok" >> "$CSV_FILE"
    fi
  done

  now=$(date +%s)
  if [[ $now -lt $end_at ]]; then
    sleep "$INTERVAL"
  fi
done

echo
echo "Summary"
for idx in "${!IPS[@]}"; do
  ip="${IPS[$idx]}"
  name="${NAMES[$idx]}"
  label="$ip"
  [[ -n "$name" ]] && label="${name} (${ip})"

  if [[ ${EVER_UP[$idx]} -eq 1 && ${EVER_DOWN[$idx]} -eq 1 ]]; then
    status="intermittent"
  elif [[ ${EVER_UP[$idx]} -eq 1 ]]; then
    status="stable-up"
  else
    status="stable-down"
  fi
  echo "  ${label}: ${status}"
done

if [[ -n "$CSV_FILE" ]]; then
  echo "CSV: $CSV_FILE"
fi
