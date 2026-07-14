const fs = require("fs");

const OUT_DIR = "reports/card-prototypes";
const syllables = ["Ae", "Vor", "Nyx", "Mor", "Tha", "Rin", "Or", "Lux", "Ka", "Zel", "Um", "Ith", "No", "Va", "Sol", "Ere"];
const roots = ["Rune", "Void", "Star", "Eye", "Wing", "Core", "Crown", "Ash", "Iron", "Soul", "Glyph", "Seed"];
const symbols = ["+", "-", "*", "/", "0", "1", "7", "13", "A", "E", "M", "X", "#", "@", "::", "<>"];
const palettes = [
  ["#38efff", "#f2ffff"],
  ["#ff4fd8", "#ffd4f3"],
  ["#c6ff43", "#efffbd"],
  ["#fff1a8", "#fffbe0"],
  ["#9c7dff", "#e3dbff"],
  ["#ff846a", "#ffe1d8"],
];
const borders = [
  { name: "No Border", color: "#000000", glow: "#000000", tier: 0 },
  { name: "Rare", color: "#38efff", glow: "#82f7ff", tier: 1 },
  { name: "Epic", color: "#9c7dff", glow: "#c7b9ff", tier: 2 },
  { name: "Mythic", color: "#ff4fd8", glow: "#ff9de8", tier: 3 },
  { name: "Legendary", color: "#ffd56a", glow: "#fff1a8", tier: 4 },
];

function rng(seed) {
  let x = BigInt(seed);
  return () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number(x >> 32n) >>> 0;
  };
}

