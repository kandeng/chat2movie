import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { getAuthConfig } from "@/utils/appConfig";

// ACT: 向前端暴露账号系统的能力开关：Google 登录入口仅在 config.json 配好凭据时显示
// （drone 的 OAuth 路由是「配置了才注册」，这里等价地做成前端可见性开关）。
export default Router().get("/", (_req, res) => {
  const config = getAuthConfig();
  res.json(success({
    googleEnabled: Boolean(config.google?.clientId && config.google?.clientSecret),
  }));
});
