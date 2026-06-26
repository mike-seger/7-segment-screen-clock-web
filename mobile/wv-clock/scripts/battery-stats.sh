#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat >&2 <<EOF_USAGE
Usage: $0 [adb-device] [interval-seconds]

  adb-device        ADB device serial (default: samsung-t220:5555)
  interval-seconds  Positive integer (default: 30)

CSV columns:
  iso_timestamp,epoch,level_percent,status,power_direction,current_now_uA,current_now_mA,power_online,temperature_c,voltage_mV
EOF_USAGE
    exit 1
}

die() {
    echo "Error: $*" >&2
    exit 1
}

cleanup() {
    echo >&2
    echo "Stopped." >&2
}
trap cleanup INT TERM

# ------------------------------------------------------------------------------

[[ $# -le 2 ]] || usage

adb_connection="${1:-samsung-t220:5555}"
interval="${2:-30}"

[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "interval must be a positive integer."

command -v adb >/dev/null || die "adb not found in PATH."
command -v awk >/dev/null || die "awk not found in PATH."

adb -s "$adb_connection" get-state >/dev/null 2>&1 \
    || die "ADB device '$adb_connection' is not connected."

adb -s "$adb_connection" shell su -c true >/dev/null 2>&1 \
    || die "Root (su) is not available on '$adb_connection'."

adb_shell() {
    adb -s "$adb_connection" shell "$@"
}

adb_su_cat() {
    local path="$1"
    adb -s "$adb_connection" shell su -c "cat '$path'" | tr -d '\r\n'
}

adb_su_optional_cat() {
    local path="$1"
    adb -s "$adb_connection" shell su -c "cat '$path'" 2>/dev/null | tr -d '\r\n'
}

adb_su_readable() {
    local path="$1"
    adb -s "$adb_connection" shell su -c "test -r '$path'" >/dev/null 2>&1
}

# Only these are mandatory on every rooted Android device we care about.
for path in \
    /sys/class/power_supply/battery/current_now \
    /sys/class/power_supply/battery/status \
    /sys/class/power_supply/battery/capacity \
    /sys/class/power_supply/battery/voltage_now
do
    adb_su_readable "$path" || die "required battery path is not readable: $path"
done

read_power_online() {
    local value

    value="$(adb_su_optional_cat /sys/class/power_supply/ac/online)"
    if [[ "$value" =~ ^[01]$ ]]; then
        echo "$value"
        return
    fi

    value="$(adb_su_optional_cat /sys/class/power_supply/usb/online)"
    if [[ "$value" =~ ^[01]$ ]]; then
        echo "$value"
        return
    fi

    value="$(adb_su_optional_cat /sys/class/power_supply/dc/online)"
    if [[ "$value" =~ ^[01]$ ]]; then
        echo "$value"
        return
    fi

    adb_shell dumpsys battery | awk '
        /AC powered:/       { ac=$3 }
        /USB powered:/      { usb=$3 }
        /Wireless powered:/ { wireless=$3 }
        /Dock powered:/     { dock=$3 }
        END {
            if (ac=="true" || usb=="true" || wireless=="true" || dock=="true")
                print 1;
            else
                print 0;
        }'
}

read_temperature_c() {
    local raw

    # Common Linux power_supply convention: tenths of a degree C, e.g. 340 = 34.0C.
    raw="$(adb_su_optional_cat /sys/class/power_supply/battery/temp)"
    if [[ "$raw" =~ ^-?[0-9]+$ ]]; then
        awk "BEGIN { printf \"%.1f\", $raw / 10 }"
        return
    fi

    # Some devices expose whole degrees here, others expose tenths.
    raw="$(adb_su_optional_cat /sys/class/power_supply/battery/temperature)"
    if [[ "$raw" =~ ^-?[0-9]+$ ]]; then
        if (( raw >= 100 || raw <= -100 )); then
            awk "BEGIN { printf \"%.1f\", $raw / 10 }"
        else
            awk "BEGIN { printf \"%.1f\", $raw }"
        fi
        return
    fi

    # Last resort: dumpsys usually reports tenths of a degree C.
    raw="$(adb_shell dumpsys battery | awk '/temperature:/ {print $2; exit}' | tr -d '\r\n')"
    if [[ "$raw" =~ ^-?[0-9]+$ ]]; then
        awk "BEGIN { printf \"%.1f\", $raw / 10 }"
        return
    fi

    echo ""
}

power_direction_from_status() {
    local status="$1"
    case "$status" in
        Charging|Full)        echo "charging" ;;
        Discharging)          echo "discharging" ;;
        "Not charging")       echo "idle" ;;
        *)                    echo "unknown" ;;
    esac
}

# ------------------------------------------------------------------------------

echo "iso_timestamp,epoch,level_percent,status,power_direction,current_now_uA,current_now_mA,power_online,temperature_c,voltage_mV"

while true; do
    iso="$(date -Iseconds)"
    epoch="$(date +%s)"

    level="$(adb_su_cat /sys/class/power_supply/battery/capacity)"
    status="$(adb_su_cat /sys/class/power_supply/battery/status)"
    current_uA="$(adb_su_cat /sys/class/power_supply/battery/current_now)"
    voltage_uV="$(adb_su_cat /sys/class/power_supply/battery/voltage_now)"

    power_direction="$(power_direction_from_status "$status")"
    power_online="$(read_power_online)"
    temperature_c="$(read_temperature_c)"

    current_mA="$(awk "BEGIN { printf \"%.1f\", $current_uA / 1000 }")"
    voltage_mV="$(awk "BEGIN { printf \"%.0f\", $voltage_uV / 1000 }")"

    echo "$iso,$epoch,$level,$status,$power_direction,$current_uA,$current_mA,$power_online,$temperature_c,$voltage_mV"

    sleep "$interval"
done
