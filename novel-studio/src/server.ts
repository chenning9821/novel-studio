import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { formatLlmTelemetryMessage, LlmGateway } from "./core/llm.js";
import { PlanService } from "./core/plan-service.js";
import { SseHub } from "./core/sse-hub.js";
import { FileStore } from "./core/storage.js";
import { TaskManager } from "./core/task-manager.js";
import type {
	CreateProjectInput,
	ModelProfile,
	RegeneratePlanInput,
	RegeneratePlanSectionInput,
	UpdateDecisionSelectionInput,
	UpdatePlanSectionInput,
} from "./core/types.js";
import { deriveWorkflowStage } from "./core/workflow.js";

interface ServerOptions {
	port: number;
	dataDir: string;
	publicDir: string;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

function noContent(res: ServerResponse): void {
	res.statusCode = 204;
	res.end();
}

async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) {
		return {} as T;
	}
	return JSON.parse(raw) as T;
}

function parseProjectRoute(pathname: string): { projectId: string; rest: string[] } | null {
	const parts = pathname.split("/").filter((part) => part.length > 0);
	if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "projects") {
		return null;
	}
	return {
		projectId: parts[2],
		rest: parts.slice(3),
	};
}

function getContentType(path: string): string {
	const ext = extname(path).toLowerCase();
	switch (ext) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

async function serveStatic(publicDir: string, pathname: string, res: ServerResponse): Promise<void> {
	const normalizedPath = pathname === "/" ? "/index.html" : pathname;
	const absolutePath = join(publicDir, normalizedPath);
	try {
		await access(absolutePath);
		res.statusCode = 200;
		res.setHeader("content-type", getContentType(absolutePath));
		res.setHeader("cache-control", "no-store, max-age=0, must-revalidate");
		res.setHeader("pragma", "no-cache");
		res.setHeader("expires", "0");
		createReadStream(absolutePath).pipe(res);
	} catch {
		const fallback = join(publicDir, "index.html");
		try {
			const html = await readFile(fallback, "utf8");
			res.statusCode = 200;
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.setHeader("cache-control", "no-store, max-age=0, must-revalidate");
			res.setHeader("pragma", "no-cache");
			res.setHeader("expires", "0");
			res.end(html);
		} catch {
			json(res, 404, { error: "Not found" });
		}
	}
}

export async function startNovelStudioServer(options: ServerOptions): Promise<Server> {
	const store = new FileStore(options.dataDir);
	await store.init();
	const sseHub = new SseHub();
	const taskManager = new TaskManager(store, (projectId, event) => {
		sseHub.broadcast(projectId, event);
	});
	await taskManager.bootstrap();

	const listVisibleProjects = async () => {
		const projects = await store.listProjects();
		const visible = [];
		for (const project of projects) {
			const state = await store.loadPipelineState(project.id);
			if (state.status !== "terminated" && state.terminated !== true) {
				visible.push(project);
			}
		}
		return visible;
	};

	const appendAndBroadcast = async (
		projectId: string,
		event: {
			type:
				| "info"
				| "warning"
				| "error"
				| "stage_change"
				| "progress"
				| "fine_control"
				| "json_parse"
				| "context_pack"
				| "plan_section_updated"
				| "review_report"
				| "chapter_generated"
				| "chapter_stream"
				| "llm_call";
			message: string;
			data?: Record<string, unknown>;
		},
	) => {
		const appended = await store.appendEvent(projectId, event);
		sseHub.broadcast(projectId, appended);
	};

	const buildLlm = (projectId: string, profile: ModelProfile): LlmGateway => {
		return new LlmGateway(profile, async (telemetry) => {
			await appendAndBroadcast(projectId, {
				type: "llm_call",
				message: formatLlmTelemetryMessage(telemetry),
				data: telemetry as unknown as Record<string, unknown>,
			});
		});
	};

	const server = createServer(async (req, res) => {
		try {
			if (!req.url || !req.method) {
				json(res, 400, { error: "Invalid request" });
				return;
			}

			const parsedUrl = new URL(req.url, "http://127.0.0.1");
			const pathname = parsedUrl.pathname;

			if (pathname.startsWith("/api/")) {
				if (pathname === "/api/settings/model-profile") {
					if (req.method === "GET") {
						const profile = await store.getModelProfile();
						json(res, 200, profile);
						return;
					}
					if (req.method === "PUT") {
						const payload = await parseJsonBody<ModelProfile>(req);
						const saved = await store.saveModelProfile(payload);
						json(res, 200, saved);
						return;
					}
				}

				if (pathname === "/api/projects") {
					if (req.method === "GET") {
						const projects = await listVisibleProjects();
						json(res, 200, projects);
						return;
					}
					if (req.method === "POST") {
						const existing = await listVisibleProjects();
						if (existing.length > 0) {
							json(res, 409, {
								error: "Single-project mode: finish or terminate the current project before creating another one.",
							});
							return;
						}
						const payload = await parseJsonBody<CreateProjectInput>(req);
						const project = await store.createProject(payload);
						json(res, 201, project);
						return;
					}
				}

				const parsedProjectRoute = parseProjectRoute(pathname);
				if (parsedProjectRoute) {
					const { projectId, rest } = parsedProjectRoute;

					if (rest.length === 0 && req.method === "GET") {
						const project = await store.loadProject(projectId);
						const pipeline = await store.loadPipelineState(projectId);
						const fineMeta = await store.readFineMeta(projectId);
						const decisionManifest = await store.loadDecisionManifest(projectId);
						const workflowStage = deriveWorkflowStage(project, pipeline, decisionManifest);
						json(res, 200, {
							project,
							pipeline,
							fineMeta,
							decisionManifest,
							fineControlState: pipeline.fineControlState,
							workflowStage,
						});
						return;
					}

					if (rest.length === 1 && rest[0] === "files" && req.method === "GET") {
						const files = await store.readProjectFileTree(projectId);
						json(res, 200, { files });
						return;
					}

					if (rest.length === 1 && rest[0] === "fine-outlines" && req.method === "GET") {
						const outlines = await store.readAllFineOutlines(projectId);
						const fineMeta = await store.readFineMeta(projectId);
						json(res, 200, { outlines, fineMeta });
						return;
					}

					if (rest.length === 2 && rest[0] === "chapters" && rest[1] === "latest" && req.method === "GET") {
						const latest = await store.readLatestChapter(projectId);
						json(res, 200, { chapter: latest });
						return;
					}

					if (rest.length === 1 && rest[0] === "start" && req.method === "POST") {
						await taskManager.start(projectId);
						noContent(res);
						return;
					}

					if (rest.length === 1 && rest[0] === "stop" && req.method === "POST") {
						await taskManager.stop(projectId);
						noContent(res);
						return;
					}

					if (rest.length === 1 && rest[0] === "terminate" && req.method === "POST") {
						await taskManager.terminate(projectId);
						noContent(res);
						return;
					}

					if (rest.length === 1 && rest[0] === "resume" && req.method === "POST") {
						await taskManager.resume(projectId);
						noContent(res);
						return;
					}

					if (rest.length === 3 && rest[0] === "plan" && rest[1] === "decisions" && rest[2] === "generate" && req.method === "POST") {
						const profile = await store.getModelProfile();
						const llm = buildLlm(projectId, profile);
						const planService = new PlanService(store, llm);
						const decisionManifest = await planService.generateDecisionManifest(projectId);
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: "Decision candidates generated",
							data: { decisionsVersion: decisionManifest.version },
						});
						json(res, 200, decisionManifest);
						return;
					}

					if (rest.length === 2 && rest[0] === "plan" && rest[1] === "decisions" && req.method === "PATCH") {
						const payload = await parseJsonBody<UpdateDecisionSelectionInput>(req);
						const profile = await store.getModelProfile();
						const llm = buildLlm(projectId, profile);
						const planService = new PlanService(store, llm);
						const decisionManifest = await planService.applyDecisionSelections(
							projectId,
							payload.selections || {},
							payload.otherTextByDecision || {},
						);
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: "Decision selections updated",
							data: { completed: decisionManifest.completed, decisionsVersion: decisionManifest.version },
						});
						if (!decisionManifest.completed) {
							json(res, 200, {
								decisionManifest,
								planManifest: null,
								autoPlan: { status: "skipped", retryable: false },
							});
							return;
						}

						await appendAndBroadcast(projectId, {
							type: "info",
							message: "Decisions completed, auto-generating initial Plan",
							data: { stage: "plan_review", action: "auto_plan_generate" },
						});
						try {
							const planManifest = await planService.generateFullPlan(projectId);
							await appendAndBroadcast(projectId, {
								type: "plan_section_updated",
								message: "Initial Plan generated automatically",
								data: { version: planManifest.version },
							});
							json(res, 200, {
								decisionManifest,
								planManifest,
								autoPlan: { status: "success", retryable: false },
							});
							return;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							await appendAndBroadcast(projectId, {
								type: "error",
								message: `Auto initial Plan failed: ${message}`,
								data: { stage: "plan_review", action: "auto_plan_generate", retryable: true },
							});
							json(res, 200, {
								decisionManifest,
								planManifest: null,
								autoPlan: { status: "failed", error: message, retryable: true },
							});
							return;
						}
					}

					if (rest.length === 2 && rest[0] === "plan" && rest[1] === "generate" && req.method === "POST") {
						const profile = await store.getModelProfile();
						const llm = buildLlm(projectId, profile);
						const planService = new PlanService(store, llm);
						await appendAndBroadcast(projectId, {
							type: "info",
							message: "Initial Plan generation requested",
							data: { stage: "plan_review", action: "generate_initial_plan" },
						});
						try {
							const planManifest = await planService.generateFullPlan(projectId);
							await appendAndBroadcast(projectId, {
								type: "plan_section_updated",
								message: "Plan generated from decisions",
								data: { version: planManifest.version },
							});
							json(res, 200, {
								planManifest,
								autoPlan: { status: "success", retryable: false },
							});
							return;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							await appendAndBroadcast(projectId, {
								type: "error",
								message: `Initial Plan generation failed: ${message}`,
								data: { stage: "plan_review", action: "generate_initial_plan", retryable: true },
							});
							json(res, 200, {
								planManifest: null,
								autoPlan: { status: "failed", error: message, retryable: true },
							});
							return;
						}
					}

					if (rest.length === 2 && rest[0] === "plan" && rest[1] === "regenerate" && req.method === "POST") {
						const payload = await parseJsonBody<RegeneratePlanInput>(req);
						const profile = await store.getModelProfile();
						const llm = buildLlm(projectId, profile);
						const planService = new PlanService(store, llm);
						const manifest = await planService.regenerateFullPlan(projectId, payload);
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: "Plan regenerated from revision guidance",
							data: { version: manifest.version },
						});
						json(res, 200, manifest);
						return;
					}

					if (rest.length === 2 && rest[0] === "plan" && rest[1] === "confirm" && req.method === "POST") {
						const manifest = await store.confirmPlan(projectId);
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: "Plan confirmed",
							data: { version: manifest.version, confirmed: true },
						});
						json(res, 200, manifest);
						return;
					}

					if (rest.length === 4 && rest[0] === "plan" && rest[1] === "sections" && rest[3] === "regenerate" && req.method === "POST") {
						const profile = await store.getModelProfile();
						const llm = buildLlm(projectId, profile);
						const planService = new PlanService(store, llm);
						const payload = await parseJsonBody<RegeneratePlanSectionInput>(req);
						const manifest = await planService.regenerateSection(projectId, rest[2], payload.guidance || "");
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: `Plan section ${rest[2]} regenerated`,
							data: { sectionId: rest[2], version: manifest.version },
						});
						json(res, 200, manifest);
						return;
					}

					if (rest.length === 3 && rest[0] === "plan" && rest[1] === "sections" && req.method === "PATCH") {
						const payload = await parseJsonBody<UpdatePlanSectionInput>(req);
						const manifest = await store.updatePlanSection(projectId, rest[2], payload);
						await appendAndBroadcast(projectId, {
							type: "plan_section_updated",
							message: `Plan section ${rest[2]} updated`,
							data: { sectionId: rest[2], version: manifest.version },
						});
						json(res, 200, manifest);
						return;
					}

					if (rest.length === 1 && rest[0] === "events" && req.method === "GET") {
						const fromSeq = Number.parseInt(parsedUrl.searchParams.get("fromSeq") || "0", 10) || 0;
						res.statusCode = 200;
						res.setHeader("content-type", "text/event-stream; charset=utf-8");
						res.setHeader("cache-control", "no-cache");
						res.setHeader("connection", "keep-alive");
						res.write("retry: 1000\n\n");
						const history = await store.readEvents(projectId, fromSeq);
						for (const event of history) {
							res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
						}
						sseHub.subscribe(projectId, res);
						req.on("close", () => {
							sseHub.unsubscribe(projectId, res);
						});
						return;
					}
				}

				json(res, 404, { error: "Unknown API route" });
				return;
			}

			await serveStatic(options.publicDir, pathname, res);
		} catch (error) {
			json(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	await new Promise<void>((resolve) => {
		server.listen(options.port, "127.0.0.1", () => {
			resolve();
		});
	});

	return server;
}

