#!/usr/bin/env bash
set -u

# Probes known clock devices for HTTP/API reachability.
# Default behavior is non-invasive (no wake/sleep trigger).

SCRIPT_NAME="$(basename "$0")"
DEFAULT_PORTS=(8765 8080)
CONNECT_TIMEOUT=2
CURL_TIMEOUT=3
TEST_CONTROL=0
DO_UDP_CHECK=0
INPUT_FILE=""
CSV_FILE=""

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME [options] <ip1> [ip2 ...]
  $SCRIPT_NAME [options] -f ip_list.txt

Options:
  -f, --file PATH         Read IPs from a file (one IP per line; '#' comments allowed)
  -p, --ports "P1 P2"      Ports to test (default: "8765 8080")
  -c, --connect-timeout N TCP connect timeout in seconds (default: ${CONNECT_TIMEOUT})
  -t, --curl-timeout N    HTTP request timeout in seconds (default: ${CURL_TIMEOUT})
      --test-control      Also POST /api/wake and /api/sleep (state-changing)
      --udp-check         Probe UDP 8766/8767 (best-effort signal only)
      --csv PATH          Write detailed per-IP/port report as CSV
  -h, --help              Show this help

Examples:
  $SCRIPT_NAME 192.168.1.20 192.168.1.21
  $SCRIPT_NAME -f ./ips.txt
  $SCRIPT_NAME --test-control -f ./ips.txt
  $SCRIPT_NAME --udp-check --csv ./tmp/clock-report.csv -f ./ips.txt
EOF
}

is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
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

trim() {
  local s="$1"
  # shellcheck disable=SC2001
  s="$(printf '%s\n' "$s" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  echo "$s"
}

read_ips_from_file() {
  local file="$1"
  local out=()
  local line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    raw_line="$line"
    line="$(trim "$line")"
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue

    # Accept strictly either "ip" or "name<TAB>ip" format.
    if [[ "$line" == *$'\t'* ]]; then
      local name_part="${line%%$'\t'*}"
      local ip_part="${line#*$'\t'}"
      name_part="$(trim "$name_part")"
      ip_part="$(trim "$ip_part")"
      if [[ -z "$name_part" || -z "$ip_part" || "$ip_part" == *$'\t'* ]] || ! is_ipv4 "$ip_part"; then
        echo "Error: invalid line ${line_no} in ${file}: ${raw_line}" >&2
        echo "Expected format: IPv4 or name<TAB>IPv4" >&2
        return 1
      fi
      out+=("${name_part}|${ip_part}")
    else
      if ! is_ipv4 "$line"; then
        echo "Error: invalid line ${line_no} in ${file}: ${raw_line}" >&2
        echo "Expected format: IPv4 or name<TAB>IPv4" >&2
        return 1
      fi
      out+=("|$line")
    fi
  done < "$file"
  printf '%s\n' "${out[@]}"
}

probe_tcp_port() {
  local ip="$1"
  local port="$2"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    nc -z -G "$CONNECT_TIMEOUT" "$ip" "$port" >/dev/null 2>&1
  else
    nc -z -w "$CONNECT_TIMEOUT" "$ip" "$port" >/dev/null 2>&1
  fi
}

probe_udp_port() {
  local ip="$1"
  local port="$2"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    nc -u -z -G "$CONNECT_TIMEOUT" "$ip" "$port" >/dev/null 2>&1
  else
    nc -u -z -w "$CONNECT_TIMEOUT" "$ip" "$port" >/dev/null 2>&1
  fi
}

fetch_info() {
  local ip="$1"
  local port="$2"
  curl -sS --max-time "$CURL_TIMEOUT" "http://${ip}:${port}/api/info" >/dev/null
}

post_control() {
  local ip="$1"
  local port="$2"
  local action="$3"
  curl -sS -o /dev/null -w "%{http_code}" --max-time "$CURL_TIMEOUT" -X POST "http://${ip}:${port}/api/${action}"
}

