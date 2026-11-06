<template>
  <div class="about">
    <div class="brand">
      <div class="brandMark"><img class="brandLogo" :src="logoUrl" alt="vidsay Logo" /></div>
      <div class="brandInfo">
        <h3>vidsay</h3>
        <div class="brandMeta">
          <span v-if="currentVersion">v{{ currentVersion }}</span>
        </div>
      </div>
    </div>

    <el-card class="infoCard repositoryCard" shadow="never">
      <a class="repositoryLink" :href="repositoryUrl" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库：kandeng/vidsay">
        <icon-brand-github class="repositoryIcon" :size="22" aria-hidden="true" />
        <div class="repositoryInfo">
          <span class="repositoryTitle">GitHub 仓库</span>
        </div>
        <icon-external-link class="externalIcon" :size="16" aria-hidden="true" />
      </a>
    </el-card>

    <el-card class="infoCard" shadow="never">
      <div class="cardHeader">
        <div class="cardLabel">
          <icon-brand-wechat :size="20" aria-hidden="true" />
          <span>微信交流群</span>
        </div>
        <el-popover trigger="click" placement="top" title="微信扫码加入交流群" :width="196">
          <template #reference>
            <el-button size="small" :icon="IconQrcode">展示二维码</el-button>
          </template>
          <q-r-code
            :value="communityUrl"
            :size="168"
            type="svg"
            color="#000000"
            bgColor="#ffffff"
            borderless
            role="img"
            aria-label="vidsay 交流群二维码" />
          <div class="tips">
            vidsay 是为爱发电的开源项目。欢迎文明交流、友善反馈；回复可能需要一些时间，请避免责问或命令式沟通，感谢你的理解与尊重。
          </div>
        </el-popover>
      </div>
    </el-card>

    <section v-if="sponsorsEnabled" class="sponsorPanel" aria-label="赞助商">
      <h3 class="sponsorTitle">
        <icon-gift :size="20" aria-hidden="true" />
        赞助商
        <span class="sponsorHint">排名不分先后</span>
        <el-popover trigger="click" placement="top" title="微信扫码洽谈商务合作" :width="196">
          <template #reference>
            <el-button class="sponsorContact" size="small" type="primary" link>成为赞助商</el-button>
          </template>
          <q-r-code
            value="https://work.weixin.qq.com/u/vc0f54596c5837d05a?v=5.0.8.70675"
            :size="168"
            type="svg"
            color="#000000"
            bgColor="#ffffff"
            borderless
            role="img"
            aria-label="vidsay 商务合作二维码" />
        </el-popover>
      </h3>
      <div v-if="sponsors.length" class="sponsorGrid" @keydown.esc="closeSponsor">
        <el-popover
          v-for="sponsor in sponsors"
          :key="sponsor.id"
          role="dialog"
          placement="top-start"
          :title="sponsor.name"
          width="min(360px, calc(100vw - 32px))"
          :visible="activeSponsorId === sponsor.id"
          :hideAfter="0"
          :persistent="false"
          @update:visible="(visible) => setSponsorVisible(sponsor.id, visible)">
          <template #reference>
            <button class="sponsorEntry" type="button" :aria-label="`查看 ${sponsor.name} 详情`">
              <span v-if="sponsor.logoUrl" class="sponsorLogo"><img :src="sponsor.logoUrl" :alt="`${sponsor.name} logo`" /></span>
              <span class="sponsorName">{{ sponsor.name }}</span>
            </button>
          </template>
          <messageMarkdown v-if="sponsor.readme.trim()" class="sponsorReadme" :content="sponsor.readme" @keydown.esc="closeSponsor" />
        </el-popover>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onMounted, onBeforeUnmount, ref } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { QRCode } from "tdesign-vue-next";
import {
  IconBrandGithub,
  IconExternalLink,
  IconGift,
  IconBrandWechat,
  IconQrcode,
} from "@tabler/icons-vue";
import logoUrl from "@toonflow/assets/logo.svg";
import tf, { type TfSponsor } from "@/lib/tf";

