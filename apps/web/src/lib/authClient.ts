import { createAuthClient } from "better-auth/vue";

// ACT: better-auth 前端客户端（计划 Task 4）。baseURL 用同源 window.location.origin：
// 开发期 Vite 把 /api 代理到 :3000、生产由 Caddy 承担，会话是 HttpOnly Cookie，同源请求自动携带。
// 只声明核心方法（signIn/signUp/getSession/signOut/updateUser）；邮箱验证码等插件端点统一走 authClient.$fetch，
// 避免跨 workspace 无法推断服务端类型时的编译问题。
export const authClient = createAuthClient({
  baseURL: window.location.origin,
});
