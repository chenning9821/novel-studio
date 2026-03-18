import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LlmGateway } from "../src/core/llm.js";
import { PlanService } from "../src/core/plan-service.js";
import { FileStore } from "../src/core/storage.js";

describe("plan regenerate full", () => {
	it("regenerates entire plan and increments version", async () => {
		const root = await mkdtemp(join(tmpdir(), "novel-studio-plan-regenerate-"));
		try {
			const store = new FileStore(root);
			await store.init();
			const project = await store.createProject({
				title: "重生测试",
				target_total_words: 100000,
				genre: "仙侠",
				theme: "成长",
				style: "克制",
				taboos: "无",
			});

			await store.saveDecisionManifest(project.id, {
				version: 2,
				completed: true,
				decisions: [
					{
						id: "d1",
						title: "核心基调",
						description: "",
						required: true,
						multiple: false,
						selectedOptionIds: ["opt1"],
						otherText: "",
						options: [
							{ id: "opt1", label: "厚重肃穆", description: "" },
							{ id: "__other__", label: "其他（自定义）", description: "", isOther: true },
						],
					},
				],
			});

			const manifest = await store.loadPlanManifest(project.id);
			for (const section of manifest.sections) {
				section.content = `旧内容-${section.id}`;
			}
			manifest.version = 5;
			manifest.confirmed = true;
			await store.setPlanManifest(project.id, manifest);

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

			(llm as unknown as { completeText: () => Promise<string> }).completeText = async () => "# 新版总策划 Plan\n\n- 强化人物弧线\n- 提升冲突压迫感";

			const service = new PlanService(store, llm);
			const next = await service.regenerateFullPlan(project.id, { guidance: "强化人物弧线" });
			assert.equal(next.version, 6);
			assert.equal(next.confirmed, false);
			const master = next.sections.find((section) => section.id === "master_plan");
			assert.ok(master);
			assert.match(master?.content || "", /新版总策划 Plan/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});


