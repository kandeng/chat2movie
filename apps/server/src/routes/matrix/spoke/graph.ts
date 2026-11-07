import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { commitRoomGraph, readCommittedGraph } from "@/matrix/graphFanout";

// ACT: 主画布辐条上报「执行完编排器画布变更后」的实时语义图快照（计划 Task 10）。
// 服务器把快照提交为房间已提交工作流（revision 自增、内容去重），并广播给房间内所有辐条，
// 各端按 revision 幂等收敛。返回提交后的 revision，上报方据此把本地 lastApplied 对齐到自己刚提交的版本，
// 从而跳过随后广播回自身的那一条（它已是该图的来源，无需重复应用）。
export default Router().post("/", validateFields({
  room: z.string().min(1).max(256),
  spokeId: z.string().min(1).max(64),
  graph: z.strictObject({ nodes: z.array(z.json()), edges: z.array(z.json()) }),
}), async (req, res) => {
  assertAppRequest(req);
  const { room, graph } = req.body as { room: string; graph: { nodes: unknown[]; edges: unknown[] } };
  const revision = await commitRoomGraph(room, graph);
  res.json(success({ revision }));
})
// ACT: 计划 Task 11 —— synchronize：辐条重新拉取房间当前已提交工作流图，用于把本地待处理覆盖层
// 回滚到编排器已同意的最新权威版本（无提交时 workflow 为 null）。GET 便于浏览器直接按房间查询。
.get("/", validateFields({ room: z.string().min(1).max(256) }, "query"), async (req, res) => {
  assertAppRequest(req);
  const { room } = req.query as { room: string };
  res.json(success({ workflow: await readCommittedGraph(room) }));
});
