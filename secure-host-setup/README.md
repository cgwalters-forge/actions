# secure-host-setup

Closes what a GitHub runner image leaves open to other local users, so a
job can then run untrusted code as a separate unprivileged user (such as
cgwalters-devspace-sandbox's `runner-sandbox`). The job user keeps its
own access, sudo included; the action only takes access away from
everyone else.

```yaml
- uses: cgwalters-forge/actions/secure-host-setup@v1
```

It needs passwordless sudo (or to run as root), and is idempotent: a
second run changes nothing and says so. It logs every change, and sets
the `changed` output to `true` or `false`.

## What it changes

- **Private directories.** The job user's home and `/opt/hca` (the
  hosted compute agent's) become 0700 when others can get into them.
  `/opt/hca` is 0755 on both RHEL and Ubuntu runners, and so is the
  home directory on RHEL, where the agent's token in `.settings` and
  the runner's `.credentials` are world-readable. Ubuntu's 0750 home is
  left alone.
- **World-writable paths.** Every file and directory on a local
  filesystem (xfs, ext4, btrfs) that anyone can write, other than sticky
  directories, loses world write access, and group write access too when
  its group is root's. The runner images' `configure-system.sh` runs
  `chmod -R 777` on `/usr/share` and `/opt`, and Ubuntu's also on
  `/usr/local/bin` and its tool caches, so any user could otherwise
  change what root runs, or add a polkit rule granting itself root.
  `/tmp`, `/var/tmp`, container storage, directories with mode 0 (which
  only root can enter) and read-only filesystems are not scanned. Files
  and directories that lose world write access stay writable by the job
  user through an ACL (it has sudo anyway), so `actions/setup-*`,
  `npm install -g`, pipx and `az extension add` keep working without
  sudo. With the ACL's mask they show group write in `ls -l`, which is
  why `/etc` gets no ACL: sshd, ssh, sudo and logrotate refuse
  group-writable configuration.
  Modes are read again when each path is changed, and only ever lose
  bits; a path that is replaced or reached through a new symlink by then
  fails the run instead. This is about 35,000 paths on a RHEL runner,
  done in seconds, and 800,000 on hosted Ubuntu, where it takes about
  4.5 minutes; a second run only scans (seconds).
- **`/etc/environment`.** Lines setting per-user variables
  (`XDG_RUNTIME_DIR`) are removed. The runner images set it to the
  runner's own (actions/runner-images#14649), and PAM hands that to every
  session, which breaks other users' session bus and rootless podman.
  The new file is written next to it with its owner, mode and SELinux
  label, then renamed over it.

## Not included

Creating the sandbox user, denying it sudo and polkit, and running steps
as it stay with the workflows that need them, and so does closing
tailscaled's LocalAPI socket, which belongs with joining the tailnet.
