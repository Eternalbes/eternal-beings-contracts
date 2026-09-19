const assert = require("assert");
const { ethers } = require("ethers");
const {
  attestCode,
  attestSource,
  byteLength,
  fetchSourceVerification,
  normalizeAddress,
  readAddress,
  readUint256,
} = require("./stock-world-v4-attest");

async function main() {
  const address = "0x0000000000000000000000000000000000001234";
  const code = "0x6001600055";
  const encodedAddress = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [address]);
  const encodedUint = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [42n]);
  const addressSelector = ethers.id("poolManager()").slice(0, 10);
  const uintSelector = ethers.id("nextTokenId()").slice(0, 10);
  const provider = {
    async getCode(receivedAddress, blockTag) {
      assert.equal(receivedAddress, ethers.getAddress(address));
      assert.equal(blockTag, 123);
      return code;
    },
    async call(request, blockTag) {
      assert.equal(request.to, address);
      assert.equal(blockTag, 123);
      if (request.data === addressSelector) return encodedAddress;
      if (request.data === uintSelector) return encodedUint;
      return "0x";
    },
  };

  assert.equal(normalizeAddress(address, "test"), ethers.getAddress(address));
  assert.equal(byteLength(code), 5);
  const record = {
    address,
    codeBytes: 5,
    codeHash: ethers.keccak256(code),
  };
  assert.deepEqual(await attestCode(provider, "Test", record, 123), {
    address: ethers.getAddress(address),
    codeBytes: 5,
    codeHash: ethers.keccak256(code),
  });
  assert.equal(await readAddress(provider, address, "poolManager()", 123), ethers.getAddress(address));
  assert.equal(await readUint256(provider, address, "nextTokenId()", 123), 42n);

  const sourceRecord = {
    sourceVerification: {
      provider: "sourcify-v2",
      matchId: "77",
      runtimeMatch: "match",
      contractName: "PoolManager",
      fullyQualifiedName: "src/PoolManager.sol:PoolManager",
      compilerVersion: "0.8.26+commit.8a97fa7a",
    },
  };
  const sourcePayload = {
    matchId: "77",
    runtimeMatch: "match",
    verifiedAt: "2026-09-01T00:00:00Z",
    compilation: {
      name: "PoolManager",
      fullyQualifiedName: "src/PoolManager.sol:PoolManager",
      compilerVersion: "0.8.26+commit.8a97fa7a",
    },
  };
  assert.equal(attestSource("PoolManager", sourceRecord, sourcePayload).matchId, "77");
  const fetched = await fetchSourceVerification(4663n, address, async (url, options) => {
    assert.equal(url.includes("/v2/contract/4663/"), true);
    assert.equal(options.headers.accept, "application/json");
    return { ok: true, json: async () => sourcePayload };
  });
  assert.deepEqual(fetched, sourcePayload);

  await assert.rejects(
    attestCode(provider, "Test", { ...record, codeBytes: 6 }, 123),
    /code size mismatch/,
  );
  await assert.rejects(
    attestCode(provider, "Test", { ...record, codeHash: ethers.ZeroHash }, 123),
    /code hash mismatch/,
  );
  await assert.rejects(
    attestCode({ getCode: async () => "0x" }, "Test", record, 123),
    /has no code/,
  );
  await assert.rejects(
    readAddress({ call: async () => "0x" }, address, "poolManager()", 123),
    /malformed data/,
  );
  await assert.rejects(
    fetchSourceVerification(4663, address, async () => ({ ok: false, status: 404 })),
    /Sourcify lookup failed/,
  );
  assert.throws(
    () => attestSource("PoolManager", sourceRecord, { ...sourcePayload, runtimeMatch: "exact_match" }),
    /source runtimeMatch mismatch/,
  );
  assert.throws(
    () => attestSource("PoolManager", sourceRecord, { ...sourcePayload, compilation: undefined }),
    /no Sourcify compilation metadata/,
  );
  assert.throws(() => normalizeAddress("not-an-address", "test"), /Invalid test address/);

  console.log("Stock World v4 attestation guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
