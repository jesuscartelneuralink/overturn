// Assembles the uploadable Front plugin: hosted index + assets + the built script.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "plugin");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "plugin"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function makeZip(dir, zipPath) {
  const files = [];
  const walk = (base, rel = "") => {
    for (const name of readdirSync(base)) {
      const full = path.join(base, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else files.push({ full, name: r.replaceAll("\\", "/") });
    }
  };
  walk(dir);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.full);
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    parts.push(local, nameBuf, compressed);
    offset += local.length + nameBuf.length + compressed.length;

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(localOffset, 42);
    central.push(cen, nameBuf);
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(zipPath, Buffer.concat([...parts, ...central, end]));
}

const zipPath = path.join(root, "dist", "overturn-front-plugin.zip");
rmSync(zipPath, { force: true });
try {
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: out });
} catch {
  makeZip(out, zipPath);
}
console.log("dist/overturn-front-plugin.zip");
