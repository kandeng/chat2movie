import { readFile, writeAtomic } from "@toonflow/file";
import { join } from "node:path";
import { ensureRoomAgentCwd, roomAgentCwd } from "./agentWorkspace";

// ACT: 计划 Task 13 —— 每用户授权（per-user grant）。用户在某个 Matrix 房间里明确同意后，
// 服务器侧编排器（customer_service）才可以「驱动」该用户的辐条（在其设备上执行画布/节点调用），
// 以及「调用」该用户防火墙内的本地模型。授权按 (roomId, userId) 记账，落盘在房间工作区的 grants.json，
// 与 workflow.json 同处一地，进程重启后仍可续用。
//
// 授权是「每用户」的；能力注册（deviceId、localModel 可达性）是「每设备」的（见 spoke.ts 的 capabilities）。
// 一个用户可在手机/平板/电脑各连一个辐条，它们共享同一份该用户的授权。
//
// 出于安全默认拒绝（default-deny）：没有记录即视为未授权，编排器不得驱动其设备、不得调用其本地模型。

export type GrantCapability = "driveSpokes" | "invokeLocalModels";

export interface UserGrant {
  // 允许编排器驱动该用户在本房间内的辐条（在其设备上执行画布/节点调用）。
  driveSpokes: boolean;
  // 允许编排器调度该用户防火墙内的本地模型（本地模型能力仅在授权后才对编排器可见）。
  invokeLocalModels: boolean;
  // 最近一次更新时间戳（毫秒）。
  updatedAt: number;
}

export type RoomGrants = Record<string, UserGrant>;

const GRANTS_FILE = "grants.json";

// 进程内缓存：授权文件较小，读一次缓存起来，供 spoke.ts 的同步门控热路径查询（hasGrant）。
// 由 loadRoomGrants（编排器每轮开始）与 setRoomGrant/revokeRoomGrant（授权路由）刷新。
const cache = new Map<string, RoomGrants>();

function grantsPath(roomId: string): string {
  return join(roomAgentCwd(roomId), GRANTS_FILE);
}

export function emptyGrant(): UserGrant {
  return { driveSpokes: false, invokeLocalModels: false, updatedAt: 0 };
}

function normalize(raw: unknown): UserGrant {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    driveSpokes: value.driveSpokes === true,
    invokeLocalModels: value.invokeLocalModels === true,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function parseGrants(text: string): RoomGrants {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const grants: RoomGrants = {};
  for (const [userId, value] of Object.entries(parsed)) {
    if (typeof userId === "string" && userId) grants[userId] = normalize(value);
  }
  return grants;
}

// 读取并缓存房间授权表；文件不存在或损坏时视为空表（默认拒绝）。
export async function loadRoomGrants(roomId: string): Promise<RoomGrants> {
  let text: string;
  try {
    text = Buffer.from(await readFile(grantsPath(roomId))).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cache.set(roomId, {});
      return {};
    }
    throw error;
  }
  let grants: RoomGrants;
  try {
    grants = parseGrants(text);
  } catch {
    grants = {};
  }
  cache.set(roomId, grants);
  return grants;
}

// 同步读取缓存中的房间授权表（未加载时返回空表）。供 spoke.ts 门控热路径使用。
export function getRoomGrantsCached(roomId: string): RoomGrants {
  return cache.get(roomId) ?? {};
}

// 同步判定某用户是否已授权某项能力（默认拒绝）。
export function hasGrant(roomId: string, userId: string | undefined, capability: GrantCapability): boolean {
  if (!userId) return false;
  return getRoomGrantsCached(roomId)[userId]?.[capability] === true;
}

async function persist(roomId: string, grants: RoomGrants): Promise<void> {
  const cwd = await ensureRoomAgentCwd(roomId);
  await writeAtomic(join(cwd, GRANTS_FILE), JSON.stringify(grants, null, 2));
}

// 设置（或更新）某用户在本房间的授权，落盘并刷新缓存，返回写入后的授权。
export async function setRoomGrant(
  roomId: string,
  userId: string,
  grant: { driveSpokes: boolean; invokeLocalModels: boolean },
): Promise<UserGrant> {
  const grants = cache.get(roomId) ?? await loadRoomGrants(roomId);
  const next: UserGrant = {
    driveSpokes: grant.driveSpokes === true,
    invokeLocalModels: grant.invokeLocalModels === true,
    updatedAt: Date.now(),
  };
  const updated = { ...grants, [userId]: next };
  cache.set(roomId, updated);
  await persist(roomId, updated);
  return next;
}

// 撤销某用户在本房间的全部授权（回到默认拒绝），落盘并刷新缓存。
export async function revokeRoomGrant(roomId: string, userId: string): Promise<void> {
  const grants = cache.get(roomId) ?? await loadRoomGrants(roomId);
  if (!(userId in grants)) return;
  const updated = { ...grants };
  delete updated[userId];
  cache.set(roomId, updated);
  await persist(roomId, updated);
}
