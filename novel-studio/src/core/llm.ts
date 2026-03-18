import { completeSimple, streamSimple, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { LlmCallContext, LlmCallTelemetryEvent, ModelProfile } from "./types.js";
import { createId, nowIso, parseJsonObject, sleep } from "./utils.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

export type LlmTelemetrySink = (event: LlmCallTelemetryEvent) => Promise<void> | void;

export interface LlmStreamCallbacks {
	onTextDelta?: (delta: string) => Promise<void> | void;
}

interface LlmRuntime {
	completeSimpleFn?: typeof completeSimple;
	streamSimpleFn?: typeof streamSimple;
}

function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return /429|too many requests|rate.?limit|500|502|503|504|timeout|fetch failed|connection|overloaded|empty text response|empty response|no content/.test(
		message,
	);
}

function parseRetryAfterMs(error: unknown): number | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const message = error.message;
	const retryIn = message.match(/retry\s+after\s+(\d+)\s*(ms|s|seconds?)/i);
	if (!retryIn || !retryIn[1]) {
		return null;
	}
	const value = Number.parseInt(retryIn[1], 10);
	if (!Number.isFinite(value)) {
		return null;
	}
	const unit = retryIn[2]?.toLowerCase() || "s";
	if (unit.startsWith("ms")) {
		return value;
	}
	return value * 1000;
}

function createModel(profile: ModelProfile): Model<any> {
	return {
		id: profile.modelId,
		name: profile.modelId,
		api: profile.api,
		provider: profile.provider,
		baseUrl: profile.baseUrl,
		reasoning: profile.thinking !== "off",
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: profile.maxTokens,
	} satisfies Model<any>;
}

function toReasoningLevel(thinking: ModelProfile["thinking"]): Exclude<ModelProfile["thinking"], "off"> | undefined {
	if (thinking === "off") {
		return undefined;
	}
	return thinking;
}

function extractTextLength(response: Awaited<ReturnType<typeof completeSimple>>): number {
	return response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n").length;
}

