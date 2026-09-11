import * as THREE from "three";
import { ethers } from "ethers";

const CONFIG = {
  rpc: "https://ethereum-rpc.publicnode.com",
  chainId: 1,
  contract: "0xC6D9Ea961C1E1E5F99D36970FcC824b8faA144f3",
  explorer: "https://etherscan.io"
};

const ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function getBeing(uint256) view returns (tuple(uint128 mass,uint128 complexity,uint64 devours,uint64 fusions,uint64 premiumDevours,uint64 markLuck,uint64 huntNonce,uint32 power,uint32 skill,uint32 scars,uint16 stage,uint8 originClass,uint8 originSymbol,uint8 mutationBias,uint8 lineageMask,bytes32 genome))",
  "function tokenURI(uint256) view returns (string)"
];

const LINEAGES = ["Mechanical", "Idol", "Citadel", "Crystal", "Star", "Rune"];
const SCENES = {
  ruins: { name: "THE NULL GARDEN", description: "A quiet proving ground built from dormant chain fragments.", fog: 0x071011, ground: 0x07100f, accent: 0x55e2d4, sky: 0x020506 },
  abyss: { name: "THE RED ABYSS", description: "A fractured lower world where survival is measured in blocks.", fog: 0x170607, ground: 0x100506, accent: 0xed6f76, sky: 0x050203 },
  astral: { name: "THE ASTRAL VAULT", description: "A cold archive of orbiting genomes and unfinished worlds.", fog: 0x08091a, ground: 0x080a12, accent: 0xa995ff, sky: 0x02030a }
};

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const short = (value, head = 6, tail = 4) => value ? `${value.slice(0, head)}...${value.slice(-tail)}` : "...";
const displayNumber = (value) => Number(value).toLocaleString("en-US");

let renderer;
let scene;
let camera;
let clock;
let avatar;
let avatarCore;
let aura;
let portal;
let floor;
let grid;
let dust;
let currentBeing;
let chainBeing;
let currentTokenId = 88;
let currentScene = "ruins";
let cameraYaw = 0;
let cameraPitch = 0.28;
let dragging = false;
let pointerX = 0;
let pointerY = 0;
let toastTimer;
let pulse = 0;
let simulatedOre = 0;
let lastAttackAt = 0;
const targets = [];
const keys = new Set();
const provider = new ethers.JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
const contract = new ethers.Contract(CONFIG.contract, ABI, provider);

function seedFromGenome(genome) {
  const clean = String(genome || "0x01").replace(/^0x/, "").padEnd(64, "0");
  let state = Number.parseInt(clean.slice(0, 8), 16) ^ Number.parseInt(clean.slice(16, 24), 16);
  state >>>= 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function normalizeBeing(raw) {
  return {
    mass: BigInt(raw.mass).toString(),
    complexity: BigInt(raw.complexity).toString(),
    devours: BigInt(raw.devours).toString(),
    fusions: BigInt(raw.fusions).toString(),
    premiumDevours: BigInt(raw.premiumDevours).toString(),
    markLuck: BigInt(raw.markLuck).toString(),
    huntNonce: BigInt(raw.huntNonce).toString(),
    power: Number(raw.power),
    skill: Number(raw.skill),
    scars: Number(raw.scars),
    stage: Number(raw.stage),
    originClass: Number(raw.originClass),
    originSymbol: Number(raw.originSymbol),
    mutationBias: Number(raw.mutationBias),
    lineageMask: Number(raw.lineageMask),
    genome: raw.genome
  };
}

function fallbackBeing(tokenId) {
  const genome = ethers.keccak256(ethers.toUtf8Bytes(`eternal-being-demo:${tokenId}`));
  const number = BigInt(genome);
  return {
    mass: "1", complexity: "4", devours: "0", fusions: "0", premiumDevours: "0", markLuck: "0", huntNonce: "0",
    power: Number(1n + number % 8n), skill: Number(1n + (number >> 8n) % 7n), scars: 0, stage: 0,
    originClass: Number((number >> 16n) % 6n), originSymbol: Number((number >> 24n) % 36n),
    mutationBias: Number((number >> 32n) % 8n), lineageMask: Number(1n << ((number >> 48n) % 6n)), genome
  };
}

function lineageNames(mask) {
  return LINEAGES.filter((_, index) => mask & (1 << index));
}

function dominantLineage(being) {
  const active = lineageNames(being.lineageMask);
  if (!active.length) return 0;
  const random = seedFromGenome(`${being.genome.slice(0, 50)}${being.lineageMask.toString(16).padStart(2, "0")}`);
  return LINEAGES.indexOf(active[Math.floor(random() * active.length)]);
}

function decodeTokenURI(uri) {
  if (!uri?.startsWith("data:application/json")) return null;
  const comma = uri.indexOf(",");
  const header = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    return JSON.parse(header.includes(";base64") ? atob(payload) : decodeURIComponent(payload));
  } catch {
    return null;
  }
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
    else object.material?.dispose?.();
  });
  group.removeFromParent();
}

