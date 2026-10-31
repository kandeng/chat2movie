// ACT: 客户端（桌面/移动）已随本次精简移除，服务端进程是唯一宿主；
// 平台信息仅用于区分“本机原生开发页面”与“服务器部署”，不再支持运行时切换宿主。
export function getRuntimePlatform() {
  const os = (process.platform as string) === "openharmony" || (process.platform === "linux" && process.env.TOONFLOW_PLATFORM === "ohos") ? "ohos" : process.platform;
  const development = process.env.NODE_ENV === "dev";
  const desktopSystem = process.platform === "win32" || process.platform === "darwin";
  const nativeDevelopment = desktopSystem && development;
  // local 表示本机任意工作目录能力，不代替请求授权。
  const local = desktopSystem && development;

  return {
    os,
    development,
    // ACT: 桌面/移动宿主已移除，恒为 false；保留字段以维持返回结构稳定。
    desktop: false,
    mobile: false,
    local,
    nativeDevelopment,
    browserSupported: development,
    // 此限制与 local 不等价：仅本机原生开发场景要求 Host 为本机。
    requiresLocalHost: nativeDevelopment,
  };
}
