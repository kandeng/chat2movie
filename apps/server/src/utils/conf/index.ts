import conf from "conf";
import { mkdirSync, readdirSync, realpathSync } from "@toonflow/file";
import { resolve } from "node:path";
import aiRouter from "@toonflow/providers/language/aiRouter";
import { languageProviders } from "@toonflow/providers";
import { getProviderEntries, type ProviderEntry } from "@/utils/appConfig";
import type { RemoteTeam } from "@/utils/teams";
import type { A2aSettings } from "@/agent/a2a/settings";
import { normalizeNodeMenu, serializeNodeMenu } from "@/lib/nodeMenu";
import type { SavedMcpServer } from "@toonflow/mcp/client";

const autoInstallProviders = [aiRouter];
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
mkdirSync(dataDirectory, { recursive: true });
const configDirectory = realpathSync(dataDirectory);
process.env.TOONFLOW_DATA_DIR = configDirectory;

const config = new conf<{ settings: Record<string, unknown>; pluginInstalledAt: Record<string, number>; disabledSkills: string[]; mcpServers: SavedMcpServer[]; mcpBundles: Record<string, string>; toolConfigs: Record<string, Record<string, unknown>>; nodeConfigs: Record<string, Record<string, unknown>>; extConfigs: Record<string, Record<string, unknown>>; remoteConnections: Record<string, RemoteTeam>; a2a: A2aSettings }>({
  cwd: configDirectory,
  configName: "settings",
  configFileMode: 0o600,
  watch: true,
});

export function removeLegacySettings(settings: Record<string, unknown>) {
  let changed = false;
  // ACT: 只清理已废弃字段，保留其他设置和插件配置。
  for (const [record, key] of [[settings, "developerConfirmed"], [settings.general, "systemPrompt"], [settings.stores, "toonflow.developer"]] as const) {
    if (record && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, key)) {
      Reflect.deleteProperty(record, key);
      changed = true;
    }
  }
  return changed;
}

// ACT: 把旧的 tfRouter / bailian 供应商标识迁移到统一的 aiRouter：
// 1) settings.customProviders 中 id 为 tfRouter 的文本供应商重写为 aiRouter（id/label/icon/apiUrl/protocol）；
// 2) 清除失效的 settings.mediaProviderConfigs.tfRouter（媒体密钥改由 config.json 托管）；
// 3) settings.chatToVideo.providerId 的 bailian/tfRouter 改为 aiRouter。
export function migrateLegacyProviderIds(settings: Record<string, unknown>) {
  let changed = false;
  const providers = settings.customProviders;
  if (Array.isArray(providers)) {
    for (const item of providers) {
      if (item && typeof item === "object" && !Array.isArray(item)
        && typeof (item as { id?: unknown }).id === "string"
        && (item as { id: string }).id.toLowerCase() === "tfrouter") {
        Object.assign(item as Record<string, unknown>, {
          id: aiRouter.id, label: aiRouter.label, icon: aiRouter.icon,
          apiUrl: aiRouter.apiUrl, protocol: aiRouter.protocol,
        });
        changed = true;
      }
    }
  }
  const mediaConfigs = settings.mediaProviderConfigs;
  if (mediaConfigs && typeof mediaConfigs === "object" && !Array.isArray(mediaConfigs) && Object.hasOwn(mediaConfigs, "tfRouter")) {
    Reflect.deleteProperty(mediaConfigs, "tfRouter");
    changed = true;
  }
  const chatToVideo = settings.chatToVideo;
  if (chatToVideo && typeof chatToVideo === "object" && !Array.isArray(chatToVideo)) {
    const record = chatToVideo as Record<string, unknown>;
    if (typeof record.providerId === "string" && ["bailian", "tfrouter"].includes(record.providerId.toLowerCase())) {
      record.providerId = aiRouter.id;
      changed = true;
    }
  }
  return changed;
}

// ACT: 判定一个 config.json 条目是否声明为「纯配置文本供应商」。
// 仅当显式 kind:"language"，或未声明 kind 但带 protocol 且无 adapter 时成立；
// 裸 {apiKey,baseUrl}（如内置 aiRouter 密钥托管）不算，避免用 config.baseUrl 覆盖 preset 的 compatible-mode 地址。
function isConfigLanguageEntry(entry: ProviderEntry): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.enabled === false) return false;
  if (entry.adapter) return false;
  if (entry.kind === "media") return false;
  return entry.kind === "language" || typeof entry.protocol === "string";
}