function materialPair(being, random) {
  const hue = (Number.parseInt(being.genome.slice(2, 6), 16) / 65535 + random() * .12) % 1;
  const primary = new THREE.Color().setHSL(hue, .58, .48);
  const secondary = new THREE.Color().setHSL((hue + .12 + random() * .24) % 1, .48, .72);
  const dark = new THREE.Color().setHSL(hue, .22, .1);
  return {
    primary: new THREE.MeshStandardMaterial({ color: dark, metalness: .72, roughness: .28, emissive: primary, emissiveIntensity: .16 }),
    edge: new THREE.MeshStandardMaterial({ color: secondary, metalness: .45, roughness: .18, emissive: primary, emissiveIntensity: .65 }),
    glow: new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false }),
    primaryColor: primary,
    secondaryColor: secondary
  };
}

function mesh(geometry, material, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  object.rotation.set(...rotation);
  object.scale.set(...scale);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

function addMechanical(group, mats, random, level) {
  group.add(mesh(new THREE.BoxGeometry(1.05, 1.45, .72, 2, 3, 2), mats.primary, [0, 1.75, 0]));
  group.add(mesh(new THREE.BoxGeometry(.68, .58, .62), mats.edge, [0, 2.72, 0]));
  const gearCount = 2 + level;
  for (let i = 0; i < gearCount; i += 1) {
    const side = i % 2 ? 1 : -1;
    group.add(mesh(new THREE.TorusGeometry(.24 + random() * .1, .055, 6, 12), mats.edge, [side * (.72 + random() * .18), 1.5 + i * .28, .02], [0, Math.PI / 2, 0]));
  }
}

function addIdol(group, mats, random, level) {
  group.add(mesh(new THREE.CapsuleGeometry(.5, 1.25, 5, 9), mats.primary, [0, 1.75, 0]));
  group.add(mesh(new THREE.SphereGeometry(.38, 12, 8), mats.edge, [0, 2.8, 0], [0, 0, 0], [1, 1.18, .84]));
  for (let i = 0; i < 1 + level; i += 1) {
    group.add(mesh(new THREE.TorusGeometry(.58 + i * .16, .025, 6, 40), mats.glow, [0, 2.88, 0], [Math.PI / 2 + i * .22, 0, 0]));
  }
}

function addCitadel(group, mats, random, level) {
  group.add(mesh(new THREE.CylinderGeometry(.48, .7, 1.65, 6), mats.primary, [0, 1.65, 0]));
  group.add(mesh(new THREE.CylinderGeometry(.62, .5, .38, 6), mats.edge, [0, 2.66, 0]));
  const towers = 3 + level;
  for (let i = 0; i < towers; i += 1) {
    const angle = i / towers * Math.PI * 2;
    const radius = .6 + level * .08;
    group.add(mesh(new THREE.CylinderGeometry(.1, .14, .75 + random() * .5, 5), mats.edge, [Math.cos(angle) * radius, 2.25, Math.sin(angle) * radius]));
  }
}

function addCrystal(group, mats, random, level) {
  group.add(mesh(new THREE.OctahedronGeometry(.78, 0), mats.primary, [0, 1.8, 0], [0, 0, Math.PI / 4], [1, 1.5, .78]));
  group.add(mesh(new THREE.IcosahedronGeometry(.36, 0), mats.edge, [0, 2.82, 0]));
  const shards = 4 + level * 2;
  for (let i = 0; i < shards; i += 1) {
    const angle = i / shards * Math.PI * 2;
    group.add(mesh(new THREE.ConeGeometry(.1 + random() * .08, .7 + random() * .55, 5), mats.edge, [Math.cos(angle) * .7, 1.7 + random() * .8, Math.sin(angle) * .7], [Math.sin(angle) * .5, 0, -Math.cos(angle) * .55]));
  }
}

function addStar(group, mats, random, level) {
  group.add(mesh(new THREE.SphereGeometry(.5, 12, 8), mats.primary, [0, 1.85, 0]));
  group.add(mesh(new THREE.SphereGeometry(.28, 12, 8), mats.edge, [0, 2.75, 0]));
  const rings = 2 + level;
  for (let i = 0; i < rings; i += 1) {
    const ring = mesh(new THREE.TorusGeometry(.7 + i * .2, .025, 5, 48), i % 2 ? mats.edge : mats.glow, [0, 1.9 + i * .18, 0], [Math.PI / 2 + random() * .7, random() * .8, 0]);
    ring.userData.spin = (i % 2 ? -1 : 1) * (.18 + random() * .3);
    group.add(ring);
  }
}

function addRune(group, mats, random, level) {
  group.add(mesh(new THREE.CylinderGeometry(.42, .58, 1.65, 8), mats.primary, [0, 1.7, 0]));
  group.add(mesh(new THREE.DodecahedronGeometry(.35, 0), mats.edge, [0, 2.75, 0]));
  const runes = 4 + level * 2;
  for (let i = 0; i < runes; i += 1) {
    const angle = i / runes * Math.PI * 2;
    const rune = mesh(new THREE.TorusKnotGeometry(.1, .025, 24, 4, 2, 3), mats.glow, [Math.cos(angle) * (1 + level * .1), 1.4 + (i % 3) * .55, Math.sin(angle) * (1 + level * .1)], [random() * Math.PI, random() * Math.PI, 0]);
    rune.userData.float = i;
    group.add(rune);
  }
}

function addLimbs(group, mats, random, level) {
  const joints = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * .63, 2.18, 0);
    arm.add(mesh(new THREE.CylinderGeometry(.11, .14, .85, 7), mats.primary, [0, -.38, 0], [0, 0, side * (.12 + random() * .18)]));
    arm.add(mesh(new THREE.SphereGeometry(.15, 8, 6), mats.edge, [0, -.85, 0]));
    arm.userData.limb = "arm";
    arm.userData.side = side;
    group.add(arm);
    joints.push(arm);
    const leg = new THREE.Group();
    leg.position.set(side * .27, 1.02, 0);
    leg.add(mesh(new THREE.CylinderGeometry(.14, .18, 1, 7), mats.primary, [0, -.42, 0]));
    leg.add(mesh(new THREE.BoxGeometry(.32, .16, .55), mats.edge, [0, -.96, .12]));
    leg.userData.limb = "leg";
    leg.userData.side = side;
    group.add(leg);
    joints.push(leg);
  }
  if (level >= 2) {
    for (const side of [-1, 1]) {
      const wing = mesh(new THREE.ConeGeometry(.48 + level * .12, 1.5 + level * .25, 3), mats.edge, [side * .72, 2.08, -.3], [Math.PI / 2, side * .22, side * .45], [1, 1, .16]);
      wing.userData.wing = side;
      group.add(wing);
    }
  }
  return joints;
}

