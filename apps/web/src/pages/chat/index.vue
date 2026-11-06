<template>
  <main class="chat" :style="{ '--chat-w': chatWidth + 'px' }">
    <!-- ACT: 未登录时整页只给出登录引导；登录态由顶栏/账户页共用的 loginDialog 提供。 -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可参与群聊')">
        <el-button type="primary" @click="loginVisible = true">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <template v-else>
      <!-- 左栏：视频播放与截图舞台 -->
      <videoStage :items="videoItems" v-model="selectedVideoId" />

      <!-- ACT: 可拖拽竖直分隔条：按住左右移动实时改右栏（聊天框）宽度。 -->
      <div class="chatResize" :class="{ dragging: resizing }" @pointerdown="onResizeDown" />

      <!-- 右栏：当前房间的消息流与输入区 -->
      <section class="chatPanel">
        <header class="chatHeader">
          <el-select
            class="roomSelect"
            :model-value="activeRoomId || undefined"
            :placeholder="translate('切换群聊')"
            :disabled="!ready"
            @update:model-value="setActiveRoom">
            <el-option v-for="room in joinedRooms" :key="room.id" :label="room.name" :value="room.id" />
          </el-select>
          <span class="chatStatus">
            <el-tag v-if="chatError" type="danger" size="small" effect="plain">{{ translate("连接失败") }}</el-tag>
            <el-tag v-else-if="connecting" type="info" size="small" effect="plain">{{ translate("连接中…") }}</el-tag>
            <el-tag v-else-if="ready" type="success" size="small" effect="plain">{{ translate("已连接") }}</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">{{ translate("未连接") }}</el-tag>
            <el-tag v-if="isHost" type="warning" size="small" effect="plain">{{ translate("主持人") }}</el-tag>
          </span>
          <div class="chatHeaderActions">
            <el-popover v-if="invites.length" placement="bottom-end" :width="260" trigger="click">
              <template #reference>
                <el-badge :value="invites.length" :max="9" class="inviteBadge">
                  <button class="roomAction" type="button" :aria-label="translate('待接受邀请')">
                    <icon-bell :size="18" aria-hidden="true" />
                  </button>
                </el-badge>
              </template>
              <ul class="inviteList">
                <li v-for="room in invites" :key="room.id">
                  <span class="inviteName">{{ room.name }}</span>
                  <el-button size="small" type="primary" plain :loading="busyRoom === room.id" :disabled="!ready" @click="accept(room.id)">
                    {{ translate("加入") }}
                  </el-button>
                </li>
              </ul>
            </el-popover>
            <el-tooltip :content="translate('新建群聊')" placement="bottom" :show-after="100">
              <button class="roomAction" type="button" :disabled="!ready" :aria-label="translate('新建群聊')" @click="createVisible = true">
                <icon-plus :size="18" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('加入群聊')" placement="bottom" :show-after="100">
              <button class="roomAction" type="button" :disabled="!ready" :aria-label="translate('加入群聊')" @click="joinVisible = true">
                <icon-link :size="18" aria-hidden="true" />
              </button>
            </el-tooltip>
          </div>
        </header>

        <el-scrollbar ref="scroller" class="chatBody">
          <div class="messageList">
            <p v-if="!activeRoomId" class="emptyHint">{{ translate("还没有群聊，点右上角新建一个。") }}</p>
            <p v-else-if="!timeline.length" class="emptyHint">{{ translate("还没有消息，发送第一条开始讨论吧。") }}</p>
            <div v-for="msg in timeline" :key="msg.id" class="messageRow" :class="{ mine: msg.mine, anchored: anchoredId === msg.id }" :data-event-id="msg.id">
              <!-- ACT: 圆形头像置于气泡外侧（他人左/自己右），替代原先气泡内的发送者名字；无头像时用首字母占位圆。 -->
              <span v-if="!msg.mine" class="msgAvatar" :aria-label="msg.senderName">
                <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
                <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
              </span>
              <div class="bubble">
                <div class="meta">
                  <span class="time">{{ formatTime(msg.ts) }}</span>
                </div>
                <button v-if="msg.msgtype === 'm.video' && msg.url" type="button" class="videoCard" :class="{ active: msg.id === selectedVideoId }" @click="selectedVideoId = msg.id">
                  <span class="videoCardIcon" :style="{ '--tool-icon': `url(&quot;${iconMovieFilm}&quot;)` }" aria-hidden="true" />
                  <span class="videoCardName">{{ msg.body || translate("视频") }}</span>
                </button>
                <el-image v-else-if="msg.msgtype === 'm.image' && msg.url" class="media" :src="msg.url" fit="contain" :preview-src-list="[msg.url]" />
                <p class="text">{{ msg.body }}</p>
              </div>
              <span v-if="msg.mine" class="msgAvatar" :aria-label="msg.senderName">
                <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
                <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
              </span>
            </div>
          </div>
        </el-scrollbar>

        <div class="typingBar" aria-live="polite">
          <span v-if="typingNames.length">{{ typingNames.join("、") }} 正在输入…</span>
        </div>

        <footer class="chatComposer">
          <div class="composerMain">
            <el-input
              v-model="draft"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 5 }"
              resize="none"
              :disabled="!ready || !activeRoomId"
              :placeholder="translate('输入消息，Enter 发送，Shift+Enter 换行')"
              :aria-label="translate('消息输入')"
              @input="noteTyping"
              @keydown.enter.exact.prevent="send" />
            <el-button class="sendButton" type="primary" :disabled="!ready || !activeRoomId || !draft.trim()" :aria-label="translate('发送')" :title="translate('发送')" @click="send">
              <icon-send :size="18" aria-hidden="true" />
            </el-button>
          </div>

          <div class="composerTools">
            <!-- ACT: 只有房间主持人能看到生成视频入口，两个图标按钮把意图带到我的工作室（Task 4 读取 query），名称作 tooltip。 -->
            <div v-if="isHost" class="hostTools">
              <el-button class="toolButton" :disabled="!ready || !activeRoomId" :aria-label="translate('一键生成视频')" :title="translate('一键生成视频')" @click="goStudio('auto')">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconOneShot}&quot;)` }" aria-hidden="true" />
              </el-button>
              <el-button class="toolButton" :disabled="!ready || !activeRoomId" :aria-label="translate('分步生成视频')" :title="translate('分步生成视频')" @click="goStudio('step')">
                <span class="toolIcon enlarged" :style="{ '--tool-icon': `url(&quot;${iconStepByStep}&quot;)` }" aria-hidden="true" />
              </el-button>
            </div>
            <div class="toolGroup">
              <el-button class="toolButton" :aria-label="translate('团队')" :title="translate('团队')" @click="team">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconUserGroup}&quot;)` }" aria-hidden="true" />
              </el-button>
              <el-button class="toolButton" :aria-label="translate('上传文件')" :title="translate('上传文件')" @click="fileInput?.click()">
                <span class="toolIcon wide" :style="{ '--tool-icon': `url(&quot;${iconFileUpload}&quot;)` }" aria-hidden="true" />
              </el-button>
              <input ref="fileInput" type="file" multiple hidden :disabled="!ready" @change="onPickFiles" />
            </div>
          </div>
        </footer>
      </section>
    </template>

    <loginDialog v-model="loginVisible" />

    <!-- 新建群聊：名称 + 可选邀请成员 -->
    <el-dialog v-model="createVisible" :title="translate('新建群聊')" width="min(420px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false">
      <el-form class="roomForm" label-position="top" @submit.prevent="submitCreate">
        <el-form-item :label="translate('群聊名称')">
          <el-input v-model="createName" maxlength="60" :disabled="actionBusy" :placeholder="translate('例如：我的剧组')" @keydown.enter="submitCreate" />
        </el-form-item>
        <el-form-item :label="translate('邀请成员')">
          <el-input v-model="createInvite" :disabled="actionBusy" :placeholder="translate('用户名以逗号分隔，例如 friend1, friend2')" @keydown.enter="submitCreate" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialogFooter">
          <el-button :disabled="actionBusy" @click="createVisible = false">{{ translate("取消") }}</el-button>
          <el-button type="primary" :loading="actionBusy" :disabled="!createName.trim()" @click="submitCreate">{{ translate("创建") }}</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 加入群聊：房间 ID 或别名 -->
    <el-dialog v-model="joinVisible" :title="translate('加入群聊')" width="min(420px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false">
      <el-form class="roomForm" label-position="top" @submit.prevent="submitJoin">
        <el-form-item :label="translate('房间 ID 或别名')">
          <el-input v-model="joinTarget" :disabled="actionBusy" placeholder="!xxxx:localhost / #name:localhost" @keydown.enter="submitJoin" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialogFooter">
          <el-button :disabled="actionBusy" @click="joinVisible = false">{{ translate("取消") }}</el-button>
          <el-button type="primary" :loading="actionBusy" :disabled="!joinTarget.trim()" @click="submitJoin">{{ translate("加入") }}</el-button>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type ScrollbarInstance } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import loginDialog from "@/components/loginDialog.vue";
