const fs = require("fs");

const OUT_DIR = "reports/character-prototypes";

const lineages = [
  { id: "mechanical", name: "Mechanical", hue: "#57f7ff", accent: "#e9ffff", seed: 11 },
  { id: "idol", name: "Idol", hue: "#ffd56a", accent: "#fff3bd", seed: 23 },
  { id: "citadel", name: "Citadel", hue: "#8ee6ff", accent: "#f2ffff", seed: 37 },
  { id: "crystal", name: "Crystal", hue: "#9d7cff", accent: "#d9ccff", seed: 41 },
  { id: "star", name: "Star", hue: "#b9ff72", accent: "#f0ffd5", seed: 53 },
  { id: "rune", name: "Rune", hue: "#ff6aa8", accent: "#ffd4e5", seed: 67 },
];

function p(seed) {
  let x = BigInt(seed);
  return () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number(x >> 32n) / 2 ** 32;
  };
}

function polar(cx, cy, r, a) {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

function n(v) {
  return Math.round(v);
}

function path(d, stroke, width = 2, opacity = 1, fill = "none") {
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function circle(cx, cy, r, stroke, width = 1, opacity = 1, fill = "none") {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function line(x1, y1, x2, y2, stroke, width = 1, opacity = 1) {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"/>`;
}

function mirror(d) {
  return `<g transform="matrix(-1 0 0 1 512 0)">${d}</g>`;
}

function orbit(cx, cy, rx, ry, turns, phase, stroke, opacity) {
  let d = "";
  const points = 80;
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * Math.PI * 2;
    const wobble = 1 + 0.11 * Math.sin(t * turns + phase);
    const x = cx + Math.cos(t) * rx * wobble;
    const y = cy + Math.sin(t) * ry * wobble;
    d += `${i ? "L" : "M"}${n(x)} ${n(y)}`;
  }
  return path(d + "Z", stroke, 1.4, opacity);
}

function body(hue, accent) {
  return [
    circle(256, 124, 25, accent, 2.6, 0.95),
    path("M256 150C238 188 236 245 256 318C276 245 274 188 256 150Z", hue, 2.6, 0.95, "rgba(255,255,255,0.025)"),
    path("M214 204C235 222 241 240 256 267C271 240 277 222 298 204", accent, 2.1, 0.82),
    path("M222 322C238 358 246 384 256 424C266 384 274 358 290 322", hue, 2.1, 0.8),
    path("M218 190C166 222 145 286 116 352M294 190C346 222 367 286 396 352", hue, 1.8, 0.68),
    path("M196 250C226 258 238 270 256 290C274 270 286 258 316 250", accent, 1.5, 0.65),
  ].join("");
}

function mechanicalBody(hue, accent) {
  return [
    circle(256, 124, 22, accent, 2.6, 0.95),
    path("M226 166H286V326H226Z", hue, 2.6, 0.95, "rgba(255,255,255,0.025)"),
    path("M246 146V404M266 146V404M216 210H296M196 256H316M216 302H296", accent, 1.7, 0.72),
    path("M210 196L256 228L302 196M214 326L256 384L298 326", hue, 2.2, 0.86),
  ].join("");
}

function idolBody(hue, accent) {
  return [
    circle(256, 126, 24, accent, 2.8, 0.95),
    path("M218 348L256 148L294 348Z", hue, 2.8, 0.95, "rgba(255,255,255,0.025)"),
    path("M232 216L256 246L280 216M222 298H290M206 374H306M190 404H322", accent, 2.2, 0.78),
    path("M256 78L284 144L256 124L228 144Z", hue, 2.2, 0.82),
  ].join("");
}

function citadelBody(hue, accent) {
  return [
    circle(256, 122, 20, accent, 2.5, 0.92),
    path("M214 392V206L256 160L298 206V392Z", hue, 2.7, 0.9, "rgba(255,255,255,0.018)"),
    path("M214 236H298M226 282H286M238 328H274M194 392H318M174 426H338", accent, 2.2, 0.72),
    path("M218 206L256 164L294 206M236 392V334H276V392", hue, 2.4, 0.85),
  ].join("");
}

function crystalBody(hue, accent) {
  return [
    circle(256, 124, 20, accent, 2.4, 0.9),
    path("M256 142L308 250L256 398L204 250Z", hue, 2.8, 0.95, "rgba(255,255,255,0.025)"),
    path("M256 142V398M204 250H308M256 142L204 250M256 142L308 250M204 250L256 398M308 250L256 398", accent, 1.8, 0.66),
  ].join("");
}

function starBody(hue, accent) {
  return [
    circle(256, 124, 22, accent, 2.6, 0.94),
    path("M256 148C230 194 226 262 256 358C286 262 282 194 256 148Z", hue, 2.5, 0.9, "rgba(255,255,255,0.02)"),
    path("M256 92V408M178 250H334M206 174L306 326M306 174L206 326", accent, 1.8, 0.56),
    path("M218 212C236 230 242 250 256 284C270 250 276 230 294 212", hue, 2.2, 0.78),
  ].join("");
}

function runeBody(hue, accent) {
  return [
    circle(256, 124, 23, accent, 2.6, 0.94),
    path("M228 162H284V386H228Z", hue, 2.5, 0.9, "rgba(255,255,255,0.018)"),
    path("M256 162V386M228 216H284M240 274H272M228 332H284", accent, 2.2, 0.72),
    path("M204 188V360M308 188V360", hue, 1.7, 0.6),
  ].join("");
}

function halo(hue, accent, seed) {
  const r = p(seed);
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += orbit(256, 210, 76 + i * 24, 76 + i * 17, 2 + i, r() * 6.28, i % 2 ? hue : accent, 0.18 + i * 0.06);
  }
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    const [x1, y1] = polar(256, 210, 120, a);
    const [x2, y2] = polar(256, 210, 155 + (i % 3) * 8, a);
    out += line(x1, y1, x2, y2, i % 2 ? hue : accent, 1, 0.38);
  }
  return out;
}

