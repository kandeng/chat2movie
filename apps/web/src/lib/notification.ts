import { generalSettings } from "@/stores/settings";

// ACT: 客户端（桌面/移动）已移除，通知仅使用浏览器原生 Notification API。
type NotificationOptions = { title: string; body?: string; silent?: boolean };

export function getNotificationPermission(): NotificationPermission | "unsupported" | "insecure" {
  if (!window.isSecureContext) return "insecure";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission() {
  const permission = getNotificationPermission();
  // ACT: 仅由设置中的点击事件请求授权，Agent 的后台事件不会弹出权限请求。
  return permission === "default" ? Notification.requestPermission() : permission;
}

export async function showNotification(options: NotificationOptions): Promise<void> {
  if (!generalSettings.value.agentNotificationsEnabled) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  if (getNotificationPermission() !== "granted") return;
  new Notification(options.title, { body: options.body, silent: options.silent });
}
