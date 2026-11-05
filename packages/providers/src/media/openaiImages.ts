// ACT: OpenAI 兼容「图像生成 / 图生图」通用适配器（adapter 名：openai-images）。
// 设计原则与 aiRouter（dashscope）一致：代码不写死任何模型。接口地址/密钥来自配置，
// 每个模型的 adapter 携带调用细节（endpoint、结果字段、尺寸/数量映射、edits 字段名），
// 同一能力可配置多个候选模型，按 adapter.priority 排序，首选失败自动回退。
// 说明：走 JSON 接口（generations，以及把参考图放进 JSON 字段的 edits）；
// 若目标服务只接受 multipart 文件上传的 /images/edits，请改用「粘贴代码」自定义适配器。
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
    title: "接口地址",
    value: "https://api.openai.com/v1",
    props: { placeholder: "https://api.openai.com/v1" },
  },
] as const;

const version = "1.0.0";
const defaultBaseUrl = "https://api.openai.com/v1";
const timeoutMinutes = 15;

type MediaKind = "image";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mediaUrl(input: MediaInput): string {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

// ACT: 点路径取值，支持数组下标（如 data.0.url）；供应商结果字段差异全部靠配置描述。
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

// ACT: 请求体 = 模型 adapter.paramDefaults 基线 + 公共字段（prompt/size/n/quality）+ request.other。
function buildBody(model: ProviderModel, request: ImageRequest) {
  const adapter = model.adapter ?? {};
  const body: Record<string, unknown> = { ...(adapter.paramDefaults as Record<string, unknown> | undefined) };
  body.model = model.id;
  if (request.prompt) body[text(adapter.promptField) || "prompt"] = request.prompt;
  if (request.size) body.size = request.size;
  if (request.n) body.n = request.n;
  if (request.quality) body.quality = request.quality;
  const responseFormat = text(adapter.responseFormat);
  if (responseFormat) body.response_format = responseFormat;
  // ACT: 有参考图且模型声明了 editsEndpoint 时走图生图；参考图以 data/URL 放进 JSON 字段。
  const reference = (request.images ?? [])[0];
  if (reference && text(adapter.editsEndpoint)) {
    body[text(adapter.editsImageField) || "image"] = mediaUrl(reference);
    if (request.mask) body.mask = mediaUrl(request.mask);
  }
  if (request.other && typeof request.other === "object") Object.assign(body, request.other);
  return body;
}

function endpointOf(model: ProviderModel, request: ImageRequest): string {
  const adapter = model.adapter ?? {};
  const hasReference = (request.images ?? []).length > 0;
  const edits = text(adapter.editsEndpoint);
  if (hasReference && edits) return edits;
  return text(adapter.endpoint) || "/images/generations";
}

function extractImages(context: ProviderContext, data: unknown, adapter: Record<string, unknown>): MediaAsset[] {
  const listPath = text(adapter.listPath) || "data";
  const picked = pick(data, listPath);
  const items = Array.isArray(picked) ? picked : [data];
  const urlField = text(adapter.urlField) || "url";
  const b64Field = text(adapter.b64Field) || "b64_json";
  const assets: MediaAsset[] = [];
  for (const item of items) {
    const url = text(pick(item, urlField));
    if (url) { assets.push({ mediaType: "image" as MediaKind, type: "url", url }); continue; }
    const inline = text(pick(item, b64Field));
    if (inline) assets.push({ mediaType: "image" as MediaKind, type: "base64", mimeType: "image/png", data: inline.replace(/^data:[^;]+;base64,/, "") });
  }
  if (!assets.length) throw new Error(context.tool.errorMessage?.(data) || "生成成功但未返回图片");
  return assets;
}

async function generateOne(context: ProviderContext, base: string, apiKey: string, model: ProviderModel,
  request: ImageRequest, signal: AbortSignal): Promise<MediaAsset[]> {
  const adapter = model.adapter ?? {};
  const endpoint = endpointOf(model, request);
  const authScheme = text(adapter.authScheme) || "Bearer";
  const response = await context.tool.fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `${authScheme} ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(model, request)),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(context.tool.errorMessage?.(data) || `请求失败：HTTP ${response.status}`);
  return extractImages(context, data, adapter);
}

function priorityOf(model: ProviderModel): number {
  return num(pick(model.adapter, "priority")) ?? 999;
}

function orderCandidates(models: ProviderModel[], pickedId: string): ProviderModel[] {
  const byPriority = [...models].sort((left, right) => priorityOf(left) - priorityOf(right));
  const picked = byPriority.find(model => model.id === pickedId);
  if (!picked) return byPriority;
  return [picked, ...byPriority.filter(model => model.id !== pickedId)];
}

async function run(context: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
  const apiKey = text(context.config.apiKey).replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请先在媒体模型设置中填写 API Key");
  const base = (text(context.config.baseUrl) || defaultBaseUrl).replace(/\/$/, "");
  const models = (context.models ?? []).filter(model => model.type === "image" && pick(model.adapter, "enabled") !== false);
  if (!models.length) throw new Error("未配置可用的图片模型，请在「设置 → 媒体模型」中添加");
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
  throw new Error(`图片生成失败，已尝试 ${ordered.length} 个候选模型：\n${failures.join("\n")}`);
}

export default {
  id: "openaiImages",
  label: "OpenAI Images（兼容）",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%2310a37f' d='M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v7.6l3.2-3.2a1 1 0 0 1 1.4 0L13 15.8l2-2a1 1 0 0 1 1.4 0l1.6 1.6V7H5zm11.5 1.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2z'/%3E%3C/svg%3E",
  version,
  readme: `## OpenAI Images（通用兼容适配器）

配置驱动的 OpenAI 兼容图像供应商：接口地址、密钥来自配置，模型与结果字段全部可编辑。

- **接口地址**：默认 \`https://api.openai.com/v1\`；自建/中转服务改成对应根地址即可（会自动拼接 \`/images/generations\`）。
- **模型 adapter**：\`endpoint\`（默认 \`/images/generations\`）、\`responseFormat\`（\`url\` 或 \`b64_json\`）、\`listPath\`/\`urlField\`/\`b64Field\`（结果字段）、\`paramDefaults\`（基线参数）、\`priority\`（多候选回退顺序）。
- **图生图**：给模型配置 \`editsEndpoint\`（如 \`/images/edits\`）与 \`editsImageField\`，参考图会以 data/URL 放进 JSON 字段提交。
- **鉴权**：默认 \`Authorization: Bearer <key>\`；如需其它前缀用 \`adapter.authScheme\` 覆盖。

> ACT: 仅覆盖 JSON 接口；若目标服务的 edits 只接受 multipart 文件上传，请用「粘贴代码」写一个专用适配器。`,
  rules,
  models: [
    {
      id: "gpt-image-1",
      label: "GPT Image 1",
      type: "image",
      mode: ["text", "singleImage"],
      imageSizes: ["1024x1024", "1536x1024", "1024x1536"],
      imageRatios: ["1:1", "3:2", "2:3"],
      adapter: {
        priority: 1,
        endpoint: "/images/generations",
        editsEndpoint: "/images/edits",
        editsImageField: "image",
        responseFormat: "b64_json",
        listPath: "data",
        urlField: "url",
        b64Field: "b64_json",
        paramDefaults: { n: 1, size: "1024x1024" },
      },
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    return run(this, request);
  },
} satisfies ProviderDefinition<typeof rules>;
