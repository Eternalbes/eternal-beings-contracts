const fs = require("fs");
const path = require("path");

const OUT = path.join("opensea-eternal-worlds-pass");
const MEDIA = path.join(OUT, "media");
const METADATA = path.join(OUT, "metadata");

const DESCRIPTION =
  "Eternal Beings Genesis Pass is a 300-supply builder identity collection for the Eternal Beings protocol ecosystem. Eternal Beings is an ownerless, non-upgradeable, fully on-chain evolving NFT protocol built around Beings, Hunt, ORE, Devour, Fusion, lineage, scars, and autonomous evolution. Genesis Pass holders receive early-builder identity for future world deployment tools, platform campaigns, creator features, community activations, and selected protocol-linked experiences. This pass is an access and participation credential. It does not represent equity, profit share, securities, or guaranteed financial return.";

const roles = [
  {
    role: "Genesis Architect",
    tier: "Architect",
    access: "Priority World Deployment",
    color: "#ffd56a",
    accent: "#fff2b0",
    shadow: "#6b4b00",
  },
  {
    role: "World Builder",
    tier: "Builder",
    access: "World Deployment Enabled",
    color: "#38efff",
    accent: "#dbfeff",
    shadow: "#005766",
  },
  {
    role: "Eternal VIP",
    tier: "VIP",
    access: "Eligible Builder Access",
    color: "#c6ff43",
    accent: "#f2ffd0",
    shadow: "#324900",
  },
];

const roleCounts = [30, 70, 200];
const roleByTokenId = buildRoleMap();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csv(value) {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function seededRank(id) {
  let x = BigInt(id) * 0x9e3779b97f4a7c15n + 0x455445524e414c57n;
  x ^= x >> 30n;
  x *= 0xbf58476d1ce4e5b9n;
  x ^= x >> 27n;
  x *= 0x94d049bb133111ebn;
  x ^= x >> 31n;
  return x & ((1n << 64n) - 1n);
}

function buildRoleMap() {
  const ids = Array.from({ length: 300 }, (_, index) => index + 1);
  ids.sort((a, b) => {
    const ar = seededRank(a);
    const br = seededRank(b);
    return ar < br ? -1 : ar > br ? 1 : a - b;
  });
  const map = new Map();
  let offset = 0;
  for (let roleIndex = 0; roleIndex < roles.length; roleIndex++) {
    for (let i = 0; i < roleCounts[roleIndex]; i++) {
      map.set(ids[offset + i], roles[roleIndex]);
    }
    offset += roleCounts[roleIndex];
  }
  return map;
}

function roleFor(id) {
  return roleByTokenId.get(id);
}

function pad(id) {
  return String(id).padStart(3, "0");
}

function line(x1, y1, x2, y2, stroke, opacity = 1, width = 2) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function text(x, y, value, fill, size, anchor = "start", opacity = 1, weight = "400") {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" opacity="${opacity}">${esc(value)}</text>`;
}

function worldCore(cx, cy, r, color, accent) {
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="5" opacity=".72"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${Math.floor(r * 0.58)}" fill="none" stroke="${accent}" stroke-width="3" opacity=".68"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${Math.floor(r * 0.22)}" fill="${color}" fill-opacity=".12" stroke="${accent}" stroke-width="3" opacity=".9"/>`,
    `<path d="M${cx} ${cy - r}L${cx + r * 0.52} ${cy}L${cx} ${cy + r}L${cx - r * 0.52} ${cy}Z" fill="${color}" fill-opacity=".06" stroke="${accent}" stroke-width="4" opacity=".85"/>`,
    line(cx - r, cy, cx + r, cy, color, 0.36, 2),
    line(cx, cy - r, cx, cy + r, color, 0.36, 2),
    `<ellipse cx="${cx}" cy="${cy}" rx="${r * 1.2}" ry="${r * 0.28}" fill="none" stroke="${color}" stroke-width="2" opacity=".32" transform="rotate(-22 ${cx} ${cy})"/>`,
    `<ellipse cx="${cx}" cy="${cy}" rx="${r * 1.2}" ry="${r * 0.28}" fill="none" stroke="${accent}" stroke-width="2" opacity=".28" transform="rotate(38 ${cx} ${cy})"/>`,
  ].join("");
}

function sigils(id, color, accent) {
  const marks = ["ORE", "HUNT", "DEVOUR", "FUSION", "LINEAGE", "SCARS", "WORLD", "BEING"];
  let out = "";
  for (let i = 0; i < marks.length; i++) {
    const y = 278 + i * 68;
    out += text(104, y, marks[(id + i) % marks.length], i % 2 ? color : accent, 30, "start", 0.78);
    out += line(102, y + 18, 252 - (i % 3) * 22, y + 18, color, 0.24, 2);
  }
  return out;
}

function cardSvg(id) {
  const r = roleFor(id);
  const p = pad(id);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1680">`,
    `<rect width="1200" height="1680" fill="#05070a"/>`,
    `<rect x="54" y="54" width="1092" height="1572" rx="24" fill="#081016" stroke="${r.color}" stroke-width="${r.tier === "Architect" ? 12 : 8}" opacity=".96"/>`,
    `<rect x="86" y="86" width="1028" height="1508" rx="18" fill="none" stroke="${r.accent}" stroke-width="3" opacity=".42"/>`,
    `<rect x="118" y="210" width="210" height="1040" rx="14" fill="none" stroke="${r.color}" stroke-width="3" opacity=".28"/>`,
    sigils(id, r.color, r.accent),
    `<g opacity=".9">${worldCore(720, 760, 246, r.color, r.accent)}</g>`,
    line(430, 380, 1030, 380, r.color, 0.22, 2),
    line(430, 1140, 1030, 1140, r.color, 0.22, 2),
    text(600, 162, "ETERNAL BEINGS", r.accent, 56, "middle", 0.96, "700"),
    text(600, 224, "GENESIS PASS", r.color, 38, "middle", 0.92),
    text(720, 1078, r.role.toUpperCase(), r.accent, 42, "middle", 0.96, "700"),
    text(720, 1134, r.access, r.color, 28, "middle", 0.88),
    text(600, 1368, "Eternal Beings ecosystem builder identity", r.accent, 30, "middle", 0.82),
    text(600, 1422, "World deployment / platform activations / protocol access", r.color, 23, "middle", 0.74),
    text(168, 1506, `NO. ${p}/300`, r.accent, 34, "start", 0.9, "700"),
    text(1034, 1506, r.tier, r.color, 34, "end", 0.9, "700"),
    `<path d="M430 1260H1030M430 1288H930M430 1316H990" stroke="${r.color}" stroke-width="2" opacity=".26"/>`,
    `<circle cx="720" cy="760" r="338" fill="none" stroke="${r.shadow}" stroke-width="30" opacity=".16"/>`,
    `</svg>`,
  ].join("");
}

function logoSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200">`,
    `<rect width="1200" height="1200" fill="#05070a"/>`,
    `<rect x="70" y="70" width="1060" height="1060" rx="42" fill="#081016" stroke="#ffd56a" stroke-width="12"/>`,
    worldCore(600, 545, 250, "#ffd56a", "#fff2b0"),
    text(600, 920, "ETERNAL BEINGS", "#fff2b0", 64, "middle", 0.96, "700"),
    text(600, 992, "GENESIS PASS", "#38efff", 40, "middle", 0.88),
    `</svg>`,
  ].join("");
}

function bannerSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2800 900">`,
    `<rect width="2800" height="900" fill="#05070a"/>`,
    `<rect x="52" y="52" width="2696" height="796" rx="28" fill="#081016" stroke="#38efff" stroke-width="6" opacity=".85"/>`,
    `<g transform="translate(380 450)">${worldCore(0, 0, 250, "#ffd56a", "#fff2b0")}</g>`,
    `<g opacity=".4">`,
    line(720, 212, 2500, 212, "#38efff", 0.32, 3),
    line(720, 688, 2500, 688, "#c6ff43", 0.28, 3),
    line(2120, 212, 2120, 688, "#ffd56a", 0.22, 3),
    `</g>`,
    text(820, 352, "ETERNAL BEINGS", "#fff2b0", 92, "start", 0.98, "700"),
    text(820, 452, "GENESIS PASS", "#38efff", 58, "start", 0.9),
    text(820, 548, "300 builder identities for the Eternal Beings protocol ecosystem", "#c6ff43", 38, "start", 0.86),
    text(820, 632, "BEINGS / HUNT / ORE / DEVOUR / FUSION / LINEAGE / WORLDS", "#fff2b0", 30, "start", 0.72),
    `</svg>`,
  ].join("");
}

function featuredSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">`,
    `<rect width="1600" height="900" fill="#05070a"/>`,
    `<rect x="58" y="58" width="1484" height="784" rx="26" fill="#081016" stroke="#c6ff43" stroke-width="6" opacity=".9"/>`,
    worldCore(800, 390, 220, "#38efff", "#dbfeff"),
    text(800, 706, "ETERNAL BEINGS GENESIS PASS", "#fff2b0", 54, "middle", 0.96, "700"),
    text(800, 768, "Builder identity for the Eternal Beings protocol", "#c6ff43", 30, "middle", 0.86),
    `</svg>`,
  ].join("");
}

