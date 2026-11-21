/**
 * preview - renders what the effects actually LOOK like. `effectproof.mjs`
 * proves the segments differ; it says nothing about whether an effect is any
 * good. Each effect gets its own time scale (`preview.seconds` in
 * `effects.json`); why that, and why time is stepped: `docs/TOOLS.md`.
 *
 * usage: node tools/preview.mjs [default seconds]
 *   -> tools/preview.html   (live animation, grouped grid)
 *   -> tools/preview.png    (contact sheet, no browser needed)
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EffectEngine, loadEffects } from "../extension/huelink-lib/effects/index.mjs";
import { drawText, textWidth } from "./font5x7.mjs";

/** Minimal PNG writer: one IDAT, filter 0. No dependencies. */
function png(width, height, rgb) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + width * 3)] = 0;
        rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SEGMENTS = 7;
const FPS = 25;
const ROWS = 280; // filmstrip height; the same for all, so they compare
const DEFAULT_SECONDS = Number(process.argv[2] ?? 20);
const SEED = 20261116;

const effects = await loadEffects(console);
if (!effects.length) {
    console.error("no valid effects; see the errors above");
    process.exit(1);
}
const engine = new EffectEngine({ effects, segments: SEGMENTS, seed: SEED });

/**
 * Runs an effect for `seconds` in real 1/FPS steps and returns ROWS frames
 * sampled evenly across it.
 */
function filmstrip(name, seconds) {
    engine.select(name);
    const total = Math.max(Math.round(seconds * FPS), ROWS);
    const every = total / ROWS;
    const out = [];
    let next = 0;
    for (let f = 0; f < total && out.length < ROWS; f++) {
        const frame = engine.frame(1_000_000 + (f * 1000) / FPS);
        if (f >= next) {
            out.push(frame.map((c) => [c.r, c.g, c.b]));
            next += every;
        }
    }
    while (out.length < ROWS) out.push(out[out.length - 1]);
    return out;
}

const data = effects.map((e) => {
    const seconds = e.preview?.seconds ?? DEFAULT_SECONDS;
    return { name: e.name, kind: e.kind, seconds, frames: filmstrip(e.name, seconds) };
});

