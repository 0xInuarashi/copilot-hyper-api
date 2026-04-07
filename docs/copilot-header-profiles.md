# Copilot API: VS Code vs CLI Header Profiles

**Date:** 2026-04-07

Headers captured via MITM proxy against the real Copilot API.

## VS Code (`vscode-chat`)

```http
Authorization: Bearer <session-token>
Content-Type: application/json
Accept: application/json
Editor-Version: vscode/1.95.0
Editor-Plugin-Version: copilot/1.0.0
Copilot-Integration-Id: vscode-chat
OpenAI-Intent: conversation-panel
User-Agent: GithubCopilot/1.0
```

## Copilot CLI (`copilot-developer-cli`)

```http
Authorization: Bearer <session-token>
Content-Type: application/json
Accept: application/json
Openai-Intent: conversation-agent
X-GitHub-Api-Version: 2026-01-09
Copilot-Integration-Id: copilot-developer-cli
User-Agent: copilot/1.0.20 (client/github/cli linux v24.11.1) term/unknown
X-Initiator: user | agent
X-Interaction-Id: <uuid>
X-Interaction-Type: conversation-user | conversation-agent
X-Agent-Task-Id: <uuid>
X-Client-Session-Id: <uuid, stable per process>
X-Client-Machine-Id: <uuid, stable per process>
```

## Key Differences

| Header | VS Code | CLI |
|---|---|---|
| `Editor-Version` | `vscode/1.95.0` | _(absent)_ |
| `Editor-Plugin-Version` | `copilot/1.0.0` | _(absent)_ |
| `User-Agent` | `GithubCopilot/1.0` | `copilot/1.0.20 (client/github/cli ...) term/unknown` |
| `Copilot-Integration-Id` | `vscode-chat` | `copilot-developer-cli` |
| `OpenAI-Intent` | `conversation-panel` | `conversation-agent` |
| `X-GitHub-Api-Version` | _(absent)_ | `2026-01-09` |
| `X-Initiator` | _(absent)_ | `user` or `agent` |
| `X-Interaction-Id` | _(absent)_ | stable UUID per conversation |
| `X-Interaction-Type` | _(absent)_ | `conversation-user` or `conversation-agent` |
| `X-Agent-Task-Id` | _(absent)_ | stable UUID per conversation |
| `X-Client-Session-Id` | _(absent)_ | stable UUID per process |
| `X-Client-Machine-Id` | _(absent)_ | stable UUID per process |

## Billing Implications

- `X-Initiator: user` triggers a premium credit charge (1 per interaction)
- `X-Initiator: agent` is a free continuation within the same interaction
- The CLI tracks interactions via stable `X-Interaction-Id` / `X-Agent-Task-Id` UUIDs

## This Proxy's Approach

Uses **VS Code base headers** (broader model access) combined with the **CLI session headers**
(`X-Initiator`, `X-Interaction-Id`, `X-Interaction-Type`, `X-Agent-Task-Id`,
`X-Client-Session-Id`, `X-Client-Machine-Id`) to get the best of both:
wider model availability + proper billing behavior.
