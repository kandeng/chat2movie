// ACT: 客户端（桌面/移动）已移除，保存文件统一使用浏览器原生 <a download> 下载。
export default async function saveFile(content: Blob | (() => Promise<Blob>), fileName: string): Promise<boolean> {
  const blob = typeof content === "function" ? await content() : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export function registerDownloads() {
  // ACT: 浏览器原生支持 <a download>，无需拦截同源下载；保留空实现以兼容启动时的注册调用。
  return () => {};
}
