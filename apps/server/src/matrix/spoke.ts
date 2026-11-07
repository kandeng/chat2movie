import type { Response } from "express";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { hasGrant } from "./grants";

type CanvasCallEvent = Extract<AgentEvent, { type: "canvasCall" }>;

// ACT: 每个辐条（一台设备上的一个工作室标签页）上报的「设备能力」。Task 9 先建立通道与注册表骨架，
// localModel（防火墙内 OpenAI 兼容模型可达性）等具体能力在 Task 12/13 接入；结构保持可扩展。
export interface SpokeCapabilities {
  // 设备是否可直连本地/防火墙内模型（Task 12 探测后上报）。
  // ACT: 计划 Task 13 —— 仅当用户已授权 invokeLocalModels 时，浏览器才上报 true；未授权即视为不具备该能力，
  // 编排器因此看不到、也不会把本地模型任务调度到未授权的设备（能力注册按设备、授权按用户）。
  localModel?: boolean;
  // Matrix 设备 id，便于把能力/授权绑定到具体设备（Task 13）。
  deviceId?: string;
  // 允许后续能力字段扩展而不破坏调用方。
  [key: string]: unknown;
}

interface Spoke {
  id: string;
  // ACT: 计划 Task 13 —— 辐条所属的 Matrix 用户（mxid）。授权按用户记账，故驱动前需用它查该用户的 grant。
  userId?: string;
  response: Response;
  canvas: CanvasInfo | null;
  capabilities: SpokeCapabilities;
  // 画布上下文最近一次更新时间戳：在多个带画布的辐条里选定编排器驱动的「主画布辐条」。
  canvasUpdatedAt: number;
}

// ACT: Stage 2「每房间多辐条注册表」（计划 Task 9）。把 Stage 1 的单辐条泛化为
// roomId -> (spokeId -> Spoke)：同一用户在手机/平板/电脑各连一个辐条并存、互不顶替；
// 同一设备重连（刷新页面）用相同 spokeId 顶替自己那条旧连接。
// customer_service 的画布调用发给「主画布辐条」，已提交的图变更（Task 10）广播给房间内所有辐条。
const rooms = new Map<string, Map<string, Spoke>>();

function write(response: Response, event: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function alive(spoke: Spoke): boolean {
  return !spoke.response.destroyed && !spoke.response.writableEnded;
}

function roomMap(roomId: string): Map<string, Spoke> {
  let map = rooms.get(roomId);
  if (!map) { map = new Map(); rooms.set(roomId, map); }
  return map;
}

// 建立/接管一个辐条的 SSE 连接；同 (roomId, spokeId) 的旧连接会被顶替（发 replaced 后关闭）。
export function connectSpoke(roomId: string, spokeId: string, response: Response, capabilities: SpokeCapabilities = {}, userId?: string): void {
  const map = roomMap(roomId);
  const previous = map.get(spokeId);
  if (previous && previous.response !== response) {
    write(previous.response, { type: "replaced" });
    previous.response.end();
  }
  // 保留旧连接（同设备刷新前）已上报的画布、能力与身份，避免顶替瞬间丢失上下文。
  const spoke: Spoke = {
    id: spokeId,
    userId: userId || previous?.userId,
    response,
    capabilities: { ...capabilities, ...previous?.capabilities },
    canvas: previous?.canvas ?? null,
    canvasUpdatedAt: previous?.canvasUpdatedAt ?? 0,
  };
  map.set(spokeId, spoke);
  response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  response.flushHeaders();
  write(response, { type: "ready" });
  const heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(": keepalive\n\n"); }, 20000);
  const socket = response.socket;
  const close = () => {
    clearInterval(heartbeat);
    response.off("close", close);
    socket?.off("close", close);
    if (map.get(spokeId) === spoke) {
      map.delete(spokeId);
      if (!map.size) rooms.delete(roomId);
    }
  };
  response.once("close", close);
  socket?.once("close", close);
}

