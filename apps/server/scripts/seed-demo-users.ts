import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { getSynapseConfig } from "@/utils/appConfig";
import { getAuth, initializeAuth } from "@/utils/auth";

// ACT: 演示账号播种脚本（幂等）。为本地账号系统创建 host / friend1 / friend2 三个演示账号，
// 并把它们的隐藏影子身份指回 provision-matrix.ts 已经建好的 @host / @friend1 / @friend2，
// 同时标记邮箱已验证，使演示账号可以直接用固定口令登录（跳过邮箱激活码流程）。
// 运行： bun run --cwd apps/server scripts/seed-demo-users.ts
// 前置： data/auth.db 已由服务启动或本脚本的 initializeAuth() 建表。

// ACT: 与 provision-matrix.ts 保持一致的演示口令；可用环境变量覆盖。
const DEMO_LOCALPARTS = ["host", "friend1", "friend2"] as const;
const DEMO_PASSWORD = process.env.VIDSAY_DEMO_PASSWORD || "vidsay";
const DEMO_EMAIL_DOMAIN = process.env.VIDSAY_DEMO_EMAIL_DOMAIN || "example.com";

// ACT: 解析到仓库根 data/auth.db —— 与 provision-matrix.ts 一致，scripts/ 到根为三级（../../../）。
function authDbPath(): string {
  const dir = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../data");
  return resolve(dir, "auth.db");
}

async function main() {
  await initializeAuth(); // ACT: 幂等建表，保证首次播种时 user/account 等表已存在。
  const auth = getAuth();
  const serverName = getSynapseConfig().serverName || "localhost";
  const db = new Database(authDbPath());
  const findByEmail = db.query("SELECT id FROM user WHERE email = ?");
  // ACT: 关键——把影子账号指回 provision-matrix 已创建的 @host/@friend1/@friend2，并标记邮箱已验证；
  // 注册钩子铸造的 @u_<hex> 孤儿账号在此被覆盖，可忽略（best-effort，Synapse 不可用时不影响播种）。
  const link = db.query("UPDATE user SET mxid = ?, emailVerified = 1, name = ? WHERE email = ?");

  console.log(`[seed] Synapse server_name=${serverName}，演示口令=${DEMO_PASSWORD}`);
  for (const localpart of DEMO_LOCALPARTS) {
    const email = `${localpart}@${DEMO_EMAIL_DOMAIN}`;
    const mxid = `@${localpart}:${serverName}`;
    if (!findByEmail.get(email)) {
      // ACT: 用 better-auth 建号以复用其口令哈希与 account 关联行；随后再用 SQL 修正 mxid/验证态。
      await auth.api.signUpEmail({ body: { email, password: DEMO_PASSWORD, name: localpart } });
      console.log(`[seed] ✓ 新建本地账号 ${email}`);
    } else {
      console.log(`[seed] · 已存在 ${email}（跳过建号）`);
    }
    link.run(mxid, localpart, email);
    console.log(`[seed] ✓ ${email} -> ${mxid}（emailVerified=1）`);
  }
  db.close();

  console.log("\n[seed] 完成。演示账号（邮箱 / 口令）：");
  for (const localpart of DEMO_LOCALPARTS) {
    console.log(`  ${localpart}@${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
  }
}

await main();
