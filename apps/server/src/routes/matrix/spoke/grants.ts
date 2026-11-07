import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveRequestMxid } from "@/utils/matrix/requestUser";
import { listRoomSpokes } from "@/matrix/spoke";
import { loadRoomGrants, setRoomGrant, type RoomGrants } from "@/matrix/grants";

// ACT: 计划 Task 13 —— 每用户授权（consent）。用户在房间里明确同意后，服务器侧编排器（customer_service）
// 才能「驱动」其辐条（在设备上执行画布/节点调用）与「调用」其防火墙内的本地模型。授权按 (room, user) 记账，
// 落盘在房间工作区 grants.json；能力注册（deviceId、localModel 可达性）按设备记录在辐条上。
//
// 安全口径：授权路由用网站会话（better-auth cookie）解析本人 mxid，用户只能设置/查询「自己」的授权，
// 无法代他人授权；未登录返回 401。

// GET：返回房间授权表 + 当前用户自己的授权 + 房间内活跃辐条（含所属用户与设备能力），
// 供浏览器渲染同意开关与设备/授权概览。
export default Router().get("/", validateFields({ room: z.string().min(1).max(256) }, "query"), async (req, res) => {
  assertAppRequest(req);
  const mxid = await resolveRequestMxid(req);
  if (!mxid) {
    res.status(401).json(error("请先登录网站账号", null, 401));
    return;
  }
  const room = req.query.room as string;
  const grants: RoomGrants = await loadRoomGrants(room);
  const spokes = listRoomSpokes(room).map(spoke => ({
    id: spoke.id,
    userId: spoke.userId ?? "",
    deviceId: typeof spoke.capabilities.deviceId === "string" ? spoke.capabilities.deviceId : "",
    localModel: spoke.capabilities.localModel === true,
    hasCanvas: spoke.hasCanvas,
  }));
  res.json(success({ userId: mxid, mine: grants[mxid] ?? null, grants, spokes }));
})
// POST：设置（或更新）当前用户在本房间的授权。两个布尔位分别对应「允许驱动我的设备」与「允许调用我的本地模型」。
.post("/", validateFields({
  room: z.string().min(1).max(256),
  driveSpokes: z.boolean(),
  invokeLocalModels: z.boolean(),
}), async (req, res) => {
  assertAppRequest(req);
  const mxid = await resolveRequestMxid(req);
  if (!mxid) {
    res.status(401).json(error("请先登录网站账号", null, 401));
    return;
  }
  const { room, driveSpokes, invokeLocalModels } = req.body as { room: string; driveSpokes: boolean; invokeLocalModels: boolean };
  const grant = await setRoomGrant(room, mxid, { driveSpokes, invokeLocalModels });
  res.json(success({ userId: mxid, grant }));
});
