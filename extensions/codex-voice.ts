// Dictation through the ChatGPT/Codex subscription instead of a local Whisper model.
//
// omp's STT runner only speaks OpenAI `POST {baseUrl}/audio/transcriptions`, so this extension runs a
// loopback shim and registers it as provider `codex-voice` (model `transcribe`, api `openai-transcriptions`).
// The shim forwards the recording to the private route Codex Desktop dictation uses:
//   POST https://chatgpt.com/backend-api/transcribe
//   Authorization: Bearer <openai-codex access token>, ChatGPT-Account-Id, originator: Codex Desktop
//   multipart `file` (+ optional `language`) -> {"text": "..."}
// The route is undocumented and may change without notice. The backend picks the audio decoder from the
// file name's extension (an extension-less name answers 500 "Error in ASR API"), so the upload is renamed
// from its MIME type; omp's own `model`, `response_format`, `prompt` fields are not forwarded.
// OpenAI keeps each uploaded recording for 30 days (`asset_ttl: "30d"` in the response).
//
// The token comes from omp's own `openai-codex` login (`/login openai-codex`), so omp owns refresh and
// rotation; `~/.codex/auth.json` is never read or written. The shim binds 127.0.0.1 on a random port and
// accepts only the per-process bearer secret registered as the provider's key.
//
// Enable with:
//   modelRoles.dictation: codex-voice/transcribe
//   retry.fallbackChains.dictation: [local/whisper-large-v3-turbo]

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROVIDER = "codex-voice";
const MODEL_ID = "transcribe";
const CODEX_PROVIDER = "openai-codex";
const UPSTREAM_URL = "https://chatgpt.com/backend-api/transcribe";
const ORIGINATOR = "Codex Desktop";
const ROUTE = "/v1/audio/transcriptions";
const UPSTREAM_TIMEOUT_MS = 60_000;
const ERROR_DETAIL_MAX = 300;

const EXTENSION_BY_MIME: Record<string, string> = {
	"audio/wav": "wav",
	"audio/wave": "wav",
	"audio/x-wav": "wav",
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/opus": "ogg",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/m4a": "m4a",
	"audio/x-m4a": "m4a",
	"audio/flac": "flac",
};

type ModelRegistry = ExtensionContext["modelRegistry"];

// Module scope: child sessions rerun the factory, but one shim per process is enough.
const secret = crypto.randomUUID();
let registry: ModelRegistry | undefined;
let shimPort: number | undefined;

function errorResponse(status: number, message: string): Response {
	return Response.json({ error: { message } }, { status });
}

function uploadName(file: File): string {
	const name = file.name?.trim() || "audio";
	if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
	const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
	return `${name}.${EXTENSION_BY_MIME[mime] ?? "wav"}`;
}

function chatgptAccountId(accessToken: string): string | undefined {
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

function upstream(accessToken: string, body: FormData, signal: AbortSignal): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		originator: ORIGINATOR,
	};
	const accountId = chatgptAccountId(accessToken);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	return fetch(UPSTREAM_URL, { method: "POST", headers, body, signal, redirect: "error" });
}

async function transcribe(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== "POST" || url.pathname !== ROUTE) return errorResponse(404, "Not found");
	if (req.headers.get("authorization") !== `Bearer ${secret}`) return errorResponse(401, "Unauthorized");
	if (!registry) return errorResponse(503, "codex-voice: no omp session is ready yet");

	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File) || file.size === 0) return errorResponse(400, "Missing audio `file`");
	const body = new FormData();
	body.append("file", file, uploadName(file));
	const language = form.get("language");
	if (typeof language === "string" && language.trim()) body.append("language", language.trim());

	const signal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
	const token = await registry.getApiKeyForProvider(CODEX_PROVIDER, undefined, { signal });
	if (!token) return errorResponse(401, "codex-voice: no openai-codex login; run /login openai-codex");

	let res = await upstream(token, body, signal);
	if (res.status === 401) {
		const fresh = await registry.getApiKeyForProvider(CODEX_PROVIDER, undefined, {
			forceRefresh: true,
			rejectedAccessToken: token,
			signal,
		});
		if (fresh && fresh !== token) res = await upstream(fresh, body, signal);
	}

	if (!res.ok) {
		const detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_MAX);
		return errorResponse(res.status, `ChatGPT transcribe ${res.status}: ${detail || res.statusText}`);
	}
	const payload: unknown = await res.json();
	const text = payload && typeof payload === "object" && "text" in payload ? payload.text : undefined;
	if (typeof text !== "string") return errorResponse(502, "ChatGPT transcribe returned no text");
	return Response.json({ text: text.trim() });
}

/** Starts the loopback shim and returns its port. */
function startServer(): number {
	const started = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			try {
				return await transcribe(req);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(502, `codex-voice: ${message}`);
			}
		},
	});
	started.unref();
	return started.port;
}

export default function codexVoice(pi: ExtensionAPI) {
	pi.setLabel("Codex voice dictation");
	shimPort ??= startServer();

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	pi.registerProvider(PROVIDER, {
		baseUrl: `http://127.0.0.1:${shimPort}/v1`,
		apiKey: secret,
		models: [
			{
				id: MODEL_ID,
				name: "ChatGPT transcribe (Codex subscription)",
				api: "openai-transcriptions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		],
	});
}
