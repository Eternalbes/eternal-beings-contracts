const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const ganache = require("ganache");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const artifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
const collections = JSON.parse(fs.readFileSync("data/top-collections.ethereum.curated.json", "utf8"));

let rendererPromise;

const TIER_LABELS = {
  0: "普通 NFT",
  1: "Rank 71-100 / 入门蓝筹",
  2: "Rank 51-70 / 低蓝筹",
  3: "Rank 31-50 / 中蓝筹",
  4: "Rank 11-30 / 高蓝筹",
  5: "Rank 1-10 / 顶级蓝筹",
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function renderer() {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
      const provider = new ethers.BrowserProvider(eip1193);
      const signer = await provider.getSigner(0);
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
      const deployed = await factory.deploy();
      await deployed.waitForDeployment();
      return deployed;
    })();
  }
  return rendererPromise;
}

function decodeDataUri(uri, mimeType) {
  const prefix = `data:${mimeType};base64,`;
  if (!uri.startsWith(prefix)) throw new Error(`unexpected ${mimeType} data URI`);
  return Buffer.from(uri.slice(prefix.length), "base64").toString("utf8");
}

function stageOf(complexity) {
  let x = BigInt(complexity);
  let stage = 0;
  while (x > 1n) {
    x = x / 2n;
    stage += 1;
  }
  return stage;
}

function nutritionForTier(tier) {
  if (tier === 0) return { nutrition: 1n, complexityGain: 1n };
  if (tier === 1) return { nutrition: 3n, complexityGain: 3n };
  if (tier === 2) return { nutrition: 6n, complexityGain: 12n };
  if (tier === 3) return { nutrition: 10n, complexityGain: 25n };
  if (tier === 4) return { nutrition: 25n, complexityGain: 60n };
  return { nutrition: 100n, complexityGain: 200n };
}

function markLuckForTier(tier) {
  if (tier === 0) return 0n;
  if (tier === 1) return 50n;
  if (tier === 2) return 100n;
  if (tier === 3) return 500n;
  if (tier === 4) return 10000n;
  return 100000n;
}

const MARK_LUCK_MASK = 0x00ffffffffffffffn;

function mergeMarks(aValue, bValue) {
  const a = BigInt(aValue || "0");
  const b = BigInt(bValue || "0");
  const luck = (a & MARK_LUCK_MASK) + (b & MARK_LUCK_MASK);
  const glyph = ((a >> 56n) & 15n) >= ((b >> 56n) & 15n) ? ((a >> 56n) & 15n) : ((b >> 56n) & 15n);
  const border = (a >> 60n) >= (b >> 60n) ? (a >> 60n) : (b >> 60n);
  return ((luck & MARK_LUCK_MASK) | (glyph << 56n) | (border << 60n)).toString();
}

function upgradeMarks(state, gene, tier, fusion) {
  const packed = BigInt(state.markLuck || "0");
  const luck = (packed & MARK_LUCK_MASK) + (fusion ? 50n : markLuckForTier(tier));
  let glyph = (packed >> 56n) & 15n;
  let border = packed >> 60n;
  const devours = BigInt(state.devours);
  const baseChance = 27n + devours * 10n + luck;
  let roll = BigInt(hashPacked(
    ["bytes32", "uint64", "uint8", "bool"],
    [gene, packed, tier, fusion],
  )) % 100000n;
  if (roll < baseChance) {
    const nextGlyph = glyph === 0n ? 1n : roll < baseChance / 16n ? 4n : roll < baseChance / 4n ? 3n : roll < baseChance / 2n ? 2n : 1n;
    if (nextGlyph > glyph) glyph = nextGlyph;
  }

  const borderChance = 18n + devours / 53n + luck;
  roll = (roll + (BigInt(gene) >> 128n)) % 100000n;
  if (roll < borderChance) {
    const nextBorder = roll < borderChance / 16n ? 4n : roll < borderChance / 4n ? 3n : roll < borderChance / 2n ? 2n : 1n;
    if (nextBorder > border) border = nextBorder;
  }

  state.markLuck = ((luck & MARK_LUCK_MASK) | (glyph << 56n) | (border << 60n)).toString();
}

function bit(n) {
  return 1 << Number(n % 6n);
}

