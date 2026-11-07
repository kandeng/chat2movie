import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { useAuthStore } from "@/stores/auth";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
      meta: { shell: true },
    },
    {
      // ACT: 合并页的 one-shot 视图（群聊 + 视频舞台）。与 /studio 共用同一个房间时间线聊天框，
      // 仅视图模式不同；meta.mode 供页面/切换器读取（计划 Task 4）。
      path: "/chat",
      component: () => import("@/pages/chat/index.vue"),
      meta: { shell: true, mode: "one-shot" },
    },
    {
      // ACT: 账户页：登录/个人资料与退出登录；登录守卫也会把未登录用户送到这里并自动弹登录框。
      path: "/account",
      component: () => import("@/pages/account/index.vue"),
      meta: { shell: true },
    },
    {
      // ACT: 设置整页（对齐群聊页布局）：左侧加深菜单栏 + 右侧主设置区，取代原弹窗。
      path: "/settings",
      component: () => import("@/pages/settings/index.vue"),
      meta: { shell: true },
    },
    {
      // ACT: 旧路径重定向到规范的 /studio，用函数式 redirect 保留 query（mode/room），
      // 使既有的 ?mode=auto|step&room= 深链在合并后仍然生效（计划 Task 4）。
      path: "/canvas",
      redirect: to => ({ path: "/studio", query: to.query }),
    },
    {
      path: "/workspace",
      redirect: to => ({ path: "/studio", query: to.query }),
    },
    {
      // ACT: 合并页的 step-by-step 视图（画布 + 文档 + 房间时间线聊天框），需要先登录；
      // requiresAuth 由下面的全局守卫处理，meta.mode 供页面/切换器读取。
      path: "/studio",
      component: () => import("@/pages/workspace/index.vue"),
      meta: { shell: true, requiresAuth: true, mode: "step-by-step" },
    },
  ],
});

// ACT: 需要登录的路由统一守卫：先恢复持久化会话，仍未登录则跳账户页并带上回跳地址与 login=1。
router.beforeEach(async to => {
  if (to.meta.requiresAuth !== true) return true;
  const auth = useAuthStore();
  if (!auth.restored) await auth.restore();
  if (auth.signedIn) return true;
  return { path: "/account", query: { login: "1", redirect: to.fullPath } };
});

export default router;
