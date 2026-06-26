#!/bin/bash

adb_connection="${1:-samsung-t220:5555}"
interval="${2:-30}"

while true; do
  iso="$(date -Iseconds)"
  current="$(adb -s $adb_connection shell su -c 'cat /sys/class/power_supply/battery/current_now' | tr -d '\r\n')"
  level="$(adb -s $adb_connection shell dumpsys battery | awk "/level:/ {print \$2}")"
  echo "$iso,$level,$current"
  sleep "$interval"
done
