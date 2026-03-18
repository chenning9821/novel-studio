import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compileStructuredFineVolume,
	defaultFineOutlineControlPolicy,
	parseStructuredFineVolume,
	parseStructuredFineVolumeLenient,
	repairStructuredFineVolumeDeterministic,
} from "../src/core/fine-outline-control.js";

describe("fine outline structured control", () => {
	it("compiles valid structured volume with full coverage", () => {
		const policy = defaultFineOutlineControlPolicy();
		const parsed = {
			volumeTitle: "Volume 1",
			volumeSlug: "volume-1",
			segments: [
				{
					startChapter: 1,
					endChapter: 5,
					goal: "enter conflict",
					conflict: "new enemy appears",
					turn: "hero loses first duel",
					hook: "urgent escape",
					points: ["setup", "pressure", "reversal"],
				},
				{
					startChapter: 6,
					endChapter: 10,
					goal: "counterattack",
					conflict: "enemy reinforcement",
					turn: "ally betrayal",
					hook: "battle at dawn",
					points: ["plan", "risk", "payoff"],
				},
			],
		};

		const result = compileStructuredFineVolume(parsed, {
			volumeNo: 1,
			chaptersPerVolume: 10,
			policy,
		});

		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.equal(result.chapterGoals.length, 10);
		assert.equal(result.coverage, 1);
		assert.match(result.outlineMarkdown, /## Chapter Goals/);
	});

	it("rejects coverage gaps and overlaps", () => {
		const policy = defaultFineOutlineControlPolicy();
		const parsed = {
			volumeTitle: "Volume 2",
			volumeSlug: "volume-2",
			segments: [
				{
					startChapter: 1,
					endChapter: 4,
					goal: "first arc goal",
					conflict: "first arc conflict",
					turn: "first arc turn",
					hook: "first arc hook",
					points: ["p1"],
				},
				{
					startChapter: 4,
					endChapter: 6,
					goal: "second arc goal",
					conflict: "second arc conflict",
					turn: "second arc turn",
					hook: "second arc hook",
					points: ["p2"],
				},
			],
		};

		const result = compileStructuredFineVolume(parsed, {
			volumeNo: 2,
			chaptersPerVolume: 8,
			policy,
		});
		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.equal(result.reason, "coverage_invalid");
	});

	it("trims overlong fields to policy caps", () => {
		const policy = {
			...defaultFineOutlineControlPolicy(),
			maxCharsPerPoint: 10,
			maxPointsPerSegment: 2,
		};
		const parsed = {
			volumeTitle: "Volume 3",
			volumeSlug: "volume-3",
			segments: [
				{
					startChapter: 1,
					endChapter: 2,
					goal: "very very long goal",
					conflict: "very very long conflict",
					turn: "very very long turn",
					hook: "very very long hook",
					points: ["point-1-long", "point-2-long", "point-3-long"],
				},
			],
		};
		const result = compileStructuredFineVolume(parsed, {
			volumeNo: 3,
			chaptersPerVolume: 2,
			policy,
		});
		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.ok(result.trimCount > 0);
		assert.ok(result.warnings.length > 0);
	});

	it("parses fenced json response", () => {
		const raw = [
			"```json",
			"{",
			'  "volumeTitle": "Volume 1",',
			'  "volumeSlug": "volume-1",',
			'  "segments": [',
			"    {",
			'      "startChapter": 1,',
			'      "endChapter": 2,',
			'      "goal": "g",',
			'      "conflict": "c",',
			'      "turn": "t",',
			'      "hook": "h",',
			'      "points": ["p1"]',
			"    }",
			"  ]",
			"}",
			"```",
		].join("\n");
		const parsed = parseStructuredFineVolume(raw);
		assert.ok(parsed);
		assert.equal(parsed?.segments.length, 1);
	});

	it("lenient parser extracts markdown range blocks", () => {
		const raw = [
			"# 第一卷：试炼之城",
			"",
			"### 第1-5章",
			"- 目标: 主角进入学院并建立盟友",
			"- 冲突: 老牌社团阻截资源",
			"- 转折: 导师突然失踪",
			"- 钩子: 密库地图出现残缺页",
			"",
			"### 第6-10章",
			"- 目标: 找回导师并解读残页",
			"- 冲突: 城防军与地下组织双线追捕",
			"- 转折: 盟友身份暴露",
			"- 钩子: 地图指向禁区核心",
		].join("\n");
		const parsed = parseStructuredFineVolumeLenient(raw, {
			chaptersPerVolume: 10,
			segmentSize: 5,
		});
		assert.ok(parsed);
		assert.equal(parsed?.segments.length, 2);
		assert.equal(parsed?.segments[0]?.startChapter, 1);
		assert.equal(parsed?.segments[0]?.endChapter, 5);
	});

	it("deterministic repair normalizes broken segments to full coverage", () => {
		const policy = defaultFineOutlineControlPolicy();
		const parsed = {
			volumeTitle: "Volume X",
			volumeSlug: "",
			segments: [
				{
					startChapter: 3,
					endChapter: 3,
					goal: "",
					conflict: "conflict seed",
					turn: "",
					hook: "",
					points: ["single point"],
				},
			],
		};
		const repaired = repairStructuredFineVolumeDeterministic(parsed, {
			chaptersPerVolume: 10,
			policy,
		});
		assert.ok(repaired);
		const compiled = compileStructuredFineVolume(repaired, {
			volumeNo: 1,
			chaptersPerVolume: 10,
			policy,
		});
		assert.equal(compiled.ok, true);
		if (!compiled.ok) {
			return;
		}
		assert.equal(compiled.chapterGoals.length, 10);
		assert.equal(compiled.coverage, 1);
	});
});
