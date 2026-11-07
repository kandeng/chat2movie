import { readdir } from "@toonflow/file";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isRoomAgentWorkspace, ORCHESTRATOR_STATE_FILES } from "@/matrix/agentWorkspace";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096).optional() }, "query"), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, (req.query.path as string | undefined) ?? "");
  const entries = await readdir(path, { withFileTypes: true });
  // ACT: 单画布 1:1:1 绑定（Task 6）——房间工作区根目录下的编排器私有状态文件
  // （workflow.json/grants.json）不在 Studio 文件树中展示，避免被用户查看/编辑/删除。
  const hideOrchestratorState = isRoomAgentWorkspace(directory);
  const visible = entries.filter(entry => entry.isFile() || entry.isDirectory()).map(entry => ({
    name: entry.name, path: relative(directory, join(path, entry.name)).split(sep).join("/"), type: entry.isDirectory() ? "directory" : "file",
  })).filter(entry => !(hideOrchestratorState && entry.type === "file" && !entry.path.includes("/") && ORCHESTRATOR_STATE_FILES.has(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  res.set("Cache-Control", "no-store").json(success({
    directory,
    empty: visible.length === 0,
    entries: visible,
  }));
});
