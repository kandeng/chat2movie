const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

export default {
  id: "aiRouter" as const,
  label: "AI-Router",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSI+PHRpdGxlPkFJLVJvdXRlcjwvdGl0bGU+PHBhdGggZmlsbD0iIzYzNjZGMSIgZD0iTTEyIDJhMyAzIDAgMCAwLTMgM3YxLjA2QTYuOTggNi45OCAwIDAgMCA1LjA2IDEwSDRhMiAyIDAgMCAwIDAgNGgxLjA2QTYuOTggNi45OCAwIDAgMCA5IDE3Ljk0VjE5YTMgMyAwIDAgMCA2IDB2LTEuMDZBNi45OCA2Ljk4IDAgMCAwIDE4Ljk0IDE0SDIwYTIgMiAwIDAgMCAwLTRoLTEuMDZBNi45OCA2Ljk4IDAgMCAwIDE1IDYuMDZWNWEzIDMgMCAwIDAtMy0zem0wIDdhMyAzIDAgMSAxIDAgNiAzIDMgMCAwIDEgMC02eiIvPjwvc3ZnPg==",
  version: "2.0.0",
  // ACT: 默认指向阿里云百炼 OpenAI 兼容模式；config.json 的 providers.aiRouter.baseUrl 可覆盖为自建路由地址。
  apiUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  protocol: "openai-completions",
  readme: "## AI-Router\n\n默认的文本模型路由，走 OpenAI 兼容协议（compatible-mode）。\n\n模型列表在设置中动态拉取，无需手工维护。",
  rules,
  models: [],
} satisfies ProviderDefinition<typeof rules>;
