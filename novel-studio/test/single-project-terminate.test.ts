import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Server } from "node:http";
import { startNovelStudioServer } from "../src/server.js";

interface JsonResponse<T> {
	status: number;
	body: T;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<JsonResponse<T>> {
	const response = await fetch(url, init);
	const status = response.status;
	if (status === 204) {
		return { status, body: null as T };
	}
	const body = (await response.json()) as T;
	return { status, body };
}

describe("single project mode after terminate", () => {
	it("hides terminated project and allows creating a new one", async () => {
		const root = await mkdtemp(join(tmpdir(), "novel-studio-server-test-"));
		const dataDir = join(root, "data");
		const publicDir = join(root, "public");
		await mkdir(publicDir, { recursive: true });

		let server: Server | null = null;
		try {
			server = await startNovelStudioServer({
				port: 0,
				dataDir,
				publicDir,
			});
			const address = server.address();
			assert.ok(address && typeof address === "object" && "port" in address);
			const base = `http://127.0.0.1:${address.port}`;

			const createFirst = await requestJson<{ id: string }>(`${base}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "第一部",
					prompt: "测试",
					target_total_words: 100000,
					genre: "奇幻",
					theme: "成长",
					style: "克制",
					taboos: "无",
				}),
			});
			assert.equal(createFirst.status, 201);
			assert.ok(createFirst.body.id);

			const projectId = createFirst.body.id;
			const terminate = await requestJson<null>(`${base}/api/projects/${projectId}/terminate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			assert.equal(terminate.status, 204);

			const listedAfterTerminate = await requestJson<Array<{ id: string }>>(`${base}/api/projects`);
			assert.equal(listedAfterTerminate.status, 200);
			assert.equal(Array.isArray(listedAfterTerminate.body), true);
			assert.equal(listedAfterTerminate.body.length, 0);

			const createSecond = await requestJson<{ id: string }>(`${base}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "第二部",
					prompt: "测试2",
					target_total_words: 120000,
					genre: "奇幻",
					theme: "命运",
					style: "克制",
					taboos: "无",
				}),
			});
			assert.equal(createSecond.status, 201);
			assert.ok(createSecond.body.id);
		} finally {
			if (server) {
				await new Promise<void>((resolve, reject) => {
					server?.close((error?: Error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				});
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});
