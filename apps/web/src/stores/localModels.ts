import { computed, ref } from "vue";
import { LOCAL_PROVIDER_ID, invalidateNodeModels, setLocalModelConfig, type LocalModelConfig, type LocalModelEntry } from "@toonflow/nodes-scaffold/nodeAi";

// ACT: 计划 Task 12 —— 浏览器直连本地模型的「按用户、存本地」配置。
// 与服务端 customProviders（保存到服务器、跨设备共享）不同：本地端点只在当前浏览器可见，
// 因为每台设备的防火墙内网可达性不同（手机/平板/电脑各自的 localhost 与内网地址）。
const STORAGE_KEY = "toonflow.localModels";

export type LocalModelProvider = {
  id: string;
  label: string;
  apiUrl: string;
  apiKey: string;
  protocol: string;
  models: LocalModelEntry[];
};

function normalizeEntry(raw: unknown): LocalModelEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return undefined;
  return {
    id: item.id.trim(),
    label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : item.id.trim(),
    ...(typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) ? { contextWindow: item.contextWindow } : {}),
    ...(typeof item.maxOutputTokens === "number" && Number.isFinite(item.maxOutputTokens) ? { maxOutputTokens: item.maxOutputTokens } : {}),
  };
}

function normalizeConfig(raw: unknown): LocalModelConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.baseUrl !== "string" || !item.baseUrl.trim()) return undefined;
  const models = Array.isArray(item.models) ? item.models.map(normalizeEntry).filter((model): model is LocalModelEntry => !!model) : [];
  return {
    baseUrl: item.baseUrl.trim(),
    ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
    ...(typeof item.apiKey === "string" && item.apiKey.trim() ? { apiKey: item.apiKey } : {}),
    models,
  };
}

function load(): LocalModelConfig | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return undefined;
  }
}

export const localModelConfig = ref<LocalModelConfig | undefined>(load());

// ACT: 模块加载即把已存配置写入 nodeAi 的 globalThis 共享槽，供各独立 UMD 节点读取。
setLocalModelConfig(localModelConfig.value);

export function saveLocalModelConfig(config: LocalModelConfig | undefined) {
  const normalized = normalizeConfig(config);
  localModelConfig.value = normalized;
  try {
    if (normalized) localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 忽略隐私模式等写入失败：内存配置仍然生效 */ }
  setLocalModelConfig(normalized);
  invalidateNodeModels("language");
}

export const localProvider = computed<LocalModelProvider | undefined>(() => {
  const config = localModelConfig.value;
  if (!config || !config.models.length) return undefined;
  return {
    id: LOCAL_PROVIDER_ID,
    label: config.label?.trim() || "本地模型",
    apiUrl: config.baseUrl,
    apiKey: config.apiKey ?? "",
    protocol: "openai-completions",
    models: config.models,
  };
});

export const localModelChoices = computed(() => (localProvider.value
  ? localProvider.value.models.map(model => ({
    value: JSON.stringify([LOCAL_PROVIDER_ID, model.id]),
    providerId: LOCAL_PROVIDER_ID,
    modelId: model.id,
    label: model.label,
    contextWindow: model.contextWindow,
    reasoningLevels: undefined,
  }))
  : []));

// ACT: 从浏览器直接探测本地 OpenAI 兼容端点的 /models，用于「获取模型」。
// 与生成调用受同样的 CORS / 混合内容 / 私有网络访问约束；失败时由调用方提示改用本地代理。
export async function discoverLocalModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<LocalModelEntry[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("请先填写本地服务地址");
  const url = /\/models$/.test(base) ? base : `${base}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      signal: signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`无法连接本地端点（${base}）：可能是 CORS 未放行本应用来源、混合内容被浏览器拦截，或需要私有网络访问授权；可在本地运行一个转发代理后将其地址填入。原始错误：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）`);
  const payload = await response.json() as { data?: { id?: string }[] };
  const models = Array.isArray(payload.data)
    ? payload.data.map(item => normalizeEntry({ id: item?.id, label: item?.id })).filter((item): item is LocalModelEntry => !!item)
    : [];
  if (!models.length) throw new Error("本地端点未返回可用模型");
  return models;
}
