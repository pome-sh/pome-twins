#!/usr/bin/env bash
set -euo pipefail

# Quick end-to-end REST exercise against a running twin. Set TWIN_AUTH_SECRET
# to the same secret the server uses, and SID to a session id whose JWT we
# mint below.

BASE_URL="${SLACK_CLONE_URL:-http://127.0.0.1:3333}"
SID="${SID:-demo}"
SECRET="${TWIN_AUTH_SECRET:-dev-only-insecure-secret}"

TOKEN=$(node -e "import('hono/jwt').then(m => m.sign({ sid: process.env.SID, team_id: 'tm_demo', login: 'pome-agent', exp: Math.floor(Date.now()/1000)+3600 }, process.env.SECRET).then(t => console.log(t)))" \
  SID="$SID" SECRET="$SECRET")

H=(-H "Authorization: Bearer $TOKEN")

echo "auth.test:"
curl -s "${H[@]}" "$BASE_URL/s/$SID/auth.test" | node -e "process.stdin.on('data', d => { const o = JSON.parse(d); console.log(`  team=${o.team_id} user=${o.user_id}`); })"

echo "conversations.list:"
curl -s "${H[@]}" "$BASE_URL/s/$SID/conversations.list" | node -e "process.stdin.on('data', d => { const o = JSON.parse(d); console.log('  ' + o.channels.map(c => '#' + c.name + ' (' + c.id + ')').join(', ')); })"

echo "chat.postMessage (form body):"
curl -s "${H[@]}" -H 'content-type: application/x-www-form-urlencoded' -d "channel=C_GENERAL&text=hello+from+curl" "$BASE_URL/s/$SID/chat.postMessage" | node -e "process.stdin.on('data', d => { const o = JSON.parse(d); console.log(`  channel=${o.channel} ts=${o.ts}`); })"

echo "conversations.history (top 5):"
curl -s "${H[@]}" "$BASE_URL/s/$SID/conversations.history?channel=C_GENERAL&limit=5" | node -e "process.stdin.on('data', d => { const o = JSON.parse(d); o.messages.forEach(m => console.log(`  ${m.ts} ${m.user}: ${m.text}`)); })"
