import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveRequestMxid } from "@/utils/matrix/requestUser";
import { isConfigured, roomMembers } from "@/utils/matrix/admin";
import { ensureRoomCanvas } from "@/matrix/agentWorkspace";

// ACT: 单画布 1:1:1 绑定（Task 6）——按 Matrix 房间解析其服务器侧工作区目录。
// 浏览器不能直接写本地磁盘，工作室项目目录即房间 Agent 工作区（chat-agent/<roomId>），
// 位于 resolveWorkspace 允许的 <dataDir>/workspaces 根下，前端可经 /api/workspaces/files 读写。
// 安全口径：用网站会话解析本人 mxid，并校验其为该房间成员；顺带确保目录与单画布已播种（幂等）。
export default Router().get("/", validateFields({ room: z.string().min(1).max(256) }, "query"), async (req, res) => {
  assertAppRequest(req);
  const mxid = await resolveRequestMxid(req);
  if (!mxid) {
    res.status(401).json(error("请先登录网站账号", null, 401));
    return;
  }
  const room = req.query.room as string;
  if (!isConfigured()) {
    res.status(503).json(error("未配置 Synapse，无法解析房间工作区", null, 503));
    return;
  }
  const members = await roomMembers(room);
  if (!members.includes(mxid)) {
    res.status(403).json(error("你不是该房间成员，无法访问其工作区", null, 403));
    return;
  }
  const directory = await ensureRoomCanvas(room);
  res.json(success({ room, directory }));
});
