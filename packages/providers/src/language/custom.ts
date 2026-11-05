// ACT: 通用「自定义」文本供应商预设——指向任意 OpenAI / Anthropic 兼容端点（如自建 GPU 上的 vLLM / Ollama / TGI / SGLang）。
// 无需为每个模型写 .ts：连接协议、接口地址、密钥都在表单里填写，模型列表通过 /models 动态拉取。
// 也可以完全在 config.json 里声明（kind:"language"），启动时自动合并，见 docs/aiRouter-deferred-features.md。
const rules = [
  {
    type: "select",
    field: "protocol" as const,
    title: "连接协议",
    value: "openai-completions",
    options: [
      { label: "OpenAI Completions（/chat/completions）", value: "openai-completions" },
      { label: "OpenAI Responses（/responses）", value: "openai-responses" },
      { label: "Anthropic Messages（/messages）", value: "anthropic-messages" },
    ],
  },
  {
    type: "input",
    field: "apiUrl" as const,
    title: "API 地址",
    value: "",
    props: { placeholder: "https://your-server.example.com/v1" },
  },
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

export default {
  id: "custom" as const,
  label: "自定义（兼容 OpenAI / Anthropic）",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%236366f1' d='M4 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 10h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm2-7v2h2V7H6zm0 10v2h2v-2H6z'/%3E%3C/svg%3E",
  version: "2.0.0",
  // ACT: apiUrl 留空，由表单填写；protocol 亦可在表单中切换，默认走 OpenAI 兼容 completions。
  apiUrl: "",
  protocol: "openai-completions",
  readme: "## 自定义供应商\n\n指向任意 **OpenAI / Anthropic 兼容** 的推理服务，例如自建 GPU 上的 vLLM、Ollama、TGI、SGLang，或第三方中转。\n\n- **连接协议**：按服务端实际接口选择 `openai-completions` / `openai-responses` / `anthropic-messages`。\n- **API 地址**：填写服务根地址（如 `https://your-server/v1`）；模型列表会自动从 `<地址>/models` 拉取。\n- **API Key**：本地服务可随便填一个非空值。\n\n> ACT: 同一预设每次只能保存一个「custom」供应商；如需接入多个自建端点，请在 config.json 的 `providers` 中用不同 id 分别声明（`kind: \"language\"`），启动时自动合并。",
  rules,
  models: [],
} satisfies ProviderDefinition<typeof rules>;