function addHybridTraits(group, being, primary, mats, random, level) {
  const active = lineageNames(being.lineageMask).map((name) => LINEAGES.indexOf(name)).filter((index) => index !== primary);
  active.slice(0, 3).forEach((kind, index) => {
    const trait = new THREE.Group();
    if (kind === 0) trait.add(mesh(new THREE.BoxGeometry(.3, .3, .3), mats.edge, [0, 0, 0]));
    if (kind === 1) trait.add(mesh(new THREE.TorusGeometry(.34, .03, 5, 24), mats.glow, [0, 0, 0], [Math.PI / 2, 0, 0]));
    if (kind === 2) trait.add(mesh(new THREE.CylinderGeometry(.12, .18, .7, 5), mats.edge, [0, 0, 0]));
    if (kind === 3) trait.add(mesh(new THREE.OctahedronGeometry(.28), mats.edge, [0, 0, 0]));
    if (kind === 4) trait.add(mesh(new THREE.TorusKnotGeometry(.2, .025, 32, 5), mats.glow, [0, 0, 0]));
    if (kind === 5) trait.add(mesh(new THREE.DodecahedronGeometry(.22), mats.glow, [0, 0, 0]));
    const angle = (index / Math.max(1, active.length)) * Math.PI * 2 + random();
    trait.position.set(Math.cos(angle) * (1 + level * .16), 2 + index * .42, Math.sin(angle) * (1 + level * .16));
    trait.userData.orbit = .2 + index * .1;
    trait.userData.angle = angle;
    group.add(trait);
  });
}

