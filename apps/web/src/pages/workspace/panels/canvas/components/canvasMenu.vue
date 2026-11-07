<template>
  <panel class="canvasMenuPanel" position="top-left">
    <div class="menuExtension"><slot /></div>
  </panel>
  <panel v-if="visibleProviderBalances.length" class="balanceMenuPanel" position="top-right">
    <div class="balanceList" tabindex="0" aria-label="供应商余额">
      <el-card v-for="item in visibleProviderBalances" :key="item.id" class="balanceCard" shadow="never" :bodyStyle="{ padding: '2px 4px' }">
        <el-popover v-if="item.id === 'tfRouter'" :visible="balanceVisible" @update:visible="value => { if (!rechargeVisible) balanceVisible = value; }" trigger="click" placement="bottom-end" :width="360" :showArrow="false">
          <template #reference>
            <el-button class="balanceTrigger" text :aria-busy="item.loading" :title="item.error || 'TF-Router 剩余可用余额'" aria-label="TF-Router 余额与充值">
              <span class="providerLabel">{{ item.label }}</span>
              <span>{{ item.balance ? `${balanceFormat.format(Math.min(item.balance.balance, item.balance.keyBalance ?? Infinity))} ${item.balance.unit}` : '—' }}</span>
            </el-button>
          </template>
          <tfAccount v-if="balanceVisible" :apiKey="tfBalanceApiKey" :visible="balanceVisible" :saveApiKey="saveTfMediaApiKey" @rechargeVisibleChange="rechargeVisible = $event" />
        </el-popover>
        <el-button v-else class="balanceTrigger" text :loading="item.loading" :title="item.error || `点击刷新 ${item.label} 余额`" :aria-label="`刷新 ${item.label} 余额`" @click="refreshProviderBalance(item.id)">
          <span class="providerLabel">{{ item.label }}</span>
          <span>{{ item.balance ? `${balanceFormat.format(Math.min(item.balance.balance, item.balance.keyBalance ?? Infinity))} ${item.balance.unit}` : '—' }}</span>
        </el-button>
      </el-card>
    </div>
  </panel>
</template>

<script setup lang="ts">
import axios from "axios";
import { locale } from "@toonflow/i18n/vue";
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ShallowRef } from "vue";
import { Panel, useVueFlow, type FlowExportObject } from "@vue-flow/core";
import { ElMessage } from "element-plus";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import tfAccount from "@/components/settings/tfAccount.vue";
import { providerBalances, tfBalanceApiKey, saveTfMediaApiKey, refreshProviderBalance } from "@/lib/providerBilling";

// ACT: 单画布模型（Task 3）——移除项目名输入与多画布选择/新建/重命名/移动/删除 UI，仅保留：
// 供应商余额面板、素材库插槽，以及「恰好打开一个画布」的引导逻辑（目录内无画布时自动新建默认「画布1」）。
const props = defineProps<{
  directory?: string;
  initialCanvasId?: string;
  activateCanvas?: (id: string, signal?: AbortSignal) => Promise<void>;
  flushSave: (action?: () => Promise<void>) => Promise<void>;
}>();

const balanceVisible = ref(false);
const rechargeVisible = ref(false);
const balanceFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 6 }));
const visibleProviderBalances = computed(() => providerBalances.value.filter(item => item.id !== "tfRouter" || (item.balance && !item.error)));

type Canvas = { id: string; name: string; flow?: Pick<FlowExportObject, "nodes" | "edges" | "viewport"> };
const canvases = inject<ShallowRef<Canvas[]>>("canvasList", shallowRef<Canvas[]>([]));
const boundCanvas = shallowRef<Canvas>();
const activeCanvasId = defineModel<string>("canvasId", { default: "" });
watch(canvases, () => {
  if (boundCanvas.value) activeCanvasId.value = canvases.value.includes(boundCanvas.value) ? boundCanvas.value.id : "";
}, { flush: "sync" });
const busy = ref(false);
const initialized = ref(false);
const loadError = ref("");
const { toObject, setNodes, setEdges, setViewport } = useVueFlow();
let controller = new AbortController();
onBeforeUnmount(() => controller.abort());

function errorMessage(err: unknown, fallback: string) {
  return axios.isAxiosError<{ message?: string }>(err) ? err.response?.data.message || fallback : err instanceof Error ? err.message : fallback;
}

