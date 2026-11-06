import { getSynapseConfig } from "@/utils/appConfig";

// ACT: Synapse（Matrix）Admin API 封装，端口自 drone-navigation-v2/server/app/matrix_admin.py。
// 设计原则：网站身份仍由 vidsay 掌握，每个 Matrix 账号都是隐藏账号，
// 客户端凭据通过 Admin「傀儡令牌」流程（POST /_synapse/admin/v1/users/<mxid>/login）代签，
// 用户永远不会看到 Matrix 密码。Synapse 故障绝不能拖垮主服务：所有辅助函数在不可用时降级。

export type BrokeredCredentials = { access_token: string; user_id: string; device_id: string | null };

// ACT: 读取并校验 Synapse 配置；缺失时抛出带 status 的错误，交由路由层转成 503。
function requireConfig() {
  const synapse = getSynapseConfig();
  if (!synapse.baseUrl || !synapse.adminAccessToken) {
    throw Object.assign(new Error("未配置 Synapse，请在 config.json 的 synapse 块填写 baseUrl 与 adminAccessToken"), { status: 503 });
  }
  return synapse as { baseUrl: string; serverName: string; adminAccessToken: string; botUserId: string; roomId: string };
}

function adminHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// 是否已配置可用的 Synapse（供路由/启动逻辑做优雅降级判断）。
export function isConfigured(): boolean {
  const synapse = getSynapseConfig();
  return Boolean(synapse.baseUrl && synapse.adminAccessToken);
}

