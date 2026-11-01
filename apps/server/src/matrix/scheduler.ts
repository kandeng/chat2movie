import type { ChatToVideoSchedule } from "./settings";
import type { VideoTrigger } from "./trigger";

// ACT: Task 4 的调度器“接口占位”。原型阶段仅支持手动触发（房间指令或面板按钮），
// 定时生成（每天固定时间自动出片）留待后续实现；这里保留稳定的启停接口与配置形状，
// 使 bot.ts 的接线方式在未来接入真实定时器时无需改动。

export type ScheduleConfig = ChatToVideoSchedule & { roomId?: string };

// 启动调度器，返回停止函数。当前为空实现（不调度任何任务）。
export function startScheduler(_trigger: VideoTrigger, _config: ScheduleConfig): () => void {
  // ACT: 定时生成尚未实现——手动触发已覆盖原型需求，故此处直接返回空的停止函数占位。
  return () => {};
}
