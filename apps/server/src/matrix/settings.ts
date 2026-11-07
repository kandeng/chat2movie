import conf from "@/utils/conf";
import { listAiModels } from "@/utils/ai";

// ACT: 聊天转视频原型的设置读取器。设置存于 data/settings.json 的 chatToVideo 块，
// 由「设置 → 通讯 → 聊天转视频」面板写入；服务端各模块（bot/trigger/scheduler）共用此归一化结果。
// 缺省时给出可用默认值，保证机器人在 Synapse 已配置时开箱即用。

export type ChatToVideoSchedule = { enabled: boolean; time: string; timezone: string };

export type ChatToVideoSettings = {
  enabled: boolean;
  providerId: string;
  modelId: string;
  command: string;
  recentMessageLimit: number;
  outputDirectory: string;
  schedule: ChatToVideoSchedule;
};

const defaults: ChatToVideoSettings = {
  enabled: true,
  providerId: "aiRouter",
  modelId: "wan3.0-video",
  command: "!video",
  recentMessageLimit: 20,
  outputDirectory: "generated",
  schedule: { enabled: false, time: "09:00", timezone: "" },
};

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// 从 conf 读取并归一化 chatToVideo 设置（含默认值兜底与范围裁剪）。
export function getChatToVideoSettings(): ChatToVideoSettings {
  const raw = conf.get("settings", {}).chatToVideo;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const schedule = value.schedule && typeof value.schedule === "object" && !Array.isArray(value.schedule)
    ? value.schedule as Record<string, unknown> : {};
  const limit = Number(value.recentMessageLimit);
  return {
    enabled: value.enabled !== false,
    providerId: text(value.providerId, defaults.providerId),
    modelId: text(value.modelId, defaults.modelId),
    command: text(value.command, defaults.command),
    recentMessageLimit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.round(limit))) : defaults.recentMessageLimit,
    outputDirectory: text(value.outputDirectory, defaults.outputDirectory),
    schedule: {
      // ACT: 定时生成在原型阶段仅存配置、不实际调度（见 scheduler.ts），默认关闭。
      enabled: schedule.enabled === true,
      time: text(schedule.time, defaults.schedule.time),
      timezone: typeof schedule.timezone === "string" ? schedule.timezone.trim() : "",
    },
  };
}

// ACT: 房间编排 Agent（customer_service）的设置。它是每个 Matrix 房间的服务器侧 pi-coding 大脑，
// 与「聊天转视频」相互独立：可以只开 Agent、只开视频，或两者都开。
export type RoomAgentSettings = { enabled: boolean; providerId: string; modelId: string };

// 读取并归一化房间 Agent 设置。providerId/modelId 未显式配置时留空，由 getRoomAgentModel 回退到首个可用模型。
export function getRoomAgentSettings(): RoomAgentSettings {
  const raw = conf.get("settings", {}).roomAgent;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { enabled: value.enabled !== false, providerId: text(value.providerId, ""), modelId: text(value.modelId, "") };
}

// 解析房间 Agent 实际使用的文本模型：优先用设置里指定的，否则回退到「设置」中已配置的首个文本模型。
// 没有任何可用模型时返回 null，调用方据此在房间里给出降级提示，而不是抛错拖垮机器人。
export function getRoomAgentModel(): { providerId: string; modelId: string } | null {
  const { providerId, modelId } = getRoomAgentSettings();
  if (providerId && modelId) return { providerId, modelId };
  const first = listAiModels()[0];
  return first ? { providerId: first.providerId, modelId: first.modelId } : null;
}
