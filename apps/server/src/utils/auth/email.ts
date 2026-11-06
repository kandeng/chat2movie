import nodemailer from "nodemailer";
import { getAuthConfig } from "@/utils/appConfig";

// ACT: 认证邮件通道（对应 drone-navigation-v2 的注册激活码 / 重置密码邮件）。
// SMTP 未配置时降级为控制台打印——本地开发无邮箱也能走通全流程；
// 已配置时用 nodemailer 真实发信。发送失败不抛出给注册/重置主流程之外，由调用方决定是否吞掉。

export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

// 发送一封纯文本认证邮件；SMTP 缺省时打印到服务端日志（dev 降级）。
export async function sendAuthEmail(to: string, subject: string, text: string): Promise<void> {
  const smtp = getAuthConfig().smtp;
  if (!smtp?.host) {
    console.log(`[auth] 未配置 SMTP，邮件内容转投控制台 -> to=${to} subject=${subject}\n${text}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port ?? 465,
    secure: smtp.secure ?? (smtp.port ?? 465) === 465,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transporter.sendMail({ from: smtp.from || smtp.user, to, subject, text });
}

// ACT: 6 位验证码邮件文案；验证码 10 分钟内有效、60 秒重发冷却（对齐 drone verification.py 的
// CODE_TTL / RESEND_COOLDOWN，由 emailOTP 插件的 expiresIn / rateLimit 落实）。
export async function sendOtpEmail(email: string, otp: string, type: OtpType): Promise<void> {
  const purpose =
    type === "email-verification" ? "注册邮箱验证"
    : type === "forget-password" ? "重置密码"
    : type === "change-email" ? "更换邮箱"
    : "登录";
  await sendAuthEmail(
    email,
    `【vidsay】${purpose}验证码`,
    `您的${purpose}验证码是：${otp}\n\n验证码 10 分钟内有效。如非本人操作，请忽略本邮件。`,
  );
}
