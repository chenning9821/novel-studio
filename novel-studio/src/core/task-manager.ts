import { FileStore } from "./storage.js";
import { formatLlmTelemetryMessage, LlmGateway } from "./llm.js";
import { MemoryManager } from "./memory.js";
import { ReviewAgent } from "./review-agent.js";
import { PipelineRunner, type RunnerEventEmitter } from "./pipeline.js";
import type { ProjectEvent } from "./types.js";

export type EventBroadcaster = (projectId: string, event: ProjectEvent) => void;

export class TaskManager {
	private readonly store: FileStore;
	private readonly broadcaster: EventBroadcaster;
	private readonly runners = new Map<string, PipelineRunner>();

	constructor(store: FileStore, broadcaster: EventBroadcaster) {
		this.store = store;
		this.broadcaster = broadcaster;
	}

	async bootstrap(): Promise<void> {
		const projects = await this.store.listProjects();
		for (const project of projects) {
			const state = await this.store.loadPipelineState(project.id);
			if (!state.isRunning) {
				continue;
			}
			await this.start(project.id);
		}
	}

	private async prepareStateForRun(projectId: string): Promise<void> {
		const state = await this.store.loadPipelineState(projectId);
		state.stopRequested = false;
		state.isRunning = false;

		if (state.terminated) {
			state.terminated = false;
		}

		const recoverableStatuses = new Set([
			"terminated",
			"paused_stopped",
			"error",
			"paused_ratio_failed",
			"paused_review_failed",
		]);

		if (recoverableStatuses.has(state.status)) {
			state.status = state.globalChapterNo > 0 ? "chapters_generating" : "plan_ready";
		}

		await this.store.savePipelineState(state);
	}

	async start(projectId: string): Promise<void> {
		if (this.runners.has(projectId)) {
			return;
		}
		await this.prepareStateForRun(projectId);
		const runner = await this.createRunner(projectId);
		this.runners.set(projectId, runner);
		void runner.run().finally(() => {
			this.runners.delete(projectId);
		});
	}

	async resume(projectId: string): Promise<void> {
		await this.prepareStateForRun(projectId);
		await this.start(projectId);
	}

	async stop(projectId: string): Promise<void> {
		const runner = this.runners.get(projectId);
		if (runner) {
			await runner.requestStop();
			return;
		}
		const state = await this.store.loadPipelineState(projectId);
		state.stopRequested = true;
		state.isRunning = false;
		state.status = "paused_stopped";
		await this.store.savePipelineState(state);
	}

	async terminate(projectId: string): Promise<void> {
		const runner = this.runners.get(projectId);
		if (runner) {
			await runner.requestTerminate();
			return;
		}
		const state = await this.store.loadPipelineState(projectId);
		state.terminated = true;
		state.stopRequested = true;
		state.isRunning = false;
		state.status = "terminated";
		await this.store.savePipelineState(state);
	}

	private async createRunner(projectId: string): Promise<PipelineRunner> {
		const profile = await this.store.getModelProfile();
		const llm = new LlmGateway(profile, async (telemetry) => {
			const event = await this.store.appendEvent(projectId, {
				type: "llm_call",
				message: formatLlmTelemetryMessage(telemetry),
				data: telemetry as unknown as Record<string, unknown>,
			});
			this.broadcaster(projectId, event);
		});
		const memoryManager = new MemoryManager(this.store, llm);
		const reviewAgent = new ReviewAgent(this.store, memoryManager, async (telemetry) => {
			const event = await this.store.appendEvent(projectId, {
				type: "llm_call",
				message: formatLlmTelemetryMessage(telemetry),
				data: telemetry as unknown as Record<string, unknown>,
			});
			this.broadcaster(projectId, event);
		});

		const emitter: RunnerEventEmitter = async (targetProjectId, type, message, data) => {
			const event = await this.store.appendEvent(targetProjectId, {
				type,
				message,
				data,
			});
			this.broadcaster(targetProjectId, event);
		};

		return new PipelineRunner(projectId, this.store, llm, memoryManager, reviewAgent, emitter);
	}
}