// ACT: 把 config.json 声明的纯配置文本供应商 upsert 进 settings.customProviders（按 id）：
// apiUrl=baseUrl、protocol、label、icon、version 来自 config（缺省时回退到同名 preset 或 id）；
// models 仅在 config 显式声明时写入，否则留空由启动时动态拉取（见 ai/initialize.ts）。
// 只新增/刷新，绝不删除用户已有条目；apiKey 在 settings 中留空，运行时由 config.json 覆盖注入。
export function mergeConfigLanguageProviders(settings: Record<string, unknown>) {
  const entries = Object.entries(getProviderEntries()).filter(([, entry]) => isConfigLanguageEntry(entry));
  if (!entries.length) return false;
  const existing = settings.customProviders;
  const list: unknown[] = Array.isArray(existing) ? [...existing] : [];
  const before = JSON.stringify(list);
  for (const [id, entry] of entries) {
    const preset = languageProviders.find(item => item.id.toLowerCase() === id.toLowerCase());
    const presetApiUrl = preset && "apiUrl" in preset && typeof preset.apiUrl === "string" ? preset.apiUrl : "";
    const presetProtocol = preset && "protocol" in preset && typeof preset.protocol === "string" ? preset.protocol : "";
    const apiUrl = (typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "") || presetApiUrl;
    if (!apiUrl || !URL.canParse(apiUrl)) continue;
    const protocol = entry.protocol ?? presetProtocol ?? "openai-completions";
    const label = (typeof entry.label === "string" && entry.label.trim()) || preset?.label || id;
    const icon = (typeof entry.icon === "string" && entry.icon) || (preset && "icon" in preset && typeof preset.icon === "string" ? preset.icon : "");
    const version = preset?.version ?? "2.0.0";
    const configModels = Array.isArray(entry.models) ? entry.models : undefined;
    const index = list.findIndex(item => !!item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).id === "string"
      && ((item as Record<string, unknown>).id as string).toLowerCase() === id.toLowerCase());
    if (index >= 0) {
      const current = list[index] as Record<string, unknown>;
      list[index] = { ...current, label, ...(icon ? { icon } : {}), apiUrl, protocol, ...(configModels ? { models: configModels } : {}) };
    } else {
      list.push({ id, label, ...(icon ? { icon } : {}), version, apiUrl, protocol, models: configModels ?? [], apiKey: "" });
    }
  }
  const changed = JSON.stringify(list) !== before;
  if (changed) settings.customProviders = list;
  return changed;
}

export function cleanNodeMenuSettings(settings: Record<string, unknown>) {
  const general = settings.general;
  if (!general || typeof general !== "object" || Array.isArray(general) || !Object.hasOwn(general, "nodeMenu")) return false;
  const record = general as Record<string, unknown>;
  const installedTypes = new Set<string>();
  try {
    // ACT: 仅扫描已安装文件名；禁用节点保留配置，菜单清理与同步存盘间不插入异步等待。
    for (const file of readdirSync(resolve(configDirectory, "nodes"), { withFileTypes: true })) {
      if (file.isFile() && /^[a-z][a-zA-Z0-9]*\.umd\.js$/.test(file.name)) installedTypes.add(`remote-${file.name.slice(0, -7)}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const nodeMenu = serializeNodeMenu(normalizeNodeMenu(record.nodeMenu), installedTypes);
  if (!nodeMenu.length) {
    delete record.nodeMenu;
    return true;
  }
  if (JSON.stringify(record.nodeMenu) === JSON.stringify(nodeMenu)) return false;
  record.nodeMenu = nodeMenu;
  return true;
}

const settings = config.get("settings", {});
let settingsDirty = removeLegacySettings(settings);
if (migrateLegacyProviderIds(settings)) settingsDirty = true;
if (settingsDirty) config.set("settings", settings);

// ACT: 仅初始化尚未配置的文本供应商；已有列表（包括用户清空的列表）保持原样。
if (!config.has("settings.customProviders")) {
  config.set("settings.customProviders", autoInstallProviders.map(({ id, label, icon, version, apiUrl, protocol, models }) =>
    ({ id, label, icon, version, apiUrl, protocol, models, apiKey: "" })));
}

// ACT: 在 preset 播种之后合并 config.json 声明的纯配置文本供应商（upsert），
// 使管理员仅凭 config.json 即可新增任意 OpenAI/Anthropic 兼容供应商（如自建 GPU 上的 vLLM/Ollama/SGLang），无需 .ts。
{
  const merged = config.get("settings", {}) as Record<string, unknown>;
  if (mergeConfigLanguageProviders(merged)) config.set("settings", merged);
}

export default config;
