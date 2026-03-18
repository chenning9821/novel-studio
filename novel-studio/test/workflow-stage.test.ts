import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveWorkflowStage } from "../src/core/workflow.js";
import type { NovelProject, PipelineState, PlanDecisionManifest } from "../src/core/types.js";
import { defaultFineOutlineControlPolicy, createInitialFineControlState } from "../src/core/fine-outline-control.js";

function baseProject(): NovelProject {
	return {
		id: "p1",
		title: "t",
		slug: "t",
		createdAt: "",
		updatedAt: "",
		wordBudget: {
			targetTotalWords: 100000,
			fineTargetWords: 1000,
			coarseTargetWords: 10,
			tolerance: 0.15,
			enforceHardGate: true,
			maxRatioFailures: 3,
		},
		fineOutlineControl: defaultFineOutlineControlPolicy(),
		preferences: {
			prompt: "",
			genre: "",
			theme: "",
			style: "",
			taboos: "",
			language: "中文",
			volumeCount: 1,
			chaptersPerVolume: 1,
		},
		planManifest: {
			version: 1,
			confirmed: false,
			sections: [],
		},
	};
}

function basePipeline(): PipelineState {
	return {
		projectId: "p1",
		status: "idle",
		isRunning: false,
		stopRequested: false,
		terminated: false,
		currentVolume: 1,
		currentChapterInVolume: 1,
		globalChapterNo: 0,
		fineVolumeCursor: 1,
		ratioFailures: { coarse: 0, fine: 0 },
		reviewCycleCount: 0,
		fineControlState: createInitialFineControlState(),
		lastEventSeq: 0,
		updatedAt: "",
	};
}

function baseDecisions(): PlanDecisionManifest {
	return {
		version: 1,
		completed: false,
		decisions: [],
	};
}

describe("workflow stage derivation", () => {
	it("returns decisions for unconfirmed flow", () => {
		const stage = deriveWorkflowStage(baseProject(), basePipeline(), baseDecisions());
		assert.equal(stage, "decisions");
	});

	it("returns plan_review after decisions completed", () => {
		const decisions = baseDecisions();
		decisions.completed = true;
		const stage = deriveWorkflowStage(baseProject(), basePipeline(), decisions);
		assert.equal(stage, "plan_review");
	});

	it("stays in plan_review when pipeline is plan_ready but plan is not confirmed", () => {
		const project = baseProject();
		const pipeline = basePipeline();
		pipeline.status = "plan_ready";
		const decisions = baseDecisions();
		decisions.completed = true;
		const stage = deriveWorkflowStage(project, pipeline, decisions);
		assert.equal(stage, "plan_review");
	});

	it("returns generating after plan confirmed", () => {
		const project = baseProject();
		project.planManifest.confirmed = true;
		const decisions = baseDecisions();
		decisions.completed = true;
		const stage = deriveWorkflowStage(project, basePipeline(), decisions);
		assert.equal(stage, "generating");
	});

	it("returns finished for completed pipeline", () => {
		const pipeline = basePipeline();
		pipeline.status = "completed";
		const stage = deriveWorkflowStage(baseProject(), pipeline, baseDecisions());
		assert.equal(stage, "finished");
	});

	it("returns setup for terminated pipeline", () => {
		const pipeline = basePipeline();
		pipeline.status = "terminated";
		pipeline.terminated = true;
		const stage = deriveWorkflowStage(baseProject(), pipeline, baseDecisions());
		assert.equal(stage, "setup");
	});
});
