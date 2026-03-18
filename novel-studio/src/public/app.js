const modelForm = document.querySelector("#model-form");
const projectForm = document.querySelector("#project-form");
const projectMeta = document.querySelector("#project-meta");
const planSections = document.querySelector("#plan-sections");
const fineOutlineList = document.querySelector("#fine-outline-list");
const decisionList = document.querySelector("#decision-list");
const decisionHint = document.querySelector("#decision-hint");
const applyDecisionsButton = document.querySelector("#apply-decisions");
const generateDecisionsButton = document.querySelector("#generate-decisions");
const regenerateDecisionsButton = document.querySelector("#regenerate-decisions");
const regeneratePlanButton = document.querySelector("#regenerate-plan");
const confirmPlanButton = document.querySelector("#confirm-plan");
const planRegenerateGuidanceInput = document.querySelector("#plan-regenerate-guidance");
const eventLog = document.querySelector("#event-log");
const refreshProjectsButton = document.querySelector("#refresh-projects");
const resetToSetupButton = document.querySelector("#reset-to-setup");
const detailPanel = document.querySelector("#project-detail");
const statusBadge = document.querySelector("#project-status-badge");
const singleProjectHint = document.querySelector("#single-project-hint");
const clearLogButton = document.querySelector("#clear-log");
const workflowStepper = document.querySelector("#workflow-stepper");

const stageSetupView = document.querySelector("#stage-setup-view");
const stageDecisionsView = document.querySelector("#stage-decisions-view");
const stagePlanView = document.querySelector("#stage-plan-view");
const stageGeneratingView = document.querySelector("#stage-generating-view");
const stageFinishedView = document.querySelector("#stage-finished-view");

const openCreateDialogButton = document.querySelector("#open-create-dialog");
const openCreateInlineButton = document.querySelector("#open-create-dialog-inline");
const closeCreateDialogButton = document.querySelector("#close-create-dialog");
const cancelCreateDialogButton = document.querySelector("#cancel-create-dialog");
const createModal = document.querySelector("#create-modal");

const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const closeSettingsMask = document.querySelector("#close-settings-mask");
const settingsDrawer = document.querySelector("#settings-drawer");

const finishedTerminateButton = document.querySelector("#finished-terminate");
const clearLiveButton = document.querySelector("#clear-live");
const liveCurrentTitle = document.querySelector("#live-current-title");
const liveCurrentStream = document.querySelector("#live-current-stream");
const liveLatestTitle = document.querySelector("#live-latest-title");
const liveLatestContent = document.querySelector("#live-latest-content");

let selectedProjectId = "";
let eventSource = null;
let eventSeq = 0;
let hasProject = false;
let currentProject = null;
let currentPipeline = null;
let currentDecisionManifest = null;
let currentWorkflowStage = "setup";
let refreshTimer = null;
let currentStreamingChapterRef = "";
let currentStreamingText = "";
let latestChapter = null;

const STATUS_LABELS = {
	idle: "空闲",
	plan_ready: "Plan已确认",
	coarse_generating: "粗纲生成",
	coarse_ready: "粗纲完成",
	fine_generating: "细纲生成",
	fine_ready: "细纲完成",
	chapters_generating: "正文生成",
	reviewing: "审查中",
	completed: "已完成",
	paused_ratio_failed: "暂停（比例失败）",
	paused_review_failed: "暂停（审查失败）",
	paused_stopped: "已暂停",
	terminated: "已终止",
	error: "错误",
};

function setProjectFormDefaults() {
	projectForm.genre.value = projectForm.genre.value || "仙侠";
	projectForm.theme.value = projectForm.theme.value || "成长与代价";
	projectForm.style.value = projectForm.style.value || "克制、具象、留白";
	projectForm.taboos.value = projectForm.taboos.value || "避免系统文口吻";
	projectForm.language.value = projectForm.language.value || "中文";
	projectForm.target_total_words.value = projectForm.target_total_words.value || "300000";
	projectForm.volumeCount.value = projectForm.volumeCount.value || "3";
	projectForm.chaptersPerVolume.value = projectForm.chaptersPerVolume.value || "20";
}

