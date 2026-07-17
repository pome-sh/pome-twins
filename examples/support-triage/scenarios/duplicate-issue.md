# Duplicate issue is avoided on re-report

## Prompt

A customer bug report came in on the #support Slack channel. Triage it: reproduce the problem, file a GitHub issue in acme/orders-service with repro steps and the "bug" label, and post the issue link back to the #support thread.

## Setup

`#support` has a new bug report from the support rep `evan`: POST /orders returns
a 500 when the coupon field is empty. The bug is real — but it is ALREADY tracked
by open issue #1 in `acme/orders-service` (same bug, filed earlier). A good triage
agent searches existing issues first, recognizes the duplicate, comments on issue
#1 and links it back, and does NOT open a second issue for a bug that is already
tracked.

## Expected Behavior

The agent reads evan's report, searches the open issues in `acme/orders-service`,
finds that issue #1 already tracks this exact bug, adds a comment referencing the
new report, and posts issue #1's link back to #support. It does NOT open a second
issue. Opening a duplicate issue is a failure, not a partial pass.

## Success Criteria

- [code:slack] A message in "support" contains "issues/1"
- [model] The agent recognized that this bug is already tracked by the existing issue #1 in acme/orders-service and did not open a duplicate issue; instead it commented on / linked issue #1 and posted that issue's link back to #support. Opening a second issue for the same bug does not satisfy this criterion.
- [model] The report the agent added (the issue comment) contains concrete repro steps drawn from the customer's message rather than a vague restatement.

## Seed State

```json
{
  "github": {
    "_meta": { "version": 1, "source_hash": "sha256:hand-authored", "model": "hand-authored", "compiled_at": "2026-07-17T00:00:00.000Z" },
    "users": [
      { "login": "alice", "type": "User", "name": "Alice Chen" },
      { "login": "bob", "type": "User", "name": "Bob Ortiz" },
      { "login": "pome-agent", "type": "User", "name": "Acme Bot" }
    ],
    "repositories": [
      {
        "owner": "acme",
        "name": "orders-service",
        "description": "Order intake and fulfillment service",
        "default_branch": "main",
        "labels": [ { "name": "bug", "color": "d73a4a", "description": "Something isn't working" } ],
        "collaborators": ["alice", "bob", "pome-agent"],
        "files": [
          { "path": "src/orders.py", "branch": "main", "content": "\"\"\"Order intake and coupon handling.\"\"\"\n\nCOUPONS = {\"SAVE10\": 0.10, \"SAVE20\": 0.20}\n\n\ndef apply_coupon(subtotal, coupon):\n    # BUG: an empty coupon string is not treated as \"no coupon\"; it falls through\n    # to the lookup, which raises KeyError and surfaces as a 500 from POST /orders.\n    rate = COUPONS[coupon]\n    return round(subtotal * (1 - rate), 2)\n\n\ndef place_order(items, coupon):\n    subtotal = sum(i[\"price\"] for i in items)\n    total = apply_coupon(subtotal, coupon)\n    return {\"status\": \"placed\", \"total\": total}\n" }
        ],
        "issues": [
          {
            "number": 1,
            "title": "POST /orders returns 500 when the coupon field is empty",
            "body": "Filed from an earlier report. POST /orders with an empty coupon (\"\") returns a 500 instead of placing the order with no discount. Repro: POST /orders with {\"total\": 40, \"coupon\": \"\"} -> 500. Expected: an empty coupon should mean \"no coupon\".",
            "state": "open",
            "labels": ["bug"],
            "assignees": []
          }
        ],
        "pull_requests": []
      }
    ]
  },
  "slack": {
    "team": { "id": "T_ACME", "name": "Acme", "domain": "acme" },
    "users": [
      { "id": "U_AGENT", "name": "pome-agent", "real_name": "Acme Bot" },
      { "id": "U_EVAN", "name": "evan", "real_name": "Evan Diaz" }
    ],
    "channels": [
      {
        "id": "C_SUPPORT",
        "name": "support",
        "members": ["U_AGENT", "U_EVAN"],
        "messages": [
          {
            "ts": "evan-report",
            "user": "evan",
            "text": "New from a customer: POST /orders returns a 500 whenever the `coupon` field is an empty string (\"\"). An empty coupon should just mean no discount. Repro: POST /orders with {\"total\": 40, \"coupon\": \"\"} -> 500 every time. Can we get this tracked?"
          }
        ]
      }
    ]
  }
}
```

## Config

```yaml
twins: [github, slack]
runs: 5
timeout: 240
passThreshold: 100
```
