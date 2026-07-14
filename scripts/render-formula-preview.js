const crypto = require("crypto");
const fs = require("fs");

const outPath = process.argv[2] || "reports/formula-being-preview.svg";

const state = {
  tokenId: 777,
  mass: 2840,
  complexity: 920,
  devours: 73,
  fusions: 9,
  power: 88,
  skill: 61,
  scars: 7,
  stage: 6,
  mutation: 3,
  genome: "0x9a9d4e1e4f3b17982c0b9d53a87a6ed9ad64df7e5c75a9f308d6b7a41cc0e911",
};

const W = 1024;
const H = 1024;
const CX = W / 2;

const palette = {
  bg: "#030607",
  ink: "#eafcff",
  dim: "#7f9699",
  cyan: "#39f4ff",
  blue: "#38a7ff",
  violet: "#b58cff",
};

function hashInt(...parts) {
  const hash = crypto.createHash("sha256").update(parts.join("|")).digest();
  return BigInt(`0x${hash.toString("hex")}`);
}

function pick(seed, min, max) {
  return Number(seed % BigInt(max - min + 1)) + min;
}

function line(x1, y1, x2, y2, color = palette.ink, width = 2, opacity = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"/>`;
}

function poly(points, color = palette.ink, width = 2, fill = "none", opacity = 1) {
  return `<polygon points="${points.map((p) => p.join(",")).join(" ")}" fill="${fill}" stroke="${color}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function circle(x, y, r, color = palette.ink, width = 2, fill = "none", opacity = 1) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${color}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function text(x, y, value, size = 20, color = palette.ink, anchor = "middle", opacity = 1) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="${size}" text-anchor="${anchor}" opacity="${opacity}">${value}</text>`;
}

function mirror(svgForLeft) {
  return `<g>${svgForLeft}</g><g transform="translate(${W},0) scale(-1,1)">${svgForLeft}</g>`;
}

function renderBitGrid() {
  const cells = 17 + state.stage;
  const size = 10;
  const startX = CX - (cells * size) / 2;
  const startY = 520;
  let out = "";

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const d = Math.abs(x - cells / 2) + Math.abs(y - cells / 2);
      const h = hashInt(state.genome, "grid", x, y, state.devours);
      const on = Number(h & 7n) < Math.max(2, 6 - Math.floor(d / 5));
      if (!on) continue;
      const color = Number(h & 31n) === 0 ? palette.violet : Number(h & 3n) === 0 ? palette.cyan : palette.ink;
      out += `<rect x="${Math.round(startX + x * size)}" y="${Math.round(startY + y * size)}" width="${size - 2}" height="${size - 2}" fill="${color}" opacity="0.72"/>`;
    }
  }
  return out;
}

function renderRecursiveHorns() {
  function branch(x, y, len, angle, depth, seedTag) {
    if (depth === 0 || len < 8) return "";
    const rad = (angle * Math.PI) / 180;
    const x2 = Math.round(x + Math.cos(rad) * len);
    const y2 = Math.round(y - Math.sin(rad) * len);
    const h = hashInt(state.genome, seedTag, depth);
    const split = pick(h, 16, 31);
    const next = Math.round(len * 0.68);
    let out = line(x, y, x2, y2, depth > 3 ? palette.ink : palette.cyan, depth > 4 ? 3 : 2, 0.9);
    out += branch(x2, y2, next, angle + split, depth - 1, `${seedTag}a`);
    out += branch(x2, y2, next, angle - Math.floor(split * 0.7), depth - 1, `${seedTag}b`);
    return out;
  }
  const left = branch(388, 286, 86 + state.stage * 8, 112, 5 + Math.min(2, state.mutation), "horn");
  return mirror(left);
}

