# Autovox

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/aodlbiejdiibbpemagfngbdhaappejda?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda)

**Autovox** digests a web page into a spoken news report—with real comprehension, not just a summary or TTS.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda)

![Autovox overlay on a news page](store/screenshot-1.png)

## Features

- On-page overlay player (toolbar icon toggles it)
- Right-click **Vox this page** opens Autovox and starts the brief
- Play starts the brief when idle — one transport control
- Progressive scrubber (buffered + played), seek within downloaded audio
- In-memory PCM cache for replay without re-calling TTS
- Optional managed listening with trial / purchased credits
- OpenRouter OAuth or OpenAI API key BYOK remains available
- Voice, output language, report length, credits, and BYOK spend in Options only

## Privacy

See [PRIVACY.md](./PRIVACY.md). Page text is sent directly to the selected AI provider. BYOK keys stay on the browser profile. Optional managed mode sends payment, credit, coarse configuration, cost, and lifecycle state to the Autovox control plane—but never URL, title, article text, script, or audio.

Page access uses `activeTab` + `scripting` when you click the toolbar icon or **Vox this page** — not a persistent `<all_urls>` host permission. The `contextMenus` permission is only for that right-click entry.

## Developers

- [Development setup](docs/development.md)
- [Publishing to the Chrome Web Store](docs/publishing.md)
- [Flywheel — money is the data](docs/flywheel.md)
- [Managed listening — one-time launch setup](docs/managed-listening.md)
- [Contributing](CONTRIBUTING.md)
- [Design — Wire Meter](DESIGN.md)
- [Store listing assets](store/listing.md)

## License

[MIT](./LICENSE) © tsjnsn
