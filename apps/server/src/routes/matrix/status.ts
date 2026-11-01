import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { getSynapseConfig } from "@/utils/appConfig";
import { isConfigured } from "@/utils/matrix/admin";
import { getChatToVideoSettings } from "@/matrix/settings";
import { getMatrixBotState } from "@/matrix/bot";

// ACT: 供「设置 → 聊天转视频」面板展示 Synapse 配置与机器人运行状态（只读，无副作用）。
export default Router().get("/", (_req, res) => {
  const synapse = getSynapseConfig();
  const settings = getChatToVideoSettings();
  const { running } = getMatrixBotState();
  res.json(success({
    configured: isConfigured(),
    running,
    enabled: settings.enabled,
    botUserId: synapse.botUserId || null,
    roomId: synapse.roomId || null,
    serverName: synapse.serverName || null,
    providerId: settings.providerId,
    modelId: settings.modelId,
    command: settings.command,
    recentMessageLimit: settings.recentMessageLimit,
  }));
});
