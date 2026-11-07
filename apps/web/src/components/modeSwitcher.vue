<template>
  <el-segmented
    class="modeSwitcher"
    :model-value="mode"
    :options="options"
    size="small"
    :aria-label="translate('切换视图模式')"
    @change="onChange">
    <template #default="{ item }">
      <span class="modeOption">
        <component :is="item.icon" :size="15" aria-hidden="true" />
        {{ item.label }}
      </span>
    </template>
  </el-segmented>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { translate } from "@toonflow/i18n/vue";
import { IconMessageCircle, IconVector } from "@tabler/icons-vue";
import { useMatrixChat } from "@/composables/useMatrixChat";

// ACT: 合并页的「就地模式切换器」（计划 Task 4）。one-shot（群聊页 /chat）与 step-by-step（工作室 /studio）
// 是同一个房间表面的两种视图；切换时把当前活跃房间带过去，保证两种模式看到同一个 Matrix 房间时间线。
// 这是页面级导航 chrome，不进聊天框（聊天框保持纯净），也不同于画布 Settings 里的模式专属控件。
const props = defineProps<{ mode: "one-shot" | "step-by-step" }>();

const router = useRouter();
const { activeRoomId } = useMatrixChat();

const options = computed(() => [
  { label: translate("一键生成"), value: "one-shot", icon: IconMessageCircle },
  { label: translate("分步生成"), value: "step-by-step", icon: IconVector },
]);

function onChange(value: string | number | boolean) {
  const next = value as "one-shot" | "step-by-step";
  if (next === props.mode) return;
  const path = next === "one-shot" ? "/chat" : "/studio";
  const query = activeRoomId.value ? { room: activeRoomId.value } : {};
  void router.push({ path, query });
}
</script>

<style scoped lang="scss">
.modeSwitcher {
  --el-border-radius-base: var(--ui-radius-large);
  --el-segmented-color: var(--el-text-color-secondary);
  --el-segmented-item-selected-color: var(--el-color-white);
  --el-segmented-item-selected-bg-color: var(--el-color-primary);
  --el-segmented-item-hover-bg-color: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  min-height: 28px;
  padding: 2px;
  border: 1px solid var(--el-border-color-light);
  font-size: 12px;
  background: color-mix(in srgb, var(--el-bg-color-overlay) 70%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--el-box-shadow-light);

  .modeOption {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 6px;
    line-height: 22px;
    font-weight: 500;
  }
}
</style>
