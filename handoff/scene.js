/**
 * Gravitas landing scene.
 *
 * One Three.js scene, seven "sections". Scrolling the page scrubs a single
 * progress value 0..1. Each section owns one hero object that arrives from the
 * dark, holds while its copy is readable, then sinks away before the next one
 * appears. Nothing is timeline-based except the hero's word/coin rolls.
 *
 * Structure of this file:
 *   1. CONFIG            everything a designer or PM might want to tune
 *   2. helpers           math, easing, DOM
 *   3. renderer          WebGL, post-processing, lights, floor
 *   4. price             live BTC spot -> every number on the page
 *   5. coins             factory + asset switching
 *   6. sections          one build function per section
 *   7. scroll + frame    the loop that drives everything
 *   8. hero word roll    the rotating headline
 *
 * Integration: see README.md. To move into a bundler, replace the importmap
 * with `npm i three@0.160` and change the import paths below to
 * 'three/examples/jsm/...'.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* =========================================================================
   1. CONFIG
   ========================================================================= */

const CONFIG = {
  /** Assets the hero coin rolls through, in order. `word` is the headline word,
   *  `glyph` is drawn on the coin face. Colours are the coin body, rim, glyph and
   *  the headline accent. */
  assets: [
    { word: 'Bitcoin.',  glyph: '₿',  body: '#f2b544', rim: '#fff1c9', glyph_color: '#3a2600', accent: '#f2b544' },
    { word: 'Ethereum.', glyph: 'Ξ',  body: '#d9deee', rim: '#ffffff', glyph_color: '#2a3050', accent: '#c9d3ff' },
    { word: 'Solana.',   glyph: '◎',  body: '#1c1c26', rim: '#14f195', glyph_color: '#14f195', accent: '#14f195' },
    { word: 'Gold.',     glyph: 'Au', body: '#ffc84a', rim: '#fff4d0', glyph_color: '#4a2f00', accent: '#ffd166' },
    { word: 'XRP.',      glyph: '✕',  body: '#e6e9f0', rim: '#ffffff', glyph_color: '#0b0b0f', accent: '#e6e9f0' },
    { word: 'HYPE.',     glyph: 'H',  body: '#0f2a26', rim: '#97fce4', glyph_color: '#97fce4', accent: '#97fce4' },
  ],

  /** The two move words cycle through these pairs, one slot changing per tick. */
  moves: [['Up', 'down.'], ['Flat', 'down.'], ['Flat', 'wild.'], ['Up', 'wild.']],

  /** Seconds between move-word changes, and between coin rolls. Independent clocks. */
  moveTickSeconds: 1.7,
  coinRollEverySeconds: 3.4,
  coinRollDurationSeconds: 1.0,

  /** Price sources. First that answers wins. */
  priceEndpoints: [
    { url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', pick: j => +j.result.list[0].lastPrice },
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', pick: j => +j.bitcoin.usd },
  ],
  fallbackSpot: 80000,

  /** How the illustrative levels derive from spot. */
  heroZeroLinePct: 0.02,       // "clear this by tonight" line = spot * (1 + pct), rounded to $500
  expiryRingOffset: 6000,      // outer ring labels = spot ± this
  boardHalfWidth: 12000,       // board shows spot ± this, $1000 per row

  /** Worst-case readout beside the builder stack, per number of legs added. */
  builderWorstCase: ['−$250', '−$250', '−$250', '−$610', '−$610', '−$2,310'],
  builderUncappedFromLeg: 4,   // from this many legs on, the readout turns red and says UNCAPPED

  /** Section count must match the .stage elements in index.html. */
  sections: 7,

  /** Set true (or add ?debug to the URL) to expose window.gravitas for QA. */
  debug: new URLSearchParams(location.search).has('debug'),
};

const COLOR = {
  gold:  new THREE.Color('#f2b544'),
  win:   new THREE.Color('#19e08a'),
  loss:  new THREE.Color('#ff4d6d'),
  white: new THREE.Color('#f5f5f7'),
  dark:  new THREE.Color('#111118'),
  black: new THREE.Color('#050507'),
};

/* =========================================================================
   2. helpers
   ========================================================================= */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const ease = {
  outCubic:   t => 1 - Math.pow(1 - t, 3),
  inCubic:    t => t * t * t,
  inOutCubic: t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint:   t => 1 - Math.pow(1 - t, 5),
  inOutQuint: t => (t < .5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inQuad:     t => t * t,
};

const fmtUsd = v => '$' + Math.round(v).toLocaleString('en-US');

/** A plane with text painted on a canvas. `retext()` repaints it in place. */
function paintCanvas(canvas, { text, color, size, weight, family }) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function textPlane(text, width, color, size = 150, weight = '500', family = 'Space Grotesk, sans-serif') {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const spec = { text, color, size, weight, family };
  paintCanvas(canvas, spec);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width / 4),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  mesh.userData.textSpec = spec;
  mesh.userData.canvas = canvas;
  return mesh;
}

function retext(mesh, text) {
  const spec = mesh.userData.textSpec;
  if (spec.text === text) return;
  spec.text = text;
  paintCanvas(mesh.userData.canvas, spec);
  mesh.material.map.needsUpdate = true;
}

/* =========================================================================
   3. renderer
   ========================================================================= */

const canvas = $('#world');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = COLOR.black;
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), .04).texture;

