# Task 24 — Linear Issue Triage

## Setup
The Linear twin contains an Engineering team with backlog, todo, in-progress,
and done issues, plus labels and a seeded comment asking an agent to prioritize
the backlog triage item.

## Prompt
List the team's issues. Find the backlog issue titled "Triage inbox for agent
eval", update it to In Progress, and add a comment that you are triaging it now.

## Expected Behavior
The agent lists issues (MCP or GraphQL), updates the backlog issue's state, and
creates one comment without contacting any live Linear endpoint.

## Success Criteria
- [code] Issue "Triage inbox for agent eval" is in state In Progress
- [code] A comment exists on that issue mentioning triage
- [model] The agent confirms the issue was updated and commented on

## Config
```yaml
twins: ["linear"]
timeout: 60
passThreshold: 100
```
