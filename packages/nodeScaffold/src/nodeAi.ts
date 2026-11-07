import { onScopeDispose } from "vue";
import { runAgentLoop, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import { EventSourceParserStream } from "eventsource-parser/stream";
import type { MediaGenerationRequest, MediaModel } from "@toonflow/tools-scaffold/runtime";
import type { NodeOutput } from "./values";

export type NodeAiModel = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type NodeMediaModel = Omit<MediaModel, "mode"> & {
  mode?: (string | string[])[];
};
export type NodeImageRequest = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  outputDirectory: string;
  images?: { path: string; mimeType: string }[];
  ratio?: string;
  size?: string;
  other?: Record<string, unknown>;
};
export type NodeImageResult = { path: string; mimeType: string; mediaType: "image" };
export type NodeVideoRequest = Omit<MediaGenerationRequest, "size"> & { directory: string; outputDirectory: string };
export type NodeVideoResult = { path: string; mimeType: string; mediaType: "video" };
export type NodeMediaPriceRequest = (NodeImageRequest & { mediaType: "image" }) | (NodeVideoRequest & { mediaType: "video" }) | (NodeAudioRequest & { mediaType: "audio" });
export type NodeMediaPrice = { price: string; tips: string };
export type NodeAudioRequest = Pick<MediaGenerationRequest, "providerId" | "modelId" | "prompt" | "images" | "audios" | "voice" | "speed" | "volume" | "pitch" | "language" | "format" | "sampleRate" | "other"> & { directory: string; outputDirectory: string };
export type NodeAudioResult = { path: string; mimeType: string; mediaType: "audio" };
export type NodeAiRequest = {
  providerId: string;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  directory?: string;
  references?: Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" | "FILE" }>[];
  tools?: NodeAiTool[];
  onEvent?: (event: NodeAiEvent) => void;
  signal?: AbortSignal;
};
export type NodeAiResult = {
  text: string;
  reasoning?: string;
};
export type NodeAiEvent = { type: "text" | "reasoning"; delta: string }
  | { type: "toolStart"; id: string; name: string; args: unknown }
  | { type: "toolEnd"; id: string; name: string; result: unknown; isError: boolean };
export type NodeAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
};

async function readResult<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || `AI 请求失败（HTTP ${response.status}），请稍后重试。`);
  return result.data;
}

// ACT: 独立 UMD 各有模块作用域，共用宿主缓存；模型设置保存后失效，不按节点重复请求。
const modelCacheKey = Symbol.for("toonflow.nodeModels");
const modelCacheHost = globalThis as typeof globalThis & { [modelCacheKey]?: Map<string, Promise<unknown[]>> };
const modelCache = modelCacheHost[modelCacheKey] ??= new Map<string, Promise<unknown[]>>();

// ACT: 计划 Task 12 —— 浏览器直连的本地 OpenAI 兼容端点配置：按用户存放在浏览器本地（localStorage），
// 经 globalThis 符号在所有独立 UMD 之间共享。仅「传输层」与服务端 /api/ai/generate 不同，
// 其余复用 nodeAi 既有的 pi-ai 客户端（createAssistantMessageEventStream + runAgentLoop）。
export const LOCAL_PROVIDER_ID = "browser-local";
export type LocalModelEntry = { id: string; label: string; contextWindow?: number; maxOutputTokens?: number };
export type LocalModelConfig = { label?: string; baseUrl: string; apiKey?: string; models: LocalModelEntry[] };
const localConfigKey = Symbol.for("toonflow.localModelConfig");
const localConfigHost = globalThis as typeof globalThis & { [localConfigKey]?: { config?: LocalModelConfig } };
const localConfigStore = localConfigHost[localConfigKey] ??= {};
export function setLocalModelConfig(config: LocalModelConfig | undefined) {
  localConfigStore.config = config && config.baseUrl.trim() && config.models.length
    ? { ...config, baseUrl: config.baseUrl.trim(), models: config.models.filter(model => model.id.trim()) }
    : undefined;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("toonflow:provider-config-changed"));
}
export function getLocalModelConfig(): LocalModelConfig | undefined {
  const config = localConfigStore.config;
  return config && config.models.length ? config : undefined;
}