function buildAvatar(being) {
  disposeGroup(avatar);
  const random = seedFromGenome(being.genome);
  const group = new THREE.Group();
  const core = new THREE.Group();
  const mats = materialPair(being, random);
  const mutationLevel = clamp(Math.floor((being.stage + being.scars + Number(being.premiumDevours) / 4 + being.fusions / 6)), 0, 4);
  const primary = dominantLineage(being);
  const builders = [addMechanical, addIdol, addCitadel, addCrystal, addStar, addRune];
  builders[primary](core, mats, random, mutationLevel);
  core.userData.limbs = addLimbs(core, mats, random, mutationLevel);
  addHybridTraits(core, being, primary, mats, random, mutationLevel);
  const scale = .75 + clamp(Math.log2(Number(being.mass) + 1) * .04, 0, .55);
  core.scale.setScalar(scale);
  group.add(core);

  const light = new THREE.PointLight(mats.primaryColor, 4, 7, 2);
  light.position.set(0, 2, 0);
  group.add(light);
  const ring = mesh(new THREE.RingGeometry(.85, .91, 48), mats.glow, [0, .035, 0], [-Math.PI / 2, 0, 0]);
  ring.userData.aura = true;
  group.add(ring);
  group.position.set(0, 0, 3.8);
  scene.add(group);
  avatar = group;
  avatarCore = core;
  aura = ring;
}

function makeWorld() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENES.ruins.sky);
  scene.fog = new THREE.FogExp2(SCENES.ruins.fog, .035);
  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, .1, 180);
  camera.position.set(0, 4.5, 10);
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $("world").appendChild(renderer.domElement);
  clock = new THREE.Clock();

  scene.add(new THREE.HemisphereLight(0x7ceadd, 0x07090a, 1.2));
  const moon = new THREE.DirectionalLight(0xd8fff9, 2.7);
  moon.position.set(-5, 12, 7);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  scene.add(moon);

  floor = mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: SCENES.ruins.ground, roughness: .88, metalness: .2 }), [0, -.04, 0], [-Math.PI / 2, 0, 0]);
  scene.add(floor);
  grid = new THREE.GridHelper(100, 100, SCENES.ruins.accent, 0x153330);
  grid.material.transparent = true;
  grid.material.opacity = .32;
  scene.add(grid);

  const ruinMat = new THREE.MeshStandardMaterial({ color: 0x101a1a, metalness: .55, roughness: .58, emissive: 0x0a2421, emissiveIntensity: .16 });
  const random = seedFromGenome("0x74a5c2e911bb47dd5a338f26abec8312099bf62ce81290caf1058ac371b7e05a");
  for (let i = 0; i < 34; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 9 + random() * 37;
    const height = 1.5 + random() * 8;
    const geometry = i % 3 === 0 ? new THREE.CylinderGeometry(.25 + random() * .9, .6 + random(), height, 5 + Math.floor(random() * 4)) : new THREE.BoxGeometry(.7 + random() * 2, height, .7 + random() * 2);
    const ruin = mesh(geometry, ruinMat, [Math.cos(angle) * radius, height / 2 - .03, Math.sin(angle) * radius], [0, random() * Math.PI, (random() - .5) * .13]);
    scene.add(ruin);
  }

  const portalMaterial = new THREE.MeshBasicMaterial({ color: SCENES.ruins.accent, transparent: true, opacity: .7, blending: THREE.AdditiveBlending });
  portal = new THREE.Group();
  portal.add(mesh(new THREE.TorusGeometry(2.2, .055, 8, 80), portalMaterial, [0, 2.3, -10]));
  portal.add(mesh(new THREE.TorusGeometry(1.65, .025, 6, 64), portalMaterial, [0, 2.3, -10]));
  const portalLight = new THREE.PointLight(SCENES.ruins.accent, 6, 15);
  portalLight.position.set(0, 2.3, -9.7);
  portal.add(portalLight);
  scene.add(portal);

  const positions = new Float32Array(1000 * 3);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (random() - .5) * 90;
    positions[i + 1] = .2 + random() * 24;
    positions[i + 2] = (random() - .5) * 90;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0x83e9df, size: .035, transparent: true, opacity: .65 }));
  scene.add(dust);

  spawnTargets();

  buildAvatar(fallbackBeing(currentTokenId));
  bindControls();
  animate();
}