const camera = new THREE.PerspectiveCamera(38, 1, .1, 120);
camera.position.set(0, .9, 12);

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }),
);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 12, aperture: .00016, maxblur: .011 });
composer.addPass(bokeh);
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), .22, .5, .92));
composer.addPass(new OutputPass());

function fitViewport() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitViewport);
fitViewport();

// Lights: warm key, cool fill, gold rim from behind.
scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0a10, .22));
const keyLight = new THREE.DirectionalLight(0xfff4e0, 2.4);
keyLight.position.set(5, 9, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8899ff, .45);
fillLight.position.set(-7, 2, 5);
scene.add(fillLight);
const rimLight = new THREE.PointLight(0xf2b544, 60, 40);
rimLight.position.set(-4, 5, -7);
scene.add(rimLight);

// Floor: dark, faintly reflective, with a soft contact shadow that scales with whatever is on stage.
const FLOOR_Y = -3.2;
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(60, 64),
  new THREE.MeshStandardMaterial({ color: 0x0a0a0f, roughness: .32, metalness: .75, envMapIntensity: .45 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
scene.add(floor);

const shadow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, 'rgba(0,0,0,.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: .9 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = FLOOR_Y + .01;
  scene.add(mesh);
  return mesh;
})();

/* =========================================================================
   4. price
   ========================================================================= */

let spot = CONFIG.fallbackSpot;

/** Every illustrative number on the page, derived from spot. */
function levelsFor(S) {
  const rounded = Math.round(S / 1000) * 1000;
  return {
    spot: rounded,
    heroZeroLine: Math.round(S * (1 + CONFIG.heroZeroLinePct) / 500) * 500,
    expiryHigh: rounded + CONFIG.expiryRingOffset,
    expiryLow: rounded - CONFIG.expiryRingOffset,
    boardStrike: row => rounded - CONFIG.boardHalfWidth + row * 1000,
  };
}

async function fetchSpot() {
  for (const { url, pick } of CONFIG.priceEndpoints) {
    try {
      const value = pick(await (await fetch(url)).json());
      if (value > 1000) return value;
    } catch { /* try the next source */ }
  }
  return null;
}

/* =========================================================================
   5. coins
   ========================================================================= */

// Pre-draw one face texture per asset.
for (const asset of CONFIG.assets) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  asset.faceCanvas = c;
  asset.faceTexture = new THREE.CanvasTexture(c);
  asset.faceTexture.colorSpace = THREE.SRGBColorSpace;
  asset.faceTexture.anisotropy = 8;
}
function drawFaces() {
  for (const a of CONFIG.assets) {
    paintCanvas(a.faceCanvas, {
      text: a.glyph, color: a.glyph_color, weight: 700,
      size: a.glyph.length > 1 ? 300 : 360, family: 'Space Grotesk, Inter, sans-serif',
    });
    a.faceTexture.needsUpdate = true;
  }
}
drawFaces();
document.fonts.ready.then(drawFaces); // redraw once the web font is in

