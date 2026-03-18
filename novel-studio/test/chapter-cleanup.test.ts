import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeGeneratedChapter } from "../src/core/chapter-cleanup.js";

describe("chapter cleanup", () => {
	it("removes scaffold headings and list-like section labels", () => {
		const raw = [
			"## 开篇钩子",
			"### （一）机场刺杀",
			"夜色压在跑道尽头，枪火像被风扯碎的光带。",
			"## 主线推进",
			"### （二）苏氏大厦",
			"他在电梯镜面里看到自己，像一枚迟到的子弹。",
		].join("\n");
		const result = sanitizeGeneratedChapter(raw);
		assert.equal(result.removedStructuralLines >= 4, true);
		assert.match(result.content, /夜色压在跑道尽头/);
		assert.match(result.content, /他在电梯镜面里看到自己/);
		assert.doesNotMatch(result.content, /开篇钩子|主线推进|机场刺杀|苏氏大厦/);
	});

	it("keeps normal narrative paragraphs", () => {
		const raw = [
			"雨下了一整夜，街灯把潮湿的空气切成薄片。",
			"她没有回头，只是把围巾往上提了一寸。",
		].join("\n\n");
		const result = sanitizeGeneratedChapter(raw);
		assert.equal(result.removedStructuralLines, 0);
		assert.equal(result.content, raw);
	});
});
