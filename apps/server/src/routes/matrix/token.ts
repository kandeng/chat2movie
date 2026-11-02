import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { error, success } from "@/lib/responseFormat";
import { getAuth } from "@/utils/auth";
import { brokerToken, ensureUser, isConfigured } from "@/utils/matrix/admin";

// ACT: 对应 drone-navigation-v2 的 /api/matrix/token：网站会话（better-auth cookie）校验通过后，
// 为当前用户的隐藏 Matrix 影子账号代签客户端凭据（Admin 傀儡令牌），用户永远看不到 Matrix 密码。
// Synapse 未配置时返回 503，前端仅聊天降级；未登录返回 401。
export default Router().post("/", async (req, res) => {
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    res.status(401).json(error("请先登录网站账号", null, 401));
    return;
  }
  if (!isConfigured()) {
    res.status(503).json(error("未配置 Synapse，无法代签 Matrix 令牌", null, 503));
    return;
  }
  const user = session.user as { name?: string; mxid?: string | null };
  const mxid = typeof user.mxid === "string" ? user.mxid : "";
  if (!mxid) {
    res.status(500).json(error("该账号缺少 Matrix 身份，请联系管理员", null, 500));
    return;
  }
  let creds = await brokerToken(mxid);
  if (!creds) {
    // ACT: 注册时 Synapse 可能不可用（影子账号缺失），这里补建一次再重试——对齐 drone 登录时的 ensure 行为。
    await ensureUser(mxid, { displayName: typeof user.name === "string" ? user.name : undefined });
    creds = await brokerToken(mxid);
  }
  if (!creds) {
    res.status(503).json(error("Synapse 暂时不可用，请稍后再试", null, 503));
    return;
  }
  res.json(success({ accessToken: creds.access_token, userId: creds.user_id, deviceId: creds.device_id }));
});
