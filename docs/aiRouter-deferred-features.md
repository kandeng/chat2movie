# aiRouter — Deferred (Toonflow-coupled) Features

Phase 1 replaced the Toonflow `tfRouter` provider with a unified, config-driven
`aiRouter` provider (language + media), whose API key/baseUrl live in the root
`config.json -> providers.aiRouter`. The features below were hard-wired to the
Toonflow platform (`https://api.toonflow.net`) and are now **disabled / guarded /
inert** — they do not crash and are hidden from the UI, but they are not yet
re-implemented against aiRouter.

The Toonflow client and billing logic are **kept in the repo (unused)** as the
reuse base for future aiRouter-backed implementations.

## Guard flags (single place to re-enable)

| Flag | File | Default | Effect |
| --- | --- | --- | --- |
| `marketEnabled` | `apps/web/src/components/settings/panels/pluginMarket/index.vue` | `false` | Hides the online "发现插件" (discover) market tab + "网页版市场" link; local 已安装 / MCP / FFmpeg stay available. |
| `sponsorsEnabled` | `apps/web/src/components/settings/panels/about.vue` | `false` | Hides the sponsor panel and skips `getSponsorList()`. |
| `balanceEnabled` | `apps/web/src/components/settings/panels/languageModel/index.vue` | `false` | Hides the `tfAccount` balance/recharge widget on the aiRouter language provider. |
| `telemetryEnabled` | `apps/web/src/lib/anonymousData.ts` | `false` | Stops the anonymous usage POST to `api.toonflow.net/web/telemetry/report`. |

## Deferred features

### 1. Balance / recharge
- **Status:** disabled. The hardcoded `TF-Router` balance entry was removed from
  `providerBilling.ts syncProviders()` (now only real providers that report
  `supportsBalance` appear). The `tfAccount` widget in the language panel is gated
  by `balanceEnabled`. The canvas balance popover
  (`pages/workspace/panels/canvas/components/canvasMenu.vue`, keyed on
  `item.id === 'tfRouter'`) is inert because no provider has that id anymore.
- **Reuse base:** `apps/web/src/lib/providerBilling.ts`,
  `apps/web/src/components/settings/tfAccount.vue`,
  `apps/web/src/components/settings/tfRechargeDialog.vue`, and the media
  `getBalance` / `getPrice` provider hooks (`apps/server/src/utils/media/billing.ts`).
- **aiRouter implementation needs:** a balance/price endpoint for the aiRouter
  backend (Bailian/DashScope or a self-hosted router). Implement `getBalance` /
  `getPrice` on the `aiRouter` media provider, then surface the balance via
  `providerBilling.ts` keyed on `aiRouter.id` instead of `tfRouter`.

### 2. Plugin market (online discover)
- **Status:** disabled via `marketEnabled`. The TF API key form, `tf.getPlugIn`
  listing, and `saveMarketKey` flow remain in the file but are unreachable.
- **Reuse base:** `apps/web/src/lib/tf.ts` (`getPlugIn`, `toggleCollection`) and the
  discover-tab logic in `pluginMarket/index.vue`.
- **aiRouter implementation needs:** a plugin registry backend + auth. Point the
  discover tab at the new registry, or keep it permanently off if plugins stay
  local-only.

### 3. Plaza / explore feed
- **Status:** already inert. The Plaza page (`apps/web/src/pages/home/index.vue`)
  was migrated to Matrix chat videos and no longer uses the TF explore API. The
  `apps/web/src/pages/home/explore.vue`, `exploreDetail.vue`, `exploreProcess.vue`
  files are **orphaned** (not routed, not imported) and compile but are dead code.
- **Reuse base:** `apps/web/src/lib/tf.ts` explore APIs (`getExploreProjects`,
  `getExploreProject`, `getExploreProcess`, `getExploreDownload`,
  `setExploreReaction`).
- **aiRouter implementation needs:** a community/gallery backend, or delete the
  orphaned explore views if the feature is dropped permanently.

