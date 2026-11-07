#!/usr/bin/env bash
# ==========================================================================
#  PITUAH.iaf desktop notifications setup for Linux (Debian, Ubuntu and others)
#  Covers Chrome, Chromium, Edge and Firefox (including Debian's firefox-esr).
#
#  Browsers block notifications on sites that aren't HTTPS. This sets the
#  official browser policies that treat this one site as secure and allow
#  its notifications. It changes nothing else.
#
#  Usage:  sudo bash pituah-notifications-setup.sh [address] [--remove] [--dry-run]
#          On Debian without sudo:  su -c "bash pituah-notifications-setup.sh" 
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
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
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
  echo "Browser policies are system settings, so run this as root: sudo bash $0" >&2
  echo "On Debian without sudo: su -c \"bash $0\"" >&2
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

# Firefox reads one policies.json, which IT may already manage, so this script merges
# into it instead of replacing it. Needs python3, which Debian and Ubuntu desktops have.
HOST="${APP_URL#*://}"
HOST="${HOST%%:*}"
FIREFOX_DIRS=("$PREFIX/etc/firefox/policies")
for app in /usr/lib/firefox-esr /usr/lib/firefox /usr/lib64/firefox /opt/firefox; do
  if [ -d "$PREFIX$app" ]; then FIREFOX_DIRS+=("$PREFIX$app/distribution"); fi
done

firefox_update() {
  python3 - "$1" "$MODE" "$APP_URL" "$HOST" <<'PY'
import json, os, sys
path, mode, url, host = sys.argv[1:5]
data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        text = f.read().strip()
    try:
        data = json.loads(text) if text else {}
    except ValueError:
        sys.exit(3)
pol = data.setdefault("policies", {})
allow = pol.setdefault("Permissions", {}).setdefault("Notifications", {}).setdefault("Allow", [])
prefs = pol.setdefault("Preferences", {})
entry = prefs.get("dom.securecontext.allowlist") or {}
hosts = [h for h in str(entry.get("Value", "")).split(",") if h.strip()]
if mode == "install":
    if url not in allow:
        allow.append(url)
    if host not in hosts:
        hosts.append(host)
else:
    allow[:] = [u for u in allow if u.lower() != url.lower()]
    hosts = [h for h in hosts if h.lower() != host.lower()]
if hosts:
    prefs["dom.securecontext.allowlist"] = {"Value": ",".join(hosts), "Status": "locked"}
    prefs["dom.webnotifications.allowinsecure"] = {"Value": True, "Status": "locked"}
else:
    prefs.pop("dom.securecontext.allowlist", None)
    prefs.pop("dom.webnotifications.allowinsecure", None)
# Leave out anything that ended up empty.
perms = pol["Permissions"]
if not allow:
    perms["Notifications"].pop("Allow")
if not perms["Notifications"]:
    perms.pop("Notifications")
for key in ("Permissions", "Preferences"):
    if not pol[key]:
        pol.pop(key)
if not pol:
    data.pop("policies")
if data:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(path + ".tmp", 0o644)
    os.replace(path + ".tmp", path)
    print("  Updated: " + path)
elif os.path.exists(path):
    os.remove(path)
    print("  Removed: " + path)
PY
}

for dir in "${FIREFOX_DIRS[@]}"; do
  policy="$dir/policies.json"
  if [ -n "$DRYRUN" ]; then
    echo "  Would update: $policy"
    continue
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  Skipped Firefox: install python3 and run this again." >&2
    break
  fi
  rc=0
  firefox_update "$policy" || rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "  Skipped $policy: it is not valid JSON. Ask your IT team to add this site to it." >&2
  elif [ "$rc" -ne 0 ]; then
    echo "  Could not update $policy." >&2
  fi
done

echo
echo "Done. Close every browser window and open the app again."
echo "To check: open chrome://policy, edge://policy or about:policies (Firefox) and look for the policies above."