// Names carry a group prefix in the HA list; grouped by the same prefix here
// so the page reads like that list does on a phone.
const groups = [];
for (const fx of data) {
    const [head, tail] = fx.name.includes(": ") ? fx.name.split(/:\s(.+)/) : ["Other", fx.name];
    const g = groups.find((x) => x.title === head) ?? (groups.push({ title: head, items: [] }), groups.at(-1));
    g.items.push({ ...fx, short: tail });
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>huelink effects</title>
<style>
 body{background:#0b0b0e;color:#e4e4e8;font:13px/1.45 ui-monospace,"DejaVu Sans Mono",monospace;
      margin:0;padding:22px 24px 30px}
 h1{font-size:17px;font-weight:600;margin:0 0 3px}
 .sub{color:#7a7a84;margin:0 0 18px;font-size:12px}
 h2{font-size:13px;font-weight:600;margin:22px 0 10px;color:#9fd8ff;
    border-bottom:1px solid #23232c;padding-bottom:5px}
 .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
 .fx{background:#131318;border:1px solid #1e1e26;border-radius:8px;padding:10px 10px 8px}
 .nm{font-weight:600;font-size:13px;margin-bottom:1px}
 .meta{color:#70707c;font-size:11px;margin-bottom:7px}
 .strip{display:flex;height:30px;border-radius:5px;overflow:hidden;margin-bottom:7px;
        box-shadow:0 0 14px rgba(0,0,0,.55)}
 .seg{flex:1;transition:background-color 40ms linear}
 canvas{display:block;width:100%;height:150px;border-radius:4px;image-rendering:pixelated}
 .cap{color:#5c5c66;font-size:10px;margin-top:4px}
</style>
<h1>huelink effects &mdash; ${data.length} themes, 7 segments</h1>
<p class=sub>Each card shows a live strip on top and a filmstrip below: time downwards, segments to the right.
Every effect has its own time scale (printed under its name), because a sunrise and a disco do not share one.</p>
${groups
    .map(
        (g) => `<h2>${g.title}</h2><div class=grid>${g.items
            .map(
                (fx) => `<div class=fx data-name="${fx.name}">
  <div class=nm>${fx.short}</div>
  <div class=meta>${fx.kind} &middot; ${fx.seconds} s</div>
  <div class=strip>${"<div class=seg></div>".repeat(SEGMENTS)}</div>
  <canvas width=${SEGMENTS} height=${ROWS}></canvas>
  <div class=cap>${fx.seconds} s &rarr; ${ROWS} rows</div>
</div>`,
            )
            .join("")}</div>`,
    )
    .join("")}
<script>
const DATA = ${JSON.stringify(data.map(({ name, frames }) => ({ name, frames })))};
const FPS = ${FPS};
for (const fx of DATA) {
  const box = document.querySelector('[data-name="' + fx.name.replace(/"/g, '&quot;') + '"]');
  if (!box) continue;
  const segs = [...box.querySelectorAll('.seg')];
  const cv = box.querySelector('canvas').getContext('2d');
  const img = cv.createImageData(${SEGMENTS}, fx.frames.length);
  fx.frames.forEach((fr, y) => fr.forEach((c, x) => {
    const o = (y * ${SEGMENTS} + x) * 4;
    img.data[o] = c[0]; img.data[o+1] = c[1]; img.data[o+2] = c[2]; img.data[o+3] = 255;
  }));
  cv.putImageData(img, 0, 0);
  let i = 0;
  setInterval(() => {
    const fr = fx.frames[i++ % fx.frames.length];
    fr.forEach((c, n) => segs[n].style.backgroundColor = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
  }, 1000 / FPS);
}
</script>
`;

const out = join(HERE, "preview.html");
writeFileSync(out, html);

// ---------------------------------------------------------------------------
// Contact sheet: one PNG with EVERY effect, grouped and labelled. This is the
// image an effect is accepted or dropped on, so it has to stand alone: without
// labels, 25 coloured columns say nothing. Hence the hand-rolled font.
const CELL = 22; // one segment's width in pixels
const STRIP_W = SEGMENTS * CELL;
const COLS = 7;
const PAD = 26;
const LABEL_H = 32; // two label rows above the filmstrip
const CARD_H = LABEL_H + ROWS + 20;
const HEAD_H = 58;
const GROUP_H = 34;

const BG = [0x10, 0x10, 0x14];
const FG = [0xe6, 0xe6, 0xec];
const DIM = [0x82, 0x82, 0x8e];
const ACCENT = [0x8f, 0xd0, 0xff];

const rowsOf = (n) => Math.ceil(n / COLS);
const imgW = PAD + COLS * (STRIP_W + PAD);
const imgH = HEAD_H + groups.reduce((h, g) => h + GROUP_H + rowsOf(g.items.length) * CARD_H, 0) + PAD;

const buf = Buffer.alloc(imgW * imgH * 3);
for (let i = 0; i < imgW * imgH; i++) {
    buf[i * 3] = BG[0];
    buf[i * 3 + 1] = BG[1];
    buf[i * 3 + 2] = BG[2];
}

const hline = (x, y, w, color) => {
    for (let dx = 0; dx < w; dx++) {
        const o = (y * imgW + x + dx) * 3;
        buf[o] = color[0];
        buf[o + 1] = color[1];
        buf[o + 2] = color[2];
    }
};

drawText(buf, imgW, imgH, PAD, 10, `HUELINK EFFECTS: ${data.length} THEMES ON 7 SEGMENTS`, FG, 3);
drawText(buf, imgW, imgH, PAD, 38, "FILMSTRIP: TIME DOWNWARDS, SEGMENTS TO THE RIGHT. TIME SCALE UNDER THE NAME.", DIM, 2);

let cursorY = HEAD_H;
for (const g of groups) {
    drawText(buf, imgW, imgH, PAD, cursorY, g.title.toUpperCase(), ACCENT, 2);
    hline(PAD, cursorY + 26, imgW - 2 * PAD, [0x28, 0x28, 0x32]);
    cursorY += GROUP_H;

    g.items.forEach((fx, i) => {
        const x0 = PAD + (i % COLS) * (STRIP_W + PAD);
        const y0 = cursorY + Math.floor(i / COLS) * CARD_H;
        // A long name would otherwise run into the neighbouring column and
        // make both unreadable, so the scale is picked by what fits.
        const label = fx.short.toUpperCase();
        const fit = textWidth(label, 2) <= STRIP_W + PAD - 8 ? 2 : 1;
        drawText(buf, imgW, imgH, x0, y0 + (fit === 2 ? 0 : 4), label, FG, fit);
        drawText(buf, imgW, imgH, x0, y0 + 18, `${fx.kind} ${fx.seconds}S`.toUpperCase(), DIM, 1);
        for (let y = 0; y < ROWS; y++) {
            fx.frames[y].forEach(([r, gr, b], s) => {
                for (let dx = 0; dx < CELL; dx++) {
                    const o = ((y0 + LABEL_H + y) * imgW + x0 + s * CELL + dx) * 3;
                    buf[o] = r;
                    buf[o + 1] = gr;
                    buf[o + 2] = b;
                }
            });
        }
    });
    cursorY += rowsOf(g.items.length) * CARD_H;
}

const pngPath = join(HERE, "preview.png");
writeFileSync(pngPath, png(imgW, imgH, buf));

console.error(`wrote ${out}`);
console.error(`wrote ${pngPath}  (${imgW}x${imgH})`);
for (const fx of data) console.error(`  ${fx.name.padEnd(28)} ${fx.kind.padEnd(8)} ${fx.seconds}s`);