// ACT: 工具按钮图标统一取自 src/icons（CSS mask + currentColor 着色，与全局外壳一致）。
import iconUserGroup from "@/icons/user_group.svg";
import iconFileUpload from "@/icons/file_upload.svg";
import iconOneShot from "@/icons/generator_one_shot.svg";
import iconStepByStep from "@/icons/generator_step_by_step.svg";
import iconMovieFilm from "@/icons/movie_film.svg";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import videoStage from "./components/videoStage.vue";

// ACT: 群聊页（计划 Task 3）——左栏房间列表 + 右栏会话。
// 客户端是模块级单例：离开本页不再 teardown，登录态消失时由 useMatrixChat 内部的 auth 监听负责断开。
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const {
  ready, connecting, error: chatError, joinedRooms, invites,
  activeRoomId, isHost, timeline, typingNames,
  bootstrap, setActiveRoom, createRoom, joinRoom, acceptInvite,
  sendText, noteTyping,
} = useMatrixChat();

const draft = ref("");
const scroller = ref<ScrollbarInstance>();
const fileInput = ref<HTMLInputElement>();
const loginVisible = ref(false);
const createVisible = ref(false);
const createName = ref("");
const createInvite = ref("");
const joinVisible = ref(false);
const joinTarget = ref("");
const busyRoom = ref("");
const actionBusy = ref(false);

