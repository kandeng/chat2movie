import { commitRoomGraphGated, type RoomGraph } from "./graphFanout";

// ACT: 计划 Task 11 —— 工作流图「用户提案」暂存区与权限/冲突策略。
// 用户在画布上直接编辑属于本地待处理覆盖层（pending overlay），只有点「更新」才把整张语义图
// 作为一个提案提交到这里，并自动在房间时间线发一条讨论消息。服务器侧编排器（customer_service）
// 通过 workflowProposal 工具查看/采纳/拒绝提案：采纳时经 commitRoomGraphGated 做 revision 门控提交，
// 冲突（基线过时）时保留提案以便用户重新同步后再次提交（lost-work guard）。
// 提案是内存态（进程内），提交/拒绝后移除；进程重启会丢失未处理提案，用户重新「更新」即可。

export interface WorkflowProposal {
  id: string;
  spokeId: string;
  // 提案所基于的已提交 revision（乐观并发基线）。
  baseRevision: number;
  graph: RoomGraph;
  createdAt: number;
}

const proposals = new Map<string, Map<string, WorkflowProposal>>();

function roomMap(roomId: string): Map<string, WorkflowProposal> {
  let map = proposals.get(roomId);
  if (!map) { map = new Map(); proposals.set(roomId, map); }
  return map;
}

// 暂存一个用户提案，返回带 id 的提案对象。baseRevision 由客户端携带（它最后应用的已提交 revision）。
export function stageProposal(roomId: string, input: { spokeId: string; baseRevision: number; graph: RoomGraph }): WorkflowProposal {
  const proposal: WorkflowProposal = {
    id: crypto.randomUUID(),
    spokeId: input.spokeId,
    baseRevision: Number.isFinite(input.baseRevision) ? input.baseRevision : 0,
    graph: { nodes: input.graph.nodes ?? [], edges: input.graph.edges ?? [] },
    createdAt: Date.now(),
  };
  roomMap(roomId).set(proposal.id, proposal);
  return proposal;
}

// 列出房间内待处理提案（按提交时间升序）。
export function listProposals(roomId: string): WorkflowProposal[] {
  const map = proposals.get(roomId);
  if (!map) return [];
  return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getProposal(roomId: string, id: string): WorkflowProposal | undefined {
  return proposals.get(roomId)?.get(id);
}

// 采纳提案：revision 门控提交 + 广播给所有辐条；成功后移除提案，返回提交后的 revision。
// 基线过时（其他人先提交）时抛 409，并保留提案，供用户 synchronize 后重新提交。
export async function commitProposal(roomId: string, id: string): Promise<number> {
  const proposal = getProposal(roomId, id);
  if (!proposal) throw Object.assign(new Error("提案不存在或已被处理"), { status: 404, code: "ENOENT" });
  const revision = await commitRoomGraphGated(roomId, proposal.graph, proposal.baseRevision);
  proposals.get(roomId)?.delete(id);
  return revision;
}

// 拒绝提案：移除并返回是否存在该提案。
export function rejectProposal(roomId: string, id: string): boolean {
  return proposals.get(roomId)?.delete(id) ?? false;
}
