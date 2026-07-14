const fs = require("fs");
const { execFileSync } = require("child_process");

const OUT = "reports/shape-algebra-preview";
const W = 1024;
const H = 1024;
const CX = 512;
const CY = 500;
const TAU = Math.PI * 2;

const forms = [
  { id: 0, name: "Mechanical", c0: "#52e7f2", c1: "#d9fbff", bg: "#050b0d" },
  { id: 1, name: "Idol", c0: "#f0d26b", c1: "#fff0b8", bg: "#0b0905" },
  { id: 2, name: "Citadel", c0: "#8bd17c", c1: "#e7ffd7", bg: "#070d08" },
  { id: 3, name: "Crystal", c0: "#b993ff", c1: "#ff6db2", bg: "#090711" },
  { id: 4, name: "Star", c0: "#50d8e7", c1: "#e9ffd3", bg: "#05090d" },
  { id: 5, name: "Rune", c0: "#ff6aa6", c1: "#e7c16b", bg: "#0d070b" },
];

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function wave(kind, t, seed = 1) {
  if (kind === 0) return 1 / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t))) - 1; // square
  if (kind === 1) return 0.42 * Math.cos(3 * t) + 0.18 * Math.cos(6 * t + 0.4); // idol triangle
  if (kind === 2) return 0.34 * Math.sign(Math.sin(4 * t)) + 0.12 * Math.cos(8 * t); // citadel steps
  if (kind === 3) return 0.56 * Math.abs(Math.cos(2 * t)) - 0.18 * Math.sin(4 * t); // crystal diamond
  if (kind === 4) return 0.34 * Math.cos(5 * t) + 0.2 * Math.cos(10 * t + 0.7); // star
  const breaks = Math.sin(6 * t + (seed % 17)) > 0 ? 0.28 : -0.1; // rune broken
  return breaks + 0.12 * Math.cos(11 * t);
}

function blendValue(sequence, t, seed, mode) {
  let value = 1;
  let memory = 0;
  for (let i = 0; i < sequence.length; i++) {
    const kind = sequence[i];
    const phase = ((seed >> (i * 3)) % 31) / 31 * TAU;
    const w = wave(kind, t + phase, seed + i * 13);
    const dominance = i === sequence.length - 1 ? 0.54 : 0.26 / Math.max(1, sequence.length - 1);
    value += dominance * w;
    memory += w * (0.18 + i * 0.035);
  }
  const interaction = wave(sequence[0], t, seed) * wave(sequence[sequence.length - 1], t + 0.6, seed);
  const route = mode === "fusion" ? 0.28 : mode === "bluechip" ? 0.18 : 0.08;
  return Math.max(0.28, value + route * interaction + 0.08 * Math.sin(memory * 2 + t * (sequence.length + 1)));
}

function polarPath(sequence, opts = {}) {
  const seed = opts.seed ?? hash32(sequence.join(":"));
  const mode = opts.mode ?? "fusion";
  const points = [];
  const count = opts.count ?? 160;
  const base = opts.base ?? 170;
  for (let i = 0; i <= count; i++) {
    const t = (i / count) * TAU;
    const r = base * blendValue(sequence, t, seed, mode);
    const x = CX + r * Math.cos(t);
    const y = CY + r * Math.sin(t);
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `${points.join(" ")}Z`;
}

function arcLayer(seed, color, opacity, count, rotate = 0) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const y = 310 + i * 34 + ((seed >> i) % 18);
    const bend = 80 + ((seed >> (i + 5)) % 130);
    const x0 = 110 + ((seed >> (i + 10)) % 70);
    const x1 = 914 - ((seed >> (i + 12)) % 70);
    out += `<path d="M${x0} ${y}C${300 - bend} ${y - 70} ${724 + bend} ${y + 70} ${x1} ${y}" fill="none" stroke="${color}" stroke-width="${i % 3 === 0 ? 3 : 2}" opacity="${opacity}"/>`;
  }
  return `<g transform="rotate(${rotate} ${CX} ${CY})">${out}</g>`;
}