function extractText(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function shortError(error: unknown): string {
	if (error instanceof Error) {
		return error.message.slice(0, 240);
	}
	return String(error).slice(0, 240);
}

export function formatLlmTelemetryMessage(event: LlmCallTelemetryEvent): string {
	const protocolTag = event.protocol ? ` protocol=${event.protocol}${event.protocolVersion ? `/${event.protocolVersion}` : ""}` : "";
	const prefix = `[${event.workflowStage || "unknown"}/${event.operation || "unknown"}] #${event.callId.slice(0, 8)}${protocolTag}`;
	switch (event.kind) {
		case "call_start":
			return `${prefix} call start model=${event.modelId} maxTokens=${event.maxTokens}`;
		case "attempt_start":
			return `${prefix} attempt ${event.attempt}/${event.maxAttempts}`;
		case "retry_scheduled":
			return `${prefix} retry ${event.attempt}/${event.maxAttempts} after ${event.delayMs}ms: ${event.error || "unknown"}`;
		case "call_success":
			return `${prefix} call success ${event.elapsedMs}ms chars=${event.responseChars || 0}`;
		case "call_failed":
			return `${prefix} call failed ${event.elapsedMs}ms: ${event.error || "unknown"}`;
		default:
			return `${prefix} call state unknown`;
	}
}

export class LlmGateway {
	private readonly limiter: SlidingWindowRateLimiter;
	private profile: ModelProfile;
	private telemetrySink?: LlmTelemetrySink;
	private readonly completeSimpleFn: typeof completeSimple;
	private readonly streamSimpleFn: typeof streamSimple;

	constructor(profile: ModelProfile, telemetrySink?: LlmTelemetrySink, runtime: LlmRuntime = {}) {
		this.profile = profile;
		this.telemetrySink = telemetrySink;
		this.limiter = new SlidingWindowRateLimiter(profile.rpmLimit);
		this.completeSimpleFn = runtime.completeSimpleFn || completeSimple;
		this.streamSimpleFn = runtime.streamSimpleFn || streamSimple;
	}

	updateProfile(profile: ModelProfile): void {
		this.profile = profile;
		this.limiter.setMaxRequestsPerMinute(profile.rpmLimit);
	}

	setTelemetrySink(telemetrySink?: LlmTelemetrySink): void {
		this.telemetrySink = telemetrySink;
	}

	private isNvidiaProfile(): boolean {
		return this.profile.provider.toLowerCase().includes("nvidia") || /integrate\.api\.nvidia\.com/i.test(this.profile.baseUrl);
	}

	private normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
		const out = { ...payload };
		out.top_p = this.profile.topP;

		if (this.profile.extraBody) {
			for (const [key, value] of Object.entries(this.profile.extraBody)) {
				out[key] = value;
			}
		}

		if (this.isNvidiaProfile() && typeof out.chat_template_kwargs === "object" && out.chat_template_kwargs !== null) {
			const kwargs = { ...(out.chat_template_kwargs as Record<string, unknown>) };
			if (kwargs.thinking === true) {
				kwargs.thinking = false;
			}
			out.chat_template_kwargs = kwargs;
		}

		return out;
	}

	private buildOptions(_maxTokens: number): SimpleStreamOptions {
		return {
			apiKey: this.profile.apiKey,
			temperature: this.profile.temperature,
			reasoning: toReasoningLevel(this.profile.thinking),
			onPayload: (payload) => {
				if (typeof payload !== "object" || payload === null) {
					return payload;
				}
				return this.normalizePayload(payload as Record<string, unknown>);
			},
			maxRetryDelayMs: this.profile.retry.maxDelayMs,
		};
	}

	private async emitTelemetry(
		kind: LlmCallTelemetryEvent["kind"],
		callId: string,
		maxTokens: number,
		context: LlmCallContext | undefined,
		extra: Partial<LlmCallTelemetryEvent> = {},
	): Promise<void> {
		if (!this.telemetrySink) {
			return;
		}
		const event: LlmCallTelemetryEvent = {
			kind,
			timestamp: nowIso(),
			callId,
			modelId: this.profile.modelId,
			provider: this.profile.provider,
			maxTokens,
			workflowStage: context?.workflowStage,
			operation: context?.operation,
			projectId: context?.projectId,
			protocol: context?.protocol,
			protocolVersion: context?.protocolVersion,
			...extra,
		};
		try {
			await this.telemetrySink(event);
		} catch {
			// Ignore telemetry sink errors to avoid breaking generation flow.
		}
	}

	private buildContext(systemPrompt: string, userPrompt: string): Context {
		return {
			systemPrompt,
			messages: [
				{
					role: "user",
					content: userPrompt,
					timestamp: Date.now(),
				},
			],
		};
	}

	async completeText(systemPrompt: string, userPrompt: string, maxTokensOverride?: number, context?: LlmCallContext): Promise<string> {
		const response = await this.completeRaw(systemPrompt, userPrompt, maxTokensOverride, context, true);
		const text = extractText(response).trim();
		if (text.length === 0) {
			throw new Error("LLM returned empty text response");
		}
		return text;
	}

	async completeTextStream(
		systemPrompt: string,
		userPrompt: string,
		callbacks: LlmStreamCallbacks = {},
		maxTokensOverride?: number,
		context?: LlmCallContext,
	): Promise<string> {
		const model = createModel(this.profile);
		const maxTokens = maxTokensOverride ?? this.profile.maxTokens;
		const content = this.buildContext(systemPrompt, userPrompt);
		const options = this.buildOptions(maxTokens);

		const callId = createId();
		const startedAt = Date.now();
		let attempt = 0;
		let lastError: unknown;
		const maxAttempts = this.profile.retry.maxRetries + 1;

		await this.emitTelemetry("call_start", callId, maxTokens, context, {
			maxAttempts,
		});

		while (attempt < maxAttempts) {
			attempt += 1;
			await this.emitTelemetry("attempt_start", callId, maxTokens, context, {
				attempt,
				maxAttempts,
			});
			await this.limiter.acquire();

			try {
				const stream = this.streamSimpleFn(model, content, options);
				for await (const event of stream) {
					if (event.type === "text_delta" && callbacks.onTextDelta) {
						await callbacks.onTextDelta(event.delta);
					}
				}
				const response = await stream.result();
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					throw new Error(response.errorMessage || "LLM stop reason error");
				}
				const text = extractText(response).trim();
				if (text.length === 0) {
					throw new Error("LLM returned empty text response");
				}

				await this.emitTelemetry("call_success", callId, maxTokens, context, {
					attempt,
					maxAttempts,
					elapsedMs: Date.now() - startedAt,
					responseChars: text.length,
				});
				return text;
			} catch (error) {
				lastError = error;
				const retryable = isRetryableError(error);
				if (!retryable || attempt >= maxAttempts) {
					await this.emitTelemetry("call_failed", callId, maxTokens, context, {
						attempt,
						maxAttempts,
						elapsedMs: Date.now() - startedAt,
						error: shortError(error),
					});
					break;
				}

				const retryAfter = parseRetryAfterMs(error);
				let delay = this.profile.retry.baseDelayMs * 2 ** (attempt - 1);
				if (retryAfter !== null) {
					delay = retryAfter;
				}
				delay = Math.min(this.profile.retry.maxDelayMs, delay);
				const jitter = Math.floor(Math.random() * Math.min(1000, delay / 3));
				const totalDelay = delay + jitter;

				await this.emitTelemetry("retry_scheduled", callId, maxTokens, context, {
					attempt,
					maxAttempts,
					delayMs: totalDelay,
					error: shortError(error),
				});
				await sleep(totalDelay);
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error("LLM call failed without detailed error");
	}

	async completeJson<T>(systemPrompt: string, userPrompt: string, maxTokensOverride?: number, context?: LlmCallContext): Promise<T> {
		const text = await this.completeText(systemPrompt, `${userPrompt}\n\nReturn a JSON object only.`, maxTokensOverride, context);
		const parsed = parseJsonObject<T>(text);
		if (!parsed) {
			throw new Error(`Failed to parse JSON response: ${text.slice(0, 400)}`);
		}
		return parsed;
	}

	private async completeRaw(
		systemPrompt: string,
		userPrompt: string,
		maxTokensOverride?: number,
		context?: LlmCallContext,
		requireNonEmptyText = false,
	) {
		const model = createModel(this.profile);
		const maxTokens = maxTokensOverride ?? this.profile.maxTokens;
		const content = this.buildContext(systemPrompt, userPrompt);
		const options = this.buildOptions(maxTokens);

		const callId = createId();
		const startedAt = Date.now();
		let attempt = 0;
		let lastError: unknown;
		const maxAttempts = this.profile.retry.maxRetries + 1;

		await this.emitTelemetry("call_start", callId, maxTokens, context, {
			maxAttempts,
		});

		while (attempt < maxAttempts) {
			attempt += 1;
			await this.emitTelemetry("attempt_start", callId, maxTokens, context, {
				attempt,
				maxAttempts,
			});
			await this.limiter.acquire();
			try {
				const response = await this.completeSimpleFn(model, content, options);
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					throw new Error(response.errorMessage || "LLM stop reason error");
				}

				const responseChars = extractTextLength(response);
				if (requireNonEmptyText && responseChars === 0) {
					throw new Error("LLM returned empty text response");
				}

				await this.emitTelemetry("call_success", callId, maxTokens, context, {
					attempt,
					maxAttempts,
					elapsedMs: Date.now() - startedAt,
					responseChars,
				});
				return response;
			} catch (error) {
				lastError = error;
				const retryable = isRetryableError(error);
				if (!retryable || attempt >= maxAttempts) {
					await this.emitTelemetry("call_failed", callId, maxTokens, context, {
						attempt,
						maxAttempts,
						elapsedMs: Date.now() - startedAt,
						error: shortError(error),
					});
					break;
				}

				const retryAfter = parseRetryAfterMs(error);
				let delay = this.profile.retry.baseDelayMs * 2 ** (attempt - 1);
				if (retryAfter !== null) {
					delay = retryAfter;
				}
				delay = Math.min(this.profile.retry.maxDelayMs, delay);
				const jitter = Math.floor(Math.random() * Math.min(1000, delay / 3));
				const totalDelay = delay + jitter;

				await this.emitTelemetry("retry_scheduled", callId, maxTokens, context, {
					attempt,
					maxAttempts,
					delayMs: totalDelay,
					error: shortError(error),
				});
				await sleep(totalDelay);
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error("LLM call failed without detailed error");
	}
}
