const fs = require("node:fs");
const { canonical, b64, bytes, hash, ensure } = require("./crypto");
const { LINEAGES } = require("./rules");

const PALETTES = ["#f8ce60", "#f58ead", "#70e6df", "#b5bcff", "#a8ec83", "#ff977e"];
const SHAPES = [
  [[-65,-110],[65,-110],[100,-60],[80,100],[40,130],[-40,130],[-80,100],[-100,-60]],
  [[0,-140],[60,-90],[80,-30],[75,100],[30,145],[-30,145],[-75,100],[-80,-30]],
  [[-85,-105],[85,-105],[85,20],[115,20],[115,135],[-115,135],[-115,20],[-85,20]],
  [[0,-150],[65,-75],[100,0],[65,90],[0,150],[-65,90],[-100,0],[-65,-75]],
  [[0,-135],[35,-35],[135,0],[35,35],[0,135],[-35,35],[-135,0],[-35,-35]],
  [[-25,-130],[85,-90],[45,0],[95,100],[20,145],[-85,90],[-45,0],[-95,-100]],
];

function rendererId() { return b64(hash(fs.readFileSync(__filename))); }

function inspectState(state) {
  ensure(state && ["active", "consumed"].includes(state.status), "INVALID_RENDER_STATE");
  bytes(state.being_id, 32); bytes(state.genome, 32);
  ensure(Number.isInteger(state.stage) && state.stage >= 0 && state.stage <= 3, "INVALID_RENDER_STATE");
  ensure(Array.isArray(state.lineage_weights) && state.lineage_weights.length === 6 &&
    state.lineage_weights.every((weight) => Number.isInteger(weight) && weight >= 0 && weight <= 10000) &&
    state.lineage_weights.reduce((sum, weight) => sum + weight, 0) === 10000, "INVALID_RENDER_STATE");
  ensure(Number.isInteger(state.glyph_rows) && state.glyph_rows >= 0 && state.glyph_rows <= 32 &&
    typeof state.border === "boolean", "INVALID_RENDER_STATE");
}

function lineageName(state) {
  return state.lineage_weights.map((weight, i) => ({ weight, name: LINEAGES[i] }))
    .filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((item) => item.name).join(" + ");
}