function pick(next, list) {
  return list[next() % list.length];
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cardState(seed, devours, mutationLevel = 0, forcedBorder = null) {
  const next = rng(seed);
  const name = `${pick(next, syllables)}${pick(next, syllables).toLowerCase()} ${pick(next, roots)}`;
  const palette = pick(next, palettes);
  const roll = next() % 10000;
  const border =
    forcedBorder ||
    (roll < 18 ? borders[4] : roll < 90 ? borders[3] : roll < 360 ? borders[2] : roll < 1200 ? borders[1] : borders[0]);
  const chars = [];
  const count = mutationLevel === 0 ? 0 : Math.min(34, mutationLevel * 3 + Math.floor(devours / 12));
  for (let i = 0; i < count; i++) {
    const pool =
      mutationLevel >= 3 && i % 4 === 0 ? roots : mutationLevel >= 2 ? symbols.concat(syllables) : symbols;
    const glyph = pick(next, pool);
    chars.push(mutationLevel >= 3 && i % 5 === 0 ? glyph.toUpperCase() : glyph);
  }
  return { name, palette, border, chars, mutationLevel, kind: next() % 6 };
}

function text(x, y, body, fill, size = 16, opacity = 1, anchor = "start") {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="monospace" font-size="${size}" text-anchor="${anchor}" opacity="${opacity}">${escapeXml(body)}</text>`;
}

function line(x1, y1, x2, y2, stroke, width = 1, opacity = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function rect(x, y, w, h, stroke, width = 1, opacity = 1, fill = "none") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function figure(kind, devours, hue, accent, mutationLevel) {
  if (mutationLevel === 0 && devours === 0) {
    return [
      `<circle cx="238" cy="250" r="4" fill="${accent}" opacity=".85"/>`,
      `<path d="M238 218V282M222 250H254" stroke="${hue}" stroke-width="1.5" opacity=".72"/>`,
      `<path d="M232 232L244 232L244 268L232 268Z" fill="none" stroke="${accent}" stroke-width="1.5" opacity=".62"/>`,
    ].join("");
  }
  if (mutationLevel === 0 && devours < 24) {
    const h = 44 + devours * 1.2;
    return [
      `<path d="M238 ${250 - h / 2}C${218 - devours / 4} ${232 - devours / 5} ${218 - devours / 5} ${268 + devours / 5} 238 ${250 + h / 2}C${258 + devours / 5} ${268 + devours / 5} ${258 + devours / 4} ${232 - devours / 5} 238 ${250 - h / 2}Z" fill="${hue}" fill-opacity=".04" stroke="${accent}" stroke-width="1.5" opacity=".78"/>`,
      `<path d="M238 ${250 - h / 2 + 10}V${250 + h / 2 - 10}M226 250H250" stroke="${hue}" stroke-width="1" opacity=".5"/>`,
    ].join("");
  }
  const scale = Math.min(1.8, 0.72 + Math.sqrt(devours + mutationLevel * 24) / 18);
  const glow = 0.2 + mutationLevel * 0.08;
  if (kind === 0) {
    return [
      `<circle cx="238" cy="238" r="${44 * scale}" fill="none" stroke="${hue}" stroke-width="2" opacity=".6"/>`,
      `<path d="M238 ${238 - 72 * scale}L${238 + 38 * scale} 238L238 ${238 + 72 * scale}L${238 - 38 * scale} 238Z" fill="${hue}" fill-opacity=".08" stroke="${accent}" stroke-width="2" opacity=".86"/>`,
      `<path d="M238 ${238 - 72 * scale}V${238 + 72 * scale}M${238 - 38 * scale} 238H${238 + 38 * scale}" stroke="${hue}" stroke-width="1" opacity=".52"/>`,
    ].join("");
  }
  if (kind === 1) {
    return [
      `<circle cx="238" cy="178" r="${18 * scale}" fill="${hue}" fill-opacity="${glow}" stroke="${accent}" stroke-width="2"/>`,
      `<path d="M238 198L${204 - scale * 8} ${322 + scale * 4}H${272 + scale * 8}Z" fill="${hue}" fill-opacity=".07" stroke="${accent}" stroke-width="2"/>`,
      `<path d="M188 246C214 220 262 220 288 246M204 286C226 270 250 270 272 286" fill="none" stroke="${hue}" stroke-width="2" opacity=".58"/>`,
    ].join("");
  }
  if (kind === 2) {
    return [
      `<path d="M178 330H298V224L280 210V172H260V198L238 178L216 198V172H196V210L178 224Z" fill="${hue}" fill-opacity=".06" stroke="${accent}" stroke-width="2"/>`,
      `<path d="M202 330V260H222V330M254 330V260H274V330M238 178V330" stroke="${hue}" stroke-width="1.5" opacity=".62"/>`,
      `<path d="M188 224H288M196 248H280M186 306H290" stroke="${hue}" stroke-width="1" opacity=".38"/>`,
    ].join("");
  }
  if (kind === 3) {
    return [
      `<rect x="204" y="178" width="68" height="132" rx="10" fill="${hue}" fill-opacity=".06" stroke="${accent}" stroke-width="2"/>`,
      `<circle cx="238" cy="222" r="22" fill="none" stroke="${hue}" stroke-width="2" opacity=".7"/>`,
      `<path d="M204 218H168M272 218H308M204 276H166M272 276H310M238 178V142M238 310V346" stroke="${hue}" stroke-width="2" opacity=".58"/>`,
      `<path d="M178 218l-18 -18M298 218l18 -18M176 276l-18 18M300 276l18 18" stroke="${accent}" stroke-width="1.5" opacity=".7"/>`,
    ].join("");
  }
  if (kind === 4) {
    return [
      `<circle cx="238" cy="238" r="90" fill="none" stroke="${hue}" stroke-width="1.5" opacity=".35"/>`,
      `<ellipse cx="238" cy="238" rx="108" ry="28" fill="none" stroke="${accent}" stroke-width="1.5" opacity=".55" transform="rotate(-18 238 238)"/>`,
      `<ellipse cx="238" cy="238" rx="108" ry="28" fill="none" stroke="${hue}" stroke-width="1.5" opacity=".4" transform="rotate(42 238 238)"/>`,
      `<path d="M238 162L252 224L314 238L252 252L238 314L224 252L162 238L224 224Z" fill="${hue}" fill-opacity=".08" stroke="${accent}" stroke-width="2"/>`,
    ].join("");
  }
  return [
    `<path d="M238 154C280 186 280 290 238 326C196 290 196 186 238 154Z" fill="${hue}" fill-opacity=".06" stroke="${accent}" stroke-width="2"/>`,
    `<path d="M238 176C220 210 222 268 238 304C254 268 256 210 238 176Z" fill="none" stroke="${hue}" stroke-width="1.5" opacity=".68"/>`,
    `<path d="M202 212H274M198 250H278M206 286H270" stroke="${hue}" stroke-width="1" opacity=".45"/>`,
    `<text x="238" y="251" fill="${accent}" font-family="monospace" font-size="44" text-anchor="middle" opacity=".76">R</text>`,
  ].join("");
}

function growthLayer(devours, mutationLevel, hue, accent) {
  const tier = devours < 24 && mutationLevel === 0 ? 0 : Math.min(8, Math.floor(Math.sqrt(devours) / 2));
  let out = "";
  for (let i = 0; i < tier; i++) {
    const r = 30 + i * 10;
    const opacity = 0.18 + i * 0.025;
    out += `<circle cx="238" cy="238" r="${r}" fill="none" stroke="${i % 2 ? accent : hue}" stroke-width="1" opacity="${opacity}"/>`;
    if (i > 2) {
      out += line(238 - r, 238, 238 - r - 12, 238 - 10 + i * 3, hue, 1, 0.35);
      out += line(238 + r, 238, 238 + r + 12, 238 - 10 + i * 3, hue, 1, 0.35);
    }
  }
  if (mutationLevel >= 2) {
    for (let i = 0; i < mutationLevel + 2; i++) {
      const y = 160 + i * 28;
      out += `<path d="M154 ${y}C182 ${y - 34} 196 ${y - 22} 214 ${y}" fill="none" stroke="${accent}" stroke-width="1.5" opacity=".48"/>`;
      out += `<path d="M322 ${y}C294 ${y - 34} 280 ${y - 22} 262 ${y}" fill="none" stroke="${accent}" stroke-width="1.5" opacity=".48"/>`;
    }
  }
  if (mutationLevel >= 3) {
    out += `<path d="M238 106C292 138 300 186 286 226M238 106C184 138 176 186 190 226" fill="none" stroke="${hue}" stroke-width="2" opacity=".45"/>`;
    out += `<circle cx="238" cy="118" r="7" fill="${accent}" fill-opacity=".22" stroke="${accent}" stroke-width="1.5"/>`;
  }
  if (mutationLevel >= 4) {
    for (let i = 0; i < 10; i++) {
      const angle = (Math.PI * 2 * i) / 10;
      const x = 238 + Math.cos(angle) * 114;
      const y = 238 + Math.sin(angle) * 114;
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 2 ? 2.5 : 4}" fill="${i % 2 ? hue : accent}" opacity=".74"/>`;
    }
  }
  return out;
}

