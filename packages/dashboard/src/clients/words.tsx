// Who the clients are, said the same way on every screen (UI-01 §33): a platform's name and icon (generic
// icons — no brand marks), an SDK's state in words, a client in one line ("iPhone 16 · iOS 19.1 · Shop iOS
// 2.3.1"), and the clients grouped by platform or by registered app. Only lazy screens import this.
import { cn } from "@bunvex/ui/lib/utils";
import {
  AppWindow,
  Atom,
  Code,
  Feather,
  Globe,
  Hexagon,
  Layers,
  type LucideIcon,
  MonitorSmartphone,
  Smartphone,
  TabletSmartphone,
  Terminal,
} from "lucide-react";
import {
  appOf,
  CLIENT_PLATFORMS,
  type ClientApp,
  type ClientBucket,
  type ClientInfo,
  type ClientPlatform,
} from "../data-source-clients.ts";
import { PLATFORM_LABEL } from "./names.ts";

export { PLATFORM_LABEL, SDK_STATE_LABEL } from "./names.ts";

const ICON: Record<ClientPlatform, LucideIcon> = {
  web: Globe,
  ios: Smartphone,
  android: TabletSmartphone,
  "react-native": Atom,
  expo: Layers,
  node: Hexagon,
  bun: Terminal,
  deno: Feather,
  swift: AppWindow,
  kotlin: Code,
  other: MonitorSmartphone,
};

export function PlatformIcon({ platform, className }: { platform: ClientPlatform; className?: string }) {
  const Icon = ICON[platform];
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

/** "iPhone 16 · iOS 19.1 · Shop iOS 2.3.1": a device (or runtime), then the app by name and version. */
export function clientLine(c: ClientInfo, apps: ClientApp[] = []): string {
  const app = appOf(c, apps);
  const appText = app ? app.name : c.app?.id;
  return [
    c.device,
    c.runtime ?? PLATFORM_LABEL[c.platform],
    appText && [appText, c.app?.version].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}

export type ClientsBy = "platform" | "app";

/** A set of connections the diagram draws as one card, and how many each serving node holds. */
export type ClientGroup = {
  key: string;
  label: string;
  platform: ClientPlatform;
  connections: number;
  perNode: { node: string; connections: number }[];
  buckets: ClientBucket[];
};

/**
 * Groups a deployment's client buckets. By app, unregistered clients are grouped per platform. The order is
 * fixed (by platform, then by name), never by count: live numbers never move a card.
 */
export function groupClients(
  nodes: { id: string; clients?: ClientBucket[] }[],
  by: ClientsBy,
  apps: ClientApp[],
): ClientGroup[] {
  const groups = new Map<string, ClientGroup>();
  for (const n of nodes)
    for (const b of n.clients ?? []) {
      const app = by === "app" && b.app ? apps.find((a) => a.id === b.app) : undefined;
      const key = by === "platform" ? `platform:${b.platform}` : app ? `app:${app.id}` : `unregistered:${b.platform}`;
      const label =
        by === "platform"
          ? PLATFORM_LABEL[b.platform]
          : app
            ? app.name
            : `Unregistered · ${PLATFORM_LABEL[b.platform]}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, label, platform: app?.platform ?? b.platform, connections: 0, perNode: [], buckets: [] };
        groups.set(key, g);
      }
      g.connections += b.connections;
      g.buckets.push(b);
      const at = g.perNode.find((p) => p.node === n.id);
      if (at) at.connections += b.connections;
      else g.perNode.push({ node: n.id, connections: b.connections });
    }
  const rank = (p: ClientPlatform) => CLIENT_PLATFORMS.indexOf(p);
  return [...groups.values()].sort(
    (a, b) =>
      rank(a.platform) - rank(b.platform) ||
      Number(a.key.startsWith("unregistered")) - Number(b.key.startsWith("unregistered")) ||
      a.label.localeCompare(b.label),
  );
}
