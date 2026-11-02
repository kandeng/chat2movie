<template>
  <el-dialog
    v-model="visible"
    :title="translate('登录')"
    width="min(420px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    :closeOnClickModal="false"
    :closeOnPressEscape="!auth.busy"
    :showClose="!auth.busy">
    <el-form class="loginForm" label-position="top" @submit.prevent="submit">
      <el-form-item :label="translate('用户名')">
        <el-input
          v-model="username"
          :disabled="auth.busy"
          autocomplete="username"
          :placeholder="translate('例如 host')"
          :aria-label="translate('用户名')"
          @keydown.enter="submit" />
      </el-form-item>
      <el-form-item :label="translate('密码')">
        <el-input
          v-model="password"
          type="password"
          show-password
          :disabled="auth.busy"
          autocomplete="current-password"
          :aria-label="translate('密码')"
          @keydown.enter="submit" />
      </el-form-item>
      <el-text v-if="errorMessage" class="loginError" type="danger" role="alert">{{ errorMessage }}</el-text>
      <p class="loginHint">{{ translate("演示账号由 provision-matrix 脚本创建，可使用 host、friend1、friend2 登录。") }}</p>
    </el-form>
    <template #footer>
      <div class="loginFooter">
        <el-button :disabled="auth.busy" @click="visible = false">{{ translate("取消") }}</el-button>
        <el-button type="primary" :loading="auth.busy" :disabled="!username.trim() || !password" @click="submit">{{ translate("登录") }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import { useAuthStore } from "@/stores/auth";

// ACT: 统一登录弹窗（计划 Task 2）。顶栏账户按钮、账户页与 /workspace 路由守卫共用这一个入口，
// 登录成功后由调用方通过 success 事件决定后续跳转（例如回到被打断的工作室页面）。
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ success: [] }>();
const auth = useAuthStore();
const username = ref("");
const password = ref("");
const errorMessage = ref("");

// ACT: 每次打开都清掉上一次的错误与密码，用户名保留以便重试。
watch(visible, value => {
  if (!value) return;
  errorMessage.value = "";
  password.value = "";
});

async function submit() {
  if (auth.busy || !username.value.trim() || !password.value) return;
  errorMessage.value = "";
  try {
    await auth.login(username.value, password.value);
    password.value = "";
    visible.value = false;
    ElMessage.success(translate("登录成功"));
    emit("success");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : translate("登录失败，请稍后重试");
    password.value = "";
  }
}
</script>

<style scoped lang="scss">
.loginForm {
  display: flex;
  flex-direction: column;
  gap: 4px;

  :deep(.el-form-item) { margin-bottom: 16px; }
}

.loginError {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
}

.loginHint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}

.loginFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
