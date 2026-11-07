import { mkdir, readFile, readdir, writeFile, writeAtomic } from "@toonflow/file";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import conf from "@/utils/conf";

// ACT: 群聊 Agent 的工作区与会话解析器。每个 Matrix 房间绑定一个服务器侧独立工作区
// （workspaces/chat-agent/<sanitizedRoomId>），房间内的 Agent 会话文件持久化在该工作区的
// .agent/sessions 下，使同一房间的所有成员共享同一份上下文与产物。

// 把 roomId 归一化成安全的目录名（Matrix roomId 含 ! : 等非法字符），口径与 trigger.ts 一致。
export function sanitizeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "room";
}

// 服务器工作区根目录（与 resolveWorkspace 的口径一致：<dataDir>/workspaces）。
function workspacesRoot(): string {
  return resolve(dirname(conf.path), "workspaces");
}

// 房间 Agent 的工作区目录（不创建）。
export function roomAgentCwd(roomId: string): string {
  return resolve(workspacesRoot(), "chat-agent", sanitizeRoomId(roomId));
}

// 确保房间 Agent 工作区存在并返回其绝对路径。
export async function ensureRoomAgentCwd(roomId: string): Promise<string> {
  const cwd = roomAgentCwd(roomId);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

// chat-agent 工作区根目录（所有房间工作区的父目录）。
export function chatAgentRoot(): string {
  return resolve(workspacesRoot(), "chat-agent");
}

// 判断某个已解析的工作区目录是否属于「房间 Agent 工作区」（chat-agent/<roomId> 或其子目录）。
// 用于把编排器私有状态文件（workflow.json/grants.json）从 Studio 文件树中隐藏。
export function isRoomAgentWorkspace(directory: string): boolean {
  if (!directory) return false;
  const rel = relative(chatAgentRoot(), directory);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ACT: 房间的「已提交工作流图」。服务器侧 pi-coding Agent 是唯一权威写入者：
// 用户画布上的改动先作为本地提案，只有 Agent 同意后才提交到这里，再广播给所有 spoke。
// 图以画布 JSON 形式落盘，revision 内嵌在根对象里，写入时做乐观并发校验。
export const WORKFLOW_FILE = "workflow.json";

// 编排器（服务器侧 customer_service Agent）的私有状态文件：与用户画布同处房间工作区根目录，
// 但不属于用户可见/可编辑的产物，需从文件树中排除（画布枚举天然排除：它们没有 toonflowCanvas 标记）。
export const ORCHESTRATOR_STATE_FILES = new Set([WORKFLOW_FILE, "grants.json"]);

// 单画布 1:1:1 绑定（Task 6）：确保房间工作区里至少存在一个画布文件。
// 房间根目录除编排器状态文件外没有任何 .json 时，播种一个空白且格式有效的画布（画布N.json）。
// 用独占创建（flag "wx"）避免覆盖并发播种或用户已有内容；返回房间工作区绝对路径。
export async function ensureRoomCanvas(roomId: string): Promise<string> {
  const cwd = await ensureRoomAgentCwd(roomId);
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  const hasCanvas = entries.some(entry => entry.isFile() && /\.json$/i.test(entry.name) && !ORCHESTRATOR_STATE_FILES.has(entry.name));
  if (hasCanvas) return cwd;
  const canvas = `${JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, null, 2)}\n`;
  for (let number = 1; ; number++) {
    try {
      await writeFile(join(cwd, `画布${number}.json`), canvas, { flag: "wx" });
      return cwd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export type RoomWorkflow = { revision: number; graph: Record<string, unknown> };

// 已提交工作流图的绝对路径（不创建目录）。
export function roomWorkflowPath(roomId: string): string {
  return join(roomAgentCwd(roomId), WORKFLOW_FILE);
}

// 读取已提交的工作流图；不存在或损坏时返回 null（调用方据此回退到空图）。
export async function readRoomWorkflow(roomId: string): Promise<RoomWorkflow | null> {
  let text: string;
  try {
    text = Buffer.from(await readFile(roomWorkflowPath(roomId))).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const graph = JSON.parse(text) as Record<string, unknown>;
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
    const revision = typeof graph.revision === "number" && Number.isFinite(graph.revision) ? graph.revision : 0;
    return { revision, graph };
  } catch {
    return null;
  }
}

// 提交新的工作流图，返回提交后的 revision。传入 expectedRevision 时做乐观并发校验，
// 与当前已提交版本不一致则抛 409，避免覆盖 Agent 或其他设备刚提交的改动。
export async function writeRoomWorkflow(roomId: string, graph: Record<string, unknown>, expectedRevision?: number): Promise<number> {
  const cwd = await ensureRoomAgentCwd(roomId);
  const baseRevision = (await readRoomWorkflow(roomId))?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== baseRevision) {
    throw Object.assign(new Error("工作流已被更新，请先同步到最新版本再提交"), { status: 409, code: "EREVISION" });
  }
  const revision = baseRevision + 1;
  await writeAtomic(join(cwd, WORKFLOW_FILE), JSON.stringify({ ...graph, revision }, null, 2));
  return revision;
}