function mutationAura(hue, accent, seed, level = 2) {
  const rand = p(seed + 999);
  let out = "";
  const rings = level === 1 ? 2 : level === 2 ? 4 : 6;
  for (let i = 0; i < rings; i++) {
    out += orbit(256, 252, 138 + i * 24, 92 + i * 18, 5 + i, rand() * 6.28, i % 2 ? hue : accent, 0.22 + i * 0.05);
  }
  const rays = level === 1 ? 8 : level === 2 ? 20 : 32;
  for (let i = 0; i < rays; i++) {
    const a = (Math.PI * 2 * i) / rays;
    const [x1, y1] = polar(256, 252, 152 + (i % 2) * 16, a);
    const [x2, y2] = polar(256, 252, 198 + (i % 4) * 9, a + 0.05 * Math.sin(i));
    out += line(x1, y1, x2, y2, i % 3 ? hue : accent, 1, 0.34);
  }
  return out;
}

function mutationArms(hue, accent, seed, level = 2) {
  const rand = p(seed + 333);
  let left = "";
  const arms = level === 1 ? 2 : level === 2 ? 6 : 10;
  for (let i = 0; i < arms; i++) {
    const y = 174 + i * 34;
    const reach = 102 + rand() * 56;
    const curl = 42 + rand() * 48;
    const d = `M224 ${y}C${n(180 - i * 6)} ${n(y + 6)} ${n(166 - reach / 2)} ${n(y + curl)} ${n(112 - i * 3)} ${n(y + curl + 8)}`;
    left += path(d, i % 2 ? hue : accent, 1.7, 0.56);
    left += circle(112 - i * 3, y + curl + 8, 3 + (i % 3), i % 2 ? accent : hue, 1, 0.7, i % 2 ? accent : hue);
  }
  return left + mirror(left);
}

function mutationSigils(hue, accent, seed, level = 2) {
  const rand = p(seed + 777);
  let out = "";
  const sigils = level === 1 ? 6 : level === 2 ? 18 : 30;
  for (let i = 0; i < sigils; i++) {
    const a = rand() * Math.PI * 2;
    const rr = 94 + rand() * 150;
    const [x, y] = polar(256, 252, rr, a);
    const size = 8 + rand() * 12;
    out += path(`M${n(x)} ${n(y - size)}L${n(x + size)} ${n(y)}L${n(x)} ${n(y + size)}L${n(x - size)} ${n(y)}Z`, i % 2 ? hue : accent, 1, 0.44);
  }
  return out;
}

