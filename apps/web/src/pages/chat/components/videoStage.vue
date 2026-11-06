<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import { useMatrixChat } from "@/composables/useMatrixChat";
// ACT: 播放/暂停字形取自 src/icons 的描边 SVG（与画笔工具箱同 1.9 描边），经 mask + currentColor 着色。
import iconVideoPlay from "@/icons/video_play.svg";
import iconVideoPause from "@/icons/video_pause.svg";

// ACT: 群聊页左侧「视频播放与截图」舞台：播放器 + 自定义控制条 + 画笔工具箱。
// 画笔层移植自 mesh-controller-codegen 的 MeshViewer：标记以归一化坐标存储（0..1），
// 面板缩放不丢笔迹；截图时把视频帧与画笔层合成一张 PNG（同源 blob 不污染 canvas）。
export type StageVideo = { id: string; url: string; name: string };

const props = defineProps<{ items: StageVideo[]; modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [id: string] }>();

const { ready, activeRoomId, sendImage } = useMatrixChat();

// ── 选择：用户未点选时自动跟随最新一条 ──
const current = computed(() => props.items.find(item => item.id === props.modelValue) ?? null);
watch(() => props.items, list => {
  if (list.some(item => item.id === props.modelValue)) return;
  emit("update:modelValue", list.length ? list[list.length - 1].id : "");
}, { immediate: true, deep: false });

// ── 播放器状态 ──
const videoRef = ref<HTMLVideoElement>();
const playing = ref(false);
const duration = ref(0);
const currentTime = ref(0);
const aspect = ref(16 / 9);
const sliding = ref(false);
const scrub = ref(0);

