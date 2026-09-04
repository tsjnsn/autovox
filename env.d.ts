interface ImportMetaEnv {
  readonly WXT_PUBLIC_MANAGED_ENABLED?: string;
  readonly WXT_PUBLIC_CONVEX_URL?: string;
  readonly WXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