function nodeLayer(seed, color, count, radius = 286) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const t = ((seed >> (i % 23)) + i * 37) % 360 / 360 * TAU;
    const r = radius * (0.48 + (((seed >> (i % 15)) % 100) / 180));
    const x = CX + Math.cos(t) * r;
    const y = CY + Math.sin(t) * r;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 5 === 0 ? 9 : 4}" fill="${color}" opacity=".78"/>`;
  }
  return out;
}

function lineageOrnament(kind, color, seed) {
  if (kind === 0) {
    return `<path d="M420 270H604V690H420ZM456 330H568M456 395H568M456 460H568M456 525H568M456 590H568" fill="none" stroke="${color}" stroke-width="5" opacity=".9"/>${mechanicalGlyphs(color, seed)}`;
  }
  if (kind === 1) {
    return `<path d="M512 210L610 690H414Z M512 210V730 M452 450H572" fill="none" stroke="${color}" stroke-width="5" opacity=".9"/>${idolGlyphs(color, seed)}`;
  }
  if (kind === 2) {
    return `<path d="M350 710V360L512 230L674 360V710M404 710V480H470V710M554 710V480H620V710M380 370H644M420 310H604" fill="none" stroke="${color}" stroke-width="5" opacity=".88"/>${citadelGlyphs(color, seed)}`;
  }
  if (kind === 3) {
    return `<path d="M512 180L666 500L512 820L358 500Z M512 180V820M358 500H666M420 330L604 670M604 330L420 670" fill="none" stroke="${color}" stroke-width="5" opacity=".9"/>${crystalGlyphs(color, seed)}`;
  }
  if (kind === 4) {
    return `<circle cx="512" cy="500" r="210" fill="none" stroke="${color}" stroke-width="4" opacity=".5"/><ellipse cx="512" cy="500" rx="315" ry="70" fill="none" stroke="${color}" stroke-width="5" opacity=".75" transform="rotate(18 512 500)"/><ellipse cx="512" cy="500" rx="315" ry="70" fill="none" stroke="${color}" stroke-width="3" opacity=".55" transform="rotate(-42 512 500)"/>${starGlyphs(color, seed)}`;
  }
  return `<path d="M512 210V790M440 300H585M462 390H560M424 520H598M474 640H550M484 300L540 390L484 520L540 640" fill="none" stroke="${color}" stroke-width="5" opacity=".9"/>${runeGlyphs(color, seed)}`;
}

function mechanicalGlyphs(color, seed) {
  let out = "";
  for (let i = 0; i < 7; i++) {
    const x = 210 + i * 98;
    const y = 190 + ((seed >> i) % 36);
    out += `<path d="M${x} ${y}h42v42h-42ZM${x + 21} ${y - 24}v90M${x - 24} ${y + 21}h90" fill="none" stroke="${color}" stroke-width="2" opacity=".38"/>`;
  }
  return out;
}

function idolGlyphs(color, seed) {
  let out = `<path d="M330 315C420 255 604 255 694 315M330 430C430 380 594 380 694 430" fill="none" stroke="${color}" stroke-width="3" opacity=".36"/>`;
  for (let i = 0; i < 6; i++) {
    const y = 330 + i * 54;
    out += `<path d="M512 ${y}C${430 - i * 10} ${y + 12} ${374 - i * 8} ${y + 50} ${330 - i * 6} ${y + 80}M512 ${y}C${594 + i * 10} ${y + 12} ${650 + i * 8} ${y + 50} ${694 + i * 6} ${y + 80}" fill="none" stroke="${color}" stroke-width="3" opacity=".34"/>`;
  }
  return out;
}

