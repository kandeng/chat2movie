import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ACT: config.json 位于仓库根目录（与 data/ 同级），集中托管各 AI 供应商密钥；该文件已被 .gitignore 忽略，不入库。
// 默认按源码布局向上定位到仓库根（apps/server/src/utils → 上 4 级 = 仓库根）；
// 也允许用环境变量 TOONFLOW_CONFIG_FILE 覆盖路径，便于打包或自定义部署。
const configPath = process.env.TOONFLOW_CONFIG_FILE ?? resolve(import.meta.dirname, "../../../../config.json");

// ACT: config.json 的 providers.<id> 既托管密钥（apiKey/baseUrl），也可声明「纯配置」供应商：
// - kind:"language"（或缺省 kind 但带 protocol、无 adapter）：按 protocol 直接作为文本供应商，启动时合并进 settings.customProviders 并动态拉取模型，无需任何 .ts；
// - kind:"media" 且带 adapter：套用内置通用媒体适配器（dashscope/openaiImages/fal/replicate），注入 models[] 后物化为 data/providers/<id>.ts；
// - 缺省 kind 且只有 apiKey/baseUrl：保持既有「密钥/地址覆盖」语义（如内置 aiRouter）。
export type ProviderEntry = {
  kind?: "language" | "media";
  protocol?: "openai-completions" | "openai-responses" | "anthropic-messages";
  adapter?: string;
  baseUrl?: string;
  apiKey?: string;
  label?: string;
  icon?: string;
  models?: unknown[];
  enabled?: boolean;
};
// ACT: 向后兼容别名——早期仅 { apiKey, baseUrl } 的密钥托管用法等价于一个未声明 kind 的 ProviderEntry。
export type ProviderKeyConfig = ProviderEntry;
// ACT: Synapse（Matrix）homeserver 连接信息，供聊天转视频原型使用；未配置时相关功能自动降级为不可用。
export type SynapseConfig = {
  baseUrl?: string;
  serverName?: string;
  adminAccessToken?: string;
  botUserId?: string;
  roomId?: string;
};
// ACT: 本地账号系统（better-auth）配置，端口自 drone-navigation-v2 的 config 块：
// smtp 供验证码/重置邮件使用（缺省降级为控制台打印）。
export type SmtpConfig = { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string };
export type AuthConfig = {
  baseUrl?: string;
  sessionSecret?: string;
  // ACT: 账号库连接串。留空时回退到 data/auth.db（bun:sqlite）；填入 postgres:// 连接串时改用 pg Pool（Postgres）。
  databaseUrl?: string;
  smtp?: SmtpConfig;
};
export type AppConfig = { providers?: Record<string, ProviderEntry>; synapse?: SynapseConfig; auth?: AuthConfig };

// ACT: 按文件 mtime 做轻量缓存，避免每次生成都重复读盘；文件变更后自动失效。
let cache: { mtimeMs: number; config: AppConfig } | null = null;

export function readAppConfig(): AppConfig {
  try {
    const stat = statSync(configPath);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.config;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as AppConfig;
    cache = { mtimeMs: stat.mtimeMs, config };
    return config;
  } catch {
    // ACT: config.json 缺失或非法 JSON 时静默回退为空配置，调用方继续沿用 data/settings.json 的旧密钥存储，不影响启动与生成。
    return {};
  }
}

// ACT: 统一去除可能误填的 "Bearer " 前缀，与 getMediaProviderApiKey 的旧归一化逻辑保持一致。
function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
}

export function getConfigApiKey(id: string): string {
  return normalizeKey(readAppConfig().providers?.[id]?.apiKey);
}

export function getConfigBaseUrl(id: string): string {
  const value = readAppConfig().providers?.[id]?.baseUrl;
  return typeof value === "string" ? value.trim() : "";
}

// ACT: 返回 config.json 中声明的全部供应商条目（含密钥托管与纯配置供应商）；缺省或非法时为空对象。
// 供 conf 合并文本供应商、media/provider 物化媒体供应商使用。
export function getProviderEntries(): Record<string, ProviderEntry> {
  const providers = readAppConfig().providers;
  return providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
}

// ACT: 读取 Synapse 配置并做基础归一化（去除 baseUrl 末尾斜杠、去除令牌可能误填的 Bearer 前缀）。
export function getSynapseConfig(): SynapseConfig {
  const synapse = readAppConfig().synapse ?? {};
  return {
    baseUrl: (synapse.baseUrl ?? "").trim().replace(/\/+$/, ""),
    serverName: (synapse.serverName ?? "").trim(),
    adminAccessToken: normalizeKey(synapse.adminAccessToken),
    botUserId: (synapse.botUserId ?? "").trim(),
    roomId: (synapse.roomId ?? "").trim(),
  };
}

// ACT: 读取账号系统配置并做基础归一化；字段缺省时返回空值，由调用方决定降级行为。
export function getAuthConfig(): AuthConfig {
  const auth = readAppConfig().auth ?? {};
  const smtp = auth.smtp && typeof auth.smtp === "object" ? auth.smtp : undefined;
  return {
    baseUrl: (auth.baseUrl ?? "").trim().replace(/\/+$/, ""),
    sessionSecret: (auth.sessionSecret ?? "").trim(),
    databaseUrl: (auth.databaseUrl ?? "").trim(),
    smtp: smtp ? {
      host: (smtp.host ?? "").trim(),
      port: smtp.port,
      secure: smtp.secure,
      user: (smtp.user ?? "").trim(),
      pass: smtp.pass ?? "",
      from: (smtp.from ?? "").trim(),
    } : undefined,
  };
}
