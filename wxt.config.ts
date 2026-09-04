import { defineConfig } from 'wxt';

/** Patterns that trigger Chrome Web Store in-depth host-permission review. */
const BROAD_HOST_PERMISSIONS = new Set([
  '<all_urls>',
  '*://*/*',
  'http://*/*',
  'https://*/*',
]);
function hostPermission(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

const clerkHost = hostPermission(
  process.env.WXT_PUBLIC_CLERK_FRONTEND_API_URL,
);
const convexHost = hostPermission(process.env.WXT_PUBLIC_CONVEX_URL);
const MANAGED_HOST_PERMISSIONS =
  process.env.WXT_PUBLIC_MANAGED_ENABLED === 'true'
    ? [
        ...(convexHost ? [convexHost] : []),
        ...(clerkHost ? [clerkHost] : []),
      ]
    : [];

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Autovox',
    description:
      'Digest a web page into a spoken news report—with real comprehension, not just a summary or TTS.',
    permissions: ['activeTab', 'storage', 'scripting', 'identity', 'contextMenus'],
    host_permissions: [
      'https://openrouter.ai/*',
      'https://api.openai.com/*',
      ...MANAGED_HOST_PERMISSIONS,
    ],
    action: {
      default_title: 'Autovox',
    },
  },
  hooks: {
    // WXT copies runtime content-script matches into host_permissions; strip
    // broad patterns so page access comes only from activeTab + scripting.
    'build:manifestGenerated': (_wxt, manifest) => {
      manifest.host_permissions = (manifest.host_permissions ?? []).filter(
        (permission: string) => !BROAD_HOST_PERMISSIONS.has(permission),
      );
    },
  },
});
