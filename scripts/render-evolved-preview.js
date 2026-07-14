const crypto = require("crypto");
const fs = require("fs");

const mode = process.argv[2] || "base";
const outPath = process.argv[3] || `reports/evolved-being-${mode}.svg`;

const states = {
base: {
  tokenId: 4096,
  mass: 1880,
  complexity: 740,
  devours: 52,
  fusions: 6,
  power: 79,
  skill: 66,
  scars: 5,
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
  scars: 11,
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
  scars: 18,
  stage: 10,
  mutation: 5,
  genome: "0xff31c0d99b3e7a142ed5aef9cce48f4fe2eaf65d8efc91b7c34d99fb163a7ae0",
},
};

const state = states[mode] || states.base;

const W = 1024;
const H = 1024;
const CX = 512;
const C = {
  bg: "#020506",
  ink: "#effcff",
  dim: "#789094",
  cyan: "#3df3ff",
  blue: "#50a8ff",
  violet: "#a98cff",
};

function h(...parts) {
  return BigInt(`0x${crypto.createHash("sha256").update(parts.join("|")).digest("hex")}`);
}

function n(seed, min, max) {
  return Number(seed % BigInt(max - min + 1)) + min;
}

function line(x1, y1, x2, y2, color = C.ink, width = 2, opacity = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"/>`;
}

function path(d, color = C.ink, width = 2, fill = "none", opacity = 1) {
  return `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function circle(x, y, r, color = C.ink, width = 2, fill = "none", opacity = 1) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${color}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function rect(x, y, w, h, color, opacity = 1) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" opacity="${opacity}"/>`;
}

