// A platform's and an SDK state's names (UI-01 §33), without icons: for pure code on the first load
// (the Overview's attention list); screens use words.tsx, which re-exports them.
import type { ClientPlatform, SdkState } from "../data-source-clients.ts";

export const PLATFORM_LABEL: Record<ClientPlatform, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  "react-native": "React Native",
  expo: "Expo",
  node: "Node",
  bun: "Bun",
  deno: "Deno",
  swift: "Swift",
  kotlin: "Kotlin",
  other: "Other",
};

export const SDK_STATE_LABEL: Record<SdkState, string> = {
  supported: "Supported",
  upgrade: "Upgrade required",
  unsupported: "Unsupported",
};
