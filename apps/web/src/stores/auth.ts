import { defineStore } from "pinia";
import { computed, ref } from "vue";
import axios from "axios";
import { translate } from "@toonflow/i18n/vue";
import { fetchMediaBlobUrl } from "@/lib/matrixMedia";
import { authClient } from "@/lib/authClient";

// ACT: 统一登录态（计划 Task 4，按 drone-navigation-v2 的「网站账号为主身份 + Matrix 影子账号」重写）。
// - 网站账号（邮箱/密码、邮箱验证码）由 better-auth 管理，会话是 HttpOnly Cookie，不落地 localStorage；
// - 登录成功后向 /api/matrix/token 代签隐藏 Matrix 影子账号令牌，聊天层照旧使用这份 Matrix 凭据；
// - localStorage（vidsay.auth）只持久化 Matrix 半段会话；刷新后 restore() 先验 better-auth Cookie，
//   再复用（whoami 校验）或重新代签 Matrix 令牌，Synapse 不可用时仅聊天降级、网站账号仍有效。

export type AuthSession = {
  userId: string; // Matrix mxid @localpart:serverName（聊天身份）
  accessToken: string; // 代签得到的 Matrix 令牌
  deviceId: string;
  displayName: string;
  avatarUrl: string; // mxc:// 或空串
};

// ACT: 网站账号（better-auth user）资料，供账户页展示邮箱/验证态并编辑昵称头像。
export type AuthAccount = {
  id: string;
  email: string;
  name: string;
  image: string; // data URI 或空串
  emailVerified: boolean;
};

type MatrixTokenResponse = {
  code: number;
  data?: { accessToken: string; userId: string; deviceId: string };
  message?: string;
};
type ProfileResponse = { displayname?: string; avatar_url?: string };

// 从 @localpart:serverName 取本地名，用作无昵称时的显示名兜底。
export function localpartOf(userId: string): string {
  if (!userId) return "";
  const bare = userId.startsWith("@") ? userId.slice(1) : userId;
  return bare.split(":")[0] || bare;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

// ACT: 把 better-auth 客户端返回的 error（{ message }）转成可读中文提示；未覆盖的原样透传。
function clientError(error: unknown, fallback: string): Error {
  const raw = (error as { message?: string } | null)?.message ?? "";
  const lower = raw.toLowerCase();
  if (!raw) return new Error(translate(fallback));
  if (lower.includes("not verified")) return new Error(translate("邮箱尚未验证，请先输入验证码激活"));
  if (lower.includes("invalid") && (lower.includes("password") || lower.includes("email"))) return new Error(translate("邮箱或密码错误"));
  if (lower.includes("already")) return new Error(translate("该邮箱已被注册"));
  if (lower.includes("otp") || lower.includes("verification")) return new Error(translate("验证码无效或已过期"));
  if (lower.includes("password") && lower.includes("short")) return new Error(translate("密码至少需要 8 位"));
  if (lower.includes("rate limit") || lower.includes("too many")) return new Error(translate("操作过于频繁，请稍后再试"));
  return new Error(translate(fallback));
}

// ACT: 把 better-auth 的 user 对象收敛成前端资料结构（字段缺失时给出安全默认值）。
function accountFrom(user: unknown): AuthAccount | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  return {
    id: typeof u.id === "string" ? u.id : "",
    email: typeof u.email === "string" ? u.email : "",
    name: typeof u.name === "string" ? u.name : "",
    image: typeof u.image === "string" ? u.image : "",
    emailVerified: Boolean(u.emailVerified),
  };
}

