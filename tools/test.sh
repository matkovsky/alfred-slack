#!/bin/bash
# Smoke tests for the search ranking, run against fixture caches.
# Workspaces come from tests/fixtures/root-state.json (kuix, Creative Factory, Acme).
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/cache" "$TMP/data"
now=$(($(date +%s) * 1000))
for f in tests/fixtures/cache/*.json; do sed "s/__NOW__/$now/" "$f" > "$TMP/cache/$(basename "$f")"; done
cp tests/fixtures/data/aliases.json "$TMP/data/"

fail=0
# titles <query> [workspaces-config] → "title | workspace" lines
titles() {
  slack_state=tests/fixtures/root-state.json alfred_workflow_cache="$TMP/cache" alfred_workflow_data="$TMP/data" workspaces="${2:-}" \
    /usr/bin/osascript -l JavaScript src/slack.js filter "$1" |
    /usr/bin/osascript -l JavaScript -e 'function run(a){return JSON.parse(a[0]).items.map(i=>i.title+" | "+i.subtitle.split(" · ")[0]).join("\n")}' "$(cat)"
}
expect() { # expect <name> <expected first lines> <actual>
  local n; n=$(printf '%s\n' "$2" | wc -l)
  if [ "$(printf '%s\n' "$3" | head -n "$n")" == "$2" ]; then echo "ok   $1"
  else echo "FAIL $1"; echo "  expected:"; printf '    %s\n' "$2"; echo "  got:"; printf '%s\n' "$3" | head -n "$n" | sed 's/^/    /'; fail=1; fi
}

expect "same name ranks by workspace order" "# design | kuix
# design | Creative Factory
# design | Acme
# design-review | kuix" "$(titles design)"

expect "configured order wins" "# design | Acme
# design | kuix
# design | Creative Factory" "$(titles design $'acme=a\nkuix=k\ncreative-factory=cf')"

expect "workspace prefix narrows" "# design | Creative Factory
# design-review | Creative Factory" "$(titles 'cf: design')"

expect "accent-insensitive, DM before group DM" "@ Bálint Kiss | kuix
👥 Team Leads 👔 | kuix" "$(titles balint)"

expect "alias with emoji" "👥 Team Leads 👔 | kuix" "$(titles leads)"

expect "no match → ⌘K fallback per workspace" "Search kuix for “zzqx” | ⌘K in Slack (kuix)
Search Creative Factory for “zzqx” | ⌘K in Slack (Creative Factory)
Search Acme for “zzqx” | ⌘K in Slack (Acme)" "$(titles zzqx)"

# emojify <text> [map] → rendered text (map "" = no map, only the macOS Unicode-name fallback)
emojify() { emoji_map="${2-${EMOJI_MAP:-build/emoji.json}}" /usr/bin/osascript -l JavaScript src/slack.js emojify "$1"; }

expect "emoji from generated map, skin tones, flags" "👔 🎉 👍 👋🏼 🇭🇺 ✅" \
  "$(emojify ':necktie: :tada: :+1: :wave::skin-tone-3: :flag-hu: :white_check_mark:')"
expect "unknown/custom codes and times stay as text" ":kuix-logo: 10:30:00" "$(emojify ':kuix-logo: 10:30:00')"
expect "Unicode-name fallback without the map" "👔 🦄 :tada: :smile:" "$(emojify ':necktie: :unicorn_face: :tada: :smile:' /nonexistent)"

exit $fail
