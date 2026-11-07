import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveRequestMxid } from "@/utils/matrix/requestUser";
import { connectSpoke } from "@/matrix/spoke";

// ACT: 房间辐条的 SSE 事件流（计划 Task 9）。每台设备的工作室标签页带一个稳定的 spokeId 接入，
// 同一房间可多辐条并存（手机/平板/电脑）；同 spokeId 重连则顶替自己旧连接。
// 用 fetch 流式读取（需带 x-toonflow-workspace 头，故不能用 EventSource），服务器经此把 customer_service 产生的画布调用推给辐条。
// ACT: 计划 Task 13 —— 从网站会话解析本人 mxid 并绑定到辐条，供授权门控（未登录则身份为空，默认不可被驱动）。
export default Router().get("/", validateFields({ room: z.string().min(1).max(256), spokeId: z.string().min(1).max(64) }, "query"), async (req, res) => {
  assertAppRequest(req);
  const userId = await resolveRequestMxid(req);
  connectSpoke(req.query.room as string, req.query.spokeId as string, res, {}, userId || undefined);
});
