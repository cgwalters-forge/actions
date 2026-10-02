// secure-host-setup: close what a GitHub runner image leaves open to other
// local users; see README.md. Node's standard library only.
//
// The action runs as the job user; the fixes need root, so this re-runs
// itself through sudo with a config argument that the root half acts on.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, fchmodSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_STORAGE, PER_USER_ENV_VARS, PRIVATE_DIRS, SHARED_TMP,
  dropEnvironmentVars, formatMode, isInaccessibleDir, parseFindRecords, privateDirMode, scanRoots, summarizeByPrefix, worldWritableFix,
} from "./lib.mjs";
import { Moved, rewriteFile, withPath } from "./fsafe.mjs";

const ROOT_FLAG = "--as-root";
const ENVIRONMENT = "/etc/environment";
// Present when SELinux is enabled.
const SELINUX_ENFORCE = "/sys/fs/selinux/enforce";
// setfacl arguments per invocation.
const ACL_CHUNK = 1000;
// Changed paths listed individually in the log before only counts are shown.
const LIST_LIMIT = 50;

class Report {
  constructor() {
    this.changes = 0;
    this.errors = [];
  }
  change(msg) {
    this.changes++;
    console.log(`changed: ${msg}`);
  }
  error(msg) {
    this.errors.push(msg);
    console.log(`::error::${msg}`);
  }
}

function group(title, fn) {
  console.log(`::group::${title}`);
  try {
    return fn();
  } finally {
    console.log("::endgroup::");
  }
}

function makePrivate(config, report) {
  for (const name of [config.home, ...PRIVATE_DIRS]) {
    // Resolved first, since the home may be reached through a symlink
    // (/home -> /var/home).
    let dir;
    try {
      dir = realpathSync.native(name);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    withPath(dir, (fd, st) => {
      if (!st.isDirectory()) return;
      const mode = privateDirMode(st.mode);
      if (mode === null) {
        console.log(`${dir}: ${formatMode(st.mode)}, already private`);
        return;
      }
      fchmodSync(fd, mode);
      report.change(`${dir}: mode ${formatMode(st.mode)} -> ${formatMode(mode)} (private)`);
    });
  }
}

// Returns { found, inaccessible }: the world-writable (not sticky) files
// and directories below ROOTS, and the directories not descended into
// because nobody but root can enter them (see isInaccessibleDir).
function findWorldWritable(roots) {
  const prune = [...SHARED_TMP, ...CONTAINER_STORAGE].flatMap((p) => ["-path", p, "-o"]);
  const printf = ["-printf", "%y %m %U %G %p\\0"];
  // -ignore_readdir_race: a file removed between listing its directory
  // and reading it is no error, since runners are busy.
  const out = execFileSync("find", [...roots, "-xdev", "-ignore_readdir_race", "(", ...prune, "-false", ")", "-prune", "-o",
    "-type", "d", "!", "-perm", "/0777", ...printf, "-prune", "-o",
    "(", "-type", "f", "-o", "-type", "d", ")", "-perm", "-0002", "!", "-perm", "-1000", ...printf],
  { encoding: "utf8", maxBuffer: 1 << 30 });
  // With / and /home both scanned, /home is listed by both.
  const seen = new Set();
  const found = [];
  const inaccessible = [];
  for (const r of parseFindRecords(out)) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    (r.type === "d" && isInaccessibleDir(r.mode) ? inaccessible : found).push(r);
  }
  return { found, inaccessible };
}