function makeFragment(position, index) {
  const group = new THREE.Group();
  const colors = [0x55e2d4, 0xe9c65a, 0xa995ff, 0xed6f76];
  const color = colors[index % colors.length];
  const material = new THREE.MeshStandardMaterial({ color: 0x0a1718, emissive: color, emissiveIntensity: .62, metalness: .72, roughness: .25 });
  const shard = mesh(new THREE.OctahedronGeometry(.48 + (index % 3) * .08, 0), material, [0, .8, 0], [0, index * .7, 0]);
  shard.castShadow = true;
  group.add(shard);
  const ringMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55, blending: THREE.AdditiveBlending });
  group.add(mesh(new THREE.TorusGeometry(.74, .025, 5, 32), ringMaterial, [0, .8, 0], [Math.PI / 2, 0, 0]));
  const light = new THREE.PointLight(color, 2.4, 4.5, 2);
  light.position.y = .85;
  group.add(light);
  group.position.set(...position);
  group.userData = { name: index % 4 === 3 ? "ANCIENT FRAGMENT" : "CHAIN FRAGMENT", hp: 3 + index % 3, maxHp: 3 + index % 3, rarity: 1 + (index % 4) * .18, active: true, respawnAt: 0, phase: index * 1.7, shard, ring: group.children[1], baseColor: color };
  scene.add(group);
  targets.push(group);
}

function spawnTargets() {
  [[1.9, 0, 1.2], [-4.2, 0, -1.7], [4.8, 0, -5.5], [-6.5, 0, -8], [7.5, 0, 4.5], [1.5, 0, -12]].forEach(makeFragment);
}

function nearestTarget() {
  if (!avatar) return null;
  let nearest = null;
  let distance = Infinity;
  targets.forEach((target) => {
    if (!target.userData.active) return;
    const nextDistance = target.position.distanceTo(avatar.position);
    if (nextDistance < distance) {
      nearest = target;
      distance = nextDistance;
    }
  });
  return nearest ? { target: nearest, distance } : null;
}

function oreForHit(target, destroyed = false) {
  const power = Math.max(1, currentBeing?.power || 1);
  const skill = Math.max(1, currentBeing?.skill || 1);
  const stage = Math.max(0, currentBeing?.stage || 0);
  const sceneMultiplier = { ruins: 1, abyss: .55, astral: .32 }[currentScene];
  const jitterSeed = ethers.keccak256(ethers.toUtf8Bytes(`${currentBeing?.genome || "0x01"}:${currentTokenId}:${Math.floor(performance.now() / 400)}`));
  const jitter = .82 + seedFromGenome(jitterSeed)() * .36;
  const base = (power + skill * .6) / (120000 + stage * 18000);
  return base * sceneMultiplier * target.userData.rarity * jitter * (destroyed ? 2.5 : 1);
}

function showOreGain(amount, target, destroyed) {
  const projected = target.position.clone().add(new THREE.Vector3(0, 1.45, 0)).project(camera);
  const gain = document.createElement("span");
  gain.className = `ore-gain${destroyed ? " kill" : ""}`;
  gain.textContent = `+${amount.toFixed(6)} ORE`;
  gain.style.left = `${clamp((projected.x * .5 + .5) * innerWidth, 42, innerWidth - 42)}px`;
  gain.style.top = `${clamp((-projected.y * .5 + .5) * innerHeight, 100, innerHeight - 100)}px`;
  $("oreGains").appendChild(gain);
  setTimeout(() => gain.remove(), 1250);
}

function attackTarget() {
  const now = performance.now();
  if (now - lastAttackAt < 430 || !currentBeing) return;
  lastAttackAt = now;
  pulse = Math.max(pulse, 1.35);
  const nearest = nearestTarget();
  if (!nearest || nearest.distance > 4.2) {
    $("simulationLog").textContent = "Attack missed. Move within 4.2 units of a glowing Chain Fragment.";
    notify("No fragment in attack range");
    return;
  }

  const { target } = nearest;
  target.userData.hp -= 1;
  const destroyed = target.userData.hp <= 0;
  const amount = oreForHit(target, destroyed);
  simulatedOre += amount;
  $("oreValue").textContent = simulatedOre.toFixed(6);
  showOreGain(amount, target, destroyed);
  target.userData.shard.material.emissiveIntensity = 2.4;
  target.scale.setScalar(1.25);

  if (destroyed) {
    target.userData.active = false;
    target.userData.respawnAt = now + 4200;
    setTimeout(() => { target.visible = false; }, 170);
    $("simulationLog").textContent = `${target.userData.name} dispersed. +${amount.toFixed(6)} simulated ORE. It will reconstruct locally.`;
  } else {
    $("simulationLog").textContent = `${target.userData.name} hit. +${amount.toFixed(6)} simulated ORE. ${target.userData.hp}/${target.userData.maxHp} integrity remains.`;
  }
}

