import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listRoomSpokes } from "@/matrix/spoke";
import { loadRoomGrants } from "@/matrix/grants";

// ACT: 计划 Task 13 —— 房间编排器（customer_service）的设备与授权视图工具。
// 授权按用户记账、能力按设备注册：本工具让编排器在调度前看清「房间里有哪些设备、各属于哪个用户、
// 每个用户是否已授权驱动其设备（driveSpokes）与调用其本地模型（invokeLocalModels）、哪些设备具备本地模型能力」。
// 编排器据此只把画布/节点任务派给已授权驱动的用户设备，只把需要防火墙内本地模型的任务派给
// 既授权 invokeLocalModels、又上报了 localModel 能力的设备；未授权的能力对编排器不可见（默认拒绝）。

export function createSpokeConsentTools(roomId: string): ToolDefinition[] {
  const listParameters = z.strictObject({});

  const list: ToolDefinition = {
    name: "listRoomDevices", label: "查看房间设备与授权",
    description: "列出当前房间内所有活跃设备（辐条）及其授权状态：每台设备含所属用户（mxid）、Matrix 设备 id、是否有可用画布、是否具备本地模型能力（localModel），并汇总每个用户是否已授权「驱动设备」（driveSpokes）与「调用本地模型」（invokeLocalModels）。在把画布/节点任务派给某台设备、或调度防火墙内本地模型前，先用它确认目标用户已授权、目标设备具备相应能力；未授权的用户设备不可驱动，未授权或未上报 localModel 的设备不能用于本地模型任务。",
    promptGuidelines: [
      "需要驱动用户画布或调度本地模型前，先用 listRoomDevices 确认目标用户已授权（driveSpokes / invokeLocalModels）且设备在线、具备能力；未授权时应提示用户在画布「协作授权」中开启相应同意开关，而不是强行调度。",
    ],
    parameters: z.toJSONSchema(listParameters), executionMode: "sequential",
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      const grants = await loadRoomGrants(roomId);
      const devices = listRoomSpokes(roomId).map(spoke => {
        const userId = spoke.userId ?? "";
        const grant = userId ? grants[userId] : undefined;
        return {
          spokeId: spoke.id,
          userId,
          deviceId: typeof spoke.capabilities.deviceId === "string" ? spoke.capabilities.deviceId : "",
          hasCanvas: spoke.hasCanvas,
          localModel: spoke.capabilities.localModel === true,
          driveSpokes: grant?.driveSpokes === true,
          invokeLocalModels: grant?.invokeLocalModels === true,
        };
      });
      return {
        content: [{ type: "text", text: devices.length ? JSON.stringify(devices, null, 2) : "当前房间内没有在线设备（辐条）。" }],
        details: { count: devices.length },
      };
    },
  };

  return [list];
}
