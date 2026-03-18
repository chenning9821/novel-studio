import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildChapterContextPackV1,
	parseChapterPayloadV1Lenient,
	parseChapterPayloadV1Strict,
	validateChapterPayloadV1,
	validateFineOutlinePayloadV1Schema,
} from "../src/core/generation-protocol.js";

describe("generation protocol", () => {
	it("parses strict chapter json payload", () => {
		const raw = JSON.stringify({
			chapterRef: "V1-C1",
			title: "入城",
			summary: "主角初入都城并接下第一份委托。",
			content: "夜色像潮水一样漫进城门，林寂把风衣扣到最上面一粒扣子。街灯下的人群散成两股，他没有停步，只在转角处抬眼看了看高楼玻璃上的倒影。那道陌生目光一闪而过，像一枚钉子钉进了今晚的空气。",
			continuity_checks: ["时间线连续"],
			seed_hooks: ["神秘跟踪者"],
			forbidden_hit: [],
		});

		const parsed = parseChapterPayloadV1Strict(raw);
		assert.ok(parsed);
		assert.equal(parsed?.chapterRef, "V1-C1");
	});

	it("rejects chapter content with outline scaffolding", () => {
		const payload = {
			chapterRef: "V1-C2",
			title: "冲突升级",
			summary: "主角察觉敌人布局并反制。",
			content: "## 开篇钩子\n他走进大厅，灯光刺眼。\n### （一）机场刺杀\n枪声骤然响起。",
			continuity_checks: [],
			seed_hooks: [],
			forbidden_hit: [],
		};
		const result = validateChapterPayloadV1(payload, "V1-C2");
		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.ok(["chapter_content_structured_scaffold", "chapter_content_invalid"].includes(result.reason));
	});

	it("rejects noisy fine outline fields", () => {
		const payload = {
			volumeTitle: "第一卷",
			volumeSlug: "vol-1",
			segments: [
				{
					startChapter: 1,
					endChapter: 5,
					goal: '{"',
					conflict: "对手突然加码施压",
					turn: "关键盟友临场倒戈",
					hook: "一封旧信揭示更大阴谋",
					points: ["推进", "反转"],
				},
			],
		};
		const result = validateFineOutlinePayloadV1Schema(payload as never);
		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.equal(result.reason, "fine_segment_field_invalid");
	});

	it("packs chapter context with per-bucket stats", () => {
		const pack = buildChapterContextPackV1({
			planText: "P".repeat(12000),
			volumeGoalsText: "G".repeat(12000),
			recentChaptersText: "R".repeat(12000),
			memoryDigestText: "M".repeat(12000),
			rulesAndTaboosText: "T".repeat(2000),
			totalBudgetChars: 8000,
		});
		assert.equal(pack.stats.mode, "chapter_budgeted");
		assert.ok(pack.stats.totalBeforeChars > pack.stats.totalAfterChars);
		assert.equal(pack.stats.buckets.length, 5);
		assert.ok(pack.stats.buckets.some((item) => item.truncated));
	});

	it("extracts chapter payload from mixed wrapper text", () => {
		const raw = [
			"一些说明文字",
			"```json",
			JSON.stringify({
				chapterRef: "V2-C3",
				title: "夜雨",
				summary: "雨夜里达成脆弱同盟。",
				content: "雨水从伞骨一路滑进袖口，他却没有伸手去抖。街角那家茶馆只开了一盏灯，窗上的雾气把两个人的影子贴在一起，又很快分开。",
				continuity_checks: [],
				seed_hooks: ["借条"],
				forbidden_hit: [],
			}),
			"```",
		].join("\n");
		const parsed = parseChapterPayloadV1Lenient(raw);
		assert.ok(parsed);
		assert.equal(parsed?.chapterRef, "V2-C3");
	});
});