function renderSvg(state) {
  inspectState(state);
  const seed = bytes(state.genome, 32);
  const rank = state.lineage_weights.map((weight, i) => ({ weight, i })).sort((a, b) => b.weight - a.weight || a.i - b.i);
  const color = PALETTES[rank[0].i];
  const accent = PALETTES[rank[1].weight ? rank[1].i : (rank[0].i + 2) % 6];
  const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-=*";
  const glyph = glyphs[seed[7] % glyphs.length];
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">',
    '<rect width="640" height="640" fill="#080c0e"/>'];
  if (state.border) parts.push(`<rect x="18" y="18" width="604" height="604" rx="2" fill="none" stroke="#f8ce60" stroke-width="5"/>`);
  if (state.stage === 0) {
    const radius = 32 + seed[2] % 32;
    const x = 302 + seed[3] % 36;
    const y = 296 + seed[4] % 40;
    const family = rank[0].i;
    if (rank[1].weight > 0) {
      const points = SHAPES[0].map((_, j) => {
        let px = 0, py = 0;
        for (let i = 0; i < 6; i++) {
          px += SHAPES[i][j][0] * state.lineage_weights[i];
          py += SHAPES[i][j][1] * state.lineage_weights[i];
        }
        return [x + Math.trunc(px / 20000) + seed[8+j] % 5 - 2,
          y + Math.trunc(py / 20000) + seed[16+j] % 5 - 2];
      });
      parts.push(`<path d="M ${points[0].join(" ")} ${points.slice(1).map((point) => `L ${point.join(" ")}`).join(" ")} Z" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`);
    }
    else if (family === 0) parts.push(`<rect x="${x-radius}" y="${y-radius}" width="${radius*2}" height="${radius*2}" fill="none" stroke="${color}" stroke-width="3"/>`);
    else if (family === 1) parts.push(`<path d="M ${x} ${y-radius} L ${x+radius} ${y+radius} L ${x-radius} ${y+radius} Z" fill="none" stroke="${color}" stroke-width="3"/>`);
    else if (family === 2) parts.push(`<path d="M ${x-radius} ${y+radius} V ${y} Q ${x} ${y-radius*2} ${x+radius} ${y} V ${y+radius} Z" fill="none" stroke="${color}" stroke-width="3"/>`);
    else if (family === 3) parts.push(`<path d="M ${x} ${y-radius} L ${x+radius} ${y} L ${x} ${y+radius} L ${x-radius} ${y} Z" fill="none" stroke="${color}" stroke-width="3"/>`);
    else if (family === 4) parts.push(`<path d="M ${x-radius} ${y} H ${x+radius} M ${x} ${y-radius} V ${y+radius} M ${x-radius+8} ${y-radius+8} L ${x+radius-8} ${y+radius-8}" fill="none" stroke="${color}" stroke-width="3"/>`);
    else parts.push(`<path d="M ${x-radius} ${y-radius} L ${x+radius} ${y} L ${x-radius} ${y+radius} M ${x} ${y-radius} V ${y+radius}" fill="none" stroke="${color}" stroke-width="3"/>`);
    parts.push(`<text x="${x}" y="${y+8}" fill="${accent}" text-anchor="middle" font-family="monospace" font-size="24">${glyph}</text>`);
  } else {
    const points = SHAPES[0].map((_, j) => {
      let x = 0, y = 0;
      for (let i = 0; i < 6; i++) {
        x += SHAPES[i][j][0] * state.lineage_weights[i];
        y += SHAPES[i][j][1] * state.lineage_weights[i];
      }
      return [320 + Math.trunc(x / 10000) + seed[8+j] % 17 - 8,
        320 + Math.trunc(y / 10000) + seed[16+j] % 17 - 8];
    });
    const path = `M ${points[0].join(" ")} ${points.slice(1).map((point) => `L ${point.join(" ")}`).join(" ")} Z`;
    parts.push(`<path d="${path}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>`);
    const heads = state.stage === 3 ? 1 + seed[24] % 3 : 1;
    for (let i = 0; i < heads; i++) {
      const cx = 320 + (i * 2 - heads + 1) * 34;
      parts.push(`<path d="M ${cx} 153 L ${cx+18} 175 L ${cx} 197 L ${cx-18} 175 Z" fill="${accent}" fill-opacity="0.2" stroke="${accent}" stroke-width="3"/>`);
    }
    parts.push(`<path d="M 320 258 L 345 320 L 320 382 L 295 320 Z" fill="${accent}" fill-opacity="0.4" stroke="${accent}" stroke-width="2"/>`);
    if (state.stage >= 2) for (const sign of [-1, 1]) {
      const reach = 100 + seed[25] % 80;
      for (let feather = 0; feather < 3 + state.stage; feather++) {
        const endX = 320 + sign * (reach + feather * 8);
        const endY = 200 + feather * 42;
        parts.push(`<path d="M ${320+sign*62} 280 Q ${320+sign*120} ${200+feather*24} ${endX} ${endY} L ${320+sign*90} ${350+feather*15}" fill="none" stroke="${feather%2 ? accent : color}" stroke-width="2" opacity="0.7"/>`);
      }
    }
    parts.push(`<path d="M 290 442 L ${250-seed[26]%22} 525 L 285 525 M 350 442 L ${390+seed[27]%22} 525 L 355 525" fill="none" stroke="${color}" stroke-width="4"/>`);
  }
  if (state.glyph_rows) {
    const fontSize = Math.min(20, Math.floor(480 / state.glyph_rows));
    for (let i = 0; i < state.glyph_rows; i++) parts.push(`<text x="42" y="${80+i*fontSize}" fill="${accent}" font-family="monospace" font-size="${fontSize-2}">${glyphs[seed[i%32]%glyphs.length]}</text>`);
  }
  if (state.status === "consumed") parts.push('<text x="320" y="575" fill="#a9b4b8" text-anchor="middle" font-family="monospace" font-size="16">CONSUMED</text>');
  parts.push('</svg>');
  return parts.join("");
}

function metadata(state) {
  inspectState(state);
  return { name: `EB-ZEC ${state.being_id.slice(0, 10)}`, description: "Local EB-ZEC protocol identity; not a native Zcash asset.",
    image: `data:image/svg+xml;base64,${Buffer.from(renderSvg(state)).toString("base64")}`,
    attributes: ["power", "skill", "mass", "complexity", "stage", "devours", "fusions", "mutations", "glyph_rows", "status"]
      .map((field) => ({ trait_type: field, value: state[field] })).concat([
        { trait_type: "lineage", value: lineageName(state) }, { trait_type: "border", value: state.border },
      ]) };
}

module.exports = { rendererId, renderSvg, metadata, lineageName };