/** A heavy metal coin. Body cylinder, two rim tori, a face on each side. */
function makeCoin(radius, thickness, asset = CONFIG.assets[0]) {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: asset.body, metalness: 1, roughness: .24, envMapIntensity: 1.2 });
  const rim = new THREE.MeshStandardMaterial({ color: asset.rim, metalness: 1, roughness: .22, envMapIntensity: .9 });
  const face = new THREE.MeshStandardMaterial({ map: asset.faceTexture, transparent: true, metalness: .85, roughness: .42, envMapIntensity: .9 });

  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, thickness, 96), body);
  cylinder.rotation.x = Math.PI / 2;
  group.add(cylinder);

  for (const side of [1, -1]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * .985, thickness * .22, 20, 120), rim);
    ring.position.z = side * thickness * .42;
    group.add(ring);

    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * .8, 72), face);
    disc.position.z = side * (thickness / 2 + .004);
    if (side < 0) disc.rotation.y = Math.PI;
    group.add(disc);
  }

  group.userData = { body, rim, face, targetBody: null, targetRim: null };
  return group;
}

/** Switch a coin to an asset. Colours tween in the frame loop; the face swaps immediately. */
function setCoinAsset(coin, asset) {
  coin.userData.targetBody = new THREE.Color(asset.body);
  coin.userData.targetRim = new THREE.Color(asset.rim);
  coin.userData.face.map = asset.faceTexture;
  coin.userData.face.needsUpdate = true;
}
function tweenCoin(coin) {
  const u = coin.userData;
  if (!u.targetBody) return;
  u.body.color.lerp(u.targetBody, .06);
  u.rim.color.lerp(u.targetRim, .06);
}

/* =========================================================================
   6. sections
   Each returns { group, update(state) }. `group.userData.restY` is where the
   object sits when on stage; place() handles arrival and departure.
   ========================================================================= */

function sectionGroup(restY, baseScale = 1) {
  const g = new THREE.Group();
  g.userData.restY = restY;
  g.userData.baseScale = baseScale;
  scene.add(g);
  return g;
}

/* ---- 0. Hero: the big coin that rolls through the assets ---- */
const hero = (() => {
  const group = sectionGroup(-1.15);
  const coin = makeCoin(2.15, .3);
  group.add(coin);

  let assetIndex = 0;
  let rollT = 1;            // 0..1 while rolling, 1 when idle
  let swapped = true;       // asset switched at the roll's midpoint
  let moveIndex = 0;
  let nextMoveTick = 2.4;
  let nextCoinRoll = 3.4;

  function update({ now, dt, u }) {
    coin.rotation.y = Math.sin(now * .28) * .55;
    coin.rotation.z = .05;

    if (rollT < 1) {
      rollT = Math.min(1, rollT + dt / CONFIG.coinRollDurationSeconds);
      const e = ease.inOutQuint(rollT);
      coin.rotation.x = e * Math.PI * 2;
      if (e > .5 && !swapped) {
        swapped = true;
        assetIndex = (assetIndex + 1) % CONFIG.assets.length;
        const a = CONFIG.assets[assetIndex];
        setCoinAsset(coin, a);
        headline.rollAsset(a);
      }
    } else {
      coin.rotation.x = 0;
    }

    // Both clocks only run while the hero is actually on screen.
    const onStage = u > -.3 && u < .3;
    if (onStage && now > nextMoveTick) {
      nextMoveTick = now + CONFIG.moveTickSeconds;
      moveIndex = (moveIndex + 1) % CONFIG.moves.length;
      headline.rollMoves(CONFIG.moves[moveIndex]);
    }
    if (onStage && now > nextCoinRoll && rollT >= 1) {
      nextCoinRoll = now + CONFIG.coinRollEverySeconds;
      rollT = 0;
      swapped = false;
    }
    tweenCoin(coin);
  }

  const debug = {
    set(asset, move) {
      assetIndex = asset; moveIndex = move;
      setCoinAsset(coin, CONFIG.assets[asset]);
      headline.setImmediate(CONFIG.assets[asset], CONFIG.moves[move]);
    },
    freeze() { nextMoveTick = nextCoinRoll = Infinity; },
  };
  return { group, update, shadowScale: 1.15, debug };
})();

