// ACT: Replicate predictions API 通用适配器（adapter 名：replicate）。覆盖 Replicate 上的图片/视频/音频模型。
// 与其它适配器同构：代码不写死模型，接口地址/密钥来自配置，每个模型的 adapter 描述入参与结果字段。
// 流程：POST {base}/predictions 提交（body: {model|version, input}）-> 轮询 urls.get 至 status=succeeded -> 解析 output。
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
    value: "https://api.replicate.com/v1",
    props: { placeholder: "https://api.replicate.com/v1" },
  },
] as const;

const version = "1.0.0";
const defaultBaseUrl = "https://api.replicate.com/v1";
const pollInterval = 3000;
const timeoutMinutes = 30;

type MediaKind = "image" | "video" | "audio";
type AnyRequest = ImageRequest | VideoRequest | AudioRequest;

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

function typeLabel(mediaType: MediaKind): string {
  return { image: "图片", video: "视频", audio: "音频" }[mediaType];
}

// ACT: Replicate 结果多为 https URL，也可能是 data: 内联；统一归一化为平台可下载的资产。
function toAsset(mediaType: MediaKind, value: unknown): MediaAsset | undefined {
  const url = text(value);
  if (!url) return undefined;
  if (url.startsWith("data:")) {
    const matched = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    return matched ? { mediaType, type: "base64", mimeType: matched[1]!, data: matched[2]! } : undefined;
  }
  return { mediaType, type: "url", url };
}

// ACT: Replicate 各模型 input 键名不同，全部由 adapter 字段名声明；缺省用常见约定。
function buildInput(model: ProviderModel, request: AnyRequest, mediaType: MediaKind) {
  const adapter = model.adapter ?? {};
  const input: Record<string, unknown> = { ...(adapter.paramDefaults as Record<string, unknown> | undefined) };
  const promptField = text(adapter.promptField) || "prompt";
  const mainText = text(mediaType === "audio" ? (request as AudioRequest).text ?? request.prompt : request.prompt);
  if (mainText) input[promptField] = mainText;

  const images = ((request as VideoRequest).images ?? []).map(mediaUrl);
  const refField = text(adapter.refImageField) || (mediaType === "image" ? "image" : "");
  if (refField && images.length) input[refField] = adapter.multiRef ? images : images[0];

  if (mediaType === "video") {
    const video = request as VideoRequest;
    const firstFrameField = text(adapter.firstFrameField) || "first_frame";
    if (video.firstFrame) input[firstFrameField] = mediaUrl(video.firstFrame);
    const lastFrameField = text(adapter.lastFrameField) || "last_frame";
    if (video.lastFrame) input[lastFrameField] = mediaUrl(video.lastFrame);
  }

  const ratio = (request as { ratio?: string }).ratio;
  const ratioField = text(adapter.ratioField) || "aspect_ratio";
  if (ratio) input[ratioField] = ratio;
  const sizeField = text(adapter.sizeField);
  if (sizeField && (request as ImageRequest).size) input[sizeField] = (request as ImageRequest).size;
  const durationField = text(adapter.durationField);
  if (durationField) {
    const duration = num((request as { duration?: number }).duration);
    if (duration !== undefined) input[durationField] = duration;
  }
  if (request.other && typeof request.other === "object") Object.assign(input, request.other);
  return input;
}

function extractAsset(context: ProviderContext, prediction: unknown, adapter: Record<string, unknown>, mediaType: MediaKind): MediaAsset[] {
  const output = pick(prediction, text(adapter.outputPath) || "output");
  const listPath = text(adapter.listPath);
  const list = listPath ? pick(prediction, listPath) : Array.isArray(output) ? output : undefined;
  const assets: MediaAsset[] = [];
  if (Array.isArray(list)) {
    const urlField = text(adapter.urlField);
    for (const item of list) {
      const asset = toAsset(mediaType, text(item) || pick(item, urlField || "url"));
      if (asset) assets.push(asset);
    }
    if (assets.length) return assets;
  }
  const single = toAsset(mediaType, output)
    || toAsset(mediaType, pick(output, text(adapter.urlField) || "url"))
    || toAsset(mediaType, pick(prediction, adapter.resultPath));
  if (single) return [single];
  if (text(pick(output, text(adapter.dataPath) || ""))) {
    const inline = text(pick(output, adapter.dataPath));
    const mimeType = text(pick(prediction, adapter.mimeTypePath))
      || (mediaType === "audio" ? "audio/mpeg" : mediaType === "image" ? "image/png" : "video/mp4");
    return [{ mediaType, type: "base64", mimeType, data: inline.replace(/^data:[^;]+;base64,/, "") }];
  }
  throw new Error(context.tool.errorMessage?.(prediction) || "生成成功但未返回结果");
}

