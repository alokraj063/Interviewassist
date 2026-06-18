# Deploying apps to the J2W shared Dokploy host

This is a self-contained guide for putting a new app on the EC2 VM that currently hosts the **J2W Cognition Engine** (`cognition.j2wofferletter.com`). The VM doubles as a multi-app **Dokploy** host: each app runs as its own isolated docker-compose stack on its own subdomain, sharing only the host's reverse proxy (Traefik) and disk.

If you can package your app as a `docker-compose.yml`, you can deploy it here in ~30 minutes.

If you're working on **cognition itself**, the parts you most need are §"Cognition is App #1" and §"Cognition TLS cert deadline — 2026-06-11" near the end. Everything before that is for new-app deployers.

---

## 1. What's already on the server

| | |
|---|---|
| **Cloud / region** | AWS EC2, `ap-south-1` (Mumbai) |
| **Instance** | `m5.large` — 2 vCPU, 8 GB RAM |
| **OS** | Amazon Linux 2023 |
| **Disk** | 100 GB EBS |
| **Static public IP** | `13.127.19.121` (Elastic IP) |
| **Open inbound ports** | `22`, `80`, `443` only (AWS Security Group) |
| **Reverse proxy** | Traefik (managed by Dokploy), Let's Encrypt auto-TLS via HTTP-01 |
| **Container engine** | Docker 25.0 + Compose v2 + Swarm mode (Dokploy enables Swarm) |
| **Control plane** | Dokploy v0.29.4 on host port `3000` (SSH-tunnel only — not internet-reachable) |
| **App #1** | `cognition` — claims ~2 GB RAM, see §"Cognition is App #1" |

### How routing works

Traefik attaches to a Docker overlay network called `dokploy-network` (Swarm scope, `attachable: true` so standalone containers can join it). Any container that joins that network and carries the right Traefik labels gets discovered automatically — no edits to a central config file. TLS certs are issued on-demand via Let's Encrypt's HTTP-01 challenge as soon as a new hostname starts receiving traffic.

Traefik's static config lives at `/etc/dokploy/traefik/traefik.yml`. Dynamic config (per-app routers, middlewares, file-provider certs) lives at `/etc/dokploy/traefik/dynamic/` — Traefik watches that directory and reloads on change.

### What's left for you

After Dokploy + Traefik + Cognition, the VM has roughly **~5 GB RAM and ~60 GB disk free**. A typical Node-or-similar service with its own Postgres + Redis claims ~1.5–2 GB RAM, so you can expect ~2 more small apps to coexist comfortably; beyond that, the host owner should bump the VM to `m5.xlarge` (4 vCPU / 16 GB) — see §"Capacity budget" below.

---

## 2. Constraints on what you can deploy

- **Must be docker-compose-able.** No raw VMs, no host-installed daemons. If your stack is, say, Node + Postgres + Redis, declare all three as services in your compose file.
- **No shared services across apps.** Don't try to talk to cognition's Postgres or any other app's Redis. Bring your own. Apps are intentionally fully isolated; there's no shared "platform DB."
- **Pick a unique `COMPOSE_PROJECT_NAME`.** Volume names are keyed `<project>_<volname>`, so collisions silently corrupt data. **Names already taken: `app`** (cognition). Use something distinct like `myapp-prod`.
- **Domains.** Bring any subdomain you control. The A-record target is `13.127.19.121`.
  - **Caveat for `*.j2wofferletter.com` subdomains:** the DNS CAA record on `j2wofferletter.com` is currently `0 issue "amazon.com"` — it **forbids Let's Encrypt issuance**. So Traefik cannot get certs for new subdomains under `j2wofferletter.com` until that CAA is updated to also allow `letsencrypt.org`. Subdomains of any other apex domain are unaffected. (Background: this is also the root cause of cognition's manual cert situation — see §"Cognition TLS cert deadline" below.)
- **No persistent state outside named volumes.** Anything written to the container filesystem is lost on redeploy.
- **Don't replicate the App #1 / CLI-managed pattern** that cognition uses (see end of doc). Deploy normally through the Dokploy UI; you'll get correctly named volumes and a UI handle on day one.

---

