import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmGateway } from "../src/core/llm.js";
import type { LlmCallTelemetryEvent } from "../src/core/types.js";

describe("llm empty response retry", () => {
	it("retries on empty text and succeeds on a later attempt", async () => {
		const telemetry: LlmCallTelemetryEvent[] = [];
		let attempts = 0;

		const llm = new LlmGateway(
			{
				api: "openai-completions",
				provider: "test",
				modelId: "test-model",
				baseUrl: "http://localhost",
				apiKey: "x",
				temperature: 1,
				topP: 1,
				maxTokens: 1000,
				thinking: "off",
				rpmLimit: 100,
				retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
			},
			(event) => {
				telemetry.push(event);
			},
			{
				completeSimpleFn: async () => {
					attempts += 1;
					if (attempts === 1) {
						return {
							stopReason: "done",
							content: [],
						};
					}
					return {
						stopReason: "done",
						content: [{ type: "text", text: "ok" }],
					};
				},
			} as any,
		);

		const output = await llm.completeText("system", "user", 128, {
			workflowStage: "plan_review",
			operation: "generate_plan_initial",
			projectId: "p1",
		});

		assert.equal(output, "ok");
		assert.equal(attempts, 2);
		assert.ok(telemetry.some((event) => event.kind === "retry_scheduled"));
		assert.ok(telemetry.some((event) => event.kind === "call_success" && event.attempt === 2));
	});
});