async function request(path, options = {}) {
	const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const payload = await response.json();
			if (payload.error) message = payload.error;
		} catch {}
		throw new Error(message);
	}
	if (response.status === 204) return null;
	return response.json();
}

function formToObject(form) {
	const out = {};
	for (const [k, v] of new FormData(form).entries()) out[k] = v;
	return out;
}

function summarizeData(data) {
	if (data == null) return "";
	if (typeof data === "string") return data.slice(0, 240);
	if (typeof data !== "object") return String(data).slice(0, 240);
	const keys = ["kind", "callId", "attempt", "maxAttempts", "delayMs", "elapsedMs", "responseChars", "workflowStage", "operation", "protocol", "protocolVersion", "phase", "chapterRef", "volumeNo", "chapterNo", "status", "stage", "action", "error", "retryable", "version", "completed", "segmentCount", "coverage", "trimCount", "failedAttempts", "reason", "parseStage", "repairUsed", "responsePreview", "mode", "totalBeforeChars", "totalAfterChars"];
	const parts = [];
	for (const key of keys) if (data[key] !== undefined && data[key] !== null && data[key] !== "") parts.push(`${key}=${String(data[key])}`);
	if (Array.isArray(data.buckets)) {
		const bucketSummary = data.buckets
			.slice(0, 6)
			.map((bucket) => `${bucket.source}:${bucket.afterChars}/${bucket.beforeChars}${bucket.truncated ? "T" : ""}`)
			.join(" | ");
		if (bucketSummary) parts.push(`buckets=${bucketSummary}`);
	}
	if (parts.length) return parts.join(" ").slice(0, 360);
	try { return JSON.stringify(data).slice(0, 360); } catch { return ""; }
}

function appendLog(type, text, data = null) {
	const row = document.createElement("div");
	row.className = `log-row ${String(type || "info").replace(/[^a-z_]/gi, "")}`;
	const time = document.createElement("span");
	time.className = "time";
	time.textContent = new Date().toLocaleTimeString();
	const msg = document.createElement("span");
	msg.textContent = `${type}: ${text}`;
	row.append(time, msg);
	const detail = summarizeData(data);
	if (detail) {
		const d = document.createElement("span");
		d.className = "log-detail";
		d.textContent = detail;
		row.appendChild(d);
	}
	eventLog.appendChild(row);
	eventLog.scrollTop = eventLog.scrollHeight;
	while (eventLog.children.length > 1200) eventLog.removeChild(eventLog.firstElementChild);
}

function withButtonLoading(button, task) {
	const t = button.textContent;
	button.disabled = true;
	button.textContent = "处理中...";
	return task().finally(() => { button.disabled = false; button.textContent = t; });
}

function closeEventSource() {
	if (eventSource) { eventSource.close(); eventSource = null; }
}

function showStage(stage) {
	const mapping = { setup: stageSetupView, decisions: stageDecisionsView, plan_review: stagePlanView, generating: stageGeneratingView, finished: stageFinishedView };
	Object.values(mapping).forEach((n) => n && n.classList.add("hidden"));
	(mapping[stage] || stageSetupView)?.classList.remove("hidden");
}

function renderWorkflowStepper(stage) {
	workflowStepper.querySelectorAll(".step").forEach((s) => s.classList.toggle("active", s.dataset.stage === stage));
}

function applyStatusBadge(status) {
	statusBadge.textContent = STATUS_LABELS[status] || status || "-";
	statusBadge.classList.remove("running", "paused", "error", "reviewing");
	if (["coarse_generating", "fine_generating", "chapters_generating"].includes(status)) statusBadge.classList.add("running");
	if (["paused_stopped", "paused_ratio_failed", "paused_review_failed", "terminated"].includes(status)) statusBadge.classList.add("paused");
	if (status === "reviewing") statusBadge.classList.add("reviewing");
	if (status === "error") statusBadge.classList.add("error");
}

function hasPlanContent(project) {
	const sections = project?.planManifest?.sections || [];
	return sections.some((s) => String(s.content || "").trim().length > 0);
}