// Gives the job user write access to PATHS through an ACL (and search or
// execute where anyone has it). Returns false if setfacl isn't installed.
function grantRunner(uid, paths, report) {
  for (let i = 0; i < paths.length; i += ACL_CHUNK) {
    // -P: not onto what a symlink swapped in since the chmod points to.
    const r = spawnSync("setfacl", ["-P", "-m", `u:${uid}:rwX`, "--", ...paths.slice(i, i + ACL_CHUNK)], { encoding: "utf8" });
    if (r.error?.code === "ENOENT") return false;
    if (r.status !== 0) report.error(`setfacl failed: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  return true;
}

function fixWorldWritable(config, report) {
  const roots = scanRoots(readFileSync("/proc/self/mounts", "utf8"));
  console.log(`Scanning ${roots.join(", ")} for world-writable files and directories (not sticky)`);
  const scan = findWorldWritable(roots);
  if (scan.inaccessible.length) {
    const more = scan.inaccessible.length > LIST_LIMIT ? `, and ${scan.inaccessible.length - LIST_LIMIT} more` : "";
    console.log(`Not scanned, since only root can enter them: ${scan.inaccessible.slice(0, LIST_LIMIT).map((r) => r.path).join(", ")}${more}`);
  }
  const found = scan.found.filter((r) => worldWritableFix(r));
  if (found.length === 0) {
    console.log("No world-writable files or directories");
    return;
  }
  const changed = [];
  for (const rec of found) {
    try {
      // The mode is the one the file has now, with bits only cleared.
      const f = withPath(rec.path, (fd, st) => {
        const type = st.isDirectory() ? "d" : st.isFile() ? "f" : "other";
        if (type !== rec.type) throw new Moved(`${rec.path} is no longer the ${rec.type === "d" ? "directory" : "file"} the scan found`);
        const fix = worldWritableFix({ type, mode: st.mode, gid: st.gid, path: rec.path });
        if (fix) fchmodSync(fd, fix.to);
        return fix;
      });
      if (f) changed.push(f);
    } catch (e) {
      report.error(`${rec.path}: ${e.message}`);
    }
  }
  report.changes += changed.length;
  // After the chmod, which would otherwise narrow the new ACL's mask to
  // the group bits.
  const grants = changed.filter((f) => f.grantRunner).map((f) => f.path);
  if (grants.length && !grantRunner(config.uid, grants, report)) {
    console.log(`::warning::setfacl is not installed: ${grants.length} paths are no longer writable by ${config.user} without sudo`);
  }
  console.log(`changed: removed world write access from ${changed.length} files and directories:`);
  for (const [prefix, n] of summarizeByPrefix(changed.map((f) => f.path))) {
    console.log(`  ${prefix}: ${n}`);
  }
  if (grants.length) {
    console.log(`  of which ${grants.length} stay writable by ${config.user} through an ACL`);
  }
  group(`World-writable paths fixed (${changed.length})`, () => {
    for (const f of changed.slice(0, LIST_LIMIT)) {
      console.log(`${f.path}: ${formatMode(f.from)} -> ${formatMode(f.to)}${f.grantRunner ? ` + ACL u:${config.user}:rwX` : ""}`);
    }
    if (changed.length > LIST_LIMIT) console.log(`... and ${changed.length - LIST_LIMIT} more`);
  });
}

// Gives the new copy of PATH, at TMP, PATH's SELinux label, if SELinux is
// enabled: the one PATH has now, so that replacing it changes nothing but
// its contents.
function labelLike(path) {
  if (!existsSync(SELINUX_ENFORCE)) return () => {};
  return (tmp) => execFileSync("chcon", [`--reference=${path}`, "--", tmp]);
}

function cleanEnvironment(report) {
  let removed = [];
  const replaced = rewriteFile(ENVIRONMENT, (text) => {
    const r = dropEnvironmentVars(text, PER_USER_ENV_VARS);
    removed = r.removed;
    return removed.length ? r.text : null;
  }, labelLike(ENVIRONMENT));
  if (replaced === false) console.log(`${ENVIRONMENT}: sets none of ${PER_USER_ENV_VARS.join(", ")}`);
  for (const line of removed) report.change(`${ENVIRONMENT}: removed ${line.trim()}`);
}

function runAsRoot(config) {
  const report = new Report();
  makePrivate(config, report);
  fixWorldWritable(config, report);
  cleanEnvironment(report);
  if (config.githubOutput) {
    appendFileSync(config.githubOutput, `changed=${report.changes > 0}\n`);
  }
  if (report.errors.length) {
    throw new Error(`${report.errors.length} errors; see above`);
  }
  console.log(report.changes ? `secure-host-setup: ${report.changes} changes` : "secure-host-setup: nothing to change");
}

// Job-user half: collect the config and re-run as root.
function main() {
  const user = userInfo();
  const config = {
    user: user.username,
    uid: user.uid,
    // The passwd entry, not $HOME, which the job may have changed.
    home: user.homedir,
    githubOutput: process.env.GITHUB_OUTPUT ?? "",
  };
  if (user.uid === 0) {
    runAsRoot(config);
    return;
  }
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync("sudo", ["-n", "--", process.execPath, self, ROOT_FLAG, JSON.stringify(config)], { stdio: "inherit" });
  if (r.error) throw new Error(`cannot run sudo: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`running as root through sudo failed (${r.status ?? r.signal})`);
}

try {
  if (process.argv[2] === ROOT_FLAG) {
    if (process.getuid() !== 0) throw new Error(`${ROOT_FLAG} must run as root`);
    runAsRoot(JSON.parse(process.argv[3]));
  } else {
    main();
  }
} catch (e) {
  console.log(`::error::secure-host-setup: ${e.message}`);
  process.exit(1);
}
