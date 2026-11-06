<template>
  <div class="chatToVideoPanel">
    <section class="settingSection" aria-labelledby="c2vEnabledTitle">
      <div class="settingHeader">
        <h3 id="c2vEnabledTitle">启用聊天转视频</h3>
        <el-switch :modelValue="config.enabled" :loading="saving" aria-label="启用聊天转视频" @change="(value) => persist({ enabled: value === true })" />
      </div>
      <p class="description">开启后，机器人 <code>{{ status?.botUserId || "@vidsay_bot" }}</code> 会监听群聊中的指令，把讨论内容生成视频并回帖到房间。需要先在 config.json 的 synapse 块完成配置。</p>
    </section>

    <section class="settingSection" aria-labelledby="c2vStatusTitle">
      <div class="settingHeader">
        <h3 id="c2vStatusTitle">机器人状态</h3>
        <el-button text :icon="IconRefresh" :loading="loading" :disabled="saving" @click="refreshStatus">刷新</el-button>
      </div>
      <el-alert v-if="statusError" :title="statusError" type="error" :closable="false" showIcon />
      <template v-else-if="status">
        <div class="stateRow">
          <el-tag :type="status.configured ? 'success' : 'info'" effect="plain">{{ status.configured ? "Synapse 已配置" : "Synapse 未配置" }}</el-tag>
          <el-tag :type="status.running ? 'success' : 'warning'" effect="plain">{{ status.running ? "机器人运行中" : "机器人未运行" }}</el-tag>
        </div>
        <ul class="stateList">
          <li><span>机器人账号</span><small>{{ status.botUserId || "未配置" }}</small></li>
          <li><span>目标房间</span><small>{{ status.roomId || "未配置" }}</small></li>
          <li><span>服务器名</span><small>{{ status.serverName || "未配置" }}</small></li>
        </ul>
      </template>
      <p class="description">机器人随主服务启动。修改启用状态或Synapse配置后需重启服务生效。</p>
    </section>

    <section class="settingSection" aria-labelledby="c2vModelTitle">
      <h3 id="c2vModelTitle">视频模型</h3>
      <el-select
        :modelValue="modelValue"
        placeholder="选择视频模型"
        filterable
        :loading="modelsLoading"
        :disabled="saving"
        style="width: 100%"
        @change="onModelChange">
        <el-option v-for="model in videoModels" :key="`${model.providerId}::${model.modelId}`" :label="`${model.providerLabel} · ${model.label}`" :value="`${model.providerId}::${model.modelId}`" />
      </el-select>
      <p class="description">仅列出已安装供应商的视频模型。当前选择：<code>{{ config.providerId }} / {{ config.modelId }}</code>。</p>
    </section>

    <section class="settingSection" aria-labelledby="c2vTriggerTitle">
      <h3 id="c2vTriggerTitle">触发与提示词</h3>
      <div class="fieldRow">
        <label for="c2vCommand">触发指令</label>
        <el-input id="c2vCommand" v-model="commandDraft" size="small" :disabled="saving" placeholder="!video" />
      </div>
      <div class="fieldRow">
        <label for="c2vLimit">参考消息条数</label>
        <el-input-number id="c2vLimit" v-model="limitDraft" :min="1" :max="100" :precision="0" controlsPosition="right" size="small" :disabled="saving" />
      </div>
      <div class="fieldRow">
        <label for="c2vOutput">输出目录</label>
        <el-input id="c2vOutput" v-model="outputDraft" size="small" :disabled="saving" placeholder="generated" />
      </div>
      <div class="actions">
        <el-button size="small" :loading="saving" @click="saveTrigger">保存</el-button>
      </div>
      <p class="description">机器人在群里收到以触发指令开头的消息（或包含“生成视频”）即开始出片；参考消息条数用于从近期讨论提炼提示词。</p>
    </section>

    <section class="settingSection" aria-labelledby="c2vNowTitle">
      <h3 id="c2vNowTitle">立即生成</h3>
      <el-input v-model="promptDraft" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="generating" placeholder="可选：直接填写视频提示词；留空则根据近期群聊讨论自动提炼。" aria-label="视频提示词" />
      <div class="actions">
        <el-button :icon="IconPlayerPlay" type="primary" :loading="generating" :disabled="!status?.running" @click="generateNow">生成视频</el-button>
      </div>
      <p class="description">生成结果将以 m.video 消息回帖到目标房间，耗时较长时请耐心等待。</p>
    </section>

    <section class="settingSection" aria-labelledby="c2vScheduleTitle">
      <div class="settingHeader">
        <h3 id="c2vScheduleTitle">定时生成</h3>
        <el-switch :modelValue="config.schedule.enabled" disabled aria-label="定时生成" />
      </div>
      <div class="fieldRow">
        <label for="c2vTime">每日时间</label>
        <el-input id="c2vTime" :modelValue="config.schedule.time" size="small" disabled placeholder="09:00" />
      </div>
      <p class="description">即将推出：定时自动出片当前仅保存配置、暂不调度，请使用手动触发。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { IconPlayerPlay, IconRefresh } from "@tabler/icons-vue";
import { saveSettings, settings } from "@/stores/settings";

const headers = { "x-toonflow-workspace": "1" };