function updateTargets(elapsed, now) {
  targets.forEach((target) => {
    if (!target.userData.active) {
      if (now >= target.userData.respawnAt) {
        target.userData.active = true;
        target.userData.hp = target.userData.maxHp;
        target.visible = true;
        target.scale.setScalar(1);
      }
      return;
    }
    target.rotation.y = elapsed * .36 + target.userData.phase;
    target.userData.shard.rotation.x = elapsed * .55 + target.userData.phase;
    target.userData.ring.rotation.z = elapsed * .42;
    target.userData.shard.position.y = .8 + Math.sin(elapsed * 1.7 + target.userData.phase) * .12;
    target.scale.lerp(new THREE.Vector3(1, 1, 1), .12);
    target.userData.shard.material.emissiveIntensity += (.62 - target.userData.shard.material.emissiveIntensity) * .1;
  });

  const nearest = nearestTarget();
  const readout = document.querySelector(".target-readout");
  if (!nearest) {
    $("targetName").textContent = "RECONSTRUCTING";
    $("targetStatus").textContent = "NO TARGET";
    readout.classList.add("out-of-range");
    return;
  }
  $("targetName").textContent = nearest.target.userData.name;
  $("targetStatus").textContent = nearest.distance <= 4.2 ? `IN RANGE / ${nearest.target.userData.hp} HP` : `${nearest.distance.toFixed(1)} m AWAY`;
  readout.classList.toggle("out-of-range", nearest.distance > 4.2);
}

function updateEnvironment(name) {
  currentScene = name;
  const config = SCENES[name];
  scene.background.setHex(config.sky);
  scene.fog.color.setHex(config.fog);
  floor.material.color.setHex(config.ground);
  grid.material.color.setHex(config.accent);
  portal.children.forEach((object) => {
    if (object.material?.color) object.material.color.setHex(config.accent);
    if (object.isLight) object.color.setHex(config.accent);
  });
  dust.material.color.setHex(config.accent);
  $("sceneName").textContent = config.name;
  $("sceneDescription").textContent = config.description;
  document.querySelectorAll("[data-scene]").forEach((button) => button.classList.toggle("active", button.dataset.scene === name));
  notify(`${config.name} loaded locally`);
}

function setData(being, owner, tokenId, metadata, source = "chain") {
  currentBeing = structuredClone(being);
  chainBeing = structuredClone(being);
  currentTokenId = tokenId;
  const names = lineageNames(being.lineageMask);
  $("beingName").textContent = `Being #${tokenId}`;
  $("beingLineage").textContent = `${names.join(" + ") || "Unknown"} / ${names.length > 1 ? "HYBRID" : "ORIGIN"}`;
  $("ownerValue").textContent = short(owner || "UNAVAILABLE");
  $("ownerValue").title = owner || "";
  $("stageValue").textContent = String(being.stage);
  $("genomeValue").textContent = short(being.genome, 8, 6);
  $("genomeValue").title = being.genome;
  $("powerValue").textContent = displayNumber(being.power);
  $("skillValue").textContent = displayNumber(being.skill);
  $("massValue").textContent = displayNumber(being.mass);
  $("complexityValue").textContent = displayNumber(being.complexity);
  $("devoursValue").textContent = displayNumber(being.devours);
  $("fusionsValue").textContent = displayNumber(being.fusions);
  $("powerBar").style.width = `${clamp(Math.log2(being.power + 1) * 15, 4, 100)}%`;
  $("skillBar").style.width = `${clamp(Math.log2(being.skill + 1) * 15, 4, 100)}%`;
  const image = metadata?.image;
  $("tokenImage").innerHTML = image && /^(data:image\/|https:\/\/)/.test(image) ? `<img src="${image}" alt="On-chain artwork for Being #${tokenId}">` : "<span>ON-CHAIN<br>SVG</span>";
  $("loadStatus").className = "load-status";
  $("loadStatus").textContent = source === "chain" ? "Verified read from Ethereum Mainnet. 3D form is a deterministic local projection." : "RPC unavailable. Displaying a deterministic local specimen.";
  buildAvatar(currentBeing);
}