function mutationCrown(hue, accent, level = 2) {
  if (level < 3) return "";
  return [
    path("M188 102L222 62L256 102L290 62L324 102", accent, 2.2, 0.78),
    path("M170 404C210 452 302 452 342 404", hue, 2.4, 0.62),
    circle(256, 92, 82, hue, 1.4, 0.38),
    circle(256, 92, 118, accent, 1.1, 0.24),
  ].join("");
}

function mutationHeads(hue, accent, seed, level = 2) {
  if (level < 2) return "";
  const heads = level === 2 ? [
    [208, 156, 16],
    [304, 156, 16],
  ] : [
    [196, 144, 17],
    [316, 144, 17],
    [256, 374, 18],
    [176, 266, 12],
    [336, 266, 12],
  ];
  let out = "";
  for (let i = 0; i < heads.length; i++) {
    const [x, y, r] = heads[i];
    out += circle(x, y, r, i % 2 ? hue : accent, 1.8, 0.76, "rgba(255,255,255,0.018)");
    out += circle(x - r / 3, y, 2, accent, 1, 0.9, accent);
    out += circle(x + r / 3, y, 2, hue, 1, 0.9, hue);
  }
  return out;
}

function mutationBodies(hue, accent, level = 2) {
  if (level < 3) return "";
  const left = [
    path("M198 188C172 242 176 320 210 392C224 330 224 244 198 188Z", hue, 1.8, 0.42, "rgba(255,255,255,0.015)"),
    path("M314 188C340 242 336 320 302 392C288 330 288 244 314 188Z", accent, 1.8, 0.42, "rgba(255,255,255,0.015)"),
  ].join("");
  return left;
}

function mutationWings(hue, accent, seed, level = 2) {
  const rand = p(seed + 1201);
  const feathersCount = level === 1 ? 4 : level === 2 ? 7 : 11;
  let left = "";
  for (let i = 0; i < feathersCount; i++) {
    const y = 78 + i * 22;
    const tipX = 76 - i * 4;
    const tipY = 108 + i * 30 + rand() * 12;
    const d = `M236 ${y + 44}C${n(190 - i * 7)} ${n(y + 12)} ${n(132 - i * 2)} ${n(tipY)} ${n(tipX)} ${n(tipY + 22)}`;
    left += path(d, i % 2 ? hue : accent, 1.7, 0.46 + i * 0.025);
  }
  return left + mirror(left);
}

function mutationEyes(hue, accent, seed, level = 2) {
  const rand = p(seed + 4242);
  const count = level === 1 ? 6 : level === 2 ? 14 : 26;
  let out = "";
  for (let i = 0; i < count; i++) {
    const ring = i % 2 ? 172 : 128;
    const a = (Math.PI * 2 * i) / count + rand() * 0.18;
    const [x, y] = polar(256, 250, ring + (i % 3) * 12, a);
    const w = 9 + (i % 4);
    out += path(`M${n(x - w)} ${n(y)}Q${n(x)} ${n(y - w / 2)} ${n(x + w)} ${n(y)}Q${n(x)} ${n(y + w / 2)} ${n(x - w)} ${n(y)}Z`, i % 2 ? hue : accent, 1, 0.42, "rgba(255,255,255,0.02)");
    out += circle(x, y, 2, i % 2 ? accent : hue, 1, 0.8, i % 2 ? accent : hue);
  }
  return out;
}

function feathers(hue, accent, seed, crystalline = false) {
  const rand = p(seed);
  let left = "";
  for (let i = 0; i < 9; i++) {
    const y = 154 + i * 24;
    const reach = 92 + i * 16 + rand() * 20;
    const tipY = y + 8 + i * 12;
    const d = crystalline
      ? `M226 ${y}L${n(226 - reach)} ${n(tipY)}L${n(224 - i * 2)} ${n(y + 34)}Z`
      : `M226 ${y}C${n(190 - i * 8)} ${n(y + 8)} ${n(150 - i * 5)} ${n(tipY)} ${n(114 - i * 2)} ${n(tipY + 18)}`;
    left += path(d, i % 2 ? hue : accent, crystalline ? 1.6 : 1.9, 0.62);
  }
  return left + mirror(left);
}

