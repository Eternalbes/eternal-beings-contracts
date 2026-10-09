const fs = require("node:fs");
const { TextDecoder } = require("node:util");
const { ensure } = require("../lib/crypto");
const { inspectCompose } = require("../regtest/compose-review");

if (require.main === module) try {
  ensure(process.argv.length === 3, "USAGE_REVIEW_REGTEST_CONFIG_JSON");
  // Open once without following the final symlink; never echo resolved secrets.
  const fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let model;
  try {
    const stat = fs.fstatSync(fd);
    ensure(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0, "PRIVATE_CONFIG_FILE_REQUIRED");
    ensure(stat.size <= 1024 * 1024, "RESOLVED_CONFIG_TOO_LARGE");
    const bytes = Buffer.alloc(stat.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    ensure(count === stat.size, "RESOLVED_CONFIG_CHANGED_DURING_READ");
    model = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { fs.closeSync(fd); }
  const report = inspectCompose(model, { projectName: process.env.EBZ_REGTEST_PROJECT,
    configRoot: process.env.EBZ_REGTEST_CONFIG_ROOT });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.static_checks_passed ? 0 : 2;
} catch (error) { console.error(error.code || "REGTEST_CONFIG_REVIEW_FAILED"); process.exitCode = 1; }