type MediaPriceCache = {
  prices: Map<string, { expires: number; value: Promise<NodeMediaPrice | null> }>;
  requestedAt: Map<string, number>;
};
const mediaPriceCacheKey = Symbol.for("toonflow.nodeMediaPrices");
const mediaPriceCacheHost = globalThis as typeof globalThis & { [mediaPriceCacheKey]?: MediaPriceCache };
const mediaPriceCache = mediaPriceCacheHost[mediaPriceCacheKey] ??= (() => {
  const cache: MediaPriceCache = { prices: new Map(), requestedAt: new Map() };
  if (typeof window !== "undefined") {
    const invalidate = (event: Event) => {
      if (event.type === "toonflow:plugin-installed" && (event as CustomEvent<{ type?: string }>).detail?.type !== "provider") return;
      cache.prices.clear();
    };
    window.addEventListener("toonflow:provider-config-changed", invalidate);
    window.addEventListener("toonflow:plugin-installed", invalidate);
  }
  return cache;
})();

type MediaTaskResult = { code: number; data: (NodeImageResult | NodeVideoResult | NodeAudioResult)[] | null; message: string };
type PendingMediaTask = { directory: string; failedAt?: number; finish: (result: MediaTaskResult) => void; fail: (error: unknown) => void };
const mediaTasksKey = Symbol.for("toonflow.nodeMediaTasks");
const mediaTasksHost = globalThis as typeof globalThis & { [mediaTasksKey]?: ReturnType<typeof createMediaTasks> };
// ACT: 图片、视频等独立 UMD 共用短轮询；每批最多 100 项，不按节点占用长连接。
const mediaTasks = mediaTasksHost[mediaTasksKey] ??= createMediaTasks();

function createMediaTasks() {
  const pending = new Map<string, PendingMediaTask>();
  const cancellations = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  function schedule(delay = 1000) {
    if (polling || timer !== undefined || (!pending.size && !cancellations.size)) return;
    timer = setTimeout(poll, delay);
  }

  function cancel(directory: string, taskId: string) {
    const ids = cancellations.get(directory) ?? new Set<string>();
    ids.add(taskId);
    cancellations.set(directory, ids);
    schedule(0);
  }

  async function poll() {
    timer = undefined;
    polling = true;
    try {
      for (const [directory, ids] of cancellations) {
        cancellations.delete(directory);
        const taskIds = [...ids];
        for (let offset = 0; offset < taskIds.length; offset += 100) {
          // 取消失败由服务端无心跳过期兜底，不重新提交生成请求。
          await fetch("/api/ai/media/tasks/cancel", {
            method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
            body: JSON.stringify({ directory, taskIds: taskIds.slice(offset, offset + 100) }), signal: AbortSignal.timeout(10000),
          }).then(readResult).catch(() => {});
        }
      }
      const directories = new Set([...pending.values()].map(task => task.directory));
      for (const directory of directories) {
        const taskIds = [...pending].filter(([, task]) => task.directory === directory).map(([id]) => id);
        for (let offset = 0; offset < taskIds.length; offset += 100) {
          const batch = taskIds.slice(offset, offset + 100).filter(id => pending.has(id));
          if (!batch.length) continue;
          try {
            const results = await fetch("/api/ai/media/tasks/status", {
              method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
              body: JSON.stringify({ directory, taskIds: batch }), signal: AbortSignal.timeout(10000),
            }).then(readResult<{ taskId: string; result?: MediaTaskResult }[]>);
            const byId = new Map(results.map(result => [result.taskId, result]));
            for (const id of batch) {
              const task = pending.get(id);
              if (!task) continue;
              const item = byId.get(id);
              if (!item) throw new Error("生成任务响应不完整，请重试");
              task.failedAt = undefined;
              if (item.result) task.finish(item.result);
            }
          } catch (error) {
            for (const id of batch) {
              const task = pending.get(id);
              if (!task) continue;
              // ACT: 状态查询允许 90 秒临时断线，不因几次快速失败取消已经提交的生成。
              task.failedAt ??= Date.now();
              if (task.failedAt + 90000 <= Date.now()) { task.fail(error); cancel(directory, id); }
            }
          }
        }
      }
    } finally {
      polling = false;
      schedule();
    }
  }

  function wait(directory: string, taskId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<NonNullable<MediaTaskResult["data"]>>((resolve, reject) => {
      const cleanup = () => {
        pending.delete(taskId);
        signal.removeEventListener("abort", abort);
        if (!pending.size && !cancellations.size) { clearTimeout(timer); timer = undefined; }
      };
      const abort = () => { cleanup(); cancel(directory, taskId); reject(signal.reason); };
      pending.set(taskId, {
        directory,
        finish(result) {
          cleanup();
          if (result.code === 200 && result.data) resolve(result.data);
          else reject(new Error(result.message || "媒体生成失败"));
        },
        fail(error) { cleanup(); reject(error); },
      });
      signal.addEventListener("abort", abort, { once: true });
      schedule();
    });
  }

  return { wait, cancel };
}