### 4. Telemetry
- **Status:** disabled via `telemetryEnabled`. Collection still runs locally but
  `report()` returns before any network send.
- **Reuse base:** `apps/web/src/lib/anonymousData.ts` (schema + collection logic).
- **aiRouter implementation needs:** a self-hosted telemetry endpoint (or leave off
  for privacy). Change the POST URL and re-enable the flag.

### 5. Hello-page login auto-config
- **Status:** removed. `apps/web/src/pages/hello/index.vue` no longer embeds the
  `api.toonflow.net/login` iframe or auto-configures providers from a TF login key.
  It keeps two paths: "配置语言模型" (manual) and "稍后配置，直接进入" (skip).
- **Rationale:** the aiRouter key is hosted server-side in `config.json`, so the
  built-in provider works out of the box with no login.
- **aiRouter implementation needs:** none for the built-in router. If a future
  hosted account/portal is added, reintroduce an onboarding auto-config here.

## Migration note
`apps/server/src/utils/conf/index.ts -> migrateLegacyProviderIds()` rewrites any
existing `settings.customProviders` entry with id `tfRouter` to `aiRouter`, clears
stale `settings.mediaProviderConfigs.tfRouter`, and repoints `chatToVideo.providerId`
from `bailian`/`tfRouter` to `aiRouter` on startup.

## Config-driven providers (`config.json -> providers`)

Phases 2–3 made **both** language and media providers fully config-driven: a
provider can be declared entirely in the root `config.json -> providers.<id>`
with **no per-provider `.ts` file**. The `<id>` is the provider key (lowerCamel,
`/^[a-z][a-zA-Z0-9]*$/`, ≤ 96 chars) and is also the materialized media file name
(`data/providers/<id>.ts`).

### Entry schema (`ProviderEntry`, see `apps/server/src/utils/appConfig.ts`)

| Field | Applies to | Meaning |
| --- | --- | --- |
| `kind` | both | `"language"` or `"media"`. Optional — see classification rules below. |
| `protocol` | language | `"openai-completions"` \| `"openai-responses"` \| `"anthropic-messages"`. |
| `adapter` | media | Generic adapter name: `"dashscope"` \| `"openai-images"` \| `"fal"` \| `"replicate"`. |
| `baseUrl` | both | Language → the provider `apiUrl`. Media → overrides the adapter's `baseUrl` rule at generation time. |
| `apiKey` | both | Secret. Hosted in `config.json` only (never written to `data/`). |
| `label` | both | Display name (defaults to `<id>`). |
| `icon` | both | Optional icon (data URI or URL). Language: shown in the sidebar. Media: overrides the adapter's default icon. |
| `models` | both | Optional model list. Language: pinned models (else auto-fetched on startup). Media: per-model `adapter` bags injected into the template. |
| `enabled` | both | Optional. `false` → the entry is skipped. |

### Classification rules (how an entry is interpreted)

1. **`kind: "media"` + `adapter`** → on startup, `materializeConfigProviders()`
   (`apps/server/src/utils/media/provider.ts`, called from `app.ts`) instantiates the
   matching generic adapter template with the declared `id`/`label`/`icon`/`models[]`
   and writes `data/providers/<id>.ts`.
2. **`kind: "language"`** (or an entry with a `protocol` and no `adapter`) →
   `mergeConfigLanguageProviders()` (`apps/server/src/utils/conf/index.ts`) merges it
   into `settings.customProviders`; `refreshLanguageModels()` then auto-fetches the
   model list from `<baseUrl>/models` when the key resolves and `models` is empty.
3. **Neither** (just `apiKey`/`baseUrl`, e.g. the built-in `aiRouter`) → a pure
   secret/URL **override** for an already-installed provider id. It does **not**
   create a new language provider; `getConfigApiKey(id)` / `getConfigBaseUrl(id)`
   supply the secret/URL at request time.

### Persistence & precedence (media)

