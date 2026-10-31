import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ACT: config.json 位于仓库根目录（与 data/ 同级），集中托管各 AI 供应商密钥；该文件已被 .gitignore 忽略，不入库。
// 默认按源码布局向上定位到仓库根（apps/server/src/utils → 上 4 级 = 仓库根）；
// 也允许用环境变量 TOONFLOW_CONFIG_FILE 覆盖路径，便于打包或自定义部署。
const configPath = process.env.TOONFLOW_CONFIG_FILE ?? resolve(import.meta.dirname, "../../../../config.json");

export type ProviderKeyConfig = { apiKey?: string; baseUrl?: string };
export type AppConfig = { providers?: Record<string, ProviderKeyConfig> };

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
