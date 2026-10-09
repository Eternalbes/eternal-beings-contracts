const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inspectCompose } = require("../regtest/compose-review");

const policy = { projectName: "ebz-regtest-unit", configRoot: "/isolated/regtest-config" };
// Synthetic structural test data, not real image pins or a runnable stack.
function model() {
  const service = () => ({ image: "example.invalid/test@sha256:" + "0".repeat(64),
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], networks: { default: null } });
  const config = (file, target) => ({ type: "bind", source: policy.configRoot + "/" + file,
    target, read_only: true, bind: { create_host_path: false } });
  return { name: policy.projectName, networks: { default: { name: policy.projectName + "_default" } },
    volumes: { wallet: { name: policy.projectName + "_wallet" } }, services: {
      zebra: { ...service(), environment: { ZEBRA_NETWORK__NETWORK: "Regtest" },
        volumes: [config("zebra.toml", "/home/zebra/.config/zebrad.toml")] },
      zallet: { ...service(), volumes: [config("zallet.toml", "/etc/zallet/zallet.toml"),
        { type: "volume", source: "wallet", target: "/var/lib/zallet", volume: { nocopy: true } }] },
      "rpc-router": { ...service(), ports: [{ target: 8181, published: "8181", host_ip: "127.0.0.1", protocol: "tcp", mode: "ingress" }] },
    } };
}
const codes = input => inspectCompose(input, policy).blockers.map(issue => issue.code);

test("offline review passes a scoped structural model but never enables runtime or chain actions", () => {
  const report = inspectCompose(model(), policy);
  assert.equal(report.static_checks_passed, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.digest_pinned_image_count, 3);
  for (const key of ["runtime_started", "chain_actions_enabled", "wallet_initialized", "config_files_verified",
    "image_contents_verified", "volume_freshness_verified", "real_memo_integration_test_complete"]) assert.equal(report[key], false);
});

test("mainnet defaults, missing node services and unresolved env cannot pass", () => {
  const a = model(); a.name = "z3-mainnet"; a.services.zebra.environment.ZEBRA_NETWORK__NETWORK = "Mainnet";
  assert.ok(codes(a).includes("PROJECT_SCOPE_MISMATCH"));
  assert.ok(codes(a).includes("REGTEST_ENVIRONMENT_REQUIRED"));
  const b = model(); delete b.services.zallet;
  assert.ok(codes(b).includes("REQUIRED_SERVICE_MISSING"));
  const c = model(); c.services.zebra.environment.X = "${PRIVATE_CONFIG}";
  assert.ok(codes(c).includes("UNRESOLVED_ENVIRONMENT"));
  assert.throws(() => inspectCompose(model(), { ...policy, projectName: "z3-mainnet" }), { code: "ISOLATED_REGTEST_PROJECT_REQUIRED" });
});

test("public binds, omitted host addresses, UDP, ranges and duplicate ports are rejected", () => {
  for (const patch of [{ host_ip: "0.0.0.0" }, { host_ip: undefined }, { host_ip: "localhost" },
    { host_ip: "::" }, { protocol: "udp" }, { published: "8181-8199" }, { published: 65536 }, { target: 0 }]) {
    const input = model(); Object.assign(input.services["rpc-router"].ports[0], patch);
    assert.ok(codes(input).includes("LOOPBACK_TCP_PORT_REQUIRED"));
  }
  const input = model(); input.services.zebra.ports = structuredClone(input.services["rpc-router"].ports);
  assert.ok(codes(input).includes("DUPLICATE_HOST_PORT"));
  const ipv6 = model(); ipv6.services["rpc-router"].ports[0].host_ip = "::1";
  assert.deepEqual(codes(ipv6), []);
});

test("mutable image tags, builds, privileged containers and host namespaces are rejected", () => {
  for (const [key, value, expected] of [["image", "zfnd/zebra:latest", "IMAGE_DIGEST_REQUIRED"],
    ["build", { context: "." }, "UNREVIEWED_SERVICE_FIELD"], ["privileged", true, "UNREVIEWED_SERVICE_FIELD"],
    ["network_mode", "host", "UNREVIEWED_SERVICE_FIELD"], ["pid", "host", "UNREVIEWED_SERVICE_FIELD"],
    ["devices", ["/dev/kvm"], "UNREVIEWED_SERVICE_FIELD"], ["cap_add", ["SYS_ADMIN"], "UNREVIEWED_CAPABILITY"],
    ["security_opt", ["seccomp:unconfined"], "CONTAINER_HARDENING_REQUIRED"]]) {
    const input = model(); input.services.zebra[key] = value;
    assert.ok(codes(input).includes(expected));
  }
});

