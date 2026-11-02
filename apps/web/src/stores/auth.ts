import { defineStore } from "pinia";
import { computed, ref } from "vue";
import axios from "axios";
import { translate } from "@toonflow/i18n/vue";
import { fetchMediaBlobUrl } from "@/lib/matrixMedia";

// ACT: 统一登录态（计划 Task 2）。chat2movie 的网站账号即 Matrix 账号：
// 直接用用户名/密码向 /_matrix/client/v3/login 换取 access_token，不再走服务端代签隐藏账号。
// 会话持久化到 localStorage（而不是默认的服务端 settings 存储），避免令牌写进共享配置文件；
// 刷新后由 restore() 用 whoami 校验令牌是否仍然有效，失效则静默清空并要求重新登录。

export type AuthSession = {
  userId: string; // @localpart:serverName
  accessToken: string;
  deviceId: string;
  displayName: string;
  avatarUrl: string; // mxc:// 或空串
};

type LoginResponse = { user_id: string; access_token: string; device_id: string };
type ProfileResponse = { displayname?: string; avatar_url?: string };

const DEVICE_NAME = "chat2movie web";

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

// 从 @localpart:serverName 取本地名，用作无昵称时的显示名兜底。
export function localpartOf(userId: string): string {
  if (!userId) return "";
  const bare = userId.startsWith("@") ? userId.slice(1) : userId;
  return bare.split(":")[0] || bare;
}

// 把 Synapse 的错误码翻译成可读提示；网络不可达时给出本地部署排查线索。
function loginFailure(error: unknown): Error {
  const status = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0;
  const errcode = axios.isAxiosError(error)
    ? (error.response?.data as { errcode?: string } | undefined)?.errcode ?? ""
    : "";
  if (errcode === "M_FORBIDDEN" || status === 403) return new Error(translate("用户名或密码错误"));
  if (errcode === "M_USER_DEACTIVATED") return new Error(translate("该账号已被停用"));
  if (errcode === "M_LIMIT_EXCEEDED") return new Error(translate("登录过于频繁，请稍后再试"));
  if (errcode === "M_UNKNOWN_TOKEN") return new Error(translate("登录状态已失效，请重新登录"));
  if (!status) return new Error(translate("无法连接 Matrix 服务，请确认本地 Synapse 已启动"));
  return new Error(translate("登录失败，请稍后重试"));
}

export const useAuthStore = defineStore("auth", () => {
  const session = ref<AuthSession | null>(null);
  const busy = ref(false);
  const restored = ref(false);
  // ACT: 头像的 blob 地址只存在于内存（objectURL 无法持久化），每次会话恢复后重新拉取。
  const avatarObjectUrl = ref("");

  const signedIn = computed(() => Boolean(session.value?.accessToken));
  const myUserId = computed(() => session.value?.userId ?? "");
  const accessToken = computed(() => session.value?.accessToken ?? "");
  const deviceId = computed(() => session.value?.deviceId ?? "");
  const displayName = computed(() => session.value?.displayName || localpartOf(session.value?.userId ?? ""));
  const avatarUrl = computed(() => avatarObjectUrl.value);

  function setAvatarObjectUrl(url: string) {
    if (avatarObjectUrl.value && avatarObjectUrl.value !== url) URL.revokeObjectURL(avatarObjectUrl.value);
    avatarObjectUrl.value = url;
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

  async function login(user: string, password: string) {
    // ACT: 允许输入 host / @host / @host:localhost 三种写法，统一裁剪成本地名。
    const identifier = localpartOf(user.trim());
    if (!identifier) throw new Error(translate("请输入用户名"));
    if (!password) throw new Error(translate("请输入密码"));
    busy.value = true;
    try {
      const { data } = await axios.post<LoginResponse>("/_matrix/client/v3/login", {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: identifier },
        password,
        initial_device_display_name: DEVICE_NAME,
      });
      if (!data?.access_token || !data?.user_id) throw new Error(translate("登录失败，请稍后重试"));
      session.value = {
        userId: data.user_id,
        accessToken: data.access_token,
        deviceId: data.device_id ?? "",
        displayName: localpartOf(data.user_id),
        avatarUrl: "",
      };
      restored.value = true;
      await refreshProfile();
    } catch (error) {
      // ACT: axios 抛出的网络/鉴权错误在此统一转换；已经是可读提示的原样抛出。
      if (axios.isAxiosError(error)) throw loginFailure(error);
      throw error;
    } finally {
      busy.value = false;
    }
  }

  // 页面刷新后校验持久化令牌；返回是否仍处于登录态。
  async function restore(): Promise<boolean> {
    if (restored.value) return signedIn.value;
    restored.value = true;
    const current = session.value;
    if (!current?.accessToken) { session.value = null; return false; }
    try {
      await axios.get("/_matrix/client/v3/account/whoami", { headers: authHeaders(current.accessToken) });
    } catch {
      session.value = null;
      return false;
    }
    void refreshProfile();
    return true;
  }

  // 令牌失效（例如 Synapse 数据库被重置）时由聊天层调用，清空会话但不请求 logout。
  function invalidate() {
    session.value = null;
    setAvatarObjectUrl("");
    restored.value = false;
  }

  async function logout() {
    const current = session.value;
    session.value = null;
    setAvatarObjectUrl("");
    restored.value = false;
    if (!current?.accessToken) return;
    try {
      await axios.post("/_matrix/client/v3/logout", {}, { headers: authHeaders(current.accessToken) });
    } catch { /* 本地会话已清理，服务端注销失败可忽略 */ }
  }

  return {
    session, busy, restored,
    signedIn, myUserId, accessToken, deviceId, displayName, avatarUrl,
    login, logout, restore, invalidate, refreshProfile, loadAvatar,
  };
}, {
  // ACT: 使用 localStorage 而非全局的 settingsStorage，令牌不落到服务端共享配置里。
  persist: {
    key: "chat2movie.auth",
    pick: ["session"],
    storage: localStorage,
  },
});
