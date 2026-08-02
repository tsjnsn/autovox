import { defineConfig } from 'wxt';

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
      '<all_urls>',
    ],
    action: {
      default_title: 'Autovox',
    },
  },
});
