# omp-setup

Portable backup of my [omp](https://github.com/badlogic/pi-mono) customizations: context-maintenance settings, a model-switch extension, and the Ollama Cloud quota skill.

Nothing here contains credentials. The Ollama skill reads `OLLAMA_API_KEY` / `OLLAMA_API_KEY_FILE` from the environment.

## Layout

| Path | Installs to | What it is |
|---|---|---|
| `config/config.yml` | `~/.omp/agent/config.yml` | full agent config: display, compaction/token budgets, model roles, status line, STT |
| `extensions/model-transit.ts` | `~/.omp/agent/extensions/` | recompacts automatically when the active model can no longer read the last compaction payload |
| `extensions/ollama-cloud-usage.ts` | `~/.omp/agent/extensions/` | Ollama Cloud balance/quota provider |
| `skills/ollama-cloud-usage/SKILL.md` | `~/.omp/agent/skills/ollama-cloud-usage/` | skill: how to query Ollama Cloud quota without leaking the key |
| `docs/compaction-and-model-switching.md` | — | why these settings exist, with measurements |

Not included on purpose: `extensions/herdr-omp-agent-state.ts` (vendor-managed, overwritten on every herdr update).

## Install

```sh
./install.sh            # copies into ~/.omp/agent, backs up an existing config.yml
```

Extensions in `~/.omp/agent/extensions/*.ts` are auto-discovered; newly added modules need an omp restart. `config.yml` is picked up live by the settings file watcher.

## The three customizations that matter

### 1. `display.collapseCompacted: false`

Default `true` hides every pre-compaction turn behind the `── 📷 compacted · ctrl+o ──` divider. Combined with `hideThinkingBlock: true` and `display.hideToolActivity: true` the transcript looks empty after a compaction. This is rendering only — the session journal always keeps every entry.

### 2. `compaction.methodOrder` without `remote`

```yaml
compaction:
  methodOrder: [snapcompact, handoff, shake, soft]
  keepRecentTokens: 40000
```

`remote` (provider-native compaction) stores the real content in a provider payload that only the writing provider can replay. On OpenAI/Codex the stored text summary is a placeholder, so switching the model away loses it. `snapcompact` is local, needs no network or quota, and survives provider changes; `handoff`/`soft` produce portable plain text.

### 3. `extensions/model-transit.ts`

Polls the active model while the session is idle; when it changes, checks whether the newest compaction entry is readable by the new model and recompacts once in a readable format if it is not.

| last compaction payload | readable by | otherwise |
|---|---|---|
| `openaiRemoteCompaction` | same provider + Responses API | vision → `snapcompact`, else `soft` |
| `snapcompact` | models with image input | `soft` |
| `anthropicCompaction` / plain summary | everything | — |

Disable with `disabledExtensions: [extension-module:model-transit]`.