function txt(x, y, value, size = 18, color = C.ink, anchor = "middle", opacity = 1) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="${size}" text-anchor="${anchor}" opacity="${opacity}">${value}</text>`;
}

function mirror(left) {
  return `<g>${left}</g><g transform="translate(${W},0) scale(-1,1)">${left}</g>`;
}

function frame() {
  let out = "";
  out += rect(0, 0, W, H, C.bg);
  out += `<rect x="28" y="28" width="968" height="968" fill="none" stroke="${C.dim}" stroke-width="2" opacity="0.65"/>`;
  out += `<rect x="54" y="54" width="916" height="916" fill="none" stroke="${C.cyan}" stroke-width="1" opacity="0.34"/>`;
  for (let i = 0; i < 14; i++) {
    const y = 92 + i * 58;
    const long = i % 3 === 0;
    out += line(64, y, long ? 216 : 154, y, i % 4 === 0 ? C.cyan : C.ink, 2, 0.52);
    out += line(960, y, long ? 808 : 870, y, i % 4 === 0 ? C.cyan : C.ink, 2, 0.52);
    if (i % 2 === 0) {
      out += circle(236, y, 5, C.ink, 2, "none", 0.6);
      out += circle(788, y, 5, C.ink, 2, "none", 0.6);
    }
  }
  return out;
}

function recursiveCrown() {
  function branch(x, y, len, angle, depth, tag) {
    if (depth === 0) return "";
    const r = (angle * Math.PI) / 180;
    const x2 = Math.round(x + Math.cos(r) * len);
    const y2 = Math.round(y - Math.sin(r) * len);
    const seed = h(state.genome, tag, depth);
    const split = n(seed, 16, 28);
    let out = line(x, y, x2, y2, depth > 3 ? C.ink : C.cyan, depth > 4 ? 3 : 2, 0.86);
    out += branch(x2, y2, Math.round(len * 0.68), angle + split, depth - 1, `${tag}a`);
    if (depth > 2) out += branch(x2, y2, Math.round(len * 0.58), angle - split, depth - 1, `${tag}b`);
    return out;
  }
  return mirror(branch(392, 290, 126 + state.stage * 4, 112, Math.min(9, 5 + state.mutation), "crown"));
}

function body() {
  let left = "";
  if (mode === "base") {
    left += path("M512 188 L438 292 L392 448 L410 612 L446 814 L512 918", C.ink, 3, "none", 0.96);
    left += path("M512 308 L462 368 L436 494 L454 676 L512 792", C.dim, 2, "none", 0.55);
    left += path("M512 382 L472 454 L472 720 L512 830", C.cyan, 2, "none", 0.8);
  } else if (mode === "devoured3x") {
    left += path("M512 142 L424 236 L342 384 L320 598 L374 842 L512 948", C.ink, 4, "rgba(239,252,255,0.04)", 0.98);
    left += path("M512 278 L430 336 L374 492 L388 722 L512 870", C.dim, 2, "none", 0.65);
    left += path("M512 360 L452 430 L432 700 L512 842", C.cyan, 3, "none", 0.86);
    left += path("M352 472 L248 540 L248 684 L336 732", C.ink, 3, "none", 0.82);
    left += path("M322 662 L224 752 L232 840 L392 850", C.cyan, 2, "none", 0.68);
  } else {
    left += path("M512 118 L396 222 L300 392 L342 558 L276 710 L394 888 L512 972", C.violet, 4, "rgba(169,140,255,0.05)", 0.98);
    left += path("M512 258 L414 330 L352 494 L396 630 L354 784 L512 918", C.ink, 3, "none", 0.82);
    left += path("M512 342 L438 424 L472 568 L420 712 L512 846", C.cyan, 3, "none", 0.92);
    left += path("M342 414 L216 354 L250 512 L164 594 L284 690", C.violet, 2, "none", 0.72);
    left += path("M360 734 L196 768 L310 844 L236 930 L436 900", C.cyan, 2, "none", 0.74);
  }

  for (let i = 0; i < 18 + state.stage * 3; i++) {
    const seed = h(state.genome, "armor", i);
    const y = n(seed, 330, 820);
    const x1 = n(seed >> 8n, 408, 500);
    const x2 = n(seed >> 16n, 344, 474);
    const color = i % 5 === 0 ? C.cyan : C.ink;
    left += line(x1, y, x2, y + n(seed >> 24n, -22, 22), color, i % 6 === 0 ? 3 : 2, 0.72);
    if (i % 4 === 0) left += circle(x2, y, 4, color, 1, "none", 0.72);
  }

  let out = mirror(left);
  if (mode === "base") {
    out += path("M512 176 L560 270 L512 360 L464 270 Z", C.ink, 3, "rgba(61,243,255,0.05)", 0.96);
    out += path("M512 406 L588 516 L558 774 L512 900 L466 774 L436 516 Z", C.ink, 3, "rgba(239,252,255,0.03)", 0.96);
    out += path("M512 486 L548 560 L536 704 L512 760 L488 704 L476 560 Z", C.cyan, 2, "none", 0.9);
  } else if (mode === "devoured3x") {
    out += path("M512 126 L604 246 L566 360 L512 402 L458 360 L420 246 Z", C.ink, 4, "rgba(61,243,255,0.06)", 0.98);
    out += path("M512 390 L632 502 L610 804 L512 930 L414 804 L392 502 Z", C.ink, 4, "rgba(239,252,255,0.04)", 0.98);
    out += path("M512 472 L574 560 L552 746 L512 836 L472 746 L450 560 Z", C.cyan, 3, "none", 0.94);
    out += path("M332 718 L692 718 L734 888 L290 888 Z", C.dim, 2, "none", 0.52);
  } else {
    out += path("M512 98 L628 234 L592 356 L512 438 L432 356 L396 234 Z", C.violet, 4, "rgba(169,140,255,0.08)", 0.98);
    out += path("M512 378 L662 506 L612 760 L512 956 L412 760 L362 506 Z", C.ink, 4, "rgba(239,252,255,0.03)", 0.96);
    out += path("M512 448 L586 548 L552 692 L586 800 L512 890 L438 800 L472 692 L438 548 Z", C.cyan, 3, "none", 0.94);
    out += path("M512 230 L542 286 L512 326 L482 286 Z", C.violet, 3, "rgba(169,140,255,0.18)", 0.9);
  }
  out += circle(CX, 520, 38 + state.mutation * 6, C.cyan, 2, "none", 0.95);
  out += circle(CX, 520, 14 + state.stage * 2, C.ink, 2, "none", 0.9);
  return out;
}

function sigil() {
  let out = "";
  for (const r of [72, 108, 146, 190]) out += circle(CX, 522, r, r === 146 ? C.cyan : C.dim, r === 146 ? 2 : 1, "none", 0.48);
  const pts = 12 + state.mutation * 2 + Math.floor(state.stage / 2);
  for (let i = 0; i < pts; i++) {
    const a = (Math.PI * 2 * i) / pts - Math.PI / 2;
    const b = (Math.PI * 2 * ((i * 5) % pts)) / pts - Math.PI / 2;
    const x1 = Math.round(CX + Math.cos(a) * 76);
    const y1 = Math.round(522 + Math.sin(a) * 76);
    const x2 = Math.round(CX + Math.cos(b) * 146);
    const y2 = Math.round(522 + Math.sin(b) * 146);
    out += line(x1, y1, x2, y2, i % 3 === 0 ? C.violet : C.cyan, 1, 0.62);
  }
  return out;
}

function texture() {
  let out = "";
  const cells = 19 + Math.min(8, state.stage);
  const size = mode === "mutated" ? 7 : 9;
  const startX = CX - Math.floor((cells * size) / 2);
  const startY = 586;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const dx = Math.abs(x - 10);
      const dy = Math.abs(y - 9);
      if (dx + dy > 16 + state.mutation) continue;
      const seed = h(state.genome, "grid", x, y, state.devours);
      if (Number(seed & 7n) > 3) continue;
      const color = Number(seed & 31n) === 0 ? C.violet : Number(seed & 3n) === 0 ? C.cyan : C.ink;
      out += rect(startX + x * size, startY + y * size, size - 2, size - 2, color, 0.62);
    }
  }
  return out;
}

function runes() {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-*/[]";
  let out = "";
  for (let i = 0; i < 36 + state.stage * 3 + state.mutation * 2; i++) {
    const seed = h(state.genome, "rune", i, state.skill);
    const side = i % 2 === 0 ? -1 : 1;
    const x = side < 0 ? n(seed, 90, 250) : n(seed, 774, 934);
    const y = n(seed >> 8n, 110, 900);
    const color = i % 9 === 0 ? C.cyan : i % 13 === 0 ? C.violet : C.ink;
    out += txt(x, y, chars[n(seed >> 16n, 0, chars.length - 1)], n(seed >> 24n, 13, 22), color, "middle", 0.66);
  }
  return out;
}

function base() {
  let out = "";
  out += path("M320 886 L704 886 L750 936 L274 936 Z", C.ink, 3, "none", 0.9);
  out += line(340, 912, 684, 912, C.cyan, 2, 0.62);
  out += line(384, 846, 640, 846, C.dim, 2, 0.55);
  for (let i = 0; i < 11; i++) {
    const x = 366 + i * 29;
    out += line(x, 886, x + (i % 2 ? 12 : -12), 846, i % 3 === 0 ? C.cyan : C.ink, 1, 0.55);
  }
  return out;
}

function mutationHalo() {
  if (mode === "devoured3x") {
    let out = "";
    for (let i = 0; i < 14; i++) {
      const x = 228 + i * 44;
      out += line(x, 206, x + (i % 2 ? -18 : 18), 154, i % 3 ? C.ink : C.cyan, 2, 0.56);
      out += line(x, 870, x + (i % 2 ? -20 : 20), 930, i % 3 ? C.ink : C.cyan, 2, 0.5);
    }
    return out;
  }
  if (state.mutation < 4) return "";
  let out = "";
  for (let i = 0; i < 30; i++) {
    const a = (Math.PI * 2 * i) / 30 - Math.PI / 2;
    const inner = 238 + (i % 2) * 18;
    const outer = 344 + (i % 5) * 34;
    const x1 = Math.round(CX + Math.cos(a) * inner);
    const y1 = Math.round(512 + Math.sin(a) * inner);
    const x2 = Math.round(CX + Math.cos(a) * outer);
    const y2 = Math.round(512 + Math.sin(a) * outer);
    out += line(x1, y1, x2, y2, i % 2 ? C.violet : C.cyan, 2, 0.72);
  }
  out += circle(CX, 512, 318, C.violet, 2, "none", 0.4);
  out += circle(CX, 512, 398, C.cyan, 1, "none", 0.22);
  return out;
}

function render() {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    frame(),
    runes(),
    mutationHalo(),
    sigil(),
    recursiveCrown(),
    body(),
    texture(),
    base(),
    txt(CX, 92, `BEING #${state.tokenId} / ${mode.toUpperCase()}`, 28, C.ink),
    txt(CX, 128, `M${state.mass} C${state.complexity} P${state.power} S${state.skill} D${state.devours} F${state.fusions}`, 18, C.cyan),
    txt(CX, 966, `GENOME ${state.genome.slice(2, 18).toUpperCase()} STAGE ${state.stage} MUT ${state.mutation}`, 16, C.ink),
    `</svg>`,
  ].join("");

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(outPath, `${svg}\n`);
  console.log(outPath);
}

render();