// 辐条上报/更新设备能力（例如 Task 12 探测到本地模型可达后）。
export function updateSpokeCapabilities(roomId: string, spokeId: string, capabilities: SpokeCapabilities): void {
  const spoke = rooms.get(roomId)?.get(spokeId);
  if (spoke && alive(spoke)) spoke.capabilities = { ...spoke.capabilities, ...capabilities };
}

// ACT: 计划 Task 13 —— 辐条上报所属 Matrix 用户（mxid），把这条连接绑定到一个用户，供授权门控使用。
export function updateSpokeUser(roomId: string, spokeId: string, userId: string): void {
  const spoke = rooms.get(roomId)?.get(spokeId);
  if (spoke && alive(spoke) && userId) spoke.userId = userId;
}

// 某个辐条上报当前画布上下文；canvas 为 null 表示当前没有可用画布。
export function updateSpokeCanvas(roomId: string, spokeId: string, canvas: CanvasInfo | null): void {
  const spoke = rooms.get(roomId)?.get(spokeId);
  if (!spoke || !alive(spoke)) return;
  spoke.canvas = canvas;
  spoke.canvasUpdatedAt = Date.now();
}

// 房间内是否还有活跃辐条。
export function hasSpoke(roomId: string): boolean {
  const map = rooms.get(roomId);
  if (!map) return false;
  for (const spoke of map.values()) if (alive(spoke)) return true;
  return false;
}

// 选定编排器驱动的「主画布辐条」：在有画布的活跃辐条里取最近上报者。
// ACT: 计划 Task 13 —— 仅在已授权 driveSpokes 的用户设备里选择：未授权（或身份未知）的辐条不可被编排器驱动，
// 落实「授权后 hub 才能驱动用户辐条」的默认拒绝策略。
function primaryCanvasSpoke(roomId: string): Spoke | undefined {
  const map = rooms.get(roomId);
  if (!map) return undefined;
  let best: Spoke | undefined;
  for (const spoke of map.values()) {
    if (!alive(spoke) || !spoke.canvas) continue;
    if (!hasGrant(roomId, spoke.userId, "driveSpokes")) continue;
    if (!best || spoke.canvasUpdatedAt > best.canvasUpdatedAt) best = spoke;
  }
  return best;
}

// 编排器读取主画布辐条的画布上下文，用于构建 run() 的 canvas 桥。
export function getSpokeCanvas(roomId: string): CanvasInfo | null {
  return primaryCanvasSpoke(roomId)?.canvas ?? null;
}

// 把一条画布调用推给主画布辐条；无可用辐条时返回 false（编排器据此判定画布不可用）。
export function sendSpokeCanvasCall(roomId: string, event: CanvasCallEvent): boolean {
  const spoke = primaryCanvasSpoke(roomId);
  if (!spoke) return false;
  write(spoke.response, event);
  return true;
}

// 计划 Task 10：把已提交的图变更广播给房间内所有活跃辐条，各端收敛式应用到实时画布；返回送达数量。
export function broadcastSpoke(roomId: string, event: unknown): number {
  const map = rooms.get(roomId);
  if (!map) return 0;
  let sent = 0;
  for (const spoke of map.values()) if (alive(spoke)) { write(spoke.response, event); sent++; }
  return sent;
}

// 计划 Task 12/13：列出房间内的活跃辐条及其设备能力与所属用户，供授权与本地模型调度使用。
export function listRoomSpokes(roomId: string): { id: string; userId?: string; hasCanvas: boolean; capabilities: SpokeCapabilities }[] {
  const map = rooms.get(roomId);
  if (!map) return [];
  return [...map.values()].filter(spoke => alive(spoke)).map(spoke => ({ id: spoke.id, userId: spoke.userId, hasCanvas: !!spoke.canvas, capabilities: spoke.capabilities }));
}