function metadata(id) {
  const r = roleFor(id);
  return {
    name: `Eternal Beings Genesis Pass #${pad(id)}`,
    description: DESCRIPTION,
    image: `ipfs://REPLACE_WITH_MEDIA_CID/${pad(id)}.svg`,
    attributes: [
      { trait_type: "Access Layer", value: "Eternal Beings" },
      { trait_type: "Protocol", value: "Eternal Beings" },
      { trait_type: "Role", value: r.role },
      { trait_type: "Tier", value: r.tier },
      { trait_type: "World Deployment", value: r.access },
      { trait_type: "Era", value: "Genesis" },
      { trait_type: "Supply Class", value: "300" },
      { trait_type: "Utility Type", value: "Builder Identity" },
    ],
  };
}

function collectionInfo() {
  return `# Eternal Beings Genesis Pass

Collection name: Eternal Beings Genesis Pass
Symbol: EBGP
Supply: 300
Chain: Robinhood
Type: ERC-721 / OpenSea Primary Drop

## Short description

300 builder identities for the Eternal Beings protocol ecosystem.

## Full description

${DESCRIPTION}

## Tiers

- 30 Genesis Architect passes
- 70 World Builder passes
- 200 Eternal VIP passes

Tier traits are distributed across the 300 token IDs and are not tied to a visible number range.

## OpenSea visual assets

- Logo: assets/logo.svg
- Banner: assets/banner-opensea.svg
- Featured image: assets/featured.svg
- NFT media: media/001.svg through media/300.svg

## Upload note

If OpenSea asks for media before metadata, upload all files in media/ first. If it asks for a CSV, use opensea-items.csv. If you upload metadata JSON to IPFS yourself, replace the placeholder image URI in metadata/*.json with your final media CID.
`;
}

function uploadGuide() {
  return `# OpenSea Upload Checklist

1. Create a new collection/drop on OpenSea Studio.
2. Choose Robinhood as the chain.
3. Use collection name: Eternal Beings Genesis Pass.
4. Upload assets/logo.svg as the collection logo.
5. Upload assets/banner-opensea.svg as the banner.
6. Upload assets/featured.svg as the featured image if OpenSea asks for one.
7. Upload media/001.svg through media/300.svg as item media.
8. Upload opensea-items.csv if OpenSea asks for item metadata by CSV.
9. Use opensea-description.txt as the collection description.
10. Set supply to 300 and keep the access language utility-based, not investment-based.

Recommended public wording:

Eternal Beings Genesis Pass is a 300-supply builder identity collection for the Eternal Beings protocol ecosystem. Holders receive early-builder identity for future world deployment tools, supported creator tools, platform campaigns, community activations, and selected protocol-linked experiences.
`;
}

function main() {
  ensureDir(MEDIA);
  ensureDir(METADATA);
  ensureDir(path.join(OUT, "assets"));

  fs.writeFileSync(path.join(OUT, "assets", "logo.svg"), `${logoSvg()}\n`);
  fs.writeFileSync(path.join(OUT, "assets", "banner-opensea.svg"), `${bannerSvg()}\n`);
  fs.writeFileSync(path.join(OUT, "assets", "featured.svg"), `${featuredSvg()}\n`);
  fs.writeFileSync(path.join(OUT, "opensea-description.txt"), `${DESCRIPTION}\n`);
  fs.writeFileSync(path.join(OUT, "collection-info.md"), collectionInfo());
  fs.writeFileSync(path.join(OUT, "UPLOAD_CHECKLIST.md"), uploadGuide());

  const rows = [
    [
      "tokenID",
      "name",
      "description",
      "file_name",
      "Access Layer",
      "Protocol",
      "Role",
      "Tier",
      "World Deployment",
      "Era",
      "Supply Class",
      "Utility Type",
    ],
  ];

  for (let id = 1; id <= 300; id++) {
    const r = roleFor(id);
    const p = pad(id);
    fs.writeFileSync(path.join(MEDIA, `${p}.svg`), `${cardSvg(id)}\n`);
    fs.writeFileSync(path.join(METADATA, `${id}.json`), `${JSON.stringify(metadata(id), null, 2)}\n`);
    rows.push([
      id,
      `Eternal Beings Genesis Pass #${p}`,
      DESCRIPTION,
      `${p}.svg`,
      "Eternal Beings",
      "Eternal Beings",
      r.role,
      r.tier,
      r.access,
      "Genesis",
      "300",
      "Builder Identity",
    ]);
  }

  fs.writeFileSync(path.join(OUT, "opensea-items.csv"), `${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`);
  console.log(`Generated ${OUT}`);
}

main();