## 3. Step-by-step deploy procedure

### Step 1 — DNS

Add an A-record at your registrar:

```
your-app.example.com.   A   13.127.19.121
```

Wait for it to propagate before deploying — Let's Encrypt's HTTP-01 challenge will fail otherwise. Verify with:

```bash
dig +short your-app.example.com
# expect: 13.127.19.121
```

**If your subdomain is under `j2wofferletter.com`**, also check CAA:

```bash
dig +short CAA j2wofferletter.com @8.8.8.8
# Until this includes `0 issue "letsencrypt.org"`, Traefik can't issue.
# If you see only `0 issue "amazon.com"`, talk to the DNS owner before deploying.
```

### Step 2 — Write your `docker-compose.yml`

Use the templates in §4 below as a starting point. The load-bearing pieces are:

1. `name: ${COMPOSE_PROJECT_NAME:?...}` at the top.
2. The `dokploy-network` declared as `external: true`.
3. Traefik labels on every service that should be reachable over HTTPS.
4. Required env vars guarded with `:?required` so missing config fails loudly at deploy time rather than silently producing broken builds.

Anything else — what services you have, what ports they listen on, build args, healthchecks — is up to you.

### Step 3 — Get SSH access to the VM

You need this for two things: opening a tunnel to the Dokploy UI, and running terminal commands like `docker exec ... pnpm migrate`.

The cognition team holds the only SSH key (`ssh-key/j2w-cognition.pem` in the cognition repo, gitignored). Ask them for either:
- A copy of the PEM, or
- A new user account on the box with your team's SSH key authorized.

```bash
# Connecting (using the cognition team's key as the canonical example)
ssh -i j2w-cognition.pem ec2-user@13.127.19.121

# Tunnel to Dokploy UI (keep this terminal open while you're working)
ssh -i j2w-cognition.pem -L 3000:localhost:3000 ec2-user@13.127.19.121
```

With the tunnel up, `http://localhost:3000` on your laptop hits the Dokploy UI on the VM. The first time anyone visits, Dokploy prompts to create the admin account; the cognition team set that up — get the credentials from them.

> **Port 3000 hardening note:** Dokploy binds port 3000 to `0.0.0.0` on the host. It's currently shielded by the AWS Security Group (only 22/80/443 inbound), but if the SG is ever loosened, the UI becomes exposed. Worth tightening at the host level (bind to localhost, or add an iptables rule) eventually.

### Step 4 — Create the app in Dokploy

1. **Projects → Create Project** — name it whatever you like (e.g. `myapp`). A "project" in Dokploy is just a folder; you can put many services under one.
2. **Add Service → Compose**.
3. **Provider:**
   - **Git** if your compose is in a public/SSH-accessible repo. Set the compose path (e.g. `deploy/docker-compose.yml`).
   - **Raw** if you'd rather paste it directly.
4. **Environment** tab: paste your env file (see §5 for required keys).
5. **Deploy.** First build pulls base images and can take 5–10 minutes depending on what's in your Dockerfile.

### Step 5 — Run any post-boot commands

Migrations, seeds, admin bootstraps — run them via Dokploy's **Terminal** tab on your service:

```bash
docker exec myapp-prod-api-1 pnpm db:migrate
docker exec myapp-prod-api-1 ./manage.py createsuperuser
# etc.
```

Container names follow `<COMPOSE_PROJECT_NAME>-<service>-1` — e.g. `myapp-prod-api-1` if your compose has `name: myapp-prod` and a service called `api`.

---

## 4. `docker-compose.yml` template

A stack-agnostic skeleton. Drop in your own services, keep the network and label patterns. Two examples follow: a plain HTTP service, and a more complex one with Postgres + Redis.

### Minimal: one HTTP service

```yaml
name: ${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}

networks:
  dokploy-network:
    external: true
  default: {}

services:
  web:
    build:
      context: .
    restart: unless-stopped
    networks: [default, dokploy-network]
    environment:
      DATABASE_URL: ${DATABASE_URL:?required}
    labels:
      - traefik.enable=true
      - traefik.docker.network=dokploy-network
      - traefik.http.routers.${APP_SLUG:?APP_SLUG is required}-web.rule=Host(`${APP_HOST:?APP_HOST is required}`)
      - traefik.http.routers.${APP_SLUG}-web.entrypoints=websecure
      - traefik.http.routers.${APP_SLUG}-web.tls.certresolver=letsencrypt
      - traefik.http.services.${APP_SLUG}-web.loadbalancer.server.port=3000
```

