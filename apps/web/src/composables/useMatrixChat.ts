import { computed, ref, shallowRef, watch } from "vue";
import axios from "axios";
import * as sdk from "matrix-js-sdk";
import { translate } from "@toonflow/i18n/vue";
import { authenticatedMediaUrl } from "@/lib/matrixMedia";
import { useAuthStore } from "@/stores/auth";

// ACT: 群聊状态单例（计划 Task 2 + Task 3）。
// Task 2：凭据不再由服务端代签隐藏账号，改为读取 auth store —— 用户自己用密码登录 Matrix 得到的令牌；
//         未登录时 error 置为 'signed-out'，由页面引导登录，不再回落到 /api/matrix/token。
// Task 3：从「单一演示房间」升级为多房间 —— 房间列表（含待接受邀请）、切换活动房间、创建/加入房间，
//         并暴露 isHost（当前房间创建者）供群聊页显示只有主持人可见的生成视频入口。
// 保留原有实现要点：bootstrap/sync 生命周期、safe() 包裹的事件绑定、时间线映射、
// v42 基于成员（RoomMember.typing）的输入状态、已读回执、鉴权媒体的 blob 解析与缓存。

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar: string; // 发送者头像的 blob 地址（鉴权媒体解析后）；无头像为空串
  msgtype: string; // m.text / m.image / m.video / ...
  body: string;
  url: string; // 媒体消息解析出的可播放 blob 地址；文本消息为空串
  ts: number;
  mine: boolean;
};

// 房间列表项：邀请排在最前，其余按最后一条消息时间倒序。
export type RoomSummary = {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  unread: number;
  lastTs: number;
  invited: boolean;
};

// 广场卡片：聚合自已加入房间的 m.video 消息，新者在前。
export type VideoCard = {
  id: string; // 事件 ID，群聊页靠它定位到具体消息
  roomId: string;
  roomName: string;
  description: string; // 生成时写入事件的 description，老事件回落到文件名
  videoUrl: string; // 已解析的 blob 地址；解析中为空串（卡片先占位）
  ts: number;
};

/* 模块级单例：所有组件实例共享同一份响应式状态。 */
const ready = ref(false);
const connecting = ref(false);
const error = ref(""); // '' | 'signed-out' | 'unavailable'
const myUserId = ref("");
const activeRoomId = ref("");
const rooms = ref<RoomSummary[]>([]);
const timeline = ref<ChatMessage[]>([]);
const videos = ref<VideoCard[]>([]);
const typingNames = ref<string[]>([]);

let client: sdk.MatrixClient | null = null;
// ACT: client 是普通变量，computed 无法感知它由 null 变成实例。
// 这里保留一份 shallowRef 镜像专供 computed 依赖，两者只能通过 assignClient() 同时更新。
const activeClient = shallowRef<sdk.MatrixClient | null>(null);
function assignClient(next: sdk.MatrixClient | null) {
  client = next;
  activeClient.value = next;
}
let bootPromise: Promise<boolean> | null = null;
let authWired = false;

const joinedRooms = computed(() => rooms.value.filter(room => !room.invited));
const invites = computed(() => rooms.value.filter(room => room.invited));

/* ─── 鉴权媒体缓存 ───
 * ACT: Synapse 1.157 默认启用「鉴权媒体」，旧的 /_matrix/media/v3/download 会返回 404；
 * 且 <video>/<img> 的 src 无法携带 Bearer 令牌，故用访问令牌把 mxc:// 媒体拉成 blob，
 * 再以 objectURL 供内联播放。解析结果按 mxc 缓存，teardown 时统一 revoke。
 */
const mediaCache = new Map<string, string>(); // mxc -> blobUrl（"" 表示解析失败，不再重试）
const mediaPending = new Set<string>();
const objectUrls = new Set<string>();

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
    .finally(() => { mediaPending.delete(mxc); safe(() => { refreshTimeline(); refreshVideos(); }); });
}

/* ─── 房间与时间线映射 ─── */
// 读取房间的主题状态事件；缺失或格式异常时返回空串。
function roomTopic(room: sdk.Room): string {
  const topic = (room.currentState.getStateEvents("m.room.topic", "")?.getContent() as { topic?: unknown } | undefined)?.topic;
  return typeof topic === "string" ? topic : "";
}

