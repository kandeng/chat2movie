<template>
  <div class="localModel">
    <section class="settingSection">
      <h3>浏览器直连本地模型</h3>
      <p class="description">
        让本设备的辐条直接调用防火墙内的 OpenAI 兼容模型（如本机或局域网内的推理服务），请求不经过 vidsay 服务端。
        此配置仅保存在当前浏览器（localStorage），不会上传，也不会同步到其他设备——因为每台设备可达的内网地址不同。
      </p>
    </section>

    <section class="settingSection">
      <el-form class="configForm" labelPosition="top">
        <el-form-item label="名称（可选）">
          <el-input v-model="draft.label" maxlength="40" placeholder="本地模型" aria-label="本地模型名称" />
        </el-form-item>
        <el-form-item label="服务地址">
          <el-input v-model="draft.baseUrl" placeholder="http://127.0.0.1:11434/v1" aria-label="本地服务地址" />
          <p class="hint">填写 OpenAI 兼容根地址（含 /v1）；生成时会自动追加 /chat/completions，获取模型时追加 /models。</p>
        </el-form-item>
        <el-form-item label="API Key（可选）">
          <el-input v-model="draft.apiKey" type="password" showPassword placeholder="sk-..." aria-label="本地服务密钥" />
        </el-form-item>
      </el-form>
    </section>

    <section class="settingSection">
      <div class="settingHeader">
        <h3>模型列表</h3>
        <el-space wrap>
          <el-button text :icon="IconRefresh" :loading="discovering" :disabled="!draft.baseUrl.trim()" @click="discover">获取模型</el-button>
          <el-button text type="danger" :icon="IconTrash" :disabled="!draft.models.length" @click="draft.models = []">清空</el-button>
        </el-space>
      </div>
      <div class="addRow">
        <el-input v-model="newModelId" maxlength="120" placeholder="手动添加模型 ID，如 qwen2.5:7b" aria-label="模型 ID" @keyup.enter="addModel" />
        <el-button :icon="IconPlus" :disabled="!newModelId.trim()" @click="addModel">添加</el-button>
      </div>
      <ul v-if="draft.models.length" class="modelList">
        <li v-for="model in draft.models" :key="model.id" class="modelItem">
          <code class="modelId" :title="model.id">{{ model.id }}</code>
          <el-input v-model="model.label" class="modelLabel" size="small" maxlength="60" :aria-label="`模型 ${model.id} 的显示名`" />
          <el-button text type="danger" :icon="IconTrash" :aria-label="`移除模型 ${model.id}`" @click="removeModel(model.id)" />
        </li>
      </ul>
      <p v-else class="description">尚未添加模型。可点击「获取模型」自动探测，或在上方手动填写模型 ID。</p>
    </section>

    <section class="settingSection">
      <div class="saveRow">
        <el-button type="primary" :disabled="!canSave" @click="save">保存</el-button>
        <el-button :disabled="!saved" @click="disable">停用本地模型</el-button>
      </div>
    </section>

    <section class="settingSection">
      <h3>连不上本地模型？</h3>
      <p class="description">
        浏览器直连受三重限制：本地服务必须放行本应用来源的 CORS；若本应用通过 HTTPS 访问，浏览器会拦截对 HTTP 本地端点的混合内容请求（需为本地服务配置 TLS，或改用本地代理）；访问私网地址还可能触发私有网络访问（PNA）预检。
      </p>
      <p class="description">
        兜底方案：在本机运行一个「瘦本地代理」——它监听浏览器可达的地址，为响应补上 CORS 头并把请求原样转发到真实模型端点；
        然后把代理地址填入上方「服务地址」即可。该代理需按具体部署单独验证。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { IconPlus, IconRefresh, IconTrash } from "@tabler/icons-vue";
import type { LocalModelEntry } from "@toonflow/nodes-scaffold/nodeAi";
import { discoverLocalModels, localModelConfig, saveLocalModelConfig } from "@/stores/localModels";

const draft = reactive<{ label: string; baseUrl: string; apiKey: string; models: LocalModelEntry[] }>({
  label: localModelConfig.value?.label ?? "",
  baseUrl: localModelConfig.value?.baseUrl ?? "",
  apiKey: localModelConfig.value?.apiKey ?? "",
  models: (localModelConfig.value?.models ?? []).map(model => ({ ...model })),
});
const newModelId = ref("");
const discovering = ref(false);
const saved = computed(() => !!localModelConfig.value);
const canSave = computed(() => !!draft.baseUrl.trim() && draft.models.length > 0);

function addModel() {
  const id = newModelId.value.trim();
  if (!id) return;
  if (draft.models.some(model => model.id === id)) { ElMessage.warning("该模型已在列表中"); return; }
  draft.models.push({ id, label: id });
  newModelId.value = "";
}

function removeModel(id: string) {
  draft.models = draft.models.filter(model => model.id !== id);
}

async function discover() {
  if (discovering.value) return;
  discovering.value = true;
  try {
    const models = await discoverLocalModels(draft.baseUrl, draft.apiKey);
    for (const model of models) {
      const existing = draft.models.find(item => item.id === model.id);
      if (!existing) draft.models.push(model);
    }
    ElMessage.success(`已获取 ${models.length} 个模型`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "获取模型失败，请重试");
  } finally {
    discovering.value = false;
  }
}

function save() {
  if (!canSave.value) return;
  saveLocalModelConfig({
    baseUrl: draft.baseUrl.trim(),
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
    models: draft.models.map(model => ({ ...model, label: model.label.trim() || model.id })),
  });
  ElMessage.success("已保存本地模型配置");
}

function disable() {
  saveLocalModelConfig(undefined);
  draft.models = [];
  ElMessage.success("已停用浏览器直连本地模型");
}
</script>

<style lang="scss" scoped>
.localModel {
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
      gap: 12px;

      h3 { margin: 0; }
    }

    .description {
      margin: 8px 0 0;
      color: var(--el-text-color-secondary);
      font-size: 13px;
      line-height: 1.6;
    }

    .configForm {
      max-width: 560px;

      .hint {
        margin: 6px 0 0;
        color: var(--el-text-color-secondary);
        font-size: 12px;
        line-height: 1.5;
      }
    }

    .addRow {
      display: flex;
      gap: 8px;
      max-width: 560px;
      margin-top: 12px;
    }

    .modelList {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 560px;
      margin: 12px 0 0;
      padding: 0;
      list-style: none;

      .modelItem {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;

        .modelId {
          overflow: hidden;
          color: var(--el-text-color-regular);
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: monospace;
          font-size: 12px;
        }
      }
    }

    .saveRow {
      display: flex;
      gap: 8px;
    }
  }
}
</style>