- `config.json` **seeds/updates** the materialized `data/providers/<id>.ts` (the
  "B layer"). **Secrets always come from `config.json`** at generation time.
- UI model edits persist to the B layer and are **only re-seeded when the config
  entry's fingerprint changes** (`adapter` + `label` + `icon` + `models`). The
  fingerprint is stored in `settings.mediaProviderSeedHash.<id>`. An unchanged
  config never clobbers UI edits; a first-seen existing file is adopted as the
  baseline (not overwritten).
- A novel media API with **no matching adapter** still uses the existing
  upload-file / paste-code path ("添加自定义媒体供应商"), unchanged.

### Copy-paste examples

```jsonc
{
  "providers": {
    // (a) Built-in aiRouter language + media: secret/URL override only (no kind).
    //     apiKey feeds the language preset AND the media DashScope adapter;
    //     baseUrl overrides the media adapter endpoint.
    "aiRouter": {
      "apiKey": "sk-your-bailian-key",
      "baseUrl": "https://dashscope.aliyuncs.com/api/v1"
    },

    // (b) Customer self-hosted OpenAI-compatible language server — config-only, no .ts.
    //     Models are auto-fetched from https://gpu.example.com/v1/models on startup.
    "myVllm": {
      "kind": "language",
      "protocol": "openai-completions",
      "baseUrl": "https://gpu.example.com/v1",
      "apiKey": "sk-your-vllm-key",
      "label": "My vLLM"
    },

    // (c) Config-only media provider via the generic DashScope (Bailian) adapter.
    "myBailianMedia": {
      "kind": "media",
      "adapter": "dashscope",
      "label": "My Bailian Media",
      "apiKey": "sk-your-bailian-key",
      "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
      "models": [
        { "id": "wan2.2-t2v-flash", "label": "Wan 2.2 T2V", "type": "video",
          "adapter": { "endpoint": "/services/aigc/video-generation/video-synthesis", "callMode": "async" } }
      ]
    },

    // (d) Config-only media provider via the fal / replicate adapters.
    "myFal": {
      "kind": "media",
      "adapter": "fal",
      "label": "My fal.ai",
      "apiKey": "your-fal-key",
      "models": [
        { "id": "fal-ai/flux/dev", "label": "FLUX.1 [dev]", "type": "image",
          "adapter": { "promptField": "prompt", "ratioField": "aspect_ratio", "listPath": "images", "urlField": "url" } }
      ]
    },
    "myReplicate": {
      "kind": "media",
      "adapter": "replicate",
      "label": "My Replicate",
      "apiKey": "r8_your-replicate-key",
      "models": [
        { "id": "black-forest-labs/flux-dev", "label": "FLUX dev", "type": "image",
          "adapter": { "refImageField": "image", "outputPath": "output" } }
      ]
    }
  }
}
```

> Multiple language servers of the same protocol must use **distinct ids** in
> `config.json -> providers` (the UI "custom" preset only supports one). Each id
> becomes its own sidebar provider.

## See also
- Root `config.json -> providers.<id>` (`kind`, `protocol`, `adapter`, `apiKey`, `baseUrl`, `label`, `icon`, `models`, `enabled`).
- `apps/server/src/utils/appConfig.ts` (`ProviderEntry`, `getProviderEntries`, `getConfigApiKey`, `getConfigBaseUrl`).
- `apps/server/src/utils/conf/index.ts` (`mergeConfigLanguageProviders`) and `apps/server/src/utils/ai/initialize.ts` (`refreshLanguageModels`).
- `apps/server/src/utils/media/provider.ts` (`materializeConfigProviders`, `instantiateAdapterSource`) + the `app.ts` startup hook.
- `packages/providers/src/language/aiRouter.ts` (OpenAI-compatible preset) and `packages/providers/src/language/custom.ts` (generic protocol preset).
- `packages/providers/src/media/aiRouter.ts` (generic DashScope adapter), `openaiImages.ts`, `fal.ts`, `replicate.ts` (generic media adapters).
