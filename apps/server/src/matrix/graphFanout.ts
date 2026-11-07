import { readRoomWorkflow, writeRoomWorkflow } from "./agentWorkspace";
import { broadcastSpoke } from "./spoke";

// ACT: 计划 Task 10 —— 图扇出（graph fan-out）。服务器侧编排器（customer_service）是唯一权威：
// 「主画布辐条」执行完编排器下发的画布变更后，把实时语义图快照上报到 /api/matrix/spoke/graph，
// 本模块把快照写入房间的已提交工作流（workflow.json，revision 自增），再把
// { type: "graph", revision, graph } 广播给房间内所有辐条，各端按 revision 幂等收敛到同一张图。
// 语义图只含 nodes/edges；视口（缩放/平移/选择）属于每设备视图态，不提交、不扇出（计划 Key decisions）。

export type RoomGraph = { nodes: unknown[]; edges: unknown[] };

// 仅比较语义图（忽略内嵌 revision），用于去重：内容未变则不产生新 revision、不广播，
// 避免「移动节点后原位写回」这类无实质变化的上报造成无谓的扇出。
function semanticKey(graph: Record<string, unknown>): string {
  return JSON.stringify({ nodes: graph.nodes ?? [], edges: graph.edges ?? [] });
}

// 提交并扇出一张新的语义图；返回提交后的 revision。内容与当前已提交版本一致时直接返回当前 revision，不广播。
export async function commitRoomGraph(roomId: string, graph: RoomGraph): Promise<number> {
  const committed: RoomGraph = { nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  const current = await readRoomWorkflow(roomId);
  if (current && semanticKey(current.graph) === semanticKey(committed)) return current.revision;
  // 不传 expectedRevision：编排器（经主画布辐条上报）是权威写入者，直接递增提交。
  // Task 11 的用户提案流程会改用 expectedRevision 做乐观并发校验。
  const revision = await writeRoomWorkflow(roomId, committed);
  broadcastSpoke(roomId, { type: "graph", revision, graph: committed });
  return revision;
}

// ACT: 计划 Task 11 —— 带乐观并发校验的提交：仅当 expectedRevision 等于当前已提交 revision 时才落盘，
// 否则抛 409 EREVISION（说明用户提案的基线已过时，其他人先提交了）。用于「用户提案 → 编排器采纳」路径，
// 与 commitRoomGraph（编排器经主画布辐条直接权威写入）区分开。内容一致时不产生新 revision、不广播。
export async function commitRoomGraphGated(roomId: string, graph: RoomGraph, expectedRevision: number): Promise<number> {
  const committed: RoomGraph = { nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  const current = await readRoomWorkflow(roomId);
  const baseRevision = current?.revision ?? 0;
  if (expectedRevision !== baseRevision) {
    throw Object.assign(new Error(`提案基于 revision ${expectedRevision}，但房间当前已是 revision ${baseRevision}，存在冲突；请让用户先同步到最新版本再重新提交`), { status: 409, code: "EREVISION" });
  }
  if (current && semanticKey(current.graph) === semanticKey(committed)) return baseRevision;
  const revision = await writeRoomWorkflow(roomId, committed, expectedRevision);
  broadcastSpoke(roomId, { type: "graph", revision, graph: committed });
  return revision;
}

// 读取房间当前已提交的工作流图，供新接入的辐条做初始收敛（尚无提交时返回 null）。
export async function readCommittedGraph(roomId: string): Promise<{ revision: number; graph: RoomGraph } | null> {
  const current = await readRoomWorkflow(roomId);
  if (!current) return null;
  return {
    revision: current.revision,
    graph: { nodes: (current.graph.nodes as unknown[]) ?? [], edges: (current.graph.edges as unknown[]) ?? [] },
  };
}
