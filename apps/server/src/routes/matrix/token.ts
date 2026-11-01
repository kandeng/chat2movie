import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { getSynapseConfig } from "@/utils/appConfig";
import { brokerToken, isConfigured } from "@/utils/matrix/admin";

// ACT: 原型阶段的 Matrix 凭据代签路由，尚无网站登录态，仅在本机运行。
// 通过 ?user=<localpart|mxid> 指定要为哪个演示账号代签令牌，默认 host。
// 生产化时应改为按登录用户代签（参考 drone-navigation-v2 的 GET /api/matrix/token）。
function toMxid(user: string, serverName: string): string {
  if (user.startsWith("@")) return user.includes(":") ? user : `${user}:${serverName}`;
  return `@${user}:${serverName}`;
}

export default Router().get("/", validateFields({ user: z.string().regex(/^@?[a-z0-9._=+\-/]+(?::[a-z0-9.\-]+)?$/i).optional() }, "query"), async (req, res) => {
  if (!isConfigured()) return res.status(503).json(error("未配置 Synapse，请先在 config.json 的 synapse 块填写 baseUrl 与 adminAccessToken", null, 503));
  const synapse = getSynapseConfig();
  const mxid = toMxid((req.query.user as string | undefined) ?? "host", synapse.serverName ?? "localhost");
  const creds = await brokerToken(mxid);
  if (!creds) return res.status(502).json(error("无法从 Synapse 代签令牌，请确认该账号已由 provision 脚本创建且 Synapse 可用", null, 502));
  res.set("Cache-Control", "no-store").json(success({
    ...creds,
    server_name: synapse.serverName,
    base_url: synapse.baseUrl,
    room_id: synapse.roomId || undefined,
  }));
});
