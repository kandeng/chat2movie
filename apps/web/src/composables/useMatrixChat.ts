import { computed, ref } from "vue";
import axios from "axios";
import * as sdk from "matrix-js-sdk";

// ACT: 本文件是 drone-navigation-v2/client/composables/useMatrixClient.js 的精简 TS 移植版。
// 原型阶段差异：chat2movie 尚无网站登录态，因此不使用 JWT/Bearer，也不做 useAuth 联动；
// 凭据直接从 GET /api/matrix/token?user=<localpart> 代签，并锁定到单一演示房间（config.synapse.roomId）。
// 已移除：DM/团队房间创建、通讯录目录、多房间列表、登录登出联动。保留：bootstrap/sync 生命周期、
// safe() 包裹的事件绑定、时间线映射、v42 基于成员的输入状态、已读回执、令牌失效自动重签。

// 演示身份：默认以主持人 host 登录；可通过 bootstrap(user) 覆盖。
const DEFAULT_USER = "host";
const CRED_KEY = "chat2movie.matrix.creds";

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  msgtype: string; // m.text / m.image / m.video / ...
  body: string;
  url: string; // 媒体消息经 mxcUrlToHttp 解析出的可播放地址；文本消息为空串
  ts: number;
  mine: boolean;
};

type BrokeredCreds = {
  access_token: string;
  user_id: string;
  device_id: string | null;
  room_id?: string;
  server_name?: string;
};

/* 模块级单例：所有组件实例共享同一份响应式状态。 */
const ready = ref(false);
const connecting = ref(false);
const error = ref(""); // '' | 'unavailable'
const myUserId = ref("");
const roomId = ref("");
const timeline = ref<ChatMessage[]>([]);
const typingNames = ref<string[]>([]);

let client: sdk.MatrixClient | null = null;
let bootPromise: Promise<boolean> | null = null;

/* ─── 凭据代签 ─── */
async function fetchCreds(user: string): Promise<BrokeredCreds> {
  const cached = sessionStorage.getItem(CRED_KEY);
  if (cached) {
    try {
      const creds = JSON.parse(cached) as BrokeredCreds & { _user?: string };
      // ACT: 缓存与代签它的演示身份绑定；切换 user 时必须丢弃，否则会沿用上一个身份的令牌与房间。
      if (creds._user === user && creds.access_token) return creds;
    } catch {
      /* 落到重新代签 */
    }
    sessionStorage.removeItem(CRED_KEY);
  }
  const { data } = await axios.get<{ code: number; data: BrokeredCreds | null; message?: string }>(
    "/api/matrix/token", { params: { user }, headers: { "Cache-Control": "no-cache" } },
  );
  if (data.code !== 200 || !data.data?.access_token) throw new Error(data.message || `matrix token HTTP ${data.code}`);
  const creds = data.data;
  sessionStorage.setItem(CRED_KEY, JSON.stringify({ ...creds, _user: user }));
  return creds;
}

/* ─── 时间线映射 ─── */
// ACT: Synapse 1.157 默认启用「鉴权媒体」，旧的 /_matrix/media/v3/download 会返回 404；
// 且 <video>/<img> 的 src 无法携带 Bearer 令牌，故这里用访问令牌把 mxc:// 媒体拉成 blob，
// 再以 objectURL 供内联播放。解析结果按 mxc 缓存，teardown 时统一 revoke。
const mediaCache = new Map<string, string>(); // mxc -> blobUrl（"" 表示解析失败，不再重试）
const mediaPending = new Set<string>();
const objectUrls = new Set<string>();