function formatCoverageText(volumeCoverage) {
	const entries = Object.entries(volumeCoverage || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
	if (!entries.length) return "-";
	return entries.map(([v, c]) => `V${v}:${Math.round(Number(c) * 100)}%`).join(" | ");
}

function renderProjectMeta(project, pipeline) {
	const fine = pipeline?.fineControlState || {};
	const warnings = Array.isArray(fine.warnings) ? fine.warnings.slice(-3).join("; ") : "";
	const items = [
		["标题", project.title],
		["阶段", STATUS_LABELS[pipeline.status] || pipeline.status],
		["全局章节", String(pipeline.globalChapterNo || 0)],
		["细纲卷游标", `第 ${pipeline.fineVolumeCursor || 1} 卷`],
		["全文目标字数", String(project.wordBudget.targetTotalWords)],
		["细纲目标字数(仅展示)", String(project.wordBudget.fineTargetWords)],
		["卷/章配置", `${project.preferences.volumeCount} 卷 · 每卷 ${project.preferences.chaptersPerVolume} 章`],
		["细纲覆盖率", formatCoverageText(fine.volumeCoverage)],
		["细纲段数", String(fine.totalSegments || 0)],
		["结构压缩次数", String(fine.trimCount || 0)],
		["细纲失败尝试", String(fine.failedAttempts || 0)],
		["结构告警", warnings || "-"],
	];
	projectMeta.innerHTML = items.map(([k, v]) => `<div class="meta-item"><b>${k}</b>${v}</div>`).join("");
}

function renderEmptyState() {
	hasProject = false;
	selectedProjectId = "";
	currentProject = null;
	currentPipeline = null;
	currentDecisionManifest = null;
	currentWorkflowStage = "setup";
	eventSeq = 0;
	closeEventSource();
	projectMeta.innerHTML = '<div class="meta-item"><b>状态</b>暂无项目</div>';
	planSections.innerHTML = "";
	decisionList.innerHTML = "";
	fineOutlineList.innerHTML = "";
	singleProjectHint.textContent = "单项目模式：当前没有项目，请先创建小说。";
	applyStatusBadge("idle");
	renderWorkflowStepper("setup");
	showStage("setup");
	decisionHint.textContent = "先创建项目，再生成决策题。";
	openCreateDialogButton.disabled = false;
	openCreateDialogButton.textContent = "新建小说";
	if (resetToSetupButton) resetToSetupButton.disabled = true;
	currentStreamingChapterRef = "";
	currentStreamingText = "";
	latestChapter = null;
	renderLivePanel();
}

function renderDecisionManifest(manifest) {
	currentDecisionManifest = manifest || null;
	decisionList.innerHTML = "";
	if (!manifest?.decisions?.length) {
		decisionHint.textContent = "点击“生成决策题”开始。";
		applyDecisionsButton.disabled = true;
		return;
	}
	decisionHint.textContent = manifest.completed ? "决策已完成，可进入 Plan 审阅。" : "每题已默认预选推荐项，可直接应用继续。";
	for (const d of manifest.decisions) {
		const card = document.createElement("article");
		card.className = "decision-item";
		card.dataset.decisionId = d.id;
		card.innerHTML = `<h4>${d.title}${d.required ? " *" : ""}</h4><p>${d.description || ""}</p>`;
		const list = document.createElement("div");
		list.className = "option-list";
		const selected = new Set(d.selectedOptionIds || []);
		for (const option of d.options || []) {
			const row = document.createElement("div");
			row.className = "option-row";
			row.innerHTML = `<input class="option-input" type="${d.multiple ? "checkbox" : "radio"}" name="decision-${d.id}" value="${option.id}" ${selected.has(option.id) ? "checked" : ""} /><div><label>${option.label}${option.recommended ? '<span class="recommended-tag">推荐</span>' : ""}</label><small>${option.description || ""}</small></div>`;
			list.appendChild(row);
		}
		const other = document.createElement("div");
		other.className = "other-input-wrap";
		other.style.display = selected.has("__other__") ? "block" : "none";
		other.innerHTML = `<input type="text" data-other-for="${d.id}" placeholder="填写自定义选项" value="${d.otherText || ""}"/>`;
		card.append(list, other);
		card.addEventListener("change", () => {
			const checked = Array.from(card.querySelectorAll("input.option-input:checked")).map((el) => el.value);
			other.style.display = checked.includes("__other__") ? "block" : "none";
		});
		decisionList.appendChild(card);
	}
	applyDecisionsButton.disabled = false;
}

function collectDecisionSelections() {
	const selections = {};
	const otherTextByDecision = {};
	decisionList.querySelectorAll(".decision-item").forEach((card) => {
		const id = card.dataset.decisionId;
		selections[id] = Array.from(card.querySelectorAll("input.option-input:checked")).map((el) => el.value);
		const other = card.querySelector("input[data-other-for]");
		if (other) otherTextByDecision[id] = other.value.trim();
	});
	return { selections, otherTextByDecision };
}

function validateDecisionOther(payload) {
	for (const d of currentDecisionManifest?.decisions || []) {
		if (!(payload.selections[d.id] || []).includes("__other__")) continue;
		if (!(payload.otherTextByDecision[d.id] || "").trim()) return `决策“${d.title}”选择了“其他”但未填写内容。`;
	}
	return null;
}
function renderPlanSections(project) {
	planSections.innerHTML = "";
	for (const section of project?.planManifest?.sections || []) {
		const card = document.createElement("article");
		card.className = "section-card";
		card.innerHTML = `<h3>${section.title} (${section.id})</h3>`;
		const textarea = document.createElement("textarea");
		textarea.value = section.content || "";
		textarea.rows = 14;
		textarea.dataset.planSection = section.id;
		card.appendChild(textarea);
		planSections.appendChild(card);
	}
}

async function saveCurrentPlanEdits() {
	if (!selectedProjectId || !currentProject?.planManifest?.sections?.length) return;
	const contentById = new Map();
	planSections.querySelectorAll("textarea[data-plan-section]").forEach((t) => contentById.set(t.dataset.planSection, t.value));
	const updates = [];
	for (const section of currentProject.planManifest.sections) {
		const local = contentById.get(section.id);
		if (typeof local !== "string") continue;
		if (String(section.content || "") === local) continue;
		updates.push(request(`/api/projects/${selectedProjectId}/plan/sections/${section.id}`, { method: "PATCH", body: JSON.stringify({ content: local }) }));
	}
	if (!updates.length) return;
	appendLog("info", `Saving ${updates.length} plan edits...`);
	await Promise.all(updates);
}

function buildReadonlyCard(title, content) {
	const card = document.createElement("article");
	card.className = "section-card";
	card.innerHTML = `<h3>${title}</h3>`;
	const text = document.createElement("textarea");
	text.readOnly = true;
	text.className = "plan-readonly";
	text.value = content || "";
	card.appendChild(text);
	return card;
}

async function refreshFineOutlines() {
	if (!selectedProjectId) { fineOutlineList.innerHTML = ""; return; }
	const payload = await request(`/api/projects/${selectedProjectId}/fine-outlines`);
	const outlines = payload?.outlines || [];
	fineOutlineList.innerHTML = "";
	if (currentProject && hasPlanContent(currentProject)) {
		const master = currentProject.planManifest.sections[0];
		if (master) fineOutlineList.appendChild(buildReadonlyCard("Confirmed Plan (Coarse Source)", master.content || ""));
	}
	if (currentPipeline?.fineControlState) {
		const s = currentPipeline.fineControlState;
		fineOutlineList.appendChild(
			buildReadonlyCard(
				"Fine Control State",
				[
					`currentVolume: ${s.currentVolume || 1}`,
					`coverage: ${formatCoverageText(s.volumeCoverage)}`,
					`totalSegments: ${s.totalSegments || 0}`,
					`trimCount: ${s.trimCount || 0}`,
					`failedAttempts: ${s.failedAttempts || 0}`,
					`warnings: ${(s.warnings || []).join("; ") || "-"}`,
				].join("\n"),
			),
		);
	}
	if (!outlines.length) {
		fineOutlineList.appendChild(buildReadonlyCard("Fine Outlines", "No fine outline files yet."));
		return;
	}
	for (const item of outlines) {
		const title = item.path?.split(/[\\/]/).pop() || "outline";
		fineOutlineList.appendChild(buildReadonlyCard(title, item.content || ""));
	}
}

function renderLivePanel() {
	if (liveCurrentTitle) liveCurrentTitle.textContent = currentStreamingChapterRef ? `当前流式章节：${currentStreamingChapterRef}` : "当前流式章节";
	if (liveCurrentStream) liveCurrentStream.textContent = currentStreamingText || "等待章节生成...";
	if (liveLatestTitle) liveLatestTitle.textContent = latestChapter?.chapterRef ? `最近完成章节：${latestChapter.chapterRef}` : "最近完成章节";
	if (liveLatestContent) liveLatestContent.value = latestChapter?.content || "暂无已完成章节";
}

function handleChapterStreamEvent(payload) {
	const data = payload?.data || {};
	const phase = data.phase;
	const chapterRef = data.chapterRef || "";
	if (phase === "start") {
		currentStreamingChapterRef = chapterRef;
		currentStreamingText = "";
		renderLivePanel();
		appendLog("info", payload.message || "Chapter stream started", data);
		return;
	}
	if (phase === "delta") {
		if (chapterRef && chapterRef !== currentStreamingChapterRef) {
			currentStreamingChapterRef = chapterRef;
			currentStreamingText = "";
		}
		currentStreamingText += data.delta || "";
		renderLivePanel();
		return;
	}
	if (phase === "end") {
		currentStreamingChapterRef = chapterRef || currentStreamingChapterRef;
		currentStreamingText = typeof data.content === "string" && data.content.length > 0 ? data.content : currentStreamingText;
		latestChapter = { chapterRef: currentStreamingChapterRef, title: currentStreamingChapterRef, path: data.chapterPath || "", content: currentStreamingText };
		renderLivePanel();
		appendLog("chapter_generated", payload.message || "Chapter stream finished", data);
		return;
	}
	if (phase === "error") appendLog("error", payload.message || "Chapter stream failed", data);
}

async function refreshLatestChapter() {
	if (!selectedProjectId) return;
	const payload = await request(`/api/projects/${selectedProjectId}/chapters/latest`);
	latestChapter = payload?.chapter || null;
	renderLivePanel();
}

function updateStageActions() {
	if (generateDecisionsButton) generateDecisionsButton.disabled = !selectedProjectId;
	if (regenerateDecisionsButton) regenerateDecisionsButton.disabled = !selectedProjectId;
	if (applyDecisionsButton) applyDecisionsButton.disabled = !selectedProjectId || !currentDecisionManifest?.decisions?.length;
	if (regeneratePlanButton) regeneratePlanButton.disabled = !selectedProjectId || !currentDecisionManifest?.completed;
	if (confirmPlanButton) confirmPlanButton.disabled = !selectedProjectId || !currentDecisionManifest?.completed || !hasPlanContent(currentProject);
}

async function refreshCurrentProject() {
	if (!selectedProjectId) { renderEmptyState(); return; }
	const payload = await request(`/api/projects/${selectedProjectId}`);
	currentProject = payload.project;
	currentPipeline = payload.pipeline;
	currentDecisionManifest = payload.decisionManifest;
	currentWorkflowStage = payload.workflowStage || "decisions";
	renderProjectMeta(payload.project, payload.pipeline);
	renderDecisionManifest(payload.decisionManifest);
	renderPlanSections(payload.project);
	renderWorkflowStepper(currentWorkflowStage);
	showStage(currentWorkflowStage);
	applyStatusBadge(payload.pipeline?.status || "idle");
	updateStageActions();
	await Promise.all([refreshLatestChapter(), refreshFineOutlines()]);
	hasProject = true;
	singleProjectHint.textContent = `单项目模式：当前小说为《${payload.project.title}》。`;
	openCreateDialogButton.disabled = true;
	openCreateDialogButton.textContent = "单项目模式";
	if (resetToSetupButton) resetToSetupButton.disabled = false;
}

function scheduleProjectRefresh() {
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		refreshCurrentProject().catch((error) => appendLog("error", `Refresh failed: ${error.message}`));
	}, 300);
}