function mechanical(l) {
  let out = halo(l.hue, l.accent, l.seed) + mechanicalBody(l.hue, l.accent);
  for (let i = 0; i < 8; i++) {
    const y = 148 + i * 28;
    const d = `M224 ${y}L${120 - i * 3} ${y + 18}L224 ${y + 34}`;
    out += path(d, i % 2 ? l.hue : l.accent, 1.8, 0.62) + mirror(path(d, i % 2 ? l.hue : l.accent, 1.8, 0.62));
  }
  for (let x = 176; x <= 336; x += 32) out += line(x, 110, x, 410, l.hue, 1.2, 0.34);
  for (let y = 176; y <= 336; y += 32) out += line(120, y, 392, y, l.accent, 1.2, 0.3);
  for (let i = 0; i < 18; i++) out += circle(136 + (i % 6) * 48, 158 + Math.floor(i / 6) * 82, 4, l.hue, 1, 0.75, l.hue);
  return out;
}

function idol(l) {
  let out = halo(l.hue, l.accent, l.seed) + idolBody(l.hue, l.accent);
  out += path("M188 406H324M204 432H308M224 458H288", l.accent, 3, 0.75);
  out += path("M256 78L286 154L256 132L226 154Z", l.hue, 2.4, 0.82);
  out += path("M206 184C150 206 130 260 112 342M306 184C362 206 382 260 400 342", l.hue, 2.4, 0.72);
  out += path("M196 238C162 266 150 314 146 380M316 238C350 266 362 314 366 380", l.accent, 1.8, 0.62);
  out += line(126, 170, 126, 382, l.hue, 2, 0.7) + circle(126, 170, 14, l.accent, 2, 0.9);
  out += line(386, 170, 386, 382, l.hue, 2, 0.7) + circle(386, 170, 14, l.accent, 2, 0.9);
  return out;
}

function citadel(l) {
  let out = halo(l.hue, l.accent, l.seed) + citadelBody(l.hue, l.accent);
  for (let i = 0; i < 5; i++) {
    const x = 150 + i * 54;
    const h = 92 + (i % 2) * 42;
    out += path(`M${x} 420V${420 - h}L${x + 18} ${396 - h}L${x + 36} ${420 - h}V420`, i % 2 ? l.hue : l.accent, 2.2, 0.72);
  }
  out += path("M172 420H340M192 448H320", l.accent, 3, 0.7);
  return out;
}

function crystal(l) {
  let out = halo(l.hue, l.accent, l.seed) + crystalBody(l.hue, l.accent) + feathers(l.hue, l.accent, l.seed, true);
  for (let i = 0; i < 6; i++) {
    const r = 54 + i * 18;
    out += path(`M256 ${n(210 - r)}L${n(256 + r)} 256L256 ${n(302 + r)}L${n(256 - r)} 256Z`, i % 2 ? l.hue : l.accent, 1.5, 0.24 + i * 0.04);
  }
  return out;
}

function star(l) {
  let out = halo(l.hue, l.accent, l.seed) + starBody(l.hue, l.accent);
  for (let i = 0; i < 7; i++) out += orbit(256, 256, 68 + i * 22, 32 + i * 15, 3 + i, i * 0.7, i % 2 ? l.hue : l.accent, 0.25 + i * 0.04);
  for (let i = 0; i < 12; i++) {
    const [x, y] = polar(256, 256, 88 + (i % 4) * 36, (Math.PI * 2 * i) / 12);
    out += circle(x, y, 3 + (i % 3), l.accent, 1, 0.8, l.accent);
  }
  return out;
}

function rune(l) {
  let out = halo(l.hue, l.accent, l.seed) + runeBody(l.hue, l.accent);
  for (let i = 0; i < 8; i++) {
    const x = 146 + i * 32;
    out += path(`M${x} 112V414M${x - 10} ${160 + (i % 2) * 34}H${x + 14}M${x - 8} ${260 + (i % 3) * 22}H${x + 12}`, i % 2 ? l.hue : l.accent, 1.7, 0.46);
  }
  out += feathers(l.hue, l.accent, l.seed + 3);
  return out;
}

const renderers = { mechanical, idol, citadel, crystal, star, rune };

