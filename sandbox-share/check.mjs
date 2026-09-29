// CI's check of sandbox-share's result, after ci.yml shared a greeting, a
// file and a directory, and tried to share a symlink to /etc/shadow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DIR = "/etc/agent-share";
const read = (name) => fs.readFileSync(`${DIR}/${name}`, "utf8");

assert.equal(read("greeting"), `hello from ${process.env.GITHUB_JOB}`);
assert.equal(read("file"), "two\n");
assert.equal(read("dir/a"), "one\n");
assert.equal(process.env.SYMLINK, "failure");
assert.ok(!fs.existsSync(`${DIR}/shadow`), "the symlink was shared");
for (const [name, mode] of [[".", 0o755], ["greeting", 0o644], ["file", 0o644], ["dir", 0o755], ["dir/a", 0o644]]) {
  const st = fs.lstatSync(`${DIR}/${name}`);
  assert.equal(`${st.uid}:${st.gid} ${(st.mode & 0o7777).toString(8)}`, `0:0 ${mode.toString(8)}`, name);
}
// Read-only to other users: the job user can't change a share.
assert.throws(() => fs.appendFileSync(`${DIR}/greeting`, "x"));
assert.throws(() => fs.writeFileSync(`${DIR}/dir/new`, "x"));
execFileSync("sudo", ["-u", "nobody", "cat", `${DIR}/greeting`], { stdio: "inherit" });
console.log("sandbox-share: shares are root-owned and read-only");
