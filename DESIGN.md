# Autovox Design — Wire Meter

## What the product actually is

Autovox is not a settings dashboard that happens to play audio. It is a **page-clipped player** whose job is: start a brief → hear the report. Every control that isn’t brand, transport, or a quiet escape hatch is suspect.

Visual distinctiveness (palette, type, chassis) still matters. It is useless if the *interaction model* is a tool panel. User corrections kept fixing that gap.

## Lessons from product corrections (why they were better)

| Correction | Why it improved the product |
|---|---|
| One play/pause control; drop Stop | Stop is a second mental model. Scrub-to-start + pause already cover reset. Fewer peer controls = clearer hierarchy. |
| Scrubber early + YouTube progressive buffer | Media UX is learned. A scrubber that appears only at the end trains distrust. Buffered range + clamp-to-loaded matches expectation. |
| Cache replay instead of re-fetch | Play means “again from here,” not “pay for TTS again.” Efficiency is UX. |
| Brief **is** the transport (play starts brief) | Two CTAs (Brief vs ▶) split the primary action. One affordance: play means go. Idle meter = same instrument as the player. |
| Kill idle copy (“Stand by · brief this page”) | Restating the obvious competes with the brand and adds dashboard smell. Status belongs on the meter label when something is actually happening. |
| Voice out of the panel (Options only) | Voice is a preference, not a listen-time decision. Panel first viewport = brand + transport + meta links. Preferences live behind Options. |
| Options/Clear as quiet links | Never peer with the primary action. Meta chrome stays meta. |
| Custom scrub thumb (not native range) | Shadow DOM + `all: initial` kills native styling. Distinctive UI must own critical controls. |
| Wire Meter over soft teal/serif “Signal Desk” | Soft pine + Instrument Serif is another AI centroid. Hardware reference (Nagra / wire ticker) moves several axes at once. |

**Meta-pattern:** Prefer **borrowed media conventions** (YouTube transport) over **invented tool chrome** (status stacks, arming bars, settings in the hero). Prefer **one instrument** that changes state over **modes that swap layouts**.

## Going forward — decision rules

Before adding UI, answer:

1. **Does this help start or continue listening?** If no → Options, or omit.
2. **Would a music/video player already teach this?** If yes → match that convention; don’t invent a “briefing panel” variant.
3. **Is this idle decoration?** If the line is true with nothing happening (“stand by”, “ready to brief”) → delete it. Put state on the meter label only while work is in flight or failed.
4. **Are there two ways to do the primary thing?** Collapse to one (play).
5. **Is this a preference or a moment-of-use control?** Preferences → Options. Moment-of-use → transport (volume, scrub, play).
6. **Will this survive shadow DOM?** Own thumbs, fills, icons; don’t trust native form chrome.
7. **Does the visual system still read as Wire Meter?** Keep tokens; don’t resurrect full-width vermillion BRIEF bars or voice selects in the faceplate.

When unsure, ship the smaller overlay.

## Named reference

**Nagra field recorder + AP wire ticker** — a physical meter clipped onto the page. Not a SaaS card. Not a magazine cover. Not a mini settings form.

## Thesis

Autovox is an **on-air instrument**: aluminum chassis, white faceplate, mono readout, vermillion signal on the meter. Digestion is invisible machinery; the face is a player.

## Personality

**Hard · Field-ready · Signal · Dry · Specific**

Avoid: pine/teal “trust” greens, Instrument/Fraunces editorial serif, soft multi-layer shadows, purple, cream+terracotta, pills, glow, fade-up mounts, equal-weight button rows, idle instructional subcopy, duplicate primary CTAs.

## Signature moves

| # | Move | Axis |
|---|------|------|
| 1 | Brand as tracked uppercase grotesque (`AUTOVOX`) | Type |
| 2 | Faceplate on aluminum; vermillion `#E23B2F` for meter/play signal only | Color |
| 3 | Hard offset shadow `4px 4px 0 ink` | Elevation |
| 4 | Hairline scanlines on chassis only | Texture |
| 5 | **Single transport row** = primary UI (idle play briefs; then full player) | Hierarchy |
| 6 | Meter label carries transient state (Extracting… / timecode / Fault)—not a subtitle under the logo | Density |
| 7 | Progressive scrub: buffered + played + thumb as soon as PCM exists | Media UX |
| 8 | Options / Clear as underlined mono meta only | Hierarchy |
| 9 | Preferences (voice, length, key) only in Options | Scope |
| 10 | `::selection` + sharp focus; custom scrub + volume thumbs | Craft |
| 11 | **Wire tape** while writing: the script prints under the meter as the model writes it; the meter fills with words written | Media UX |

## Tokens