/* ---- 1. Easy Options: the payoff slab that reshapes to the chosen move ---- */
const payoffSlab = (() => {
  const group = sectionGroup(-1.0);
  group.rotation.x = .55;

  const geo = new THREE.PlaneGeometry(11.5, 7, 90, 54);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const current = new Float32Array(pos.count);
  const target = new Float32Array(pos.count);

  const slab = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: .6, roughness: .28, envMapIntensity: .9, side: THREE.DoubleSide,
  }));
  group.add(slab);
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .05 }),
  );
  slab.add(wire);

  /** Normalised payoff for a move kind. x: moneyness -1..1, t: 0 today .. 1 expiry. */
  function payoff(kind, x, t) {
    const k = 1.4 + 5 * t;
    const sig = v => 1 / (1 + Math.exp(-v * k));
    const w = .36;
    let v;
    if (kind === 'up') v = sig(x / w) * 2 - 1;
    else if (kind === 'down') v = sig(-x / w) * 2 - 1;
    else if (kind === 'flat') v = 1 - 2 * sig((Math.abs(x) - w) / (w * .55));
    else v = 2 * sig((Math.abs(x) - w * .9) / (w * .7)) - 1;               // wild
    return v * (.55 + .45 * t);
  }

  const tmp = new THREE.Color();
  function setTarget(kind) {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / 5.75, z = pos.getZ(i) / 3.5;
      target[i] = payoff(kind, x, 1 - (z + 1) / 2) * 1.5;
    }
  }
  function paint() {
    for (let i = 0; i < pos.count; i++) {
      const y = current[i];
      pos.setY(i, y);
      tmp.copy(COLOR.dark).lerp(y >= 0 ? COLOR.win : COLOR.loss, .12 + .62 * Math.min(1, Math.abs(y) / 1.2));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    pos.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    wire.geometry.dispose();
    wire.geometry = new THREE.WireframeGeometry(geo);
  }

  setTarget('up');
  current.set(target);
  paint();

  $$('.pill').forEach(btn => btn.addEventListener('click', () => {
    $$('.pill').forEach(b => b.setAttribute('aria-pressed', b === btn));
    setTarget(btn.dataset.kind);
  }));

  function update({ now, u }) {
    group.rotation.y = u * .7 + Math.sin(now * .2) * .06;
    let moving = false;
    for (let i = 0; i < pos.count; i++) {
      const d = target[i] - current[i];
      if (Math.abs(d) > 1e-4) { current[i] += d * .09; moving = true; }
    }
    if (moving) paint();
  }
  return { group, update, shadowScale: 0 };
})();

/* ---- 2. Hero Zero: one gold line; your coin rises to it ---- */
const heroZero = (() => {
  const group = sectionGroup(-.95);
  const barMat = new THREE.MeshStandardMaterial({ color: COLOR.gold, emissive: COLOR.gold, emissiveIntensity: 1.4, metalness: .6, roughness: .3 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(19, .06, .06), barMat);
  bar.position.y = 1.15;
  group.add(bar);

  const label = textPlane(fmtUsd(levelsFor(spot).heroZeroLine) + ' by tonight', 4.6, 'rgba(242,181,68,.85)', 74);
  label.position.set(4.0, 1.62, 0);
  group.add(label);

  const coin = makeCoin(1.05, .16);
  const glow = new THREE.PointLight(0xf2b544, 0, 6);
  coin.add(glow);
  group.add(coin);

  function update({ now, story }) {
    const e = ease.inOutCubic(story);
    const y = lerp(-2.0, 3.3, e);
    coin.position.set(0, y, .6);
    coin.rotation.y = Math.sin(now * .6) * .35;
    coin.rotation.x = -e * 1.2;

    const cleared = clamp((y - bar.position.y) / .5, 0, 1);
    barMat.color.copy(COLOR.gold).lerp(COLOR.win, cleared);
    barMat.emissive.copy(COLOR.gold).lerp(COLOR.win, cleared);
    glow.color.copy(COLOR.gold).lerp(COLOR.win, cleared);
    glow.intensity = 2.5 + cleared * 14;

    const line = fmtUsd(levelsFor(spot).heroZeroLine);
    retext(label, cleared >= 1 ? `${line} · cleared · ×2` : `${line} by tonight`);
  }
  return { group, update, shadowScale: .7, label };
})();

/* ---- 3. Expiry Trading: a dish of rings; your coin settles into it ---- */
const expiryDish = (() => {
  const group = sectionGroup(-1.1, .74);
  const TILT = -.78;
  group.rotation.x = TILT;

  const ringSpecs = [[5.4, COLOR.loss, .5], [4.25, COLOR.white, .08], [3.1, COLOR.win, .7], [1.95, COLOR.white, .08], [.85, COLOR.gold, 1.2]];
  const edges = ringSpecs.map(([r, color, lit], i) => {
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, .14, 128),
      new THREE.MeshStandardMaterial({ color: 0x2a2a34, metalness: .8, roughness: .3, envMapIntensity: 1.0 }),
    );
    disc.position.y = -i * .11;
    group.add(disc);

    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(r, .045, 12, 160),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .5, metalness: .4, roughness: .4 }),
    );
    edge.rotation.x = Math.PI / 2;
    edge.position.y = -i * .11 + .07;
    group.add(edge);
    return { edge, lit };
  });

  const L = levelsFor(spot);
  const highLabel = textPlane(fmtUsd(L.expiryHigh), 3.2, 'rgba(245,245,247,.55)', 90);
  highLabel.rotation.x = -Math.PI / 2;
  highLabel.position.set(0, .09, -4.8);
  group.add(highLabel);
  const lowLabel = textPlane(fmtUsd(L.expiryLow), 3.2, 'rgba(245,245,247,.55)', 90);
  lowLabel.rotation.x = -Math.PI / 2;
  lowLabel.position.set(0, .09, 4.8);
  group.add(lowLabel);

  const coin = makeCoin(.95, .15);
  coin.rotation.x = Math.PI / 2;
  group.add(coin);

  function update({ now, u, story }) {
    group.rotation.x = TILT + u * .25;
    group.rotation.z = Math.sin(now * .15) * .04;

    const drop = clamp((story - .12) / .7, 0, 1);
    coin.position.set(.25, lerp(7, .62, ease.inQuad(drop)), .15);
    coin.rotation.z = (1 - drop) * .5;

    edges.forEach(({ edge, lit }, i) => {
      const on = clamp((story - .05 - i * .09) / .14, 0, 1);
      edge.material.emissiveIntensity = .5 + on * lit;
    });
  }
  return { group, update, shadowScale: 1.4, highLabel, lowLabel };
})();

