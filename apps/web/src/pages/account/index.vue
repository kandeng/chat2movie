<template>
  <div class="accountPage">
    <el-card class="accountCard" shadow="never">
      <h1>{{ translate("账户") }}</h1>
      <p class="accountHint">{{ translate("登录与个人资料将在后续任务中接入。") }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
</script>

<style scoped lang="scss">
.accountPage {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  box-sizing: border-box;

  .accountCard {
    width: 100%;
    max-width: 480px;
    border-radius: calc(var(--ui-radius) * 2);
  }

  h1 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
  }

  .accountHint {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.7;
  }
}
</style>
