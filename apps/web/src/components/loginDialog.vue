<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    width="min(440px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    :closeOnClickModal="false"
    :closeOnPressEscape="!auth.busy"
    :showClose="!auth.busy">
    <el-tabs v-model="activeTab" class="authTabs" @tab-change="onTabChange">
      <!-- ACT: 登录——邮箱 + 密码（网站账号即主身份，Matrix 令牌由服务端代签）。 -->
      <el-tab-pane :label="translate('登录')" name="login">
        <el-form class="authForm" label-position="top" @submit.prevent="submitLogin">
          <el-form-item :label="translate('邮箱')">
            <el-input
              v-model="loginEmail"
              :disabled="auth.busy"
              autocomplete="email"
              placeholder="you@example.com"
              :aria-label="translate('邮箱')"
              @keydown.enter="submitLogin" />
          </el-form-item>
          <el-form-item :label="translate('密码')">
            <el-input
              v-model="loginPassword"
              type="password"
              show-password
              :disabled="auth.busy"
              autocomplete="current-password"
              :aria-label="translate('密码')"
              @keydown.enter="submitLogin" />
          </el-form-item>
          <el-button class="submitBtn" type="primary" :loading="auth.busy" :disabled="!loginEmail.trim() || !loginPassword" @click="submitLogin">{{ translate("登录") }}</el-button>
        </el-form>
      </el-tab-pane>

      <!-- ACT: 注册——仅需邮箱+昵称+密码，提交即建账号并自动登录（服务端 requireEmailVerification=false）。
           邮箱验证不在注册内完成；未验证时账户页给出提醒与验证码输入框，稍后补验即可。 -->
      <el-tab-pane :label="translate('注册')" name="register">
        <el-form class="authForm" label-position="top" @submit.prevent="submitRegister">
          <el-form-item :label="translate('邮箱')">
            <el-input v-model="regEmail" :disabled="auth.busy" autocomplete="email" placeholder="you@example.com" :aria-label="translate('邮箱')" />
          </el-form-item>
          <el-form-item :label="translate('昵称')">
            <el-input v-model="regName" :disabled="auth.busy" :placeholder="translate('群聊中展示的名字')" :aria-label="translate('昵称')" />
          </el-form-item>
          <el-form-item :label="translate('密码')">
            <el-input v-model="regPassword" type="password" show-password :disabled="auth.busy" autocomplete="new-password" :placeholder="translate('至少 8 位')" :aria-label="translate('密码')" />
          </el-form-item>
          <el-button class="submitBtn" type="primary" :loading="auth.busy" :disabled="!regEmail.trim() || !regPassword" @click="submitRegister">{{ translate("注册") }}</el-button>
        </el-form>
      </el-tab-pane>

      <!-- ACT: 忘记密码——第一步发重置验证码，第二步填验证码 + 新密码完成重置。 -->
      <el-tab-pane :label="translate('忘记密码')" name="reset">
        <el-form v-if="resetStep === 'email'" class="authForm" label-position="top" @submit.prevent="submitResetRequest">
          <el-form-item :label="translate('邮箱')">
            <el-input v-model="resetEmail" :disabled="auth.busy" autocomplete="email" placeholder="you@example.com" :aria-label="translate('邮箱')" @keydown.enter="submitResetRequest" />
          </el-form-item>
          <el-button class="submitBtn" type="primary" :loading="auth.busy" :disabled="!resetEmail.trim()" @click="submitResetRequest">{{ translate("发送重置验证码") }}</el-button>
        </el-form>
        <el-form v-else class="authForm" label-position="top" @submit.prevent="submitResetConfirm">
          <p class="authNotice">{{ noticeMessage }}</p>
          <el-form-item :label="translate('邮箱验证码')">
            <el-input v-model="resetOtp" :disabled="auth.busy" maxlength="6" inputmode="numeric" :placeholder="translate('6 位数字')" :aria-label="translate('邮箱验证码')" />
          </el-form-item>
          <el-form-item :label="translate('新密码')">
            <el-input v-model="resetNewPassword" type="password" show-password :disabled="auth.busy" autocomplete="new-password" :placeholder="translate('至少 8 位')" :aria-label="translate('新密码')" @keydown.enter="submitResetConfirm" />
          </el-form-item>
          <div class="btnRow">
            <el-button :disabled="auth.busy || cooldown > 0" @click="resendResetOtp">{{ resendLabel }}</el-button>
            <el-button type="primary" :loading="auth.busy" :disabled="resetOtp.trim().length < 6 || !resetNewPassword" @click="submitResetConfirm">{{ translate("重置密码") }}</el-button>
          </div>
        </el-form>
      </el-tab-pane>
    </el-tabs>

    <el-text v-if="errorMessage" class="authError" type="danger" role="alert">{{ errorMessage }}</el-text>

    <template #footer>
      <div class="authFooter">
        <el-button :disabled="auth.busy" @click="visible = false">{{ translate("关闭") }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import { useAuthStore } from "@/stores/auth";

// ACT: 统一登录弹窗（计划 Task 5）：登录 / 注册 / 忘记密码 三个标签页 + 可选的 Google 登录。
// 顶栏账户按钮、账户页、群聊页与 /workspace 路由守卫共用这一个入口，登录成功后由调用方通过 success 事件决定后续跳转。
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ success: [] }>();
const auth = useAuthStore();

