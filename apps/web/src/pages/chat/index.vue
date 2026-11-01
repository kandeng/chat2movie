<template>
  <main class="chat">
    <header class="chatHeader">
      <el-button text :icon="IconArrowLeft" @click="router.push('/home')">返回</el-button>
      <div class="chatTitle">
        <h1>{{ roomName || "群聊" }}</h1>
        <span class="chatStatus">
          <el-tag v-if="error" type="danger" size="small" effect="plain">连接失败</el-tag>
          <el-tag v-else-if="connecting" type="info" size="small" effect="plain">连接中…</el-tag>
          <el-tag v-else-if="ready" type="success" size="small" effect="plain">已连接 · {{ myUserId }}</el-tag>
          <el-tag v-else type="info" size="small" effect="plain">未连接</el-tag>
        </span>
      </div>
    </header>

    <el-scrollbar ref="scroller" class="chatBody">
      <div class="messageList">
        <p v-if="!timeline.length" class="emptyHint">还没有消息，发送第一条开始讨论吧。</p>
        <div v-for="msg in timeline" :key="msg.id" class="messageRow" :class="{ mine: msg.mine }">
          <div class="bubble">
            <div class="meta">
              <span class="sender">{{ msg.senderName }}</span>
              <span class="time">{{ formatTime(msg.ts) }}</span>
            </div>
            <video v-if="msg.msgtype === 'm.video' && msg.url" class="media" :src="msg.url" controls />
            <el-image v-else-if="msg.msgtype === 'm.image' && msg.url" class="media" :src="msg.url" fit="contain" :preview-src-list="[msg.url]" />
            <p class="text">{{ msg.body }}</p>
          </div>
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
          :disabled="!ready"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          aria-label="消息输入"
          @input="noteTyping"
          @keydown.enter.exact.prevent="send" />
        <el-button class="sendButton" type="primary" :disabled="!ready || !draft.trim()" :aria-label="translate('发送')" :title="translate('发送')" @click="send">
          <icon-send :size="18" aria-hidden="true" />
        </el-button>
      </div>
      <div class="composerTools">
        <el-button class="toolButton" :disabled="!ready" :aria-label="translate('生成视频')" :title="translate('生成视频')" @click="generate">
          <icon-video :size="18" aria-hidden="true" />
        </el-button>
        <el-button class="toolButton" :aria-label="translate('团队')" :title="translate('团队')" @click="team">
          <icon-users :size="18" aria-hidden="true" />
        </el-button>
        <el-button class="toolButton" :aria-label="translate('上传文件')" :title="translate('上传文件')" @click="fileInput?.click()">
          <icon-folder :size="18" aria-hidden="true" />
        </el-button>
        <input ref="fileInput" type="file" multiple hidden :disabled="!ready" @change="onPickFiles" />
      </div>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type ScrollbarInstance } from "element-plus";
import { IconArrowLeft } from "@tabler/icons-vue";
import { translate } from "@toonflow/i18n/vue";
import { useMatrixChat } from "@/composables/useMatrixChat";

// ACT: 原型聊天页——单一演示房间、单一身份（host），无网站登录态。
// “生成视频”按钮只把机器人指令发进房间；真正触发生成由 Task 3 的机器人完成，在此之前它是普通消息。
const router = useRouter();
const { ready, connecting, error, myUserId, roomName, timeline, typingNames, bootstrap, teardown, sendText, sendGenerateCommand, noteTyping } = useMatrixChat();

const draft = ref("");
const scroller = ref<ScrollbarInstance>();
const fileInput = ref<HTMLInputElement>();

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function scrollToBottom() {
  await nextTick();
  const wrap = scroller.value?.wrapRef;
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

async function send() {
  const text = draft.value.trim();
  if (!text || !ready.value) return;
  draft.value = "";
  try {
    await sendText(text);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送失败");
  }
}

async function generate() {
  if (!ready.value) return;
  try {
    await sendGenerateCommand("!video");
    ElMessage.success("已发送生成视频指令");
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送指令失败");
  }
}

// ACT: 团队与附件上传为占位入口，实际能力在后续任务接入。
function team() { ElMessage.info(translate("团队功能将在后续任务接入")); }
function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const count = input.files?.length ?? 0;
  input.value = "";
  if (count) ElMessage.info(translate("附件上传将在后续任务接入"));
}

watch(() => timeline.value.length, scrollToBottom);

onMounted(async () => {
  const ok = await bootstrap();
  if (!ok) ElMessage.error("无法连接 Matrix/Synapse，请确认本地 Synapse 已启动且已配置 config.json 的 synapse 块");
  await scrollToBottom();
});
onBeforeUnmount(() => teardown());
</script>

<style lang="scss" scoped>
.chat {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  height: 100%;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);

  .chatHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--el-border-color-lighter);

    .chatTitle {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
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

      &.mine {
        justify-content: flex-end;

        .bubble {
          background: var(--el-color-primary-light-9);
        }
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

        .sender {
          font-size: 12px;
          font-weight: 600;
          color: var(--el-text-color-regular);
        }

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

    // ACT: 发送为蓝色圆角方块（对齐 drone 的 CHAT_SEND），工具按钮为描边圆角方块排在其下一行。
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
      justify-content: flex-end;
      gap: 8px;

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
    }
  }
}
</style>
