// Ollama Cloud subscription quota for `/usage`, `omp usage`, and the status-line `usage` segment.
// Overrides omp's built-in `ollama-cloud` usage provider, which reports no limits.
// Source: GET https://ollama.com/api/balance (https://docs.ollama.com/api/balance.md).

import type { UsageLimit, UsageProvider } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PROVIDER = "ollama-cloud";
const BALANCE_URL = "https://ollama.com/api/balance";
const HOUR_MS = 3_600_000;

// Same thresholds as omp's built-in usage providers.
function status(usedFraction: number): UsageLimit["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

export default function ollamaCloudUsage(pi: ExtensionAPI) {
	const z = pi.zod;
	// Invalid timestamps become "no reset time", not a schema failure that hides the whole report.
	const resetTime = (value: string) => {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : undefined;
	};
	// Legacy plans: `remaining_percent` is the share LEFT (75 = 75% remains).
	const LegacyLimit = z.object({ remaining_percent: z.number().min(0).max(100), resets_at: z.string() });
	// pi.zod objects strip unknown keys (a morph), so ArkType rejects a union of the two plan shapes.
	// Both shapes share one object with optional fields; the plan is told apart after parsing.
	const Balance = z.object({
		included: z.object({
			session: LegacyLimit.optional(),
			weekly: LegacyLimit.optional(),
			// Credit plans: monthly USD allowance; `period.until` is the next reset.
			balance_usd: z.number().optional(),
			allowance_usd: z.number().positive().optional(),
			period: z.object({ from: z.string(), until: z.string() }).optional(),
		}),
		purchased: z.object({ balance_usd: z.number() }).optional(),
	});

	const legacyLimit = (
		id: "5h" | "7d",
		label: string,
		durationMs: number,
		raw: { remaining_percent: number; resets_at: string },
	): UsageLimit => {
		const remainingFraction = raw.remaining_percent / 100;
		const usedFraction = 1 - remainingFraction;
		return {
			id: `${PROVIDER}:${id}`,
			label,
			scope: { provider: PROVIDER, windowId: id, shared: true },
			window: { id, label, durationMs, resetsAt: resetTime(raw.resets_at) },
			amount: {
				unit: "percent",
				used: usedFraction * 100,
				limit: 100,
				remaining: raw.remaining_percent,
				usedFraction,
				remainingFraction,
			},
			status: status(usedFraction),
		};
	};

	const usage: UsageProvider = {
		id: PROVIDER,
		// Distinct from the built-in provider so neither serves the other's cached reports.
		cacheVersion: 100,
		supports: (params) => params.provider === PROVIDER,
		async fetchUsage(params, ctx) {
			if (params.provider !== PROVIDER || params.credential.type !== "api_key") return null;
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;

			let payload: unknown;
			try {
				const response = await ctx.fetch(BALANCE_URL, {
					headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
					redirect: "manual",
					signal: params.signal,
				});
				if (!response.ok) {
					ctx.logger?.warn("Ollama Cloud balance request failed", {
						status: response.status,
						retryAfter: response.headers.get("retry-after") ?? undefined,
					});
					return null;
				}
				payload = await response.json();
			} catch (error) {
				ctx.logger?.warn("Ollama Cloud balance request error", { error: String(error) });
				return null;
			}
			const parsed = Balance.safeParse(payload);
			if (!parsed.success) {
				ctx.logger?.warn("Ollama Cloud balance response invalid", { error: parsed.error.message });
				return null;
			}

			const { included, purchased } = parsed.data;
			const limits: UsageLimit[] = [];
			if (included.session) limits.push(legacyLimit("5h", "Session", 5 * HOUR_MS, included.session));
			if (included.weekly) limits.push(legacyLimit("7d", "Weekly", 7 * 24 * HOUR_MS, included.weekly));
			if (included.balance_usd !== undefined && included.allowance_usd !== undefined && included.period) {
				const remaining = Math.max(included.balance_usd, 0);
				const remainingFraction = Math.min(remaining / included.allowance_usd, 1);
				const usedFraction = 1 - remainingFraction;
				const from = resetTime(included.period.from);
				const until = resetTime(included.period.until);
				limits.push({
					id: `${PROVIDER}:monthly`,
					label: "Monthly credits",
					scope: { provider: PROVIDER, windowId: "monthly", shared: true },
					window: {
						id: "monthly",
						label: "Monthly",
						durationMs: from !== undefined && until !== undefined ? until - from : undefined,
						resetsAt: until,
					},
					amount: {
						unit: "usd",
						used: included.allowance_usd - remaining,
						limit: included.allowance_usd,
						remaining,
						usedFraction,
						remainingFraction,
					},
					status: status(usedFraction),
				});
			}
			if (limits.length === 0) {
				ctx.logger?.warn("Ollama Cloud balance response has no known plan limits");
				return null;
			}

			return {
				provider: PROVIDER,
				fetchedAt: Date.now(),
				limits,
				...(purchased ? { notes: [`Purchased credits: $${purchased.balance_usd.toFixed(2)}`] } : {}),
				metadata: { endpoint: BALANCE_URL },
			};
		},
	};

	pi.registerProvider(PROVIDER, { usage });
}