export function invalidateNodeModels(type: "language" | "media") {
  modelCache.delete(type === "language" ? "/api/ai/models" : "/api/ai/media/models");
  if (type === "media") mediaPriceCache.prices.clear();
}

async function readModels<T>(url: string, signal: AbortSignal): Promise<T[]> {
  signal.throwIfAborted();
  let pending = modelCache.get(url);
  if (!pending) {
    const request = fetch(url, { cache: "no-store" }).then(readResult<unknown[]>).catch(error => {
      if (modelCache.get(url) === request) modelCache.delete(url);
      throw error;
    });
    pending = request;
    modelCache.set(url, request);
  }
  // 单个节点关闭只取消自己的等待，不能中断其他节点共用的请求。
  let cancel = () => {};
  try {
    const models = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    return modelCache.get(url) === pending ? models as T[] : readModels<T>(url, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function requestModel(input: NodeAiRequest, context: Context, model: Model<NodeAiModel["protocol"]>, signal: AbortSignal) {
  const { providerId, modelId, references, directory, onEvent } = input;
  const stream = createAssistantMessageEventStream();
  try {
    signal.throwIfAborted();
    const response = await fetch("/api/ai/generate", {
      method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ providerId, modelId, context, directory, references }), signal,
    });
    if (!response.ok) await readResult(response);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("AI 未返回预期的 SSE 数据流，无法接收生成内容。");
    const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) throw new Error("AI 数据流提前结束，生成内容可能不完整，请重试。");
        const event = JSON.parse(value.data);
        if (event.type === "error") throw new Error(event.message || "AI 生成失败");
        if (event.type === "text" || event.type === "reasoning") onEvent?.(event);
        if (event.type !== "done") continue;
        const message = event.message as AssistantMessage;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) throw new Error("AI 返回的消息不完整，请确认 vidsay 服务端已更新后重试。");
        if (message.stopReason === "deferred" || message.stopReason === "pending") throw new Error("AI 返回的任务尚未完成，本次生成未能正常结束。");
        if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
        // ACT: 增量直接通知 UI；SDK 只消费完整单轮消息，避免每个 token 传输全量快照。
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message });
        break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    const reason = signal.aborted ? "aborted" : "error";
    stream.push({ type: "error", reason, error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: reason, errorMessage: error instanceof Error ? error.message : "AI 请求失败",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
  }
  return stream;
}

// ACT: 计划 Task 12 —— 浏览器直连本地模型的 OpenAI 兼容 Chat Completions 传输层。
type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type OpenAiChatMessage = { role: string; content?: unknown; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

function resolveLocalChatUrl(config: LocalModelConfig): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function toLocalUsage(usage?: OpenAiUsage) {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: usage?.total_tokens ?? input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { arguments: raw };
  }
}

