# Plan 0 — Production Cutover Runbook

Prereqs: DigitalOcean droplet (Docker), a domain, GitHub repo `sj132q/svyft-logistics`.

## 1. Neon
- [ ] Create a **new Neon project** for logistics, region nearest the droplet.
- [ ] Copy the **pooled** URL (`-pooler` host) → `DATABASE_URL` and the **direct** URL → `DIRECT_URL`.

## 2. Droplet pre-flight (coexistence)
- [ ] `ss -tlnp | grep -E ':80|:443'` — confirm `:80/:443` are free.
      - Free → proceed with the Caddy edge below.
      - Occupied → an edge already exists; instead of the `caddy` service, add a route for `logistics.<domain>` to the existing edge and drop the `caddy` service + `ports` from `docker-compose.prod.yml`.
- [ ] DO firewall: allow **80/443** publicly **and 22/SSH** (key-only auth). The CD pipeline SSHes into the droplet on every deploy from GitHub-hosted runners (dynamic IPs), so do **not** restrict to only 80/443 — that would lock CD out of every future deploy.

## 3. Droplet files
- [ ] `mkdir -p /opt/svyft-logistics && cd /opt/svyft-logistics`
- [ ] Copy `docker-compose.prod.yml` and `Caddyfile` here.
- [ ] Create `.env`:
```
DATABASE_URL=...neon pooled...
DIRECT_URL=...neon direct...
SITE_ADDRESS=logistics.<domain>
```

## 4. DNS
- [ ] A-record `logistics.<domain>` → droplet public IP. Wait for propagation.

## 5. GitHub secrets (repo → Settings → Secrets → Actions)
- [ ] `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY` (private key with droplet access)
- [ ] `GHCR_TOKEN` (a PAT with `read:packages`, used by the droplet to pull the image)

## 6. First deploy
- [ ] Push any commit to `main` (or re-run the Deploy workflow).
- [ ] Watch: `gh run watch`.
- [ ] Verify: `curl -s https://logistics.<domain>/api/health` → `{"status":"ok"}`
- [ ] Verify: `curl -s https://logistics.<domain>/api/health/db` → `{"status":"ok","db":"ok"}`
- [ ] Open `https://logistics.<domain>/` → two green `ok` badges.

## Rollback
- [ ] Re-run Deploy for a previous commit SHA, or on the droplet:
      `export IMAGE=ghcr.io/sj132q/svyft-logistics:<prev-sha> && docker compose -f docker-compose.prod.yml up -d`
