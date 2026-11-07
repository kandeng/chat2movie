import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { locale } from "@toonflow/i18n/vue";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
import { isCanvasRead } from "@/pages/workspace/panels/canvas/canvasQueries";

// ACT: 浏览器侧「隐藏 pi-core 辐条」的画布中继（计划 Task 5，Stage 1 单辐条）。
// 打开的工作室标签页把自己注册为当前 Matrix 房间的辐条：
//   (a) 通过 fetch 流式读取 /api/matrix/spoke/events（需带 x-toonflow-workspace 头，故不用 EventSource）；
//   (b) 上报画布上下文（id + 节点工具）到 /api/matrix/spoke/state；
//   (c) 收到 customer_service（服务器侧编排器）推来的画布调用后，在实时 vue-flow 图上执行，
//       再把结果回传 /api/matrix/spoke/result。
// 画布执行直接复用面板暴露的 CanvasContext.call —— 与 /api/agent 流里的 sendCanvasResult 同一条执行路径。

type CanvasCallEvent = { type: "canvasCall"; callId: string; name: string; args: Record<string, unknown> };
// ACT: 计划 Task 10 —— 房间已提交工作流的语义图（仅 nodes/edges；视口/缩放/选择属于每设备视图态，不扇出）。
export type RoomGraph = { nodes: unknown[]; edges: unknown[] };
// 服务器编排器提交图后广播的事件；各辐条按 revision 幂等收敛。
type GraphEvent = { type: "graph"; revision: number; graph: RoomGraph };
type SpokeEvent = CanvasCallEvent | GraphEvent | { type: "ready" } | { type: "replaced" };
// 只读/视图态/画布级操作不改变当前工作流的语义图，执行后无需上报提交。
const NON_GRAPH_OPS = new Set(["selectNodes", "transcribeAudio", "fitCanvas", "addCanvas", "switchCanvas", "renameCanvas"]);
// ACT: 计划 Task 11 —— 语义图指纹（仅 nodes/edges），用于判定收敛到的权威图是否就是本机提交的提案。
function semanticKey(graph: RoomGraph): string {
  return JSON.stringify({ nodes: graph.nodes ?? [], edges: graph.edges ?? [] });
}

export interface RoomSpokeOptions {
  // 当前房间 id（空串表示无房间）。
  roomId: () => string;
  // 辐条是否应处于活动状态（已登录 + 有房间 + 处于 step-by-step 视图等）。
  active: () => boolean;
  // 读取实时画布上下文；无画布时返回 undefined。
  getCanvasContext: () => CanvasContext | undefined;
  // 当前画布 id 的响应式来源，用于在切换画布时重新上报上下文。
  canvasId: () => string;
  // 可选：本设备能力（计划 Task 12/13，如本地模型可达性），随画布状态一起上报。
  capabilities?: () => Record<string, unknown>;
  // ACT: 计划 Task 10 —— 读取当前实时语义图（编排器变更后上报提交用）；无画布时返回 undefined。
  getGraph?: () => RoomGraph | undefined;
  // ACT: 计划 Task 10 —— 把已提交语义图收敛式应用到实时画布（revision 幂等由本 composable 保证）。
  applyGraph?: (graph: RoomGraph) => void;
  // ACT: 计划 Task 11 —— 读取当前画布的「本地语义编辑信号」（用户改动时自增），用于判定待处理覆盖层。
  editSignal?: () => number;
  // ACT: 计划 Task 11 —— 提交更新提案后，自动在房间时间线发一条讨论消息（接到 useMatrixChat.sendText）。
  announce?: (body: string) => void | Promise<void>;
}

