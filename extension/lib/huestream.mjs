/**
 * huestream - the entertainment stream LIFECYCLE: start, frame counter, end.
 * Byte encoding lives in `huepack.mjs`; this file knows nothing about colour.
 *
 * The transport is injected and is one object with two methods:
 *   zclCommand({cluster, command, payload, frametype, options})
 *   writeAttribute({cluster, attribute, type, value, options})
 * So the same module runs inside z2m and against the test harness.
 *
 * Start order was observed from a real Hue bridge. See docs/PROTOCOL.md.
 */

import {
    CMD_FRAME,
    CMD_RESET,
    CMD_SEGMENT_MAP,
    DEFAULT_SMOOTHING,
    MODE_SEGMENT,
    encodeFrame,
    encodeReset,
    encodeSegmentMap,
    lightBalanceWrite,
    segmentAddrs,
    smoothingFromMs,
    zclCommand,
} from "./huepack.mjs";

export class HueStream {
    /**
     * @param {object} opts
     * @param {{zclCommand:Function, writeAttribute:Function}} opts.transport
     * @param {number} opts.networkAddress  the strip's Zigbee network address
     * @param {number} [opts.segments]      gradient segments (LCX002 = 7)
     * @param {number} [opts.smoothingMs]   fade time between frames
     */
    constructor({ transport, networkAddress, segments = 7, smoothingMs = null }) {
        this.transport = transport;
        this.addrs = segmentAddrs(networkAddress, segments);
        this.segments = segments;
        this.smoothing = smoothingMs === null ? DEFAULT_SMOOTHING : smoothingFromMs(smoothingMs);
        this.counter = 0;
        this.running = false;
    }

    async start() {
        if (this.running) return;
        await this.transport.zclCommand(zclCommand(CMD_RESET, encodeReset(this.counter)));
        await this.transport.writeAttribute(lightBalanceWrite(0xfe));
        if (this.segments > 1) {
            await this.transport.zclCommand(
                zclCommand(CMD_SEGMENT_MAP, encodeSegmentMap(this.addrs)),
            );
        }
        this.running = true;
    }

    /**
     * Match the fade to the real frame spacing. A fade shorter than the gap
     * lets the colour come to rest between frames, which reads as stutter.
     * The pacer decides the value; see docs/PACING.md.
     *
     * @param {number} ms
     */
    setSmoothingMs(ms) {
        this.smoothing = smoothingFromMs(Math.min(Math.max(ms, 10), 2000));
    }

    /** @param {Array<{r:number,g:number,b:number}>} colors length `segments` */
    async frame(colors) {
        if (!this.running) return;
        const lights = this.addrs.map((addr, i) => ({
            addr,
            color: colors[i] ?? colors[colors.length - 1],
            mode: MODE_SEGMENT,
        }));
        const data = encodeFrame(this.counter, this.smoothing, lights);
        this.counter = (this.counter + 1) >>> 0;
        await this.transport.zclCommand(zclCommand(CMD_FRAME, data));
    }

    /**
     * Unconditional CMD_RESET: leaves entertainment mode whether or not THIS
     * process put the strip there. Needed after a z2m restart, when `running`
     * is false but the strip is still streaming and ignoring normal commands.
     */
    async reset() {
        this.running = false;
        await this.transport.zclCommand(zclCommand(CMD_RESET, encodeReset(this.counter)));
    }

    /**
     * End the stream. `running` is cleared only AFTER the reset has gone out:
     * if the send times out, the flag stays and the next tick retries, rather
     * than leaving a strip we believe is idle but which is still streaming.
     */
    async stop() {
        if (!this.running) return;
        await this.transport.zclCommand(zclCommand(CMD_RESET, encodeReset(this.counter)));
        this.running = false;
    }
}
