// ACT: 客户端（桌面/移动）已随本次精简移除，网页始终运行在浏览器模式；
// 不再解析 ?desktop/?mobile/?remote，也不提供平台模拟。保留导出名以兼容既有引用，桌面/移动相关值恒为 false。
export const actualPlatform = {
  isDesktop: false,
  isMobile: false,
  isRemoteConnection: false,
  isLocalDesktop: false,
  isLocalMobile: false,
  isWindows: /Windows/i.test(navigator.userAgent),
  isMac: navigator.platform.includes("Mac"),
};

export const isMobile: boolean = false;
export const isDesktop: boolean = false;
export const isRemoteConnection: boolean = false;
export const isLocalDesktop: boolean = false;
export const isLocalMobile: boolean = false;
export const isWindows = actualPlatform.isWindows;
export const isMac = actualPlatform.isMac;