function fmt(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function onMeta() {
  const video = videoRef.value;
  if (!video) return;
  duration.value = Number.isFinite(video.duration) ? video.duration : 0;
  if (video.videoWidth && video.videoHeight) aspect.value = video.videoWidth / video.videoHeight;
  sizeInk();
}
function onTime() {
  const video = videoRef.value;
  if (video) currentTime.value = video.currentTime;
}
async function togglePlay() {
  const video = videoRef.value;
  if (!video || !current.value) return;
  if (video.paused) await video.play().catch(() => { playing.value = false; });
  else video.pause();
}
function onScrubDown() { sliding.value = true; scrub.value = currentTime.value; }
function onScrubUp() { sliding.value = false; }
function onScrubInput(event: Event) {
  const video = videoRef.value;
  if (!video) return;
  const value = Number((event.target as HTMLInputElement).value);
  scrub.value = value;
  video.currentTime = value;
  currentTime.value = value;
}

// ACT: 换片即清笔迹——标记属于某一帧/某一片，跨片保留只会造成误解。
watch(current, () => {
  playing.value = false;
  currentTime.value = 0;
  scrub.value = 0;
  clearMarks();
  void nextTick(sizeInk);
});

// ── 画笔层（移植自 MeshViewer 的 ink 层）──
type Mark = {
  kind: "arrow" | "rect" | "curve" | "text";
  x0?: number; y0?: number; x1?: number; y1?: number;
  pts?: [number, number][];
  x?: number; y?: number; text?: string; px?: number;
  color: string;
};

// ACT: 与 MeshViewer 相同的 20x20 描边字形，保证四支笔视觉重量一致。
const TOOLS = [
  { id: "arrow", label: "箭头", paths: ["M3 10 H16 M16 10 L11 5.5 M16 10 L11 14.5"] },
  { id: "rect", label: "矩形", paths: ["M4 4 H16 V16 H4 Z"] },
  { id: "curve", label: "自由曲线", paths: ["M3 13 C6 3, 8 17, 11 9 C13 4, 15 6, 17 8"] },
  { id: "text", label: "文字", paths: ["M5 5 H15 M10 5 V16"] },
] as const;

const GLYPHS = {
  clear: ["M4.5 6.5 H15.5", "M8 6.5 V4.5 H12 V6.5", "M6.5 6.5 L7.5 16 H12.5 L13.5 6.5"],
  escape: ["M6 6 L14 14", "M14 6 L6 14"],
  camera: ["M4 7.5 H7 L8.5 5.5 H11.5 L13 7.5 H16 V15 H4 Z", "M10 12.6 m-2.1 0 a2.1 2.1 0 1 0 4.2 0 a2.1 2.1 0 1 0 -4.2 0"],
  download: ["M10 4 V11.5", "M6.5 8.5 L10 12 L13.5 8.5", "M4.5 16 H15.5"],
} as const;

const boxRef = ref<HTMLElement>();
const inkRef = ref<HTMLCanvasElement>();
const textInput = ref<HTMLInputElement>();
const tool = ref<"" | "arrow" | "rect" | "curve" | "text">("");
const inkColor = ref("#ff3b30");
const marks = ref<Mark[]>([]);
let draft: Mark | null = null;
const textAt = ref<{ x: number; y: number } | null>(null);
const textDraft = ref("");

function sizeInk() {
  const canvas = inkRef.value;
  const box = boxRef.value;
  if (!canvas || !box) return;
  const dpr = window.devicePixelRatio || 1;
  const width = box.clientWidth;
  const height = box.clientHeight;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  redrawInk();
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, width: number, height: number) {
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (mark.kind === "arrow") {
    const x0 = (mark.x0 ?? 0) * width, y0 = (mark.y0 ?? 0) * height;
    const x1 = (mark.x1 ?? 0) * width, y1 = (mark.y1 ?? 0) * height;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = 12;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - 0.42), y1 - head * Math.sin(angle - 0.42));
    ctx.lineTo(x1 - head * Math.cos(angle + 0.42), y1 - head * Math.sin(angle + 0.42));
    ctx.closePath(); ctx.fill();
  } else if (mark.kind === "rect") {
    ctx.strokeRect(
      Math.min(mark.x0 ?? 0, mark.x1 ?? 0) * width, Math.min(mark.y0 ?? 0, mark.y1 ?? 0) * height,
      Math.abs((mark.x1 ?? 0) - (mark.x0 ?? 0)) * width, Math.abs((mark.y1 ?? 0) - (mark.y0 ?? 0)) * height,
    );
  } else if (mark.kind === "curve") {
    const pts = mark.pts ?? [];
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach(([px, py], index) => (index ? ctx.lineTo(px * width, py * height) : ctx.moveTo(px * width, py * height)));
    ctx.stroke();
  } else if (mark.kind === "text") {
    ctx.font = `${mark.px ?? 14}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    ctx.fillText(mark.text ?? "", (mark.x ?? 0) * width, (mark.y ?? 0) * height);
  }
}

function redrawInk() {
  const canvas = inkRef.value;
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  for (const mark of marks.value) drawMark(ctx, mark, width, height);
  if (draft) drawMark(ctx, draft, width, height);
}

function inkPos(event: PointerEvent) {
  const rect = inkRef.value!.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
    cx: event.clientX - rect.left,
    cy: event.clientY - rect.top,
  };
}

function inkDown(event: PointerEvent) {
  if (!tool.value) return;
  event.preventDefault();
  const point = inkPos(event);
  if (tool.value === "text") {
    textAt.value = { x: point.cx, y: point.cy };
    textDraft.value = "";
    void nextTick(() => textInput.value?.focus());
    return;
  }
  draft = tool.value === "curve"
    ? { kind: "curve", pts: [[point.x, point.y]], color: inkColor.value }
    : { kind: tool.value, x0: point.x, y0: point.y, x1: point.x, y1: point.y, color: inkColor.value };
  inkRef.value?.setPointerCapture?.(event.pointerId);
  redrawInk();
}

function inkMove(event: PointerEvent) {
  if (!draft) return;
  const point = inkPos(event);
  if (draft.kind === "curve") draft.pts?.push([point.x, point.y]);
  else { draft.x1 = point.x; draft.y1 = point.y; }
  redrawInk();
}

function inkUp() {
  if (!draft) return;
  const mark = draft;
  draft = null;
  // ACT: 几乎没移动的点击视为手滑，不落笔（与 MeshViewer 一致）。
  const real = mark.kind === "curve" ? (mark.pts?.length ?? 0) > 2 : Math.hypot((mark.x1 ?? 0) - (mark.x0 ?? 0), (mark.y1 ?? 0) - (mark.y0 ?? 0)) > 0.01;
  if (real) marks.value = [...marks.value, mark];
  redrawInk();
}

function commitText() {
  const at = textAt.value;
  const text = textDraft.value.trim();
  textAt.value = null;
  textDraft.value = "";
  if (!at || !text || !inkRef.value) return;
  const rect = inkRef.value.getBoundingClientRect();
  marks.value = [...marks.value, { kind: "text", x: at.x / rect.width, y: at.y / rect.height, text, px: 14, color: inkColor.value }];
  redrawInk();
}

function toggleTool(id: typeof tool.value) {
  tool.value = tool.value === id ? "" : id;
  draft = null;
  textAt.value = null;
  redrawInk();
}

function disarm() {
  tool.value = "";
  draft = null;
  textAt.value = null;
  redrawInk();
}

// ACT: 窗口级 Esc：与 MeshViewer 相同的双保险——未持笔时 Esc 归别人，焦点在文字草稿框时由框自己处理。
function onEsc(event: KeyboardEvent) {
  if (event.key !== "Escape" || !tool.value) return;
  if (event.target === textInput.value) return;
  disarm();
}

function clearMarks() {
  marks.value = [];
  draft = null;
  redrawInk();
}

// ── 截图：视频帧 + 画笔层合成 PNG ──
const busy = ref(false);

async function capture(): Promise<{ blob: Blob; width: number; height: number } | null> {
  const video = videoRef.value;
  const ink = inkRef.value;
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const out = document.createElement("canvas");
  out.width = video.videoWidth;
  out.height = video.videoHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, out.width, out.height);
  // ACT: 画笔层与视频内容盒完全重合（stageBox 按视频宽高比撑开），整幅缩放合成即可。
  if (ink && marks.value.length) ctx.drawImage(ink, 0, 0, out.width, out.height);
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, "image/png"));
  return blob ? { blob, width: out.width, height: out.height } : null;
}

async function screenshot() {
  if (busy.value) return;
  const shot = await capture();
  if (!shot) return;
  busy.value = true;
  try {
    const name = `vidsay-frame-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    await sendImage(new File([shot.blob], name, { type: "image/png" }), name, shot.width, shot.height);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("上传失败，请稍后重试"));
  } finally {
    busy.value = false;
  }
}

