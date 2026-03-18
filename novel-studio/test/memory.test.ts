import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LlmGateway } from "../src/core/llm.js";
import { MemoryManager } from "../src/core/memory.js";
import { FileStore } from "../src/core/storage.js";

describe("memory retrieval", () => {
	it("returns facts related to query", async () => {
		const root = await mkdtemp(join(tmpdir(), "novel-studio-test-"));
		try {
			const store = new FileStore(root);
			await store.init();
			const project = await store.createProject({
				title: "测试项目",
				target_total_words: 100000,
				genre: "奇幻",
				theme: "勇气",
				style: "克制",
				taboos: "无",
			});

			const memoryManager = new MemoryManager(store, {} as LlmGateway);
			const factsPath = join(store.projectMemoryDir(project.id), "facts.jsonl");
			await writeFile(
				factsPath,
				[
					JSON.stringify({
						factId: "a",
						chapterRef: "V1-C1",
						timestamp: new Date().toISOString(),
						text: "主角林澈在黑塔获得火焰戒指",
						entityRefs: ["林澈", "火焰戒指"],
						confidence: 0.9,
						tags: ["道具", "主角"],
					}),
					JSON.stringify({
						factId: "b",
						chapterRef: "V1-C2",
						timestamp: new Date().toISOString(),
						text: "反派议会在银港召开会议",
						entityRefs: ["反派议会"],
						confidence: 0.8,
						tags: ["反派"],
					}),
				].join("\n") + "\n",
				"utf8",
			);

			const result = await memoryManager.memoryGet(project.id, "火焰戒指", 1);
			assert.equal(result.length, 1);
			assert.equal(result[0]?.factId, "a");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