function citadelGlyphs(color, seed) {
  let out = "";
  for (let i = 0; i < 5; i++) {
    const x = 190 + i * 160;
    const h = 120 + ((seed >> i) % 90);
    out += `<path d="M${x} 760V${760 - h}l36-34l36 34v${h}M${x - 20} 760h112M${x + 18} ${746 - h}h36" fill="none" stroke="${color}" stroke-width="3" opacity=".42"/>`;
  }
  return out;
}

function crystalGlyphs(color, seed) {
  let out = "";
  for (let i = 0; i < 10; i++) {
    const x = 120 + ((seed >> (i % 13)) % 780);
    const y = 170 + i * 66;
    const h = 38 + ((seed >> (i + 3)) % 52);
    out += `<path d="M${x} ${y - h}L${x + 34} ${y}L${x} ${y + h}L${x - 34} ${y}Z" fill="none" stroke="${color}" stroke-width="3" opacity=".34"/>`;
  }
  return out;
}

function starGlyphs(color, seed) {
  let out = "";
  for (let i = 0; i < 18; i++) {
    const t = (i / 18) * TAU + ((seed % 17) / 17);
    const r = 170 + (i % 3) * 82;
    const x = CX + Math.cos(t) * r;
    const y = CY + Math.sin(t) * r;
    out += `<path d="M${(x - 18).toFixed(1)} ${y.toFixed(1)}h36M${x.toFixed(1)} ${(y - 18).toFixed(1)}v36" stroke="${color}" stroke-width="2" opacity=".38"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 4 === 0 ? 6 : 3}" fill="${color}" opacity=".48"/>`;
  }
  return out;
}

function runeGlyphs(color, seed) {
  const glyphs = ["A", "K", "R", "X", "Z", "M", "V", "Y", "I", "O"];
  let out = `<path d="M126 154V858M898 154V858" stroke="${color}" stroke-width="2" opacity=".28"/>`;
  for (let i = 0; i < 20; i++) {
    const left = i % 2 === 0;
    const x = left ? 126 : 898;
    const y = 190 + i * 34;
    const g = glyphs[(seed + i * 7) % glyphs.length];
    out += `<text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="23" text-anchor="middle" opacity=".48">${g}</text>`;
  }
  return out;
}

function routeLayers(sequence, route, seed, palette) {
  const primary = sequence[0];
  const last = sequence[sequence.length - 1];
  let out = "";
  if (route === "ordinary") {
    out += arcLayer(seed, palette.c0, ".12", 9);
    out += nodeLayer(seed, palette.c1, 26, 280);
  } else if (route === "bluechip") {
    out += `<rect x="36" y="36" width="952" height="952" fill="none" stroke="${palette.c1}" stroke-width="4" opacity=".55"/>`;
    out += arcLayer(seed, palette.c1, ".28", 16, 8);
    out += `<circle cx="512" cy="500" r="360" fill="none" stroke="${palette.c0}" stroke-width="5" opacity=".35"/>`;
    out += nodeLayer(seed, palette.c0, 50, 340);
  } else {
    out += arcLayer(seed, palette.c0, ".22", 9, -12);
    out += arcLayer(seed >> 2, palette.c1, ".18", 7, 17);
    out += nodeLayer(seed, palette.c1, 42, 320);
  }
  out += lineageOrnament(primary, palette.c0, seed);
  if (last !== primary) out += `<g opacity=".58">${lineageOrnament(last, palette.c1, seed >> 3)}</g>`;
  if (route !== "ordinary" || sequence.length > 1) {
    out += creatureLayer(sequence, route, seed, palette);
  }
  return out;
}

