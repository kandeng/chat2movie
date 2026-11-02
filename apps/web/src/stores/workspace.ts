import { defineStore } from "pinia";
import { ref } from "vue";
import axios from "axios";
import type { AgentAttachment } from "@/components/agent/types";

export type Project = {
  directory: string;
  name: string;
  lastOpenedAt: number;
  // ACT: 归属的工作室账号（Matrix 用户 ID）；服务端按用户隔离目录在后续任务实现，这里先落地归属关系。
  ownerId?: string;
};

// 群聊主持人点「自动生成视频 / 分步生成视频」带过来的生成意图。
export type PipelineIntent = {
  mode: "auto" | "step";
  roomId: string;
  ownerId: string;
  createdAt: number;
};

export const useWorkspaceStore = defineStore("workspace", () => {
  const project = ref<Project | null>(null);
  const projectList = ref<Project[]>([]);
  const projectLoading = ref(false);
  const projectLoadingDrawn = ref(false);
  const projectLoadingVisible = ref(false);
  const pendingAgentMessage = ref<{ directory: string; prompt: string; attachments?: AgentAttachment[]; model: string; reasoningEffort: string } | null>(null);
  // ACT: 计划 Task 4 —— 由群聊跳转带入的生成意图；真正的流水线接入后由它驱动，消费完可清空。
  const pipeline = ref<PipelineIntent | null>(null);

  async function addProject(path: string, name?: string, signal?: AbortSignal, previousDirectory = path) {
    const { data } = await axios.get<{ code: number; data?: { directory: string }; message?: string }>("/api/workspaces/check", {
      params: { directory: path }, headers: { "x-toonflow-workspace": "1" }, signal,
    });
    signal?.throwIfAborted();
    if (data.code !== 200 || !data.data?.directory) throw new Error(data.message || "工作目录校验失败");
    const checkedDirectory = data.data.directory;
    const existing = projectList.value.find(project => project.directory === previousDirectory)
      ?? projectList.value.find(project => project.directory === checkedDirectory);
    const added = { directory: checkedDirectory, name: name?.trim() || existing?.name || checkedDirectory.split(/[\\/]/).filter(Boolean).at(-1) || checkedDirectory, lastOpenedAt: Date.now() };
    projectList.value = [
      added,
      ...projectList.value.filter(item => item.directory !== previousDirectory && item.directory !== checkedDirectory),
    ];
    return added;
  }

  async function openProject(path: string, previousDirectory = path, signal?: AbortSignal) {
    project.value = await addProject(path, undefined, signal, previousDirectory);
    pendingAgentMessage.value = null;
  }

  function renameProject(path: string, name: string) {
    const target = projectList.value.find(item => item.directory === path);
    if (!target || !name.trim()) return;
    target.name = name.trim();
    if (project.value?.directory === path) project.value = target;
  }

  function removeProject(path: string) {
    projectList.value = projectList.value.filter(item => item.directory !== path);
    if (project.value?.directory === path) project.value = null;
  }

  // 记录项目归属账号（已归属同一账号时不做任何事，避免无谓的持久化写入）。
  function markProjectOwner(path: string, ownerId: string) {
    if (!ownerId) return;
    for (const item of projectList.value) {
      if (item.directory === path && item.ownerId !== ownerId) {
        item.ownerId = ownerId;
        if (project.value?.directory === path) project.value = item;
      }
    }
  }

  function setPipeline(intent: PipelineIntent | null) {
    pipeline.value = intent;
  }

  return {
    project, projectList, projectLoading, projectLoadingDrawn, projectLoadingVisible, pendingAgentMessage, pipeline,
    addProject, openProject, renameProject, removeProject, markProjectOwner, setPipeline,
  };
}, {
  persist: {
    key: "toonflow.projectList",
    pick: ["project", "projectList", "pipeline"],
  },
});
