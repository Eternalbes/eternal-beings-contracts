const path = require("node:path");
const { ensure } = require("../lib/crypto");

const SERVICES = ["zebra", "zallet", "rpc-router", "cookie-permissions", "zaino"];
const REQUIRED = ["zebra", "zallet", "rpc-router"];
const CAPS = {
  zebra: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
  zaino: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
  "cookie-permissions": ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
  zallet: [], "rpc-router": [],
};
const SERVICE_FIELDS = new Set(["image", "platform", "container_name", "restart", "stop_grace_period",
  "cap_drop", "cap_add", "security_opt", "environment", "volumes", "ports", "networks", "depends_on",
  "healthcheck", "command", "entrypoint", "profiles", "user", "read_only", "init", "working_dir", "labels"]);
const CONFIG_TARGETS = {
  zebra: "/home/zebra/.config/zebrad.toml", zallet: "/etc/zallet/zallet.toml", zaino: "/etc/zaino/zindexer.toml",
};
const DATA_TARGETS = {
  zebra: ["/home/zebra/.cache/zebra", "/var/run/auth"],
  zallet: ["/var/lib/zallet", "/etc/ssl/certs"], zaino: ["/app/data"],
  "cookie-permissions": ["/var/run/auth", "/var/run/zallet-data", "/var/run/zallet-ca"], "rpc-router": [],
};
const object = value => value && typeof value === "object" && !Array.isArray(value);
const portNumber = value => /^(?:[1-9][0-9]{0,4})$/.test(String(value)) && Number(value) <= 65535;
const scoped = (name, project) => typeof name === "string" && name.startsWith(project + "_") &&
  /^[a-z0-9_-]{1,100}$/.test(name);

