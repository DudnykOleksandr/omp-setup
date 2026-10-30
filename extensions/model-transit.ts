/**
 * model-transit — makes a mid-session model switch safe.
 *
 * Problem: a committed compaction can carry a *native* payload that only the
 * provider that wrote it can replay:
 *   - preserveData.openaiRemoteCompaction -> Responses-family models only
 *     (everyone else sees a ~900-char placeholder + <files>)
 *   - preserveData.snapcompact            -> vision models only
 *     (a text-only model loses the imaged middle of the archive)
 * Switching the model therefore silently thins the context for the next turn.
 *
 * Fix: when the active model changes and the newest compaction is unreadable by
 * it, recompact once, while idle, with a method the new model can read.
 * Compaction preparation re-expands the originals from the journal, so the
 * rewrite costs no history.
 *
 * Mode: vision -> "snapcompact" (local, no network, no quota),
 * otherwise -> "soft" (plain text, portable everywhere).
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const RESPONSES_APIS: Record<string, true> = {
	"openai-responses": true,
	"openai-codex-responses": true,
	"azure-openai-responses": true,
};

const POLL_MS = 2000;

export type Kind = "openai" | "snapcompact" | "anthropic" | "text" | "none";

function field(value: unknown, key: string): unknown {
	return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function nativeKind(entry: unknown): Kind {
	if (!entry) return "none";
	const preserved = field(entry, "preserveData");
	if (field(preserved, "openaiRemoteCompaction")) return "openai";
	if (field(preserved, "snapcompact")) return "snapcompact";
	if (field(preserved, "anthropicCompaction")) return "anthropic";
	return "text";
}

export function providerOf(model: unknown): string {
	return text(field(model, "provider")) || text(field(model, "providerId"));
}

export function modelKey(model: unknown): string {
	const id = text(field(model, "id"));
	return id ? `${providerOf(model)}/${id}` : "";
}

export function isVision(model: unknown): boolean {
	const input = field(model, "input");
	return Array.isArray(input) && input.includes("image");
}

/** Can `model` replay the native payload of a compaction of this kind? */
export function canRead(kind: Kind, model: unknown, writerProvider?: string): boolean {
	switch (kind) {
		case "openai": {
			// Needs a Responses-family encoder on the provider that wrote it.
			if (!RESPONSES_APIS[text(field(model, "api"))]) return false;
			return writerProvider ? providerOf(model) === writerProvider : true;
		}
		case "snapcompact":
			return isVision(model);
		// Anthropic blocks degrade to their real summary text; plain summaries are portable.
		default:
			return true;
	}
}

export function planTransit(
	entry: unknown,
	model: unknown,
	writerProvider?: string,
): { mode: "snapcompact" | "soft"; kind: Kind } | undefined {
	const kind = nativeKind(entry);
	if (kind === "none" || canRead(kind, model, writerProvider)) return undefined;
	return { mode: isVision(model) ? "snapcompact" : "soft", kind };
}

function lastCompaction(ctx: ExtensionContext): unknown {
	let found: unknown;
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (field(entry, "type") === "compaction") found = entry;
	}
	return found;
}

function currentModel(ctx: ExtensionContext): unknown {
	const models = field(ctx, "models");
	const current = field(models, "current");
	return typeof current === "function" ? (current as () => unknown).call(models) : undefined;
}

export default function modelTransit(pi: ExtensionAPI) {
	pi.setLabel("Model transit");

	pi.on("session_start", async (_event, ctx) => {
		let seen = modelKey(currentModel(ctx));
		/** provider that wrote the newest compaction, when this session observed it */
		let writerProvider: string | undefined;
		let busy = false;

		pi.on("session_compact", (_event, compactCtx) => {
			writerProvider = providerOf(currentModel(compactCtx));
		});

		const timer = ctx.setInterval(async () => {
			if (busy) return;
			const model = currentModel(ctx);
			const key = modelKey(model);
			if (!key || key === seen) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return; // never race a turn
			seen = key;

			const plan = planTransit(lastCompaction(ctx), model, writerProvider);
			if (!plan) return;

			busy = true;
			ctx.ui.notify(`Model transit: recompacting as ${plan.mode} — previous ${plan.kind} payload is unreadable by ${key}`, "info");
			try {
				await ctx.compact({
					mode: plan.mode,
					suppressContinuation: true,
					onError: (error: unknown) => ctx.ui.notify(`Model transit failed: ${String(error)}`, "warning"),
				});
				writerProvider = providerOf(model);
			} finally {
				busy = false;
			}
		}, POLL_MS);

		pi.on("session_shutdown", () => ctx.clearTimer(timer));
	});
}
