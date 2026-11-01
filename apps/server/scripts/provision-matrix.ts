import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSynapseConfig } from "@/utils/appConfig";
import { adminJoinRoom, createRoom, ensureUser, isConfigured } from "@/utils/matrix/admin";

// ACT: 一次性初始化脚本（原型用）。创建隐藏账号、建群、把机器人和演示用户拉进房间，
// 并把 roomId 回写到 config.json 的 synapse 块。可重复运行（幂等）。
// 运行： bun run --cwd apps/server scripts/provision-matrix.ts

// 原型固定账号：主持人 host、两个朋友 friend1/friend2，机器人取自 config.botUserId。
const DEMO_LOCALPARTS = ["host", "friend1", "friend2"] as const;

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
    const ok = await ensureUser(mxid, { displayName: localpart });
    members.push({ mxid, label: localpart });
    console.log(`[provision] ${ok ? "✓" : "✗"} ${mxid}`);
  }

  // 2. 复用已配置的房间，否则新建一个
  let roomId = synapse.roomId;
  if (!roomId) {
    const created = await createRoom("Chat2Movie 原型房间");
    if (!created) {
      console.error("[provision] 创建房间失败，请检查管理员令牌与 Synapse 状态。");
      process.exit(1);
    }
    roomId = created;
    writeRoomIdToConfig(roomId);
    console.log(`[provision] ✓ 已创建房间 ${roomId} 并回写到 config.json`);
  } else {
    console.log(`[provision] 复用已配置房间 ${roomId}`);
  }

  // 3. 管理员强制把所有成员拉进房间（免手动接受邀请）
  for (const member of members) {
    const joined = await adminJoinRoom(roomId, member.mxid);
    console.log(`[provision] ${joined ? "✓ 加入" : "✗ 加入失败"} ${member.mxid} -> ${roomId}`);
  }

  console.log("\n[provision] 完成。摘要：");
  console.log(`  roomId   = ${roomId}`);
  console.log(`  bot      = ${botMxid}`);
  console.log(`  members  = ${members.map(member => member.mxid).join(", ")}`);
  console.log(`\n下一步：测试代签令牌  curl -s "http://127.0.0.1:3000/api/matrix/token?user=host"`);
}

await main();