async function loadBeing(tokenId) {
  $("loadStatus").className = "load-status";
  $("loadStatus").textContent = `Reading Being #${tokenId} from Ethereum Mainnet...`;
  $("chainState").textContent = "READING ETHEREUM";
  try {
    const [owner, raw, uri, block] = await Promise.all([
      contract.ownerOf(tokenId),
      contract.getBeing(tokenId),
      contract.tokenURI(tokenId).catch(() => ""),
      provider.getBlockNumber()
    ]);
    setData(normalizeBeing(raw), owner, tokenId, decodeTokenURI(uri), "chain");
    $("blockNumber").textContent = `BLOCK ${block.toLocaleString("en-US")}`;
    $("chainState").textContent = "ETHEREUM VERIFIED";
    notify(`Being #${tokenId} projected from chain`);
  } catch (error) {
    setData(fallbackBeing(tokenId), "", tokenId, null, "fallback");
    $("chainState").textContent = "LOCAL FALLBACK";
    $("loadStatus").className = "load-status error";
    $("loadStatus").textContent = error?.shortMessage || error?.message || "Unable to read this token.";
    notify("Chain read unavailable; local specimen loaded");
  }
}

function simulate(type) {
  if (!currentBeing) return;
  const next = structuredClone(currentBeing);
  if (type === "hunt") {
    next.power += 1;
    next.skill += currentScene === "astral" ? 2 : 1;
    next.huntNonce = (BigInt(next.huntNonce) + 1n).toString();
    pulse = 1.8;
    $("simulationLog").textContent = `Hunt projection completed in ${SCENES[currentScene].name}. Temporary PWR +1 / SKL +${currentScene === "astral" ? 2 : 1}.`;
  }
  if (type === "evolve") {
    next.stage += 1;
    next.complexity = (BigInt(next.complexity) + 12n + BigInt(next.stage * 4)).toString();
    next.mass = (BigInt(next.mass) + 4n).toString();
    next.power += 3;
    next.skill += 2;
    next.scars += next.stage % 3 === 0 ? 1 : 0;
    next.genome = ethers.keccak256(ethers.solidityPacked(["bytes32", "string", "uint256"], [next.genome, "3d-evolution-preview", next.stage]));
    pulse = 2.4;
    $("simulationLog").textContent = `Evolution preview reached Stage ${next.stage}. Geometry changed without writing to Ethereum.`;
  }
  if (type === "hybrid") {
    const active = lineageNames(next.lineageMask);
    const missing = LINEAGES.map((_, index) => index).filter((index) => !(next.lineageMask & (1 << index)));
    const random = seedFromGenome(`${next.genome.slice(0, 60)}ab01`);
    const added = missing.length ? missing[Math.floor(random() * missing.length)] : Math.floor(random() * 6);
    next.lineageMask |= 1 << added;
    next.fusions = (BigInt(next.fusions) + 1n).toString();
    next.genome = ethers.keccak256(ethers.solidityPacked(["bytes32", "uint8", "string"], [next.genome, added, "3d-hybrid-preview"]));
    pulse = 2.8;
    $("simulationLog").textContent = `${active.join(" + ") || "Origin"} combined with ${LINEAGES[added]}. This is a local visual hypothesis, not an on-chain Fusion.`;
  }
  currentBeing = next;
  const owner = $("ownerValue").title;
  setPreviewData(next, owner);
  buildAvatar(next);
}

function setPreviewData(being) {
  const names = lineageNames(being.lineageMask);
  $("beingLineage").textContent = `${names.join(" + ")} / LOCAL PREVIEW`;
  $("stageValue").textContent = String(being.stage);
  $("genomeValue").textContent = short(being.genome, 8, 6);
  $("powerValue").textContent = displayNumber(being.power);
  $("skillValue").textContent = displayNumber(being.skill);
  $("massValue").textContent = displayNumber(being.mass);
  $("complexityValue").textContent = displayNumber(being.complexity);
  $("fusionsValue").textContent = displayNumber(being.fusions);
}

function resetSimulation() {
  if (!chainBeing) return;
  currentBeing = structuredClone(chainBeing);
  setPreviewData(currentBeing);
  const names = lineageNames(currentBeing.lineageMask);
  $("beingLineage").textContent = `${names.join(" + ") || "Unknown"} / ${names.length > 1 ? "HYBRID" : "ORIGIN"}`;
  $("simulationLog").textContent = "Reset to the latest state read from Ethereum. No simulation active.";
  simulatedOre = 0;
  $("oreValue").textContent = "0.000000";
  buildAvatar(currentBeing);
  notify("Restored chain state");
}

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function bindControls() {
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  });
  addEventListener("keydown", (event) => {
    if (["INPUT", "BUTTON"].includes(document.activeElement?.tagName)) return;
    keys.add(event.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
    if (event.code === "Space" && !event.repeat) attackTarget();
  });
  addEventListener("keyup", (event) => keys.delete(event.code));
  renderer.domElement.addEventListener("pointerdown", (event) => { dragging = true; pointerX = event.clientX; pointerY = event.clientY; });
  addEventListener("pointerup", () => { dragging = false; });
  addEventListener("pointermove", (event) => {
    if (!dragging) return;
    cameraYaw -= (event.clientX - pointerX) * .004;
    cameraPitch = clamp(cameraPitch + (event.clientY - pointerY) * .003, .08, .62);
    pointerX = event.clientX;
    pointerY = event.clientY;
  });
  document.querySelectorAll(".mobile-controls button").forEach((button) => {
    const key = button.dataset.key;
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); keys.add(key); if (key === "Space") attackTarget(); });
    button.addEventListener("pointerup", () => keys.delete(key));
    button.addEventListener("pointercancel", () => keys.delete(key));
  });
}

