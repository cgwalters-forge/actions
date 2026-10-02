// The pure logic of secure-host-setup: deciding what to change from what
// the host looks like. main.mjs gathers the facts and applies the changes.

// Directories others must not be able to read: the job user's home (on
// RHEL runners it is 0755 and holds the runner's world-readable
// .credentials) and the hosted compute agent's, whose world-readable
// .settings holds its token.
export const PRIVATE_DIRS = ["/opt/hca"];

// Sticky world-writable directories, meant to stay that way; the scan
// doesn't descend into them either, since what's inside belongs to
// whoever created it.
export const SHARED_TMP = ["/tmp", "/var/tmp"];
// Container storage: image layers are content, not host configuration.
export const CONTAINER_STORAGE = [
  "/var/lib/docker", "/var/lib/containerd", "/var/lib/containers",
  "/home/*/.local/share/containers", "/home/*/.local/share/docker",
];

// Whether a directory with MODE is one only root can enter: no
// permission bits at all (mode 0, like systemd's inaccessible
// directories). Nothing inside can be reached by other users, so the scan
// doesn't descend into them.
export function isInaccessibleDir(mode) {
  return (mode & 0o777) === 0;
}

// Whether PATH matches PATTERN, a find -path pattern where "*" matches
// within one path component (all CONTAINER_STORAGE needs).
export function matchesPathPattern(path, pattern) {
  const re = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${re}$`).test(path);
}

// Where world-writable paths lose write access for the job user too.
export const NO_GRANT = ["/etc"];

// Filesystem types scanned for world-writable paths. Pseudo filesystems
// (/proc, /sys, /run, /dev/shm) and overlays are left alone.
export const SCANNED_FSTYPES = new Set(["xfs", "ext4", "ext3", "ext2", "btrfs"]);

// Variables that must not be set for every session in /etc/environment.
// The runner images set XDG_RUNTIME_DIR to runner's own, and PAM
// hands it to every session, including other users' SSH logins and
// systemd user managers, which breaks their session bus and rootless
// podman: https://github.com/actions/runner-images/issues/14649
export const PER_USER_ENV_VARS = ["XDG_RUNTIME_DIR"];

const S_ISVTX = 0o1000;
const S_IWGRP = 0o020;
const S_IWOTH = 0o002;
const OTHER_BITS = 0o007;

// formatMode(0o755) -> "0755"
export function formatMode(mode) {
  return "0" + (mode & 0o7777).toString(8).padStart(3, "0");
}

// The mode a private directory gets (no group or other access), or null
// when others already have no access (Ubuntu's homes are 0750, which is
// fine). Bits are only ever cleared.
export function privateDirMode(mode) {
  return (mode & OTHER_BITS) === 0 ? null : mode & 0o7700;
}

// Whether PATH is ROOT or below it.
export function isUnder(path, root) {
  const r = root.length > 1 ? root.replace(/\/+$/, "") : root;
  return r === "/" || path === r || path.startsWith(r + "/");
}

// Parses the output of
//   find ... -printf '%y %m %U %G %p\0'
// into records { type, mode, uid, gid, path }. Paths may contain spaces
// and newlines; they end at the NUL.
export function parseFindRecords(output) {
  const records = [];
  for (const rec of output.split("\0")) {
    if (rec === "") continue;
    const m = /^([a-zA-Z]) ([0-7]+) (\d+) (\d+) (\/.*)$/s.exec(rec);
    if (!m) throw new Error(`unexpected find output: ${JSON.stringify(rec)}`);
    records.push({ type: m[1], mode: parseInt(m[2], 8), uid: Number(m[3]), gid: Number(m[4]), path: m[5] });
  }
  return records;
}

// What to do about a world-writable path found by the scan:
//   { path, from, to, grantRunner }
// or null if it isn't one to fix (sticky, or not world-writable).
// World write goes, and group write too when the group is root's, since
// only root is in it and sshd, ssh, sudo and logrotate refuse
// group-writable files and directories. Bits are only ever cleared.
// Paths outside NO_GRANT keep write access for the job user through an
// ACL (it has sudo anyway): runner images make tool directories
// world-writable so that setup actions can install into them without
// sudo, and tools also write files there (pipx's lock file). Not in
// NO_GRANT, since the ACL's mask shows as group write, which sshd, ssh,
// sudo and logrotate refuse in their configuration.
export function worldWritableFix(record) {
  const { type, mode, gid, path } = record;
  if ((mode & S_IWOTH) === 0 || (mode & S_ISVTX) !== 0) return null;
  if (type !== "f" && type !== "d") return null;
  let to = mode & ~S_IWOTH;
  if (gid === 0) to &= ~S_IWGRP;
  const grantRunner = !NO_GRANT.some((root) => isUnder(path, root));
  return { path, from: mode, to, grantRunner };
}

// Local filesystems to scan, from /proc/self/mounts: read-only ones can't
// be fixed, nor written by anyone. Mount points are octal-escaped there
// (a space is \040).
export function scanRoots(mounts) {
  const roots = new Set();
  for (const line of mounts.split("\n")) {
    const [, target, fstype, options = ""] = line.split(" ");
    if (!target || !SCANNED_FSTYPES.has(fstype) || options.split(",").includes("ro")) continue;
    roots.add(target.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  return [...roots].sort();
}

// Removes the lines setting one of NAMES from the text of
// /etc/environment (pam_env's KEY=VALUE format, where an "export " prefix
// is tolerated). Returns { text, removed }, removed being the dropped
// lines; text is unchanged if nothing matched.
export function dropEnvironmentVars(text, names) {
  const removed = [];
  const kept = text.split("\n").filter((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && names.includes(m[1])) {
      removed.push(line);
      return false;
    }
    return true;
  });
  return { text: removed.length ? kept.join("\n") : text, removed };
}

// Counts paths by their first two components ("/usr/share/doc/x" ->
// "/usr/share"), for a readable summary of a long list.
export function summarizeByPrefix(paths) {
  const counts = new Map();
  for (const p of paths) {
    const prefix = "/" + p.split("/").filter(Boolean).slice(0, 2).join("/");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
