# Novel Studio

向导式长篇小说生成工作台（单机单用户，纯文件系统存储）。

- 单 Node 服务 + Web UI
- 全流程线性向导：创建项目 -> 决策选择 -> Plan 审阅 -> 生成阶段
- SSE 实时日志（进度、LLM 调用、JSON 解析、上下文打包、章节流）

## 主要能力

- `Plan = 粗纲`：确认后的 Plan 直接作为粗纲来源
- 细纲串行逐卷生成（结构化 JSON 协议 + 本地校验/修复）
- 章节串行生成（JSON 包裹正文 + 内容门禁）
- 每 5 章触发 agentic 审查（只给建议，不直接改写）
- 记忆系统：事实 / 角色状态 / 时间线 / 世界规则 / 伏笔账本
- 失败语义统一：重试耗尽后任务进入 `error`（服务不退出）

## 快速启动

### 方式 1：一键启动（Windows）

双击：

`start-novel-studio.bat`

### 方式 2：命令行

```bash
npm install
npm run dev
```

默认访问地址：

`http://127.0.0.1:4310`

## 环境变量

- `NOVEL_STUDIO_PORT`：服务端口（默认 `4310`）
- `NOVEL_STUDIO_DATA_DIR`：数据目录（默认 `./data`）

## 使用流程

1. 在「新建小说」大对话框中填写 prompt、目标字数、卷章参数与约束
2. 生成决策题（每题可选“其他”并填写）
3. 自动生成首版 Plan，支持手工补充后“重新生成”
4. 确认 Plan 后进入生成阶段（暂停 / 恢复 / 终止）
5. 在日志与实时章节面板观察生成进度

## 模型配置

在页面右上角「设置」中填写：

- `modelId`
- `baseUrl`
- `apiKey`
- 采样与重试参数

说明：

- 配置会保存到本地数据目录（不会提交到仓库，见 `.gitignore`）
- 默认支持 OpenAI 兼容接口（包括 NVIDIA integrate endpoint）

## 数据目录结构

`data/projects/<projectId>/novel/` 下主要目录：

- `01-plan/`
- `02-outline/`
- `03-outline-fine/`
- `10-volumes/`
- `90-memory/`
- `95-review/`

## 实时日志类型

- `llm_call`：调用开始/重试/成功/失败
- `json_parse`：JSON 解析链路状态
- `context_pack`：上下文打包与裁剪统计
- `fine_control`：细纲卷控制事件
- `chapter_stream`：章节实时流

## 常见问题

### 1) Plan 已确认后立刻报 `EPERM rename ...pipeline-state.json.tmp`

这通常是 Windows 文件锁冲突（并发写或文件占用）。

已在代码中加入：

- pipeline state 串行写队列
- 原子写 rename 的重试退避

若仍出现：

1. 确认只启动了一个服务实例
2. 关闭后重新运行 `start-novel-studio.bat`
3. 避免将项目目录放在高频同步/扫描路径

### 2) 为什么重启后还停在上个项目

系统会持久化项目状态到 `data` 目录。可在界面中「终止任务并返回开始」后新建项目。

## 开发与测试

```bash
npm run check
npm run build
npm test
```
