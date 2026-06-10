#!/usr/bin/env bash
set -u

SCRIPT_NAME="$(basename "$0")"
TARGET_IP=""
TARGET_NAME=""
PORT=8765
DO_CURL=1
VERBOSE=0
INPUT_FILE=""

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME --ip IP [options]
  $SCRIPT_NAME -f ips.txt [options]

Options:
  --ip IP           Target tablet IPv4 address (required)
  -f, --file PATH   Input list: IPv4 OR name<TAB>IPv4 per line (uses first row)
  -p, --port N      TCP port to probe (default: 8765)
  -v, --verbose     Show ARP/ping/TCP/HTTP details before conclusion
  --no-curl         Skip HTTP probe, only check ARP/ping/TCP
  -h, --help        Show help

Examples:
  $SCRIPT_NAME --ip 192.168.1.212
  $SCRIPT_NAME --ip 192.168.1.212 --no-curl
  $SCRIPT_NAME -f ips.txt
  $SCRIPT_NAME -f ips.txt --verbose
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

load_first_target_from_file() {
  local file="$1"
  local line
  local name
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue

    if [[ "$line" == *$'\t'* ]]; then
      name="$(trim "${line%%$'\t'*}")"
      line="$(trim "${line#*$'\t'}")"
    fi

    if is_ipv4 "$line"; then
      printf '%s\t%s\n' "${name:-}" "$line"
      return 0
    fi
  done < "$file"
  return 1
}

load_all_targets_from_file() {
  local file="$1"
  local line
  local name
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue

    name=""
    if [[ "$line" == *$'\t'* ]]; then
      name="$(trim "${line%%$'\t'*}")"
      line="$(trim "${line#*$'\t'}")"
    fi

    if is_ipv4 "$line"; then
      printf '%s\t%s\n' "$name" "$line"
    fi
  done < "$file"
}

run_target_check() {
  local target_name="$1"
  local target_ip="$2"
  local target_port="$3"

  local arp_line=""
  local ping_ok=0
  local tcp_ok=0

  if [[ "$VERBOSE" -eq 1 ]]; then
    echo "Target: ${target_name:+$target_name }(${target_ip}):${target_port}"
    echo
    echo "== ARP =="
    arp_line="$(arp -an 2>/dev/null | grep -F "(${target_ip})" || true)"
    if [[ -n "$arp_line" ]]; then
      echo "$arp_line"
    else
      echo "No ARP entry"
    fi

    echo
    echo "== Ping =="
    if ping -c 1 -W 1000 "$target_ip" >/tmp/mac-clock-lan-check-ping.out 2>&1; then
      echo "Ping OK"
      ping_ok=1
    else
      echo "Ping failed"
    fi
    sed -n '1,4p' /tmp/mac-clock-lan-check-ping.out 2>/dev/null || true
    rm -f /tmp/mac-clock-lan-check-ping.out

    echo
    echo "== TCP =="
    if nc -z -v -G 2 "$target_ip" "$target_port" >/tmp/mac-clock-lan-check-nc.out 2>&1; then
      echo "TCP ${target_port} open"
      tcp_ok=1
    else
      echo "TCP ${target_port} closed/unreachable"
    fi
    sed -n '1,4p' /tmp/mac-clock-lan-check-nc.out 2>/dev/null || true
    rm -f /tmp/mac-clock-lan-check-nc.out

    if [[ "$DO_CURL" -eq 1 ]]; then
      echo
      echo "== HTTP =="
      if curl -sS --connect-timeout 2 --max-time 3 "http://${target_ip}:${target_port}/api/info" >/tmp/mac-clock-lan-check-curl.out 2>&1; then
        echo "HTTP /api/info OK"
        sed -n '1,4p' /tmp/mac-clock-lan-check-curl.out 2>/dev/null || true
      else
        echo "HTTP /api/info failed"
        sed -n '1,6p' /tmp/mac-clock-lan-check-curl.out 2>/dev/null || true
      fi
      rm -f /tmp/mac-clock-lan-check-curl.out
    fi
  else
    arp_line="$(arp -an 2>/dev/null | grep -F "(${target_ip})" || true)"
    ping -c 1 -W 1000 "$target_ip" >/dev/null 2>&1 && ping_ok=1
    nc -z -G 2 "$target_ip" "$target_port" >/dev/null 2>&1 && tcp_ok=1
  fi

  echo -n "${target_name:+$target_name }(${target_ip}): "
  if [[ -n "$arp_line" ]] && [[ "$ping_ok" -eq 1 ]] && [[ "$tcp_ok" -eq 1 ]]; then
    echo "local app likely OK; LAN path reachable"
  elif [[ -z "$arp_line" ]]; then
    echo "LAN path broken at layer 2/ARP or the host is asleep/down"
  elif [[ "$ping_ok" -eq 0 ]]; then
    echo "tablet is not answering ICMP on the LAN"
  elif [[ "$tcp_ok" -eq 0 ]]; then
    echo "tablet answers on LAN but TCP ${target_port} is blocked/unreachable"
  else
    echo "mixed result; check HTTP/app logs next"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --file" >&2; exit 1; }
      INPUT_FILE="$1"
      ;;
    --ip)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --ip" >&2; exit 1; }
      TARGET_IP="$1"
      ;;
    -p|--port)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --port" >&2; exit 1; }
      is_number "$1" || { echo "--port must be numeric" >&2; exit 1; }
      PORT="$1"
      ;;
    -v|--verbose)
      VERBOSE=1
      ;;
    --no-curl)
      DO_CURL=0
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

if [[ -n "$INPUT_FILE" ]]; then
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "Input file not found: $INPUT_FILE" >&2
    exit 1
  fi
  if [[ -n "$TARGET_IP" ]]; then
    echo "Use either --ip or --file, not both." >&2
    exit 1
  fi
  target_pair="$(load_first_target_from_file "$INPUT_FILE")" || {
    echo "No valid IPv4 address found in: $INPUT_FILE" >&2
    exit 1
  }
  TARGET_NAME="${target_pair%%$'\t'*}"
  TARGET_IP="${target_pair#*$'\t'}"
fi

if [[ -n "$INPUT_FILE" ]]; then
  found_any=0
  while IFS=$'\t' read -r name ip; do
    [[ -z "$ip" ]] && continue
    found_any=1
    run_target_check "$name" "$ip" "$PORT"
  done < <(load_all_targets_from_file "$INPUT_FILE")
  if [[ "$found_any" -eq 0 ]]; then
    echo "No valid IPv4 address found in: $INPUT_FILE" >&2
    exit 1
  fi
else
  if [[ -z "$TARGET_IP" ]]; then
    echo "--ip is required" >&2
    usage
    exit 1
  fi
  run_target_check "$TARGET_NAME" "$TARGET_IP" "$PORT"
fi
