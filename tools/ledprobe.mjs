/**
 * ledprobe - checks whether Hyperion emits `ledcolors-ledstream-update` at all.
 * Written to find out why bytediff was hanging waiting for a frame.
 *
 * usage: HYPERION_HOST=host:8090 HYPERION_PASS=... node tools/ledprobe.mjs
 */
const HOST = process.env.HYPERION_HOST ?? "127.0.0.1:8090";
const PASS = process.env.HYPERION_PASS ?? "hyperion";

const sock = new WebSocket(`ws://${HOST}`);
let n = 0;

sock.onopen = () => {
    sock.send(JSON.stringify({ command: "authorize", subcommand: "login", password: PASS, tan: 1 }));
};

sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.command === "authorize-login") {
        console.log("auth:", m.success);
        sock.send(JSON.stringify({
            command: "color",
            color: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255, 128, 128, 128],
            priority: 50,
            origin: "ledprobe",
            tan: 2,
        }));
        sock.send(JSON.stringify({ command: "ledcolors", subcommand: "ledstream-start", tan: 3 }));
        return;
    }
    if (m.command === "ledcolors-ledstream-update") {
        n += 1;
        if (n <= 3) console.log(n, JSON.stringify(m).slice(0, 400));
        return;
    }
    console.log("msg:", JSON.stringify(m).slice(0, 300));
};

sock.onerror = (e) => console.log("err", e.message);

setTimeout(() => {
    console.log(`ledstream frames in total: ${n}`);
    process.exit(0);
}, 8000);
