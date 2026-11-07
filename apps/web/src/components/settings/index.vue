<template>
  <!-- ACT: 设置由弹窗改为整页布局（对齐群聊页）：左侧双倍加深的菜单栏 + 右侧主设置区。 -->
  <div class="settings">
    <aside class="sidebar" aria-label="设置分类">
      <div class="settingsNav">
        <template v-for="item in settingsPanels" :key="item.id">
          <h3 v-if="item.groupLabel" class="settingsGroupLabel">{{ item.groupLabel }}</h3>
          <button
            class="settingsItem"
            type="button"
            :aria-label="item.label"
            :aria-pressed="activePanel.id === item.id"
            @click="activePanel = item">
            <span>{{ item.label }}</span>
          </button>
        </template>
      </div>
    </aside>
    <section class="content" :aria-label="activePanel.label" tabindex="0">
      <h2 class="panelTitle">{{ activePanel.label }}</h2>
      <div class="panelContent">
        <transition name="el-fade-in" mode="out-in">
          <keep-alive include="personalization">
            <component
              :is="activePanel.component"
              v-bind="['pluginMarket', 'languageModel', 'mediaModel', 'personalization'].includes(activePanel.id) ? { visible: true } : {}" />
          </keep-alive>
        </transition>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, shallowRef } from "vue";

const settingsPanels = [
  { id: "ui", label: "界面设置", component: defineAsyncComponent(() => import("./panels/ui.vue")) },
  { id: "general", label: "常规配置", component: defineAsyncComponent(() => import("./panels/general/index.vue")) },
  {
    id: "languageModel",
    label: "文本模型",
    groupLabel: "模型",
    component: defineAsyncComponent(() => import("./panels/languageModel/index.vue")),
  },
  { id: "mediaModel", label: "媒体模型", component: defineAsyncComponent(() => import("./panels/mediaModel/index.vue")) },
  { id: "localModel", label: "本地模型", component: defineAsyncComponent(() => import("./panels/localModel/index.vue")) },
  {
    id: "pluginMarket",
    label: "插件市场",
    groupLabel: "市场",
    component: defineAsyncComponent(() => import("./panels/pluginMarket/index.vue")),
  },
  { id: "mcp", label: "MCP", groupLabel: "通讯", component: defineAsyncComponent(() => import("./panels/mcp/index.vue")) },
  { id: "chatToVideo", label: "聊天转视频", component: defineAsyncComponent(() => import("./panels/chatToVideo/index.vue")) },
  { id: "network", label: "网络设置", component: defineAsyncComponent(() => import("./panels/network.vue")) },
  {
    id: "personalization",
    label: "个性化",
    groupLabel: "其他",
    component: defineAsyncComponent(() => import("./panels/personalization.vue")),
  },
  { id: "privacy", label: "隐私", component: defineAsyncComponent(() => import("./panels/privacy.vue")) },
  { id: "developer", label: "开发者选项", component: defineAsyncComponent(() => import("./panels/developer/index.vue")) },
  { id: "about", label: "关于", component: defineAsyncComponent(() => import("./panels/about.vue")) },
];
const activePanel = shallowRef(settingsPanels[0]!);
</script>

<style lang="scss" scoped>
.settings {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  // ACT: 基准字号与群聊页对齐（14px），避免继承 body 的 16px 导致菜单/正文偏大。
  font-size: 14px;

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    // ACT: 与群聊页左栏同款双倍加深背景（图标栏 96/4、本栏 92/8），随主题变量适配深/浅色。
    background: color-mix(in srgb, var(--el-bg-color) 92%, var(--el-text-color-primary));
    border-inline-end: 1px solid var(--el-border-color-lighter);

    .settingsNav {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      // ACT: 顶部留白与菜单行间距同尺寸（24px = 14 + 条目上内边距 10），移除标题后菜单不再紧贴面板顶边。
      padding: 14px 2px 2px;
    }

    .settingsGroupLabel {
      margin: 14px 12px 6px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
    }

    .settingsItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: start;
      cursor: pointer;

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover {
        background: var(--el-fill-color-light);
      }

      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;

    .panelTitle {
      flex-shrink: 0;
      // ACT: 顶部留白与账户页主面板首段标题对齐（20px），避免标题紧贴内容区上边框。
      margin: 20px 0 20px;
      font-size: 18px;
    }

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-left: 5px;
      padding-right: 5px;
      padding-bottom: 50px;

      > :deep(.el-fade-in-enter-active),
      > :deep(.el-fade-in-leave-active) {
        transition-duration: 100ms;
      }
    }
  }

  @media (max-width: 700px) {
    grid-template-columns: 44px minmax(0, 1fr);

    .sidebar {
      .settingsHeader {
        display: none;
      }

      .settingsGroupLabel {
        margin: 12px 0 6px;
        text-align: center;
      }

      .settingsItem {
        justify-content: center;
        padding: 12px;
        span {
          display: none;
        }
      }
    }

    .content {
      padding: 0 8px 0 16px;
    }
  }
}
</style>
