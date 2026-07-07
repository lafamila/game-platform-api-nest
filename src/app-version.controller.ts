import { Controller, Get, Query } from "@nestjs/common";
import { env, intEnv } from "./config/env";

type AppPlatform = "ios" | "android" | "macos";

const supportedPlatforms = new Set<AppPlatform>(["ios", "android", "macos"]);

@Controller("app-version")
export class AppVersionController {
  @Get()
  version(@Query("platform") platform?: string) {
    const normalized = normalizePlatform(platform);
    if (!normalized) {
      return {
        status: "unsupported",
        platform: platform?.trim().toLowerCase() || "unknown",
        latestVersion: "",
        latestBuild: 0,
        minSupportedBuild: 0,
        updateUrl: "",
        message: "",
      };
    }
    const envPrefix = normalized.toUpperCase();
    const latestBuild = intEnv(`APP_${envPrefix}_LATEST_BUILD`, 0);
    const minSupportedBuild = intEnv(`APP_${envPrefix}_MIN_SUPPORTED_BUILD`, 0);

    return {
      status: "ok",
      platform: normalized,
      latestVersion: env(`APP_${envPrefix}_LATEST_VERSION`, ""),
      latestBuild,
      minSupportedBuild,
      updateUrl: env(`APP_${envPrefix}_UPDATE_URL`, ""),
      message: env(`APP_${envPrefix}_UPDATE_MESSAGE`, ""),
    };
  }
}

function normalizePlatform(value?: string): AppPlatform | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized && supportedPlatforms.has(normalized as AppPlatform)) {
    return normalized as AppPlatform;
  }
  return null;
}
