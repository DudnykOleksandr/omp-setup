// HummingRelay (https://hmbrd.dev) prepaid credit balance for `/usage`, `omp usage`, and the status line.
// HummingRelay has no balance endpoint on api.hmbrd.dev; its console accepts the same hr_live_ key:
//   POST https://hmbrd.dev/api/dashboard/login {"key": "..."} -> `hr_console` session cookie (7 days)
//   GET  https://hmbrd.dev/dashboard -> server-rendered overview with balance, paid/bonus split, 30-day spend.
// The status-line `usage` segment only renders 5h/1d/7d windows (and monthly for an allowlist), so the
// balance is also published through `ctx.ui.setStatus` while a hummingrelay model is active
// (shown by the `status` segment, or the footer hook-status row).

import type { UsageLimit, UsageProvider } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROVIDER = "hummingrelay";
const ORIGIN = "https://hmbrd.dev";
const LOGIN_URL = `${ORIGIN}/api/dashboard/login`;
const OVERVIEW_URL = `${ORIGIN}/dashboard`;
const KEY_ENV = "HMBRD_API_KEY";
const STATUS_KEY = "hummingrelay";
const STATUS_TTL_MS = 60_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface Balance {
	balance: number;
	paid: number;
	bonus: number;
	runway?: string;
	spend30d?: number;
	spendPerDay?: number;
}

// One console session per key for the life of the process; logins are rate-limited (429).
const cookies = new Map<string, string>();

const MONEY = String.raw`([−-])?\$([−-])?([\d,]+(?:\.\d+)?)`;

function money(match: RegExpMatchArray, at: number): number {
	const value = Number(match[at + 2].replaceAll(",", ""));
	return match[at] || match[at + 1] ? -value : value;
}

function pageText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/\s+/g, " ");
}

// Overview text: "Credit balance $5.36 $2.87 paid · $2.50 bonus ≈ 7 days at current pace Spend $22.14 $0.7379 / day average"
function parseOverview(html: string): Balance | undefined {
	const text = pageText(html);
	const head = text.match(new RegExp(`Credit balance ${MONEY} ${MONEY} paid · ${MONEY} bonus`));
	if (!head) return undefined;
	const result: Balance = { balance: money(head, 1), paid: money(head, 4), bonus: money(head, 7) };
	const runway = text.slice(head.index! + head[0].length).match(/^\s*(≈[^$]*?) Spend /);
	if (runway) result.runway = runway[1].trim();
	const spend = text.match(new RegExp(`Spend ${MONEY} ${MONEY} / day average`));
	if (spend) {
		result.spend30d = money(spend, 1);
		result.spendPerDay = money(spend, 4);
	}
	return result;
}

async function login(fetchFn: FetchFn, apiKey: string, signal?: AbortSignal): Promise<string> {
	const response = await fetchFn(LOGIN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ key: apiKey }),
		redirect: "manual",
		signal,
	});
	if (!response.ok) throw new Error(`console login failed: HTTP ${response.status}`);
	const setCookies =
		typeof response.headers.getSetCookie === "function"
			? response.headers.getSetCookie()
			: [response.headers.get("set-cookie") ?? ""];
	for (const header of setCookies) {
		const match = header.match(/(?:^|[;,]\s*)(hr_console=[^;]+)/);
		if (match) return match[1];
	}
	throw new Error("console login returned no hr_console cookie");
}

async function fetchBalance(fetchFn: FetchFn, apiKey: string, signal?: AbortSignal): Promise<Balance> {
	for (let attempt = 0; attempt < 2; attempt++) {
		let cookie = cookies.get(apiKey);
		if (!cookie) {
			cookie = await login(fetchFn, apiKey, signal);
			cookies.set(apiKey, cookie);
		}
		const response = await fetchFn(OVERVIEW_URL, {
			headers: { Cookie: cookie, Accept: "text/html" },
			redirect: "manual",
			signal,
		});
		// An expired or revoked session redirects to /dashboard/login; log in again once.
		if (response.status >= 300 && response.status < 400) {
			cookies.delete(apiKey);
			continue;
		}
		if (!response.ok) throw new Error(`console overview failed: HTTP ${response.status}`);
		const parsed = parseOverview(await response.text());
		if (parsed) return parsed;
		cookies.delete(apiKey);
	}
	throw new Error("console overview has no credit balance (layout changed or session rejected)");
}

