import { defineConfig } from 'wxt';

/** Patterns that trigger Chrome Web Store in-depth host-permission review. */
const BROAD_HOST_PERMISSIONS = new Set([
  '<all_urls>',
  '*://*/*',
  'http://*/*',
  'https://*/*',
]);

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Autovox',
    description:
      'Digest a web page into a spoken news report—with real comprehension, not just a summary or TTS.',
    permissions: ['activeTab', 'storage', 'scripting', 'identity'],
    host_permissions: [
      'https://openrouter.ai/*',
      'https://api.openai.com/*',
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
