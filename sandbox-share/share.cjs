// The sandbox-share action's script, run as root (`sudo node`): publishes
// a file or a directory tree from the runner's side as a root-owned,
// world-readable copy under SHARE_DIR, so a job's sandboxed steps can
// read it but not change it. This is the one channel from the privileged
// phase to the sandbox that the sandbox can trust not to have been
// rewritten by an earlier sandboxed step.
//
// The settings come from the environment (action.yml maps the inputs),
// never from the script text, so expressions in them stay data:
//
//   SHARE_NAME     the name under SHARE_DIR ([A-Za-z0-9][A-Za-z0-9._-]*)
//   SHARE_PATH     a file or directory to copy (relative to the workspace)
//   SHARE_CONTENT  literal file content, when SHARE_PATH is empty
//
// Symlinks and special files in the source are refused: a checkout can
// contain a symlink to /etc/shadow, and following it here, as root, would
// publish the target to every user.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SHARE_DIR = "/etc/agent-share";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
  console.error(`share: ${message}`);
  process.exit(1);
}

// Copies SRC to DEST, as root:root with 0644 files and 0755 directories.
function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
    for (const entry of fs.readdirSync(src).sort()) {
      copyTree(path.join(src, entry), path.join(dest, entry));
    }
  } else if (st.isFile()) {
    // Not copyFileSync: libuv gives the copy the source's owner, and a
    // runner-owned file could be changed after the sandbox is entered.
    fs.writeFileSync(dest, fs.readFileSync(src), { mode: 0o644, flag: "wx" });
    fs.chmodSync(dest, 0o644);
  } else {
    fail(`${src} is neither a regular file nor a directory; refusing to share it`);
  }
}

if (process.getuid() !== 0) fail("must run as root");
const name = process.env.SHARE_NAME ?? "";
if (!NAME_RE.test(name)) fail(`invalid share name ${JSON.stringify(name)}`);
// A composite action passes every input, unset ones as "": an empty path
// means content, which may itself be empty.
const sharePath = process.env.SHARE_PATH ?? "";
const content = process.env.SHARE_CONTENT ?? "";
const hasContent = sharePath === "";
if (!hasContent && content !== "") fail("set path or content, not both");

fs.mkdirSync(SHARE_DIR, { recursive: true, mode: 0o755 });
fs.chmodSync(SHARE_DIR, 0o755);
const dest = path.join(SHARE_DIR, name);
// Build the copy next to its final name, so readers never see half of it.
const tmp = `${dest}.tmp-${process.pid}`;
fs.rmSync(tmp, { recursive: true, force: true });
try {
  if (hasContent) {
    fs.writeFileSync(tmp, content, { mode: 0o644, flag: "wx" });
    fs.chmodSync(tmp, 0o644);
  } else {
    // copyTree refuses symlinks below the path, and this those in it: a
    // symlinked directory `a` in a checkout would otherwise make `a/b`
    // any file on the machine.
    const src = path.resolve(fs.realpathSync(process.cwd()), sharePath);
    if (fs.realpathSync(src) !== src) fail(`${sharePath} goes through a symlink; refusing to share it`);
    copyTree(src, tmp);
  }
  // Owned by root however it was made.
  fs.chownSync(tmp, 0, 0);
  if (fs.lstatSync(tmp).isDirectory()) {
    for (const entry of fs.readdirSync(tmp, { recursive: true })) fs.lchownSync(path.join(tmp, entry), 0, 0);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`Shared ${hasContent ? "content" : sharePath} as ${dest} (root-owned, read-only to other users)`);