export const useAuthStore = defineStore("auth", () => {
  const session = ref<AuthSession | null>(null); // Matrix 半段（持久化）
  const account = ref<AuthAccount | null>(null); // 网站账号资料（不持久化，restore 时拉取）
  const busy = ref(false);
  const restored = ref(false);
  // ACT: 头像的 blob 地址只存在于内存（objectURL 无法持久化），每次会话恢复后重新拉取。
  const avatarObjectUrl = ref("");

  const signedIn = computed(() => Boolean(session.value?.accessToken));
  const myUserId = computed(() => session.value?.userId ?? "");
  const accessToken = computed(() => session.value?.accessToken ?? "");
  const deviceId = computed(() => session.value?.deviceId ?? "");
  const displayName = computed(() => account.value?.name || session.value?.displayName || localpartOf(session.value?.userId ?? ""));
  const avatarUrl = computed(() => avatarObjectUrl.value);
  const email = computed(() => account.value?.email ?? "");
  const emailVerified = computed(() => account.value?.emailVerified ?? false);

  function setAvatarObjectUrl(url: string) {
    if (avatarObjectUrl.value && avatarObjectUrl.value !== url) URL.revokeObjectURL(avatarObjectUrl.value);
    avatarObjectUrl.value = url;
  }

  // ACT: 向 /api/matrix/token 代签当前网站账号的 Matrix 影子令牌（会话 Cookie 随同源请求自动携带）。
  async function brokerMatrixToken(): Promise<AuthSession> {
    const { data } = await axios.post<MatrixTokenResponse>("/api/matrix/token");
    if (data.code !== 200 || !data.data?.accessToken) {
      throw new Error(translate(data.message || "Synapse 暂时不可用，请稍后再试"));
    }
    const mx = data.data;
    return {
      userId: mx.userId,
      accessToken: mx.accessToken,
      deviceId: mx.deviceId ?? "",
      displayName: localpartOf(mx.userId),
      avatarUrl: "",
    };
  }

  // 读取 Matrix 个人资料（昵称/头像）；失败不影响登录本身。
  async function refreshProfile() {
    const current = session.value;
    if (!current?.accessToken) return;
    try {
      const { data } = await axios.get<ProfileResponse>(
        `/_matrix/client/v3/profile/${encodeURIComponent(current.userId)}`,
        { headers: authHeaders(current.accessToken) },
      );
      session.value = {
        ...current,
        displayName: typeof data.displayname === "string" ? data.displayname : current.displayName,
        avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : current.avatarUrl,
      };
    } catch { /* 昵称与头像属于锦上添花，忽略失败 */ }
    await loadAvatar();
  }

  async function loadAvatar() {
    const current = session.value;
    if (!current?.avatarUrl || !current.accessToken) { setAvatarObjectUrl(""); return; }
    try {
      setAvatarObjectUrl(await fetchMediaBlobUrl(current.avatarUrl, current.accessToken));
    } catch {
      setAvatarObjectUrl("");
    }
  }

  // ACT: 邮箱+密码登录：先过 better-auth，再代签 Matrix 令牌；代签失败则回滚网站会话，避免半登录态。
  async function login(identifier: string, password: string) {
    const emailAddress = identifier.trim();
    if (!emailAddress) throw new Error(translate("请输入邮箱"));
    if (!password) throw new Error(translate("请输入密码"));
    busy.value = true;
    try {
      const res = await authClient.signIn.email({ email: emailAddress, password });
      if (res.error) throw clientError(res.error, "登录失败，请稍后重试");
      account.value = accountFrom((res.data as { user?: unknown } | null)?.user);
      try {
        session.value = await brokerMatrixToken();
      } catch (brokerError) {
        await authClient.signOut();
        account.value = null;
        throw brokerError;
      }
      restored.value = true;
      await refreshProfile();
    } finally {
      busy.value = false;
    }
  }

  // ACT: 注册网站账号；服务端在注册后即发送邮箱验证码（未配置 SMTP 时打印到服务日志）。
  async function register(emailAddress: string, password: string, name: string) {
    const email0 = emailAddress.trim();
    if (!email0) throw new Error(translate("请输入邮箱"));
    if (!password) throw new Error(translate("请输入密码"));
    busy.value = true;
    try {
      const res = await authClient.signUp.email({ email: email0, password, name: name.trim() || localpartOf(email0) });
      if (res.error) throw clientError(res.error, "注册失败，请稍后重试");
      account.value = accountFrom((res.data as { user?: unknown } | null)?.user);
    } finally {
      busy.value = false;
    }
  }

  // ACT: 发送/重发邮箱验证码（type：email-verification 激活、sign-in 验证码登录）。
  async function sendVerificationOtp(emailAddress: string, type: "email-verification" | "sign-in" = "email-verification") {
    const res = await authClient.$fetch("/email-otp/send-verification-otp", {
      method: "POST",
      body: { email: emailAddress.trim(), type },
    });
    if (res.error) throw clientError(res.error, "验证码发送失败，请稍后再试");
  }

  // ACT: 用验证码激活邮箱（对应 drone 的邮箱激活流程）。
  async function verifyOtp(emailAddress: string, otp: string) {
    const res = await authClient.$fetch("/email-otp/verify-email", {
      method: "POST",
      body: { email: emailAddress.trim(), otp: otp.trim() },
    });
    if (res.error) throw clientError(res.error, "验证码无效或已过期");
    if (account.value) account.value = { ...account.value, emailVerified: true };
  }

  // ACT: 请求重置密码——发送重置验证码到邮箱。
  async function requestPasswordReset(emailAddress: string) {
    const res = await authClient.$fetch("/email-otp/request-password-reset", {
      method: "POST",
      body: { email: emailAddress.trim() },
    });
    if (res.error) throw clientError(res.error, "重置邮件发送失败，请稍后再试");
  }

  // ACT: 用验证码设置新密码，完成重置。
  async function resetPassword(emailAddress: string, otp: string, password: string) {
    const res = await authClient.$fetch("/email-otp/reset-password", {
      method: "POST",
      body: { email: emailAddress.trim(), otp: otp.trim(), password },
    });
    if (res.error) throw clientError(res.error, "重置密码失败，请稍后重试");
  }

  // ACT: 更新网站账号昵称/头像；服务端 update.after 钩子会把资料同步到 Matrix，这里再刷新本地展示。
  async function updateProfile(name: string, avatarDataUri?: string) {
    busy.value = true;
    try {
      const body: { name: string; image?: string } = { name: name.trim() };
      if (avatarDataUri) body.image = avatarDataUri;
      const res = await authClient.updateUser(body);
      if (res.error) throw clientError(res.error, "资料更新失败，请稍后重试");
      const fresh = await authClient.getSession();
      account.value = accountFrom((fresh.data as { user?: unknown } | null)?.user) ?? account.value;
      if (session.value && body.name) session.value = { ...session.value, displayName: body.name };
      await refreshProfile();
    } finally {
      busy.value = false;
    }
  }

  // 页面刷新后：先验 better-auth Cookie 会话，再复用/重签 Matrix 令牌；返回是否仍处于登录态。
  async function restore(): Promise<boolean> {
    if (restored.value) return signedIn.value;
    restored.value = true;
    const res = await authClient.getSession();
    const user = (res.data as { user?: unknown; session?: unknown } | null);
    if (!user?.session || !user?.user) {
      session.value = null;
      account.value = null;
      return false;
    }
    account.value = accountFrom(user.user);
    // 复用持久化的 Matrix 令牌（whoami 校验），失效则重新代签。
    const current = session.value;
    if (current?.accessToken) {
      try {
        await axios.get("/_matrix/client/v3/account/whoami", { headers: authHeaders(current.accessToken) });
        void refreshProfile();
        return true;
      } catch { /* 令牌失效，落到重新代签 */ }
    }
    try {
      session.value = await brokerMatrixToken();
      await refreshProfile();
      return true;
    } catch {
      // ACT: 网站账号有效但 Synapse 不可用——保留 account，聊天降级为不可用（signedIn=false）。
      session.value = null;
      return false;
    }
  }

  // 令牌失效（例如 Synapse 数据库被重置）时由聊天层调用：仅清空 Matrix 半段，不动网站账号 Cookie。
  function invalidate() {
    session.value = null;
    setAvatarObjectUrl("");
    restored.value = false;
  }

  async function logout() {
    session.value = null;
    account.value = null;
    setAvatarObjectUrl("");
    restored.value = false;
    try {
      await authClient.signOut();
    } catch { /* 本地会话已清理，服务端注销失败可忽略 */ }
  }

  return {
    session, account, busy, restored,
    signedIn, myUserId, accessToken, deviceId, displayName, avatarUrl, email, emailVerified,
    login, logout, restore, invalidate, refreshProfile, loadAvatar,
    register, sendVerificationOtp, verifyOtp, requestPasswordReset, resetPassword, updateProfile,
  };
}, {
  // ACT: 只持久化 Matrix 半段会话；网站账号会话由 better-auth 的 HttpOnly Cookie 管理，不落 localStorage。
  persist: {
    key: "vidsay.auth",
    pick: ["session"],
    storage: localStorage,
  },
});