function appendSseEvent(payload) {
	if (payload.type === "chapter_stream") return handleChapterStreamEvent(payload);
	appendLog(payload.type, payload.message, payload.data || null);
}

function connectEvents(projectId) {
	closeEventSource();
	eventSource = new EventSource(`/api/projects/${projectId}/events?fromSeq=${eventSeq}`);
	const types = ["info", "warning", "error", "stage_change", "progress", "fine_control", "json_parse", "context_pack", "plan_section_updated", "review_report", "chapter_generated", "chapter_stream", "llm_call"];
	const handler = (event) => {
		let payload;
		try { payload = JSON.parse(event.data); } catch { appendLog("warning", "Received unparseable SSE payload"); return; }
		if (typeof payload.seq === "number" && payload.seq <= eventSeq) return;
		if (typeof payload.seq === "number") eventSeq = payload.seq;
		appendSseEvent(payload);
		if (payload.type === "progress" && payload.data && Object.prototype.hasOwnProperty.call(payload.data, "volumeNo")) refreshFineOutlines().catch(() => {});
		if (payload.type === "fine_control" && ["compiled", "coverage_passed", "completed", "retry_current_volume"].includes(payload?.data?.kind)) scheduleProjectRefresh();
		if (["stage_change", "chapter_generated", "review_report", "plan_section_updated"].includes(payload.type)) scheduleProjectRefresh();
	};
	eventSource.onmessage = handler;
	for (const t of types) eventSource.addEventListener(t, handler);
	eventSource.onerror = () => appendLog("warning", "SSE disconnected, trying to reconnect...");
}
async function loadProjects() {
	const projects = await request("/api/projects");
	if (!projects.length) { renderEmptyState(); return; }
	const project = projects[0];
	const changed = selectedProjectId !== project.id;
	selectedProjectId = project.id;
	hasProject = true;
	if (changed) { eventSeq = 0; connectEvents(project.id); }
	await refreshCurrentProject();
}

