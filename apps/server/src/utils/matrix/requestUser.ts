import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "@/utils/auth";

// ACT: 计划 Task 13 —— 从请求的网站会话（better-auth cookie）解析当前用户的 Matrix 身份（mxid）。
// 辐条与授权路由据此把连接/授权绑定到「经过服务器校验的用户」，而不是客户端自报的 userId，
// 避免越权：授权按用户记账，只有本人会话才能设置/查询自己的授权，辐条也只能被绑定到本人 mxid。
// 未登录或缺少 Matrix 影子账号时返回空串，调用方据此降级（默认拒绝）。
export async function resolveRequestMxid(req: Request): Promise<string> {
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session) return "";
  const user = session.user as { mxid?: string | null };
  return typeof user.mxid === "string" ? user.mxid : "";
}