function borderLayer(border) {
  if (border.tier === 0) {
    return [
      rect(30, 30, 300, 452, "#1f2a30", 1, 0.22, "rgba(255,255,255,0.006)"),
    ].join("");
  }
  const width = border.tier === 4 ? 8 : 6;
  return [
    rect(18, 18, 324, 476, border.color, width, 0.95, "rgba(255,255,255,0.018)"),
    rect(29, 29, 302, 454, border.glow, 2, 0.42),
  ].join("");
}

function svg(seed, devours, mutationLevel = 0, forcedBorder = null) {
  const s = cardState(seed, devours, mutationLevel, forcedBorder);
  const [hue, accent] = s.palette;
  let chars = "";
  const charSize = s.chars.length <= 10 ? 13 : s.chars.length <= 18 ? 10 : 8;
  const charStep = s.chars.length <= 10 ? 20 : s.chars.length <= 18 ? 15 : 11;
  for (let i = 0; i < s.chars.length; i++) {
    chars += text(54, 100 + i * charStep, s.chars[i], i % 3 ? hue : accent, charSize, 0.84);
  }

  let circuit = "";
  const circuitCount =
    devours === 0 && mutationLevel === 0 ? 0 : Math.min(8, Math.floor(Math.sqrt(devours + 1) / 2) + mutationLevel);
  for (let i = 0; i < circuitCount; i++) {
    const y = 126 + i * 34;
    circuit += line(142, y, 330 - (i % 3) * 18, y, hue, 1, 0.28);
    circuit += line(330 - (i % 3) * 18, y, 330 - (i % 3) * 18, y + 18, hue, 1, 0.28);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 512">`,
    `<rect width="360" height="512" fill="#05070a"/>`,
    borderLayer(s.border),
    s.chars.length ? rect(40, 76, 72, 356, hue, 1, 0.26) : "",
    chars,
    circuit,
    growthLayer(devours, mutationLevel, hue, accent),
    figure(s.kind, devours, hue, accent, mutationLevel),
    text(180, 54, s.name, accent, 18, 0.95, "middle"),
    s.border.tier > 0 ? text(238, 454, s.border.name, s.border.glow, 15, 0.95, "middle") : "",
    text(238, 476, `D:${devours} M:${mutationLevel}`, hue, 12, 0.75, "middle"),
    `</svg>`,
  ].join("");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const samples = [
  ["timeline-00-start", 777, 0, 0, borders[0]],
  ["timeline-01-small-devour", 777, 10, 0, borders[0]],
  ["timeline-02-many-devours", 777, 120, 0, borders[0]],
  ["timeline-03-mutated", 777, 120, 2, borders[1]],
  ["timeline-04-supercomplex", 777, 360, 4, borders[4]],
];
for (const [name, seed, devours, mutationLevel, border] of samples) {
  fs.writeFileSync(`${OUT_DIR}/${name}.svg`, `${svg(seed, devours, mutationLevel, border)}\n`);
}
console.log(JSON.stringify(samples.map(([name]) => `${OUT_DIR}/${name}.svg`), null, 2));
