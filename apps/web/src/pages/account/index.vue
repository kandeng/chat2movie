<template>
  <!-- ACT: 账户整页（对齐设置页布局）：左侧双倍加深菜单栏（账户/钱包/账单，无图标）+ 右侧扁平主面板。
       菜单项为锚点：点击平滑滚动到主面板中对应段落，滚动时高亮跟随。 -->
  <div class="account">
    <aside class="sidebar" aria-label="账户分类">
      <div class="accountNav">
        <button
          v-for="item in sections"
          :key="item.id"
          class="accountItem"
          type="button"
          :aria-label="translate(item.label)"
          :aria-pressed="activeSection === item.id"
          @click="goTo(item.id)">
          <span>{{ translate(item.label) }}</span>
        </button>
      </div>
    </aside>

    <section class="content" aria-label="账户内容" tabindex="0">
      <div ref="scrollBox" class="panelContent" @scroll.passive="onScroll">
        <!-- ACT: 账户段落：已登录展示资料与验证提醒并支持编辑昵称/头像；未登录展示登录入口。 -->
        <section :id="sectionId(sections[0].id)" class="accountSection" aria-labelledby="accountTitle">
          <h2 id="accountTitle">{{ translate("账户") }}</h2>

          <div v-if="auth.signedIn" class="accountProfile">
            <div class="avatarRow">
              <div class="avatarBox">
                <img v-if="pendingAvatar || auth.avatarUrl" class="avatar" :src="pendingAvatar || auth.avatarUrl" :alt="auth.displayName" />
                <span v-else class="navIcon avatar" :style="{ '--nav-icon': `url(&quot;${iconAccount}&quot;)` }" aria-hidden="true" />
              </div>
              <div class="avatarControls">
                <input ref="fileInput" type="file" accept="image/*" class="avatarFile" @change="onPickAvatar" />
                <el-button size="small" :disabled="saving" @click="pickAvatar">{{ translate("更换头像") }}</el-button>
                <el-text v-if="pendingAvatar" class="avatarHint" type="info" size="small">{{ translate("保存后生效") }}</el-text>
              </div>
            </div>

            <dl class="profileFields">
              <div class="profileRow">
                <dt>{{ translate("邮箱") }}</dt>
                <dd>
                  {{ auth.email || translate("未知") }}
                  <el-tag :type="auth.emailVerified ? 'success' : 'warning'" size="small" effect="plain">
                    {{ auth.emailVerified ? translate("已验证") : translate("未验证") }}
                  </el-tag>
                </dd>
              </div>
              <div class="profileRow">
                <dt>{{ translate("昵称") }}</dt>
                <dd>
                  <el-input v-model="editName" size="small" :disabled="saving" :placeholder="translate('群聊中展示的名字')" />
                </dd>
              </div>
              <div class="profileRow">
                <dt>{{ translate("用户 ID") }}</dt>
                <dd class="mono">{{ auth.myUserId }}</dd>
              </div>
              <div class="profileRow">
                <dt>{{ translate("设备 ID") }}</dt>
                <dd class="mono">{{ auth.deviceId || translate("未知") }}</dd>
              </div>
            </dl>

            <div class="profileActions">
              <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">{{ translate("保存修改") }}</el-button>
              <el-button type="danger" plain :loading="signingOut" @click="signOut">{{ translate("退出登录") }}</el-button>
            </div>

            <!-- ACT: 未验证邮箱（注册流程不再含验证）：资料区下方先给提醒，再给验证码输入框供稍后补验。 -->
            <div v-if="!auth.emailVerified" class="verifyBlock">
              <div class="verifyNotice" role="note">
                <p class="verifyTitle">{{ translate("你的邮箱尚未验证") }}</p>
                <p>{{ translate("注册已完成，你可以正常使用本站。验证邮件可能尚未送达，因此邮箱目前尚未验证。") }}</p>
                <p>{{ translate("通用建议：请先检查垃圾邮件或订阅文件夹；若仍未收到，说明站点邮箱服务的发信授权码尚未配置，请联系站点管理员。") }}</p>
                <p class="verifySub">{{ translate("开启发信授权码的方式因邮箱服务商而异，以 QQ 邮箱为例：") }}</p>
                <ol class="verifySteps">
                  <li>{{ translate("登录 QQ 邮箱网页版，进入「设置」→「账号与安全」。") }}</li>
                  <li>{{ translate("在「安全设置」中找到「POP3/IMAP/SMTP/Exchange/CardDAV 服务」。") }}</li>
                  <li>{{ translate("开启「IMAP/SMTP 服务」，按提示用手机发送短信完成验证。") }}</li>
                  <li>{{ translate("生成并保存 16 位「授权码」，填入站点服务端 config.json 的 auth.smtp.pass 字段。") }}</li>
                </ol>
                <p class="verifyWarn">{{ translate("未验证邮箱的影响：如果忘记密码，将无法通过邮箱重置。请尽快完成验证。") }}</p>
              </div>

              <div class="verifyForm">
                <el-input
                  v-model="verifyCode"
                  class="verifyInput"
                  maxlength="6"
                  inputmode="numeric"
                  :placeholder="translate('6 位数字')"
                  :disabled="verifying"
                  :aria-label="translate('邮箱验证码')"
                  @keydown.enter="submitVerify" />
                <el-button :disabled="verifying || resending || cooldown > 0" :loading="resending" @click="resendCode">{{ resendLabel }}</el-button>
                <el-button type="primary" :loading="verifying" :disabled="verifyCode.trim().length < 6" @click="submitVerify">{{ translate("验证邮箱") }}</el-button>
              </div>
            </div>
          </div>

          <div v-else class="accountSignedOut">
            <p class="accountHint">{{ translate("登录后即可创建群聊、邀请成员，并作为主持人生成视频。") }}</p>
            <el-button type="primary" @click="loginVisible = true">{{ translate("登录") }}</el-button>
          </div>
        </section>

        <!-- ACT: 钱包/账单段落：占位内容，作为菜单锚点目标。 -->
        <section :id="sectionId(sections[1].id)" class="accountSection" aria-labelledby="walletTitle">
          <h2 id="walletTitle">{{ translate("钱包") }}</h2>
          <p class="sectionEmpty">{{ translate("钱包功能即将上线，敬请期待。") }}</p>
        </section>

        <section :id="sectionId(sections[2].id)" class="accountSection" aria-labelledby="billingTitle">
          <h2 id="billingTitle">{{ translate("账单") }}</h2>
          <p class="sectionEmpty">{{ translate("账单功能即将上线，敬请期待。") }}</p>
        </section>
      </div>
    </section>

    <loginDialog v-model="loginVisible" @success="onLoggedIn" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import loginDialog from "@/components/loginDialog.vue";
