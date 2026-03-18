import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLlmTelemetryMessage } from "../src/core/llm.js";

describe("llm telemetry message", () => {
	it("formats retry event with delay", () => {
		const message = formatLlmTelemetryMessage({
			kind: "retry_scheduled",
			timestamp: new Date().toISOString(),
			callId: "12345678-1234-1234-1234-1234567890ab",
			modelId: "m",
			provider: "p",
			maxTokens: 1024,
			workflowStage: "plan_review",
			operation: "generate_plan_initial",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 3000,
			error: "429 too many requests",
		});
		assert.match(message, /3000ms/);
		assert.match(message, /429/);
	});
});
