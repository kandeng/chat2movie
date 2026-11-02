<template>
  <div class="accountPage">
    <el-card class="accountCard" shadow="never">
      <h1>{{ translate("账户") }}</h1>

      <!-- ACT: 已登录：展示网站账号资料（邮箱/验证态）+ Matrix 影子身份，并支持编辑昵称/头像；未登录：打开统一登录框。 -->
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
      </div>

      <div v-else class="accountSignedOut">
        <p class="accountHint">{{ translate("登录后即可创建群聊、邀请成员，并作为主持人生成视频。") }}</p>
        <el-button type="primary" @click="loginVisible = true">{{ translate("登录") }}</el-button>
      </div>
    </el-card>

    <loginDialog v-model="loginVisible" @success="onLoggedIn" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import loginDialog from "@/components/loginDialog.vue";
import iconAccount from "@/icons/user.svg";
import { useAuthStore } from "@/stores/auth";

// ACT: 账户页（计划 Task 5）：网站账号资料展示与编辑（昵称/头像）+ 登录/退出。
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
    margin: 0 0 16px;
    font-size: 20px;
    font-weight: 600;
  }

  .accountHint {
    margin: 0 0 16px;
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
</style>