import iconAccount from "@/icons/user.svg";
import { useAuthStore } from "@/stores/auth";

// ACT: 账户页：设置页同款整页布局（左菜单栏 + 右扁平主面板），主面板内含「账户/钱包/账单」三个锚点段落。
// 头像上传后在本地裁剪/缩放为 128x128 的 data URI（对齐 drone 的头像处理），保存时经 updateProfile 同步到 Matrix。
// 路由守卫把未登录用户送到 /account?login=1&redirect=<目标>，这里自动弹出登录框，登录成功后回到目标页。
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const loginVisible = ref(false);
const signingOut = ref(false);
const saving = ref(false);

const editName = ref("");
const pendingAvatar = ref(""); // 待保存的头像 data URI 预览
const fileInput = ref<HTMLInputElement | null>(null);

// ACT: 邮箱补验（注册不含验证步骤）：验证码输入 + 重发冷却（60 秒，对齐 drone）。
const verifyCode = ref("");
const verifying = ref(false);
const resending = ref(false);
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

const resendLabel = computed(() => cooldown.value > 0 ? `${translate("重发验证码")} (${cooldown.value}s)` : translate("重发验证码"));

async function resendCode() {
  if (verifying.value || resending.value || cooldown.value > 0 || !auth.email) return;
  resending.value = true;
  try {
    await auth.sendVerificationOtp(auth.email, "email-verification");
    startCooldown(60);
    ElMessage.success(translate("验证码已重新发送"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("验证码发送失败，请稍后再试"));
  } finally {
    resending.value = false;
  }
}

async function submitVerify() {
  if (verifying.value || !auth.email) return;
  verifying.value = true;
  try {
    // ACT: 验证成功后 store 会把 emailVerified 置真，提醒与输入框随之消失。
    await auth.verifyOtp(auth.email, verifyCode.value);
    verifyCode.value = "";
    ElMessage.success(translate("邮箱已验证"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("验证失败，请稍后重试"));
  } finally {
    verifying.value = false;
  }
}

// ACT: 主面板锚点段落（自上而下：账户 -> 钱包 -> 账单），菜单项不带图标。
const sections = [
  { id: "account", label: "账户" },
  { id: "wallet", label: "钱包" },
  { id: "billing", label: "账单" },
];
const activeSection = ref(sections[0].id);
const scrollBox = ref<HTMLElement | null>(null);

function sectionId(id: string) { return `sec-${id}`; }

// ACT: 点击菜单：高亮对应项并把主面板平滑滚动到该段落。
function goTo(id: string) {
  activeSection.value = id;
  document.getElementById(sectionId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ACT: 滚动监听（scroll-spy）：以主面板顶部为基准，高亮当前视口内最靠上的段落对应菜单项。
function onScroll() {
  const box = scrollBox.value;
  if (!box) return;
  const boxTop = box.getBoundingClientRect().top;
  let current = sections[0].id;
  for (const item of sections) {
    const el = document.getElementById(sectionId(item.id));
    if (el && el.getBoundingClientRect().top - boxTop <= 24) current = item.id;
  }
  activeSection.value = current;
}

// ACT: 网站账号资料就绪后，用其昵称初始化可编辑输入框。
watch(() => auth.account?.name, value => {
  if (typeof value === "string") editName.value = value;
}, { immediate: true });

const dirty = computed(() =>
  editName.value.trim() !== (auth.account?.name ?? "") || Boolean(pendingAvatar.value));

function pickAvatar() { fileInput.value?.click(); }

// ACT: 读文件 -> 居中裁剪为正方形 -> 缩放到 128x128 -> 输出 PNG data URI。
async function onPickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  if (!file) return;
  try {
    pendingAvatar.value = await fileToSquareDataUri(file, 128);
  } catch {
    ElMessage.error(translate("图片读取失败，请换一张试试"));
  }
}

async function fileToSquareDataUri(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL("image/png");
}

async function save() {
  if (saving.value || auth.busy) return;
  saving.value = true;
  try {
    await auth.updateProfile(editName.value, pendingAvatar.value || undefined);
    pendingAvatar.value = "";
    ElMessage.success(translate("资料已更新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("资料更新失败，请稍后重试"));
  } finally {
    saving.value = false;
  }
}

function onLoggedIn() {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
  // ACT: 只接受站内绝对路径，避免被构造成外站跳转。
  if (redirect.startsWith("/") && !redirect.startsWith("//")) { void router.replace(redirect); return; }
  if (route.query.login === "1") void router.replace({ path: "/account" });
}

async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await auth.logout();
    pendingAvatar.value = "";
    ElMessage.success("已退出登录");
  } finally {
    signingOut.value = false;
  }
}

// ACT: 不能只靠 onMounted —— 已停留在 /account 时再被守卫重定向回来（只是 query 变了）
// 会复用同一个组件实例，onMounted 不会再触发，login=1 就丢了。改用 watch(immediate) 覆盖两种情况。
watch(() => route.query.login, async () => {
  if (!auth.restored) await auth.restore();
  // ACT: 只负责「该弹时弹」，不在 query 不是 login=1 时强制关闭用户手动打开的登录框。
  if (!auth.signedIn && route.query.login === "1") loginVisible.value = true;
}, { immediate: true });
</script>

<style scoped lang="scss">
// ACT: 与设置页同款的整页网格：左 220px 双倍加深菜单栏 + 右主面板；基准字号 14px 对齐群聊/设置页。
.account {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  font-size: 14px;

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--el-bg-color) 92%, var(--el-text-color-primary));
    border-inline-end: 1px solid var(--el-border-color-lighter);

    .accountNav {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      // ACT: 顶部留白与菜单行间距同尺寸（24px = 14 + 条目上内边距 10），移除标题后菜单不再紧贴面板顶边。
      padding: 14px 2px 2px;
    }

    .accountItem {
      display: flex;
      align-items: center;
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

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 20px 5px 50px;
    }
  }
}

