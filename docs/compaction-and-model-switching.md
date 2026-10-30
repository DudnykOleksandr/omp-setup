# Compaction, token budgets, and model switching

Notes behind the settings in this repo. Measurements come from my own session store
(`~/.omp/agent/sessions`, 422 `.jsonl` files, 82 of them containing compaction entries).

## What a compaction actually stores

A `CompactionEntry` keeps `summary`, `firstKeptEntryId`, `tokensBefore`, and optionally a
native payload under `preserveData`. The payload decides portability:

| `method` | `preserveData` | median `summary` length | readable by |
|---|---|---|---|
| `snapcompact` | `snapcompact` (bitmap frames + bounded source text) | 1 300 chars (lead-in + file list) | any vision model |
| `remote` (OpenAI/Codex) | `openaiRemoteCompaction` | **909 chars — placeholder + `<files>`** | same provider, Responses API only |
| `remote` (Anthropic) | `anthropicCompaction` | 10 736 chars (real summary text) | any model reads the text |
| `handoff` | — | 6 933 chars | any model |
| `soft` | — | 9 018 chars | any model |

Counts in my store: 188 snapcompact, 147 OpenAI remote, 61 handoff, 16 soft, 5 Anthropic remote.

A representative Codex summary in full:

> `Remote compaction preserved provider-native history for this session. Compaction processed 209097 input tokens.` + `<files>…`

That is all a non-Responses model receives after a Codex remote compaction. Hence rule #1:
**never leave a Codex `remote` compaction as the newest entry if the session will roam.**

## Nothing is ever deleted

Compaction appends an entry; it never rewrites the journal. Preparation for a *local*
summary re-expands the original messages instead of trusting an opaque placeholder, so a
`/compact` on the new model after a switch rebuilds a readable summary from the originals.
`/dump`, `/export`, and `history://` always see the full transcript.

## Token budgets

| setting | value here | why |
|---|---|---|
| `compaction.keepRecentTokens` | `40000` | longer verbatim tail survives every compaction (default 20000) |
| `compaction.v2RetainedMessageBudget` | `64000` (ceiling) | only relevant while `remote` is enabled; Codex keeps *user* messages within it, assistant turns are dropped into the opaque item |
| `compaction.thresholdPercent` / `thresholdTokens` | `-1` | reserve-based default; the effective reserve is `max(15% of window, 16384)` |
| `compaction.idleEnabled` | `false` | no surprise compaction while away |

Compaction frequency scales inversely with the context window, which is why losses are most
visible on the provider with the smallest window — but the *kind* of loss is decided by the
method, not the window.

## Model matrix (my rotation)

| model | image input | context window |
|---|---|---|
| `anthropic/claude-opus-5`, `-5-5`, `claude-fable-5` | yes | 1 000 000 |
| `openai-codex/gpt-5.6-sol`, `gpt-6-sol`, `gpt-6-astra` | yes | — |
| `ollama-cloud/glm-5.3` | **no** | 1 048 576 |
| `ollama-cloud/glm-5.3-flash` | yes | 1 048 576 |

`glm-5.3` is text-only, so it can neither create nor read a snapcompact archive: in a
GLM↔Codex rotation the only portable formats are `handoff`/`soft` (plain text) and `shake`
(tool output moved to recoverable `artifact://` references). `glm-5.3-flash` has the same
1M window *and* image input, so it keeps snapcompact usable across the whole rotation.

## Operating rules

1. Switch the model, then `/compact` before the next substantive prompt — one thin turn at most.
2. When a provider's quota is exhausted, do not try `/handoff` on it: switch first, then
   compact on the live provider. `snapcompact` and `shake` need no network at all.
3. Keep `remote` out of `methodOrder` unless the session will stay on one provider.
4. `model-transit.ts` automates rule 1 for the cases where it actually matters.