async function generateOne(context: ProviderContext, base: string, apiKey: string, model: ProviderModel,
  request: AnyRequest, mediaType: MediaKind, signal: AbortSignal): Promise<MediaAsset[]> {
  const adapter = model.adapter ?? {};
  const authScheme = text(adapter.authScheme) || "Bearer";
  const modelField = text(adapter.modelField) || "model";
  const payload: Record<string, unknown> = { input: buildInput(model, request, mediaType) };
  payload[modelField] = model.id;
  const submitResponse = await context.tool.fetch(`${base}/predictions`, {
    method: "POST",
    headers: { Authorization: `${authScheme} ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const submitted = await submitResponse.json().catch(() => null);
  if (!submitResponse.ok) throw new Error(context.tool.errorMessage?.(submitted) || `提交任务失败：HTTP ${submitResponse.status}`);
  if (text(adapter.callMode) === "sync") return extractAsset(context, submitted, adapter, mediaType);

  const getUrl = text(pick(submitted, text(adapter.getUrlPath) || "urls.get"))
    || `${base}/predictions/${text(pick(submitted, "id"))}`;
  const statusPath = text(adapter.taskStatusPath) || "status";
  while (true) {
    await wait(signal, pollInterval);
    const response = await context.tool.fetch(getUrl, { headers: { Authorization: `${authScheme} ${apiKey}` }, signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(context.tool.errorMessage?.(body) || `查询任务失败：HTTP ${response.status}`);
    const status = text(pick(body, statusPath)).toLowerCase();
    if (status === "succeeded") return extractAsset(context, body, adapter, mediaType);
    if (["failed", "canceled", "cancelled"].includes(status)) {
      throw new Error(context.tool.errorMessage?.(body) || `${typeLabel(mediaType)}生成失败`);
    }
  }
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

async function run(context: ProviderContext, request: AnyRequest, mediaType: MediaKind): Promise<MediaAsset[]> {
  const apiKey = text(context.config.apiKey).replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请先在媒体模型设置中填写 Replicate API Key");
  const base = (text(context.config.baseUrl) || defaultBaseUrl).replace(/\/$/, "");
  const models = (context.models ?? []).filter(model => model.type === mediaType && pick(model.adapter, "enabled") !== false);
  if (!models.length) throw new Error(`未配置可用的${typeLabel(mediaType)}模型，请在「设置 → 媒体模型」中添加`);
  const ordered = orderCandidates(models, request.model);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMinutes * 60_000), ...(context.signal ? [context.signal] : [])]);
  const failures: string[] = [];
  for (const model of ordered) {
    try {
      return await generateOne(context, base, apiKey, model, request, mediaType, signal);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      failures.push(`【${model.id}】${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${typeLabel(mediaType)}生成失败，已尝试 ${ordered.length} 个候选模型：\n${failures.join("\n")}`);
}

export default {
  id: "replicate",
  label: "Replicate",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000000' d='M4 4h7v3H7v4H4V4zm9 0h7v7h-3V7h-4V4zM4 13h3v4h4v3H4v-7zm13 0h3v7h-7v-3h4v-4z'/%3E%3C/svg%3E",
  version,
  readme: `## Replicate（通用预测适配器）

配置驱动的 Replicate 供应商：图片、视频、音频模型均可，模型与字段全部可编辑。

- **接口地址**：默认 \`https://api.replicate.com/v1\`；提交到 \`{base}/predictions\`，body 为 \`{ model: <model.id>, input }\`。
- **鉴权**：默认 \`Authorization: Bearer <token>\`（可用 \`adapter.authScheme\` 覆盖）。
- **模型标识**：\`model.id\` 填 Replicate 模型 slug（如 \`black-forest-labs/flux-dev\`）；若需用版本哈希，设 \`adapter.modelField = "version"\` 并把 \`id\` 填成版本哈希。
- **轮询**：提交后轮询 \`urls.get\` 至 \`status = succeeded\`，再解析 \`output\`；同步模型设 \`adapter.callMode = "sync"\`。
- **入参字段**：\`promptField\`、\`refImageField\`、\`firstFrameField\`/\`lastFrameField\`、\`ratioField\`（默认 \`aspect_ratio\`）、\`sizeField\`、\`durationField\`、\`paramDefaults\`、\`multiRef\`。
- **结果字段**：默认读 \`output\`（字符串 URL / URL 数组 / \`{url}\` 对象均可）；可用 \`outputPath\`、\`listPath\`+\`urlField\`、\`resultPath\`、\`dataPath\`/\`mimeTypePath\` 精确描述。

> ACT: 下面给出一个 FLUX 图片示例模型；接入视频/音频模型时，复制该条目并改 \`id\` 与 \`adapter\` 字段即可，无需改代码。`,
  rules,
  models: [
    {
      id: "black-forest-labs/flux-dev",
      label: "FLUX.1 [dev]（Replicate）",
      type: "image",
      mode: ["text"],
      imageSizes: ["1024x1024", "1280x720", "720x1280"],
      imageRatios: ["1:1", "16:9", "9:16"],
      adapter: {
        priority: 1,
        modelField: "model",
        promptField: "prompt",
        ratioField: "aspect_ratio",
        sizeField: "image_size",
        outputPath: "output",
        paramDefaults: { num_outputs: 1, aspect_ratio: "1:1" },
      },
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    return run(this, request, "image");
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    return run(this, request, "video");
  },
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    return run(this, request, "audio");
  },
} satisfies ProviderDefinition<typeof rules>;
