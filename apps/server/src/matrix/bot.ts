import * as sdk from "matrix-js-sdk";
import { getSynapseConfig } from "@/utils/appConfig";
import { brokerToken, isConfigured } from "@/utils/matrix/admin";
import { createVideoTrigger, type VideoTrigger } from "./trigger";
import { startScheduler } from "./scheduler";
import { getChatToVideoSettings } from "./settings";

// ACT: Task 3 的机器人。以隐藏账号 @chat2movie_bot 登录 Synapse，同步目标房间时间线，
// 监听「!video / 生成视频」指令，命中后调用 trigger 生成视频并回贴 m.video。
// 设计原则与 admin.ts 一致：Synapse 不可用或未配置时静默降级，绝不拖垮主服务。

let stop: (() => void) | null = null;
let activeTrigger: VideoTrigger | null = null;

// ACT: 供「设置 → 聊天转视频」面板查询机器人运行状态，并复用同一 trigger 做手动生成。
export function getMatrixBotState(): { running: boolean; trigger: VideoTrigger | null } {
  return { running: Boolean(stop), trigger: activeTrigger };
}

// 启动机器人；返回停止函数。未配置 Synapse 或未启用时返回 null（不抛错）。
export async function startMatrixBot(): Promise<(() => void) | null> {
  if (stop) return stop;
  if (!isConfigured()) return null;
  const settings = getChatToVideoSettings();
  if (!settings.enabled) return null;
  const synapse = getSynapseConfig();
  const botUserId = synapse.botUserId;
  if (!botUserId) {
    console.warn("[matrix] 未配置 botUserId，跳过聊天转视频机器人启动");
    return null;
  }
  const creds = await brokerToken(botUserId);
  if (!creds) {
    console.warn(`[matrix] 无法为机器人 ${botUserId} 代签令牌，跳过启动`);
    return null;
  }
  const client = sdk.createClient({
    baseUrl: synapse.baseUrl!,
    accessToken: creds.access_token,
    userId: creds.user_id,
    deviceId: creds.device_id ?? undefined,
  });
  const trigger = createVideoTrigger(client, botUserId);
  activeTrigger = trigger;
  const command = settings.command.toLowerCase();
  // ACT: 首次同步（PREPARED 之前）会回放历史事件，用 prepared 标志 + toStartOfTimeline 过滤，避免机器人对旧指令重复出片。
  let prepared = false;

  client.on(sdk.RoomEvent.Timeline, (event, _room, toStartOfTimeline) => {
    if (!prepared || toStartOfTimeline) return;
    if (event.getSender() === botUserId) return;
    if (event.getType() !== "m.room.message") return;
    const content = event.getContent<{ msgtype?: string; body?: string }>() ?? {};
    if (content.msgtype !== "m.text") return;
    const body = (content.body ?? "").trim();
    if (!body) return;
    const roomId = event.getRoomId();
    if (!roomId) return;
    // ACT: 原型只服务 config.json 指定的单一房间；未指定 roomId 时对所有房间生效。
    if (synapse.roomId && roomId !== synapse.roomId) return;
    const lower = body.toLowerCase();
    if (!lower.startsWith(command) && !lower.includes("生成视频")) return;
    void trigger.trigger(roomId).catch(err => console.error("[matrix] 触发视频生成失败:", err));
  });

  client.on(sdk.ClientEvent.Sync, (state: sdk.SyncState) => {
    if (state === sdk.SyncState.Prepared) prepared = true;
  });

  await client.startClient({ initialSyncLimit: 30 });
  // ACT: 确保机器人已在目标房间。用机器人自己的令牌走标准 /join（已加入时是空操作），
  // 不再用 Admin 强制拉人：演示房间由 host 创建，管理员并不在房内，那个接口会 403。
  if (synapse.roomId) await client.joinRoom(synapse.roomId).catch(() => {});
  const stopScheduler = startScheduler(trigger, { ...settings.schedule, roomId: synapse.roomId });

  const stopFn = () => {
    stopScheduler();
    try { client.stopClient(); } catch (err) { console.error("[matrix] 停止机器人失败:", err); }
    activeTrigger = null;
    if (stop === stopFn) stop = null;
  };
  stop = stopFn;
  console.log(`[matrix] 聊天转视频机器人已启动：${botUserId}`);
  return stopFn;
}

// 停止机器人（幂等）。
export function stopMatrixBot() {
  stop?.();
  stop = null;
}
