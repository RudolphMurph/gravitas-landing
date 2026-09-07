# Gravitas landing page

Three files, no build step.

| File | What it is |
|---|---|
| `index.html` | Markup and copy. Every line of text on the page lives here. |
| `styles.css` | Design tokens and layout. |
| `scene.js` | The 3D scene and all motion. Tunables are in `CONFIG` at the top. |

Dependencies: Three.js 0.160 (loaded from unpkg via an import map) and three Google Fonts. Nothing else.

## Run it

Serve the folder over HTTP (ES modules do not load from `file://`):

```bash
npx serve .
```

## How it works

- The page is one fixed full-screen canvas plus a tall invisible scroll track. Scrolling turns into a single progress value 0..1.
- Seven sections. Each owns one 3D object and one block of copy. As you scroll, the current object sinks back into the dark and the next one arrives from far away. They never overlap.
- The hero coin rolls through the assets on one clock and the two move words roll on another. Both only run while the hero is on screen.
- Every dollar figure on the page is derived from the live BTC spot price (Bybit first, CoinGecko fallback, $80,000 if both fail). Nothing is hardcoded.

## Things you will want to change

All in `CONFIG` at the top of `scene.js` unless noted.

- **Assets in the hero roll:** `assets`. Order, headline word, coin glyph and colours.
- **Move words:** `moves`. Also change the four pill labels in `index.html`.
- **Cadence:** `moveTickSeconds` (words), `coinRollEverySeconds` and `coinRollDurationSeconds` (coin).
- **Price sources and level maths:** `priceEndpoints`, `fallbackSpot`, `heroZeroLinePct`, `expiryRingOffset`, `boardHalfWidth`.
- **Builder worst-case readout:** `builderWorstCase`, `builderUncappedFromLeg`.
- **Copy:** `index.html`. Keep one `.stage` per section; `data-section` is its index.
- **Colours and type:** `:root` in `styles.css`.
- **Scroll length:** `#track { height }` in `styles.css`. More height = slower story.
- **Buttons:** the four `<a class="btn">` hrefs in `index.html` currently point at `#`.

## Integrating into the Next.js app

1. `npm i three@0.160.0`
2. Change the six imports at the top of `scene.js` from `three/addons/...` to `three/examples/jsm/...` and delete the import map from the HTML.
3. Wrap the body markup in a client component and start the scene from `useEffect`. The scene touches `window`, `document` and WebGL, so it must not run on the server:

```tsx
'use client';
import { useEffect } from 'react';
export default function Landing() {
  useEffect(() => { import('./scene'); }, []);
  return ( /* markup from index.html body */ );
}
```

4. `scene.js` calls `frame()` at the bottom and adds `scroll` and `resize` listeners on `window`. If the component can unmount, export a `dispose()` that cancels the animation frame, removes the listeners and calls `renderer.dispose()`.
5. Load the fonts through `next/font` instead of the `<link>` tags.

## QA hooks

Add `?debug` to the URL and `window.gravitas` appears:

```js
gravitas.setProgress(0.5)   // jump to the middle of the story
gravitas.setHero(3, 2)      // hero on asset 3 (Gold), move pair 2 (Flat or wild)
gravitas.freeze()           // stop the hero clocks
gravitas.setSpot(79844)     // force a BTC price
```

## Performance notes

- Pixel ratio is capped at 1.5 and the render target is 4x MSAA. On low-end phones drop the cap to 1 and remove the `BokehPass` line.
- The payoff slab recomputes normals while morphing (about a second after a pill click), then idles.
- Everything is one draw list; there is no per-section teardown, so memory is flat after load.

## Copy rules the product owner set

No em dashes. Dollars only. Say "bet". Under 120 visible words. Never claim a capped loss for anything that sells an option.
