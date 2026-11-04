import { resolve } from "node:path";
import { createApp } from "./app";
// ACT: 应用版本号改为读取仓库根 package.json（可用 TOONFLOW_APP_VERSION 覆盖），不再依赖已移除的 electrobun 配置。
import rootPackage from "../../../package.json";

const startTime = Date.now();
const realPort = Number(process.env.TOONFLOW_SERVER_PORT || 3000);
if (!Number.isInteger(realPort) || realPort < 1 || realPort > 65535) throw new Error("TOONFLOW_SERVER_PORT 必须是 1–65535 之间的整数");
// 源码位于 apps/server/src，生产构建位于 build/server，均从文件位置定位根目录。
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  appVersion: process.env.TOONFLOW_APP_VERSION || rootPackage.version,
  dataDirectory,
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: 暂不安装内置团队，随团队打包一同恢复。
  // agentsRoot: resolve(appDirectory, "build/agents"),
  providersRoot: resolve(appDirectory, fromSource ? "packages/providers/src" : "build/providers"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
});
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
app.listen(realPort, async (error?: Error) => {
  if (error) throw error;
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  // ACT: 聊天转视频机器人（Task 3）随主服务启动；未配置 Synapse 或未启用时内部静默降级，不阻塞监听。
  const { startMatrixBot } = await import("./matrix/bot");
  await startMatrixBot().catch(botError => console.warn("启动聊天转视频机器人失败：", botError));
  // ACT: 顺手把 AI 客服的身份（显示名 + 头像）同步到 Synapse，新建群聊时它才能以正确形象入群。
  // 内部全部降级、不抛错，用 fire-and-forget 以免 Synapse 慢响应拖住启动日志。
  const { ensureAgentIdentity } = await import("./matrix/agent");
  void ensureAgentIdentity().catch(agentError => console.warn("初始化 AI 客服身份失败：", agentError));
  console.log(`[服务启动成功]: http://localhost:${realPort}`);
  console.log(`[启动耗时]: ${(Date.now() - startTime).toFixed(2)}ms`);
});