/* ---- 4. Strategy Builder: six glass legs sliding into a stack ---- */
const builder = (() => {
  const group = sectionGroup(-.2);
  group.rotation.x = .14;

  const tints = [COLOR.win, COLOR.loss, COLOR.win, COLOR.white, COLOR.loss, COLOR.gold];
  const tmp = new THREE.Color();
  const legs = tints.map((tint, i) => {
    const w = 5.4 - i * .55;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, .5, w * .68),
      new THREE.MeshPhysicalMaterial({
        color: tmp.copy(COLOR.dark).lerp(tint, .55).clone(),
        metalness: .15, roughness: .14, transmission: .5, thickness: 1.4, ior: 1.4, envMapIntensity: 1.1,
      }),
    );
    mesh.userData = { restY: -2.05 + i * .56, fromX: i % 2 ? 9.5 : -9.5 };
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });

  const readout = textPlane('MAX LOSS  −$250', 6.2, 'rgba(245,245,247,.75)', 54, '500', 'JetBrains Mono, monospace');
  readout.position.set(3.9, 1.2, 0);
  readout.visible = false;
  group.add(readout);

  function update({ now, u, story }) {
    group.rotation.y = .55 + u * .5 + Math.sin(now * .12) * .08;
    let landed = 0;
    legs.forEach((leg, i) => {
      const local = clamp((story - i * .11) / .3, 0, 1);
      const e = ease.outQuint(local);
      leg.visible = local > 0;
      leg.position.x = lerp(leg.userData.fromX, 0, e);
      leg.position.y = leg.userData.restY + (1 - e) * 1.6;
      leg.rotation.y = (1 - e) * .4 * (i % 2 ? -1 : 1);
      if (local >= 1) landed = i + 1;
    });

    readout.visible = landed > 0;
    if (landed > 0) {
      const uncapped = landed >= CONFIG.builderUncappedFromLeg;
      retext(readout, 'MAX LOSS  ' + CONFIG.builderWorstCase[landed - 1] + (uncapped ? '  ·  UNCAPPED' : ''));
      readout.material.color.set(uncapped ? '#ff4d6d' : '#f5f5f7');
    }
    readout.position.y = -2.05 + Math.max(1, landed) * .56 + .4;
    readout.lookAt(camera.position);
  }
  return { group, update, shadowScale: 1.1 };
})();