// 生成一个没人会使用的随机密码（隐藏账号仍需一个密码字段）。
export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// 幂等地创建/更新一个 Matrix 账号（PUT /_synapse/admin/v2/users/<mxid>）。
// 返回 true 表示成功；Synapse 不可用或被拒绝时返回 false（不抛错，聊天降级但主服务不受影响）。
export async function ensureUser(mxid: string, options?: { password?: string; displayName?: string; admin?: boolean }): Promise<boolean> {
  const synapse = requireConfig();
  const body: Record<string, unknown> = { password: options?.password ?? randomPassword() };
  if (options?.displayName) body.displayname = options.displayName;
  if (options?.admin !== undefined) body.admin = options.admin;
  try {
    const resp = await fetch(`${synapse.baseUrl}/_synapse/admin/v2/users/${mxid}`, {
      method: "PUT",
      headers: adminHeaders(synapse.adminAccessToken),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`[matrix] ensureUser ${mxid} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[matrix] ensureUser ${mxid} 失败:`, err);
    return false;
  }
}

// 为某个隐藏账号代签客户端凭据（POST /_synapse/admin/v1/users/<mxid>/login，Synapse >= 1.49）。
// 成功返回 { access_token, user_id, device_id }；不可用时返回 null。
export async function brokerToken(mxid: string): Promise<BrokeredCredentials | null> {
  const synapse = requireConfig();
  try {
    const resp = await fetch(`${synapse.baseUrl}/_synapse/admin/v1/users/${mxid}/login`, {
      method: "POST",
      headers: adminHeaders(synapse.adminAccessToken),
      body: "{}",
    });
    if (!resp.ok) {
      console.error(`[matrix] brokerToken ${mxid} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as { access_token: string; device_id?: string };
    return { access_token: data.access_token, user_id: mxid, device_id: data.device_id ?? null };
  } catch (err) {
    console.error(`[matrix] brokerToken ${mxid} 失败:`, err);
    return null;
  }
}

// 创建一个房间，返回 roomId（失败返回 null）。
// ACT: 传入 creatorMxid 时改用该账号的代签令牌建房，让它成为 m.room.create 的发送者，
// 也就是前端的「主持人」——演示房间必须由 host 创建，host 登录后才看得到生成视频入口。
// 未指定（或代签失败）时回落到管理员令牌。
export async function createRoom(name: string, creatorMxid?: string, invite?: string[]): Promise<string | null> {
  const synapse = requireConfig();
  let token = synapse.adminAccessToken;
  if (creatorMxid) {
    const creds = await brokerToken(creatorMxid);
    if (creds) token = creds.access_token;
    else console.error(`[matrix] createRoom 无法代签 ${creatorMxid}，回落为管理员建房`);
  }
  try {
    const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/createRoom`, {
      method: "POST",
      headers: adminHeaders(token),
      body: JSON.stringify({ name, visibility: "private", preset: "private_chat", invite: invite ?? [] }),
    });
    if (!resp.ok) {
      console.error(`[matrix] createRoom -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as { room_id: string };
    return data.room_id;
  } catch (err) {
    console.error(`[matrix] createRoom 失败:`, err);
    return null;
  }
}

// 读取房间的创建者 mxid（GET /_synapse/admin/v1/rooms/<roomId>）；不可用时返回空串。
export async function roomCreator(roomId: string): Promise<string> {
  const synapse = requireConfig();
  try {
    const resp = await fetch(`${synapse.baseUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`, {
      headers: adminHeaders(synapse.adminAccessToken),
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as { creator?: unknown };
    return typeof data.creator === "string" ? data.creator : "";
  } catch (err) {
    console.error(`[matrix] roomCreator 失败:`, err);
    return "";
  }
}

/* ACT: 下面两个函数取代旧的「管理员强制拉人」（POST /_synapse/admin/v1/join）。
 * 那个接口在私有房间里会先让「管理员本人」发邀请，管理员不在房内就直接 403
 * （"@chat2admin:localhost not in room"）；房间改为由 host 创建后管理员已不是成员，
 * 所以改成「host 邀请 + 本人接受邀请」两步，都不依赖管理员的房籍。 */

// 以 inviterMxid 的身份邀请 targetMxid 进房；对方已在房里时视为成功（幂等）。
export async function inviteToRoom(inviterMxid: string, roomId: string, targetMxid: string): Promise<boolean> {
  const synapse = requireConfig();
  const creds = await brokerToken(inviterMxid);
  if (!creds) return false;
  try {
    const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: "POST",
      headers: adminHeaders(creds.access_token),
      body: JSON.stringify({ user_id: targetMxid }),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      if (detail.includes("is already in the room")) return true;
      console.error(`[matrix] inviteToRoom ${targetMxid} -> HTTP ${resp.status}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[matrix] inviteToRoom ${targetMxid} 失败:`, err);
    return false;
  }
}

// 代签 mxid 的客户端令牌后，以它自己的身份加入房间（已加入时 Synapse 返回 200 空操作）。
export async function joinRoomAs(mxid: string, roomId: string): Promise<boolean> {
  const synapse = requireConfig();
  const creds = await brokerToken(mxid);
  if (!creds) return false;
  try {
    const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: "POST",
      headers: adminHeaders(creds.access_token),
      body: "{}",
    });
    if (!resp.ok) {
      console.error(`[matrix] joinRoomAs ${mxid} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[matrix] joinRoomAs ${mxid} 失败:`, err);
    return false;
  }
}

// 读取房间当前的成员 mxid 列表（GET /_synapse/admin/v1/rooms/<roomId>/members）；不可用时返回空数组。
export async function roomMembers(roomId: string): Promise<string[]> {
  const synapse = requireConfig();
  try {
    const resp = await fetch(`${synapse.baseUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`, {
      headers: adminHeaders(synapse.adminAccessToken),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { members?: unknown };
    return Array.isArray(data.members) ? data.members.filter((mxid): mxid is string => typeof mxid === "string") : [];
  } catch (err) {
    console.error(`[matrix] roomMembers 失败:`, err);
    return [];
  }
}

// 代签 mxid 的令牌后，以它自己的身份往房间发一条 m.text 消息
// （PUT /_matrix/client/v3/rooms/<roomId>/send/m.room.message/<txnId>，txnId 保证幂等不重复发）。
export async function sendTextAs(mxid: string, roomId: string, body: string): Promise<boolean> {
  const synapse = requireConfig();
  const creds = await brokerToken(mxid);
  if (!creds) return false;
  const txnId = `c2m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`, {
      method: "PUT",
      headers: adminHeaders(creds.access_token),
      body: JSON.stringify({ msgtype: "m.text", body }),
    });
    if (!resp.ok) {
      console.error(`[matrix] sendTextAs ${mxid} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[matrix] sendTextAs ${mxid} 失败:`, err);
    return false;
  }
}

// ACT: 把本地账号的昵称/头像同步到隐藏 Matrix 账号的 profile（端口自 drone 的 PATCH /users/me 行为）。
// 头像以 data URI 传入：先上传到 Matrix 媒体库换 mxc:// 地址，再写入 avatar_url；
// 任一环节失败只记日志不抛错（聊天降级，主服务不受影响）。
export async function syncMatrixProfile(mxid: string, displayName?: string, avatarDataUri?: string): Promise<boolean> {
  const synapse = requireConfig();
  const creds = await brokerToken(mxid);
  if (!creds) return false;
  const headers = adminHeaders(creds.access_token);
  const encoded = encodeURIComponent(mxid);
  try {
    if (displayName) {
      const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/profile/${encoded}/displayname`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ displayname: displayName }),
      });
      if (!resp.ok) console.error(`[matrix] syncMatrixProfile displayname ${mxid} -> HTTP ${resp.status}`);
    }
    const match = avatarDataUri ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(avatarDataUri) : null;
    if (match) {
      const upload = await fetch(`${synapse.baseUrl}/_matrix/media/v3/upload?filename=avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": match[1] },
        body: Buffer.from(match[2], "base64"),
      });
      if (upload.ok) {
        const { content_uri } = (await upload.json()) as { content_uri?: string };
        if (content_uri) {
          const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/profile/${encoded}/avatar_url`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ avatar_url: content_uri }),
          });
          if (!resp.ok) console.error(`[matrix] syncMatrixProfile avatar ${mxid} -> HTTP ${resp.status}`);
        }
      } else {
        console.error(`[matrix] syncMatrixProfile 上传头像 ${mxid} -> HTTP ${upload.status}`);
      }
    }
    return true;
  } catch (err) {
    console.error(`[matrix] syncMatrixProfile ${mxid} 失败:`, err);
    return false;
  }
}
