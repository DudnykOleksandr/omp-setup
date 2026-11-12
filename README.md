# omp-setup

Portable backup of my [omp](https://github.com/badlogic/pi-mono) customizations: context-maintenance settings, a model-switch extension, the Ollama Cloud quota skill, and the HummingRelay provider with its balance display.

Nothing here contains credentials. The Ollama skill reads `OLLAMA_API_KEY` / `OLLAMA_API_KEY_FILE` from the environment; HummingRelay reads `HMBRD_API_KEY`.

## Layout

| Path | Installs to | What it is |
|---|---|---|
| `config/config.yml` | `~/.omp/agent/config.yml` | full agent config: display, compaction/token budgets, model roles, status line (with the `status` segment for extension statuses), STT |
| `models/models.yml` | `~/.omp/agent/models.yml` | custom providers: [HummingRelay](https://hmbrd.dev/docs) (`hummingrelay/model-zero`, `model-one-flash`, `model-one`) |
| `extensions/model-transit.ts` | `~/.omp/agent/extensions/` | recompacts automatically when the active model can no longer read the last compaction payload |
| `extensions/ollama-cloud-usage.ts` | `~/.omp/agent/extensions/` | Ollama Cloud balance/quota provider |
| `extensions/hummingrelay-usage.ts` | `~/.omp/agent/extensions/` | HummingRelay prepaid balance for `/usage`, `omp usage` and the status line |
| `skills/ollama-cloud-usage/SKILL.md` | `~/.omp/agent/skills/ollama-cloud-usage/` | skill: how to query Ollama Cloud quota without leaking the key |
| `docs/compaction-and-model-switching.md` | — | why these settings exist, with measurements |

Not included on purpose: `extensions/herdr-omp-agent-state.ts` (vendor-managed, overwritten on every herdr update).

## Install

```sh
./install.sh            # copies into ~/.omp/agent, backs up an existing config.yml / models.yml
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

## HummingRelay balance

[HummingRelay](https://hmbrd.dev) is OpenAI-compatible (Chat Completions only) and prepaid in USD. Its API has no balance endpoint, so `extensions/hummingrelay-usage.ts` signs into the web console with the same `hr_live_` key (`POST https://hmbrd.dev/api/dashboard/login {"key": …}` → `hr_console` cookie) and reads the balance, the paid/bonus split, 30-day spend and runway from the server-rendered `/dashboard` overview.

Setup after `./install.sh`:

1. Put the key in `~/.omp/agent/.env` (or the shell environment): `HMBRD_API_KEY=hr_live_…`. `models/models.yml` references it by name.
2. Store the same key in omp's credential store; `omp usage` and `/usage` only query providers with stored credentials, not env-only keys:

   ```sh
   K=$(awk -F= '/^HMBRD_API_KEY=/{print $2}' ~/.omp/agent/.env | tr -d '\r')
   jq -n --arg k "$K" '{version:1,credentials:[{provider:"hummingrelay",credential:{type:"api_key",key:$k,source:"login"}}]}' | omp auth import -
   ```

   Repeat after rotating the key.
3. Restart omp.

Where it shows:

- `omp usage --provider hummingrelay` and `/usage`: credit balance (paid + bonus), paid credit (the only credit `model-one` can spend), 30-day spend, runway.
- Status line, while a `hummingrelay/*` model is active: `HR $2.50 (paid $0.00) · ≈ 3 days`. The built-in `usage` segment only renders 5h/1d/7d windows, so the extension publishes this through `ctx.ui.setStatus`, drawn by the `status` segment; `showHookStatus: false` keeps it from repeating in the footer. Refreshed after every agent run and at most once a minute; after a `/model` switch it appears or clears within ~15 s.

If the console layout changes, the status line shows `HR balance unavailable` and omp logs `HummingRelay balance request failed`; the parser is `parseOverview` in the extension.
