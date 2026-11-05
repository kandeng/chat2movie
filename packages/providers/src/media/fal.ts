// ACT: fal.ai 队列 API 通用适配器（adapter 名：fal）。覆盖 fal 上大量图片/视频/音乐模型。
// 与 aiRouter（dashscope）同构：代码不写死模型，接口地址/密钥来自配置，
// 每个模型的 adapter 描述提交路径、参数字段名、结果字段与轮询字段。
// 队列流程：POST {base}/{model} 提交 -> 轮询 status_url 至 COMPLETED -> GET response_url 取结果。
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
    value: "https://queue.fal.run",
    props: { placeholder: "https://queue.fal.run" },
  },
] as const;

const version = "1.0.0";
const defaultBaseUrl = "https://queue.fal.run";
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

// ACT: fal 各模型入参名差异较大，全部由 adapter 字段名声明；缺省用 fal 常见约定。
function buildArgs(model: ProviderModel, request: AnyRequest, mediaType: MediaKind) {
  const adapter = model.adapter ?? {};
  const args: Record<string, unknown> = { ...(adapter.paramDefaults as Record<string, unknown> | undefined) };
  const promptField = text(adapter.promptField) || "prompt";
  const mainText = text(mediaType === "audio" ? (request as AudioRequest).text ?? request.prompt : request.prompt);
  if (mainText) args[promptField] = mainText;

  const images = ((request as VideoRequest).images ?? []).map(mediaUrl);
  const refField = text(adapter.refImageField) || (mediaType === "image" ? "image_url" : "");
  if (refField && images.length) args[refField] = adapter.multiRef ? images : images[0];

  if (mediaType === "video") {
    const video = request as VideoRequest;
    const firstFrameField = text(adapter.firstFrameField) || "image_url";
    if (video.firstFrame) args[firstFrameField] = mediaUrl(video.firstFrame);
    const lastFrameField = text(adapter.lastFrameField);
    if (lastFrameField && video.lastFrame) args[lastFrameField] = mediaUrl(video.lastFrame);
  }

  const ratioField = text(adapter.ratioField) || "aspect_ratio";
  const ratio = (request as { ratio?: string }).ratio;
  if (ratio) args[ratioField] = ratio;
  const sizeField = text(adapter.sizeField);
  if (sizeField && (request as ImageRequest).size) args[sizeField] = (request as ImageRequest).size;
  const durationField = text(adapter.durationField);
  if (durationField) {
    const duration = num((request as { duration?: number }).duration);
    if (duration !== undefined) args[durationField] = duration;
  }
  if (request.other && typeof request.other === "object") Object.assign(args, request.other);
  return args;
}

function extractAsset(context: ProviderContext, data: unknown, adapter: Record<string, unknown>, mediaType: MediaKind): MediaAsset[] {
  const listPath = text(adapter.listPath);
  if (listPath) {
    const list = pick(data, listPath);
    if (Array.isArray(list)) {
      const urlField = text(adapter.urlField) || "url";
      const assets: MediaAsset[] = [];
      for (const item of list) {
        const url = text(pick(item, urlField)) || text(item);
        if (url) assets.push({ mediaType, type: "url", url });
      }
      if (assets.length) return assets;
    }
  }
  const url = text(pick(data, adapter.resultPath));
  if (url) return [{ mediaType, type: "url", url }];
  const inline = text(pick(data, adapter.dataPath));
  if (inline) {
    const mimeType = text(pick(data, adapter.mimeTypePath))
      || (mediaType === "audio" ? "audio/mpeg" : mediaType === "image" ? "image/png" : "video/mp4");
    return [{ mediaType, type: "base64", mimeType, data: inline.replace(/^data:[^;]+;base64,/, "") }];
  }
  throw new Error(context.tool.errorMessage?.(data) || "生成成功但未返回结果");
}

