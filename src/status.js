const net = require("net");

const varint = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varint(b.length), b]);
};
const packet = (id, payload) => {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
};

function readVarint(buf, offset) {
  let val = 0, shift = 0, i = offset, b;
  do {
    if (i >= buf.length) return null;
    b = buf[i++];
    val |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { val, next: i };
}

function flatten(d) {
  if (!d) return "";
  if (typeof d === "string") return d;
  return (d.text || "") + (Array.isArray(d.extra) ? d.extra.map(flatten).join("") : "");
}

function ping(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port: Number(port) });
    let buf = Buffer.alloc(0);
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout, () => done({ online: false }));
    sock.on("error", () => done({ online: false }));
    sock.on("connect", () => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(Number(port));
      sock.write(packet(0, Buffer.concat([varint(767), str(host), p, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.next + len.val) return;
        const id = readVarint(buf, len.next);
        const sl = id && readVarint(buf, id.next);
        if (!sl || buf.length < sl.next + sl.val) return;
        const json = JSON.parse(buf.subarray(sl.next, sl.next + sl.val).toString("utf8"));
        done({
          online: true,
          ping: Date.now() - t0,
          players: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          version: json.version?.name || "",
          motd: flatten(json.description).replace(/§./g, "").trim(),
        });
      } catch {
        done({ online: false });
      }
    });
  });
}

module.exports = { ping };