// ACT: 每台设备一个稳定的辐条 id（持久化到 localStorage）：多设备并存时互不顶替，
// 同设备刷新页面用同一 id 顶替自己旧连接（计划 Task 9）。
const SPOKE_ID_KEY = "vidsay.spokeId";
function deviceSpokeId(): string {
  try {
    const existing = localStorage.getItem(SPOKE_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(SPOKE_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function useRoomSpoke(options: RoomSpokeOptions) {
  const spokeId = deviceSpokeId();
  const lifetime = new AbortController();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let connection: AbortController | undefined;
  let currentRoom = "";
  // ACT: 计划 Task 10 —— 本辐条已应用到实时画布的最新 revision；换房间时归零（revision 按房间计）。
  let lastAppliedRevision = 0;
  // ACT: 计划 Task 11 —— 待处理覆盖层状态：pending 表示本地有未同步的语义改动；
  // lastProposal 保留最近一次被远端权威提交覆盖（或已提交）的本地改动，供冲突后「恢复」重新应用（lost-work guard）。
  const pending = ref(false);
  const lastProposal = ref<{ graph: RoomGraph; baseRevision: number } | undefined>();
  const canReapply = computed(() => !!lastProposal.value && !pending.value);
  // 本地编辑信号基线：与画布 localEditSignal 比较得出 pending（远端收敛/初始装载会重置基线）。
  let baselineEdits = 0;
  function rebase() { baselineEdits = options.editSignal?.() ?? 0; pending.value = false; }

  const baseHeaders = () => ({ "x-toonflow-workspace": "1", "Accept-Language": locale.value });

  // 按 revision 幂等应用一张已提交图：仅当比本地已应用版本新时才落到实时画布，重复/回环广播被安全跳过。
  function applyCommitted(committed?: { revision: number; graph: RoomGraph } | null) {
    if (!committed || typeof committed.revision !== "number" || !committed.graph) return;
    if (committed.revision <= lastAppliedRevision) return;
    // ACT: 计划 Task 11 —— 本地若有未提交改动即将被远端权威版本覆盖，先留存以便冲突后恢复（lost-work guard）。
    if (pending.value && !lastProposal.value) {
      const local = options.getGraph?.();
      if (local) lastProposal.value = { graph: local, baseRevision: lastAppliedRevision };
    }
    lastAppliedRevision = committed.revision;
    options.applyGraph?.(committed.graph);
    // ACT: 计划 Task 11 —— 若收敛到的权威图正是本机提交的提案（被采纳），清除留存，避免误显「恢复」。
    if (lastProposal.value && semanticKey(lastProposal.value.graph) === semanticKey(committed.graph)) lastProposal.value = undefined;
    rebase();
  }

  async function postState(room: string, signal: AbortSignal) {
    const context = options.getCanvasContext();
    const canvas = context ? { id: context.id, tools: context.tools } : null;
    const response = await fetch("/api/matrix/spoke/state", {
      method: "POST",
      headers: { ...baseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ room, spokeId, canvas, capabilities: options.capabilities?.() }),
      signal,
    }).catch(() => undefined);
    // ACT: 计划 Task 10 —— 初始收敛：服务器在状态回执里回带房间已提交工作流图，比本地新则应用到实时画布。
    if (!response) return;
    const json = await response.json().catch(() => null) as { data?: { workflow?: { revision: number; graph: RoomGraph } | null } } | null;
    applyCommitted(json?.data?.workflow);
    // ACT: 计划 Task 11 —— 初始收敛后，等画布装载/回落触发的 post-flush 监听器 settles，再把当前信号设为基线，
    // 避免把「装载画布」误判成本地未同步改动。
    await nextTick();
    rebase();
  }

  async function postResult(room: string, callId: string, body: Record<string, unknown>) {
    await fetch("/api/matrix/spoke/result", {
      method: "POST",
      headers: { ...baseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ room, callId, ...body }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    }).catch(() => {});
  }

  // ACT: 计划 Task 10 —— 把当前实时语义图上报给服务器提交并扇出。用回执里的 revision 对齐本地 lastApplied，
  // 使随后广播回自身的那一条被幂等跳过（本机正是该图来源）。失败静默：扇出尽力而为，不影响画布调用本身。
  async function reportGraph(room: string) {
    const graph = options.getGraph?.();
    if (!graph) return;
    const response = await fetch("/api/matrix/spoke/graph", {
      method: "POST",
      headers: { ...baseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ room, spokeId, graph }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    }).catch(() => undefined);
    if (!response) return;
    const json = await response.json().catch(() => null) as { data?: { revision?: number } } | null;
    const revision = json?.data?.revision;
    if (typeof revision === "number" && revision > lastAppliedRevision) lastAppliedRevision = revision;
    // ACT: 计划 Task 11 —— 编排器驱动的变更经上报已成为房间权威图：重置本地编辑基线并清除留存，
    // 避免把这次权威变更（同样会触发 localEditSignal）误判为本地待处理覆盖层。
    if (response.ok) { await nextTick(); rebase(); lastProposal.value = undefined; }
  }

  // ACT: 计划 Task 11 —— update：把当前本地待处理覆盖层（整张语义图）作为提案提交到房间。
  // 服务器暂存提案并回带 proposalId；随后自动在房间时间线发一条讨论消息（announce），
  // 触发编排器与其他成员讨论。本地改动仍为 pending，直到编排器采纳并广播新权威图才收敛。
  async function proposeUpdate(): Promise<string | undefined> {
    const room = currentRoom || options.roomId();
    const graph = options.getGraph?.();
    if (!room || !graph) return undefined;
    const baseRevision = lastAppliedRevision;
    const response = await fetch("/api/matrix/spoke/proposal", {
      method: "POST",
      headers: { ...baseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ room, spokeId, baseRevision, graph }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    }).catch(() => undefined);
    if (!response) return undefined;
    const json = await response.json().catch(() => null) as { data?: { proposalId?: string } } | null;
    const proposalId = json?.data?.proposalId;
    if (!proposalId) return undefined;
    lastProposal.value = { graph, baseRevision };
    await options.announce?.(`我提议更新工作流图，请大家一起讨论；请客服 Agent 审核后决定是否采纳。（提案编号：${proposalId}）`);
    return proposalId;
  }

  // ACT: 计划 Task 11 —— synchronize：重新拉取房间已提交工作流图并强制回落（即使 revision 不比本地新），
  // 丢弃本地待处理覆盖层，回到编排器已同意的最新权威版本（讨论中或提案未被采纳时的回滚）。
  async function synchronize(): Promise<void> {
    const room = currentRoom || options.roomId();
    if (!room) return;
    const response = await fetch(`/api/matrix/spoke/graph?room=${encodeURIComponent(room)}`, {
      headers: baseHeaders(),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    }).catch(() => undefined);
    const json = await response?.json().catch(() => null) as { data?: { workflow?: { revision: number; graph: RoomGraph } | null } } | null;
    const committed = json?.data?.workflow;
    if (committed && typeof committed.revision === "number" && committed.graph) {
      if (committed.revision > lastAppliedRevision) lastAppliedRevision = committed.revision;
      options.applyGraph?.(committed.graph);
    }
    lastProposal.value = undefined;
    await nextTick();
    rebase();
  }

  // ACT: 计划 Task 11 —— lost-work guard：把最近被远端提交覆盖的本地改动重新应用回画布，恢复为待处理覆盖层，
  // 供用户在最新权威版本之上重新「更新」提交（此时会以最新 revision 作为新基线）。
  function reapplyProposal() {
    const proposal = lastProposal.value;
    if (!proposal) return;
    options.applyGraph?.(proposal.graph);
    baselineEdits = (options.editSignal?.() ?? 0) - 1;
    pending.value = true;
  }

  async function execute(room: string, event: CanvasCallEvent, signal: AbortSignal) {
    const controller = new AbortController();
    const callSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120000)]);
    try {
      callSignal.throwIfAborted();
      const context = options.getCanvasContext();
      if (!context) throw Object.assign(new Error("当前页面没有激活的画布"), { code: "CANVAS_UNAVAILABLE" });
      const result = await context.call({ name: event.name, args: event.args }, callSignal);
      await postResult(room, event.callId, { result: result ?? null });
      // ACT: 计划 Task 10 —— 编排器下发的语义图变更执行成功后，上报实时图供服务器提交并广播给所有辐条。
      if (!isCanvasRead(event.name) && !NON_GRAPH_OPS.has(event.name)) await reportGraph(room);
    } catch (error) {
      if (callSignal.aborted && signal.aborted) return; // 辐条整体停用，无需回传
      const unavailable = (error as { code?: string })?.code === "CANVAS_UNAVAILABLE";
      const message = (error instanceof Error && error.message ? error.message : "画布操作失败").slice(0, 8000);
      await postResult(room, event.callId, { error: message, unavailable });
    }
  }

  // 建立一次连接并处理事件流；返回是否应重连（被顶替时不再重连，避免两个标签页来回抢占）。
  async function connectOnce(room: string, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`/api/matrix/spoke/events?room=${encodeURIComponent(room)}&spokeId=${encodeURIComponent(spokeId)}`, { headers: baseHeaders(), signal });
      if (!response.ok || !response.body) throw new Error(`辐条连接失败（${response.status}）`);
      await postState(room, signal);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      let data: string[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          pending += value;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "");
            if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            if (line || !data.length) continue;
            const event = JSON.parse(data.join("\n")) as SpokeEvent;
            data = [];
            if (event.type === "replaced") return false;
            // ACT: 计划 Task 10 —— 收到已提交图广播：按 revision 幂等收敛到实时画布（不阻塞事件流）。
            if (event.type === "graph") { applyCommitted(event); continue; }
            // 服务器编排器串行下发画布调用：逐条 await 执行，天然保证图变更顺序。
            if (event.type === "canvasCall") await execute(room, event, signal);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return true;
    } catch (error) {
      if (!signal.aborted) console.warn("[spoke] 画布辐条连接中断", error);
      return !signal.aborted;
    }
  }

  async function run(room: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const shouldReconnect = await connectOnce(room, signal);
      if (signal.aborted || !shouldReconnect) break;
      await new Promise<void>(resolve => { reconnect = setTimeout(resolve, 3000); });
      reconnect = undefined;
    }
  }

  function teardown() {
    if (reconnect) { clearTimeout(reconnect); reconnect = undefined; }
    connection?.abort();
    connection = undefined;
    currentRoom = "";
    lastAppliedRevision = 0;
    pending.value = false;
    lastProposal.value = undefined;
    baselineEdits = 0;
  }

  function ensure() {
    const room = options.roomId();
    if (!options.active() || !room) { teardown(); return; }
    if (room === currentRoom && connection) return; // 已连到该房间
    teardown();
    currentRoom = room;
    const controller = new AbortController();
    connection = controller;
    void run(room, AbortSignal.any([lifetime.signal, controller.signal]));
  }

  watch(() => [options.active(), options.roomId()], ensure, { immediate: true });
  // 切换画布后重新上报上下文，使编排器拿到最新的画布 id。
  watch(() => options.canvasId(), id => { if (id && currentRoom && connection) void postState(currentRoom, lifetime.signal); });
  // ACT: 计划 Task 11 —— 本地语义编辑信号变化 → 重新计算待处理覆盖层（与基线不一致即为未同步）。
  watch(() => options.editSignal?.() ?? 0, value => { pending.value = value !== baselineEdits; });
  // ACT: 计划 Task 13 —— 设备能力变化（如本地模型配置保存、invokeLocalModels 授权开关切换）→ 重新上报状态，
  // 使服务器端 listRoomSpokes 的能力广告（localModel）随授权实时更新，编排器据此决定是否把本地模型任务派给本机。
  watch(() => options.capabilities?.(), () => { if (currentRoom && connection) void postState(currentRoom, lifetime.signal); }, { deep: true });

  onScopeDispose(() => {
    teardown();
    lifetime.abort(new Error("工作室已关闭"));
  });

  return { pending, canReapply, proposeUpdate, synchronize, reapplyProposal };
}
