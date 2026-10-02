/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Prefills the sign-in page's deployment URL (Convex: NEXT_PUBLIC_DEPLOYMENT_URL). */
  readonly VITE_BUNVEX_DEPLOYMENT_URL?: string;
  /** Prefills the sign-in page's admin key (Convex: NEXT_PUBLIC_ADMIN_KEY). Never bake a real key into a public build. */
  readonly VITE_BUNVEX_ADMIN_KEY?: string;
}
