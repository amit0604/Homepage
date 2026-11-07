#!/usr/bin/env bash
# ==========================================================================
#  PITUAH.iaf desktop notifications setup for Chrome, Chromium and Edge on Linux
#
#  Browsers block notifications on sites that aren't HTTPS. This sets the
#  official browser policies that treat this one site as secure and allow
#  its notifications. It changes nothing else.
#
#  Usage:  sudo bash pituah-notifications-setup.sh [address] [--remove] [--dry-run]
#    address     The app's address, for example http://10.0.0.5:8080
#    --remove    Undo the setup for that address
#    --dry-run   Show what would change, without changing anything
# ==========================================================================
set -euo pipefail

APP_URL="__APP_URL__"
MODE="install"
DRYRUN=""
for arg in "$@"; do
  case "$arg" in
    --remove) MODE="remove" ;;
    --dry-run) DRYRUN=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) APP_URL="$arg" ;;
  esac
done

if [ "$APP_URL" = "__APP_URL__" ] || [ -z "$APP_URL" ]; then
  read -r -p "Enter the app's address, for example http://10.0.0.5:8080 : " APP_URL
fi
APP_URL="${APP_URL%/}"

# Only a plain web address is accepted.
if ! printf '%s' "$APP_URL" | grep -Eiq '^https?://[a-z0-9.-]+(:[0-9]+)?$'; then
  echo "The address \"$APP_URL\" is not valid. Use the form http://server:8080, without a path." >&2
  exit 2
fi
case "$APP_URL" in
  https://*|HTTPS://*) echo "$APP_URL already uses HTTPS, so no setup is needed. Just allow notifications when the browser asks."; exit 0 ;;
esac

if [ -z "$DRYRUN" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Browser policies are system settings, so run this with sudo." >&2
  exit 1
fi

# Where each browser reads its policies. PITUAH_POLICY_PREFIX is for testing only.
PREFIX="${PITUAH_POLICY_PREFIX:-}"
DIRS=(
  "$PREFIX/etc/opt/chrome/policies/managed"
  "$PREFIX/etc/chromium/policies/managed"
  "$PREFIX/etc/chromium-browser/policies/managed"
  "$PREFIX/etc/opt/edge/policies/managed"
)
LIST_NAME="pituah-notifications.urls"
POLICY_NAME="pituah-notifications.json"

json_list() {
  local first=1
  printf '['
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ $first -eq 0 ]; then printf ', '; fi
    printf '"%s"' "$line"
    first=0
  done < "$1"
  printf ']'
}

echo
if [ "$MODE" = "install" ]; then echo "Setting up desktop notifications for $APP_URL"; else echo "Removing the setup for $APP_URL"; fi
[ -n "$DRYRUN" ] && echo "Dry run: nothing will be changed."
echo

for dir in "${DIRS[@]}"; do
  list="$dir/$LIST_NAME"
  policy="$dir/$POLICY_NAME"
  if [ -n "$DRYRUN" ]; then
    echo "  Would update: $policy"
    continue
  fi
  mkdir -p "$dir"
  touch "$list"
  if [ "$MODE" = "install" ]; then
    grep -Fxqi "$APP_URL" "$list" || printf '%s\n' "$APP_URL" >> "$list"
  else
    grep -Fxvi "$APP_URL" "$list" > "$list.tmp" || true
    mv "$list.tmp" "$list"
  fi
  if [ -s "$list" ]; then
    urls="$(json_list "$list")"
    printf '{\n  "OverrideSecurityRestrictionsOnInsecureOrigin": %s,\n  "NotificationsAllowedForUrls": %s\n}\n' "$urls" "$urls" > "$policy"
    chmod 644 "$policy" "$list"
    echo "  Updated: $policy"
  else
    rm -f "$policy" "$list"
    echo "  Removed: $policy"
  fi
done

echo
echo "Done. Close every browser window and open the app again."
echo "To check: open chrome://policy or edge://policy and look for the two policies above."
echo "Firefox is not covered by this script."
