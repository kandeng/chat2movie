// ACT: 通用音乐 / BGM 供应商（音频类，prompt 驱动）。
// 不写死任何厂商：每个候选模型用 adapter 描述接口地址、鉴权方式、请求体模板、
// 异步轮询与结果字段；模板中的 {{占位符}} 在运行时替换。首选失败按 priority 回退。
// 内置 MiniMax / fal MusicGen 两个示例候选，接口地址与字段均可在「设置 → 媒体模型」中改写。
const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "接口地址（可选，模型未写绝对地址时作为前缀）",
    value: "",
    props: { placeholder: "留空则使用各模型 adapter.endpoint 的绝对地址" },
  },
] as const;

const version = "1.0.0";
// ACT: 固定 5s 轮询、单次生成最长等待 15 分钟。
const pollInterval = 5000;
const timeoutMinutes = 15;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ACT: 点路径取值，支持数组下标（如 data.items.0.audio.url）。
function pick(value: unknown, path: unknown): unknown {
  const route = text(path);
  if (!route) return undefined;
  let current: unknown = value;
  for (const segment of route.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[num(segment) ?? -1] : (current as Record<string, unknown>)[segment];
  }
  return current;
}

function wait(signal: AbortSignal | undefined, ms: number) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// ACT: 递归替换 {{占位符}}；整串恰为单个占位符时保留原值类型（如 duration 为数字）。
function substitute(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const exact = /^\{\{\s*(\w+)\s*\}\}$/.exec(template);
    if (exact) return values[exact[1]] ?? "";
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
      const value = values[key];
      return value == null ? "" : String(value);
    });
  }
  if (Array.isArray(template)) return template.map(item => substitute(item, values));
  if (template && typeof template === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) result[key] = substitute(value, values);
    return result;
  }
  return template;
}

function resolveUrl(base: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${base.replace(/\/$/, "")}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
}

function buildHeaders(adapter: Record<string, unknown>, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(adapter.headers as Record<string, string> | undefined) };
  const authStyle = text(adapter.authStyle) || "bearer";
  if (authStyle !== "none" && apiKey) {
    const authHeader = text(adapter.authHeader) || "Authorization";
    const prefix = authStyle === "key" ? "Key " : "Bearer ";
    headers[authHeader] = `${prefix}${apiKey}`;
  }
  return headers;
}

function extractAsset(context: ProviderContext, data: unknown, adapter: Record<string, unknown>): MediaAsset[] {
  const url = text(pick(data, adapter.resultPath));
  if (url) return [{ mediaType: "audio", type: "url", url }];
  const inline = text(pick(data, adapter.dataPath));
  if (inline) {
    return [{ mediaType: "audio", type: "base64", mimeType: text(pick(data, adapter.mimeTypePath)) || "audio/mpeg", data: inline.replace(/^data:[^;]+;base64,/, "") }];
  }
  throw new Error(context.tool.errorMessage?.(data) || "生成成功但未返回音频结果");
}