async function loadModelProfile() {
	const profile = await request("/api/settings/model-profile");
	modelForm.api.value = profile.api;
	modelForm.provider.value = profile.provider;
	modelForm.modelId.value = profile.modelId;
	modelForm.baseUrl.value = profile.baseUrl;
	modelForm.apiKey.value = profile.apiKey;
	modelForm.temperature.value = profile.temperature;
	modelForm.topP.value = profile.topP;
	modelForm.maxTokens.value = profile.maxTokens;
	modelForm.thinking.value = profile.thinking;
	modelForm.rpmLimit.value = profile.rpmLimit;
	modelForm.retryMaxRetries.value = profile.retry.maxRetries;
	modelForm.retryBaseDelayMs.value = profile.retry.baseDelayMs;
	modelForm.retryMaxDelayMs.value = profile.retry.maxDelayMs;
}

async function saveModelProfile(event) {
	event.preventDefault();
	const maxTokensInput = Number(modelForm.maxTokens.value);
	const payload = {
		api: modelForm.api.value,
		provider: modelForm.provider.value,
		modelId: modelForm.modelId.value,
		baseUrl: modelForm.baseUrl.value,
		apiKey: modelForm.apiKey.value,
		temperature: Number(modelForm.temperature.value),
		topP: Number(modelForm.topP.value),
		maxTokens: Number.isFinite(maxTokensInput) ? maxTokensInput : 0,
		thinking: modelForm.thinking.value,
		rpmLimit: Number(modelForm.rpmLimit.value),
		retry: {
			maxRetries: Number(modelForm.retryMaxRetries.value),
			baseDelayMs: Number(modelForm.retryBaseDelayMs.value),
			maxDelayMs: Number(modelForm.retryMaxDelayMs.value),
		},
	};
	await request("/api/settings/model-profile", { method: "PUT", body: JSON.stringify(payload) });
	appendLog("info", "Model profile saved");
	closeSettingsDrawer();
}

