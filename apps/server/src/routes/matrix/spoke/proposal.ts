import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { stageProposal } from "@/matrix/graphProposal";

// ACT: 计划 Task 11 —— update：用户点击画布「更新」把本地待处理覆盖层作为提案提交到房间。
// 服务器暂存提案（含客户端最后应用的 baseRevision 作为乐观并发基线），返回 proposalId。
// 浏览器随后自动在房间时间线发一条讨论消息（带 proposalId），触发编排器与其他成员讨论；
// 只有编排器通过 workflowProposal 工具采纳后，才经 revision 门控提交并广播给所有辐条。
export default Router().post("/", validateFields({
  room: z.string().min(1).max(256),
  spokeId: z.string().min(1).max(64),
  baseRevision: z.number().int().min(0).max(1_000_000_000),
  graph: z.strictObject({ nodes: z.array(z.json()), edges: z.array(z.json()) }),
}), (req, res) => {
  assertAppRequest(req);
  const { room, spokeId, baseRevision, graph } = req.body as {
    room: string; spokeId: string; baseRevision: number; graph: { nodes: unknown[]; edges: unknown[] };
  };
  const proposal = stageProposal(room, { spokeId, baseRevision, graph });
  res.json(success({ proposalId: proposal.id, baseRevision: proposal.baseRevision }));
});