function renderBody() {
  const baseY = 858;
  const headY = 292;
  let left = "";
  left += poly([[512, headY], [424, 350], [378, 522], [420, 800], [512, baseY]], palette.ink, 3, "none", 0.96);
  left += poly([[512, 366], [448, 408], [420, 522], [452, 688], [512, 738]], palette.dim, 2, "none", 0.55);

  const plates = 12 + state.stage * 3;
  for (let i = 0; i < plates; i++) {
    const h = hashInt(state.genome, "plate", i);
    const y = pick(h, 354, 812);
    const x1 = pick(h >> 8n, 392, 492);
    const x2 = pick(h >> 16n, 348, 486);
    const color = i % 4 === 0 ? palette.cyan : palette.ink;
    left += line(x1, y, x2, y + pick(h >> 24n, -28, 28), color, i % 7 === 0 ? 3 : 2, 0.85);
    if (i % 3 === 0) left += circle(x2, y, 4 + (i % 3), color, 1, "none", 0.9);
  }

  let out = mirror(left);
  out += poly([[512, 210], [552, 286], [512, 352], [472, 286]], palette.ink, 3, "none", 0.98);
  out += poly([[512, 388], [592, 504], [562, 812], [512, 908], [462, 812], [432, 504]], palette.ink, 3, "none", 0.98);
  out += poly([[512, 464], [550, 546], [536, 690], [512, 746], [488, 690], [474, 546]], palette.cyan, 2, "none", 0.9);
  return out;
}

function renderSigils() {
  let out = "";
  const rings = [70, 96, 132, 176, 222];
  for (let i = 0; i < rings.length; i++) {
    out += circle(CX, 500, rings[i], i % 2 ? palette.dim : palette.cyan, i === 2 ? 3 : 1, "none", i < 2 ? 0.9 : 0.52);
  }

  const points = 12 + state.mutation * 2;
  const r1 = 78;
  const r2 = 156;
  for (let i = 0; i < points; i++) {
    const a = (Math.PI * 2 * i) / points - Math.PI / 2;
    const b = (Math.PI * 2 * ((i * 5) % points)) / points - Math.PI / 2;
    const x1 = Math.round(CX + Math.cos(a) * r1);
    const y1 = Math.round(500 + Math.sin(a) * r1);
    const x2 = Math.round(CX + Math.cos(b) * r2);
    const y2 = Math.round(500 + Math.sin(b) * r2);
    out += line(x1, y1, x2, y2, i % 3 === 0 ? palette.violet : palette.cyan, 1, 0.68);
  }
  return out;
}

function renderRunes() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-*/<>[]{}";
  let out = "";
  const count = 28 + state.skill;
  for (let i = 0; i < count; i++) {
    const h = hashInt(state.genome, "rune", i, state.power);
    const left = Number(h & 1n) === 0;
    const x = left ? pick(h >> 4n, 64, 260) : pick(h >> 4n, 764, 960);
    const y = pick(h >> 12n, 70, 920);
    const ch = alphabet[pick(h >> 20n, 0, alphabet.length - 1)];
    const color = i % 7 === 0 ? palette.cyan : i % 11 === 0 ? palette.violet : palette.ink;
    out += text(x, y, ch, pick(h >> 28n, 12, 26), color, "middle", 0.72);
  }
  return out;
}

function renderFrame() {
  let out = "";
  out += `<rect x="28" y="28" width="968" height="968" fill="none" stroke="${palette.dim}" stroke-width="2" opacity="0.62"/>`;
  out += `<rect x="54" y="54" width="916" height="916" fill="none" stroke="${palette.cyan}" stroke-width="1" opacity="0.35"/>`;
  for (let i = 0; i < 18; i++) {
    const h = hashInt(state.genome, "frame", i);
    const y = pick(h, 82, 916);
    out += line(48, y, pick(h >> 8n, 96, 210), y, i % 4 === 0 ? palette.cyan : palette.ink, 2, 0.65);
    out += line(W - 48, y, W - pick(h >> 8n, 96, 210), y, i % 4 === 0 ? palette.cyan : palette.ink, 2, 0.65);
  }
  return out;
}

function render() {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${palette.bg}"/>`,
    renderFrame(),
    renderRunes(),
    renderSigils(),
    renderRecursiveHorns(),
    renderBody(),
    renderBitGrid(),
    text(CX, 88, `BEING #${state.tokenId}`, 28, palette.ink),
    text(CX, 126, `M${state.mass} C${state.complexity} P${state.power} S${state.skill} D${state.devours} F${state.fusions}`, 18, palette.cyan),
    text(CX, 954, `GENOME ${state.genome.slice(2, 18).toUpperCase()} / STAGE ${state.stage} / MUT ${state.mutation}`, 18, palette.ink),
    `</svg>`,
  ].join("");
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(outPath, `${svg}\n`);
  console.log(outPath);
}

render();