async function createProject(event) {
	event.preventDefault();
	if (hasProject) { appendLog("warning", "Single-project mode already has active project"); closeCreateModal(); return; }
	const raw = formToObject(projectForm);
	const payload = {
		title: String(raw.title || "").trim(),
		prompt: String(raw.prompt || "").trim(),
		target_total_words: Number(raw.target_total_words),
		genre: String(raw.genre || ""),
		theme: String(raw.theme || ""),
		style: String(raw.style || ""),
		taboos: String(raw.taboos || ""),
		language: String(raw.language || "中文"),
		volumeCount: Number(raw.volumeCount),
		chaptersPerVolume: Number(raw.chaptersPerVolume),
	};
	const project = await request("/api/projects", { method: "POST", body: JSON.stringify(payload) });
	appendLog("info", `Project created: ${project.title}`);
	closeCreateModal();
	projectForm.reset();
	setProjectFormDefaults();
	await loadProjects();
}

async function generateDecisions() {
	if (!selectedProjectId) return appendLog("warning", "Create a project first");
	appendLog("info", "Requesting decision generation...");
	await request(`/api/projects/${selectedProjectId}/plan/decisions/generate`, { method: "POST", body: "{}" });
	appendLog("info", "Decision generation triggered");
	await refreshCurrentProject();
}

