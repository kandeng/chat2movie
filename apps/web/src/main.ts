import { createApp, h, nextTick } from "vue";
import { ElButton, ElResult } from "element-plus";
import { createPinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import App from "./App.vue";
import "@/assets/main.scss";
import "element-plus/es/components/message-box/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/result/style/css";

import router from "@/router";
import { registerDownloads } from "@/lib/saveFile";
import { registerAnonymousData } from "@/lib/anonymousData";
import { loadSettings, settingsStorage } from "@/stores/settings";
import { registerLanguage } from "@/lib/i18n";
import { translate } from "@toonflow/i18n/vue";

const app = createApp(App);
app.onUnmount(registerLanguage());
let isMounted = false;

// ACT: 客户端（桌面/移动）已随本次精简移除，网页只运行在浏览器模式；
// 不再做 WebView2/移动内核检测，也不再与桌面宿主握手就绪状态。
loadSettings().then(async () => {
  app.use(createPinia().use(createPersistedState({ storage: settingsStorage })));
  app.use(router);
  await router.isReady();
  app.onUnmount(registerAnonymousData());
  app.mount("#app");
  isMounted = true;
  app.onUnmount(registerDownloads());
}).catch(async (error) => {
  console.error("页面初始化失败：", error);
  if (isMounted) app.unmount();
  createApp({
    render: () => h(ElResult, {
      icon: "error",
      title: translate("启动失败"),
      subTitle: error instanceof Error ? error.message : translate("无法加载应用，请重试。"),
    }, {
      extra: () => [h(ElButton, { type: "primary", onClick: () => window.location.reload() }, () => translate("重试"))],
    }),
  }).mount("#app");
  await nextTick();
});
