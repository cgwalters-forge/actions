// Changing a path found by a scan that took minutes, on a host where
// other users may still write the directories on the way.
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;

export class Moved extends Error {}

// withPath(PATH, FN): FN(fd, stat) on what is at PATH, or undefined if
// PATH is gone. Paths come from a scan that can take minutes, and other
// users may write the directories on the way, so what is opened is
// checked to be PATH itself: no symlink as its last component
// (O_NOFOLLOW), nor anywhere on the way (its real path is PATH), and the
// same file as PATH's after opening, so that a parent swapped for a
// symlink and back meanwhile is caught too. Throws Moved otherwise.
// AFTER_OPEN runs right after opening, for the tests to race it.
export function withPath(path, fn, afterOpen = () => {}) {
  let fd;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    if (e.code === "ELOOP") throw new Moved(`${path} is now a symlink`);
    throw e;
  }
  try {
    afterOpen();
    const st = fstatSync(fd);
    let now;
    try {
      if (realpathSync.native(path) !== path) throw new Moved(`${path} is now reached through a symlink`);
      now = lstatSync(path);
    } catch (e) {
      // Removed since it was opened: nothing left to fix.
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
    if (now.dev !== st.dev || now.ino !== st.ino) throw new Moved(`${path} was replaced while it was opened`);
    return fn(fd, st);
  } finally {
    closeSync(fd);
  }
}


// rewriteFile(PATH, EDIT, LABEL): replaces the regular file PATH with
// EDIT(its text), unless that returns null. The new text goes to a
// temporary file next to PATH that gets PATH's owner and mode, then
// LABEL(temporary path) for its SELinux label, all before it is renamed
// over PATH: readers see the old file or the new one, never a partial
// one or one with the wrong label. Returns true if PATH was replaced,
// false if EDIT left it alone, undefined if there is no PATH.
export function rewriteFile(path, edit, label = () => {}) {
  let fd;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    if (e.code === "ELOOP") throw new Error(`${path} is a symlink; not replacing it`);
    throw e;
  }
  let st, text;
  try {
    st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    text = edit(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  if (text === null) return false;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  // O_EXCL: never a file someone else put there.
  const tfd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(tfd, text);
      // Owner before mode, since chown clears setuid bits.
      fchownSync(tfd, st.uid, st.gid);
      fchmodSync(tfd, st.mode & 0o7777);
      fsyncSync(tfd);
    } finally {
      closeSync(tfd);
    }
    label(tmp);
    renameSync(tmp, path);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
  return true;
}