function lineageGain(gene, tier, mutation) {
  const g = BigInt(gene);
  if (mutation) return bit(g >> 80n);
  if (tier === 0) return 0;
  const threshold = BigInt(tier) * 9n;
  if (g % 100n >= threshold) return 0;
  return bit(g >> 88n);
}

function toHex32(value) {
  return ethers.toBeHex(BigInt(value), 32);
}

function hashPacked(types, values) {
  return ethers.keccak256(ethers.solidityPacked(types, values));
}

function randomGenome(seedText) {
  return ethers.keccak256(ethers.toUtf8Bytes(seedText));
}

function initialBeing(tokenId, genome) {
  const g = BigInt(genome);
  const complexity = 1n + (g % 9n);
  return {
    tokenId: String(tokenId),
    mass: "1",
    complexity: complexity.toString(),
    devours: "0",
    fusions: "0",
    premiumDevours: "0",
    markLuck: "0",
    power: String(1n + ((g >> 8n) % 10n)),
    skill: String(1n + ((g >> 16n) % 10n)),
    scars: "0",
    stage: String(stageOf(complexity)),
    lineageMask: String(1 << Number((g >> 48n) % 6n)),
    mutationBias: String((g >> 40n) % 10n),
    genome,
  };
}

function maybeMutation(state, gene, tier, fusion) {
  const roll = BigInt(hashPacked(["bytes32", "bytes32", "uint256"], [gene, state.genome, state.tokenId])) % 1_000_000n;
  const minor = fusion ? 200_000n : tier === 0 ? 1_000n : BigInt(tier) * 50_000n;
  const major = fusion ? 30_000n : tier === 0 ? 100n : BigInt(tier) * 10_000n;
  const mythic = fusion ? 1_000n : tier === 0 ? 1n : BigInt(tier) * 100n;
  let kind = 0;

  if (roll < mythic) {
    state.skill = String(BigInt(state.skill) + 3n);
    state.power = String(BigInt(state.power) + 3n);
    state.mutationBias = String((BigInt(gene) >> 8n) % 10n);
    state.lineageMask = String(Number(state.lineageMask) | lineageGain(gene, tier, true));
    state.genome = hashPacked(["bytes32", "string", "bytes32"], [state.genome, "MYTHIC", gene]);
    kind = 3;
  } else if (roll < mythic + major) {
    state.skill = String(BigInt(state.skill) + 1n);
    state.power = String(BigInt(state.power) + 2n);
    state.lineageMask = String(Number(state.lineageMask) | lineageGain(gene, tier, true));
    state.genome = hashPacked(["bytes32", "string", "bytes32"], [state.genome, "MAJOR", gene]);
    kind = 2;
  } else if (roll < mythic + major + minor) {
    state.skill = String(BigInt(state.skill) + 1n);
    if (fusion) state.lineageMask = String(Number(state.lineageMask) | lineageGain(gene, tier, true));
    state.genome = hashPacked(["bytes32", "string", "bytes32"], [state.genome, "MINOR", gene]);
    kind = 1;
  }
  return kind;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function devourExternal(state, index, tier, collectionAddress) {
  const { nutrition, complexityGain } = nutritionForTier(tier);
  const nft = collectionAddress ? collectionAddress.toLowerCase() : ethers.getAddress(`0x${toHex32(BigInt(index) + 1n).slice(-40)}`);
  const externalTokenId = BigInt(index + 1);
  const gene = hashPacked(
    ["bytes32", "address", "uint256", "bytes32", "uint64", "uint8"],
    [state.genome, nft, externalTokenId, hashPacked(["address"], [nft]), BigInt(state.devours), tier],
  );

  state.devours = String(BigInt(state.devours) + 1n);
  if (tier > 0) state.premiumDevours = String(BigInt(state.premiumDevours || "0") + 1n);
  upgradeMarks(state, gene, tier, false);
  state.mass = String(BigInt(state.mass) + nutrition);
  state.complexity = String(BigInt(state.complexity) + complexityGain);
  if (tier > 0) {
    state.power = String(BigInt(state.power) + BigInt(tier));
    state.skill = String(BigInt(state.skill) + BigInt(Math.floor(tier / 2)));
  }
  state.genome = hashPacked(["bytes32", "bytes32", "uint128", "uint128"], [state.genome, gene, BigInt(state.mass), BigInt(state.complexity)]);
  state.lineageMask = String(Number(state.lineageMask) | lineageGain(gene, tier, false));
  state.stage = String(stageOf(BigInt(state.complexity)));
  return maybeMutation(state, gene, tier, false);
}

function fuseBeing(parent, sacrifice) {
  const gene = hashPacked(
    ["bytes32", "bytes32", "uint256", "uint256", "uint64", "uint64"],
    [parent.genome, sacrifice.genome, BigInt(parent.tokenId), BigInt(sacrifice.tokenId), BigInt(parent.fusions), BigInt(sacrifice.fusions)],
  );
  parent.mass = String(BigInt(parent.mass) + BigInt(sacrifice.mass));
  parent.complexity = String(BigInt(parent.complexity) + (BigInt(sacrifice.complexity) * 70n) / 100n + 1n);
  parent.devours = String(BigInt(parent.devours) + BigInt(sacrifice.devours) + 1n);
  parent.fusions = String(BigInt(parent.fusions) + BigInt(sacrifice.fusions) + 1n);
  parent.premiumDevours = String(BigInt(parent.premiumDevours || "0") + BigInt(sacrifice.premiumDevours || "0"));
  parent.markLuck = mergeMarks(parent.markLuck, sacrifice.markLuck);
  upgradeMarks(parent, gene, 5, true);
  parent.power = String(BigInt(parent.power) + 1n + BigInt(sacrifice.power) / 2n);
  parent.skill = String(BigInt(parent.skill) + 1n + BigInt(sacrifice.skill) / 2n);
  parent.lineageMask = String(Number(parent.lineageMask) | Number(sacrifice.lineageMask));
  parent.genome = hashPacked(["bytes32", "bytes32", "bytes32"], [parent.genome, sacrifice.genome, gene]);
  parent.stage = String(stageOf(BigInt(parent.complexity)));
  return maybeMutation(parent, gene, 5, true);
}

async function renderState(state) {
  const r = await renderer();
  const tokenUri = await r.tokenURI(
    BigInt(state.tokenId),
    BigInt(state.mass),
    BigInt(state.complexity),
    BigInt(state.devours),
    BigInt(state.fusions),
    BigInt(state.premiumDevours || "0"),
    BigInt(state.markLuck || "0"),
    Number(state.power),
    Number(state.skill),
    Number(state.scars),
    Number(state.stage),
    Number(state.lineageMask),
    state.genome,
  );
  const metadata = JSON.parse(decodeDataUri(tokenUri, "application/json"));
  const svg = decodeDataUri(metadata.image, "image/svg+xml");
  return {
    state,
    metadata,
    svg,
    image: metadata.image,
    svgBytes: Buffer.byteLength(svg, "utf8"),
    tokenURIBytes: Buffer.byteLength(tokenUri, "utf8"),
  };
}

function rankCollectionFor(tier, index) {
  const list = collections.filter((item) => Number(item.tier) === Number(tier));
  if (list.length === 0) return null;
  return list[index % list.length];
}

async function simulate(base, options) {
  const ordinaryCount = Math.max(0, Math.min(10000, Number(options.ordinaryCount || 0)));
  const fusionCount = Math.max(0, Math.min(10000, Number(options.fusionCount || 0)));
  const tier = Math.max(0, Math.min(5, Number(options.tier || 0)));
  const tierCount = Math.max(0, Math.min(10000, Number(options.tierCount || 0)));
  const selected = cloneState(base);
  const result = {
    initial: await renderState(cloneState(base)),
    ordinary: null,
    fusion: null,
    tiered: null,
  };

  let ordinary = cloneState(selected);
  for (let i = 0; i < ordinaryCount; i++) devourExternal(ordinary, i, 0);
  result.ordinary = await renderState(ordinary);

  let fused = cloneState(selected);
  for (let i = 0; i < fusionCount; i++) {
    const sacrifice = initialBeing(10_000 + i, randomGenome(`fusion:${selected.genome}:${i}`));
    fuseBeing(fused, sacrifice);
  }
  result.fusion = await renderState(fused);

  let tiered = cloneState(selected);
  const absorbedCollections = [];
  for (let i = 0; i < tierCount; i++) {
    const collection = rankCollectionFor(tier, i);
    absorbedCollections.push(collection ? `${collection.rank}. ${collection.name}` : TIER_LABELS[tier]);
    devourExternal(tiered, i, tier, collection?.address);
  }
  result.tiered = await renderState(tiered);
  result.tiered.absorbedCollections = absorbedCollections.slice(0, 8);
  result.options = { ordinaryCount, fusionCount, tier, tierCount, tierLabel: TIER_LABELS[tier] };
  return result;
}

function makeInitialCards(count, seed) {
  const safeCount = Math.max(1, Math.min(80, Number(count || 10)));
  const salt = seed || `${Date.now()}`;
  return Array.from({ length: safeCount }, (_, i) => initialBeing(i + 1, randomGenome(`mint:${salt}:${i + 1}`)));
}

function page() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Eternal Beings Local Simulator</title>
<style>
:root{color-scheme:dark;--bg:#090b0e;--panel:#12161b;--line:#27313a;--text:#e9f1f5;--muted:#8fa1ad;--cyan:#48d9e9;--gold:#e9c46a;--green:#8bd17c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:2;background:#0b0f13;border-bottom:1px solid var(--line);padding:14px 18px;display:flex;gap:16px;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0;font-weight:700;letter-spacing:0}.sub{color:var(--muted);font-size:12px}.wrap{display:grid;grid-template-columns:360px 1fr;min-height:calc(100vh - 61px)}
aside{border-right:1px solid var(--line);padding:16px;overflow:auto}.main{padding:16px;overflow:auto}
.controls,.selected,.preview{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:14px}.row{display:grid;grid-template-columns:1fr 96px;gap:10px;align-items:center;margin:10px 0}
label{color:var(--muted);font-size:12px}.row input,.row select{width:100%;background:#090d11;color:var(--text);border:1px solid #34424d;border-radius:6px;padding:8px}
button{background:#13232a;color:var(--text);border:1px solid #31515a;border-radius:7px;padding:9px 12px;cursor:pointer}button:hover{border-color:var(--cyan)}.primary{background:#123039;border-color:#2e7884}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{background:#0c1014;border:1px solid var(--line);border-radius:8px;padding:8px;cursor:pointer}.card.active{border-color:var(--cyan);box-shadow:0 0 0 1px var(--cyan) inset}
.card img{width:100%;display:block;background:#050607;border-radius:6px}.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}.grid{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:14px}
.preview img{width:100%;background:#050607;border-radius:6px;border:1px solid #1d252b}.preview h2{font-size:14px;margin:0 0 10px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}.stat{border:1px solid #27313a;border-radius:6px;padding:6px}.stat b{display:block;font-size:15px}.stat span{color:var(--muted);font-size:11px}
.hint{color:var(--muted);font-size:12px}.list{color:var(--muted);font-size:12px;margin-top:8px;max-height:90px;overflow:auto}.pill{display:inline-block;border:1px solid #34424d;border-radius:999px;padding:2px 7px;color:var(--muted);margin:2px}
@media(max-width:980px){.wrap{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(3,1fr)}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header><div><h1>Eternal Beings Local Simulator</h1><div class="sub">本地模拟状态增长，图像由真实 Solidity EternalRenderer 渲染</div></div><button id="refresh">重新随机 MINT</button></header>
<div class="wrap">
<aside>
  <div class="controls">
    <div class="row"><label>随机 MINT 张数</label><input id="mintCount" type="number" min="1" max="80" value="10"></div>
    <button class="primary" id="generate">生成初始卡</button>
  </div>
  <div class="selected">
    <div class="hint" id="selectedText">请选择一张初始卡</div>
    <div class="row"><label>普通 NFT 吞噬数量</label><input id="ordinaryCount" type="number" min="0" max="10000" value="10"></div>
    <div class="row"><label>同集合卡融合数量</label><input id="fusionCount" type="number" min="0" max="10000" value="3"></div>
    <div class="row"><label>100 系列阶段</label><select id="tier"><option value="5">Rank 1-10 顶级蓝筹</option><option value="4">Rank 11-30 高蓝筹</option><option value="3">Rank 31-50 中蓝筹</option><option value="2">Rank 51-70 低蓝筹</option><option value="1">Rank 71-100 入门蓝筹</option><option value="0">普通 NFT</option></select></div>
    <div class="row"><label>该阶段吞噬数量</label><input id="tierCount" type="number" min="0" max="10000" value="2"></div>
    <button class="primary" id="simulate">根据当前卡生成效果</button>
  </div>
  <div id="cards" class="cards"></div>
</aside>
<main class="main">
  <div id="status" class="hint">正在初始化 renderer...</div>
  <div id="previews" class="grid"></div>
</main>
</div>
<script>
let cards = [];
let selected = null;
async function post(url, data){ const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
function attrMap(meta){ const m={}; for(const a of meta.attributes||[]) m[a.trait_type]=a.value; return m; }
function stats(meta){ const m=attrMap(meta); return ['Power','Skill','Mass','Complexity','Devours','Fusions'].map(k=>'<div class="stat"><b>'+ (m[k] ?? '-') +'</b><span>'+k+'</span></div>').join(''); }
function cardLabel(state){ return '#'+state.tokenId+' C'+state.complexity+' P'+state.power+' S'+state.skill; }
async function renderCard(state){
  const r = await post('/api/render',{state});
  return '<div class="card '+(selected&&selected.tokenId===state.tokenId?'active':'')+'" data-id="'+state.tokenId+'"><img src="'+r.image+'"><div class="meta"><span>#'+state.tokenId+'</span><span>C'+state.complexity+' P'+state.power+'</span></div></div>';
}
async function drawCards(){
  const html = [];
  for(const c of cards) html.push(await renderCard(c));
  document.getElementById('cards').innerHTML = html.join('');
  document.querySelectorAll('.card').forEach(el=>el.onclick=()=>{ selected = cards.find(c=>String(c.tokenId)===el.dataset.id); document.getElementById('selectedText').textContent='当前选择 '+cardLabel(selected); drawCards(); simulate(); });
}
function preview(title, result, extra){
  return '<section class="preview"><h2>'+title+'</h2><img src="'+result.image+'"><div class="stats">'+stats(result.metadata)+'</div><div class="hint">SVG '+result.svgBytes+' bytes · tokenURI '+result.tokenURIBytes+' bytes</div>'+(extra||'')+'</section>';
}
async function generate(){
  document.getElementById('status').textContent = '生成初始卡中...';
  cards = (await post('/api/mint',{count:document.getElementById('mintCount').value})).cards;
  selected = cards[0];
  document.getElementById('selectedText').textContent='当前选择 '+cardLabel(selected);
  await drawCards();
  await simulate();
}
async function simulate(){
  if(!selected) return;
  document.getElementById('status').textContent = '渲染模拟结果中...';
  const data = await post('/api/simulate',{base:selected, ordinaryCount:ordinaryCount.value, fusionCount:fusionCount.value, tier:tier.value, tierCount:tierCount.value});
  const absorbed = data.tiered.absorbedCollections?.length ? '<div class="list">'+data.tiered.absorbedCollections.map(x=>'<span class="pill">'+x+'</span>').join('')+'</div>' : '';
  document.getElementById('previews').innerHTML = [
    preview('初始 MINT', data.initial),
    preview('普通 NFT x '+data.options.ordinaryCount, data.ordinary),
    preview('同集合融合 x '+data.options.fusionCount, data.fusion),
    preview(data.options.tierLabel+' x '+data.options.tierCount, data.tiered, absorbed)
  ].join('');
  document.getElementById('status').textContent = '完成。所有图像都来自本地 Solidity renderer。';
}
generate.onclick = generate; refresh.onclick = generate; simulate.onclick = simulate;
['ordinaryCount','fusionCount','tier','tierCount'].forEach(id=>document.getElementById(id).addEventListener('change', simulate));
generate().catch(e=>{ document.getElementById('status').textContent=e.message; console.error(e); });
</script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "POST" && url.pathname === "/api/mint") {
      const body = await parseBody(req);
      return json(res, 200, { cards: makeInitialCards(body.count, body.seed) });
    }
    if (req.method === "POST" && url.pathname === "/api/render") {
      const body = await parseBody(req);
      return json(res, 200, await renderState(body.state));
    }
    if (req.method === "POST" && url.pathname === "/api/simulate") {
      const body = await parseBody(req);
      return json(res, 200, await simulate(body.base, body));
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error.message, stack: error.stack });
  }
}

renderer().then(() => {
  http.createServer(handle).listen(PORT, "127.0.0.1", () => {
    console.log(`Eternal Beings simulator running at http://127.0.0.1:${PORT}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