const messageMarkdown = defineAsyncComponent(() => import("@/components/messageMarkdown.vue"));
const repositoryUrl = "https://github.com/kandeng/vidsay";
const communityUrl = "https://work.weixin.qq.com/u/vc36adcc89845edcbe?v=5.0.3.63936&bb=85b8d228e8";
// ACT: 客户端（桌面/移动）已移除，网页版本号直接取构建时注入的应用版本。
const currentVersion = import.meta.env.appVersion as string | undefined;
const activeSponsorId = ref<number>();
const controller = new AbortController();
const sponsors = ref<TfSponsor[]>([]);
// ACT: 赞助商与 TF-Router 平台入口均来自 api.toonflow.net，已随 tfRouter 下线；保留代码作为未来 aiRouter 复用基础（见 docs/aiRouter-deferred-features.md）。
const sponsorsEnabled: boolean = false;

onMounted(async () => {
  if (!sponsorsEnabled) return;
  try {
    sponsors.value = await tf.getSponsorList({ signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(getRequestError(error));
  }
});
onBeforeUnmount(() => controller.abort());

function setSponsorVisible(id: number, visible: boolean) {
  if (visible || activeSponsorId.value === id) activeSponsorId.value = visible ? id : undefined;
}

function closeSponsor(event: KeyboardEvent) {
  if (!activeSponsorId.value) return;
  event.stopPropagation();
  activeSponsorId.value = undefined;
}

function getRequestError(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : String(error);
}
</script>

<style lang="scss" scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 0 12px;

    .brandMark {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      width: 60px;
      height: 60px;
      border-radius: calc(var(--ui-radius) * 1.5);
      background: var(--el-fill-color-light);

      .brandLogo {
        width: 42px;
        height: 42px;
        object-fit: contain;

        .dark & {
          filter: invert(1);
        }
      }
    }

    .brandInfo {
      min-width: 0;

      h3 {
        margin: 0 0 8px;
        color: var(--el-text-color-primary);
        font-size: 20px;
        font-weight: 600;
      }

      .brandMeta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }
    }
  }

  .infoCard {
    min-width: 0;
    border-radius: calc(var(--ui-radius) * 1);

    :deep(.el-card__body) {
      padding: 14px;
    }

    .cardHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;

      .cardLabel {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--el-text-color-primary);
        font-size: 14px;
        font-weight: 600;
      }
    }

    &.repositoryCard {
      transition: border-color 0.2s;

      :deep(.el-card__body) {
        padding: 0;
      }
      &:hover {
        border-color: var(--el-border-color-darker);
      }

      .repositoryLink {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px;
        color: var(--el-text-color-primary);
        text-decoration: none;

        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: -2px;
          border-radius: calc(var(--ui-radius) * 1);
        }

        .repositoryIcon,
        .externalIcon {
          flex-shrink: 0;
        }
        .externalIcon {
          color: var(--el-text-color-secondary);
        }

        .repositoryInfo {
          display: flex;
          flex: 1;
          flex-direction: column;
          gap: 6px;
          min-width: 0;

          .repositoryTitle {
            font-size: 14px;
            font-weight: 600;
          }
        }
      }
    }
  }

  .sponsorPanel {
    margin-top: 8px;
    min-width: 0;

    .sponsorTitle {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 8px;
      color: var(--el-text-color-primary);
      font-size: 16px;
      font-weight: 600;

      .sponsorHint {
        color: var(--el-text-color-secondary);
        font-size: 12px;
        font-weight: 400;
      }

      .sponsorContact {
        margin-left: auto;
      }
    }

    .sponsorGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 110px), 1fr));
      gap: 6px;

      .sponsorEntry {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        height: 48px;
        padding: 7px 8px;
        border: 1px solid var(--el-border-color-lighter);
        border-radius: var(--ui-radius);
        background: var(--el-bg-color);
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: left;
        cursor: pointer;

        &:hover,
        &[aria-expanded="true"] {
          border-color: var(--el-border-color-darker);
          background: var(--el-fill-color-light);
        }

        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 2px;
        }

        .sponsorLogo {
          display: block;
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          padding: 4px;
          box-sizing: border-box;
          border-radius: var(--ui-radius);
          background: #fff;

          img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
          }
        }

        .sponsorName {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 500;
        }
      }
    }
  }
}

.tips {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}

.sponsorReadme {
  max-height: min(320px, 50vh);
  overflow-y: auto;
  overflow-wrap: anywhere;
}
</style>