function mergeCanvases(loaded: Canvas[]) {
  const known = new Set(canvases.value.map(canvas => canvas.id));
  const added = loaded.filter(canvas => !known.has(canvas.id));
  if (added.length) canvases.value = [...canvases.value, ...added];
}

function peekCanvases() {
  return canvases.value.map(({ id, name }) => ({ id, name }));
}

function getCanvasDirectory(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!props.directory) throw new Error("请先选择工作目录");
  if (busy.value) throw new Error("画布正在加载或编辑，请稍后重试");
  return props.directory;
}

function checkCanvasDirectory(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (props.directory !== directory) throw new Error("工作目录已切换，本次画布操作已停止");
}

async function listCanvasEntries(directory: string, path = "", recursive = false, signal?: AbortSignal) {
  const files = useWorkspaceFiles(directory);
  const { entries, empty } = await files.list(path, signal);
  // ACT: 每次只读当前一层；完整查询仅由 Agent 列举显式触发。递归展开时跳过素材/Agent 保留目录。
  for (let index = 0; index < entries.length; index++) {
    checkCanvasDirectory(directory, signal);
    const entry = entries[index]!;
    if (entry.type !== "directory" || ["assets", ".agent"].includes(entry.name.toLowerCase())) continue;
    if (recursive) {
      const children = await files.list(entry.path, signal);
      entries.push(...children.entries);
    }
  }
  return { entries, empty };
}

async function listCanvases(directory: string, path = "", recursive = false, signal?: AbortSignal) {
  const files = useWorkspaceFiles(directory);
  const { entries } = await listCanvasEntries(directory, path, recursive, signal);
  const loaded = await Promise.all(entries.filter(entry => entry.type === "file" && /\.json$/i.test(entry.name)).map(async entry => {
    if (!(await isCanvasFile(files, entry.path, signal))) return null;
    return { id: entry.path, name: entry.name.slice(0, -5) };
  }));
  return {
    canvases: loaded.filter(canvas => canvas !== null).sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true })),
  };
}

async function getCanvases(signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  const callSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const loaded = await listCanvases(directory, "", true, callSignal);
  checkCanvasDirectory(directory, callSignal);
  mergeCanvases(loaded.canvases);
  return loaded.canvases.map(({ id, name }) => ({ id, name }));
}

function normalizeCanvasName(name: string, label = "画布") {
  name = name.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(label === "文件夹" ? "文件夹名称不是有效文件名" : "画布名称不是有效文件名");
  }
  return name;
}

