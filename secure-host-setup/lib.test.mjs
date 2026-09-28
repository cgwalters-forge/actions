import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTAINER_STORAGE, dropEnvironmentVars, formatMode, isInaccessibleDir, isUnder, matchesPathPattern, parseFindRecords, privateDirMode, scanRoots, summarizeByPrefix, worldWritableFix,
} from "./lib.mjs";

test("formatMode", () => {
  for (const [mode, want] of [[0o755, "0755"], [0o40777, "0777"], [0o1777, "01777"], [0o4755, "04755"], [0o7, "0007"]]) {
    assert.equal(formatMode(mode), want);
  }
});

test("privateDirMode", () => {
  // Bits are only cleared: 0055 doesn't become 0700.
  for (const [mode, want] of [[0o40755, 0o700], [0o777, 0o700], [0o701, 0o700], [0o2757, 0o2700], [0o055, 0o000], [0o750, null], [0o700, null], [0o770, null]]) {
    assert.equal(privateDirMode(mode), want, formatMode(mode));
  }
});

test("isUnder", () => {
  for (const [path, root, want] of [
    ["/usr/local/bin", "/usr/local", true],
    ["/usr/local", "/usr/local", true],
    ["/usr/local", "/usr/local/", true],
    ["/usr/localx", "/usr/local", false],
    ["/usr", "/usr/local", false],
    ["/anything", "/", true],
  ]) {
    assert.equal(isUnder(path, root), want, `${path} under ${root}`);
  }
});

test("isInaccessibleDir", () => {
  for (const [mode, want] of [[0o40000, true], [0o41000, true], [0o2000, true], [0o700, false], [0o710, false], [0o001, false]]) {
    assert.equal(isInaccessibleDir(mode), want, formatMode(mode));
  }
});

test("matchesPathPattern", () => {
  for (const [path, pattern, want] of [
    ["/var/lib/docker", "/var/lib/docker", true],
    ["/var/lib/dockerx", "/var/lib/docker", false],
    ["/var/lib/docker/x", "/var/lib/docker", false],
    ["/home/runner/.local/share/containers", "/home/*/.local/share/containers", true],
    ["/home/a/b/.local/share/containers", "/home/*/.local/share/containers", false],
    ["/homeXrunner", "/home.runner", false],
  ]) {
    assert.equal(matchesPathPattern(path, pattern), want, `${path} ~ ${pattern}`);
  }
  assert.ok(CONTAINER_STORAGE.some((p) => matchesPathPattern("/home/runner-sandbox/.local/share/containers", p)));
});

test("parseFindRecords", () => {
  const out = "d 777 0 0 /opt\0f 666 1001 1001 /home/runner/a file\nwith newline\0";
  assert.deepEqual(parseFindRecords(out), [
    { type: "d", mode: 0o777, uid: 0, gid: 0, path: "/opt" },
    { type: "f", mode: 0o666, uid: 1001, gid: 1001, path: "/home/runner/a file\nwith newline" },
  ]);
  assert.deepEqual(parseFindRecords(""), []);
  assert.throws(() => parseFindRecords("garbage\0"), /unexpected find output/);
});

test("worldWritableFix", () => {
  const cases = [
    // Root's group loses write too; the job user keeps it through an ACL.
    [{ type: "d", mode: 0o777, gid: 0, path: "/usr/share/doc" }, { to: 0o755, grantRunner: true }],
    [{ type: "f", mode: 0o666, gid: 0, path: "/opt/pipx/.shared.lock" }, { to: 0o644, grantRunner: true }],
    [{ type: "f", mode: 0o777, gid: 0, path: "/usr/local/bin/tool" }, { to: 0o755, grantRunner: true }],
    // Another group keeps its write access.
    [{ type: "f", mode: 0o666, gid: 1001, path: "/opt/runner-cache/x" }, { to: 0o664, grantRunner: true }],
    // Special bits are kept.
    [{ type: "d", mode: 0o2777, gid: 0, path: "/srv/x" }, { to: 0o2755, grantRunner: true }],
    // Configuration in /etc gets no ACL, whose mask would show as group write.
    [{ type: "f", mode: 0o666, gid: 0, path: "/etc/ssh/x" }, { to: 0o644, grantRunner: false }],
    [{ type: "d", mode: 0o777, gid: 0, path: "/etc" }, { to: 0o755, grantRunner: false }],
    [{ type: "f", mode: 0o666, gid: 0, path: "/etcetera" }, { to: 0o644, grantRunner: true }],
    // Not ours to fix.
    [{ type: "d", mode: 0o1777, gid: 0, path: "/srv/tmp" }, null],
    [{ type: "d", mode: 0o775, gid: 0, path: "/srv/y" }, null],
    [{ type: "l", mode: 0o777, gid: 0, path: "/srv/link" }, null],
  ];
  for (const [rec, want] of cases) {
    const got = worldWritableFix({ uid: 0, ...rec });
    assert.deepEqual(got, want && { path: rec.path, from: rec.mode, ...want }, rec.path);
  }
});

test("scanRoots", () => {
  const mounts = [
    "/dev/sda4 / xfs rw,relatime 0 0",
    "proc /proc proc rw 0 0",
    "/dev/sda3 /boot xfs rw 0 0",
    "/dev/sda2 /boot/efi vfat rw 0 0",
    "/dev/sdb1 /mnt ext4 rw 0 0",
    "/dev/sdc1 /with\\040space btrfs rw 0 0",
    "/dev/sdd1 /readonly ext4 ro,relatime 0 0",
    "overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0",
    "/dev/sda4 / xfs rw,relatime 0 0",
    "",
  ].join("\n");
  assert.deepEqual(scanRoots(mounts), ["/", "/boot", "/mnt", "/with space"]);
});

test("dropEnvironmentVars", () => {
  const cases = [
    // The RHEL runner image's /etc/environment.
    ["XDG_RUNTIME_DIR=/run/user/1001\nImageOS=Linux\nImageVersion=1\n", "ImageOS=Linux\nImageVersion=1\n", ["XDG_RUNTIME_DIR=/run/user/1001"]],
    ["A=1\n  export XDG_RUNTIME_DIR=/run/user/1\nB=2", "A=1\nB=2", ["  export XDG_RUNTIME_DIR=/run/user/1"]],
    // Nothing to drop: the text is returned as it was.
    ["A=1\nXDG_RUNTIME_DIRX=1\n# XDG_RUNTIME_DIR=/x\n", "A=1\nXDG_RUNTIME_DIRX=1\n# XDG_RUNTIME_DIR=/x\n", []],
    ["", "", []],
  ];
  for (const [text, want, removed] of cases) {
    assert.deepEqual(dropEnvironmentVars(text, ["XDG_RUNTIME_DIR"]), { text: want, removed });
  }
});

test("summarizeByPrefix", () => {
  assert.deepEqual(summarizeByPrefix(["/usr/share/a/b", "/usr/share/c", "/opt/x/y", "/opt"]),
    [["/usr/share", 2], ["/opt", 1], ["/opt/x", 1]]);
});