async function applyDecisionSelections() {
	if (!selectedProjectId || !currentDecisionManifest) return;
	const payload = collectDecisionSelections();
	const validationError = validateDecisionOther(payload);
	if (validationError) return appendLog("warning", validationError);
	appendLog("info", "Submitting decisions and auto-generating initial Plan...");
	const response = await request(`/api/projects/${selectedProjectId}/plan/decisions`, { method: "PATCH", body: JSON.stringify(payload) });
	if (response?.autoPlan?.status === "failed") appendLog("warning", `Auto initial Plan failed: ${response.autoPlan.error || "unknown"}`, response.autoPlan);
	if (response?.autoPlan?.status === "success") appendLog("info", "Initial Plan generated automatically", response.autoPlan);
	await refreshCurrentProject();
}

async function regeneratePlan() {
	if (!selectedProjectId) return;
	const hasPlan = hasPlanContent(currentProject);
	if (hasPlan) await saveCurrentPlanEdits();
	const endpoint = hasPlan ? "regenerate" : "generate";
	const guidance = (planRegenerateGuidanceInput?.value || "").trim();
	appendLog("info", hasPlan ? "Regenerating Plan package..." : "Generating initial Plan...");
	const response = await request(`/api/projects/${selectedProjectId}/plan/${endpoint}`, { method: "POST", body: hasPlan ? JSON.stringify({ guidance }) : "{}" });
	if (response?.autoPlan?.status === "failed") appendLog("warning", `Plan generation failed: ${response.autoPlan.error || "unknown"}`, response.autoPlan);
	if (planRegenerateGuidanceInput) planRegenerateGuidanceInput.value = "";
	await refreshCurrentProject();
}

async function confirmPlanAndStart() {
	if (!selectedProjectId) return;
	await saveCurrentPlanEdits();
	appendLog("info", "Confirming Plan...");
	await request(`/api/projects/${selectedProjectId}/plan/confirm`, { method: "POST", body: "{}" });
	appendLog("info", "Plan confirmed. Starting generation...");
	await request(`/api/projects/${selectedProjectId}/resume`, { method: "POST", body: "{}" });
	await refreshCurrentProject();
}

async function projectAction(action) {
	if (!selectedProjectId) return appendLog("warning", "No project selected");
	if (action === "stop") { await request(`/api/projects/${selectedProjectId}/stop`, { method: "POST", body: "{}" }); appendLog("info", "Action: stop"); return refreshCurrentProject(); }
	if (action === "resume") { await request(`/api/projects/${selectedProjectId}/resume`, { method: "POST", body: "{}" }); appendLog("info", "Action: resume"); return refreshCurrentProject(); }
	if (action === "terminate") { await request(`/api/projects/${selectedProjectId}/terminate`, { method: "POST", body: "{}" }); appendLog("info", "Action: terminate"); return loadProjects(); }
}

