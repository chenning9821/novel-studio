import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LlmGateway } from "../src/core/llm.js";
import { PlanService } from "../src/core/plan-service.js";
import { FileStore } from "../src/core/storage.js";

describe("decision other option", () => {
	it("requires custom text when selecting __other__", async () => {
		const root = await mkdtemp(join(tmpdir(), "novel-studio-decision-test-"));
		try {
			const store = new FileStore(root);
			await store.init();
			const project = await store.createProject({
				title: "测试项目",
				target_total_words: 100000,
				genre: "奇幻",
				theme: "成长",
				style: "克制",
				taboos: "无",
			});

			await store.saveDecisionManifest(project.id, {
				version: 1,
				completed: false,
				decisions: [
					{
						id: "d1",
						title: "测试决策",
						description: "",
						required: true,
						multiple: false,
						selectedOptionIds: [],
						otherText: "",
						options: [
							{ id: "opt1", label: "选项1", description: "" },
							{ id: "__other__", label: "其他（自定义）", description: "", isOther: true },
						],
					},
				],
			});

			const llm = new LlmGateway({
				api: "openai-completions",
				provider: "test",
				modelId: "test-model",
				baseUrl: "http://localhost",
				apiKey: "x",
				temperature: 1,
				topP: 1,
				maxTokens: 1000,
				thinking: "off",
				rpmLimit: 40,
				retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
			});
			const service = new PlanService(store, llm);

			const invalid = await service.applyDecisionSelections(project.id, { d1: ["__other__"] }, { d1: "" });
			assert.equal(invalid.completed, false);

			const valid = await service.applyDecisionSelections(project.id, { d1: ["__other__"] }, { d1: "我自定义的路线" });
			assert.equal(valid.completed, true);
			assert.equal(valid.decisions[0]?.otherText, "我自定义的路线");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
