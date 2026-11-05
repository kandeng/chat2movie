// ACT: 阿里云百炼（Model Studio / DashScope）媒体供应商。
// 设计原则：代码不写死任何模型。模型 ID、接口地址、调用方式（异步/同步）、
// 结果字段与回退顺序全部来自可编辑配置——rules 保存到 settings.json，
// models 可在「设置 → 媒体模型」中编辑或刷新；每个模型的 adapter 携带调用细节。
// 同一能力（视频/图片/音频）可配置多个候选模型，按 adapter.priority 排序，
// 首选失败时自动回退到下一个候选。
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
    value: "https://token-plan.cn-beijing.maas.aliyuncs.com",
    props: { placeholder: "https://token-plan.cn-beijing.maas.aliyuncs.com" },
  },
] as const;

const version = "1.0.0";
const defaultBaseUrl = "https://token-plan.cn-beijing.maas.aliyuncs.com";
// ACT: 固定 5s 轮询、单次生成最长等待 30 分钟；如需可调再提升到 rules。
const pollInterval = 5000;
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

// ACT: 点路径取值，支持数组下标（如 output.results.0.url），供应商结果字段差异全部靠配置描述。
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

// ACT: DashScope 原生 body 结构为 { model, input, parameters }。
// adapter.paramDefaults/inputDefaults 作为基线，请求参数覆盖（浅合并即可满足扁平结构）。
function buildBody(model: ProviderModel, request: AnyRequest, mediaType: MediaKind) {
  const adapter = model.adapter ?? {};
  const input: Record<string, unknown> = {};
  const parameters: Record<string, unknown> = {};
  const promptField = text(adapter.promptField) || (mediaType === "audio" ? "text" : "prompt");
  const mainText = text(mediaType === "audio" ? (request as AudioRequest).text ?? request.prompt : request.prompt);
  if (mainText) input[promptField] = mainText;

  const images = ((request as VideoRequest).images ?? []).map(mediaUrl);
  const refField = text(adapter.refImageField);
  if (refField && images.length) input[refField] = adapter.multiRef ? images : images[0];

  if (mediaType === "video") {
    const video = request as VideoRequest;
    const firstFrameField = text(adapter.firstFrameField);
    const lastFrameField = text(adapter.lastFrameField);
    if (firstFrameField && video.firstFrame) input[firstFrameField] = mediaUrl(video.firstFrame);
    if (lastFrameField && video.lastFrame) input[lastFrameField] = mediaUrl(video.lastFrame);
    if (video.resolution) parameters.resolution = video.resolution;
    if (video.duration) parameters.duration = video.duration;
    if (video.ratio) parameters.ratio = video.ratio;
    if (typeof video.watermark === "boolean") parameters.watermark = video.watermark;
  } else if (mediaType === "image") {
    const image = request as ImageRequest;
    if (image.size) parameters.size = image.size;
    if (image.ratio) parameters.ratio = image.ratio;
    if (image.n) parameters.n = image.n;
  } else {
    const audio = request as AudioRequest;
    // ACT: Qwen-Audio-TTS（SpeechSynthesizer）要求 voice/format/sample_rate 等放在 input 内，
    // 而非 parameters；用 adapter.audioParamsInInput 声明放置位置，一套引擎兼容两类接口约定。
    const target = adapter.audioParamsInInput ? input : parameters;
    if (audio.voice) target.voice = audio.voice;
    if (audio.format) target.format = audio.format;
    if (audio.sampleRate) target.sample_rate = audio.sampleRate;
    if (audio.speed) target.speed = audio.speed;
    if (audio.volume) target.volume = audio.volume;
    if (audio.pitch) target.pitch = audio.pitch;
    if (audio.language) target.language = audio.language;
  }

  return {
    model: model.id,
    input: { ...(adapter.inputDefaults as Record<string, unknown> | undefined), ...input },
    parameters: { ...(adapter.paramDefaults as Record<string, unknown> | undefined), ...parameters },
  };
}

