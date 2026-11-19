/**
 * huepack - Philips Hue "entertainment" Zigbee frame encoder.
 *
 * Pure functions over data: no UDP, no MQTT, no zigbee2mqtt. Takes RGB colours
 * (one per segment) and returns the bytes for a ZCL command.
 *
 * The frame format, the quantisation and the byte-for-byte proof against a
 * real Hue bridge are in docs/PROTOCOL.md.
 */

// Wide-gamut bounds xy is quantised against (Bifrost: WIDE_GAMUT_MAX_X/Y).
const WIDE_GAMUT_MAX_X = 0.7347;
const WIDE_GAMUT_MAX_Y = 0.8264;

// sRGB -> XYZ. The same matrix and gamma zigbee-herdsman-converters uses in
// `ColorRGB.toXY`, so a streamed colour matches a normal `move_to_color`.
// Using Bifrost's wide-gamut D50 matrix without gamma rendered blue as
// fuchsia. See docs/PROTOCOL.md.
const M_RGB_TO_XYZ = [
    0.664511, 0.154324, 0.162028, //
    0.283881, 0.668433, 0.047685, //
    0.000088, 0.07231, 0.986039,
];

// D65 white point. Black (0,0,0) falls here, where xy is undefined.
const D65 = { x: 0.3127, y: 0.329 };

export const CLUSTER = 0xfc01;
export const MFC = 0x100b; // PHILIPS_HUE_ZIGBEE_VENDOR_ID
export const CMD_FRAME = 1;
export const CMD_RESET = 3;
export const ATTR_LIGHT_BALANCE = 5;
export const CMD_SEGMENT_MAP = 7;
export const DEFAULT_SMOOTHING = 0x0400;
export const SMOOTHING_MAX_MICROS = 2_560_000;

export const MODE_SEGMENT = 0b00000;
export const MODE_DEVICE = 0b01011;

/**
 * LCX002 (Hue Play gradient lightstrip 65) gradient profile, copied from
 * Bifrost and confirmed against a real bridge. These are data, not guesses.
 */
export const GRADIENT_LCX002 = {
    pixelCount: 20,
    pointsCapable: 5,
    segments: [
        { start: 0, length: 2 },
        { start: 2, length: 2 },
        { start: 4, length: 4 },
        { start: 8, length: 4 },
        { start: 12, length: 4 },
        { start: 16, length: 2 },
        { start: 18, length: 2 },
    ],
};

function mult(m, d) {
    return [
        d[0] * m[0] + d[1] * m[1] + d[2] * m[2],
        d[0] * m[3] + d[1] * m[4] + d[2] * m[5],
        d[0] * m[6] + d[1] * m[7] + d[2] * m[8],
    ];
}

/** sRGB gamma -> linear light. Hyperion sends display bytes, not linear ones. */
function gammaToLinear(c8) {
    const c = c8 / 255.0;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
}

/**
 * RGB (0..255) -> { xy, brightness 0..255 }. Black returns D65 at brightness 0.
 *
 * Brightness is the largest GAMMA-ENCODED channel, not linear Y. Not
 * physically correct, but linear Y would darken mid-tones ~2.4x. See
 * docs/PROTOCOL.md.
 */
export function rgbToXy(r8, g8, b8) {
    const [cx, cy, cz] = mult(M_RGB_TO_XYZ, [
        gammaToLinear(r8),
        gammaToLinear(g8),
        gammaToLinear(b8),
    ]);
    const sum = cx + cy + cz;
    if (sum > Number.EPSILON) {
        return { x: cx / sum, y: cy / sum, brightness: Math.max(r8, g8, b8) };
    }
    return { x: D65.x, y: D65.y, brightness: 0.0 };
}

/** Rust `as u16`: truncate toward zero, saturate to 0..65535. */
function asU16(v) {
    if (Number.isNaN(v)) return 0;
    const t = Math.trunc(v);
    return t < 0 ? 0 : t > 0xffff ? 0xffff : t;
}