type Tab = "login" | "register" | "reset";
const activeTab = ref<Tab>("login");
const errorMessage = ref("");
const noticeMessage = ref("");

// 登录
const loginEmail = ref("");
const loginPassword = ref("");

// 注册（单步：邮箱 + 昵称 + 密码，提交即完成并自动登录）
const regEmail = ref("");
const regName = ref("");
const regPassword = ref("");

// 重置密码（两步：邮箱 -> 验证码 + 新密码）
const resetStep = ref<"email" | "otp">("email");
const resetEmail = ref("");
const resetOtp = ref("");
const resetNewPassword = ref("");

// ACT: 验证码重发冷却（drone RESEND_COOLDOWN_SECONDS = 60 秒），注册与重置共用一个计时器。
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;
function startCooldown(seconds = 60) {
  cooldown.value = seconds;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0 && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  }, 1000);
}
onBeforeUnmount(() => { if (cooldownTimer) clearInterval(cooldownTimer); });

const dialogTitle = computed(() =>
  activeTab.value === "register" ? translate("注册") : activeTab.value === "reset" ? translate("重置密码") : translate("登录"));
const resendLabel = computed(() => cooldown.value > 0 ? `${translate("重发验证码")} (${cooldown.value}s)` : translate("重发验证码"));

// ACT: 每次打开都回到登录页并清空上一次的输入/错误。
watch(visible, value => {
  if (!value) return;
  errorMessage.value = "";
  noticeMessage.value = "";
  activeTab.value = "login";
  loginPassword.value = "";
  resetStep.value = "email"; resetOtp.value = ""; resetNewPassword.value = "";
});

function onTabChange() { errorMessage.value = ""; noticeMessage.value = ""; }

function fail(error: unknown, fallback: string) {
  errorMessage.value = error instanceof Error ? error.message : translate(fallback);
}

async function succeed(message = "登录成功") {
  loginPassword.value = "";
  regPassword.value = "";
  visible.value = false;
  ElMessage.success(translate(message));
  emit("success");
}

async function submitLogin() {
  if (auth.busy) return;
  errorMessage.value = "";
  try {
    await auth.login(loginEmail.value, loginPassword.value);
    await succeed();
  } catch (error) { fail(error, "登录失败，请稍后重试"); loginPassword.value = ""; }
}

async function submitRegister() {
  if (auth.busy) return;
  errorMessage.value = "";
  try {
    // ACT: 注册即完成——提交邮箱+昵称+密码即建账号并显式登录（服务端 requireEmailVerification=false）。
    // 邮箱验证不在注册流程内；未验证时账户页给出提醒与验证码输入框，稍后补验即可。
    await auth.register(regEmail.value, regPassword.value, regName.value);
    await auth.login(regEmail.value, regPassword.value);
    await succeed("注册成功");
  } catch (error) { fail(error, "注册失败，请稍后重试"); }
}

async function submitResetRequest() {
  if (auth.busy) return;
  errorMessage.value = "";
  try {
    await auth.requestPasswordReset(resetEmail.value);
    resetStep.value = "otp";
    startCooldown(60);
    noticeMessage.value = translate("重置验证码已发送到你的邮箱，10 分钟内有效。开发环境未配置 SMTP 时，验证码会打印在服务端日志。");
  } catch (error) { fail(error, "重置邮件发送失败，请稍后再试"); }
}

async function resendResetOtp() {
  if (auth.busy || cooldown.value > 0) return;
  errorMessage.value = "";
  try {
    await auth.requestPasswordReset(resetEmail.value);
    startCooldown(60);
    noticeMessage.value = translate("验证码已重新发送");
  } catch (error) { fail(error, "验证码发送失败，请稍后再试"); }
}

async function submitResetConfirm() {
  if (auth.busy) return;
  errorMessage.value = "";
  try {
    await auth.resetPassword(resetEmail.value, resetOtp.value, resetNewPassword.value);
    ElMessage.success(translate("密码已重置，请用新密码登录"));
    loginEmail.value = resetEmail.value;
    activeTab.value = "login";
    resetStep.value = "email"; resetOtp.value = ""; resetNewPassword.value = "";
    noticeMessage.value = "";
  } catch (error) { fail(error, "重置密码失败，请稍后重试"); }
}
</script>

<style scoped lang="scss">
.authTabs {
  :deep(.el-tabs__header) { margin-bottom: 12px; }
}

.authForm {
  display: flex;
  flex-direction: column;
  gap: 4px;

  :deep(.el-form-item) { margin-bottom: 16px; }
}

.submitBtn {
  width: 100%;
}

.btnRow {
  display: flex;
  gap: 8px;

  .el-button { flex: 1; }
}

.authNotice {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}

.authError {
  display: block;
  margin-top: 4px;
  font-size: 13px;
}

.authFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
