---
name: ollama-cloud-usage
description: Check Ollama Cloud subscription quota, remaining balance, and session/weekly/monthly reset times using an API key. Use for Ollama limits, quota reset, ліміти, квота, коли резет, or залишок підписки; not local model performance.
---

# Ollama Cloud quota and reset times

Read-only account check; no inference requests, purchases, plan changes, or credential changes.

## Credentials

Use `OLLAMA_API_KEY` in memory. Otherwise read the file named by `OLLAMA_API_KEY_FILE`.
On this owner's workstation, the existing key file is `D:/Repos/Drones/sym/.cache/llm/ollama_key.txt`; this absolute path works from other repositories. It is a local credential-location fact, not a portable default for other users/machines.

Never display the key, read it through a tool that echoes file contents, put it in command-line arguments, copy it into the skill, or commit it. Missing credentials: report the missing environment variable/file; do not search unrelated secrets or ask for a key pasted into chat.

## Check

Call `GET https://ollama.com/api/balance` with `Authorization: Bearer <key>`.
Use a Python execution tool or run the following code without shell tracing. It prints only the balance response and relevant error metadata, never request headers. No third-party packages required for the request.

```python
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


def check_ollama_balance():
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    if not key:
        path = Path(os.environ.get(
            "OLLAMA_API_KEY_FILE",
            "D:/Repos/Drones/sym/.cache/llm/ollama_key.txt",
        )).expanduser()
        if not path.is_file():
            raise SystemExit("Missing OLLAMA_API_KEY or readable key file")
        key = path.read_text(encoding="utf-8-sig").strip()
    if not key:
        raise SystemExit("Ollama credential is empty")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None  # Never forward credentials to a redirected host.

    request = urllib.request.Request(
        "https://ollama.com/api/balance",
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            balance = json.load(response)
            print(json.dumps({
                "checked_at_http_date": response.headers.get("Date"),
                "balance": balance,
            }, ensure_ascii=False).replace(key, "[REDACTED]"))
    except urllib.error.HTTPError as error:
        raise SystemExit(
            f"Ollama HTTP {error.code}; Retry-After={error.headers.get('Retry-After', 'absent')}"
        ) from None
    except urllib.error.URLError:
        raise SystemExit("Ollama connection failed; no balance obtained") from None


check_ollama_balance()
```

## Interpret the actual response

- Legacy subscription: `included.session` and `included.weekly` each contain `remaining_percent` and `resets_at`. The percentage is **remaining**, not used. `resets_at` is the next reset timestamp in UTC.
- Credit-based subscription: `included.balance_usd`, `included.allowance_usd`, and `included.period.until`. The period end is the next monthly reset, including on annual subscriptions. Do not invent session/weekly limits if these fields are absent.
- `purchased.balance_usd` is the separate balance of unexpired purchased credits; it is not the subscription allowance or a new bill.
- Convert timestamps using `zoneinfo.ZoneInfo("Europe/Kyiv")` for this owner unless another timezone is requested. Use timezone rules, not a hardcoded UTC offset. If timezone data is unavailable, report explicitly labeled UTC; never guess local time. Python may need `tzdata` on Windows.
- Report a short table: limit, remaining quota, next reset (date and time), with timezone and observation time. Compute time remaining only from a current clock, not an old chat timestamp.
- Read live values every time. Never store transient percentages/reset dates as account facts. Do not infer the exact subscription tier from this response: it does not identify it.

Only if usage history is requested, call `GET https://ollama.com/api/usage?range=24h` (also supports `7d`, `30d`; optional `group_by=model`). Legacy plans may expose request counts only. Usage can lag and does not determine reset time; `/api/balance` does.

## Failures and verification

No blind retry loop. `401`: credential rejected; `403`: account access denied; `429`: respect `Retry-After` (not the subscription reset); `503`: reporting unavailable. Redirects and unexpected schemas are not usable balance evidence. Both account endpoints allow 10 requests/minute per user; do not poll faster than once/minute.

Before claiming success, obtain HTTP 200 and the actual balance fields. An error must not become an estimated reset time. For skill maintenance, execute the code above from a directory outside the source repo and confirm no inference call or credential output occurred. This skill produces a live chat answer, not a persisted report/template.

## Authorities

- [Balance API, both subscription formats and reset semantics](https://docs.ollama.com/api/balance.md)
- [Usage API and rate limits](https://docs.ollama.com/api/cloud-usage.md)
- [Account usage page](https://ollama.com/settings/usage)

Method first verified against the owner's account on 2026-10-28. This skill is installed at user scope, outside project repositories; it does not sync to other machines automatically.