/* ---- 5. The Board: a tunnel of strikes you dolly through ---- */
const board = (() => {
  const group = sectionGroup(.3);
  const ROWS = CONFIG.boardHalfWidth / 1000 * 2;       // 24 rows + 1
  const MID = ROWS / 2;
  const labels = [];

  for (let i = 0; i <= ROWS; i++) {
    const z = -(i - MID) * 1.6;
    const m = Math.abs(i - MID) / 60;
    const liquidity = Math.max(.06, Math.exp(-m * m * 260) * ((i - MID) % 5 === 0 ? 1 : .55));
    const spread = 1.4 + (1 - liquidity) * 2.4;

    for (const [color, x] of [[COLOR.win, -(3 + spread / 2)], [COLOR.loss, 3 + spread / 2]]) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(.55, .2 + liquidity * 1.9, .34),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .15 + liquidity * .9, metalness: .5, roughness: .35 }),
      );
      bar.position.set(x, 0, z);
      group.add(bar);
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5.1, .018, 8, 120),
      new THREE.MeshBasicMaterial({ color: COLOR.white, transparent: true, opacity: .04 + liquidity * .16 }),
    );
    ring.position.z = z;
    group.add(ring);

    if (i % 4 === 0) {
      const label = textPlane(fmtUsd(levelsFor(spot).boardStrike(i)), 3.6, 'rgba(245,245,247,.6)', 86);
      label.position.set(0, -1.9, z);
      label.userData.row = i;
      group.add(label);
      labels.push(label);
    }
  }
  const spotRing = new THREE.Mesh(
    new THREE.TorusGeometry(5.0, .06, 10, 160),
    new THREE.MeshStandardMaterial({ color: COLOR.gold, emissive: COLOR.gold, emissiveIntensity: 1.2 }),
  );
  group.add(spotRing);

  function update({ now, story }) {
    group.position.z += lerp(-14, 9, ease.inOutCubic(story));   // dolly through
    group.rotation.z = Math.sin(now * .2) * .03;
  }
  return { group, update, shadowScale: 0, labels, focusFollows: true };
})();

/* ---- 6. Close: the coin comes back beside the button ---- */
const closing = (() => {
  const group = sectionGroup(-1.3);
  const coin = makeCoin(1.9, .28);
  coin.position.x = 3.4;
  group.add(coin);
  function update({ now }) {
    coin.rotation.y = now * .35;
    coin.rotation.x = .25;
  }
  return { group, update, shadowScale: 1 };
})();

const SECTIONS = [hero, payoffSlab, heroZero, expiryDish, builder, board, closing];
if (SECTIONS.length !== CONFIG.sections) console.warn('CONFIG.sections does not match the built sections');

/** Rewrite every price label from a new spot. */
function applySpot(S) {
  if (!(S > 1000)) return;
  spot = S;
  const L = levelsFor(S);
  retext(heroZero.label, fmtUsd(L.heroZeroLine) + ' by tonight');
  retext(expiryDish.highLabel, fmtUsd(L.expiryHigh));
  retext(expiryDish.lowLabel, fmtUsd(L.expiryLow));
  board.labels.forEach(l => retext(l, fmtUsd(L.boardStrike(l.userData.row))));
}
fetchSpot().then(S => S && applySpot(S));

/* =========================================================================
   7. scroll + frame
   ========================================================================= */

const stages = $$('.stage');
const rail = $('#rail');
for (let i = 0; i < CONFIG.sections; i++) rail.appendChild(document.createElement('i'));

let progressTarget = 0;   // straight from scrollY
let progress = 0;         // smoothed
addEventListener('scroll', () => {
  const max = document.body.scrollHeight - innerHeight;
  progressTarget = clamp(scrollY / max, 0, 1);
}, { passive: true });

/**
 * Position a section's group for the current scroll.
 * u = f - index: negative while approaching, 0 on stage, positive while leaving.
 * Objects are hidden outside (-.55, .45) so no two sections ever share a frame.
 * Returns null when hidden, else { u, story } where story runs 0..1 across the dwell.
 */
function place(group, index, f) {
  const u = f - index;
  group.visible = u > -.55 && u < .45;
  if (!group.visible) return null;

  const arrive = u < 0 ? ease.outCubic(clamp((u + .55) / .5, 0, 1)) : 1;
  const depart = u > 0 ? ease.inCubic(clamp(u / .45, 0, 1)) : 0;

  group.position.z = lerp(-20, 0, arrive) - depart * 14;
  group.position.y = group.userData.restY - (1 - arrive) * 1.6 - depart * 1.2;
  group.scale.setScalar(lerp(.75, 1, arrive) * (1 - depart * .45) * group.userData.baseScale);

  return { u, story: clamp((u + .38) / .8, 0, 1), presence: clamp(1 - Math.abs(u) * 1.8, 0, 1) };
}