function svg(l) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    `<rect width="512" height="512" fill="#05070a"/>`,
    `<rect x="18" y="18" width="476" height="476" fill="none" stroke="${l.hue}" opacity=".22"/>`,
    renderers[l.id](l),
    `<text x="256" y="482" fill="${l.accent}" font-family="monospace" font-size="18" text-anchor="middle">${l.name}</text>`,
    `</svg>`,
  ].join("");
}

function earlySvg(l) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    `<rect width="512" height="512" fill="#05070a"/>`,
    `<rect x="92" y="92" width="328" height="328" fill="none" stroke="${l.hue}" opacity=".10"/>`,
    orbit(256, 256, 42, 30, 1, l.seed * 0.17, l.hue, 0.26),
    circle(256, 256, 10, l.accent, 2, 0.78),
    path("M256 218V294", l.hue, 2, 0.62),
    earlyLineage(l),
    `<text x="256" y="452" fill="${l.accent}" font-family="monospace" font-size="15" text-anchor="middle">${l.name} / +10 COMMON</text>`,
    `</svg>`,
  ].join("");
}

function earlyLineage(l) {
  if (l.id === "mechanical") {
    return path("M214 256H298M238 232V280M274 232V280", l.accent, 1.6, 0.5);
  }
  if (l.id === "idol") {
    return path("M232 292H280L266 224H246ZM224 312H288", l.accent, 1.7, 0.52);
  }
  if (l.id === "citadel") {
    return path("M226 304V248L256 220L286 248V304", l.accent, 1.8, 0.52);
  }
  if (l.id === "crystal") {
    return path("M256 208L302 256L256 318L210 256ZM256 208V318", l.accent, 1.7, 0.52);
  }
  if (l.id === "star") {
    return path("M256 208V310M204 256H308M220 220L292 292M292 220L220 292", l.accent, 1.5, 0.48);
  }
  return path("M256 212V310M226 238H286M238 276H274", l.accent, 1.8, 0.52);
}

function mutatedSvg(l, level = 2) {
  const secondary = lineages[(lineages.findIndex((x) => x.id === l.id) + 2) % lineages.length];
  const label = level === 1 ? "MINOR" : level === 2 ? "MAJOR" : "MYTHIC";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    `<rect width="512" height="512" fill="#05070a"/>`,
    `<rect x="18" y="18" width="476" height="476" fill="none" stroke="${l.hue}" opacity=".28"/>`,
    mutationAura(secondary.hue, l.accent, l.seed, level),
    mutationWings(secondary.hue, l.accent, l.seed, level),
    renderers[l.id](l),
    mutationBodies(secondary.hue, l.accent, level),
    mutationHeads(secondary.hue, l.accent, l.seed, level),
    mutationArms(secondary.hue, l.accent, l.seed, level),
    mutationEyes(secondary.hue, l.accent, l.seed, level),
    mutationSigils(secondary.hue, l.accent, l.seed, level),
    mutationCrown(secondary.hue, l.accent, level),
    `<text x="256" y="482" fill="${l.accent}" font-family="monospace" font-size="18" text-anchor="middle">${l.name} / ${label}</text>`,
    `</svg>`,
  ].join("");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const lineage of lineages) {
  fs.writeFileSync(`${OUT_DIR}/${lineage.id}.svg`, `${svg(lineage)}\n`);
  fs.writeFileSync(`${OUT_DIR}/${lineage.id}-early.svg`, `${earlySvg(lineage)}\n`);
  fs.writeFileSync(`${OUT_DIR}/${lineage.id}-minor.svg`, `${mutatedSvg(lineage, 1)}\n`);
  fs.writeFileSync(`${OUT_DIR}/${lineage.id}-major.svg`, `${mutatedSvg(lineage, 2)}\n`);
  fs.writeFileSync(`${OUT_DIR}/${lineage.id}-mythic.svg`, `${mutatedSvg(lineage, 3)}\n`);
}
console.log(
  JSON.stringify(
    lineages.flatMap((l) => [
      `${OUT_DIR}/${l.id}.svg`,
      `${OUT_DIR}/${l.id}-early.svg`,
      `${OUT_DIR}/${l.id}-minor.svg`,
      `${OUT_DIR}/${l.id}-major.svg`,
      `${OUT_DIR}/${l.id}-mythic.svg`,
    ]),
    null,
    2,
  ),
);
