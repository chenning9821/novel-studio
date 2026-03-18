import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LlmGateway } from "../src/core/llm.js";
import { PlanService } from "../src/core/plan-service.js";
import { FileStore } from "../src/core/storage.js";

describe("decision default selection", () => {
	it("auto-selects one recommended or fallback option per decision", async () => {
		const root = await mkdtemp(join(tmpdir(), "novel-studio-default-selection-"));
		try {
			const store = new FileStore(root);
			await store.init();
			const project = await store.createProject({
				title: "默认勾选测试",
				target_total_words: 150000,
				genre: "都市",
				theme: "成长",
				style: "克制",
				taboos: "无",
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

			let round = 0;
			(
				llm as unknown as {
					completeJson: () => Promise<{
						decisions: Array<{
							id: string;
							title: string;
							description: string;
							required: boolean;
							multiple: boolean;
							options: Array<{ id: string; label: string; description: string }>;
						}>;
					}>;
				}
			).completeJson = async () => {
				round += 1;
				return {
					decisions: [
						{
							id: `r${round}-a`,
							title: `决策A-${round}`,
							description: "测试候选",
							required: true,
							multiple: false,
							options: [
								{ id: `r${round}-a-opt-1`, label: "首选", description: "应被自动选中" },
								{ id: `r${round}-a-opt-2`, label: "备选", description: "备用" },
							],
						},
						{
							id: `r${round}-b`,
							title: `决策B-${round}`,
							description: "测试候选",
							required: true,
							multiple: true,
							options: [
								{ id: `r${round}-b-opt-1`, label: "首选", description: "应被自动选中" },
								{ id: `r${round}-b-opt-2`, label: "备选", description: "备用" },
							],
						},
					],
				};
			};

			const service = new PlanService(store, llm);
			const manifest = await service.generateDecisionManifest(project.id);
			assert.equal(manifest.completed, false);
			assert.ok(manifest.decisions.length >= 8);

			for (const decision of manifest.decisions) {
				assert.equal(decision.selectedOptionIds.length, 1);
				const selected = decision.selectedOptionIds[0];
				assert.ok(selected);
				const selectedOption = decision.options.find((option) => option.id === selected);
				assert.ok(selectedOption);
				const firstNonOther = decision.options.find((option) => option.id !== "__other__");
				assert.equal(selected, firstNonOther?.id);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
