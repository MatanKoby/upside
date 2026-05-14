# IB Client Portal Gateway — local capture rig

Builds a Docker image that runs IB's official Client Portal Gateway (Java) on
port 5000. Used by Batch 7 to capture raw IB Web API responses locally before
we adjust our schema/types to match reality.

## Build

```bash
docker build -t upside/clientportal.gw infra/clientportal.gw
```

First build is slow (downloads ~10MB JRE base + IB's zip). Subsequent builds
are cached.

## Run

```bash
docker run --rm -p 127.0.0.1:5000:5000 --name cpg upside/clientportal.gw
```

- `--rm` auto-removes the container when stopped (no state lingers).
- `-p 127.0.0.1:5000:5000` binds the gateway to **localhost only** on the host.
  Other machines on your LAN cannot reach it.

Leave the container running in one terminal while you work in another.

## Authenticate (browser)

1. Open a **fresh incognito tab** to `https://localhost:5000`.
2. Accept the self-signed cert warning (the cert IB ships expired in 2019;
   browsers warn loudly. It's a localhost-only cert — nothing leaves your
   machine. Click "Advanced" → "Proceed to localhost (unsafe)").
3. Log in with your **live IBKR Pro** credentials.
4. Approve the 2FA push on the IB Key app on your phone.
5. You should land on a "Client login succeeds" page.

> **Note on the IP allowlist patch:** IB's stock `conf.yaml` restricts incoming
> connections to a hard-coded list of CIDR ranges (192.*, 131.216.*, 127.0.0.1)
> that doesn't include the Docker bridge network. The Dockerfile patches
> `conf.yaml` at build time to accept all sources (`"*"`). Combined with binding
> the host port to `127.0.0.1` only, the gateway remains reachable only from
> this machine.

## Verify auth from terminal

```bash
curl -sk https://localhost:5000/v1/api/iserver/auth/status | jq .
```

Expect:
```json
{ "authenticated": true, "connected": true, "competing": false, ... }
```

If `authenticated: false`, re-login through the browser.

## Stop

```bash
docker stop cpg
```

The session ends and all state in the container is destroyed.

## Notes

- **Do not** set `IBEAM_ACCOUNT`, `IBEAM_PASSWORD`, or any other IB credential
  env var on `docker run`. They're not used by this image and would only create
  leak vectors. The browser-login flow is intentional.
- Sessions are short-lived. If the gateway hasn't been tickled in ~5 minutes
  the session auto-expires and you have to re-login.
- IB also forces a nightly logout at ~11:45 PM ET regardless.
