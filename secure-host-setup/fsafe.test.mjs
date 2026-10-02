import assert from "node:assert/strict";
import {
  chmodSync, fchmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Moved, rewriteFile, withPath } from "./fsafe.mjs";

// A world: DIR/a/f (world-writable, the scan's find) and DIR/victim/f,
// which a chmod through a swapped parent would reach instead.
function world(t) {
  // Real, since withPath refuses paths reached through a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fsafe-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["a", "victim"]) mkdirSync(join(dir, d));
  for (const [f, m] of [["a/f", 0o666], ["victim/f", 0o600]]) {
    writeFileSync(join(dir, f), "");
    chmodSync(join(dir, f), m); // Not through umask.
  }
  return dir;
}
const mode = (p) => statSync(p).mode & 0o7777;
const strip = (fd, st) => (fchmodSync(fd, st.mode & ~0o002 & 0o7777), "changed");

test("the path itself is changed", (t) => {
  const dir = world(t);
  assert.equal(withPath(join(dir, "a", "f"), strip), "changed");
  assert.equal(mode(join(dir, "a", "f")), 0o664);
});

test("a path gone since the scan is skipped", (t) => {
  const dir = world(t);
  assert.equal(withPath(join(dir, "a", "gone"), strip), undefined);
});

test("a symlink swapped in is refused, and its target left alone", (t) => {
  const cases = [
    ["as the last component", (dir) => {
      unlinkSync(join(dir, "a", "f"));
      symlinkSync(join(dir, "victim", "f"), join(dir, "a", "f"));
    }],
    ["as a parent", (dir) => {
      renameSync(join(dir, "a"), join(dir, "a.real"));
      symlinkSync(join(dir, "victim"), join(dir, "a"));
    }],
  ];
  for (const [name, swap] of cases) {
    const dir = world(t);
    swap(dir);
    assert.throws(() => withPath(join(dir, "a", "f"), strip), Moved, name);
    assert.equal(mode(join(dir, "victim", "f")), 0o600, name);
  }
});

test("a parent swapped for a symlink and back while opening is caught", (t) => {
  const dir = world(t);
  renameSync(join(dir, "a"), join(dir, "a.real"));
  symlinkSync(join(dir, "victim"), join(dir, "a"));
  const swapBack = () => {
    unlinkSync(join(dir, "a"));
    renameSync(join(dir, "a.real"), join(dir, "a"));
  };
  assert.throws(() => withPath(join(dir, "a", "f"), strip, swapBack), /replaced while it was opened/);
  assert.equal(mode(join(dir, "victim", "f")), 0o600);
  assert.equal(mode(join(dir, "a", "f")), 0o666);
});

test("rewriteFile", async (t) => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "fsafe-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "environment");
    writeFileSync(path, "A=1\nB=2\n");
    chmodSync(path, 0o640);
    return { dir, path, ino: statSync(path).ino };
  };
  const dropB = (text) => text.replace("B=2\n", "");

  await t.test("replaced by a new file, with the mode and label set before the rename", () => {
    const { dir, path, ino } = setup();
    const labelled = [];
    assert.equal(rewriteFile(path, dropB, (tmp) => {
      // What gets renamed over PATH: complete, with its mode already.
      assert.equal(readFileSync(tmp, "utf8"), "A=1\n");
      assert.equal(mode(tmp), 0o640);
      assert.equal(readFileSync(path, "utf8"), "A=1\nB=2\n");
      labelled.push(tmp);
    }), true);
    assert.equal(labelled.length, 1);
    assert.equal(readFileSync(path, "utf8"), "A=1\n");
    assert.equal(mode(path), 0o640);
    assert.notEqual(statSync(path).ino, ino);
    assert.deepEqual(readdirSync(dir), ["environment"]);
  });

  await t.test("left alone when nothing changes", () => {
    const { path, ino } = setup();
    assert.equal(rewriteFile(path, () => null, () => assert.fail("labelled")), false);
    assert.equal(statSync(path).ino, ino);
  });

  await t.test("a failed label leaves the file as it was", () => {
    const { dir, path, ino } = setup();
    assert.throws(() => rewriteFile(path, dropB, () => {
      throw new Error("chcon failed");
    }), /chcon failed/);
    assert.equal(readFileSync(path, "utf8"), "A=1\nB=2\n");
    assert.equal(statSync(path).ino, ino);
    assert.deepEqual(readdirSync(dir), ["environment"]);
  });

  await t.test("missing file, or a symlink", () => {
    const { dir, path } = setup();
    assert.equal(rewriteFile(join(dir, "gone"), dropB), undefined);
    symlinkSync(path, join(dir, "link"));
    assert.throws(() => rewriteFile(join(dir, "link"), dropB), /is a symlink/);
    assert.equal(readFileSync(path, "utf8"), "A=1\nB=2\n");
  });
});
