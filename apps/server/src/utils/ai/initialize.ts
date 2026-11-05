import conf from "@/utils/conf";
import { getConfigApiKey } from "@/utils/appConfig";
import { fetchProviderModels } from "@/utils/ai/models";

let initialization: Promise<void> | undefined;

function normalizeApiKey(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
}

// ACT: 优先使用 config.json 托管的密钥（providers.<id>.apiKey），其次才是 settings 中存储的密钥。
function resolveProviderApiKey(provider?: { id?: unknown; apiKey?: unknown }) {
  if (!provider || typeof provider.id !== "string") return "";
  return normalizeApiKey(getConfigApiKey(provider.id) || provider.apiKey);
}

function asProviderList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function providerLabel(provider: Record<string, unknown>): string {
  return typeof provider.label === "string" && provider.label.trim() ? provider.label : String(provider.id ?? "供应商");
}

function hasFetchableEndpoint(provider: Record<string, unknown>): boolean {
  return typeof provider.apiUrl === "string" && URL.canParse(provider.apiUrl) && typeof provider.protocol === "string";
}

// ACT: 逐个刷新「模型为空」或「密钥相对上次变化」的文本供应商——覆盖内置 aiRouter 与 config.json
// 声明的任意兼容供应商，按各自 protocol（openai-completions/openai-responses/anthropic-messages）动态拉取模型。
async function refreshLanguageModels(previousSettings?: Record<string, unknown>) {
  const current = asProviderList(conf.get("settings.customProviders"));
  const previous = asProviderList(previousSettings?.customProviders);
  const targets = current.filter(provider => {
    if (!hasFetchableEndpoint(provider)) return false;
    const apiKey = resolveProviderApiKey(provider);
    if (!apiKey) return false;
    if (!Array.isArray(provider.models) || provider.models.length === 0) return true;
    const before = previous.find(item => item.id === provider.id);
    return !!before && resolveProviderApiKey(before) !== apiKey;
  });
  const errors: string[] = [];
  let changed = false;
  for (const target of targets) {
    const label = providerLabel(target);
    try {
      const models = await fetchProviderModels({
        apiUrl: String(target.apiUrl), protocol: String(target.protocol), apiKey: resolveProviderApiKey(target),
      });
      if (!models.length) { errors.push(`${label} 未获取到文本模型，保留原有列表`); continue; }
      // ACT: 重新读取最新列表并按 id 定位，保留用户已有的 reasoningEfforts 等本地编辑。
      const list = asProviderList(conf.get("settings.customProviders"));
      const index = list.findIndex(item => item.id === target.id);
      if (index === -1) continue;
      const item = list[index]!;
      list[index] = { ...item, models: models.map(model => {
        const saved = Array.isArray(item.models)
          ? (item.models as { id?: string; reasoningEfforts?: unknown }[]).find(existing => existing?.id === model.id)
          : undefined;
        return saved?.reasoningEfforts === undefined ? model : { ...model, reasoningEfforts: saved.reasoningEfforts };
      }) };
      conf.set("settings.customProviders", list);
      changed = true;
    } catch (reason) {
      errors.push(`${label} 文本模型更新失败：${reason instanceof Error ? reason.message : "未知错误"}`);
    }
  }
  return { changed, errors };
}

export async function refreshProviderModels(previousSettings?: Record<string, unknown>) {
  // ACT: aiRouter 媒体模型为静态配置（无 modelsUrl），无需在此自动刷新；仅刷新文本模型。
  const result = await refreshLanguageModels(previousSettings).catch((reason: unknown) => ({
    changed: false, errors: [`文本模型更新失败：${reason instanceof Error ? reason.message : "未知错误"}`],
  }));
  return {
    ...(result.changed ? { customProviders: conf.get("settings.customProviders") as Record<string, unknown>[] } : {}),
    ...(result.errors.length ? { modelRefreshErrors: result.errors } : {}),
  };
}

export default function initializeProviderModels() {
  // ACT: 每个进程启动时仅尝试一次；失败保留已有模型，下次启动再更新。
  return initialization ??= refreshProviderModels().then(result => {
    result.modelRefreshErrors?.forEach(error => console.warn(error));
  });
}
