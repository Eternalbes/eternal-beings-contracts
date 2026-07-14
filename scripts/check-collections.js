const fs = require("fs");
const { ethers } = require("ethers");

const inputPath = process.argv[2] || "data/top-collections.ethereum.curated.json";
const outPath = process.argv[3] || "";
const rpcUrl = process.env.ETH_RPC_URL || "https://ethereum.publicnode.com";
const entries = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC165_INTERFACE_ID = "0x01ffc9a7";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const knownSpecial = new Map(
  [
    ["0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB", "native CryptoPunks: use observeCryptoPunk/devourCryptoPunk"],
    ["0xD4e4078CA3495DE5B1d4dB434BEbc5a986197782", "Autoglyphs: early on-chain art, verify ERC721 behavior before enabling"],
    ["0x059edd72Cd353d124731D9dF5A6FfC1F2e11f2F5", "Art Blocks legacy shared contract: verify project/token behavior"],
    ["0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270", "Art Blocks shared contract: duplicate collection address for many projects"],
    ["0xABB3738f04Dc2Ec20f4AE4462c3d069d02AE045B", "KnownOrigin legacy marketplace contract: verify ERC721 behavior"],
  ].map(([address, note]) => [ethers.getAddress(address.toLowerCase()).toLowerCase(), note]),
);

const abi = [
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function punkIndexToAddress(uint256 punkIndex) view returns (address)",
];

function classify(check) {
  if (!check.hasCode) return "remove";
  if (check.knownSpecial && check.name === "CryptoPunks") return "adapter";
  if (check.knownSpecial && !check.erc721) return "adapter";
  if (check.erc721) return check.knownSpecial ? "review" : "direct";
  if (check.hasOwnerOf && check.hasTotalSupply) return "review";
  if (check.hasPunkIndexToAddress) return "adapter";
  return "remove";
}

async function optionalCall(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error.shortMessage || error.message };
  }
}

async function hasAnyOwnerOf(contract) {
  for (const tokenId of [0, 1, 2, 10, 100, 1000, 5000, 9999]) {
    const result = await optionalCall(`ownerOf${tokenId}`, () => contract.ownerOf(tokenId));
    if (result.ok && result.value !== ZERO_ADDRESS) return true;
  }
  return false;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const results = [];

  for (const entry of entries) {
    const address = ethers.getAddress(entry.address.toLowerCase());
    const contract = new ethers.Contract(address, abi, provider);
    const code = await provider.getCode(address);

    const erc165Call = await optionalCall("erc165", () => contract.supportsInterface(ERC165_INTERFACE_ID));
    const erc721Call = await optionalCall("erc721", () => contract.supportsInterface(ERC721_INTERFACE_ID));
    const totalSupplyCall = await optionalCall("totalSupply", () => contract.totalSupply());
    const nameCall = await optionalCall("name", () => contract.name());
    const symbolCall = await optionalCall("symbol", () => contract.symbol());
    const ownerOfCall = await hasAnyOwnerOf(contract);
    const punkZeroCall = await optionalCall("punk0", () => contract.punkIndexToAddress(0));

    const check = {
      rank: entry.rank,
      tier: entry.tier,
      name: entry.name,
      address,
      hasCode: code !== "0x",
      codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
      erc165: erc165Call.ok ? Boolean(erc165Call.value) : false,
      erc721: erc721Call.ok ? Boolean(erc721Call.value) : false,
      hasTotalSupply: totalSupplyCall.ok,
      totalSupply: totalSupplyCall.ok ? totalSupplyCall.value.toString() : null,
      chainName: nameCall.ok ? nameCall.value : null,
      chainSymbol: symbolCall.ok ? symbolCall.value : null,
      hasOwnerOf: ownerOfCall,
      hasPunkIndexToAddress: punkZeroCall.ok,
      knownSpecial: knownSpecial.get(address.toLowerCase()) || null,
    };
    check.classification = classify(check);
    results.push(check);
  }

  const counts = results.reduce((acc, result) => {
    acc[result.classification] = (acc[result.classification] || 0) + 1;
    return acc;
  }, {});

  const report = { rpcUrl, checkedAt: new Date().toISOString(), counts, results };
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, `${json}\n`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