let activeSection = -1;
let lastTime = performance.now();
const focusPoint = new THREE.Vector3();

function frame() {
  const t = performance.now();
  const dt = Math.min(.05, (t - lastTime) / 1000);
  lastTime = t;
  const now = t / 1000;

  progress += (progressTarget - progress) * (1 - Math.pow(.0006, dt));
  const f = progress * (CONFIG.sections - 1);
  const section = clamp(Math.round(f), 0, CONFIG.sections - 1);

  // Copy fades and nudges with the scene.
  stages.forEach((stage, i) => {
    const u = f - i;
    const opacity = clamp(1 - Math.abs(u) * 2.4, 0, 1);
    stage.style.opacity = opacity;
    stage.style.transform = `translateY(${-u * 70}px)`;
    stage.style.pointerEvents = opacity > .5 ? 'auto' : 'none';
  });

  if (section !== activeSection) {
    activeSection = section;
    [...rail.children].forEach((dot, i) => dot.classList.toggle('on', i === section));
    $('#hint').style.opacity = section === CONFIG.sections - 1 ? 0 : 1;
  }

  camera.position.x = Math.sin(now * .11) * .35;
  camera.position.y = .9 + Math.sin(now * .17) * .12;
  camera.lookAt(0, .15, 0);

  let shadowScale = 0;
  let focusZ = 0;
  SECTIONS.forEach((s, i) => {
    const r = place(s.group, i, f);
    if (!r) return;
    s.update({ now, dt, u: r.u, story: r.story });
    shadowScale = Math.max(shadowScale, r.presence * s.shadowScale);
    if (s.focusFollows) focusZ = s.group.position.z;
  });

  shadow.scale.setScalar(Math.max(.001, shadowScale));
  focusPoint.set(0, 0, SECTIONS[section].focusFollows ? clamp(focusZ, -6, 6) : 0);
  bokeh.uniforms.focus.value = camera.position.distanceTo(focusPoint);

  composer.render();
  requestAnimationFrame(frame);
}

/* =========================================================================
   8. hero word roll
   ========================================================================= */

const headline = (() => {
  const slots = { asset: '#slot-asset', moveA: '#slot-move-a', moveB: '#slot-move-b' };
  const measureEl = $('#measure');

  function measure(slotSel, text) {
    const el = $(slotSel);
    const cs = getComputedStyle(el);
    measureEl.style.font = cs.font;
    measureEl.style.letterSpacing = cs.letterSpacing;
    measureEl.textContent = text;
    return measureEl.getBoundingClientRect().width + parseFloat(cs.fontSize) * .08;
  }
  function fit(slotSel, text) {
    $(slotSel).style.width = Math.ceil(measure(slotSel, text)) + 'px';
  }
  function roll(slotSel, text) {
    const word = $(slotSel).firstElementChild;
    if (word.textContent === text) return;
    fit(slotSel, text);
    word.classList.add('out');
    setTimeout(() => {
      word.textContent = text;
      word.classList.remove('out');
      word.classList.add('pre');
      void word.offsetWidth;           // restart the transition
      word.classList.remove('pre');
    }, 380);
  }
  function fitAll() {
    for (const sel of Object.values(slots)) fit(sel, $(sel).firstElementChild.textContent);
  }
  addEventListener('resize', fitAll);
  document.fonts.ready.then(fitAll);

  return {
    rollAsset(asset) {
      roll(slots.asset, asset.word);
      $(slots.asset).style.color = asset.accent;
    },
    rollMoves([a, b]) {
      roll(slots.moveA, a);
      roll(slots.moveB, b);
    },
    setImmediate(asset, [a, b]) {
      $(slots.asset).firstElementChild.textContent = asset.word;
      $(slots.asset).style.color = asset.accent;
      $(slots.moveA).firstElementChild.textContent = a;
      $(slots.moveB).firstElementChild.textContent = b;
      fitAll();
    },
  };
})();

/* ---------- debug hooks (only with ?debug in the URL) ---------- */
if (CONFIG.debug) {
  window.gravitas = {
    setProgress(v) { progressTarget = progress = clamp(v, 0, 1); },
    setHero: hero.debug.set,
    freeze: hero.debug.freeze,
    setSpot: applySpot,
  };
}

frame();
