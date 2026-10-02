// A link to an extension's route (UI-01 §26). Extension routes are not in the router's types (their paths are
// plain strings), so the built-in screens keep their checked `DashLink` and extensions use this one.
import { Link, type LinkComponentProps } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

type AnchorProps = Omit<ComponentProps<"a">, "href" | "children"> &
  Pick<LinkComponentProps<"a">, "activeProps" | "inactiveProps">;

export function ExtensionLink(
  props: { to: string; search?: Record<string, unknown>; children?: ReactNode; exact?: boolean } & AnchorProps,
) {
  const { to, search, exact, ...rest } = props;
  const link = { to, search, activeOptions: exact ? { exact: true } : undefined } as unknown as LinkComponentProps<"a">;
  return <Link {...link} {...rest} />;
}