function creatureLayer(sequence, route, seed, palette) {
  const primary = sequence[0];
  const last = sequence[sequence.length - 1];
  const hybrid = sequence.length > 1;
  const heads = route === "bluechip" ? 2 + (seed % 3) : hybrid && (seed & 8) ? 2 : 1;
  const bodies = route === "bluechip" ? 2 + ((seed >> 5) % 2) : sequence.length >= 3 ? 2 : 1;
  const wingSpan = 180 + sequence.length * 42 + (route === "bluechip" ? 110 : 0);
  const bodyColor = palette.c0;
  const accent = palette.c1;
  let out = `<g stroke-linecap="round" stroke-linejoin="round" opacity=".92">`;

  if (last === 0 || primary === 0) out += mechanicalBody(bodyColor, accent, bodies, seed);
  else if (last === 1 || primary === 1) out += idolBody(bodyColor, accent, bodies, seed);
  else if (last === 2 || primary === 2) out += citadelBody(bodyColor, accent, bodies, seed);
  else if (last === 3 || primary === 3) out += crystalBody(bodyColor, accent, bodies, seed);
  else if (last === 4 || primary === 4) out += starBody(bodyColor, accent, bodies, seed);
  else out += runeBody(bodyColor, accent, bodies, seed);

  if (hybrid) out += wingLayer(last, accent, wingSpan, seed);
  out += headLayer(last, bodyColor, accent, heads, seed);
  out += mutationMarks(sequence, bodyColor, accent, seed);
  return `${out}</g>`;
}

function headLayer(kind, color, accent, heads, seed) {
  let out = "";
  for (let i = 0; i < heads; i++) {
    const dx = heads === 1 ? 0 : (i - (heads - 1) / 2) * 88;
    const y = heads > 1 ? 245 + (i % 2) * 38 : 255;
    const eye = kind === 5 ? "M-20 0H20M0-20V20" : kind === 3 ? "M0-34L34 0L0 34L-34 0Z" : "M-36 0C-8-28 8-28 36 0C8 28-8 28-36 0Z";
    out += `<g transform="translate(${512 + dx} ${y})"><path d="${eye}" fill="${kind === 3 ? accent : "none"}" fill-opacity=".07" stroke="${accent}" stroke-width="4"/><circle cx="-11" cy="2" r="4" fill="${color}"/><circle cx="11" cy="2" r="4" fill="${color}"/></g>`;
  }
  return out;
}

function mechanicalBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 72;
    out += `<path d="M${x - 42} 330H${x + 42}V675H${x - 42}ZM${x - 42} 430H${x + 42}M${x - 42} 540H${x + 42}M${x} 330V675" fill="none" stroke="${color}" stroke-width="6"/><path d="M${x - 78} 390h-78v84M${x + 78} 390h78v84M${x - 78} 600h-90v-70M${x + 78} 600h90v-70" fill="none" stroke="${accent}" stroke-width="4" opacity=".75"/>`;
  }
  return out;
}

function idolBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 68;
    out += `<path d="M${x} 300L${x + 76} 705H${x - 76}Z M${x} 300V735 M${x - 48} 470H${x + 48}" fill="none" stroke="${color}" stroke-width="6"/><path d="M${x - 118} 450C${x - 220} 515 ${x - 188} 640 ${x - 88} 650M${x + 118} 450C${x + 220} 515 ${x + 188} 640 ${x + 88} 650" fill="none" stroke="${accent}" stroke-width="4" opacity=".68"/>`;
  }
  return out;
}

function citadelBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 74;
    out += `<path d="M${x - 62} 700V390L${x} 320L${x + 62} 390V700M${x - 95} 700H${x + 95}M${x - 38} 465H${x + 38}M${x - 38} 540H${x + 38}" fill="none" stroke="${color}" stroke-width="6"/><path d="M${x - 140} 700V520l38-38l38 38v180M${x + 64} 700V520l38-38l38 38v180" fill="none" stroke="${accent}" stroke-width="4" opacity=".7"/>`;
  }
  return out;
}

function crystalBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 70;
    out += `<path d="M${x} 290L${x + 88} 505L${x} 735L${x - 88} 505Z M${x} 290V735M${x - 88} 505H${x + 88}" fill="${accent}" fill-opacity=".035" stroke="${color}" stroke-width="6"/><path d="M${x - 130} 430L${x - 230} 350M${x + 130} 430L${x + 230} 350M${x - 122} 610L${x - 245} 695M${x + 122} 610L${x + 245} 695" stroke="${accent}" stroke-width="4" opacity=".72"/>`;
  }
  return out;
}

function starBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 72;
    out += `<path d="M${x} 300L${x + 36} 455L${x + 140} 392L${x + 70} 540L${x + 170} 650L${x + 22} 620L${x} 760L${x - 22} 620L${x - 170} 650L${x - 70} 540L${x - 140} 392L${x - 36} 455Z" fill="none" stroke="${color}" stroke-width="5"/><circle cx="${x}" cy="520" r="54" fill="none" stroke="${accent}" stroke-width="4"/>`;
  }
  return out;
}

function runeBody(color, accent, bodies, seed) {
  let out = "";
  for (let i = 0; i < bodies; i++) {
    const x = 512 + (i - (bodies - 1) / 2) * 70;
    out += `<path d="M${x} 285V735M${x - 88} 370H${x + 72}M${x - 56} 465H${x + 96}M${x - 110} 585H${x + 86}M${x - 40} 370L${x + 52} 465L${x - 64} 585L${x + 40} 735" fill="none" stroke="${color}" stroke-width="6"/><path d="M${x - 138} 420C${x - 240} 470 ${x - 220} 625 ${x - 105} 660M${x + 138} 420C${x + 240} 470 ${x + 220} 625 ${x + 105} 660" fill="none" stroke="${accent}" stroke-width="4" opacity=".68"/>`;
  }
  return out;
}

function wingLayer(kind, color, span, seed) {
  let out = "";
  const featherCount = 5 + (kind % 3);
  for (let side of [-1, 1]) {
    for (let i = 0; i < featherCount; i++) {
      const y0 = 350 + i * 44;
      const tipX = 512 + side * (span + i * 26);
      const tipY = 290 + i * 70 + ((seed >> i) % 30);
      const ctrlX = 512 + side * (120 + i * 28);
      out += `<path d="M${512 + side * 58} ${y0}C${ctrlX} ${y0 - 90} ${tipX} ${tipY - 25} ${tipX} ${tipY}C${ctrlX} ${tipY + 28} ${512 + side * 82} ${y0 + 35} ${512 + side * 58} ${y0}" fill="none" stroke="${color}" stroke-width="${i === 0 ? 5 : 3}" opacity="${0.72 - i * .055}"/>`;
    }
  }
  return out;
}

function mutationMarks(sequence, color, accent, seed) {
  let out = "";
  const count = Math.min(28, 6 + sequence.length * 6);
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = 512 + side * (90 + ((seed >> (i % 16)) % 300));
    const y = 260 + i * 24 + ((seed >> (i % 11)) % 34);
    if (sequence[i % sequence.length] === 3) out += `<path d="M${x} ${y - 18}L${x + 16} ${y}L${x} ${y + 18}L${x - 16} ${y}Z" fill="none" stroke="${accent}" stroke-width="2" opacity=".58"/>`;
    else if (sequence[i % sequence.length] === 5) out += `<text x="${x}" y="${y}" fill="${accent}" font-family="monospace" font-size="21" text-anchor="middle" opacity=".55">${["A","V","X","K","M","R"][(seed + i) % 6]}</text>`;
    else out += `<circle cx="${x}" cy="${y}" r="${i % 4 === 0 ? 8 : 4}" fill="${i % 3 === 0 ? color : accent}" opacity=".64"/>`;
  }
  return out;
}