const usd = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

export default function hummingRelayUsage(pi: ExtensionAPI) {
	const usage: UsageProvider = {
		id: PROVIDER,
		cacheVersion: 1,
		supports: (params) => params.provider === PROVIDER,
		async fetchUsage(params, ctx) {
			if (params.provider !== PROVIDER || params.credential.type !== "api_key") return null;
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;

			let data: Balance;
			try {
				data = await fetchBalance(ctx.fetch as FetchFn, apiKey, params.signal);
			} catch (error) {
				ctx.logger?.warn("HummingRelay balance request failed", { error: String(error) });
				return null;
			}

			const limits: UsageLimit[] = [
				{
					id: `${PROVIDER}:balance`,
					label: "Credit balance",
					scope: { provider: PROVIDER, windowId: "prepaid", shared: true },
					window: { id: "prepaid", label: "paid + bonus" },
					amount: { unit: "usd", remaining: data.balance },
					status: data.balance <= 0 ? "exhausted" : "ok",
				},
				{
					// model-one is billed to paid credit only (bonus credit does not cover it).
					id: `${PROVIDER}:paid`,
					label: "Paid credit",
					scope: { provider: PROVIDER, windowId: "prepaid-paid", shared: true },
					window: { id: "prepaid-paid", label: "model-one" },
					amount: { unit: "usd", remaining: data.paid },
					status: data.paid <= 0 ? "exhausted" : "ok",
				},
			];
			const notes = [`Paid ${usd(data.paid)} · bonus ${usd(data.bonus)} (bonus not valid for model-one)`];
			if (data.spend30d !== undefined && data.spendPerDay !== undefined) {
				notes.push(`Spend, last 30 days: ${usd(data.spend30d)} (${usd(data.spendPerDay)}/day)`);
			}
			if (data.runway) notes.push(data.runway);

			return {
				provider: PROVIDER,
				fetchedAt: Date.now(),
				limits,
				notes,
				metadata: { endpoint: OVERVIEW_URL },
			};
		},
	};

	pi.registerProvider(PROVIDER, { usage });

	// Status line: balance of the active hummingrelay model, refreshed after each agent run and every minute.
	let last: { at: number; text: string } | undefined;
	let inFlight: Promise<void> | undefined;

	const refresh = (ctx: ExtensionContext, force: boolean) => {
		if (!ctx.hasUI) return;
		const model = ctx.models?.current?.() ?? ctx.model;
		if (model?.provider !== PROVIDER) {
			if (last) ctx.ui.setStatus(STATUS_KEY, undefined);
			last = undefined;
			return;
		}
		if (!force && last && Date.now() - last.at < STATUS_TTL_MS) return;
		const apiKey = process.env[KEY_ENV];
		if (!apiKey || inFlight) return;
		inFlight = fetchBalance(fetch as FetchFn, apiKey)
			.then((data) => {
				const runway = data.runway ? ` · ${data.runway.replace(/ at current pace$/, "")}` : "";
				const text = `HR ${usd(data.balance)} (paid ${usd(data.paid)})${runway}`;
				last = { at: Date.now(), text };
				ctx.ui.setStatus(STATUS_KEY, text);
			})
			.catch(() => {
				last = { at: Date.now(), text: "HR balance unavailable" };
				ctx.ui.setStatus(STATUS_KEY, last.text);
			})
			.finally(() => {
				inFlight = undefined;
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx, true);
		// No model-change event exists; the tick also picks up /model switches within ~15 s.
		ctx.setInterval(() => refresh(ctx, false), 15_000);
	});
	pi.on("agent_end", async (_event, ctx) => refresh(ctx, true));
}