PORTS=("${DEFAULT_PORTS[@]}")
IPS=()
NAMES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -f|--file)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --file" >&2; exit 1; }
      INPUT_FILE="$1"
      ;;
    -p|--ports)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --ports" >&2; exit 1; }
      # Intentionally split on spaces.
      # shellcheck disable=SC2206
      PORTS=($1)
      ;;
    -c|--connect-timeout)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --connect-timeout" >&2; exit 1; }
      is_number "$1" || { echo "--connect-timeout must be numeric" >&2; exit 1; }
      CONNECT_TIMEOUT="$1"
      ;;
    -t|--curl-timeout)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --curl-timeout" >&2; exit 1; }
      is_number "$1" || { echo "--curl-timeout must be numeric" >&2; exit 1; }
      CURL_TIMEOUT="$1"
      ;;
    --test-control)
      TEST_CONTROL=1
      ;;
    --udp-check)
      DO_UDP_CHECK=1
      ;;
    --csv)
      shift
      [[ $# -eq 0 ]] && { echo "Missing value for --csv" >&2; exit 1; }
      CSV_FILE="$1"
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        IPS+=("$1")
        shift
      done
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      IPS+=("$1")
      NAMES+=("")
      ;;
  esac
  shift
done

if [[ -n "$INPUT_FILE" ]]; then
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "IP file not found: $INPUT_FILE" >&2
    exit 1
  fi
  file_records="$(read_ips_from_file "$INPUT_FILE")" || exit 1
  while IFS= read -r record; do
    [[ -z "$record" ]] && continue
    local_name="${record%%|*}"
    local_ip="${record#*|}"
    [[ -z "$local_ip" ]] && continue
    IPS+=("$local_ip")
    NAMES+=("$local_name")
  done <<< "$file_records"
fi

if [[ ${#IPS[@]} -eq 0 ]]; then
  echo "No IPs provided." >&2
  usage
  exit 1
fi

# Remove duplicates while preserving order.
UNIQUE_IPS=()
UNIQUE_NAMES=()
for idx in "${!IPS[@]}"; do
  ip="${IPS[$idx]}"
  name="${NAMES[$idx]:-}"
  already_seen=0
  existing_idx=0
  if [[ ${#UNIQUE_IPS[@]} -gt 0 ]]; then
    for existing in "${UNIQUE_IPS[@]}"; do
      if [[ "$existing" == "$ip" ]]; then
        already_seen=1
        break
      fi
      existing_idx=$((existing_idx + 1))
    done
  fi
  if [[ "$already_seen" -eq 0 ]]; then
    UNIQUE_IPS+=("$ip")
    UNIQUE_NAMES+=("$name")
  else
    # If duplicate IP appears with a name later and current stored name is empty, fill it.
    if [[ -n "$name" && -z "${UNIQUE_NAMES[$existing_idx]:-}" ]]; then
      UNIQUE_NAMES[$existing_idx]="$name"
    fi
  fi
done

printf 'Clock reachability test\n'
printf '  IPs: %s\n' "${#UNIQUE_IPS[@]}"
printf '  Ports: %s\n' "${PORTS[*]}"
printf '  Control tests: %s\n\n' "$([[ "$TEST_CONTROL" -eq 1 ]] && echo enabled || echo disabled)"
printf '  UDP checks: %s\n' "$([[ "$DO_UDP_CHECK" -eq 1 ]] && echo enabled || echo disabled)"
if [[ -n "$CSV_FILE" ]]; then
  printf '  CSV output: %s\n\n' "$CSV_FILE"
  header='name,ip'
  if [[ "$DO_UDP_CHECK" -eq 1 ]]; then
    header+=',udp8766_probe,udp8767_probe'
  fi
  for port in "${PORTS[@]}"; do
    header+=",p${port}_tcp,p${port}_api_info"
    if [[ "$TEST_CONTROL" -eq 1 ]]; then
      header+=",p${port}_wake,p${port}_sleep"
    fi
  done
  printf '%s\n' "$header" > "$CSV_FILE"
else
  printf '\n'
fi

ok_info=0
ok_tcp=0
total_tcp=0

for idx in "${!UNIQUE_IPS[@]}"; do
  ip="${UNIQUE_IPS[$idx]}"
  name="${UNIQUE_NAMES[$idx]:-}"
  if [[ -n "$name" ]]; then
    echo "=== ${name} (${ip}) ==="
  else
    echo "=== $ip ==="
  fi
  any_info_ok=0
  udp_8766_status="skipped"
  udp_8767_status="skipped"
  csv_port_cells=''

  if [[ "$DO_UDP_CHECK" -eq 1 ]]; then
    if probe_udp_port "$ip" 8766; then
      udp_8766_status="probe-ok"
    else
      udp_8766_status="no-response"
    fi
    if probe_udp_port "$ip" 8767; then
      udp_8767_status="probe-ok"
    else
      udp_8767_status="no-response"
    fi
    echo "udp/8766 probe: ${udp_8766_status}"
    echo "udp/8767 probe: ${udp_8767_status}"
  fi

  for port in "${PORTS[@]}"; do
    total_tcp=$((total_tcp + 1))
    tcp_open="no"
    api_info_ok="no"
    wake_code="NA"
    sleep_code="NA"

    if probe_tcp_port "$ip" "$port"; then
      echo "tcp/${port}: open"
      ok_tcp=$((ok_tcp + 1))
      tcp_open="yes"

      if fetch_info "$ip" "$port"; then
        echo "GET /api/info on ${port}: ok"
        any_info_ok=1
        api_info_ok="yes"
      else
        echo "GET /api/info on ${port}: fail"
      fi

      if [[ "$TEST_CONTROL" -eq 1 ]]; then
        wake_code="$(post_control "$ip" "$port" wake || true)"
        sleep_code="$(post_control "$ip" "$port" sleep || true)"
        [[ -z "$wake_code" ]] && wake_code="ERR"
        [[ -z "$sleep_code" ]] && sleep_code="ERR"
        echo "POST /api/wake on ${port}: ${wake_code}"
        echo "POST /api/sleep on ${port}: ${sleep_code}"
      fi
    else
      echo "tcp/${port}: closed/unreachable"
    fi

    if [[ "$TEST_CONTROL" -eq 1 ]]; then
      csv_port_cells+=",${tcp_open},${api_info_ok},${wake_code},${sleep_code}"
    else
      csv_port_cells+=",${tcp_open},${api_info_ok}"
    fi
  done

  if [[ -n "$CSV_FILE" ]]; then
    # Quote name in CSV so commas in labels don't break columns.
    safe_name="${name//\"/\"\"}"
    if [[ "$DO_UDP_CHECK" -eq 1 ]]; then
      printf '"%s",%s,%s,%s%s\n' \
        "$safe_name" "$ip" "$udp_8766_status" "$udp_8767_status" "$csv_port_cells" >> "$CSV_FILE"
    else
      printf '"%s",%s%s\n' \
        "$safe_name" "$ip" "$csv_port_cells" >> "$CSV_FILE"
    fi
  fi

  if [[ "$any_info_ok" -eq 1 ]]; then
    ok_info=$((ok_info + 1))
  fi
  echo

done

echo "Summary"
echo "  Open TCP checks: ${ok_tcp}/${total_tcp}"
echo "  Devices with at least one reachable /api/info: ${ok_info}/${#UNIQUE_IPS[@]}"
if [[ "$DO_UDP_CHECK" -eq 1 ]]; then
  echo "  UDP probe labels: probe-ok means packet accepted locally; UDP remains connectionless and not definitive."
fi
if [[ -n "$CSV_FILE" ]]; then
  echo "  CSV report: ${CSV_FILE}"
fi

if [[ "$ok_info" -eq 0 ]]; then
  printf '\nNo device responded to /api/info. Discovery on UDP 8766 can still work even when TCP APIs are blocked.\n'
  exit 2
fi
