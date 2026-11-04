import { getSynapseConfig } from "@/utils/appConfig";
import { ensureUser, inviteToRoom, isConfigured, joinRoomAs, roomMembers, sendTextAs, syncMatrixProfile } from "@/utils/matrix/admin";

// ACT: 群聊里的 AI 客服（机器人成员）。每次新建群聊都自动把它拉进来，见 routes/matrix/agent.ts。
// 身份固定：显示名 "Customer Service"，头像取 apps/web/src/icons/customer_service.svg。
// 服务端构建产物（build/server）不包含 web 的静态资源，运行期按路径读文件不可靠，所以把 SVG 内联在这里。
export const AGENT_DISPLAY_NAME = "Customer Service";
// 新建群聊后由 AI 客服自动发出的第一条消息（固定文案，不随界面语言变化）。
export const AGENT_GREETING = "Hello friends! ";

const AGENT_AVATAR_SVG = `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M868.5 418.1h-37.9c-15.1-164-153.2-292.8-321.1-292.8-167.8 0-306 128.9-321 292.8h-31.1c-8.8 0-15.9 7.2-15.9 15.9v272.3c0 8.8 7.2 15.9 15.9 15.9H287c8.8 0 15.9-7.2 15.9-15.9V434c0-8.8-7.2-15.9-15.9-15.9h-27.7C274 293 380.5 195.6 509.5 195.6S745 293 759.8 418.1h-20.9c-8.8 0-15.9 7.2-15.9 15.9v272.3c0 8.8 7.2 15.9 15.9 15.9h37.3c-10.9 46.3-79 85.8-169.8 102.7v-4.4c0-8.8-7.2-15.9-15.9-15.9H428.6c-8.8 0-15.9 7.2-15.9 15.9v65c0 8.8 7.2 15.9 15.9 15.9h161.8c8.8 0 15.9-7.2 15.9-15.9V864c115.7-19.8 199-74.5 208.5-141.8h53.6c8.8 0 15.9-7.2 15.9-15.9V434c0.1-8.7-7.1-15.9-15.8-15.9z" fill="currentColor"></path><path d="M672.4 571.1c1-9.3-7-17.2-16.3-17.2H369.8c-9.4 0-17.3 7.9-16.3 17.2 8.6 80.5 76.7 143.1 159.4 143.1 82.8 0.1 150.9-62.6 159.5-143.1z" fill="currentColor"></path></svg>`;

// 进程内标记：身份只在首次需要时同步，避免每次入群都往 Matrix 媒体库重复上传头像。
let identityReady = false;

// 读取某个账号当前的 profile（GET /_matrix/client/v3/profile/<mxid> 无需鉴权）；失败返回 null。
async function readProfile(baseUrl: string, mxid: string): Promise<{ displayname?: string; avatar_url?: string } | null> {
  try {
    const resp = await fetch(`${baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(mxid)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as { displayname?: string; avatar_url?: string };
  } catch {
    return null;
  }
}

// 幂等地确保机器人账号存在，且显示名/头像就是规定的那一套。
// 返回机器人 mxid；未配置 Synapse 或未配置 botUserId 时返回空串（调用方降级，不抛错）。
export async function ensureAgentIdentity(): Promise<string> {
  if (!isConfigured()) return "";
  const synapse = getSynapseConfig();
  const { baseUrl, botUserId } = synapse;
  if (!baseUrl || !botUserId) {
    console.warn("[matrix] 未配置 synapse.botUserId，AI 客服无法入群");
    return "";
  }
  if (identityReady) return botUserId;
  // 账号可能还没被 provision-matrix 脚本建过，这里幂等补建；机器人只用 Admin 代签令牌登录，随机密码即可。
  await ensureUser(botUserId, { displayName: AGENT_DISPLAY_NAME });
  const profile = await readProfile(baseUrl, botUserId);
  if (profile?.displayname !== AGENT_DISPLAY_NAME || !profile.avatar_url) {
    const avatarDataUri = `data:image/svg+xml;base64,${Buffer.from(AGENT_AVATAR_SVG, "utf8").toString("base64")}`;
    // 只有真正同步成功才置位标记，失败时下次入群再试一次。
    identityReady = await syncMatrixProfile(botUserId, AGENT_DISPLAY_NAME, avatarDataUri);
  } else {
    identityReady = true;
  }
  return botUserId;
}

// 把 AI 客服加进房间：由 inviterMxid（房间创建者，必须是房内成员）发邀请，机器人再自己接受邀请。
// 与 provision-matrix 脚本同一套路 —— 管理员不在房内时，Admin 的强制拉人接口会 403。
// 机器人已在房内时 Synapse 视为空操作，整体幂等；入群成功后由它发出第一条问候消息。
export async function addAgentToRoom(inviterMxid: string, roomId: string): Promise<boolean> {
  const botUserId = await ensureAgentIdentity();
  if (!botUserId) return false;
  // 已在房内说明是重复调用（例如前端重试），不再问候，避免同一句话刷屏。
  const alreadyJoined = (await roomMembers(roomId)).includes(botUserId);
  if (!(await inviteToRoom(inviterMxid, roomId, botUserId))) return false;
  if (!(await joinRoomAs(botUserId, roomId))) return false;
  if (alreadyJoined) return true;
  // 问候失败不影响“已入群”这个结果（机器人仍是成员），只记日志。
  if (!(await sendTextAs(botUserId, roomId, AGENT_GREETING))) {
    console.warn(`[matrix] AI 客服入群问候发送失败：${roomId}`);
  }
  return true;
}