Replace the `loadbalancer.server.port` with whatever port your app listens on inside the container.

### With Postgres and Redis (fully isolated stack)

```yaml
name: ${COMPOSE_PROJECT_NAME:?required}

networks:
  dokploy-network:
    external: true
  default: {}

services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: ${POSTGRES_DB:-app}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-app}"]
      interval: 5s
      retries: 20
    # Drop shared_buffers to 256MB unless you really need it — host RAM
    # is shared across apps and tight on m5.large (8 GB).
    command: postgres -c shared_buffers=256MB

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  api:
    build: .
    restart: unless-stopped
    networks: [default, dokploy-network]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-app}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-app}
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    labels:
      - traefik.enable=true
      - traefik.docker.network=dokploy-network
      - traefik.http.routers.${APP_SLUG:?required}-api.rule=Host(`${APP_HOST:?required}`)
      - traefik.http.routers.${APP_SLUG}-api.entrypoints=websecure
      - traefik.http.routers.${APP_SLUG}-api.tls.certresolver=letsencrypt
      - traefik.http.services.${APP_SLUG}-api.loadbalancer.server.port=8080

volumes:
  pgdata:
  redisdata:
```

### Add-on: WebSocket route

If your app has a `/ws/*` path that needs a separate router (typical when WS and HTTP share a hostname), add these labels alongside the HTTP ones on the same service:

```yaml
      - traefik.http.routers.${APP_SLUG}-ws.rule=Host(`${APP_HOST}`) && PathPrefix(`/ws`)
      - traefik.http.routers.${APP_SLUG}-ws.entrypoints=websecure
      - traefik.http.routers.${APP_SLUG}-ws.tls.certresolver=letsencrypt
      - traefik.http.routers.${APP_SLUG}-ws.priority=20
      - traefik.http.routers.${APP_SLUG}-ws.service=${APP_SLUG}-api
```

Traefik forwards WebSocket upgrades transparently over HTTP/1.1. **Gotcha when testing with curl:** modern curl negotiates HTTP/2 via ALPN, and WS upgrade headers don't work the standard way over HTTP/2. Force HTTP/1.1 when testing (`curl --http1.1 …`). Browsers do the right thing automatically.

### Add-on: Server-Sent Events (SSE) buffering disable

Traefik buffers responses by default, which breaks SSE heartbeats. If your app uses SSE, attach a buffering middleware to its router:

```yaml
      - traefik.http.routers.${APP_SLUG}-api.middlewares=${APP_SLUG}-sse@docker
      - traefik.http.middlewares.${APP_SLUG}-sse.buffering.maxResponseBodyBytes=0
      - traefik.http.middlewares.${APP_SLUG}-sse.buffering.memResponseBodyBytes=0
```

Belt-and-braces: also have your route emit `X-Accel-Buffering: no` in the response headers.

---

## 5. Required environment variables

Every app needs these three:

```
COMPOSE_PROJECT_NAME=myapp-prod
APP_SLUG=myapp                      # used in Traefik label keys; [a-z0-9-]
APP_HOST=your-app.example.com       # the public hostname
```

`APP_SLUG` and `COMPOSE_PROJECT_NAME` need to be different from anything already deployed. **Currently taken: `cognition` (slug), `app` (project name).**

Plus whatever your own app requires (`DATABASE_URL`, `JWT_SECRET`, third-party API keys, etc.). Best practice: guard everything critical with `:?required` in the compose so a misconfigured deploy fails at boot rather than running silently in a broken state.

---

## 6. Verification checklist

After your first deploy, run through this list. Each step proves a specific layer is wired correctly.