// ACT: 锚点段落：scroll-margin 保证滚动到位后标题不被裁切；段落间留白分隔。
.accountSection {
  scroll-margin-top: 12px;
  margin-bottom: 36px;

  &:last-child { margin-bottom: 0; }

  h2 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 600;
  }

  .sectionEmpty {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.7;
  }
}

.accountProfile {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

// ACT: 未验证区块：提醒条 + 验证码输入行，置于资料区（保存/退出按钮）下方。
.verifyBlock {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.verifyForm {
  display: flex;
  align-items: center;
  gap: 8px;

  .verifyInput {
    width: 160px;
    flex: 0 0 auto;
  }
}

// ACT: 未验证邮箱提醒条：暖色警示风格，内含授权码启用步骤列表。
.verifyNotice {
  padding: 12px 14px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: var(--ui-radius);
  background: var(--el-color-warning-light-9);
  font-size: 13px;
  line-height: 1.7;

  p { margin: 0 0 8px; }
  p:last-child { margin-bottom: 0; }

  .verifyTitle {
    font-weight: 600;
    color: var(--el-color-warning-dark-2);
  }

  .verifySub { margin-bottom: 4px; font-weight: 500; }

  .verifySteps {
    margin: 0 0 8px;
    padding-left: 20px;

    li { margin-bottom: 2px; }
  }

  .verifyWarn { color: var(--el-color-warning-dark-2); }
}

.avatarRow {
  display: flex;
  align-items: center;
  gap: 16px;
}

.avatarBox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  overflow: hidden;

  .avatar {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  // ACT: 与全局外壳一致，用 mask + currentColor 给 icons/user.svg 着色（该图标内置固定填充色）。
  .navIcon {
    width: 32px;
    height: 32px;
    background-color: currentColor;
    mask-image: var(--nav-icon);
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-image: var(--nav-icon);
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
  }
}

.avatarControls {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.avatarFile {
  display: none;
}

.avatarHint {
  font-size: 12px;
}

.profileFields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.profileRow {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  align-items: center;

  dt {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }

  dd {
    margin: 0;
    font-size: 14px;
    word-break: break-all;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
}

.profileActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.accountSignedOut {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.accountHint {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}
</style>
