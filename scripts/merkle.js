const { ethers } = require("ethers");

function leafFor(address, tier) {
  return ethers.solidityPackedKeccak256(["address", "uint8"], [ethers.getAddress(address.toLowerCase()), tier]);
}

function hashPair(a, b) {
  const left = BigInt(a) <= BigInt(b) ? a : b;
  const right = BigInt(a) <= BigInt(b) ? b : a;
  return ethers.keccak256(ethers.concat([left, right]));
}

function buildTree(entries) {
  if (entries.length === 0) {
    return { root: ethers.ZeroHash, leaves: [], layers: [] };
  }

  const leaves = entries.map((entry) => leafFor(entry.address, entry.tier));
  const layers = [leaves];

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 === current.length) {
        next.push(current[i]);
      } else {
        next.push(hashPair(current[i], current[i + 1]));
      }
    }
    layers.push(next);
  }

  return { root: layers[layers.length - 1][0], leaves, layers };
}

function proofFor(index, layers) {
  const proof = [];
  let cursor = index;

  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const pairIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    if (pairIndex < layer.length) {
      proof.push(layer[pairIndex]);
    }
    cursor = Math.floor(cursor / 2);
  }

  return proof;
}

module.exports = {
  buildTree,
  leafFor,
  proofFor,
};