// 由 mxc://<serverName>/<mediaId> 构造同源鉴权下载地址（经 Vite /_matrix 代理转发到 Synapse）。
function authenticatedMediaUrl(mxc: string): string {
  const body = mxc.slice("mxc://".length);
  const slash = body.indexOf("/");
  if (slash <= 0) return "";
  const serverName = body.slice(0, slash);
  const mediaId = body.slice(slash + 1);
  if (!serverName || !mediaId) return "";
  return `${window.location.origin}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
}

// 同步读取已解析的 blob 地址；未解析或失败返回空串。
function cachedMediaUrl(mxc: unknown): string {
  return typeof mxc === "string" && mxc.startsWith("mxc://") ? mediaCache.get(mxc) ?? "" : "";
}

// 异步解析单个 mxc 媒体；完成后刷新时间线（此时缓存已命中，不会重复触发）。
function resolveMedia(mxc: string) {
  if (!client || mediaCache.has(mxc) || mediaPending.has(mxc)) return;
  const url = authenticatedMediaUrl(mxc);
  const token = client.getAccessToken();
  if (!url || !token) { mediaCache.set(mxc, ""); return; }
  mediaPending.add(mxc);
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then(resp => { if (!resp.ok) throw new Error(`media HTTP ${resp.status}`); return resp.blob(); })
    .then(blob => { const objectUrl = URL.createObjectURL(blob); objectUrls.add(objectUrl); mediaCache.set(mxc, objectUrl); })
    .catch(err => { console.warn("[matrix] 媒体解析失败:", mxc, err); mediaCache.set(mxc, ""); })
    .finally(() => { mediaPending.delete(mxc); safe(() => refreshTimeline()); });
}

function updateTyping(room: sdk.Room | null) {
  if (!room || !client) { typingNames.value = []; return; }
  const me = client.getUserId();
  // matrix-js-sdk v42：输入状态基于成员（RoomMember.typing），Room.getTypingMembers() 已移除。
  typingNames.value = room.getMembers()
    .filter(member => member.typing && member.userId !== me)
    .map(member => member.name);
}

function refreshTimeline() {
  if (!client || !roomId.value) { timeline.value = []; typingNames.value = []; return; }
  const room = client.getRoom(roomId.value);
  if (!room) { timeline.value = []; return; }
  const me = client.getUserId();
  const msgs: ChatMessage[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.getType() !== "m.room.message") continue;
    const content = ev.getContent() ?? {};
    const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
    if (!msgtype) continue;
    const senderId = ev.getSender() ?? "";
    const mxc = typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : "";
    // ACT: 媒体消息异步解析成 blob URL（鉴权媒体）；解析完成后会再次刷新时间线。
    if (mxc && !mediaCache.has(mxc)) resolveMedia(mxc);
    msgs.push({
      id: ev.getId() ?? `${ev.getTs()}-${senderId}`,
      senderId,
      senderName: room.getMember(senderId)?.name || senderId,
      msgtype,
      body: typeof content.body === "string" ? content.body : "",
      url: cachedMediaUrl(mxc),
      ts: ev.getTs(),
      mine: senderId === me,
    });
  }
  timeline.value = msgs;
  updateTyping(room);
}

/* ─── 事件绑定 ───
 * 每个处理函数都经过 safe()：UI 映射异常绝不能回灌进 SDK —— Room.timeline 处理内抛错
 * 会破坏 sendTextMessage（pending-event 路径）并中断 /sync 的房间处理。
 */
function safe(fn: () => void) {
  try { fn(); } catch (err) { console.error("[matrix] UI refresh failed:", err); }
}

function wireEvents(c: sdk.MatrixClient) {
  c.on(sdk.RoomEvent.Timeline, (event, room) => safe(() => {
    if (room?.roomId === roomId.value) {
      refreshTimeline();
      if (event.getSender() && event.getSender() !== c.getUserId()) markRead();
    }
  }));
  c.on(sdk.RoomMemberEvent.Typing, (_event, member) => safe(() => {
    if (member.roomId === roomId.value) updateTyping(c.getRoom(roomId.value) ?? null);
  }));
  c.on(sdk.RoomEvent.MyMembership, (room, membership) => safe(() => {
    // ACT: 原型自动接受邀请，确保被拉进演示房间后立即可见。
    if (membership === "invite") c.joinRoom(room.roomId).catch(() => {});
    if (room.roomId === roomId.value) refreshTimeline();
  }));
}

/* ─── 生命周期 ─── */
async function bootstrap(user = DEFAULT_USER): Promise<boolean> {
  if (client) return true;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      connecting.value = true;
      error.value = "";
      const creds = await fetchCreds(user);
      const c = sdk.createClient({
        baseUrl: window.location.origin, // 同源 /_matrix 代理（Vite dev / 生产 Caddy）
        accessToken: creds.access_token,
        userId: creds.user_id,
        deviceId: creds.device_id || undefined,
      });
      roomId.value = creds.room_id ?? "";
      wireEvents(c);
      const synced = new Promise<boolean>(resolve => {
        const onSync = (state: sdk.SyncState, _prev: sdk.SyncState | null, data?: sdk.SyncStateData) => {
          if (state === sdk.SyncState.Prepared) { c.removeListener(sdk.ClientEvent.Sync, onSync); resolve(true); }
          // 缓存令牌失效（例如 Synapse 数据库被重置）：强制下次重新代签。
          if (state === sdk.SyncState.Error && (data?.error as { errcode?: string } | undefined)?.errcode === "M_UNKNOWN_TOKEN") sessionStorage.removeItem(CRED_KEY);
        };
        c.on(sdk.ClientEvent.Sync, onSync);
      });
      await c.startClient({ initialSyncLimit: 30 });
      client = c;
      myUserId.value = creds.user_id;
      await synced;
      ready.value = true;
      refreshTimeline();
      return true;
    } catch (err) {
      console.error("[matrix] bootstrap failed:", err);
      error.value = "unavailable";
      teardown();
      return false;
    } finally {
      connecting.value = false;
      bootPromise = null;
    }
  })();
  return bootPromise;
}

function teardown() {
  if (client) {
    try { client.stopClient(); } catch { /* noop */ }
    client = null;
  }
  // ACT: 释放本次会话创建的所有 blob URL，避免内存泄漏。
  for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
  objectUrls.clear();
  mediaCache.clear();
  mediaPending.clear();
  sessionStorage.removeItem(CRED_KEY);
  ready.value = false;
  error.value = "";
  myUserId.value = "";
  roomId.value = "";
  timeline.value = [];
  typingNames.value = [];
}

/* ─── 聊天动作 ─── */
function markRead() {
  if (!client || !roomId.value) return;
  const events = client.getRoom(roomId.value)?.getLiveTimeline().getEvents() ?? [];
  const last = events[events.length - 1];
  if (last) client.sendReadReceipt(last).catch(() => {});
}

async function sendText(body: string) {
  const text = (body || "").trim();
  if (!client || !roomId.value || !text) return;
  await client.sendTextMessage(roomId.value, text);
  refreshTimeline();
}

// ACT: “生成视频”按钮把机器人指令发进房间（Task 3 的机器人稍后监听并触发生成，在此之前该指令仅是普通消息）。
async function sendGenerateCommand(command = "!video") {
  await sendText(command);
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
function noteTyping() {
  if (!client || !roomId.value) return;
  client.sendTyping(roomId.value, true, 4000).catch(() => {});
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    client?.sendTyping(roomId.value, false, 0).catch(() => {});
  }, 4000);
}

const roomName = computed(() => client?.getRoom(roomId.value)?.name ?? roomId.value);

export function useMatrixChat() {
  return {
    ready, connecting, error, myUserId, roomId, roomName,
    timeline, typingNames,
    bootstrap, teardown,
    sendText, sendGenerateCommand, noteTyping, markRead,
  };
}