/** xy -> 3 bytes, 12+12 bits packed (Bifrost `XY::to_quant`). */
export function quantXy(x, y) {
    const qx = asU16((x * 0xfff) / WIDE_GAMUT_MAX_X);
    const qy = asU16((y * 0xfff) / WIDE_GAMUT_MAX_Y);
    return [qx & 0xff, ((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4), (qy >> 4) & 0xff];
}

/** Fade duration in milliseconds -> the `smoothing` field. */
export function smoothingFromMs(ms) {
    const us = Math.round(ms * 1000);
    if (us < 0 || us >= SMOOTHING_MAX_MICROS) {
        throw new RangeError(`smoothing ${ms} ms is outside 0..2560 ms`);
    }
    return Math.trunc((us * 0x10000) / SMOOTHING_MAX_MICROS);
}

/** One 7-byte light record. `color` is {r,g,b} 0..255. */
function lightRecord(addr, color, mode) {
    const { x, y, brightness } = rgbToXy(color.r, color.g, color.b);
    // Bifrost: (bright / 255.0 * 2047.0).clamp(1.0, 2047.0) as u16
    const bri = Math.trunc(Math.min(Math.max((brightness / 255.0) * 2047.0, 1.0), 2047.0));
    const [c0, c1, c2] = quantXy(x, y);
    const field = ((bri << 5) | mode) & 0xffff;
    return [addr & 0xff, (addr >> 8) & 0xff, field & 0xff, (field >> 8) & 0xff, c0, c1, c2];
}

/**
 * Frame payload (cmd 1 `data`).
 *
 * @param {number} counter    monotonic frame number (u32, wraps)
 * @param {number} smoothing  fade field (see smoothingFromMs)
 * @param {Array<{addr:number,color:{r:number,g:number,b:number},mode?:number}>} lights
 * @returns {number[]} bytes
 */
export function encodeFrame(counter, smoothing, lights) {
    const c = counter >>> 0;
    const out = [
        c & 0xff,
        (c >>> 8) & 0xff,
        (c >>> 16) & 0xff,
        (c >>> 24) & 0xff,
        smoothing & 0xff,
        (smoothing >> 8) & 0xff,
    ];
    for (const l of lights) {
        out.push(...lightRecord(l.addr, l.color, l.mode ?? MODE_SEGMENT));
    }
    return out;
}

/** Stream boundary payload (cmd 3 `data`). */
export function encodeReset(counter) {
    const c = counter >>> 0;
    return [0x00, 0x01, c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff];
}

/** Segment map payload (cmd 7 `data`). Count is big-endian, addresses little. */
export function encodeSegmentMap(addrs) {
    const out = [(addrs.length >> 8) & 0xff, addrs.length & 0xff];
    for (const a of addrs) {
        out.push(a & 0xff, (a >> 8) & 0xff);
    }
    return out;
}

/** Segment addresses for a strip: network address + segment index. */
export function segmentAddrs(networkAddress, count) {
    return Array.from({ length: count }, (_, i) => (networkAddress + i) & 0xffff);
}

/**
 * Transport-independent description of the ZCL call.
 * `zigbee-herdsman`: endpoint.zclCommand(cluster, command, payload, options,
 *                                        {}, false, Zcl.FrameType.SPECIFIC)
 * `zigbee2mqtt` MQTT: {"zclcommand": {...this...}}
 */
export function zclCommand(command, data) {
    return {
        cluster: CLUSTER,
        command,
        payload: { data },
        frametype: 1,
        options: {
            manufacturerCode: MFC,
            disableDefaultResponse: true,
            direction: 0,
            timeout: 100.0,
            // A frame is fire-and-forget. Waiting for a reply queues every
            // frame until its APS ack, the ZNP queue overflows and fps drops
            // below one. See docs/PROTOCOL.md.
            disableResponse: true,
            disableRecovery: true,
        },
    };
}

/**
 * Entertainment brightness balance. Not a command but an attribute write:
 * cluster 0xFC01, attribute 5, uint8. Bifrost writes 0xFE just before a stream.
 */
export function lightBalanceWrite(value = 0xfe) {
    return {
        cluster: CLUSTER,
        attribute: ATTR_LIGHT_BALANCE,
        type: 0x20,
        value,
        options: { manufacturerCode: MFC },
    };
}
