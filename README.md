# omp-setup

Portable backup of my [omp](https://github.com/can1357/oh-my-pi) customizations: context-maintenance settings, model-switch and non-Anthropic behavior extensions, the Ollama Cloud quota skill, the HummingRelay provider with its balance display, and voice dictation through the ChatGPT/Codex subscription.

Nothing here contains credentials. The Ollama skill reads `OLLAMA_API_KEY` / `OLLAMA_API_KEY_FILE` from the environment; HummingRelay reads `HMBRD_API_KEY`; Codex dictation uses omp's own `openai-codex` login.

## Layout

| Path | Installs to | What it is |
|---|---|---|
| `config/config.yml` | `~/.omp/agent/config.yml` | full agent config: display, compaction/token budgets, model roles, status line, STT |
| `models/models.yml` | `~/.omp/agent/models.yml` | custom providers: [HummingRelay](https://hmbrd.dev/docs) (`hummingrelay/model-zero`, `model-one-flash`, `model-one`) |
| `extensions/model-transit.ts` | `~/.omp/agent/extensions/` | recompacts automatically when the active model can no longer read the last compaction payload |
| `extensions/ollama-cloud-usage.ts` | `~/.omp/agent/extensions/` | Ollama Cloud balance/quota provider |
| `extensions/hummingrelay-usage.ts` | `~/.omp/agent/extensions/` | HummingRelay prepaid balance for `/usage`, `omp usage` and the footer status row |
| `extensions/portable-behavior.ts` | `~/.omp/agent/extensions/` | model-scoped, independently worded behavior cues for non-Anthropic models |
| `extensions/codex-voice.ts` | `~/.omp/agent/extensions/` | speech-to-text through the ChatGPT/Codex subscription (provider `codex-voice/transcribe`) |
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

When enabled, adds a short behavioral supplement on the next user prompt for a non-Anthropic model (GPT, Gemini, local Ollama, etc.). It is **off by default for every model**. It excludes the `anthropic` provider and Claude/Fable/Mythos models routed through other providers such as OpenRouter. Switching models with `/model` selects that model's own profile and on/off state. The extension leaves OMP's normal system prompt and project rules intact, and never changes a model's identity, tool list, knowledge cutoff, or safety rules.

The cues are independently written, not copies of the published [Opus 5](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-opus-5) or [Fable 5](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-fable-5) claude.ai prompts; those prompts do not apply to Claude API or OMP. All profiles share cues for honest uncertainty, checking sources and actions, respectful responses, contextual clarification, balanced arguments, untrusted-source handling, and cautious support for distress.

To use: install or copy the extension, restart omp, select a non-Anthropic model (`/model` or `omp --model openai-codex/gpt-6-sol`), then choose a profile in the picker or run `/portable-behavior on`. To disable the extension globally, add `disabledExtensions: [extension-module:portable-behavior]` to `~/.omp/agent/config.yml` and restart; alternatively start one session with `omp --no-extensions` (which disables *all* auto-discovered extensions). The default install path follows the active OMP profile; named profiles have separate agent directories. Prompt additions are instructions, not an enforcement mechanism, and behavior may vary by model.

To choose during a running **interactive** OMP session, select a non-Anthropic model, then open the picker:

```text
/model openai-codex/gpt-6-sol
/portable-behavior
```

Typing exactly `portable-behavior` **without** `/` in the interactive composer also opens the same picker instead of sending those words to the model. The menu shows the current model and selection. Pick `default`, `opus-5`, or `fable-5` to enable that profile, or pick `off` to disable it; when disabled, the menu offers `on` to restore the previously selected profile. Dismiss the menu to leave the state unchanged. The bare-word shortcut does not intercept messages with images or run in print/RPC mode.

The TUI status bar is blank for this extension initially. It shows `behavior: default`, `behavior: opus-5`, or `behavior: fable-5` only after enabling a profile for the active model; it disappears on `off` or when an Anthropic model is active.

`default` is the original generic supplement. `opus-5` favors plain, short sentences and useful lists; `fable-5` favors warm prose and minimal formatting unless clarity or local rules require structure. These are **presentation profiles inspired by the published chat prompts**, not the models themselves: they cannot add model capabilities or copy Anthropic's safeguards, identity, product features, or training cutoff.

The picker and explicit commands target the active `provider/model-id` only. Selecting a profile (including with `/portable-behavior profile …`) enables it for that model on its next user prompt. Switching away and back retains its choice for this session; other non-Anthropic models stay off until enabled separately. The modifier cannot be enabled for Anthropic or Claude served through another provider. Explicit commands remain available: `/portable-behavior status`, `/portable-behavior profile opus-5`, `/portable-behavior profile fable-5`, `/portable-behavior profile default`, `/portable-behavior off`, and `/portable-behavior on`. Session overrides reset in a new OMP session; updating the extension's code requires restarting OMP once.

## Codex dictation

omp's cloud speech-to-text only speaks OpenAI's `POST {baseUrl}/audio/transcriptions`. `extensions/codex-voice.ts` runs a loopback shim on `127.0.0.1` (random port, per-process bearer secret) and registers it as provider `codex-voice` with model `transcribe`. The shim forwards each recording to `https://chatgpt.com/backend-api/transcribe`, the private route Codex Desktop dictation uses, with the access token of omp's `openai-codex` login (`/login openai-codex`). omp owns token refresh; `~/.codex/auth.json` is never read or written.

Setup after installing the extension, already in `config/config.yml`:

```yaml
modelRoles:
  dictation: codex-voice/transcribe
retry:
  fallbackChains:
    dictation:
      - local/whisper-large-v3-turbo   # used when the Codex route fails
stt:
  enabled: true
  language: uk
```

Restart omp, then dictate as usual (hold `Space`).

Things to know:

- The route is undocumented and may change without notice; the fallback chain then switches to local Whisper.
- The backend chooses the decoder from the file extension: an upload named without one answers `500 Error in ASR API`, so the shim adds an extension from the MIME type when it is missing (omp's dictation already sends `dictation.wav`; the runner's fallback name is `audio`). It validates `language` as an ISO-639-1 code but does not act on it; the language is auto-detected.
- OpenAI keeps every uploaded recording for 30 days (`asset_ttl: "30d"` in the response).
- Measured: an 11.8 s Ukrainian clip transcribed in about 1 s, with correct punctuation and `middleware` kept in Latin script.

`stt.cloudLive: true` sends each phrase when you pause, so text appears while you are still speaking. It needs an omp build with [can1357/oh-my-pi#20359](https://github.com/can1357/oh-my-pi/pull/20359); older omp ignores the key and sends the whole recording at the end. Phrases are transcribed without each other's context, so a short phrase can occasionally be detected as a neighbouring language (seen once: Belarusian for Ukrainian).

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