async function pollTask(context: ProviderContext, base: string, apiKey: string, adapter: Record<string, unknown>,
  taskId: string, values: Record<string, unknown>, signal: AbortSignal): Promise<MediaAsset[]> {
  const template = text(adapter.taskEndpoint);
  const pollUrl = template ? resolveUrl(base, text(substitute(template, { ...values, taskId }))) : resolveUrl(base, `/tasks/${taskId}`);
  const headers = buildHeaders(adapter, apiKey);
  const statusPath = text(adapter.taskStatusPath) || "status";
  const success = (Array.isArray(adapter.successStatuses) ? adapter.successStatuses : ["succeeded", "success", "completed"])
    .map(item => String(item).toLowerCase());
  const failed = (Array.isArray(adapter.failStatuses) ? adapter.failStatuses : ["failed", "failure", "error", "canceled", "cancelled"])
    .map(item => String(item).toLowerCase());
  while (true) {
    const response = await context.tool.fetch(pollUrl, { method: text(adapter.taskMethod) || "GET", headers, signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(context.tool.errorMessage?.(data) || `查询任务失败：HTTP ${response.status}`);
    const status = text(pick(data, statusPath)).toLowerCase();
    if (success.includes(status)) return extractAsset(context, data, adapter);
    if (failed.includes(status)) throw new Error(context.tool.errorMessage?.(data) || "音乐生成失败");
    await wait(signal, pollInterval);
  }
}

async function generateOne(context: ProviderContext, base: string, apiKey: string, model: ProviderModel,
  request: AudioRequest, signal: AbortSignal): Promise<MediaAsset[]> {
  const adapter = model.adapter ?? {};
  const endpoint = text(adapter.endpoint);
  if (!endpoint) throw new Error(`模型 ${model.id} 未配置 adapter.endpoint`);
  const values: Record<string, unknown> = {
    model: model.id,
    apiKey,
    prompt: request.prompt ?? "",
    text: request.text ?? "",
    lyrics: text(request.other?.lyrics),
    duration: request.other?.duration ?? "",
    format: request.format ?? "mp3",
  };
  const bodyTemplate = (adapter.bodyTemplate ?? { model: "{{model}}", prompt: "{{prompt}}" }) as Record<string, unknown>;
  const isAsync = text(adapter.callMode) === "async";
  const response = await context.tool.fetch(resolveUrl(base, endpoint), {
    method: text(adapter.method) || "POST",
    headers: buildHeaders(adapter, apiKey),
    body: JSON.stringify(substitute(bodyTemplate, values)),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(context.tool.errorMessage?.(data) || `请求失败：HTTP ${response.status}`);
  if (!isAsync) return extractAsset(context, data, adapter);
  const taskId = text(pick(data, text(adapter.taskIdPath) || "task_id"));
  if (!taskId) throw new Error(context.tool.errorMessage?.(data) || "提交任务未返回任务 ID");
  return pollTask(context, base, apiKey, adapter, taskId, values, signal);
}

function priorityOf(model: ProviderModel): number {
  return num(pick(model.adapter, "priority")) ?? 999;
}

// ACT: 首选为节点选中的模型，其余候选按 priority 升序作为回退。
function orderCandidates(models: ProviderModel[], pickedId: string): ProviderModel[] {
  const byPriority = [...models].sort((left, right) => priorityOf(left) - priorityOf(right));
  const picked = byPriority.find(model => model.id === pickedId);
  if (!picked) return byPriority;
  return [picked, ...byPriority.filter(model => model.id !== pickedId)];
}

async function run(context: ProviderContext, request: AudioRequest): Promise<MediaAsset[]> {
  const apiKey = text(context.config.apiKey).replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请先在媒体模型设置中填写音乐供应商 API Key");
  const base = text(context.config.baseUrl).replace(/\/$/, "");
  const models = (context.models ?? []).filter(model => model.type === "audio" && pick(model.adapter, "enabled") !== false);
  if (!models.length) throw new Error("未配置可用的音乐模型，请在「设置 → 媒体模型」中添加候选（如 MiniMax music-01 / Suno / fal MusicGen）");
  const ordered = orderCandidates(models, request.model);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMinutes * 60_000), ...(context.signal ? [context.signal] : [])]);
  const failures: string[] = [];
  for (const model of ordered) {
    try {
      return await generateOne(context, base, apiKey, model, request, signal);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      failures.push(`【${model.id}】${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`音乐生成失败，已尝试 ${ordered.length} 个候选模型：\n${failures.join("\n")}`);
}

export default {
  id: "music",
  label: "音乐 / BGM 生成",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%237c3aed' d='M9 18V5l12-2v13'/%3E%3Ccircle cx='6' cy='18' r='3' fill='%237c3aed'/%3E%3Ccircle cx='18' cy='16' r='3' fill='%237c3aed'/%3E%3C/svg%3E",
  version,
  readme: `## 音乐 / BGM 生成（通用供应商）

用于为成片配乐。厂商、模型、接口、鉴权与请求体全部由每个候选模型的 \`adapter\` 配置描述，**不写死任何厂商**：

- \`endpoint\`：绝对地址，或相对 \`baseUrl\` 的路径。
- \`callMode\`：\`sync\` 直接返回，或 \`async\` 提交任务后轮询（配 \`taskIdPath\` / \`taskEndpoint\` / \`taskStatusPath\`）。
- \`authStyle\`：\`bearer\`（默认）/ \`key\` / \`none\`。
- \`bodyTemplate\`：请求体模板，支持 \`{{prompt}}\`、\`{{lyrics}}\`、\`{{model}}\`、\`{{duration}}\`、\`{{format}}\`、\`{{apiKey}}\`、\`{{taskId}}\` 占位符。
- \`resultPath\` / \`dataPath\`：结果音频地址或 base64 字段的点路径。
- \`priority\`：多候选回退顺序，首选失败自动尝试下一个。

内置 MiniMax Music-01（同步）与 fal MusicGen（异步队列）两个示例，接口字段请按所选厂商在设置中核对。`,
  rules,
  models: [
    {
      id: "music-01",
      label: "MiniMax Music-01",
      type: "audio",
      adapter: {
        priority: 1,
        callMode: "sync",
        endpoint: "https://api.minimaxi.com/v1/music_generation",
        authStyle: "bearer",
        bodyTemplate: {
          model: "{{model}}",
          prompt: "{{prompt}}",
          lyrics: "{{lyrics}}",
          audio_setting: { format: "mp3", sample_rate: 44100, bitrate: 256000 },
        },
        resultPath: "data.audio_url",
        dataPath: "data.audio",
      },
    },
    {
      id: "fal-ai/musicgen",
      label: "MusicGen（fal.ai）",
      type: "audio",
      adapter: {
        priority: 2,
        callMode: "async",
        endpoint: "https://queue.fal.run/fal-ai/musicgen",
        authStyle: "key",
        bodyTemplate: { prompt: "{{prompt}}", duration: "{{duration}}" },
        taskIdPath: "request_id",
        taskEndpoint: "https://queue.fal.run/fal-ai/musicgen/requests/{{taskId}}",
        taskStatusPath: "status",
        successStatuses: ["completed"],
        failStatuses: ["failed", "error"],
        resultPath: "audio.url",
      },
    },
  ] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    return run(this, request);
  },
} satisfies ProviderDefinition<typeof rules>;
