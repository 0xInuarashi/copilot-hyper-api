# Copilot API: Model Availability by Header Profile

**Date:** 2026-04-07

The Copilot API returns different model lists depending on the client headers sent.
Two profiles were tested against the same GitHub OAuth token and session.

## VS Code Headers

```
Editor-Version: vscode/1.95.0
Editor-Plugin-Version: copilot/1.0.0
Copilot-Integration-Id: vscode-chat
OpenAI-Intent: conversation-panel
User-Agent: GithubCopilot/1.0
```

**46 models** returned.

## Copilot CLI Headers

```
Openai-Intent: conversation-agent
X-GitHub-Api-Version: 2026-01-09
Copilot-Integration-Id: copilot-developer-cli
User-Agent: copilot/1.0.20 (client/github/cli linux v24.11.1) term/unknown
```

**28 models** returned.

## Diff

### Only in VS Code (20)

| Model | Notes |
|---|---|
| `gpt-4o` | Used as judge model in auto-route |
| `gpt-4o-2024-05-13` | |
| `gpt-4o-2024-08-06` | |
| `gpt-4o-2024-11-20` | |
| `oswe-vscode-prime` | Free-tier model for auto-route |
| `oswe-vscode-secondary` | |
| `gpt-4` | |
| `gpt-4` | (duplicate in API response) |
| `gpt-4-0125-preview` | |
| `gpt-4-0613` | |
| `gpt-4-o-preview` | |
| `gpt-4-o-preview` | (duplicate in API response) |
| `minimax-m2.5` | |
| `gemini-3-flash-preview` | |
| `gemini-3.1-pro-preview` | |
| `accounts/msft/routers/f185i3v4` | Internal router |
| `accounts/msft/routers/fmfeto88` | Internal router |
| `accounts/msft/routers/gdjv4v2v` | Internal router |
| `accounts/msft/routers/mp3yn0h7` | Internal router |
| `accounts/msft/routers/yaqq2gxh` | Internal router |

### Only in CLI (2)

| Model | Notes |
|---|---|
| `gpt-41-copilot` | |
| `gpt-5.4-nano` | |

### Shared (26)

```
claude-haiku-4.5       claude-opus-4.5        claude-opus-4.6
claude-opus-4.6-fast   claude-sonnet-4        claude-sonnet-4.5
claude-sonnet-4.6      gemini-2.5-pro         goldeneye-free-auto
gpt-3.5-turbo          gpt-3.5-turbo-0613     gpt-4.1
gpt-4.1-2025-04-14     gpt-4o-mini            gpt-4o-mini-2024-07-18
gpt-5-mini             gpt-5.1                gpt-5.2
gpt-5.2-codex          gpt-5.3-codex          gpt-5.4
gpt-5.4-mini           grok-code-fast-1       text-embedding-3-small
text-embedding-3-small-inference               text-embedding-ada-002
```

## Conclusion

This proxy uses **VS Code headers** because the VS Code profile is a strict superset
of the CLI profile (minus 2 CLI-exclusive models). Critically, `gpt-4o` (judge model)
and `oswe-vscode-prime` (free-tier routing target) are only available under VS Code headers.
