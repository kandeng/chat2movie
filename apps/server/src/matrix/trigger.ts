import { mkdir, readFile } from "@toonflow/file";
import { basename, dirname, join, resolve } from "node:path";
import * as sdk from "matrix-js-sdk";
import conf from "@/utils/conf";
import { generateMedia } from "@/utils/media/generation";
import { getChatToVideoSettings } from "./settings";

// ACT: 视频触发器——把「房间里的讨论」转成一次 generateMedia("video") 调用，
// 生成结果上传到 Synapse 媒体库，再以 m.video 消息回帖到房间。
// 这是 Task 3（机器人）与 Task 4（调度器）共用的执行内核，二者只负责“何时触发”。

export interface VideoTrigger {
  // 为指定房间生成并回贴一段视频；prompt 省略时从近期讨论自动提炼。
  trigger(roomId: string, prompt?: string, signal?: AbortSignal): Promise<void>;
}

// 把 roomId 归一化成安全的目录名（Matrix roomId 含 ! : 等非法字符）。
function sanitizeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "room";
}

// 服务器工作区根目录（与 resolveWorkspace 的口径一致：<dataDir>/workspaces）。
function workspacesRoot(): string {
  return resolve(dirname(conf.path), "workspaces");
}

// 从房间实时时间线收集近期“人类讨论”，排除机器人自身消息与指令消息。
function collectDiscussion(client: sdk.MatrixClient, roomId: string, botUserId: string, command: string, limit: number): string[] {
  const room = client.getRoom(roomId);
  if (!room) return [];
  const events = room.getLiveTimeline().getEvents();
  const lines: string[] = [];
  for (const event of events) {
    if (event.getType() !== "m.room.message") continue;
    const sender = event.getSender();
    if (!sender || sender === botUserId) continue;
    const content = event.getContent<{ msgtype?: string; body?: string }>() ?? {};
    if (content.msgtype !== "m.text") continue;
    const body = (content.body ?? "").trim();
    if (!body) continue;
    // ACT: 指令消息（如 !video）不算讨论内容，避免把触发词喂进提示词。
    if (body.toLowerCase().startsWith(command.toLowerCase())) continue;
    const name = room.getMember(sender)?.name ?? sender;
    lines.push(`${name}: ${body}`);
  }
  return lines.slice(-limit);
}

// 依据讨论拼装视频生成提示词；无讨论时回退到通用提示。
function buildPrompt(discussion: string[]): string {
  if (!discussion.length) return "根据本次群聊生成一段简洁的示意视频。";
  return [
    "请根据以下群聊讨论，提炼其中的画面、情节与风格要求，生成一段连贯的视频：",
    ...discussion,
  ].join("\n");
}

export function createVideoTrigger(client: sdk.MatrixClient, botUserId: string): VideoTrigger {
  return {
    async trigger(roomId, prompt, signal) {
      const settings = getChatToVideoSettings();
      const discussion = collectDiscussion(client, roomId, botUserId, settings.command, settings.recentMessageLimit);
      const finalPrompt = prompt?.trim() ? prompt.trim() : buildPrompt(discussion);
      // ACT: 生成耗时较长，先在房间里回一条通知，避免用户以为机器人无响应。
      await client.sendNotice(roomId, "正在根据讨论生成视频，请稍候…").catch(() => {});
      const cwd = resolve(workspacesRoot(), "chat2video", sanitizeRoomId(roomId));
      try {
        await mkdir(cwd, { recursive: true });
        signal?.throwIfAborted();
        const files = await generateMedia(cwd, "video", {
          providerId: settings.providerId,
          modelId: settings.modelId,
          prompt: finalPrompt,
          outputDirectory: settings.outputDirectory,
        }, signal);
        const file = files[0];
        if (!file) throw new Error("供应商未返回可用的视频文件");
        const absolute = join(cwd, file.path);
        const bytes = await readFile(absolute, { signal });
        if (!bytes.length) throw new Error("生成的视频文件为空");
        const filename = basename(file.path);
        signal?.throwIfAborted();
        const uploaded = await client.uploadContent(bytes, { name: filename, type: file.mimeType });
        // ACT: 视频是 msgtype=m.video 的 m.room.message 事件（并非独立事件类型）。
        await client.sendEvent(roomId, sdk.EventType.RoomMessage, {
          msgtype: sdk.MsgType.Video,
          body: filename,
          filename,
          url: uploaded.content_uri,
          info: { mimetype: file.mimeType, size: bytes.length },
        });
        await client.sendNotice(roomId, "视频已生成完成。").catch(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[matrix] 视频生成失败:", err);
        await client.sendNotice(roomId, `视频生成失败：${message}`).catch(() => {});
      }
    },
  };
}
