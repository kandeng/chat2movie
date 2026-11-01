<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { translate } from "@toonflow/i18n/vue";
// ACT: 品牌 Logo 改用本仓库绘制的 chat2movie.svg（双气泡+相机），替换原 Toonflow 图标。
import logoUrl from "@/assets/chat2movie.svg";
import languageSelect from "@/components/languageSelect.vue";
import settings from "@/components/settings/index.vue";

const route = useRoute();
const router = useRouter();

// ACT: 上组为内容页（广场/群聊/我的工作室），下组为账户；左栏为纯文本（对齐 drone），设置入口在下组并直接打开设置弹窗。
const topNav = [
  { path: "/home", label: "广场" },
  { path: "/chat", label: "群聊" },
  { path: "/workspace", label: "我的工作室" },
];
const bottomNav = [
  { path: "/account", label: "账户" },
];

function isActive(path: string) { return route.path === path; }
function go(path: string) { if (route.path !== path) void router.push(path); }

// ACT: 默认展开左栏，便于直接看到整体外观；顶栏圆形按钮可折叠/展开。
const open = ref(true);
const settingsVisible = ref(false);

// ── 左栏宽度拖拽（沿用 drone AppShell 的分隔条模式）──
const LEFT_MIN = 180;
const LEFT_MAX = 420;
const LEFT_DEFAULT = 260;
const leftWidth = ref(LEFT_DEFAULT);
const isDragging = ref(false);
const leftPanel = ref<HTMLElement>();

function onDividerPointerDown(event: PointerEvent) {
  event.preventDefault();
  isDragging.value = true;
  document.addEventListener("pointermove", onDividerPointerMove);
  document.addEventListener("pointerup", onDividerPointerUp);
}
function onDividerPointerMove(event: PointerEvent) {
  if (!isDragging.value || !leftPanel.value) return;
  const rect = leftPanel.value.getBoundingClientRect();
  leftWidth.value = Math.min(LEFT_MAX, Math.max(LEFT_MIN, event.clientX - rect.left));
}
function onDividerPointerUp() {
  if (!isDragging.value) return;
  isDragging.value = false;
  document.removeEventListener("pointermove", onDividerPointerMove);
  document.removeEventListener("pointerup", onDividerPointerUp);
}
onBeforeUnmount(onDividerPointerUp);
</script>

<template>
  <div class="appShell">
    <!-- 左栏：品牌 + 上组导航 + 弹性间隔 + 分隔线 + 下组导航 -->
    <aside v-if="open" ref="leftPanel" class="shellLeft" :style="{ width: leftWidth + 'px' }">
      <div class="shellBrand">
        <el-image class="brandLogo" :src="logoUrl" fit="contain" alt="chat2movie" />
        <span class="brandName">chat2movie</span>
      </div>

      <nav class="shellNav" :aria-label="translate('主导航')">
        <button
          v-for="item in topNav" :key="item.path"
          class="shellNavItem" :class="{ active: isActive(item.path) }"
          type="button" :aria-current="isActive(item.path) ? 'page' : undefined"
          :aria-label="translate(item.label)" :title="translate(item.label)"
          @click="go(item.path)">
          <span class="shellNavText">{{ translate(item.label) }}</span>
        </button>
      </nav>

      <div class="shellSpacer" />
      <div class="shellDivider" />

      <nav class="shellNav" :aria-label="translate('账户导航')">
        <button
          v-for="item in bottomNav" :key="item.path"
          class="shellNavItem" :class="{ active: isActive(item.path) }"
          type="button" :aria-current="isActive(item.path) ? 'page' : undefined"
          :aria-label="translate(item.label)" :title="translate(item.label)"
          @click="go(item.path)">
          <span class="shellNavText">{{ translate(item.label) }}</span>
        </button>
        <button
          class="shellNavItem"
          type="button"
          :aria-label="translate('设置')" :title="translate('设置')"
          @click="settingsVisible = true">
          <span class="shellNavText">{{ translate('设置') }}</span>
        </button>
      </nav>
    </aside>

    <!-- 可拖拽的竖直分隔条 -->
    <div v-if="open" class="shellResize" :class="{ dragging: isDragging }" @pointerdown="onDividerPointerDown" />

    <!-- 右列：顶栏 + 主面板 -->
    <div class="shellRight">
      <header class="shellTopbar">
        <div class="shellTopbarLeft">
          <button class="shellToggle" type="button" :aria-label="open ? translate('收起') : translate('展开')" @click="open = !open">
            <icon-layout-sidebar-left-collapse v-if="open" :size="18" aria-hidden="true" />
            <icon-layout-sidebar-left-expand v-else :size="18" aria-hidden="true" />
          </button>
        </div>

        <!-- 各页面通过 Teleport 投放提示的标准槽位（居中） -->
        <div class="shellTopbarNotices">
          <div id="shell-notices" style="display: contents" />
        </div>

        <div class="shellTopbarRight">
          <button class="shellRound" type="button" :aria-label="translate('账户')" :title="translate('账户')" @click="go('/account')">
            <icon-user :size="20" aria-hidden="true" />
          </button>
          <languageSelect popover />
        </div>
      </header>

      <main class="shellMain">
        <slot />
      </main>
    </div>

    <settings v-model="settingsVisible" />
  </div>
</template>

<style scoped lang="scss">
.appShell {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}

.shellLeft {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  padding: 20px 12px 16px;
  overflow-x: hidden;
  overflow-y: auto;
  border-inline-end: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color) 96%, var(--el-text-color-primary));
}

.shellBrand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  height: 30px;
  margin-bottom: 24px;
  padding: 0 8px;

  .brandLogo {
    flex-shrink: 0;
    width: 30px;
    height: 30px;

    .dark & { filter: invert(1); }
  }

  .brandName {
    overflow: hidden;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.shellNav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.shellNavItem {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--ui-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  text-align: start;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  > svg { flex-shrink: 0; }

  .shellNavText {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &:hover { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  &.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-weight: 500; }
}

.shellSpacer { flex: 1 1 auto; }

.shellDivider {
  height: 1px;
  flex-shrink: 0;
  margin: 12px 8px;
  background: var(--el-border-color-lighter);
}

.shellResize {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;

  &:hover, &.dragging { background: var(--el-color-primary); }
}

.shellRight {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.shellTopbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  column-gap: 12px;
  min-height: 56px;
  padding: 8px 16px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  z-index: 20;
}

.shellTopbarLeft {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 12px;
}

.shellTopbarNotices {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  max-width: 60%;
}

.shellTopbarRight {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.shellToggle,
.shellRound {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  background: transparent;
  color: var(--el-text-color-primary);
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover { background: var(--el-fill-color); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
}

.shellMain {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .shellNavItem,
  .shellResize,
  .shellToggle,
  .shellRound { transition: none; }
}
</style>