function svg(sequence, label, route = "fusion") {
  const seed = hash32(`${label}:${sequence.join("-")}:${route}`);
  const primary = forms[sequence[0]];
  const last = forms[sequence[sequence.length - 1]];
  const palette = { c0: primary.c0, c1: last.c1, bg: primary.bg };
  const closed = polarPath(sequence, { seed, mode: route, base: route === "bluechip" ? 208 : 176 });
  const inner = polarPath(sequence.slice().reverse(), { seed: seed >> 1, mode: route, base: 92, count: 128 });
  const animated = route === "bluechip" || route === "fusion";
  const slowSpin = animated ? `<animateTransform attributeName="transform" type="rotate" from="0 ${CX} ${CY}" to="360 ${CX} ${CY}" dur="${route === "bluechip" ? 42 : 58}s" repeatCount="indefinite"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${palette.bg}"/>
<g opacity=".95">${routeLayers(sequence, route, seed, palette)}</g>
<g>${slowSpin}<path d="${closed}" fill="none" stroke="${palette.c0}" stroke-width="6" opacity=".88" stroke-linejoin="round"/><path d="${inner}" fill="${palette.c1}" fill-opacity=".045" stroke="${palette.c1}" stroke-width="4" opacity=".82" stroke-linejoin="round"/></g>
<circle cx="${CX}" cy="${CY}" r="48" fill="none" stroke="${palette.c1}" stroke-width="5" opacity=".86"/>
<circle cx="${CX}" cy="${CY}" r="12" fill="${palette.c0}" opacity=".85"><animate attributeName="opacity" values=".45;.95;.45" dur="4.2s" repeatCount="indefinite"/></circle>
<text x="512" y="964" fill="${palette.c1}" font-family="monospace" font-size="33" font-weight="700" text-anchor="middle">${label}</text>
</svg>`;
}

const samples = [
  ["01-mechanical-base", [0], "Mechanical", "ordinary"],
  ["02-crystal-base", [3], "Crystal", "ordinary"],
  ["03-star-base", [4], "Star", "ordinary"],
  ["04-rune-base", [5], "Rune", "ordinary"],
  ["05-mechanical-crystal", [0, 3], "Mechanical + Crystal", "fusion"],
  ["06-crystal-mechanical", [3, 0], "Crystal + Mechanical", "fusion"],
  ["07-star-rune", [4, 5], "Star + Rune", "fusion"],
  ["08-rune-star-rune", [5, 4, 5], "Rune + Star + Rune", "fusion"],
  ["09-citadel-idol", [2, 1], "Citadel + Idol", "fusion"],
  ["10-mech-crystal-mech", [0, 3, 0], "Mechanical + Crystal + Mechanical", "fusion"],
  ["11-ordinary-10000", [3], "Crystal / ordinary x10000", "ordinary"],
  ["12-bluechip-10000", [3, 4], "Crystal + Star / bluechip x10000", "bluechip"],
];

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const [name, seq, label, route] of samples) {
  const file = `${OUT}/${name}.svg`;
  fs.writeFileSync(file, svg(seq, label, route));
  try {
    execFileSync("qlmanage", ["-t", "-s", "1024", "-o", OUT, file], { stdio: "ignore" });
  } catch (error) {
    console.warn(`preview failed for ${file}: ${error.message}`);
  }
  rows.push({ name, label, route, svg: file, png: `${file}.png` });
}

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4096 3072">
<rect width="4096" height="3072" fill="#050607"/>
${rows.map((r, i) => {
  const x = (i % 4) * 1024;
  const y = Math.floor(i / 4) * 1024;
  const body = fs.readFileSync(r.svg, "utf8").replace(/<\/?svg[^>]*>/g, "");
  return `<g transform="translate(${x} ${y})">${body}</g>`;
}).join("\n")}
</svg>`;
fs.writeFileSync(`${OUT}/contact-sheet.svg`, sheet);
try {
  execFileSync("qlmanage", ["-t", "-s", "2048", "-o", OUT, `${OUT}/contact-sheet.svg`], { stdio: "ignore" });
} catch {}

fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
