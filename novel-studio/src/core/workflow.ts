import type { NovelProject, PipelineState, PlanDecisionManifest, WorkflowStage } from "./types.js";

export function deriveWorkflowStage(project: NovelProject, pipeline: PipelineState, decisions: PlanDecisionManifest): WorkflowStage {
	if (pipeline.terminated || pipeline.status === "terminated") {
		return "setup";
	}

	if (pipeline.status === "completed") {
		return "finished";
	}

	// Keep users in plan review until plan is explicitly confirmed.
	if (!project.planManifest.confirmed) {
		if (decisions.completed) {
			return "plan_review";
		}
		return "decisions";
	}

	return "generating";
}