function buildLocalChatMessages(context: Context): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  if (context.systemPrompt?.trim()) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") { messages.push({ role: "user", content: message.content }); continue; }
      messages.push({ role: "user", content: message.content.map(part => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }) });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
      const toolCalls = message.content.filter(part => part.type === "toolCall");
      const entry: OpenAiChatMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) entry.tool_calls = toolCalls.map(part => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) } }));
      messages.push(entry);
      continue;
    }
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
    messages.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
  }
  return messages;
}

async function requestLocalModel(input: NodeAiRequest, context: Context, model: Model<NodeAiModel["protocol"]>, signal: AbortSignal) {
  const { onEvent } = input;
  const stream = createAssistantMessageEventStream();
  try {
    const config = getLocalModelConfig();
    if (!config) throw new Error("尚未配置浏览器直连的本地模型端点，请在设置的「本地模型」中填写本地服务地址");
    signal.throwIfAborted();
    const body: Record<string, unknown> = { model: model.id, stream: true, stream_options: { include_usage: true }, messages: buildLocalChatMessages(context) };
    if (context.tools?.length) {
      body.tools = context.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      body.tool_choice = "auto";
    }
    let response: Response;
    try {
      response = await fetch(resolveLocalChatUrl(config), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}) },
        body: JSON.stringify(body), signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // ACT: fetch 抛 TypeError 通常意味着 CORS 未放行本应用来源、混合内容（HTTPS 页面访问 HTTP 本地端点）被拦截，
      // 或 Private Network Access 预检失败；此时改用本地转发代理（见设置面板与 docs 说明）。
      throw new Error(`无法连接本地模型端点（${config.baseUrl}）：可能是 CORS 未放行本应用来源、混合内容被浏览器拦截，或需要私有网络访问授权；可在本地运行一个转发代理后将其地址填入「本地模型」设置。原始错误：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`本地模型请求失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 500)}` : ""}`);
    }
    if (!response.body) throw new Error("本地模型未返回数据流");
    const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    let text = "";
    let reasoning = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "";
    let usage: OpenAiUsage | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        const data = value.data.trim();
        if (!data) continue;
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: OpenAiUsage };
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) { text += delta.content; onEvent?.({ type: "text", delta: delta.content }); }
        const think = delta.reasoning_content ?? delta.reasoning;
        if (typeof think === "string" && think) { reasoning += think; onEvent?.({ type: "reasoning", delta: think }); }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? toolCalls.size;
          const acc = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) acc.id = call.id;
          if (call.function?.name) acc.name += call.function.name;
          if (call.function?.arguments) acc.args += call.function.arguments;
          toolCalls.set(index, acc);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const calls = [...toolCalls.values()].filter(call => call.name);
    const content: AssistantMessage["content"] = [];
    if (reasoning) content.push({ type: "thinking", thinking: reasoning });
    if (text) content.push({ type: "text", text });
    for (const call of calls) content.push({ type: "toolCall", id: call.id || crypto.randomUUID(), name: call.name, arguments: parseToolArguments(call.args) });
    if (!content.length) throw new Error("本地模型未返回任何内容，请确认端点与模型名称是否正确");
    const stopReason = calls.length ? "toolUse" : finishReason === "length" ? "length" : "stop";
    const message: AssistantMessage = {
      role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      usage: toLocalUsage(usage), stopReason, timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message });
  } catch (error) {
    const reason = signal.aborted ? "aborted" : "error";
    stream.push({ type: "error", reason, error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: reason, errorMessage: error instanceof Error ? error.message : "本地模型请求失败",
      usage: toLocalUsage(),
    } });
  }
  return stream;
}

