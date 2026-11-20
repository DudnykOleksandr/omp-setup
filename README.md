# omp-setup

Portable backup of my [omp](https://github.com/can1357/oh-my-pi) customizations: context-maintenance settings, model-switch and non-Anthropic behavior extensions, the Ollama Cloud quota skill, and the HummingRelay provider with its balance display.

Nothing here contains credentials. The Ollama skill reads `OLLAMA_API_KEY` / `OLLAMA_API_KEY_FILE` from the environment; HummingRelay reads `HMBRD_API_KEY`.

## Layout

| Path | Installs to | What it is |
|---|---|---|
| `config/config.yml` | `~/.omp/agent/config.yml` | full agent config: display, compaction/token budgets, model roles, status line, STT |
| `models/models.yml` | `~/.omp/agent/models.yml` | custom providers: [HummingRelay](https://hmbrd.dev/docs) (`hummingrelay/model-zero`, `model-one-flash`, `model-one`) |
| `extensions/model-transit.ts` | `~/.omp/agent/extensions/` | recompacts automatically when the active model can no longer read the last compaction payload |
| `extensions/ollama-cloud-usage.ts` | `~/.omp/agent/extensions/` | Ollama Cloud balance/quota provider |
| `extensions/hummingrelay-usage.ts` | `~/.omp/agent/extensions/` | HummingRelay prepaid balance for `/usage`, `omp usage` and the footer status row |
| `extensions/portable-behavior.ts` | `~/.omp/agent/extensions/` | model-scoped, independently worded behavior cues for non-Anthropic models |
| `skills/ollama-cloud-usage/SKILL.md` | `~/.omp/agent/skills/ollama-cloud-usage/` | skill: how to query Ollama Cloud quota without leaking the key |
| `docs/compaction-and-model-switching.md` | — | why these settings exist, with measurements |

Not included on purpose: `extensions/herdr-omp-agent-state.ts` (vendor-managed, overwritten on every herdr update).

## Install

```sh
./install.sh            # copies into ~/.omp/agent, backs up an existing config.yml / models.yml
```

Extensions in `~/.omp/agent/extensions/*.ts` are auto-discovered; newly added modules need an omp restart. `config.yml` is picked up live by the settings file watcher.

For an existing installation, copy just the new extension if you do **not** want `install.sh` to replace your local `config.yml` and `models.yml` with this repo's snapshots:

```sh
cp extensions/portable-behavior.ts ~/.omp/agent/extensions/
```

## The four customizations that matter

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

### 4. `extensions/portable-behavior.ts`

Automatically adds a short behavioral supplement on the next user prompt for a non-Anthropic model (GPT, Gemini, local Ollama, etc.). It excludes the `anthropic` provider and Claude/Fable/Mythos models routed through other providers such as OpenRouter. Switching models with `/model` changes the selection on the next prompt; no skill invocation or special keyword is required. The extension leaves OMP's normal system prompt and project rules intact, and never changes a model's identity, tool list, knowledge cutoff, or safety rules.

The cues are newly written, not copies of the [published claude.ai prompt](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-fable-5-2); those prompts do not apply to Claude API or OMP. They cover honest uncertainty, checking sources and actions, concise and respectful responses, contextual clarification, balanced arguments, untrusted-source handling, and cautious support for distress.

To use: install or copy the extension, restart omp, then select a non-Anthropic model (`/model` or `omp --model openai-codex/gpt-6-sol`). To turn it off globally, add `disabledExtensions: [extension-module:portable-behavior]` to `~/.omp/agent/config.yml` and restart; alternatively start one session with `omp --no-extensions` (which disables *all* auto-discovered extensions). The default install path follows the active OMP profile; named profiles have separate agent directories. Prompt additions are instructions, not an enforcement mechanism, and behavior may vary by model.

To change it **during a running OMP session**, select the model and use the command:

```text
/model openai-codex/gpt-6-sol
/portable-behavior off
/portable-behavior status
/portable-behavior on
```

The command targets the currently active `provider/model-id` only. It takes effect on that model's next user prompt; switching away and back retains the choice for this session. Other non-Anthropic models remain on by default. The command cannot enable the supplement for Anthropic or Claude served through another provider. Run `/portable-behavior` with no argument for status. Session overrides reset in a new OMP session; editing an extension's code still requires restarting OMP.

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
- Footer status row under the editor, while a `hummingrelay/*` model is active: `⏱ $2.60 · paid $0.11 · ≈3d`, styled like the `usage` segment. The credit the active model spends is colored: paid credit on `model-one` (bonus cannot pay for it), the total balance on the others; muted while ≥ $1, warning below $1, error at $0 or less. Refreshed after every agent run and at most once a minute; after a `/model` switch it appears, clears or re-colors within ~15 s.
- Why the footer row and not the status line: the built-in `usage` segment only renders percent windows (5h/1d/7d), and the `status` segment strips ANSI from extension statuses and paints them all in the accent color. The footer row (`statusLine.showHookStatus`, default `true`) keeps the colors.

If the console layout changes, the footer shows `⏱ HR balance unavailable` in the error color and omp logs `HummingRelay balance request failed`; the parser is `parseOverview` in the extension.