test("external or shared storage, host paths and Docker socket mounts cannot pass", () => {
  for (const patch of [{ name: "production-wallet" }, { external: true }, { driver: "nfs" },
    { driver_opts: { type: "none", device: "/wallet", o: "bind" } }]) {
    const input = model(); Object.assign(input.volumes.wallet, patch);
    assert.ok(codes(input).includes("UNISOLATED_VOLUME"));
  }
  const socket = model(); socket.services.zallet.volumes.push({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" });
  assert.ok(codes(socket).includes("UNREVIEWED_MOUNT"));
  const home = model(); home.services.zallet.volumes[0].source = "/Users/operator/.zcash/zallet.toml";
  assert.ok(codes(home).includes("READ_ONLY_REGTEST_CONFIG_BIND_REQUIRED"));
  const mount = model(); mount.services.zallet.volumes[1].source = "unknown";
  assert.ok(codes(mount).includes("UNISOLATED_VOLUME_MOUNT"));
});

test("config binds must be readonly, confined and explicit rather than auto-created", () => {
  for (const patch of [{ read_only: false }, { source: "/isolated/regtest-config-other/zebra.toml" },
    { bind: { create_host_path: true } }, { target: "/etc/somewhere.toml" }, { source: "zebra.toml" }]) {
    const input = model(); Object.assign(input.services.zebra.volumes[0], patch);
    assert.ok(codes(input).includes("READ_ONLY_REGTEST_CONFIG_BIND_REQUIRED"));
    assert.ok(codes(input).includes("NODE_CONFIG_MOUNT_REQUIRED"));
  }
  const duplicate = model(); duplicate.services.zebra.volumes.push(structuredClone(duplicate.services.zebra.volumes[0]));
  assert.ok(codes(duplicate).includes("DUPLICATE_MOUNT_TARGET"));
  const hiding = model(); hiding.services.zebra.volumes.push({ type: "volume", source: "wallet",
    target: "/home/zebra/.config/zebrad.toml", volume: { nocopy: true } });
  assert.ok(codes(hiding).includes("UNISOLATED_VOLUME_MOUNT"));
});

test("unreviewed helpers, network modes, container names and optional indexes fail closed", () => {
  const a = model(); a.services.helper = { image: "anything" };
  assert.ok(codes(a).includes("UNREVIEWED_SERVICE"));
  const b = model(); b.networks.default.external = true;
  assert.ok(codes(b).includes("UNISOLATED_NETWORK"));
  const c = model(); c.services.zallet.container_name = "existing-zallet";
  assert.ok(codes(c).includes("UNISOLATED_CONTAINER_NAME"));
  const d = model(); d.services.zaino = { ...d.services.zebra, environment: { ZAINO_NETWORK: "Mainnet" } };
  assert.ok(codes(d).includes("REGTEST_ENVIRONMENT_REQUIRED"));
  const e = model(); e.services.zebra.networks = { default: { ipv4_address: "172.17.0.1" } };
  assert.ok(codes(e).includes("SCOPED_NETWORK_REQUIRED"));
});

test("configuration CLI prints redacted checks only and rejects permissive/symlink inputs", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebz-compose-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "private.json");
  const input = model(); input.services["rpc-router"].environment = { RPC_PASSWORD: "PRIVATE_SENTINEL_NOT_FOR_OUTPUT" };
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  const run = target => spawnSync(process.execPath, [require.resolve("../bin/review-regtest-config"), target], {
    env: { EBZ_REGTEST_PROJECT: policy.projectName, EBZ_REGTEST_CONFIG_ROOT: policy.configRoot }, encoding: "utf8", timeout: 10000,
  });
  const accepted = run(file);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).static_checks_passed, true);
  assert.equal((accepted.stdout + accepted.stderr).includes("PRIVATE_SENTINEL_NOT_FOR_OUTPUT"), false);
  input.services["rpc-router"].ports[0].host_ip = "0.0.0.0";
  fs.writeFileSync(file, JSON.stringify(input));
  assert.equal(run(file).status, 2);
  fs.chmodSync(file, 0o644);
  assert.match(run(file).stderr, /PRIVATE_CONFIG_FILE_REQUIRED/);
  const link = path.join(directory, "link.json"); fs.symlinkSync(file, link);
  assert.notEqual(run(link).status, 0);
});

test("invalid JSON/UTF-8 and oversized files never leak their raw content", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebz-compose-invalid-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "private.json");
  for (const contents of ["PRIVATE_SENTINEL_NOT_FOR_OUTPUT", Buffer.from([0xff]), "x".repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    const result = spawnSync(process.execPath, [require.resolve("../bin/review-regtest-config"), file], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal((result.stdout + result.stderr).includes("PRIVATE_SENTINEL_NOT_FOR_OUTPUT"), false);
  }
});