```bash
# DNS resolves
dig +short your-app.example.com           # expect 13.127.19.121

# HTTPS works and the cert is real
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://your-app.example.com/
echo | openssl s_client -connect your-app.example.com:443 \
       -servername your-app.example.com 2>/dev/null \
       | openssl x509 -noout -issuer -dates
# expect issuer: Let's Encrypt; notAfter ~90 days out

# Your app's health endpoint returns 200
curl -fsS https://your-app.example.com/health
```

From the VM (via SSH):

```bash
# Containers are healthy
sudo docker ps --filter "name=myapp-prod" \
     --format 'table {{.Names}}\t{{.Status}}'

# Traefik discovered all your routers
sudo docker exec dokploy-traefik wget -qO- http://localhost:8080/api/http/routers \
  | python3 -c 'import json,sys;[print(r["name"],r.get("status")) for r in json.load(sys.stdin) if "myapp" in r["name"]]'
```

If something looks off, the first place to look is **Dokploy UI → your-service → Logs**, then `sudo docker logs <container>` on the VM.

---

## 7. Common pitfalls

These all surfaced during the cognition migration or the sibling GCP server's lifetime. Save yourself the rediscovery.

- **Forgetting `dokploy-network` is external.** If you write `networks: { dokploy-network: {} }` (no `external: true`), Compose creates a *new* network with that name, Traefik never sees your containers, and you get bewildering 404s through the proxy.
- **Postgres `shared_buffers` greedy.** Defaults to `1GB` in many templates. With three apps that's 3 GB of RAM gone before any actual work happens. Use `256MB` unless you've measured a need. (Cognition's Postgres is at `512MB`, which is already aggressive for this host.)
- **DNS not propagated before deploy.** Let's Encrypt's HTTP-01 challenge runs immediately on first request. If DNS still resolves to the old IP (or NXDOMAIN), the cert fails to issue, and Dokploy doesn't auto-retry until the next redeploy. Always verify `dig` before triggering the deploy.
- **CAA on `j2wofferletter.com` blocks Let's Encrypt.** If your hostname is `*.j2wofferletter.com`, ACME issuance will return `urn:ietf:params:acme:error:caa` until the CAA record is amended to allow `letsencrypt.org`. Symptom: Traefik logs `Unable to obtain ACME certificate for domains`, browser sees Traefik's default self-signed cert.
- **`COMPOSE_PROJECT_NAME` collision.** Volumes are `<project>_<volname>`. Reusing `app` would attach your postgres to cognition's data — bad. Always pick a fresh name.
- **`:3000` is firewalled.** It's only reachable through the SSH tunnel; don't try `http://13.127.19.121:3000`. If you ever need it exposed, ask the host owner — should be a per-IP allowlist firewall rule, not opened broadly.
- **WebSocket routes returning 404 to your test curl.** Two possible causes: (a) curl negotiated HTTP/2 — re-test with `curl --http1.1`; (b) you're hitting Fastify/Express's plain-HTTP 404 for a WS-only route — test with a real WS client (`wscat`).
- **SSE batched instead of streamed.** Buffering middleware label didn't expand because `APP_SLUG` was unset, so the middleware name came out as `-sse@docker` (orphan). Always set `APP_SLUG`.
- **Build args vs runtime env.** If you're building a Vite/Next/CRA bundle, the public URL is *baked in at build time*, not read at runtime. Pass it as a build `arg`, not an `environment` var.
- **Dokploy ACME email is the placeholder `test@localhost.com`.** Let's Encrypt accepts it but won't send expiry-warning emails. Update via Dokploy UI → Settings → Server. Affects all apps issued via Traefik on this host.

---

## 8. Capacity budget on this server

Approximate usage today:

| Component | RAM |
|---|---|
| Dokploy + Traefik + dockerd + system | ~750 MB |
| Cognition (Postgres + backend + Caddy) | ~2 GB |
| **Free for new apps** | **~5 GB** (of 8 GB total) |

Disk: ~60 GB free of 100 GB. Postgres dataset growth is the dominant factor; budget ~5–10 GB per app's pgdata over time.

Check before deploying a new app (or earlier if `free -m` shows pressure):

```bash
ssh -i j2w-cognition.pem ec2-user@13.127.19.121 'free -m && sudo docker stats --no-stream'
```

When the host gets uncomfortably full, the upgrade path is:

```bash
aws ec2 stop-instances --instance-ids <id>
aws ec2 modify-instance-attribute --instance-id <id> --instance-type m5.xlarge
aws ec2 start-instances --instance-ids <id>
```

~5 min downtime; Elastic IP stays attached. EBS disk grows separately via `aws ec2 modify-volume`.

---

## 9. Operational ownership

| Concern | Owner |
|---|---|
| VM uptime, OS patches, Docker upgrades | Cognition team (j2w) |
| Dokploy version + Traefik static config | Cognition team |
| TLS cert issuance/renewal | Automatic (Traefik + Let's Encrypt) — except cognition itself, see below |
| DNS for your subdomain | Your team |
| Your app's compose, Dockerfiles, env values | Your team |
| Your app's secrets (DB password, API keys, KEKs) | Your team |
| Your app's data backups (`pg_dump` to S3, etc.) | Your team |
| Whole-VM EBS snapshots | Cognition team (recommend weekly) |
| Resource policing (your app eats 8 GB RAM) | Cognition team enforces; your team fixes |

If your app needs something host-wide (e.g. a longer Traefik idle timeout, a new firewall rule, more disk), file the ask with the cognition team — those are not per-app knobs.

---

## 10. Cognition is "App #1" (CLI-managed, hands-off)

Cognition is the legacy first app on this VM and runs **outside the Dokploy UI**:

- It lives at `/home/ec2-user/app/` on the host.
- Its `docker-compose.prod.yml` is CLI-managed: deploys via `tar` + `scp` + `docker compose -f docker-compose.prod.yml up -d --build` from the cognition repo, NOT through the Dokploy UI.
- It still joins `dokploy-network` and carries Traefik labels for the `cognition` router — Traefik routes `Host(cognition.j2wofferletter.com)` to it like any other app.
- The internal stack: Caddy (HTTP-only on port 80, serves SPA + reverse-proxies to backend), Hono backend (port 3001 internal), Postgres with pgvector. Caddy is no longer the edge — it just does internal routing + serves static files + sets security headers.
- Volume names: `app_pg_data`, `app_kb_uploads`, `app_caddy_data`, `app_caddy_config` (the `app_` prefix is from the compose project name, which is `app`).

**The reason cognition is the exception:** re-importing it through the Dokploy UI would change `COMPOSE_PROJECT_NAME` and orphan the existing named volumes. **Don't replicate this pattern for new apps** — just deploy normally through the Dokploy UI; you'll get correctly named volumes and a UI handle on day one.

**Rollback (cognition only) — if Dokploy/Traefik ever needs to come out of the path:**

```bash
ssh -i ssh-key/j2w-cognition.pem ec2-user@13.127.19.121
cd /home/ec2-user/app
sudo docker compose -f docker-compose.prod.yml down caddy
# Revert Caddyfile + docker-compose.prod.yml from git (the two files that changed during the migration)
git checkout <pre-migration-commit> -- Caddyfile docker-compose.prod.yml
sudo docker stop dokploy-traefik   # free host 80/443
sudo docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
```

Dokploy itself does not have to be uninstalled — stopping its Traefik is enough to give host ports back to cognition's Caddy. Data volumes (`app_pg_data`, `app_kb_uploads`) are never touched in the rollback.

---

## 11. ⚠️ Cognition TLS cert deadline — 2026-06-11

**Hard deadline: 2026-06-11.** Cognition's TLS cert is currently a **static file** served by Traefik (not auto-renewed). It expires 2026-06-11. If the CAA fix below isn't done before then, cognition goes down with an expired cert.

### Why

The DNS CAA record on `j2wofferletter.com` is `0 issue "amazon.com"` — it forbids Let's Encrypt from issuing certs for any `*.j2wofferletter.com` subdomain. When we set up Dokploy's Traefik to front cognition, Traefik's ACME issuance got rejected with `urn:ietf:params:acme:error:caa`. As a workaround, we extracted the existing Caddy-issued cert (issued 2026-03-13, valid until 2026-06-11) from the `app_caddy_data` volume and registered it as a static cert in Traefik via the file provider.

### Files on the host

- `/etc/dokploy/traefik/dynamic/certificates/cognition.j2wofferletter.com.crt` — full chain PEM (mode 644, root)
- `/etc/dokploy/traefik/dynamic/certificates/cognition.j2wofferletter.com.key` — private key PEM (mode 600, root)
- `/etc/dokploy/traefik/dynamic/cognition-tls.yml` — Traefik dynamic config that registers them

The `traefik.http.routers.cognition.tls=true` label on the `caddy` service in `docker-compose.prod.yml` tells Traefik to use TLS without specifying a resolver — so Traefik picks the matching SNI cert from the file provider.

### Post-CAA-fix steps (do this once DNS is updated)

1. **Update DNS on `j2wofferletter.com`** to add `0 issue "letsencrypt.org"` alongside the existing `0 issue "amazon.com"`. Verify with `dig +short CAA j2wofferletter.com @8.8.8.8`.

2. **Switch cognition router back to ACME auto-issuance.** In `docker-compose.prod.yml`, on the `caddy` service, swap:
   ```yaml
   - traefik.http.routers.cognition.tls=true
   ```
   for:
   ```yaml
   - traefik.http.routers.cognition.tls.certresolver=letsencrypt
   ```
   Ship the file (`scp docker-compose.prod.yml ec2-user@13.127.19.121:/home/ec2-user/app/`) and recreate caddy:
   ```bash
   ssh -i ssh-key/j2w-cognition.pem ec2-user@13.127.19.121 'cd /home/ec2-user/app && sudo docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate caddy'
   ```

3. **Verify fresh issuance** — within ~30 seconds of recreating caddy, Traefik will ACME-request and issue a new cert via Let's Encrypt. Confirm:
   ```bash
   echo | openssl s_client -connect cognition.j2wofferletter.com:443 -servername cognition.j2wofferletter.com 2>/dev/null \
     | openssl x509 -noout -dates
   # notBefore should be ~today; notAfter ~90 days out
   ```
   Also check Traefik logs for errors:
   ```bash
   ssh -i ssh-key/j2w-cognition.pem ec2-user@13.127.19.121 'sudo docker logs --since 5m dokploy-traefik 2>&1 | grep -iE "cognition|acme|error" | tail -20'
   ```

4. **Clean up the static cert config** (optional but tidy — do this only after step 3 confirms a freshly-issued cert):
   ```bash
   ssh -i ssh-key/j2w-cognition.pem ec2-user@13.127.19.121 'sudo rm /etc/dokploy/traefik/dynamic/cognition-tls.yml /etc/dokploy/traefik/dynamic/certificates/cognition.j2wofferletter.com.{crt,key}'
   ```

---

## FAQ

**Q: Can I use Dokploy's built-in "Database" service type instead of declaring postgres in my compose?**

You can, but I'd recommend against it. The whole-stack-in-one-compose pattern is more portable (you can pick it up and run it locally or on another host), and it keeps the boundary between apps cleaner.

**Q: My app uses a non-HTTP protocol (raw TCP, gRPC, etc.). Will Traefik route it?**

Plain HTTP, HTTPS, WebSocket, and HTTP/2 (gRPC) all work. For raw TCP or UDP you'd need a TCP entryPoint added to Traefik's static config — talk to the cognition team.

**Q: How do I redeploy after a code change?**

If you used a Git source: push to the branch, then in the Dokploy UI click **Deployments → Redeploy**. If you pasted Raw compose: edit the service's compose, then redeploy. Your volumes survive redeploys; your container filesystem doesn't.

**Q: What happens to my app if the VM reboots?**

Docker daemon comes up automatically; containers with `restart: unless-stopped` (which the templates above use) come back. There's a brief blip where Traefik races against your services to start, but the routers reattach within seconds.

**Q: Can I see other apps' data or affect them?**

No. Each app is its own docker-compose project with its own network namespace and volumes. The only shared resources are the VM's CPU, RAM, and disk, plus Traefik (which is request-routed by hostname).

**Q: Do I need a copy of the cognition SSH PEM?**

For UI-only access via the SSH tunnel, eventually no — the cognition team can add your SSH public key to `~ec2-user/.ssh/authorized_keys` on the box. Ask them.
