import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { commitProposal, listProposals, rejectProposal } from "@/matrix/graphProposal";
import type { RoomGraph } from "@/matrix/graphFanout";

// ACT: 计划 Task 11 —— 房间编排器（customer_service）的工作流提案工具。
// 用户在画布上直接编辑是本地待处理覆盖层；点「更新」后整张语义图作为提案暂存到服务器，并在房间发讨论消息。
// 编排器用这组工具查看提案、与用户讨论后决定采纳（revision 门控提交并广播给所有设备）或拒绝。
// 只有编排器采纳后，所有用户（含提案者）的画布才会收敛到新版本 —— 落实「hub 权威、用户改动为提案」的策略。

// 生成图变更的紧凑结构摘要，供编排器判断与讨论（不含节点内部生成产物，避免上下文膨胀）。
function summarize(graph: RoomGraph): { nodeCount: number; edgeCount: number; nodes: unknown[]; edges: unknown[] } {
  const nodes = (graph.nodes ?? []).slice(0, 200).map((raw) => {
    const node = raw as { id?: unknown; type?: unknown; position?: unknown; data?: { label?: unknown } };
    return { id: node.id, type: node.type, position: node.position, label: node.data?.label };
  });
  const edges = (graph.edges ?? []).slice(0, 400).map((raw) => {
    const edge = raw as { id?: unknown; source?: unknown; target?: unknown; sourceHandle?: unknown; targetHandle?: unknown };
    return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
  });
  return { nodeCount: (graph.nodes ?? []).length, edgeCount: (graph.edges ?? []).length, nodes, edges };
}

export function createWorkflowProposalTools(roomId: string): ToolDefinition[] {
  const listParameters = z.strictObject({});
  const commitParameters = z.strictObject({ proposalId: z.string().min(1).max(64).describe("要采纳并提交的提案 id（来自 listWorkflowProposals）") });
  const rejectParameters = z.strictObject({
    proposalId: z.string().min(1).max(64).describe("要拒绝的提案 id"),
    reason: z.string().trim().max(2000).optional().describe("拒绝原因，会作为你的回复依据告知用户"),
  });

  const list: ToolDefinition = {
    name: "listWorkflowProposals", label: "查看工作流提案",
    description: "列出当前房间里用户通过画布「更新」按钮提交、尚未处理的工作流图修改提案。每个提案含 id、提交设备、基线 revision，以及图变更的结构摘要（节点数、连线数、节点 id/类型/标签/位置、连线 id/来源/目标）。在与用户讨论是否采纳其画布改动前，先用它查看待处理提案。",
    promptGuidelines: ["当用户消息提到提议更新工作流图（通常带 proposal id）或询问画布改动时，先用 listWorkflowProposals 查看待处理提案，理解其结构摘要后再决定采纳、拒绝或继续与用户讨论。"],
    parameters: z.toJSONSchema(listParameters), executionMode: "sequential",
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      const items = listProposals(roomId).map(proposal => ({
        id: proposal.id, spokeId: proposal.spokeId, baseRevision: proposal.baseRevision, summary: summarize(proposal.graph),
      }));
      return {
        content: [{ type: "text", text: items.length ? JSON.stringify(items, null, 2) : "当前没有待处理的工作流提案。" }],
        details: { count: items.length },
      };
    },
  };

  const commit: ToolDefinition = {
    name: "commitWorkflowProposal", label: "采纳工作流提案",
    description: "采纳一个用户提案：把提案里的图作为房间新的权威已提交工作流（revision 自增）落盘，并广播给房间内所有设备，使所有用户（含提案者）的画布收敛到该版本。仅在你与用户讨论后确实同意该改动时调用。若提案基线已过时（其他人先提交了），会返回冲突错误，此时应让用户先 synchronize（同步）到最新版本，再重新提交更新。",
    promptGuidelines: ["只有讨论达成一致、你确认采纳用户画布改动时才调用 commitWorkflowProposal；采纳后简要告诉用户已提交为哪个 revision。", "遇到冲突（基线过时）错误时，不要重复提交，应提示用户先点「同步」再重新「更新」。"],
    parameters: z.toJSONSchema(commitParameters), executionMode: "sequential",
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const { proposalId } = commitParameters.parse(params);
      try {
        const revision = await commitProposal(roomId, proposalId);
        return { content: [{ type: "text", text: `已采纳提案 ${proposalId} 并提交为 revision ${revision}，已广播给房间内所有设备。` }], details: { revision } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `提交失败：${message}` }], details: { error: message } };
      }
    },
  };

  const reject: ToolDefinition = {
    name: "rejectWorkflowProposal", label: "拒绝工作流提案",
    description: "拒绝一个用户提案：把它从待处理列表移除，不改动已提交工作流、不广播。用于讨论后你认为该改动不应采纳的情况。拒绝后请在回复里说明原因，用户可点「同步」回滚本地覆盖层到最新已提交版本。",
    promptGuidelines: ["讨论后决定不采纳用户画布改动时调用 rejectWorkflowProposal，并在回复中清楚说明原因与替代建议。"],
    parameters: z.toJSONSchema(rejectParameters), executionMode: "sequential",
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const { proposalId, reason } = rejectParameters.parse(params);
      const removed = rejectProposal(roomId, proposalId);
      return {
        content: [{ type: "text", text: removed ? `已拒绝提案 ${proposalId}。${reason ? `原因：${reason}` : ""}`.trim() : `提案 ${proposalId} 不存在或已被处理。` }],
        details: { removed },
      };
    },
  };

  return [list, commit, reject];
}
