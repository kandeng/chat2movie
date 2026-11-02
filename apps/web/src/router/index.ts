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
      // ACT: 聊天转视频原型的群聊页面（单一演示房间，身份固定为 host，无网站登录态）。
      path: "/chat",
      component: () => import("@/pages/chat/index.vue"),
      meta: { shell: true },
    },
    {
      // ACT: 账户页：登录/个人资料与退出登录；登录守卫也会把未登录用户送到这里并自动弹登录框。
      path: "/account",
      component: () => import("@/pages/account/index.vue"),
      meta: { shell: true },
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      // ACT: 我的工作室需要先登录（计划 Task 4）；requiresAuth 由下面的全局守卫处理。
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
      meta: { shell: true, requiresAuth: true },
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
