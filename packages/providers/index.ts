/// <reference path="./types.d.ts" />

import aiRouterLanguage from "./src/language/aiRouter";
import deepSeek from "./src/language/deepSeek";
import custom from "./src/language/custom";
import aiRouterMedia from "./src/media/aiRouter";
import apiMart from "./src/media/apiMart";
import metaso from "./src/media/metaso";
import compshare from "./src/media/compshare";
import music from "./src/media/music";
import openaiImages from "./src/media/openaiImages";
import fal from "./src/media/fal";
import replicate from "./src/media/replicate";

export type Provider = ProviderDefinition;
export type ProviderPrice = NonNullable<Awaited<ReturnType<NonNullable<Provider["getPrice"]>>>>;
export type ProviderPriceRequest = Parameters<NonNullable<Provider["getPrice"]>>[0];
export type ProviderPriceReference = NonNullable<ProviderPriceRequest["images"]>[number];
export type ProviderBalance = Awaited<ReturnType<NonNullable<Provider["getBalance"]>>>;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [aiRouterLanguage, deepSeek, custom] as const;
export const mediaProviders = [aiRouterMedia, apiMart, metaso, compshare, music, openaiImages, fal, replicate] as const;
