# tailscale

Joins the tailnet with
[tailscale/github-action](https://github.com/tailscale/github-action)
v4, then makes `/var/run/tailscale` root's only (0700).

tailscaled's LocalAPI socket is 0666, and the API doesn't check who
dials through it: any local user could `tailscale nc` to every node the
runner's tags may reach, as this node, and list the tailnet with
`tailscale status`. Only root needs it; use `sudo tailscale ...`.
tailscaled leaves an existing directory's mode alone when it restarts.
The socket is open from tailscaled's start until this action closes it,
and a connection made meanwhile survives that, so join before any other
user's processes start.

```yaml
- uses: cgwalters-forge/actions/tailscale@v1
  with:
    oauth-client-id: ${{ vars.TS_OAUTH_CLIENT_ID }}
    audience: ${{ vars.TS_AUDIENCE }}
    tags: tag:bootc-dev-sandbox
    hostname: cgwalters-devspace-${{ github.run_id }}
```

The job needs `permissions: id-token: write` for the OIDC login.

## Inputs

These are passed to tailscale/github-action as they are; empty means its
default.

| Input | Meaning |
| --- | --- |
| `oauth-client-id` | Client ID of the OIDC federated identity (the only login passed on; no OAuth secret or auth key) |
| `audience` | Audience of the OIDC federated identity |
| `tags` | Comma-separated tags for the node |
| `hostname` | Node name (default: from the runner name) |
| `args` | Additional arguments to `tailscale up`, e.g. `--accept-dns=false` |

## RHEL runners

tailscale/github-action installs into `/usr/local/bin`, which isn't in
sudo's `PATH` there, and needs `iptables`. Until that moves in here, run
this first:

```bash
sudo dnf install -y iptables
sudo ln -sfn /usr/local/bin/tailscale /usr/bin/tailscale
sudo ln -sfn /usr/local/bin/tailscaled /usr/bin/tailscaled
```