function moveAvatar(delta, elapsed) {
  if (!avatar) return;
  let x = 0;
  let z = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) z -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) z += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
  const moving = x || z;
  if (moving) {
    const direction = new THREE.Vector3(x, 0, z).normalize();
    direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
    const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 6.5 : 3.6;
    avatar.position.addScaledVector(direction, speed * delta);
    avatar.position.x = clamp(avatar.position.x, -32, 32);
    avatar.position.z = clamp(avatar.position.z, -32, 32);
    avatar.rotation.y = Math.atan2(direction.x, direction.z);
  }
  const walk = moving ? Math.sin(elapsed * (keys.has("ShiftLeft") ? 12 : 8)) : 0;
  avatarCore?.userData.limbs?.forEach((limb) => {
    limb.rotation.x = walk * .48 * limb.userData.side * (limb.userData.limb === "arm" ? -1 : 1);
  });
  avatarCore?.traverse((object) => {
    if (object.userData.spin) object.rotation.z += delta * object.userData.spin;
    if (object.userData.float !== undefined) object.position.y += Math.sin(elapsed * 1.8 + object.userData.float) * .0015;
    if (object.userData.orbit) {
      object.userData.angle += delta * object.userData.orbit;
      const radius = Math.hypot(object.position.x, object.position.z);
      object.position.x = Math.cos(object.userData.angle) * radius;
      object.position.z = Math.sin(object.userData.angle) * radius;
    }
    if (object.userData.wing) object.rotation.z += Math.sin(elapsed * 2.6) * .002 * object.userData.wing;
  });
  avatarCore.position.y = Math.sin(elapsed * 2.2) * .035 + (pulse > 0 ? Math.sin((1.8 - pulse) * 5) * .08 : 0);
  if (pulse > 0) pulse = Math.max(0, pulse - delta);
  if (aura) {
    const auraScale = 1 + Math.sin(elapsed * 2) * .06 + pulse * .28;
    aura.scale.setScalar(auraScale);
    aura.material.opacity = .42 + pulse * .18;
  }
}

function updateCamera(delta) {
  if (!avatar) return;
  const distance = innerWidth < 640 ? 9.5 : 7.2;
  const horizontal = Math.cos(cameraPitch) * distance;
  const target = avatar.position.clone().add(new THREE.Vector3(0, 2.05, 0));
  const desired = target.clone().add(new THREE.Vector3(Math.sin(cameraYaw) * horizontal, Math.sin(cameraPitch) * distance + 1.1, Math.cos(cameraYaw) * horizontal));
  camera.position.lerp(desired, 1 - Math.exp(-delta * 6));
  camera.lookAt(target);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), .05);
  const elapsed = clock.elapsedTime;
  moveAvatar(delta, elapsed);
  updateTargets(elapsed, performance.now());
  updateCamera(delta);
  portal.rotation.z += delta * .08;
  portal.children[1].rotation.z -= delta * .24;
  dust.rotation.y += delta * .003;
  renderer.render(scene, camera);
}

$("loadForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const tokenId = clamp(Number.parseInt($("tokenInput").value, 10) || 1, 1, 9999);
  $("tokenInput").value = String(tokenId);
  loadBeing(tokenId);
});
document.querySelectorAll("[data-scene]").forEach((button) => button.addEventListener("click", () => updateEnvironment(button.dataset.scene)));
$("huntButton").addEventListener("click", () => simulate("hunt"));
$("evolveButton").addEventListener("click", () => simulate("evolve"));
$("hybridButton").addEventListener("click", () => simulate("hybrid"));
$("resetButton").addEventListener("click", resetSimulation);

makeWorld();
loadBeing(currentTokenId);
