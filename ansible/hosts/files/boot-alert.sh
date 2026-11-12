#!/bin/bash
# Managed by Ansible (containers-at-home, ansible/hosts/boot-safeguard.yml) - do not edit on the host.
#
# Runs once per boot (boot-alert.service). If the PREVIOUS boot did not end with a
# clean shutdown, or its kernel log shows an oops/BUG/panic, send a Telegram alert.
# Pairs with panic_on_oops=1 panic=10: a kernel oops reboots the box instead of
# hanging it, and this script is how you find out that it happened.
#   boot-alert          check the previous boot (normal use, from the service)
#   boot-alert --test   send a test message
set -u
. /etc/boot-alert.env          # TELEGRAM_TOKEN, CHAT_ID (root-only, rendered from the vault)
HOST=$(hostname -s)

send() {
  local i
  for i in $(seq 1 20); do      # network/DNS may still be settling right after boot
    if curl -fsS -m 20 -o /dev/null \
         --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=$1" \
         "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage"; then
      logger -t boot-alert "alert sent"; return 0
    fi
    sleep 30
  done
  logger -t boot-alert "could not reach Telegram - alert NOT sent"; return 1
}

if [ "${1:-}" = "--test" ]; then
  send "✅ ${HOST}: boot-alert test - kernel $(uname -r), up since $(uptime -s)"
  exit $?
fi

# no previous boot in the journal -> nothing to judge
journalctl -b -1 -q -n1 --no-pager >/dev/null 2>&1 || { logger -t boot-alert "no previous boot in journal"; exit 0; }

reasons=()
# Every intentional reboot/poweroff logs one of these early in the shutdown.
if ! journalctl -b -1 -q -o cat --no-pager | grep -qE 'System is (rebooting|powering down|halting)'; then
  reasons+=("no clean shutdown (kernel panic/oops reboot, hang + power cycle, watchdog or power loss)")
fi
oops=$(journalctl -b -1 -k -q -o cat --no-pager \
        | grep -E 'Oops|kernel BUG|Kernel panic|Internal error|list_add corruption|soft lockup|hard LOCKUP|hung_task|blocked for more than' \
        | head -5 | cut -c1-160)
if [ -n "$oops" ]; then reasons+=("kernel errors in the previous boot"); fi
# systemd-pstore archives panic logs here (only if the firmware/EFI backend kept any)
pst=$(find /var/lib/systemd/pstore -mindepth 1 -maxdepth 1 -newermt "$(uptime -s)" 2>/dev/null | head -3)
if [ -n "$pst" ]; then reasons+=("pstore crash dump saved: ${pst//$'\n'/ }"); fi

if [ ${#reasons[@]} -eq 0 ]; then logger -t boot-alert "previous boot ended cleanly"; exit 0; fi

first=$(journalctl -b -1 -q -o short-iso --no-pager | head -1 | cut -d' ' -f1)
last=$(journalctl -b -1 -q -o short-iso --no-pager -n1 | cut -d' ' -f1)
msg="⚠️ ${HOST} rebooted unexpectedly
previous boot: ${first} … ${last} (clock may be off right after boot)
$(printf -- '- %s\n' "${reasons[@]}")"
if [ -n "$oops" ]; then msg="${msg}
kernel:
${oops}"; fi
msg="${msg}
now: kernel $(uname -r), up since $(uptime -s), state $(systemctl is-system-running 2>/dev/null)
details: journalctl -b -1 -k"
logger -t boot-alert "previous boot ended uncleanly: ${reasons[*]}"
send "$msg"
