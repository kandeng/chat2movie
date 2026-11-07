import { Router } from "express";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { getAuth } from "@/utils/auth";
import { isConfigured } from "@/utils/matrix/admin";
import { addAgentToRoom, AGENT_DISPLAY_NAME } from "@/matrix/agent";
import { ensureRoomCanvas } from "@/matrix/agentWorkspace";

// ACT: 新建群聊后由前端调用，把 AI 客服机器人加进房间。
// 邀请必须由房内成员发出，所以用当前登录用户（房间创建者）的身份代签发邀请，
// 机器人再用自己的令牌接受邀请 —— 管理员不在房内，Admin 的强制拉人接口会 403。
export default Router().post("/", validateFields({
  roomId: z.string().min(1).max(256),
}), async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json(error("未配置 Synapse，无法邀请 AI 客服入群", null, 503));
    return;
  }
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    res.status(401).json(error("请先登录网站账号", null, 401));
    return;
  }
  const user = session.user as { mxid?: string | null };
  const mxid = typeof user.mxid === "string" ? user.mxid : "";
  if (!mxid) {
    res.status(500).json(error("该账号缺少 Matrix 身份，无法邀请 AI 客服入群", null, 500));
    return;
  }
  const roomId = (req.body.roomId as string).trim();
  const ok = await addAgentToRoom(mxid, roomId);
  if (!ok) {
    res.status(503).json(error("AI 客服入群失败，请确认 Synapse 可用且已配置 synapse.botUserId", null, 503));
    return;
  }
  // ACT: 单画布 1:1:1 绑定（Task 6）——新建群聊即 eager 创建房间工作区并播种一个空白画布，
  // 不等首条消息；失败不阻断「已入群」结果，工作室路由仍会惰性补种。
  await ensureRoomCanvas(roomId).catch(err => console.warn(`[matrix] 房间工作区初始化失败：${roomId}`, err));
  res.json(success({ roomId, name: AGENT_DISPLAY_NAME }, "AI 客服已加入群聊"));
});