```css
--av-aluminum: #D7DBE0;
--av-face: #FFFFFF;
--av-ink: #141414;
--av-muted: #5C636A;
--av-accent: #E23B2F;
--av-accent-ink: #FFFFFF;
--av-track: #C9CED4;
--av-buffered: #9AA3AB;
--av-danger: #E23B2F;
--av-shadow: 4px 4px 0 #141414;
--av-font-brand: "Bricolage Grotesque", "Arial Narrow", sans-serif;
--av-font-ui: "Geist", "Sora", "Segoe UI", sans-serif;
--av-font-mono: "JetBrains Mono", ui-monospace, monospace;
```

## Type roles

- **Brand:** Bricolage Grotesque 700, uppercase, `letter-spacing: 0.14em`, ~18px
- **UI:** Sora 400–600, 12px
- **Meter / timecode:** JetBrains Mono 500–600, 10–11px, `tabular-nums`

## Composition (overlay) — current

```
AUTOVOX                           Close

[▶] ◁) ===meter===   Extract…|0:42|Fault
                       (speaker after audio starts;
                        hover/focus opens volume)
source…                (after script ready)
Show script

Options · Chalkboard     (idle / brief)
Options · Clear          (after script ready)
```

No logo subtitle. No voice select. No separate Brief button. No Stop. No volume row: the speaker mutes, and its slider only opens on hover or focus, as on YouTube.

A failure puts one of four labels on the meter, in danger ink. It says what the listener can do; the provider's wording never reaches the faceplate.

- `Needs setup`: no usable key or sign-in, or the provider refused the key. Fixed in Options; changing settings clears it.
- `No credits`: the provider account or Autovox credits ran out.
- `Retry`: rate limit, outage, dropped network, or managed listening paused for now. Play again later.
- `Fault`: anything else, including a page with no readable text.

While the script is written (brief or chalkboard), the row reads as a wire printer:

```
[▶] ======meter======........       214 words
       …and the Moon line up, their pull adds█
```

- Reading: the tape says `Reading 9,958 words` in muted ink with a solid pilot light on the meter.
- Writing: the spoken text (headline, lede, segments; or lesson title, scene headings, narration) prints on the tape, joined by ` — `, ending at a blinking vermillion cursor. The meter fills with words written against the top of the length target and never reaches the end; the label counts words.
- The tape starts at the meter's left edge, types left to right like a carriage, then pins its newest text under the label and fades the oldest out at the start edge. RTL text mirrors it.
- Only real signals: the article's word count, then the model's actual output. No fake percentages, no rotating "thinking" phrases.
- The tape exists only while work is in flight. Once the script is ready, the player takes the row back and the tape is gone.

### Chalkboard session

```
AUTOVOX                                         Close
┌──────────────────────────────────────────────────┐
│  chalk heading                                   │
│    o/        ──────▶   [ box ]                   │  board 5:3, slate green
│   /|    label                                    │
│   / \                                            │
└──────────────────────────────────────────────────┘
[▶] ◁) ============meter============          0:42
source…
Show script

Options · Export video · Clear     (Export video once the narration has fully downloaded)
```

- The board is a display on the same instrument, not a second mode: one transport row still drives it, and the chassis only widens.
- The board is a pure function of the playhead. Scrub, pause, and replay put it exactly where the voice is; it never runs ahead through a buffering gap.
- The board is never blank or stale: the heading is written first, beat notes stand in until a scene's art arrives, then the art catches up in about a second.
- **Chalkboard** is a quiet meta link (like Options), never a second primary button. Play still means go.
- **Export video** is meta too: the link itself shows progress ("Exporting 42%"), clicking it again cancels, and a failure reads "Export failed" in danger ink with the reason on hover. No modal, no second progress bar.

## Motion

- No panel fade-up.
- Loading: meter fill blink (steps), not spinner stacks.
- One thing blinks at a time: the meter before anything is on the tape, then the tape cursor.
- Wire tape types out each streamed burst over ~300ms so it keeps the model's pace without lagging behind it.
- Scrub thumb/fill: zero lag.
- `prefers-reduced-motion: reduce` kills blink and typing; the tape shows text as it arrives.

## Anti-slop + anti-dashboard gate

- [ ] Primary action is exactly one control (play)
- [ ] No idle instructional status under the brand
- [ ] No preferences in the faceplate
- [ ] Scrubber usable as soon as audio buffers (YouTube-like)
- [ ] Replay/seek don’t imply a new API call when cache exists
- [ ] Still looks like Autovox in grayscale
- [ ] No soft blur shadows / Inter / pine teal / nested cards
- [ ] Shadow-DOM-safe custom thumbs and SVG icons
