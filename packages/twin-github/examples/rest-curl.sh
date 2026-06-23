#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GITHUB_CLONE_URL:-http://127.0.0.1:3333}"

curl -s "$BASE_URL/repos/acme/api" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).full_name))"
curl -s "$BASE_URL/repos/acme/api/issues" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).map(i => i.title).join('\n')))"
curl -s "$BASE_URL/repos/acme/api/contents/README.md" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).path))"
