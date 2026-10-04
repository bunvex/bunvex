/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Prefills the sign-in page's deployment URL (Convex: NEXT_PUBLIC_DEPLOYMENT_URL). */
  readonly VITE_BUNVEX_DEPLOYMENT_URL?: string;
  /** Prefills the sign-in page's admin key (Convex: NEXT_PUBLIC_ADMIN_KEY). Never bake a real key into a public build. */
  readonly VITE_BUNVEX_ADMIN_KEY?: string;
  /**
   * The parent origins allowed to embed the dashboard and hand it credentials, separated by commas or spaces.
   * Written into index.html's `<meta name="bunvex-embed-origins">` at build (vite.config.ts); unset, embedded
   * sign-in is off. Convex has no such list (STUDY-12 LG3).
   */
  readonly VITE_BUNVEX_EMBED_ORIGINS?: string;
}
