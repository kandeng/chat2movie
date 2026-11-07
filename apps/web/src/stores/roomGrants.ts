import { reactive, ref } from "vue";
import { locale } from "@toonflow/i18n/vue";

// ACT: 计划 Task 13 —— 浏览器侧「每用户授权（consent）」状态。用户在某个 Matrix 房间里明确同意后，
// 服务器侧编排器（customer_service）才能驱动本用户在该房间的设备（画布/节点调用）与调用其防火墙内的本地模型。
// 授权按账号（mxid）记账、落盘在服务器房间工作区；本 store 只缓存当前房间的授权与设备概览，
// 并在开关切换时回写服务器。授权路由用网站会话校验身份，用户只能改自己的授权。

export interface RoomDevice {
  spokeId: string;
  userId: string;
  deviceId: string;
  localModel: boolean;
  hasCanvas: boolean;
  driveSpokes: boolean;
  invokeLocalModels: boolean;
}

// 当前用户在本房间的授权（响应式，供同意开关双向绑定）。
export const roomGrant = reactive({ driveSpokes: false, invokeLocalModels: false });
// 房间内活跃设备概览（含所属用户与能力/授权），供 UI 展示与调试。
export const roomGrantDevices = ref<RoomDevice[]>([]);
export const roomGrantLoaded = ref(false);
export const roomGrantSaving = ref(false);

let currentRoom = "";

const baseHeaders = () => ({ "x-toonflow-workspace": "1", "Accept-Language": locale.value, "Content-Type": "application/json" });

export function currentGrantRoom(): string {
  return currentRoom;
}

export function resetRoomGrants(): void {
  currentRoom = "";
  roomGrant.driveSpokes = false;
  roomGrant.invokeLocalModels = false;
  roomGrantDevices.value = [];
  roomGrantLoaded.value = false;
}

type GrantsResponse = {
  data?: {
    userId?: string;
    mine?: { driveSpokes?: boolean; invokeLocalModels?: boolean } | null;
    spokes?: RoomDevice[];
  };
};

// 拉取当前房间的授权与设备概览；roomId 为空或未登录时重置为默认拒绝。
export async function loadRoomGrants(roomId: string): Promise<void> {
  if (!roomId) { resetRoomGrants(); return; }
  currentRoom = roomId;
  const response = await fetch(`/api/matrix/spoke/grants?room=${encodeURIComponent(roomId)}`, { headers: baseHeaders() }).catch(() => undefined);
  const json = await response?.json().catch(() => null) as GrantsResponse | null;
  const data = json?.data;
  if (!data) { roomGrantLoaded.value = false; return; }
  roomGrant.driveSpokes = data.mine?.driveSpokes === true;
  roomGrant.invokeLocalModels = data.mine?.invokeLocalModels === true;
  roomGrantDevices.value = Array.isArray(data.spokes) ? data.spokes : [];
  roomGrantLoaded.value = true;
}

// 回写当前用户的授权；成功后刷新本地状态与设备概览（能力广告随 invokeLocalModels 变化）。
export async function saveRoomGrant(next: { driveSpokes: boolean; invokeLocalModels: boolean }): Promise<boolean> {
  if (!currentRoom) return false;
  roomGrantSaving.value = true;
  try {
    const response = await fetch("/api/matrix/spoke/grants", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ room: currentRoom, driveSpokes: next.driveSpokes === true, invokeLocalModels: next.invokeLocalModels === true }),
    }).catch(() => undefined);
    const json = await response?.json().catch(() => null) as { data?: { grant?: { driveSpokes?: boolean; invokeLocalModels?: boolean } } } | null;
    const grant = json?.data?.grant;
    if (!grant) return false;
    roomGrant.driveSpokes = grant.driveSpokes === true;
    roomGrant.invokeLocalModels = grant.invokeLocalModels === true;
    await loadRoomGrants(currentRoom);
    return true;
  } finally {
    roomGrantSaving.value = false;
  }
}
