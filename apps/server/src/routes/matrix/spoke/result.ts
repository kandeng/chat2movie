import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { finishCanvasCall } from "@/agent/bridge/canvas";
import { roomAgentCwd } from "@/matrix/agentWorkspace";

// ACT: 辐条回传画布调用结果（计划 Task 5）。用房间工作区目录作为 cwd 定位挂起的画布调用——
// 与编排器创建画布桥时使用的 cwd（ensureRoomAgentCwd → roomAgentCwd）完全一致；
// 幂等：超时/取消/完成后仍可能收到回传，finishCanvasCall 会安全忽略。
export default Router().post("/", validateFields({
  room: z.string().min(1).max(256),
  callId: z.uuid(),
  result: z.json().optional(),
  error: z.string().min(1).max(8000).optional(),
  cancelled: z.boolean().optional(),
  unavailable: z.boolean().optional(),
}), (req, res) => {
  assertAppRequest(req);
  const { room, callId, ...response } = req.body as {
    room: string; callId: string;
    result?: unknown; error?: string; cancelled?: boolean; unavailable?: boolean;
  };
  finishCanvasCall(roomAgentCwd(room), callId, response);
  res.json(success());
});
