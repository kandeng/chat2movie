import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { getAuthConfig, getSynapseConfig } from "@/utils/appConfig";
import { ensureUser, syncMatrixProfile } from "@/utils/matrix/admin";
import { sendOtpEmail } from "./email";

// ACT: 本地账号系统（按 drone-navigation-v2 的 FastAPI+fastapi-users 方案移植，改用 better-auth 实现）。
// 与 drone 对齐的设计原则：
// - 网站账号是主身份（邮箱+密码 / Google OAuth），存 data/auth.db（bun:sqlite，后续可切 Postgres）；
// - 注册即发放隐藏 Matrix 影子账号 @u_<12hex>:server（drone 的 on_after_register -> ensure_matrix_user），
//   客户端凭据由 /api/matrix/token 用 Admin 傀儡令牌代签，用户永远看不到 Matrix 密码；
// - 邮箱激活码：6 位数字、10 分钟有效、60 秒重发冷却、库里只存哈希（drone verification.py 语义）；
// - Synapse 故障绝不能拖垮注册/登录，聊天相关动作全部 best-effort 降级。

function dataDirectory(): string {
  const dir = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ACT: 会话签名密钥：优先 config.json 的 auth.sessionSecret；缺省时生成随机值并持久化到
// data/auth-secret.key（0600），保证服务重启后既有会话仍有效——对应 drone 的 SECRET_KEY 职责。
function resolveSecret(): string {
  const configured = getAuthConfig().sessionSecret;
  if (configured) return configured;
  const file = resolve(dataDirectory(), "auth-secret.key");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* 首次运行，下面生成 */ }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// ACT: 惰性单例：首次调用时按当前 config.json 构建 better-auth 实例（进程内配置视为不变）。
// 用推断出的具体实例类型而非默认的 Auth 泛型，避免插件/options 带来的型变不兼容。
function createInstance() {
  const config = getAuthConfig();
  const synapse = getSynapseConfig();
  const googleEnabled = Boolean(config.google?.clientId && config.google?.clientSecret);
  return betterAuth({
    secret: resolveSecret(),
    // baseUrl 留空时 better-auth 按请求 Host 动态推导，Vite 代理（:5173 -> :3000）下也能工作。
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    trustedOrigins: [...(config.baseUrl ? [config.baseUrl] : []), "http://localhost:5173"],
    database: new Database(resolve(dataDirectory(), "auth.db")),
    user: {
      // ACT: mxid = 隐藏 Matrix 影子账号（drone models.MatrixAccount.mxid）；input:false 禁止客户端注入。
      additionalFields: { mxid: { type: "string", required: false, input: false } },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // 未激活的邮箱不能登录（drone requires_verification=True）
      autoSignIn: false,              // 注册成功后必须再登录一次
      minPasswordLength: 8,
    },
    ...(googleEnabled
      ? { socialProviders: { google: { clientId: config.google!.clientId!, clientSecret: config.google!.clientSecret! } } }
      : {}),
    account: {
      // ACT: 对齐 drone 的 associate_by_email——Google 登录可按同邮箱自动关联既有密码账号并自动视为已验证。
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,                              // drone：6 位数字验证码
        expiresIn: 600,                            // drone CODE_TTL_SECONDS = 10 分钟
        sendVerificationOnSignUp: true,            // 注册即发激活码（drone on_after_register -> issue code）
        overrideDefaultEmailVerification: true,    // 用验证码取代默认的链接式验证
        storeOTP: "hashed",                        // drone：库里只存 SHA-256 哈希
        rateLimit: { window: 60, max: 1 },         // drone RESEND_COOLDOWN_SECONDS = 60 秒
        sendVerificationOTP: async ({ email, otp, type }) => { await sendOtpEmail(email, otp, type); },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // ACT: 注册时铸造隐藏 mxid（drone matrix_admin.localpart_for = u_<uuid-hex 前 12 位>）。
          // 已带 mxid 的（演示账号播种脚本）保持原值。
          before: async (user) => {
            if (typeof user.mxid === "string" && user.mxid) return;
            const serverName = synapse.serverName || "localhost";
            const mxid = `@u_${randomBytes(6).toString("hex")}:${serverName}`;
            return { data: { ...user, mxid } };
          },
          // ACT: drone on_after_register -> ensure_matrix_user；best-effort，Synapse 不可用只降级聊天。
          after: async (user) => {
            const mxid = typeof user.mxid === "string" ? user.mxid : "";
            if (!mxid) return;
            void ensureUser(mxid, { displayName: typeof user.name === "string" ? user.name : undefined });
          },
        },
        update: {
          // ACT: 昵称/头像变更同步到 Matrix profile（对齐 drone PATCH /users/me 后的资料编辑行为）。
          // 必须 await：better-auth 在返回 updateUser 响应前会等待 after 钩子；若像旧代码那样 void 触发，
          // Matrix 头像上传还没完成客户端就已 refreshProfile 回读，导致头像永远慢一拍（保存 image_1 仍显示 image_0）。
          // syncMatrixProfile 内部吞掉所有异常只返回布尔值，await 它不会因 Synapse 故障拖垮资料更新。
          after: async (user) => {
            const mxid = typeof user.mxid === "string" ? user.mxid : "";
            if (!mxid) return;
            await syncMatrixProfile(
              mxid,
              typeof user.name === "string" ? user.name : undefined,
              typeof user.image === "string" ? user.image : undefined,
            );
          },
        },
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createInstance>;

let instance: AuthInstance | null = null;

export function getAuth(): AuthInstance {
  if (!instance) instance = createInstance();
  return instance;
}

// ACT: 启动时幂等建表（better-auth getMigrations + runMigrations），由 createApp 调用；
// 与 drone 的 alembic migration 对应，SQLite 文件即库，无需额外迁移工具。
export async function initializeAuth(): Promise<void> {
  const auth = getAuth();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