// ── 视频舞台选择状态 ──
const selectedVideoId = ref("");
const videoItems = computed(() =>
  timeline.value.filter(m => m.msgtype === "m.video" && m.url).map(m => ({ id: m.id, url: m.url!, name: m.body })),
);

// ── 视频舞台与聊天区之间的分隔条拖拽 ──
// ACT: pointerdown 记下起始 X，pointermove 用窗口宽度 - clientX 算出右栏宽度，夹紧到 [320, vw*0.55]。
const CHAT_MIN = 320;
const chatWidth = ref(400);
const resizing = ref(false);

function onResizeDown(event: PointerEvent) {
  event.preventDefault();
  resizing.value = true;
  document.addEventListener("pointermove", onResizeMove);
  document.addEventListener("pointerup", onResizeUp);
}
function onResizeMove(event: PointerEvent) {
  if (!resizing.value) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, window.innerWidth - event.clientX));
}
function onResizeUp() {
  if (!resizing.value) return;
  resizing.value = false;
  document.removeEventListener("pointermove", onResizeMove);
  document.removeEventListener("pointerup", onResizeUp);
}
onBeforeUnmount(onResizeUp);

// ── 广场深链：切到指定房间并滚动到指定消息 ──
// ACT: 广场卡片点击带 ?room=&event= 进来：先切房间，再轮询等事件出现在时间线里，
// 然后 scrollIntoView 到该消息并短暂高亮。锚定期间抑制自动滚底，
// 否则视图会被 scrollToBottom 抢回最新一条，用户看不到视频所在位置。
const anchoredId = ref("");
let suppressAutoScroll = false;
let anchorTimer: ReturnType<typeof setTimeout> | null = null;

