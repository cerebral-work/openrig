#!/usr/bin/env bash
# OpenRig hook for Google Antigravity CLI (agy), registered on the PreInvocation
# event in ~/.gemini/config/hooks.json. The hooks file is global, so this is a
# no-op unless the agy process runs inside an OpenRig seat (OPENRIG_SESSION_NAME).
#
# Records the conversation id so OpenRig can capture a resume token after the
# first turn (agy creates no conversation until then):
#   $OPENRIG_HOME/state/agy/<session>.json  ->  {"conversationId":"<uuid>","updatedAt":"..."}
#
# ASSUMPTION (unconfirmed for PreInvocation): the JSON payload on stdin carries a
# top-level `conversationId`, as the existing moshi PreToolUse hook reads.
# agy expects JSON on stdout, so this always prints {} and exits 0.

emit() { printf '{}\n'; exit 0; }

[ -n "${OPENRIG_SESSION_NAME:-}" ] || emit
case "$OPENRIG_SESSION_NAME" in */*|*..*) emit ;; esac

payload="$(cat)"
if command -v jq >/dev/null 2>&1; then
  id="$(printf '%s' "$payload" | jq -r '.conversationId // empty' 2>/dev/null)"
else
  id="$(printf '%s' "$payload" | sed -n 's/.*"conversationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
# Only a UUID is ever written (also keeps the file free of injected content).
printf '%s' "$id" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || emit

dir="${OPENRIG_HOME:-$HOME/.openrig}/state/agy"
mkdir -p "$dir" || emit
tmp="$(mktemp "$dir/.${OPENRIG_SESSION_NAME}.XXXXXX")" || emit
printf '{"conversationId":"%s","updatedAt":"%s"}\n' "$id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" \
  && mv -f "$tmp" "$dir/${OPENRIG_SESSION_NAME}.json" || rm -f "$tmp"
emit
