import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
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
      // ACT: 账户页占位；登录与个人资料在后续任务接入。
      path: "/account",
      component: () => import("@/pages/account/index.vue"),
      meta: { shell: true },
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
      meta: { shell: true },
    },
  ],
});
export default router;