// 未读数在不同版本/线程下可能为 null，这里统一收敛成非负整数，异常一律视为 0。
function unreadCount(room: sdk.Room): number {
  try {
    const value = room.getUnreadNotificationCount() as unknown;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

// 人数统计：getJoinedMemberCount() 只算已加入的，刚建的房邀请还未接受时会显示 1 人，
// 这里把待接受的邀请一并计入，取两者的较大值，避免列表上的人数看起来不对劲。
function memberCount(room: sdk.Room): number {
  const joined = room.getJoinedMemberCount();
  const joinedSafe = typeof joined === "number" && Number.isFinite(joined) ? joined : 0;
  const pending = room.getMembers().filter(member => member.membership === "join" || member.membership === "invite").length;
  return Math.max(joinedSafe, pending);
}

function summarize(room: sdk.Room): RoomSummary {
  let lastTs = 0;
  for (const event of room.getLiveTimeline().getEvents()) {
    const ts = event.getTs();
    if (ts > lastTs) lastTs = ts;
  }
  return {
    id: room.roomId,
    name: room.name || room.roomId,
    topic: roomTopic(room),
    memberCount: memberCount(room),
    unread: unreadCount(room),
    lastTs,
    invited: room.getMyMembership() === "invite",
  };
}

function refreshRooms() {
  if (!client) { rooms.value = []; return; }
  rooms.value = client.getRooms()
    .filter(room => room.getMyMembership() === "join" || room.getMyMembership() === "invite")
    .map(summarize)
    .sort((a, b) => Number(b.invited) - Number(a.invited) || b.lastTs - a.lastTs);
}

// 首次进入且没有指定房间时，默认打开最近活跃的一个已加入房间。
function pickInitialRoom() {
  if (activeRoomId.value && client?.getRoom(activeRoomId.value)) return;
  activeRoomId.value = rooms.value.find(room => !room.invited)?.id ?? "";
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
  if (!client || !activeRoomId.value) { timeline.value = []; typingNames.value = []; return; }
  const room = client.getRoom(activeRoomId.value);
  if (!room) { timeline.value = []; typingNames.value = []; return; }
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
    const member = room.getMember(senderId);
    // ACT: 头像同属鉴权媒体：mxc -> blob；解析完成的回调会再刷一次时间线把头像填上。
    const avatarMxc = member?.getMxcAvatarUrl() ?? "";
    if (avatarMxc && !mediaCache.has(avatarMxc)) resolveMedia(avatarMxc);
    msgs.push({
      id: ev.getId() ?? `${ev.getTs()}-${senderId}`,
      senderId,
      senderName: member?.name || senderId,
      senderAvatar: cachedMediaUrl(avatarMxc),
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

/* ─── 广场视频聚合 ───
 * ACT: 扫描所有已加入房间的实时时间线，把 m.video 消息汇成卡片（新者在前）。
 * 服务端不上传缩略图，封面由卡片端用 <video src="blob#t=0.5"> 取首帧；
 * 这里只负责把视频本体解析成 blob，解析完成后会再跑一次本函数填上 videoUrl。
 * 注意：live timeline 只含 initialSyncLimit 内的近期事件，更早的视频不会出现在广场。
 */
function refreshVideos() {
  if (!client) { videos.value = []; return; }
  const cards: VideoCard[] = [];
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    for (const ev of room.getLiveTimeline().getEvents()) {
      if (ev.getType() !== "m.room.message") continue;
      const content = ev.getContent() ?? {};
      if (content.msgtype !== "m.video") continue;
      const mxc = typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : "";
      if (mxc && !mediaCache.has(mxc)) resolveMedia(mxc);
      const rawDescription = typeof content.description === "string" && content.description.trim() ? content.description.trim() : "";
      cards.push({
        id: ev.getId() ?? `${ev.getTs()}-${ev.getSender()}`,
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        description: rawDescription || (typeof content.body === "string" ? content.body : ""),
        videoUrl: cachedMediaUrl(mxc),
        ts: ev.getTs(),
      });
    }
  }
  cards.sort((a, b) => b.ts - a.ts);
  videos.value = cards;
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
    refreshRooms();
    refreshVideos();
    if (room?.roomId === activeRoomId.value) {
      refreshTimeline();
      if (event.getSender() && event.getSender() !== c.getUserId()) markRead();
    }
  }));
  c.on(sdk.RoomMemberEvent.Typing, (_event, member) => safe(() => {
    if (member.roomId === activeRoomId.value) updateTyping(c.getRoom(activeRoomId.value) ?? null);
  }));
  c.on(sdk.RoomEvent.Name, room => safe(() => {
    if (room?.roomId === activeRoomId.value || rooms.value.some(item => item.id === room?.roomId)) refreshRooms();
  }));
  c.on(sdk.RoomEvent.MyMembership, (room, membership) => safe(() => {
    // ACT: 不再自动接受邀请 —— 邀请要在房间列表里可见，由用户显式点「加入」。
    if (room.roomId === activeRoomId.value && membership !== "join") activeRoomId.value = "";
    refreshRooms();
    pickInitialRoom();
    refreshTimeline();
    refreshVideos();
  }));
}

// 退出登录（或令牌失效被清空）时立即断开客户端；重新登录后由页面再次调用 bootstrap。
function wireAuth() {
  if (authWired) return;
  authWired = true;
  const auth = useAuthStore();
  watch(() => auth.session?.accessToken, token => { if (!token) teardown(); }, { flush: "sync" });
}

/* ─── 生命周期 ─── */
async function bootstrap(): Promise<boolean> {
  const auth = useAuthStore();
  if (!auth.session?.accessToken) {
    error.value = "signed-out";
    ready.value = false;
    return false;
  }
  if (client) return true;
  if (bootPromise) return bootPromise;
  wireAuth();

  bootPromise = (async () => {
    try {
      connecting.value = true;
      error.value = "";
      const session = auth.session!;
      const c = sdk.createClient({
        baseUrl: window.location.origin, // 同源 /_matrix 代理（Vite dev / 生产 Caddy）
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId || undefined,
      });
      wireEvents(c);
      const synced = new Promise<boolean>(resolve => {
        const onSync = (state: sdk.SyncState, _prev: sdk.SyncState | null, data?: sdk.SyncStateData) => {
          if (state === sdk.SyncState.Prepared) { c.removeListener(sdk.ClientEvent.Sync, onSync); resolve(true); }
          // 令牌已失效（例如 Synapse 数据库被重置）：清空登录态，交回登录弹窗。
          if (state === sdk.SyncState.Error && (data?.error as { errcode?: string } | undefined)?.errcode === "M_UNKNOWN_TOKEN") {
            c.removeListener(sdk.ClientEvent.Sync, onSync);
            auth.invalidate();
            resolve(false);
          }
        };
        c.on(sdk.ClientEvent.Sync, onSync);
      });
      await c.startClient({ initialSyncLimit: 30 });
      assignClient(c);
      myUserId.value = session.userId;
      if (!(await synced)) {
        teardown();
        error.value = auth.signedIn ? "unavailable" : "signed-out";
        return false;
      }
      ready.value = true;
      refreshRooms();
      pickInitialRoom();
      refreshTimeline();
      refreshVideos();
      return true;
    } catch (err) {
      console.error("[matrix] bootstrap failed:", err);
      teardown();
      error.value = auth.signedIn ? "unavailable" : "signed-out";
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
    assignClient(null);
  }
  // ACT: 释放本次会话创建的所有 blob URL，避免内存泄漏。
  for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
  objectUrls.clear();
  mediaCache.clear();
  mediaPending.clear();
  ready.value = false;
  connecting.value = false;
  error.value = "";
  myUserId.value = "";
  activeRoomId.value = "";
  rooms.value = [];
  timeline.value = [];
  videos.value = [];
  typingNames.value = [];
}

/* ─── 房间操作 ─── */
// 切换活动房间：重算时间线与输入状态，并把未读清零。
function setActiveRoom(roomId: string) {
  if (!roomId || activeRoomId.value === roomId) { refreshTimeline(); return; }
  activeRoomId.value = roomId;
  refreshTimeline();
  markRead();
  refreshRooms();
}

// 轮询等待房间出现在本地（createRoom/joinRoom 之后 sync 尚未推送到本地状态时的兜底）。
async function waitForRoom(roomId: string, timeout = 8000): Promise<sdk.Room | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const room = client?.getRoom(roomId);
    if (room && room.getMyMembership() === "join") return room;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return client?.getRoom(roomId) ?? null;
}

// ACT: 新建群聊自动拉入 AI 客服（Customer Service）：邀请与入群都由后端用当前用户（房间创建者）
// 的 Matrix 影子身份完成，前端无需知道机器人 mxid。失败只记日志，不影响建房本身（群聊仍可用）。
async function addAgentToRoom(roomId: string) {
  try {
    await axios.post("/api/matrix/agent", { roomId });
  } catch (err) {
    console.warn("[chat] AI 客服入群失败：", err);
  }
}

async function createRoom(options: { name: string; invite?: string[] }): Promise<string> {
  if (!client) throw new Error(translate("尚未连接到聊天服务"));
  const name = options.name.trim();
  if (!name) throw new Error(translate("请输入群聊名称"));
  const created = await client.createRoom({
    name,
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
    invite: options.invite ?? [],
  });
  await waitForRoom(created.room_id);
  // ACT: 先等自己入群（成为房内成员）再拉 AI 客服，否则后端的代签邀请会因邀请人不在房内而 403。
  await addAgentToRoom(created.room_id);
  refreshRooms();
  setActiveRoom(created.room_id);
  return created.room_id;
}

// 支持房间 ID（!abc:server）与房间别名（#abc:server）两种输入。
async function joinRoom(idOrAlias: string): Promise<string> {
  if (!client) throw new Error(translate("尚未连接到聊天服务"));
  const target = idOrAlias.trim();
  if (!target) throw new Error(translate("请输入房间 ID 或别名"));
  const room = await client.joinRoom(target);
  await waitForRoom(room.roomId);
  refreshRooms();
  setActiveRoom(room.roomId);
  return room.roomId;
}

async function acceptInvite(roomId: string) {
  if (!client || !roomId) return;
  await client.joinRoom(roomId);
  await waitForRoom(roomId);
  refreshRooms();
  setActiveRoom(roomId);
}

/* ─── 聊天动作 ─── */
function markRead() {
  if (!client || !activeRoomId.value) return;
  const events = client.getRoom(activeRoomId.value)?.getLiveTimeline().getEvents() ?? [];
  const last = events[events.length - 1];
  if (last) client.sendReadReceipt(last).catch(() => {});
}

async function sendText(body: string) {
  const text = (body || "").trim();
  if (!client || !activeRoomId.value || !text) return;
  await client.sendTextMessage(activeRoomId.value, text);
  refreshTimeline();
  refreshRooms();
}

// ACT: 截图发送：上传二进制到 Matrix 内容仓库，再发 m.image 事件。
async function sendImage(file: File, name: string, width: number, height: number) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const uploaded = await client.uploadContent(file, { name, type: file.type });
  const mxc = typeof uploaded === "string" ? uploaded : (uploaded as { content_uri?: string })?.content_uri;
  if (!mxc) throw new Error(translate("上传失败，请稍后重试"));
  await client.sendMessage(activeRoomId.value, {
    msgtype: sdk.MsgType.Image,
    body: name,
    url: mxc,
    info: { mimetype: file.type, size: file.size, w: width, h: height },
  });
  refreshTimeline();
  refreshRooms();
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
function noteTyping() {
  if (!client || !activeRoomId.value) return;
  client.sendTyping(activeRoomId.value, true, 4000).catch(() => {});
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    client?.sendTyping(activeRoomId.value, false, 0).catch(() => {});
  }, 4000);
}

