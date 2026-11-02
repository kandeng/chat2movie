import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { getAuth } from "@/utils/auth";

// ACT: 对应 drone-navigation-v2 的 /api/directory/users：返回本地账号目录（昵称 / 隐藏 mxid / 头像），
// 供聊天层「找人」使用。头像与昵称即账号资料，mxid 对普通用户不可见，仅用于发起会话。
type UserRow = { id: string; name?: string; image?: string | null; mxid?: string | null };

export default Router().get("/", async (_req, res) => {
  const ctx = await getAuth().$context;
  const users = await ctx.adapter.findMany<UserRow>({ model: "user" });
  res.json(success(users.map(user => ({
    name: user.name ?? "",
    mxid: user.mxid ?? "",
    image: user.image ?? "",
  }))));
});
