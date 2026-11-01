import { getSynapseConfig } from "@/utils/appConfig";

// ACT: Synapse（Matrix）Admin API 封装，端口自 drone-navigation-v2/server/app/matrix_admin.py。
// 设计原则：网站身份仍由 chat2movie 掌握，每个 Matrix 账号都是隐藏账号，
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

// 用管理员客户端令牌创建一个房间，返回 roomId（失败返回 null）。
export async function createRoom(name: string): Promise<string | null> {
  const synapse = requireConfig();
  try {
    const resp = await fetch(`${synapse.baseUrl}/_matrix/client/v3/createRoom`, {
      method: "POST",
      headers: adminHeaders(synapse.adminAccessToken),
      body: JSON.stringify({ name, visibility: "private", preset: "private_chat" }),
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

// 管理员强制把某用户拉进房间（POST /_synapse/admin/v1/join/<roomId>），免去手动接受邀请。
export async function adminJoinRoom(roomId: string, mxid: string): Promise<boolean> {
  const synapse = requireConfig();
  try {
    const resp = await fetch(`${synapse.baseUrl}/_synapse/admin/v1/join/${roomId}`, {
      method: "POST",
      headers: adminHeaders(synapse.adminAccessToken),
      body: JSON.stringify({ user_id: mxid }),
    });
    if (!resp.ok) {
      console.error(`[matrix] adminJoinRoom ${mxid} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[matrix] adminJoinRoom ${mxid} 失败:`, err);
    return false;
  }
}