export function useNodeAi() {
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  async function getModels(signal?: AbortSignal) {
    const remote = await readModels<NodeAiModel>("/api/ai/models", requestSignal(signal));
    // ACT: 计划 Task 12 —— 合并浏览器直连的本地模型；它们不经过服务端，仅在本地端点可达时使用。
    const local = getLocalModelConfig();
    if (!local) return remote;
    const localModels: NodeAiModel[] = local.models.map(model => ({
      providerId: LOCAL_PROVIDER_ID, providerLabel: local.label?.trim() || "本地模型", modelId: model.id, label: model.label || model.id,
      protocol: "openai-completions", contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
    }));
    return [...remote, ...localModels];
  }

  async function getMediaModels(signal?: AbortSignal) {
    return readModels<NodeMediaModel>("/api/ai/media/models", requestSignal(signal));
  }

  async function getMediaPrice(input: NodeMediaPriceRequest, signal?: AbortSignal): Promise<NodeMediaPrice | null> {
    const waitingSignal = requestSignal(signal);
    waitingSignal.throwIfAborted();
    const now = Date.now();
    const { prices, requestedAt } = mediaPriceCache;
    for (const [key, entry] of prices) if (entry.expires <= now) prices.delete(key);
    for (const [key, time] of requestedAt) if (time + 2000 <= now) requestedAt.delete(key);
    const key = JSON.stringify({ ...input, outputDirectory: undefined });
    let entry = prices.get(key);
    if (!entry) {
      // ACT: 节流状态跨节点面板重建保留；每个节点最多每 2 秒发起一次新报价。
      const nodeKey = JSON.stringify([input.directory, input.outputDirectory, input.providerId]);
      const delay = (requestedAt.get(nodeKey) ?? 0) + 2000 - now;
      if (delay > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(resolve, delay);
            cancel = () => reject(waitingSignal.reason);
            waitingSignal.addEventListener("abort", cancel, { once: true });
          });
          return await getMediaPrice(input, signal);
        } finally {
          clearTimeout(timer);
          waitingSignal.removeEventListener("abort", cancel);
        }
      }
      requestedAt.set(nodeKey, now);
      if (requestedAt.size > 500) requestedAt.delete(requestedAt.keys().next().value!);
      if (prices.size >= 500) prices.delete(prices.keys().next().value!);
      const hasReferences = !!(input.images?.length || ("videos" in input && input.videos?.length) || ("audios" in input && input.audios?.length)
        || ("firstFrame" in input && input.firstFrame) || ("lastFrame" in input && input.lastFrame));
      const pending = { expires: Infinity, value: Promise.resolve<NodeMediaPrice | null>(null) };
      // ACT: 最多缓存 500 条 / 30 秒；参考文件没有前端修订号，只合并进行中的查询，避免同路径覆盖后复用旧价。
      pending.value = fetch("/api/ai/media/price", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      }).then(readResult<NodeMediaPrice | null>).then(price => {
        if (price !== null && (!price || typeof price.price !== "string" || !price.price.trim() || typeof price.tips !== "string")) {
          throw new Error("价格响应格式不正确");
        }
        pending.expires = hasReferences ? 0 : Date.now() + 30000;
        return price;
      }).catch(error => {
        pending.expires = Date.now() + 5000;
        throw error;
      });
      prices.set(key, pending);
      entry = pending;
    }
    // 单个节点退出只取消自己的等待，共用请求继续为其他节点提供结果。
    let cancel = () => {};
    try {
      const price = await Promise.race([entry.value, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(waitingSignal.reason);
        waitingSignal.addEventListener("abort", cancel, { once: true });
      })]);
      waitingSignal.throwIfAborted();
      return prices.get(key) === entry ? price : getMediaPrice(input, signal);
    } finally {
      waitingSignal.removeEventListener("abort", cancel);
    }
  }

  async function generateMedia<T extends "image" | "video" | "audio">(mediaType: T, input: NodeImageRequest | NodeVideoRequest | NodeAudioRequest, signal?: AbortSignal) {
    const waitingSignal = requestSignal(signal);
    waitingSignal.throwIfAborted();
    const taskId = crypto.randomUUID();
    // 提交使用独立超时；用户取消立即结束等待，提交收尾后再取消，避免先取消后登记的竞态。
    const submitted = fetch("/api/ai/media/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ ...input, mediaType, taskId }), signal: AbortSignal.timeout(30000),
    }).then(readResult<{ taskId: string }>);
    let abort = () => {};
    try {
      const started = await Promise.race([submitted, new Promise<never>((_resolve, reject) => {
        abort = () => reject(waitingSignal.reason);
        waitingSignal.addEventListener("abort", abort, { once: true });
      })]);
      waitingSignal.throwIfAborted();
      if (started.taskId !== taskId) throw new Error("生成任务响应无效，无法确认任务状态，请确认 vidsay 服务端已更新后重试。");
    } catch (error) {
      void submitted.then(() => mediaTasks.cancel(input.directory, taskId), () => mediaTasks.cancel(input.directory, taskId));
      throw error;
    } finally {
      waitingSignal.removeEventListener("abort", abort);
    }
    return await mediaTasks.wait(input.directory, taskId, waitingSignal) as { path: string; mimeType: string; mediaType: T }[];
  }

  function generateImage(input: NodeImageRequest, signal?: AbortSignal) {
    return generateMedia("image", input, signal);
  }

  function generateVideo(input: NodeVideoRequest, signal?: AbortSignal) {
    return generateMedia("video", input, signal);
  }

  function generateAudio(input: NodeAudioRequest, signal?: AbortSignal) {
    return generateMedia("audio", input, signal);
  }

  async function generate(input: NodeAiRequest): Promise<NodeAiResult> {
    const signal = requestSignal(input.signal);
    const callSignal = input.tools?.length ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : signal;
    const { providerId, modelId, prompt, systemPrompt, onEvent } = input;
    if (!prompt.trim()) throw new Error("请输入提示词");
    const definitions = input.tools ?? [];
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new Error("工具名称不能重复");
    const selected = (await getModels(callSignal)).find(model => model.providerId === providerId && model.modelId === modelId);
    if (!selected) throw new Error("所选模型不存在，请重新选择");
    const model: Model<NodeAiModel["protocol"]> = {
      id: modelId, name: selected.label, provider: providerId, api: selected.protocol, baseUrl: "",
      reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: selected.contextWindow ?? 262144, maxTokens: selected.maxOutputTokens ?? 32768,
    };
    const tools: AgentTool[] = definitions.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      async execute(_id, args, toolSignal) {
        callSignal.throwIfAborted();
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数格式错误：必须是对象。");
        const result = await tool.execute(args as Record<string, unknown>, toolSignal) ?? null;
        callSignal.throwIfAborted();
        return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }], details: undefined };
      },
    }));
    let turns = 0;
    const messages = await runAgentLoop([{ role: "user", content: prompt, timestamp: Date.now() }], {
      systemPrompt: systemPrompt ?? "", messages: [], tools,
    }, {
      model, convertToLlm: messages => messages as Message[], toolExecution: "sequential",
      shouldStopAfterTurn: ({ message }) => ++turns >= 40 || message.stopReason === "length",
    }, event => {
      callSignal.throwIfAborted();
      if (event.type === "tool_execution_start") onEvent?.({ type: "toolStart", id: event.toolCallId, name: event.toolName, args: event.args });
      if (event.type === "tool_execution_end" && onEvent) {
        const text = (event.result as AgentToolResult<unknown>).content.filter(part => part.type === "text").map(part => part.text).join("\n");
        onEvent({ type: "toolEnd", id: event.toolCallId, name: event.toolName, result: event.isError ? text : JSON.parse(text), isError: event.isError });
      }
    }, callSignal, (_model, context) => providerId === LOCAL_PROVIDER_ID
      ? requestLocalModel(input, context, model, callSignal)
      : requestModel(input, context, model, callSignal));
    callSignal.throwIfAborted();
    const message = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    if (!message) throw new Error("AI 未返回结果");
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
    if (definitions.length && message.stopReason === "length") throw new Error("模型输出达到上限，请精简任务后重试");
    if (message.content.some(part => part.type === "toolCall")) throw new Error("AI 已达到 40 轮调用上限，请缩小任务后重试");
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
    const reasoning = message.content.filter(part => part.type === "thinking").map(part => part.thinking).join("");
    return { text, ...(reasoning ? { reasoning } : {}) };
  }

  return { getModels, getMediaModels, getMediaPrice, generateImage, generateVideo, generateAudio, generate };
}
