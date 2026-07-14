const crypto = require("crypto");
const fs = require("fs");

const mode = process.argv[2] || "mutated";
const outPath = process.argv[3] || `reports/math-compressed-${mode}.svg`;

const states = {
  base: {
    tokenId: 4096,
    mass: 1880,
    complexity: 740,
    devours: 52,
    fusions: 6,
    power: 79,
    skill: 66,
    stage: 6,
    mutation: 2,
    genome: "0x3f6a111e4fd91b728dfad54a1a5cbf337079e5cefd9f582bd9913cd7485092aa",
  },
  devoured3x: {
    tokenId: 4096,
    mass: 5640,
    complexity: 2220,
    devours: 156,
    fusions: 13,
    power: 142,
    skill: 118,
    stage: 9,
    mutation: 2,
    genome: "0xa6e88d394fa7f9bb6c16b934a00a9ec65ca90210fa18d408a2c7513dd64f8409",
  },
  mutated: {
    tokenId: 4096,
    mass: 6010,
    complexity: 2480,
    devours: 159,
    fusions: 13,
    power: 151,
    skill: 129,
    stage: 10,
    mutation: 5,
    genome: "0xff31c0d99b3e7a142ed5aef9cce48f4fe2eaf65d8efc91b7c34d99fb163a7ae0",
  },
};

const s = states[mode] || states.mutated;
const W = 1024;
const H = 1024;
const CX = 512;
const CY = 512;

const palettes = {
  base: ["#f2ffff", "#38efff", "#7fa0a5", "#6ba8ff", "#11191b"],
  devoured3x: ["#fff8df", "#39f3ff", "#b58cff", "#72d6ff", "#160c22"],
  mutated: ["#fff6e2", "#39f3ff", "#ff4fd8", "#c6ff43", "#1b0820"],
};
const P = palettes[mode] || palettes.mutated;

function Hx(...parts) {
  return BigInt(`0x${crypto.createHash("sha256").update(parts.join("|")).digest("hex")}`);
}

function pick(seed, min, max) {
  return Number(seed % BigInt(max - min + 1)) + min;
}

function line(x1, y1, x2, y2, color = P[0], w = 2, o = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" opacity="${o}" stroke-linecap="round"/>`;
}

function path(d, color = P[0], w = 2, fill = "none", o = 1) {
  return `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${w}" opacity="${o}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function circle(x, y, r, color = P[0], w = 2, fill = "none", o = 1) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${color}" stroke-width="${w}" opacity="${o}"/>`;
}