function inspectCompose(model, { projectName, configRoot }) {
  ensure(typeof projectName === "string" && /^ebz-regtest-[a-z0-9][a-z0-9-]{0,31}$/.test(projectName), "ISOLATED_REGTEST_PROJECT_REQUIRED");
  ensure(typeof configRoot === "string" && path.isAbsolute(configRoot) &&
    path.normalize(configRoot) !== path.parse(configRoot).root && !configRoot.includes("${"), "REGTEST_CONFIG_ROOT_REQUIRED");
  ensure(object(model) && object(model.services) && Object.keys(model.services).length <= 8, "INVALID_RESOLVED_COMPOSE");
  const issues = [];
  const add = (code, service) => issues.push(service && SERVICES.includes(service) ? { code, service } : { code });
  if (model.name !== projectName) add("PROJECT_SCOPE_MISMATCH");
  if (Object.keys(model).some(key => !["name", "services", "volumes", "networks"].includes(key))) add("UNREVIEWED_COMPOSE_TOP_LEVEL_FIELD");
  const volumes = object(model.volumes) ? model.volumes : {};
  const networks = object(model.networks) ? model.networks : {};
  if (model.volumes && !object(model.volumes)) add("INVALID_VOLUME_DEFINITIONS");
  if (model.networks && !object(model.networks)) add("INVALID_NETWORK_DEFINITIONS");
  if (Object.keys(volumes).length > 32 || Object.keys(networks).length > 8) add("COMPOSE_RESOURCE_LIMIT");
  for (const definition of Object.values(volumes)) {
    if (!object(definition) || !scoped(definition.name, projectName) || definition.external ||
      definition.driver_opts || (definition.driver && definition.driver !== "local") ||
      Object.keys(definition).some(key => !["name", "driver", "labels", "external"].includes(key))) add("UNISOLATED_VOLUME");
  }
  for (const definition of Object.values(networks)) {
    if (!object(definition) || !scoped(definition.name, projectName) || definition.external ||
      definition.driver_opts || (definition.driver && definition.driver !== "bridge") ||
      Object.keys(definition).some(key => !["name", "driver", "labels", "internal", "external"].includes(key))) add("UNISOLATED_NETWORK");
  }
  for (const name of REQUIRED) if (!Object.hasOwn(model.services, name)) add("REQUIRED_SERVICE_MISSING", name);
  const hostPorts = new Set();
  let publishedPorts = 0, pinnedImages = 0;
  for (const [name, service] of Object.entries(model.services)) {
    if (!SERVICES.includes(name)) { add("UNREVIEWED_SERVICE"); continue; }
    if (!object(service)) { add("INVALID_SERVICE", name); continue; }
    if (Object.keys(service).some(key => !SERVICE_FIELDS.has(key))) add("UNREVIEWED_SERVICE_FIELD", name);
    if (typeof service.image !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(service.image)) {
      add("IMAGE_DIGEST_REQUIRED", name);
    } else pinnedImages++;
    if (service.container_name && !scoped(service.container_name, projectName)) add("UNISOLATED_CONTAINER_NAME", name);
    if (!Array.isArray(service.cap_drop) || !service.cap_drop.includes("ALL") ||
      !Array.isArray(service.security_opt) || !service.security_opt.includes("no-new-privileges:true") ||
      service.security_opt.some(option => option !== "no-new-privileges:true")) add("CONTAINER_HARDENING_REQUIRED", name);
    if (service.cap_add && (!Array.isArray(service.cap_add) || service.cap_add.some(cap => !CAPS[name].includes(cap)))) add("UNREVIEWED_CAPABILITY", name);
    if (service.restart && !["no", "unless-stopped", "on-failure"].includes(service.restart)) add("UNREVIEWED_RESTART_POLICY", name);
    const env = object(service.environment) ? service.environment : {};
    if (service.environment && !object(service.environment)) add("RESOLVED_ENVIRONMENT_REQUIRED", name);
    if (Object.keys(env).length > 128 || Object.values(env).some(value =>
      value !== null && (typeof value !== "string" || value.includes("${")))) add("UNRESOLVED_ENVIRONMENT", name);
    const networkKey = { zebra: "ZEBRA_NETWORK__NETWORK", zaino: "ZAINO_NETWORK" }[name];
    if (networkKey && env[networkKey] !== "Regtest") add("REGTEST_ENVIRONMENT_REQUIRED", name);
    const ports = service.ports || [];
    if (!Array.isArray(ports) || ports.length > 16) { add("INVALID_PORT_MAPPING", name); }
    else for (const port of ports) {
      publishedPorts++;
      if (!object(port) || !["127.0.0.1", "::1"].includes(port.host_ip) ||
        !portNumber(port.published) || !portNumber(port.target) ||
        (port.protocol && port.protocol !== "tcp") || (port.mode && port.mode !== "ingress") ||
        Object.keys(port).some(key => !["host_ip", "published", "target", "protocol", "mode", "name"].includes(key))) {
        add("LOOPBACK_TCP_PORT_REQUIRED", name);
        continue;
      }
      const id = `${port.host_ip}:${port.published}`;
      if (hostPorts.has(id)) add("DUPLICATE_HOST_PORT", name);
      hostPorts.add(id);
    }
    const mounts = service.volumes || [];
    let hasConfig = false;
    const targets = new Set();
    if (!Array.isArray(mounts) || mounts.length > 16) add("INVALID_MOUNT_MAPPING", name);
    else for (const mount of mounts) {
      if (!object(mount) || typeof mount.target !== "string" || !path.posix.isAbsolute(mount.target) ||
        mount.target.includes("..") || mount.target.includes("docker.sock") ||
        (mount.read_only !== undefined && typeof mount.read_only !== "boolean") ||
        Object.keys(mount).some(key => !["type", "source", "target", "read_only", "bind", "volume"].includes(key))) {
        add("UNREVIEWED_MOUNT", name); continue;
      }
      if (targets.has(mount.target)) add("DUPLICATE_MOUNT_TARGET", name);
      targets.add(mount.target);
      if (mount.type === "volume") {
        if (!Object.hasOwn(volumes, mount.source) || !object(mount.volume) || mount.volume.nocopy !== true ||
          Object.keys(mount.volume).some(key => key !== "nocopy") ||
          !DATA_TARGETS[name].includes(mount.target) ||
          (mount.target === "/etc/ssl/certs" && mount.read_only !== true)) add("UNISOLATED_VOLUME_MOUNT", name);
      } else if (mount.type === "bind") {
        const relative = typeof mount.source === "string" && path.isAbsolute(mount.source) ?
          path.relative(configRoot, mount.source) : "..";
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ||
          !relative.endsWith(".toml") || mount.read_only !== true || mount.target !== CONFIG_TARGETS[name] ||
          !object(mount.bind) || mount.bind.create_host_path !== false ||
          Object.keys(mount.bind).some(key => key !== "create_host_path")) add("READ_ONLY_REGTEST_CONFIG_BIND_REQUIRED", name);
        else hasConfig = true;
      } else add("UNREVIEWED_MOUNT_TYPE", name);
    }
    if (CONFIG_TARGETS[name] && !hasConfig) add("NODE_CONFIG_MOUNT_REQUIRED", name);
    if (!object(service.networks) || !Object.keys(service.networks).length ||
      Object.entries(service.networks).some(([network, options]) => !Object.hasOwn(networks, network) ||
        (options !== null && (!object(options) || Object.keys(options).length)))) add("SCOPED_NETWORK_REQUIRED", name);
  }
  const unique = [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()];
  return { mode: "offline-resolved-regtest-compose-review", service_count: Object.keys(model.services).length,
    digest_pinned_image_count: pinnedImages, loopback_port_policy_checked: true, published_port_count: publishedPorts,
    blockers: unique, static_checks_passed: unique.length === 0,
    config_files_verified: false, image_contents_verified: false, volume_freshness_verified: false, runtime_started: false,
    wallet_initialized: false, chain_actions_enabled: false, real_memo_integration_test_complete: false,
    next_step: unique.length ? "correct-and-review-resolved-config" : "verify-config-files-images-and-obtain-runtime-approval" };
}

module.exports = { inspectCompose };
