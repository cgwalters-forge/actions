// Checks a host after secure-host-setup ran twice, for CI: nothing left
// world-writable, /etc/environment clean, and the job user still able to
// write its tool directories while nobody else can. Run as the job user,
// with the second run's `changed` output in CHANGED_AGAIN and the
// directories to probe as arguments; it re-runs itself through sudo for
// the scan.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_STORAGE, PER_USER_ENV_VARS, SHARED_TMP,
  dropEnvironmentVars, formatMode, isInaccessibleDir, matchesPathPattern, scanRoots, worldWritableFix,
} from "./lib.mjs";

const SCAN_FLAG = "--scan";
const NOBODY = "nobody";
// World-writable paths listed before giving up.
const LIST_LIMIT = 20;

// Root half: walks the local filesystems like the action's find, but
// independently of it, and lists what is still world-writable.
function scan() {
  const skip = [...SHARED_TMP, ...CONTAINER_STORAGE];
  const left = [];
  let inaccessible = 0;
  let checked = 0;
  for (const root of scanRoots(readFileSync("/proc/self/mounts", "utf8"))) {
    const dev = lstatSync(root).dev;
    const dirs = [root];
    while (dirs.length && left.length < LIST_LIMIT) {
      const dir = dirs.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      for (const ent of entries) {
        if (!ent.isFile() && !ent.isDirectory()) continue;
        const path = dir === "/" ? `/${ent.name}` : `${dir}/${ent.name}`;
        let st;
        try {
          st = lstatSync(path);
        } catch (e) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        // Other filesystems are scanned from their own root, if at all.
        if (st.dev !== dev) continue;
        const type = st.isDirectory() ? "d" : "f";
        if (type === "d") {
          if (skip.some((p) => matchesPathPattern(path, p))) {
            console.log(`not scanned: ${path} (${formatMode(st.mode)})`);
            continue;
          }
          if (isInaccessibleDir(st.mode)) {
            console.log(`not scanned, only root can enter it: ${path}`);
            inaccessible++;
            continue;
          }
          dirs.push(path);
        }
        checked++;
        if (worldWritableFix({ type, mode: st.mode, gid: st.gid, path })) {
          left.push(`${path} (${formatMode(st.mode)})`);
        }
      }
    }
  }
  console.log(`checked ${checked} files and directories, skipped ${inaccessible} inaccessible directories`);
  if (left.length) throw new Error(`still world-writable:\n  ${left.join("\n  ")}`);
}

// Whether USER (through sudo) or the job user (USER null) can create a
// file in DIR.
function canWrite(dir, user) {
  const probe = `${dir}/.probe-${user ?? "job"}`;
  if (user) {
    const r = spawnSync("sudo", ["-n", "-u", user, "--", "touch", probe], { stdio: "ignore" });
    if (r.error) throw new Error(`cannot run sudo: ${r.error.message}`);
    if (r.status !== 0) return false;
  } else {
    try {
      writeFileSync(probe, "", { flag: "wx" });
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") return false;
      throw e;
    }
  }
  // Through sudo, since the job user may not be able to remove nobody's.
  spawnSync("sudo", ["-n", "rm", "-f", "--", probe]);
  return true;
}

function aclOf(dir, user) {
  const r = spawnSync("getfacl", ["-pc", dir], { encoding: "utf8" });
  return r.stdout?.split("\n").find((l) => l.startsWith(`user:${user}:`)) ?? "no ACL entry";
}

function main(toolDirs) {
  const failures = [];
  const check = (ok, msg) => ok || failures.push(msg);

  check(process.env.CHANGED_AGAIN === "false", `the second run changed something (changed=${process.env.CHANGED_AGAIN})`);

  const self = fileURLToPath(import.meta.url);
  const r = spawnSync("sudo", ["-n", "--", process.execPath, self, SCAN_FLAG], { stdio: "inherit" });
  check(r.status === 0, `the scan failed (${r.error?.message ?? r.status ?? r.signal})`);

  const { removed } = dropEnvironmentVars(readFileSync("/etc/environment", "utf8"), PER_USER_ENV_VARS);
  check(removed.length === 0, `/etc/environment still sets ${removed.join(", ")}`);

  check(spawnSync("sudo", ["-n", "true"]).status === 0, "the job user lost passwordless sudo");

  // Tool directories the job user writes without sudo: it still can,
  // through the ACL, and nobody else can.
  const user = userInfo().username;
  for (const dir of toolDirs) {
    check(canWrite(dir, null), `${user} can no longer write ${dir}`);
    check(!canWrite(dir, NOBODY), `${NOBODY} can write ${dir}`);
    console.log(`${dir}: ${formatMode(lstatSync(dir).mode)}, ${aclOf(dir, user)}`);
  }

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("secure-host-setup check passed");
}

try {
  if (process.argv[2] === SCAN_FLAG) {
    scan();
  } else {
    main(process.argv.slice(2));
  }
} catch (e) {
  console.log(`::error::${e.message.replaceAll("\n", "%0A")}`);
  process.exit(1);
}