async function createCanvasFile(directory: string, name?: string, signal?: AbortSignal) {
  if (name !== undefined) name = normalizeCanvasName(name);
  const files = useWorkspaceFiles(directory);
  const flow = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  for (let number = 1; ; number++) {
    checkCanvasDirectory(directory, signal);
    const canvasName = name ?? `画布${number}`;
    const id = `${canvasName}.json`;
    try {
      await files.writeJson(id, { toonflowCanvas: true, ...flow }, true);
      return { id, name: canvasName, flow };
    } catch (err) {
      if (name !== undefined || !axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
    }
  }
}

async function applyCanvas(canvasId: string, directory: string, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const nextCanvas = canvases.value.find(canvas => canvas.id === canvasId);
  const currentCanvas = canvases.value.find(canvas => canvas.id === activeCanvasId.value);
  if (!nextCanvas) throw new Error("画布不存在，请重新获取画布列表");
  if (nextCanvas === currentCanvas) return;
  if (currentCanvas && props.activateCanvas) {
    await props.activateCanvas(canvasId, signal);
    checkCanvasDirectory(directory, signal);
    return;
  }
  if (!nextCanvas.flow) {
    const data = await useWorkspaceFiles(directory).readJson<Partial<NonNullable<Canvas["flow"]>> & { toonflowCanvas?: boolean } | null>(nextCanvas.id);
    checkCanvasDirectory(directory, signal);
    if (data?.toonflowCanvas !== true || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.viewport
      || ![data.viewport.x, data.viewport.y, data.viewport.zoom].every(Number.isFinite) || data.viewport.zoom <= 0) throw new Error("画布文件格式无效");
    // 旧画布可能保存了临时导出进度，重新打开时任务已不存在。
    for (const node of data.nodes) if (node.type === "remote-videoNode" && node.data) delete node.data.exportProgress;
    nextCanvas.flow = { nodes: data.nodes, edges: data.edges, viewport: data.viewport };
  }
  await props.flushSave();
  checkCanvasDirectory(directory, signal);
  if (currentCanvas) currentCanvas.flow = toObject();
  // 应用画布数据时暂时清空文件名，避免初始化触发自动保存。
  activeCanvasId.value = "";
  setNodes(nextCanvas.flow.nodes);
  // 命中宽度由画布统一配置，不使用旧文件中的覆盖值。
  setEdges(nextCanvas.flow.edges.map(({ interactionWidth, ...edge }) => edge));
  await setViewport(nextCanvas.flow.viewport);
  await nextTick();
  checkCanvasDirectory(directory);
  boundCanvas.value = nextCanvas;
  activeCanvasId.value = nextCanvas.id;
  signal?.throwIfAborted();
}

// ACT: 单画布引导（Task 3）：进入/切换工作目录时确保恰好打开一个画布；目录内无画布则新建默认「画布1」。
watch(() => props.directory, async (directory, _previous, onCleanup) => {
  let cancelled = false;
  controller.abort();
  const current = new AbortController();
  controller = current;
  const signal = current.signal;
  onCleanup(() => { cancelled = true; current.abort(); });
  initialized.value = false;
  busy.value = true;
  loadError.value = "";
  boundCanvas.value = undefined;
  activeCanvasId.value = "";
  try {
    if (props.initialCanvasId === undefined) canvases.value = [];
    if (!directory) return;
    if (props.initialCanvasId) {
      await applyCanvas(props.initialCanvasId, directory);
      return;
    }
    mergeCanvases((await listCanvases(directory, "", true, signal)).canvases);
    checkCanvasDirectory(directory, signal);
    if (cancelled) return;
    if (!canvases.value.length) {
      try {
        mergeCanvases([await createCanvasFile(directory, "画布1", signal)]);
        checkCanvasDirectory(directory, signal);
      } catch (err) {
        if (!axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
        // 同时打开工作区时，读取另一请求刚创建的默认画布，不覆盖同名文件。
        mergeCanvases((await listCanvases(directory, "", true, signal)).canvases);
        checkCanvasDirectory(directory, signal);
        if (!canvases.value.length) {
          mergeCanvases([await createCanvasFile(directory, undefined, signal)]);
          checkCanvasDirectory(directory, signal);
        }
      }
    }
    if (cancelled) return;
    if (canvases.value[0]) await applyCanvas(canvases.value[0].id, directory, signal);
  } catch (err) {
    if (!cancelled) {
      loadError.value = errorMessage(err, "读取画布失败");
      if (!props.initialCanvasId) ElMessage.error(loadError.value);
    }
  } finally {
    if (!cancelled) { busy.value = false; initialized.value = true; }
  }
}, { immediate: true });

function syncCanvasPath(previous: string, target: string) {
  if (activeCanvasId.value === previous) activeCanvasId.value = target;
}

function syncDocumentNode(canvasId: string, nodeId: string, handleId: string, text: string, inline: boolean) {
  const node = canvases.value.find(canvas => canvas.id === canvasId)?.flow?.nodes.find(node => node.id === nodeId);
  if (!node) return;
  const data = node.data ??= {};
  const output = data.outputs?.[handleId];
  if (output?.dataType === "STRING") output.value = text;
  else if (inline) (data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
}

defineExpose({ getCanvases, peekCanvases, initialized, syncCanvasPath, syncDocumentNode, loadError });
</script>

<style lang="scss" scoped>
.canvasMenuPanel.vue-flow__panel {
  left: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(50% - 90px);
}

.balanceMenuPanel.vue-flow__panel {
  max-width: calc(50% - 90px);

  .balanceList {
    display: flex;
    gap: 6px;
    max-width: 520px;
    overflow-x: auto;
    scrollbar-width: thin;

    .balanceCard {
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      .providerLabel { color: var(--el-text-color-secondary); font-size: 12px; }
      .balanceTrigger {
        height: 28px;
        padding: 0 3px;
        font-size: 13px;
        :deep(> span) { display: flex; align-items: center; gap: 4px; }
      }
    }
  }
}

@container canvasWorkspace (max-width: 1040px) {
  .balanceMenuPanel.vue-flow__panel {
    top: 50px;
    max-width: calc(100% - 30px);
  }
}

.menuExtension {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
}
</style>