function text(x, y, value, size = 18, color = P[0]) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="${size}" text-anchor="middle">${escapeXml(value)}</text>`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fourierPath(tag, cx, cy, rx, ry, points, closed = false) {
  const seed = Hx(s.genome, tag, s.stage, s.mutation);
  const f1 = pick(seed, 2, 5);
  const f2 = pick(seed >> 8n, 5, 11);
  const f3 = pick(seed >> 16n, 3, 9);
  const a1 = pick(seed >> 24n, 10, 42 + s.stage * 2);
  const a2 = pick(seed >> 32n, 6, 28 + s.mutation * 3);
  let d = "";
  for (let i = 0; i <= points; i++) {
    const t = (Math.PI * 2 * i) / points;
    const r =
      1 +
      (Math.sin(t * f1) * a1) / 220 +
      (Math.cos(t * f2) * a2) / 260 +
      (Math.sin(t * f3 + s.devours) * s.mutation) / 80;
    const x = Math.round(cx + Math.cos(t) * rx * r);
    const y = Math.round(cy + Math.sin(t) * ry * r);
    d += `${i === 0 ? "M" : "L"}${x} ${y}`;
  }
  return closed ? `${d}Z` : d;
}

function matrixCopies(basePath) {
  const transforms = [
    "matrix(1 0 0 1 0 0)",
    "matrix(-1 0 0 1 1024 0)",
    "matrix(.72 .18 -.18 .72 238 112)",
    "matrix(-.72 .18 .18 .72 786 112)",
  ];
  if (mode !== "base") {
    transforms.push("matrix(.54 -.28 .28 .54 238 674)");
    transforms.push("matrix(-.54 -.28 -.28 .54 786 674)");
  }
  return transforms
    .map((tr, i) => `<g transform="${tr}">${path(basePath, P[i % 4], i < 2 ? 3 : 2, "none", i < 2 ? 0.92 : 0.52)}</g>`)
    .join("");
}

function lattice() {
  let out = "";
  const rings = mode === "mutated" ? 7 : mode === "devoured3x" ? 5 : 4;
  for (let i = 0; i < rings; i++) {
    out += circle(CX, CY, 64 + i * 42, P[i % 4], i === 2 ? 3 : 1, "none", 0.22 + i * 0.07);
  }

  const spokes = 10 + s.stage + s.mutation * 2;
  for (let i = 0; i < spokes; i++) {
    const t = (Math.PI * 2 * i) / spokes;
    const inner = 72 + (i % 3) * 18;
    const outer = mode === "mutated" ? 344 + (i % 5) * 18 : 242 + (i % 4) * 18;
    out += line(
      Math.round(CX + Math.cos(t) * inner),
      Math.round(CY + Math.sin(t) * inner),
      Math.round(CX + Math.cos(t) * outer),
      Math.round(CY + Math.sin(t) * outer),
      P[i % 4],
      i % 5 === 0 ? 3 : 1,
      mode === "mutated" ? 0.72 : 0.5,
    );
  }
  return out;
}

function body() {
  const silhouette = fourierPath("silhouette", CX, 548, mode === "base" ? 104 : mode === "devoured3x" ? 162 : 188, mode === "base" ? 294 : 356, 56, true);
  const core = fourierPath("core", CX, 552, 54 + s.stage * 2, 156 + s.mutation * 8, 44, true);
  const wing = fourierPath("wing", 348, 484, mode === "base" ? 56 : 116, mode === "base" ? 160 : 236, 34, false);
  let out = "";
  out += path(silhouette, P[0], 4, mode === "mutated" ? "rgba(255,79,216,.08)" : "rgba(57,243,255,.04)", 0.96);
  out += path(core, P[1], 3, "none", 0.92);
  out += matrixCopies(wing);
  return out;
}

function glyphField() {
  const chars = mode === "mutated" ? "0123456789ABCDEF+-*/[]{}<>ΩΣλ" : "0123456789ABCDEF+-*/[]";
  let out = "";
  const count = mode === "base" ? 30 : mode === "devoured3x" ? 46 : 58;
  for (let i = 0; i < count; i++) {
    const seed = Hx(s.genome, "glyph", i);
    const side = i % 2 === 0 ? -1 : 1;
    const x = side < 0 ? pick(seed, 82, 262) : pick(seed, 762, 942);
    const y = pick(seed >> 8n, 94, 916);
    const ch = chars[pick(seed >> 16n, 0, chars.length - 1)];
    out += text(x, y, ch, pick(seed >> 24n, 12, 23), P[i % 4]);
  }
  return out;
}

function baseStructure() {
  let out = "";
  out += path("M288 900 L736 900 L790 952 L234 952 Z", P[0], 3, "none", 0.82);
  out += line(330, 922, 694, 922, P[1], 2, 0.7);
  for (let i = 0; i < 9; i++) {
    const x = 360 + i * 38;
    out += line(x, 900, x + (i % 2 ? 22 : -22), 846, P[i % 4], 1, 0.55);
  }
  return out;
}

function render() {
  const bg = `<rect width="${W}" height="${H}" fill="${P[4]}"/>`;
  const frame = `<rect x="34" y="34" width="956" height="956" fill="none" stroke="${P[0]}" stroke-width="2" opacity=".45"/><rect x="64" y="64" width="896" height="896" fill="none" stroke="${P[1]}" stroke-width="1" opacity=".34"/>`;
  const outer = mode === "mutated" ? path(fourierPath("outer", CX, CY, 382, 382, 72, true), P[2], 2, "none", 0.6) : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    bg,
    frame,
    glyphField(),
    lattice(),
    outer,
    body(),
    baseStructure(),
    text(CX, 90, `MATRIX BEING #${s.tokenId} / ${mode.toUpperCase()}`, 26, P[0]),
    text(CX, 126, `M${s.mass} C${s.complexity} P${s.power} S${s.skill} D${s.devours} F${s.fusions}`, 17, P[1]),
    text(CX, 966, `FOURIER-LIKE / MATRIX MIRROR / GENOME ${s.genome.slice(2, 14).toUpperCase()}`, 15, P[0]),
    `</svg>`,
  ].join("");

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(outPath, `${svg}\n`);
  console.log(outPath);
}

render();