async function download() {
  const shot = await capture();
  if (!shot) return;
  const url = URL.createObjectURL(shot.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vidsay-frame-${Date.now()}.png`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let boxObserver: ResizeObserver | null = null;
onMounted(() => {
  window.addEventListener("keydown", onEsc);
  if (typeof ResizeObserver !== "undefined" && boxRef.value) {
    boxObserver = new ResizeObserver(() => sizeInk());
    boxObserver.observe(boxRef.value);
  }
  sizeInk();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEsc);
  boxObserver?.disconnect();
  boxObserver = null;
});
</script>

<template>
  <section class="stage">
    <div class="stageBoxWrap">
      <!-- ACT: 盒子按视频原生宽高比撑开（object-fit 无需 letterbox），画笔层与视频内容完全重合。 -->
      <!-- ACT: 无视频时保留 16:9 占位盒与控制条/画笔工具箱，仅按钮置灰，布局不随内容跳变。 -->
      <div ref="boxRef" class="stageBox" :class="{ empty: !current }" :style="{ aspectRatio: `${aspect}` }">
        <video
          v-if="current"
          ref="videoRef"
          :src="current.url"
          preload="metadata"
          @loadedmetadata="onMeta"
          @timeupdate="onTime"
          @play="playing = true"
          @pause="playing = false"
          @ended="playing = false" />
        <el-empty v-else :description="translate('该群聊还没有视频')" />
        <canvas
          ref="inkRef"
          class="ink"
          :style="{ pointerEvents: tool ? 'auto' : 'none' }"
          @pointerdown="inkDown"
          @pointermove="inkMove"
          @pointerup="inkUp" />
        <input
          v-if="textAt"
          ref="textInput"
          v-model="textDraft"
          class="inkText"
          :style="{ left: `${textAt.x}px`, top: `${textAt.y}px`, color: inkColor }"
          :placeholder="translate('输入文字，Enter 落笔，Esc 取消')"
          @keydown.enter.prevent="commitText"
          @keydown.escape.prevent="textAt = null"
          @blur="commitText" />
      </div>
    </div>

    <!-- ACT: 控制条：左播放/暂停、中滑杆、右时间盒（滑动时显示目标时间）。无视频时播放键禁用。 -->
    <div class="stageControls">
      <button
        class="ctlButton"
        type="button"
        :disabled="!current"
        :aria-label="playing ? translate('暂停') : translate('播放')"
        :title="playing ? translate('暂停') : translate('播放')"
        @click="togglePlay">
        <span class="pic" :style="{ '--tool-icon': `url(&quot;${playing ? iconVideoPause : iconVideoPlay}&quot;)` }" aria-hidden="true" />
      </button>
      <input
        class="scrubber"
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="sliding ? scrub : currentTime"
        :disabled="!duration"
        :aria-label="translate('滑动定位')"
        @pointerdown="onScrubDown"
        @pointerup="onScrubUp"
        @input="onScrubInput" />
      <span class="timeBox">{{ sliding ? fmt(scrub) : `${fmt(currentTime)} / ${fmt(duration)}` }}</span>
    </div>

    <!-- ACT: 画笔工具箱：四支笔 + 墨色 + 清除/放下 + 截图发送/下载。 -->
    <div class="pens">
      <button
        v-for="item in TOOLS"
        :key="item.id"
        type="button"
        class="penButton"
        :class="{ on: tool === item.id }"
        :title="translate(item.label)"
        :aria-label="translate(item.label)"
        @click="toggleTool(item.id)">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in item.paths" :key="index" :d="path" />
        </svg>
      </button>
      <input v-model="inkColor" type="color" :title="translate('墨色')" :aria-label="translate('墨色')" />
      <span class="sep" aria-hidden="true" />
      <button
        type="button"
        class="penButton"
        :disabled="!marks.length"
        :title="translate('清除标记')"
        :aria-label="translate('清除标记')"
        @click="clearMarks">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.clear" :key="index" :d="path" />
        </svg>
      </button>
      <button
        type="button"
        class="penButton"
        :class="{ on: !!tool }"
        :disabled="!tool"
        :title="translate('放下画笔')"
        :aria-label="translate('放下画笔')"
        @click="disarm">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.escape" :key="index" :d="path" />
        </svg>
      </button>
      <span class="sep" aria-hidden="true" />
      <button
        type="button"
        class="penButton"
        :disabled="!current || busy || !ready || !activeRoomId"
        :title="translate('截图并发送到群聊')"
        :aria-label="translate('截图并发送到群聊')"
        @click="screenshot">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.camera" :key="index" :d="path" />
        </svg>
      </button>
      <button
        type="button"
        class="penButton"
        :disabled="!current"
        :title="translate('下载截图')"
        :aria-label="translate('下载截图')"
        @click="download">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.download" :key="index" :d="path" />
        </svg>
      </button>
    </div>
  </section>
</template>

<style lang="scss" scoped>
// ACT: 背景对齐 Studio 画布：同底色 + 16px 点阵（Vue Flow Background 的 CSS 复现）。
.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background-color: var(--el-bg-color);
  background-image: radial-gradient(var(--el-border-color) 1px, transparent 1px);
  background-size: 16px 16px;
}

.stageBoxWrap {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 16px;
}

.stageBox {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  overflow: hidden;
  border-radius: var(--ui-radius);
  background: #000;

  // ACT: 无视频时的占位态：透明底 + 虚线框勾出播放器区域，空态文案居中于盒内。
  &.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--el-border-color);
    background: transparent;
  }

  :deep(.el-empty) { padding: 24px 0; }

  video {
    display: block;
    width: 100%;
    height: 100%;
  }

  .ink {
    position: absolute;
    inset: 0;
    touch-action: none;
  }

  .inkText {
    position: absolute;
    z-index: 2;
    padding: 2px 6px;
    border: 1px dashed currentColor;
    border-radius: 4px;
    background: color-mix(in srgb, var(--el-bg-color) 82%, transparent);
    font: 14px ui-monospace, monospace;
    outline: none;
  }
}

.stageControls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 10px;

  .ctlButton {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    // ACT: 边框用较浅的 --el-border-color，与聊天框 Generate 按钮边框同色；图标用 primary 文字色，与聊天框图标同深度；禁用态仅换光标。
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:disabled { cursor: not-allowed; }

    // ACT: 播放/暂停字形为 src/icons 的 1.9 描边 SVG，mask + currentColor 着色，与画笔/聊天框图标同色。
    .pic {
      background-color: currentColor;
      mask-image: var(--tool-icon);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--tool-icon);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
    }
  }

  // ACT: 滑杆轨道与滑块同图标色（regular 文字色），不再使用系统默认浅灰轨道；禁用态不降透明度。
  .scrubber {
    flex: 1;
    min-width: 0;
    height: 12px;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    outline: none;
    cursor: pointer;

    &::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 2px;
      background: var(--el-text-color-regular);
    }

    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4px;
      border-radius: 50%;
      background: var(--el-text-color-regular);
      cursor: pointer;
    }

    &::-moz-range-track {
      height: 4px;
      border-radius: 2px;
      background: var(--el-text-color-regular);
    }

    &::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 50%;
      background: var(--el-text-color-regular);
      cursor: pointer;
    }

    &:disabled { cursor: not-allowed; }
  }

  // ACT: 时间盒：滑动时显示滑杆目标时间，平时显示 当前/总长。
  .timeBox {
    flex-shrink: 0;
    min-width: 92px;
    padding: 3px 8px;
    // ACT: 边框用 --el-border-color，与播放按钮/画笔/聊天框各图标按钮边框同色。
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    background: var(--el-fill-color-light);
    color: var(--el-text-color-regular);
    font: 12px ui-monospace, monospace;
    text-align: center;
  }
}

.pens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 16px 14px;

  .penButton {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:disabled { opacity: 0.45; cursor: not-allowed; }
    &.on {
      border-color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
    }
  }

  // ACT: 墨色选择器：可见色块即内容盒，与笔按钮同视觉重量（同 MeshViewer 做法）。
  input[type="color"] {
    width: 30px;
    height: 30px;
    padding: 2px;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    cursor: pointer;

    &::-webkit-color-swatch-wrapper { padding: 0; }
    &::-webkit-color-swatch { border: none; border-radius: 4px; }
    &::-moz-color-swatch { border: none; border-radius: 4px; }
  }

  .sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--el-border-color);
  }
}

.pic {
  width: 18px;
  height: 18px;
}
</style>
