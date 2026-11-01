import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { getSynapseConfig } from "@/utils/appConfig";
import { isConfigured } from "@/utils/matrix/admin";
import { getMatrixBotState } from "@/matrix/bot";

// ACT: 面板「立即生成」按钮的后端。复用运行中机器人的 trigger，采用 fire-and-forget：
// 立即返回“已开始”，真正的视频由机器人生成完成后以 m.video 回帖到房间。
export default Router().post("/", validateFields({
  prompt: z.string().max(4000).optional(),
  roomId: z.string().max(256).optional(),
}), async (req, res) => {
  if (!isConfigured()) return res.status(503).json(error("未配置 Synapse，请先在 config.json 的 synapse 块填写 baseUrl 与 adminAccessToken", null, 503));
  const { trigger, running } = getMatrixBotState();
  if (!running || !trigger) return res.status(503).json(error("聊天转视频机器人未运行，请先在设置中启用并确认 Synapse 可用", null, 503));
  const synapse = getSynapseConfig();
  const roomId = (req.body.roomId as string | undefined)?.trim() || synapse.roomId;
  if (!roomId) return res.status(400).json(error("缺少目标房间，请在 config.json 的 synapse.roomId 配置或在请求中指定 roomId", null, 400));
  void trigger.trigger(roomId, req.body.prompt as string | undefined).catch(err => console.error("[matrix] 手动生成失败:", err));
  res.json(success({ started: true, roomId }, "已开始生成视频，完成后将回帖到房间"));
});