async function anchorFromQuery() {
  const roomId = typeof route.query.room === "string" ? route.query.room : "";
  const eventId = typeof route.query.event === "string" ? route.query.event : "";
  if (!roomId || !auth.signedIn || !ready.value) return;
  suppressAutoScroll = !!eventId;
  if (activeRoomId.value !== roomId) setActiveRoom(roomId);
  if (!eventId) { suppressAutoScroll = false; return; }
  const deadline = Date.now() + 5000;
  while (!timeline.value.some(msg => msg.id === eventId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await nextTick();
  suppressAutoScroll = false;
  const wrap = scroller.value?.wrapRef;
  const target = wrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`) ?? null;
  // ACT: 同步窗口之外的事件不在本地时间线里：只切房间，不强制定位。
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  anchoredId.value = eventId;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => { anchoredId.value = ""; }, 2600);
}
watch([() => route.query.room, () => route.query.event, ready, () => auth.signedIn], () => { void anchorFromQuery(); }, { immediate: true });
onBeforeUnmount(() => { if (anchorTimer) clearTimeout(anchorTimer); });

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function scrollToBottom() {
  if (suppressAutoScroll) return;
  await nextTick();
  const wrap = scroller.value?.wrapRef;
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

async function send() {
  const text = draft.value.trim();
  if (!text || !ready.value || !activeRoomId.value) return;
  draft.value = "";
  try {
    await sendText(text);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送失败");
  }
}

// 把 host / @host / @host:localhost 统一补成完整 Matrix ID（邀请成员用）。
function toMxid(input: string) {
  const name = input.trim();
  if (!name) return "";
  if (name.startsWith("@")) return name;
  if (name.includes(":")) return `@${name}`;
  const serverName = auth.myUserId.split(":")[1] || "localhost";
  return `@${name}:${serverName}`;
}

async function submitCreate() {
  if (actionBusy.value || !createName.value.trim()) return;
  actionBusy.value = true;
  try {
    await createRoom({
      name: createName.value,
      invite: createInvite.value.split(/[,，\s]+/).map(toMxid).filter(Boolean),
    });
    createVisible.value = false;
    createName.value = "";
    createInvite.value = "";
    ElMessage.success("群聊已创建");
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "创建群聊失败");
  } finally {
    actionBusy.value = false;
  }
}

async function submitJoin() {
  if (actionBusy.value || !joinTarget.value.trim()) return;
  actionBusy.value = true;
  try {
    await joinRoom(joinTarget.value);
    joinVisible.value = false;
    joinTarget.value = "";
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加入群聊失败");
  } finally {
    actionBusy.value = false;
  }
}

async function accept(roomId: string) {
  if (busyRoom.value) return;
  busyRoom.value = roomId;
  try {
    await acceptInvite(roomId);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加入群聊失败");
  } finally {
    busyRoom.value = "";
  }
}

// ACT: 主持人的两个生成入口只负责把模式与房间带到我的工作室；真正的流水线在 Task 4 之后接入。
function goStudio(mode: "auto" | "step") {
  void router.push({ path: "/workspace", query: { mode, room: activeRoomId.value } });
}

// ACT: 团队与附件上传为占位入口，实际能力在后续任务接入。
function team() { ElMessage.info("团队功能将在后续任务接入"); }
function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const count = input.files?.length ?? 0;
  input.value = "";
  if (count) ElMessage.info("附件上传将在后续任务接入");
}

async function start() {
  if (!auth.signedIn) return;
  const ok = await bootstrap();
  if (!ok && chatError.value === "unavailable") ElMessage.error("无法连接 Matrix/Synapse，请确认本地 Synapse 已启动且已配置 config.json 的 synapse 块");
  await scrollToBottom();
}

watch(() => timeline.value.length, scrollToBottom);
watch(activeRoomId, scrollToBottom);
// ACT: 登录/退出都会切换 signedIn；登录后自动接上 Matrix 客户端（退出时的断开由 useMatrixChat 负责）。
watch(() => auth.signedIn, value => { if (value) void start(); });

onMounted(async () => {
  await auth.restore();
  await start();
});
</script>

<style lang="scss" scoped>
.chat {
  display: grid;
  // ACT: 三列：视频舞台（弹性占满）+ 4px 分隔条 + 聊天框（宽度由拖拽变量 --chat-w 决定）。
  grid-template-columns: minmax(0, 1fr) 4px var(--chat-w, 400px);
  height: 100%;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  // ACT: 显式钉住基准字号 14px，与设置页保持一致（不继承 body 的 16px）。
  font-size: 14px;
}

.signedOut {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

// ACT: 分隔条平时透明，悬停/拖拽时亮主色给出反馈。
.chatResize {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;

  &:hover, &.dragging { background: var(--el-color-primary); }
}

.roomAction {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: var(--ui-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.chatPanel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  min-width: 0;
  min-height: 0;
}

.chatHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--shell-page-header-h, 56px);
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  .roomSelect {
    flex-shrink: 1;
    min-width: 0;
    max-width: 180px;
  }

  .chatStatus {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .chatHeaderActions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
    flex-shrink: 0;
  }

  .inviteBadge {
    :deep(.el-badge__content) { z-index: 1; }
  }
}

.inviteList {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;

    &:not(:last-child) { border-bottom: 1px solid var(--el-border-color-lighter); }
  }

  .inviteName {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.chatBody {
  min-height: 0;

  .messageList {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }

  .emptyHint {
    margin: auto;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    text-align: center;
  }

  .messageRow {
    display: flex;
    align-items: flex-end;
    gap: 8px;

    &.mine {
      justify-content: flex-end;

      .bubble {
        background: var(--el-color-primary-light-9);
      }
    }

    // ACT: 广场深链定位到的目标消息：主色描边 + 淡底高亮，约 2.6 秒后自动清除。
    &.anchored .bubble {
      background: var(--el-color-primary-light-9);
      outline: 2px solid var(--el-color-primary);
      outline-offset: 2px;
    }
  }

  // ACT: 气泡旁的圆形头像（替代气泡内发送者名字）；与气泡底边对齐，无头像时首字母占位。
  .msgAvatar {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--el-fill-color);
    color: var(--el-text-color-regular);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .initial {
      font-size: 14px;
      font-weight: 600;
    }
  }

  .bubble {
    max-width: min(72%, 640px);
    padding: 8px 12px;
    border-radius: var(--ui-radius);
    background: var(--el-fill-color-light);

    .meta {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;

      .time {
        font-size: 11px;
        color: var(--el-text-color-secondary);
      }
    }

    .media {
      max-width: 100%;
      border-radius: calc(var(--ui-radius) * 0.75);
      margin-bottom: 4px;
    }

    // ACT: 视频卡片：可点击加载到左侧舞台播放，选中时高亮边框。
    .videoCard {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--el-border-color);
      border-radius: calc(var(--ui-radius) * 0.75);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: start;
      transition: border-color 0.15s ease, background 0.15s ease;

      &:hover { background: var(--el-fill-color); }
      &.active {
        border-color: var(--el-color-primary);
        background: var(--el-color-primary-light-9);
      }
    }

    .videoCardIcon {
      display: block;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
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

    .videoCardName {
      overflow: hidden;
      font-size: 13px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .text {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
}

.typingBar {
  min-height: 20px;
  padding: 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.chatComposer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);

  .composerMain {
    display: flex;
    align-items: flex-end;
    gap: 12px;

    :deep(.el-textarea) {
      flex: 1;
    }
  }

  // ACT: 发送为蓝色圆角方块（对齐 drone 的 CHAT_SEND），下一行左侧是主持人生成入口、右侧是工具按钮。
  .sendButton {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 10px;
  }

  .composerTools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .hostTools {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .el-button { margin: 0; }
  }

  .toolGroup {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-inline-start: auto;
  }

  .toolButton {
    width: 36px;
    height: 36px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 10px;
    background: transparent;
    color: var(--el-text-color-regular);

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  }

  // ACT: 图标用 mask + currentColor 着色，兼容内置固定填充色的 svg（与全局外壳同一做法）。
  // .wide 对应 viewBox 宽于高的图标（file_upload 1228x1024），
  // 按比例加宽盒子让 contain 后的视觉高度与方形图标一致。
  .toolIcon {
    display: block;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    background-color: currentColor;
    mask-image: var(--tool-icon);
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-image: var(--tool-icon);
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;

    &.wide { width: 22px; }

    // ACT: 分步生成字形偏疏，单独放大到 18px 的 120%（21.6px）以对齐邻项视觉重量。
    &.enlarged {
      width: 21.6px;
      height: 21.6px;
    }
  }
}

.roomForm {
  :deep(.el-form-item) { margin-bottom: 16px; }
  :deep(.el-form-item:last-child) { margin-bottom: 0; }
}

.dialogFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