async function postJson(context: ProviderContext, url: string, apiKey: string, body: unknown, isAsync: boolean, signal: AbortSignal) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (isAsync) headers["X-DashScope-Async"] = "enable";
  const response = await context.tool.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(context.tool.errorMessage?.(data) || `请求失败：HTTP ${response.status}`);
  return data;
}

function extractAsset(context: ProviderContext, data: unknown, adapter: Record<string, unknown>, mediaType: MediaKind): MediaAsset[] {
  const url = text(pick(data, adapter.resultPath));
  if (url) return [{ mediaType, type: "url", url }];
  // ACT: 部分模型（如 TTS）直接返回 base64 数据而非地址，用 dataPath/mimeTypePath 描述。
  const inline = text(pick(data, adapter.dataPath));
  if (inline) {
    const mimeType = text(pick(data, adapter.mimeTypePath))
      || (mediaType === "audio" ? "audio/wav" : mediaType === "image" ? "image/png" : "video/mp4");
    return [{ mediaType, type: "base64", mimeType, data: inline.replace(/^data:[^;]+;base64,/, "") }];
  }
  throw new Error(context.tool.errorMessage?.(data) || "生成成功但未返回结果");
}

async function pollTask(context: ProviderContext, base: string, apiKey: string, adapter: Record<string, unknown>,
  taskId: string, mediaType: MediaKind, signal: AbortSignal): Promise<MediaAsset[]> {
  const taskEndpoint = text(adapter.taskEndpoint) || "/api/v1/tasks";
  const statusPath = text(adapter.taskStatusPath) || "output.task_status";
  while (true) {
    const response = await context.tool.fetch(`${base}${taskEndpoint}/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(context.tool.errorMessage?.(data) || `查询任务失败：HTTP ${response.status}`);
    const status = text(pick(data, statusPath)).toUpperCase();
    if (["SUCCEEDED", "SUCCESS", "COMPLETED"].includes(status)) return extractAsset(context, data, adapter, mediaType);
    if (["FAILED", "FAILURE", "CANCELED", "CANCELLED", "UNKNOWN", "ERROR"].includes(status)) {
      throw new Error(context.tool.errorMessage?.(data) || `${typeLabel(mediaType)}生成失败`);
    }
    await wait(signal, pollInterval);
  }
}

async function generateOne(context: ProviderContext, base: string, apiKey: string, model: ProviderModel,
  request: AnyRequest, mediaType: MediaKind, signal: AbortSignal): Promise<MediaAsset[]> {
  const adapter = model.adapter ?? {};
  const endpoint = text(adapter.endpoint);
  if (!endpoint) throw new Error(`模型 ${model.id} 未配置 adapter.endpoint`);
  // ACT: DashScope 生成类接口默认异步；adapter.callMode === "sync" 时走同步返回。
  const isAsync = text(adapter.callMode) !== "sync";
  const data = await postJson(context, `${base}${endpoint}`, apiKey, buildBody(model, request, mediaType), isAsync, signal);
  if (!isAsync) return extractAsset(context, data, adapter, mediaType);
  const taskId = text(pick(data, text(adapter.taskIdPath) || "output.task_id"));
  if (!taskId) throw new Error(context.tool.errorMessage?.(data) || "提交任务未返回任务 ID");
  return pollTask(context, base, apiKey, adapter, taskId, mediaType, signal);
}

function priorityOf(model: ProviderModel): number {
  return num(pick(model.adapter, "priority")) ?? 999;
}

// ACT: 首选为节点选中的模型，其余同类型候选按 priority 升序作为回退。
function orderCandidates(models: ProviderModel[], pickedId: string): ProviderModel[] {
  const byPriority = [...models].sort((left, right) => priorityOf(left) - priorityOf(right));
  const picked = byPriority.find(model => model.id === pickedId);
  if (!picked) return byPriority;
  return [picked, ...byPriority.filter(model => model.id !== pickedId)];
}

async function run(context: ProviderContext, request: AnyRequest, mediaType: MediaKind): Promise<MediaAsset[]> {
  const apiKey = text(context.config.apiKey).replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请先在媒体模型设置中填写百炼 API Key");
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
  id: "aiRouter",
  label: "AI-Router",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ff6a00' d='M12 2l2.4 7.2H22l-6.2 4.5 2.4 7.3L12 16.9 5.8 21l2.4-7.3L2 9.2h7.6z'/%3E%3C/svg%3E",
  version,
  readme: `## AI-Router（DashScope / 阿里云百炼）

配置驱动的媒体供应商：视频、图片、语音（TTS）均支持，模型与接口全部可在「设置 → 媒体模型」中编辑。

- **接口地址**：Token Plan 密钥（\`sk-sp-\`）默认使用 \`https://token-plan.cn-beijing.maas.aliyuncs.com\`；标准密钥（\`sk-\`）可改为 \`https://dashscope.aliyuncs.com\`。
- **多候选回退**：同一能力可配置多个模型，按 \`adapter.priority\` 排序，首选失败自动回退。
- **异步/同步**：每个模型通过 \`adapter.callMode\` 声明；异步走「提交任务 + 轮询」，同步直接返回。
- **语音合成（TTS）**：\`qwen-audio-3.0-tts-plus\` 走同步 \`/api/v1/services/audio/tts/SpeechSynthesizer\`，\`voice/format/sample_rate\` 放在 \`input\` 内（\`adapter.audioParamsInInput = true\`）；音色须属于该模型（如 \`longanlingxin\`），跨模型会报 InvalidParameter。
- **声音复刻（voice cloning）**：\`POST /api/v1/services/audio/tts/customization\`，\`model: "voice-enrollment"\`，\`input.action: "create_voice"\`（传 \`target_model\`、\`prefix\`、参考音频 \`audio\`）→ \`output.voice_id\`；轮询 \`query_voice\` 至 \`status === "OK"\` 后，把该 \`voice_id\` 填入 TTS 的 \`voice\` 即可用克隆音色合成（复刻音色绑定 target_model，不可跨模型）。

> ACT: Token Plan 密钥当前仅放开视频生成（HappyHorse / Wan 视频，异步）。图片与 TTS 已按 DashScope 原生接口接好，待填入具备相应权限的密钥即可启用，无需改代码。

> ACT: 视频模型默认同步生成音效（\`adapter.paramDefaults.audio = true\`）——即视频文件自带与画面同步的声音（环境音/音效）。如需无声视频，把对应模型的 \`audio\` 改为 \`false\` 即可，无需改代码。旁白（TTS）与背景音乐（BGM）仍由各自的供应商单独生成，最终在合成阶段与视频原生音轨混音。`,
  rules,
  models: [
    {
      id: "happyhorse-1.1-t2v",
      label: "HappyHorse 1.1 文生视频",
      type: "video",
      mode: ["text"],
      durationResolutionMap: [{ duration: [5], resolution: ["480P", "720P", "1080P"] }],
      adapter: {
        priority: 1,
        callMode: "async",
        endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
        taskEndpoint: "/api/v1/tasks",
        taskIdPath: "output.task_id",
        taskStatusPath: "output.task_status",
        resultPath: "output.video_url",
        // ACT: audio=true 让视频模型在生成画面的同时生成音效（如刀剑碰撞、风声）。
        // happyhorse 默认即有声，此处显式声明以确保行为稳定、且可在配置中一键关闭。
        paramDefaults: { resolution: "720P", duration: 5, audio: true },
      },
    },
    {
      id: "wan3.0-video",
      label: "Wan3.0 文生视频",
      type: "video",
      mode: ["text"],
      durationResolutionMap: [{ duration: [5], resolution: ["480P", "720P", "1080P"] }],
      adapter: {
        priority: 2,
        callMode: "async",
        endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
        taskEndpoint: "/api/v1/tasks",
        taskIdPath: "output.task_id",
        taskStatusPath: "output.task_status",
        resultPath: "output.video_url",
        // ACT: wan3.0-video 的 parameters.audio 默认为 true（输出含声轨）；显式声明以确保同步生成音效。
        paramDefaults: { resolution: "480P", audio: true },
      },
    },
    {
      id: "wan2.7-image",
      label: "Wan2.7 图像生成",
      type: "image",
      mode: ["text", "singleImage"],
      imageSizes: ["1024*1024", "1280*720", "720*1280"],
      imageRatios: ["1:1", "16:9", "9:16"],
      adapter: {
        priority: 1,
        callMode: "async",
        endpoint: "/api/v1/services/aigc/text2image/image-synthesis",
        taskEndpoint: "/api/v1/tasks",
        taskIdPath: "output.task_id",
        taskStatusPath: "output.task_status",
        resultPath: "output.results.0.url",
        paramDefaults: { size: "1024*1024", n: 1 },
      },
    },
    {
      id: "qwen-image-3.0-pro",
      label: "Qwen-Image 3.0 Pro",
      type: "image",
      mode: ["text"],
      imageSizes: ["1024*1024", "1328*1328"],
      imageRatios: ["1:1", "16:9", "9:16"],
      adapter: {
        priority: 2,
        callMode: "async",
        endpoint: "/api/v1/services/aigc/text2image/image-synthesis",
        taskEndpoint: "/api/v1/tasks",
        taskIdPath: "output.task_id",
        taskStatusPath: "output.task_status",
        resultPath: "output.results.0.url",
        paramDefaults: { n: 1, size: "1328*1328" },
      },
    },
    {
      id: "qwen-audio-3.0-tts-plus",
      label: "Qwen-Audio 语音合成 3.0 Plus",
      type: "audio",
      // ACT: voice 必须属于本模型（qwen-audio-3.0-tts-plus）的支持列表，跨模型会报 InvalidParameter；
      // 完整音色见百炼「Qwen-Audio-TTS 音色列表」，也可填入「声音复刻」生成的 voice_id。
      voices: [
        { title: "龙安灵心 longanlingxin（女·温暖治愈）", voice: "longanlingxin" },
        { title: "龙安路风 longanlufeng", voice: "longanlufeng" },
      ],
      adapter: {
        priority: 1,
        // ACT: Qwen-Audio-TTS 走同步 SpeechSynthesizer 接口，一次请求直接返回 output.audio.url。
        callMode: "sync",
        endpoint: "/api/v1/services/audio/tts/SpeechSynthesizer",
        // ACT: 官方约定 voice/format/sample_rate 放在 input 内（而非 parameters），故开启此开关。
        audioParamsInInput: true,
        resultPath: "output.audio.url",
        dataPath: "output.audio.data",
        mimeTypePath: "output.audio.mimeType",
        inputDefaults: { voice: "longanlingxin", format: "wav", sample_rate: 24000 },
        // ACT: 声音复刻（voice cloning）——先用独立接口创建 voice_id，再把该 id 填入 voice 即可使用。
        // POST {base}/api/v1/services/audio/tts/customization
        //   创建: { model: "voice-enrollment", input: { action: "create_voice", target_model: "qwen-audio-3.0-tts-plus", prefix: "myvoice", audio: "<公网URL 或 base64 data uri>" } } → output.voice_id
        //   轮询: { model: "voice-enrollment", input: { action: "query_voice", voice_id } } → output.status === "OK" 后可用
        //   复刻音色绑定 target_model，不可跨模型；音频要求 WAV/MP3/M4A、10~20s（≤60s）、≤10MB、≥16kHz。
        voiceEnrollment: {
          endpoint: "/api/v1/services/audio/tts/customization",
          enrollmentModel: "voice-enrollment",
          targetModel: "qwen-audio-3.0-tts-plus",
        },
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
