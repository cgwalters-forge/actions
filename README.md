# actions

GitHub Actions for cgwalters-forge and bootc-dev workflows, one per
directory, used as `cgwalters-forge/actions/<name>@v1`. Work items are
this repository's issues.

| Action | Status | Roadmap |
| --- | --- | --- |
| [tailscale](tailscale/README.md) | New; CI checks the socket is closed after a join that fails, no real join (no tailnet credentials here) | Replace devspace.yml's and agent.yml's tailscale/github-action steps; take over the RHEL prerequisites |

Licensed under either of [Apache-2.0](LICENSE-APACHE) or
[MIT](LICENSE-MIT), at your option.
