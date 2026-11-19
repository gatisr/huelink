/**
 * font5x7 - a tiny bitmap font for the labels in the preview image. Why a hand
 * rolled font and not a browser screenshot: `docs/TOOLS.md`.
 *
 * Uppercase only. Accented letters are composed from a base letter plus a mark
 * above or below, so none of them needs a glyph of its own.
 *
 * The cell is 5x7 for the letter plus 2 rows above (macron, caron) and 2 below
 * (comma), 5x11 in total.
 */

const G = {
    A: ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    B: "####.|#...#|#...#|####.|#...#|#...#|####.",
    C: ".###.|#...#|#....|#....|#....|#...#|.###.",
    D: "####.|#...#|#...#|#...#|#...#|#...#|####.",
    E: "#####|#....|#....|####.|#....|#....|#####",
    F: "#####|#....|#....|####.|#....|#....|#....",
    G: ".###.|#...#|#....|#.###|#...#|#...#|.###.",
    H: "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    I: "#####|..#..|..#..|..#..|..#..|..#..|#####",
    J: "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    K: "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    L: "#....|#....|#....|#....|#....|#....|#####",
    M: "#...#|##.##|#.#.#|#...#|#...#|#...#|#...#",
    N: "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
    O: ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    P: "####.|#...#|#...#|####.|#....|#....|#....",
    Q: ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    R: "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    S: ".####|#....|#....|.###.|....#|....#|####.",
    T: "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    U: "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    V: "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    W: "#...#|#...#|#...#|#...#|#.#.#|##.##|#...#",
    X: "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    Y: "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    Z: "#####|....#|...#.|..#..|.#...|#....|#####",
    0: ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
    1: "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
    2: ".###.|#...#|....#|...#.|..#..|.#...|#####",
    3: "#####|...#.|..#..|...#.|....#|#...#|.###.",
    4: "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
    5: "#####|#....|####.|....#|....#|#...#|.###.",
    6: "..##.|.#...|#....|####.|#...#|#...#|.###.",
    7: "#####|....#|...#.|..#..|.#...|.#...|.#...",
    8: ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
    9: ".###.|#...#|#...#|.####|....#|...#.|.##..",
    " ": ".....|.....|.....|.....|.....|.....|.....",
    ":": ".....|..#..|..#..|.....|..#..|..#..|.....",
    ".": ".....|.....|.....|.....|.....|.....|..#..",
    "!": "..#..|..#..|..#..|..#..|..#..|.....|..#..",
    "-": ".....|.....|.....|.###.|.....|.....|.....",
    "/": "....#|....#|...#.|..#..|.#...|#....|#....",
    "%": "##..#|##..#|...#.|..#..|.#...|#..##|#..##",
    "(": "...#.|..#..|.#...|.#...|.#...|..#..|...#.",
    ")": ".#...|..#..|...#.|...#.|...#.|..#..|.#...",
};

/** Macron, caron and the comma below a letter. 5 wide, 2 rows. */
const MARK = {
    macron: ["", ".###."],
    caron: ["#...#", "..#.."],
    comma: ["..#..", ".#..."],
};

/** Accented letters = base letter + mark. None has a pattern of its own. */
const DIACRITIC = {
    Ā: ["A", "macron"],
    Ē: ["E", "macron"],
    Ī: ["I", "macron"],
    Ū: ["U", "macron"],
    Č: ["C", "caron"],
    Š: ["S", "caron"],
    Ž: ["Z", "caron"],
    Ģ: ["G", "comma"],
    Ķ: ["K", "comma"],
    Ļ: ["L", "comma"],
    Ņ: ["N", "comma"],
};

export const CELL_W = 5;
export const CELL_H = 11; // 2 above + 7 letter + 2 below
const TOP = 2; // the row the letter itself starts on
export const ADVANCE = 6; // letter pitch (5 + 1 space)

/**
 * One character's dots as [x, y] within a CELL_W x CELL_H cell. An unknown
 * character yields blank rather than throwing: a label is not worth a crash.
 */
function glyph(ch) {
    const up = ch.toUpperCase();
    const [base, mark] = DIACRITIC[up] ?? [up, null];
    const rows = (G[base] ?? G[" "]).split("|");
    const dots = [];
    rows.forEach((row, y) => {
        [...row].forEach((c, x) => {
            if (c === "#") dots.push([x, TOP + y]);
        });
    });
    if (mark === "comma") {
        MARK.comma.forEach((row, y) =>
            [...row].forEach((c, x) => {
                if (c === "#") dots.push([x, TOP + 7 + y]);
            }),
        );
    } else if (mark) {
        MARK[mark].forEach((row, y) =>
            [...row].forEach((c, x) => {
                if (c === "#") dots.push([x, y]);
            }),
        );
    }
    return dots;
}

/** Text width in pixels at the given `scale`. */
export function textWidth(text, scale = 1) {
    return text.length * ADVANCE * scale;
}

/**
 * Draws text into an RGB buffer (3 bytes per pixel, rows in order). `x`, `y`
 * is the top-left of the label; `y` is the cell top, so the letter itself
 * starts 2*scale pixels lower.
 */
export function drawText(buf, width, height, x, y, text, color, scale = 1) {
    let cx = x;
    for (const ch of text) {
        for (const [gx, gy] of glyph(ch)) {
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const px = cx + gx * scale + dx;
                    const py = y + gy * scale + dy;
                    if (px < 0 || py < 0 || px >= width || py >= height) continue;
                    const o = (py * width + px) * 3;
                    buf[o] = color[0];
                    buf[o + 1] = color[1];
                    buf[o + 2] = color[2];
                }
            }
        }
        cx += ADVANCE * scale;
    }
}