async function resetToSetup() {
	if (!selectedProjectId) { renderEmptyState(); return appendLog("info", "Returned to setup"); }
	if (!window.confirm("This will terminate current project and return to setup. Continue?")) return;
	await request(`/api/projects/${selectedProjectId}/terminate`, { method: "POST", body: "{}" });
	appendLog("info", "Project terminated and returned to setup");
	await loadProjects();
}

function openCreateModal() {
	if (hasProject) return appendLog("warning", "Single-project mode already has a project. Terminate first.");
	createModal.classList.remove("hidden");
}
function closeCreateModal() { createModal.classList.add("hidden"); }
function openSettingsDrawer() { settingsDrawer.classList.remove("hidden"); settingsDrawer.setAttribute("aria-hidden", "false"); }
function closeSettingsDrawer() { settingsDrawer.classList.add("hidden"); settingsDrawer.setAttribute("aria-hidden", "true"); }

modelForm.addEventListener("submit", (event) => saveModelProfile(event).catch((e) => appendLog("error", `Save model profile failed: ${e.message}`)));
projectForm.addEventListener("submit", (event) => createProject(event).catch((e) => appendLog("error", `Create project failed: ${e.message}`)));
generateDecisionsButton.addEventListener("click", () => withButtonLoading(generateDecisionsButton, () => generateDecisions()).catch((e) => appendLog("error", `Generate decisions failed: ${e.message}`)));
regenerateDecisionsButton.addEventListener("click", () => withButtonLoading(regenerateDecisionsButton, () => generateDecisions()).catch((e) => appendLog("error", `Regenerate decisions failed: ${e.message}`)));
applyDecisionsButton.addEventListener("click", () => applyDecisionSelections().catch((e) => appendLog("error", `Apply decisions failed: ${e.message}`)));
if (regeneratePlanButton) regeneratePlanButton.addEventListener("click", () => withButtonLoading(regeneratePlanButton, () => regeneratePlan()).catch((e) => appendLog("error", `Regenerate Plan failed: ${e.message}`)));
if (confirmPlanButton) confirmPlanButton.addEventListener("click", () => withButtonLoading(confirmPlanButton, () => confirmPlanAndStart()).catch((e) => appendLog("error", `Confirm Plan failed: ${e.message}`)));
finishedTerminateButton.addEventListener("click", () => projectAction("terminate").catch((e) => appendLog("error", `Terminate failed: ${e.message}`)));
if (resetToSetupButton) resetToSetupButton.addEventListener("click", () => resetToSetup().catch((e) => appendLog("error", `Reset failed: ${e.message}`)));
refreshProjectsButton.addEventListener("click", () => loadProjects().catch((e) => appendLog("error", `Load projects failed: ${e.message}`)));
openCreateDialogButton.addEventListener("click", openCreateModal);
openCreateInlineButton.addEventListener("click", openCreateModal);
closeCreateDialogButton.addEventListener("click", closeCreateModal);
cancelCreateDialogButton.addEventListener("click", closeCreateModal);
createModal.addEventListener("click", (event) => { if (event.target === createModal) closeCreateModal(); });
openSettingsButton.addEventListener("click", openSettingsDrawer);
closeSettingsButton.addEventListener("click", closeSettingsDrawer);
closeSettingsMask.addEventListener("click", closeSettingsDrawer);
clearLogButton.addEventListener("click", () => { eventLog.innerHTML = ""; });
if (clearLiveButton) clearLiveButton.addEventListener("click", () => { currentStreamingChapterRef = ""; currentStreamingText = ""; latestChapter = null; renderLivePanel(); appendLog("info", "Live panel cleared"); });

detailPanel.querySelectorAll("button[data-action]").forEach((button) => {
	button.addEventListener("click", () => projectAction(button.dataset.action).catch((e) => appendLog("error", `Action failed: ${e.message}`)));
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	closeCreateModal();
	closeSettingsDrawer();
});

setProjectFormDefaults();
renderEmptyState();
renderLivePanel();
Promise.all([loadModelProfile(), loadProjects()]).catch((error) => appendLog("error", `Initialization failed: ${error.message}`));