type BotStatus = {
  configured: boolean;
  running: boolean;
  enabled: boolean;
  botUserId: string | null;
  roomId: string | null;
  serverName: string | null;
  providerId: string;
  modelId: string;
  command: string;
  recentMessageLimit: number;
};
type VideoModel = { providerId: string; providerLabel: string; modelId: string; label: string; type: string };
type ChatToVideoValue = {
  enabled: boolean;
  providerId: string;
  modelId: string;
  command: string;
  recentMessageLimit: number;
  outputDirectory: string;
  schedule: { enabled: boolean; time: string; timezone: string };
};

const config = computed(() => {
  const raw = settings.value.chatToVideo;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const schedule = value.schedule && typeof value.schedule === "object" && !Array.isArray(value.schedule) ? value.schedule as Record<string, unknown> : {};
  return {
    enabled: value.enabled !== false,
    providerId: typeof value.providerId === "string" && value.providerId ? value.providerId : "bailian",
    modelId: typeof value.modelId === "string" && value.modelId ? value.modelId : "wan3.0-video",
    command: typeof value.command === "string" && value.command.trim() ? value.command : "!video",
    recentMessageLimit: typeof value.recentMessageLimit === "number" ? value.recentMessageLimit : 20,
    outputDirectory: typeof value.outputDirectory === "string" && value.outputDirectory.trim() ? value.outputDirectory : "generated",
    schedule: {
      enabled: schedule.enabled === true,
      time: typeof schedule.time === "string" && schedule.time ? schedule.time : "09:00",
      timezone: typeof schedule.timezone === "string" ? schedule.timezone : "",
    },
  };
});

const status = ref<BotStatus>();
const statusError = ref("");
const loading = ref(false);
const saving = ref(false);
const generating = ref(false);
const videoModels = ref<VideoModel[]>([]);
const modelsLoading = ref(false);
const promptDraft = ref("");
const commandDraft = ref(config.value.command);
const limitDraft = ref(config.value.recentMessageLimit);
const outputDraft = ref(config.value.outputDirectory);
watch(() => config.value.command, value => { commandDraft.value = value; });
watch(() => config.value.recentMessageLimit, value => { limitDraft.value = value; });
watch(() => config.value.outputDirectory, value => { outputDraft.value = value; });

const modelValue = computed(() => `${config.value.providerId}::${config.value.modelId}`);

function errorMessage(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "操作失败";
}

// ACT: 统一以归一化后的当前值为基底合并补丁，避免遗漏未在本面板编辑的字段。
function persist(patch: Partial<ChatToVideoValue>) {
  return saveSettings(() => ({ chatToVideo: { ...config.value, ...patch } }));
}

async function refreshStatus() {
  loading.value = true;
  statusError.value = "";
  try {
    const { data } = await axios.get<{ code: number; data: BotStatus; message?: string }>("/api/matrix/status", { headers });
    if (data.code !== 200) throw new Error(data.message || "读取机器人状态失败");
    status.value = data.data;
  } catch (error) {
    statusError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function loadModels() {
  modelsLoading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: VideoModel[]; message?: string }>("/api/ai/media/models", { headers });
    if (data.code !== 200) throw new Error(data.message || "读取视频模型失败");
    videoModels.value = (data.data ?? []).filter(model => model.type === "video");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    modelsLoading.value = false;
  }
}

function onModelChange(value: string) {
  const [providerId, modelId] = value.split("::");
  if (!providerId || !modelId) return;
  void persist({ providerId, modelId }).then(refreshStatus).catch(error => ElMessage.error(errorMessage(error)));
}

async function saveTrigger() {
  const command = commandDraft.value.trim() || "!video";
  const outputDirectory = outputDraft.value.trim() || "generated";
  const limit = Number.isFinite(limitDraft.value) ? Math.min(100, Math.max(1, Math.round(limitDraft.value))) : 20;
  saving.value = true;
  try {
    await persist({ command, outputDirectory, recentMessageLimit: limit });
    ElMessage.success("已保存");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function generateNow() {
  generating.value = true;
  try {
    const body = promptDraft.value.trim() ? { prompt: promptDraft.value.trim() } : {};
    const { data } = await axios.post<{ code: number; message?: string }>("/api/matrix/generate", body, { headers });
    if (data.code !== 200) throw new Error(data.message || "触发生成失败");
    ElMessage.success(data.message || "已开始生成视频");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    generating.value = false;
  }
}

onMounted(() => { void refreshStatus(); void loadModels(); });
</script>

<style lang="scss" scoped>
.chatToVideoPanel {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px 8px;

  .settingSection {
    min-width: 0;

    h3 {
      margin: 0 0 12px;
      color: var(--el-text-color-primary);
      font-size: 14px;
      font-weight: 600;
    }

    .settingHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;

      h3 { margin: 0; }
    }

    .description {
      margin: 8px 0 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.6;

      code {
        padding: 1px 4px;
        border-radius: 4px;
        background: var(--el-fill-color-light);
        color: var(--el-text-color-regular);
      }
    }

    .stateRow, .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;

      .el-button { margin-left: 0; }
    }

    .stateList {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0;
      margin: 12px 0 0;
      list-style: none;

      li {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
        overflow-wrap: anywhere;

        small { flex-shrink: 0; color: var(--el-text-color-secondary); }
      }
    }

    .fieldRow {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      font-size: 12px;

      label {
        flex-shrink: 0;
        width: 96px;
        color: var(--el-text-color-regular);
      }

      .el-input, .el-input-number { flex: 1; }
      .el-input-number { max-width: 160px; }
    }
  }
}
</style>