// ACT: 依赖必须来自响应式来源（activeClient / activeRoomId）。
// 早先写成 `client ? client.getRoom(activeRoomId.value) : null`：client 为 null 时短路求值
// 根本不会读取 activeRoomId，于是这个 computed 没有任何依赖、永久缓存 null，
// 表现为群聊标题退化成房间 ID、「主持人」标签与两个生成视频入口始终不渲染。
const activeRoom = computed(() => {
  const current = activeClient.value;
  const roomId = activeRoomId.value;
  return current && roomId ? (current.getRoom(roomId) ?? null) : null;
});
// ACT: 标题取 rooms 快照中的名字（refreshRooms 随 Timeline/Name 事件刷新，是响应式来源）。
// 不能直接读 activeRoom.name：SDK 会对 room 对象原地改名，computed 对其无响应式依赖、不会重算，
// 标题会停在进房瞬间的默认名（如 "Empty room"），与左栏列表显示的群名不一致。
const roomName = computed(() => {
  const id = activeRoomId.value;
  return rooms.value.find(room => room.id === id)?.name || activeRoom.value?.name || id;
});
// ACT: 主持人＝当前房间的创建者（m.room.create 的发送者）；只有主持人才看到生成视频入口。
const isHost = computed(() => {
  const room = activeRoom.value;
  if (!room || !myUserId.value) return false;
  return room.currentState.getStateEvents("m.room.create", "")?.getSender() === myUserId.value;
});

export function useMatrixChat() {
  return {
    ready, connecting, error, myUserId,
    rooms, joinedRooms, invites, activeRoomId, roomName, isHost,
    timeline, videos, typingNames,
    bootstrap, teardown, refreshRooms,
    setActiveRoom, createRoom, joinRoom, acceptInvite,
    sendText, sendImage, noteTyping, markRead,
  };
}