async function generateOne(context: ProviderContext, base: string, apiKey: string, model: ProviderModel,
  request: AnyRequest, mediaType: MediaKind, signal: AbortSignal): Promise<MediaAsset[]> {
  const adapter = model.adapter ?? {};
  const authScheme = text(adapter.authScheme) || "Key";
  const headers = { Authorization: `${authScheme} ${apiKey}`, "Content-Type": "application/json" };
  const path = text(adapter.endpoint) || `/${model.id}`;
  const submitUrl = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const submitResponse = await context.tool.fetch(submitUrl, {
    method: "POST", headers, body: JSON.stringify(buildArgs(model, request, mediaType)), signal,
  });
  const submitted = await submitResponse.json().catch(() => null);
  if (!submitResponse.ok) throw new Error(context.tool.errorMessage?.(submitted) || `提交任务失败：HTTP ${submitResponse.status}`);

  const statusUrl = text(pick(submitted, text(adapter.statusUrlPath) || "status_url"));
  const responseUrl = text(pick(submitted, text(adapter.responseUrlPath) || "response_url"));
  // ACT: 同步接口（或未返回队列 URL）时直接解析结果。
  if (text(adapter.callMode) === "sync" || (!statusUrl && !responseUrl)) return extractAsset(context, submitted, adapter, mediaType);

  const statusPath = text(adapter.taskStatusPath) || "status";
  const pollUrl = statusUrl || responseUrl;
  while (true) {
    await wait(signal, pollInterval);
    const response = await context.tool.fetch(pollUrl, { headers: { Authorization: `${authScheme} ${apiKey}` }, signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(context.tool.errorMessage?.(body) || `查询任务失败：HTTP ${response.status}`);
    const status = text(pick(body, statusPath)).toUpperCase();
    if (["COMPLETED", "SUCCEEDED", "SUCCESS"].includes(status)) {
      const finalUrl = responseUrl || pollUrl;
      const finalResponse = await context.tool.fetch(finalUrl, { headers: { Authorization: `${authScheme} ${apiKey}` }, signal });
      const finalData = await finalResponse.json().catch(() => null);
      if (!finalResponse.ok) throw new Error(context.tool.errorMessage?.(finalData) || `获取结果失败：HTTP ${finalResponse.status}`);
      return extractAsset(context, finalData, adapter, mediaType);
    }
    if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED"].includes(status)) {
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
  if (!apiKey) throw new Error("请先在媒体模型设置中填写 fal API Key");
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
  id: "fal",
  label: "fal.ai",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23111111' d='M5 3h6a5 5 0 0 1 0 10H8v8H5V3zm3 3v4h3a2 2 0 0 0 0-4H8z'/%3E%3C/svg%3E",
  version,
  readme: `## fal.ai（通用队列适配器）

配置驱动的 fal 队列供应商：图片、视频、音乐（MusicGen 等）均可，模型与字段全部可编辑。

- **接口地址**：默认队列入口 \`https://queue.fal.run\`；提交地址为 \`{base}/{model.id}\`（模型 ID 直接用 fal 路径，如 \`fal-ai/flux/dev\`），或用 \`adapter.endpoint\` 覆盖。
- **鉴权**：fal 使用 \`Authorization: Key <key>\`（默认已内置，可用 \`adapter.authScheme\` 覆盖）。
- **队列流程**：提交后轮询 \`status_url\` 至 \`COMPLETED\`，再 GET \`response_url\` 取结果；同步模型设 \`adapter.callMode = "sync"\`。
- **入参字段**：\`promptField\`、\`refImageField\`、\`firstFrameField\`/\`lastFrameField\`、\`ratioField\`（默认 \`aspect_ratio\`）、\`sizeField\`、\`durationField\`、\`paramDefaults\`、\`multiRef\`。
- **结果字段**：单值用 \`resultPath\`（如 \`image.url\`、\`video.url\`）；数组用 \`listPath\`+\`urlField\`（如 \`images\`+\`url\`）；内联数据用 \`dataPath\`/\`mimeTypePath\`。

> ACT: 下面给出一个 FLUX 图片示例模型；接入视频/音乐模型时，复制该条目并改 \`id\` 与 \`adapter\` 字段即可，无需改代码。`,
  rules,
  models: [
    {
      id: "fal-ai/flux/dev",
      label: "FLUX.1 [dev]",
      type: "image",
      mode: ["text"],
      imageSizes: ["1024x1024", "1280x720", "720x1280"],
      imageRatios: ["1:1", "16:9", "9:16"],
      adapter: {
        priority: 1,
        promptField: "prompt",
        ratioField: "aspect_ratio",
        sizeField: "image_size",
        listPath: "images",
        urlField: "url",
        paramDefaults: { num_images: 1, image_size: "square_hd" },
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
