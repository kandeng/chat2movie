import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSynapseConfig } from "@/utils/appConfig";
import { createRoom, ensureUser, inviteToRoom, isConfigured, joinRoomAs, roomCreator } from "@/utils/matrix/admin";

// ACT: 一次性初始化脚本（原型用）。创建隐藏账号、建群、把机器人和演示用户拉进房间，
// 并把 roomId 回写到 config.json 的 synapse 块。可重复运行（幂等）。
// 运行： bun run --cwd apps/server scripts/provision-matrix.ts

// 原型固定账号：主持人 host、两个朋友 friend1/friend2，机器人取自 config.botUserId。
const DEMO_LOCALPARTS = ["host", "friend1", "friend2"] as const;
// ACT: 计划 Task 2 改为「网站直接用密码登录 Matrix」，所以演示账号必须使用可预期的密码；
// 机器人仍是隐藏账号，保持随机密码（它通过 Admin 代签令牌登录，不需要密码）。
const DEMO_PASSWORD = process.env.CHAT2MOVIE_DEMO_PASSWORD || "chat2movie";

const configPath = process.env.TOONFLOW_CONFIG_FILE ?? resolve(import.meta.dirname, "../../../config.json");

function writeRoomIdToConfig(roomId: string) {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as { synapse?: Record<string, unknown> };
  raw.synapse = { ...(raw.synapse ?? {}), roomId };
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function main() {
  if (!isConfigured()) {
    console.error("未配置 Synapse，请先在 config.json 的 synapse 块填写 baseUrl 与 adminAccessToken。");
    process.exit(1);
  }
  const synapse = getSynapseConfig();
  const serverName = synapse.serverName || "localhost";
  const botMxid = synapse.botUserId || `@chat2movie_bot:${serverName}`;

  console.log(`[provision] Synapse: ${synapse.baseUrl} (server_name=${serverName})`);

  // 1. 创建机器人 + 演示用户（幂等）
  const members: { mxid: string; label: string }[] = [{ mxid: botMxid, label: "bot 机器人" }];
  const okBot = await ensureUser(botMxid, { displayName: "Chat2Movie Bot" });
  console.log(`[provision] ${okBot ? "✓" : "✗"} ${botMxid} (bot)`);
  for (const localpart of DEMO_LOCALPARTS) {
    const mxid = `@${localpart}:${serverName}`;
    // ACT: 每次运行都会把演示账号密码重置为 DEMO_PASSWORD，保证登录口令可预期（幂等）。
    const ok = await ensureUser(mxid, { displayName: localpart, password: DEMO_PASSWORD });
    members.push({ mxid, label: localpart });
    console.log(`[provision] ${ok ? "✓" : "✗"} ${mxid}`);
  }

  // 2. 复用已配置的房间，否则新建一个
  // ACT: 演示房间必须由 host 创建 —— 前端把「主持人」定义为 m.room.create 的发送者，
  // 只有主持人能看到「自动生成视频 / 分步生成视频」入口；用管理员令牌建的房会让 host 永远看不到。
  const hostMxid = `@${DEMO_LOCALPARTS[0]}:${serverName}`;
  let roomId = synapse.roomId;
  if (roomId) {
    const creator = await roomCreator(roomId);
    if (creator && creator !== hostMxid) {
      console.log(`[provision] 已配置房间 ${roomId} 的创建者是 ${creator}，重新以 ${hostMxid} 建一个演示房间`);
      roomId = "";
    } else {
      console.log(`[provision] 复用已配置房间 ${roomId}`);
    }
  }
  if (!roomId) {
    // ACT: 建房时就把其他成员列为邀请对象，下一步再让他们本人接受。
    const created = await createRoom("Chat2Movie 原型房间", hostMxid, members.map(member => member.mxid).filter(mxid => mxid !== hostMxid));
    if (!created) {
      console.error("[provision] 创建房间失败，请检查管理员令牌与 Synapse 状态。");
      process.exit(1);
    }
    roomId = created;
    writeRoomIdToConfig(roomId);
    console.log(`[provision] ✓ 已由 ${hostMxid} 创建房间 ${roomId} 并回写到 config.json`);
  }

  // 3. 把其他成员拉进房间：先由 host 发邀请，再代签各自令牌接受邀请（全程幂等）。
  // ACT: 不再用 Admin 强制拉人——私有房间里那个接口需要管理员本人在房内，而房间现在由 host 创建。
  for (const member of members) {
    if (member.mxid === hostMxid) {
      console.log(`[provision] ✓ 已在房内（创建者）${member.mxid}`);
      continue;
    }
    await inviteToRoom(hostMxid, roomId, member.mxid);
    const joined = await joinRoomAs(member.mxid, roomId);
    console.log(`[provision] ${joined ? "✓ 加入" : "✗ 加入失败"} ${member.mxid} -> ${roomId}`);
  }

  console.log("\n[provision] 完成。摘要：");
  console.log(`  roomId   = ${roomId}`);
  console.log(`  bot      = ${botMxid}`);
  console.log(`  members  = ${members.map(member => member.mxid).join(", ")}`);
  console.log(`  password = ${DEMO_PASSWORD}（host/friend1/friend2 通用，可用 CHAT2MOVIE_DEMO_PASSWORD 覆盖）`);
  console.log("\n下一步：打开 http://127.0.0.1:5173/#/account 用 host / 上述密码登录，再进入群聊。");
}

await main();
