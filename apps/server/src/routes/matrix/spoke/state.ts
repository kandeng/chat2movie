import { Router } from "express";
import { z } from "zod";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveRequestMxid } from "@/utils/matrix/requestUser";
import { updateSpokeCanvas, updateSpokeCapabilities, updateSpokeUser } from "@/matrix/spoke";
import { readCommittedGraph } from "@/matrix/graphFanout";

// ACT: 辐条上报当前画布上下文与设备能力（计划 Task 9）。画布字段与 /api/agent 的 canvas 入参一致，
// 使 customer_service 的 run() 能拿到 id + 节点工具清单来构建画布桥；canvas 为 null 表示暂无可用画布。
// capabilities 为可选的设备能力（如本地模型可达性），供 Task 12/13 调度与授权使用。
// 响应回带房间当前已提交工作流图（计划 Task 10），使新接入/刷新的辐条立即按 revision 幂等收敛到权威图。
const canvasSchema = z.strictObject({
  id: z.string().max(256),
  tools: z.array(z.strictObject({
    nodeId: z.string().min(1).max(256),
    name: z.string().max(101).regex(/^node:[a-z][a-zA-Z0-9]*$/),
    nodeLabel: z.string().max(200).optional(),
    description: z.string().max(4000),
    parameters: z.record(z.string(), z.json()).refine(value => value.type === "object", "函数参数必须是 object JSON Schema"),
  })).max(1000),
});

export default Router().post("/", validateFields({
  room: z.string().min(1).max(256),
  spokeId: z.string().min(1).max(64),
  canvas: canvasSchema.nullable(),
  capabilities: z.record(z.string(), z.json()).optional(),
}), async (req, res) => {
  assertAppRequest(req);
  const { room, spokeId, canvas, capabilities } = req.body as {
    room: string; spokeId: string; canvas: CanvasInfo | null; capabilities?: Record<string, unknown>;
  };
  // ACT: 计划 Task 13 —— 把这条辐条绑定到经会话校验的本人 mxid（而非客户端自报），供授权门控使用。
  const userId = await resolveRequestMxid(req);
  if (userId) updateSpokeUser(room, spokeId, userId);
  if (capabilities) updateSpokeCapabilities(room, spokeId, capabilities);
  updateSpokeCanvas(room, spokeId, canvas ?? null);
  // 回带已提交工作流图（无提交时为 null），辐条据此做初始收敛。
  res.json(success({ workflow: await readCommittedGraph(room) }));
});
