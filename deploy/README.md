# Hosted playground

This is how firediff.amsozzer.com runs `firediff playground --hosted`. Docker runs on a home server,
and a Cloudflare Tunnel makes it reachable from the internet. The router has no port forwarding and
the host has no web server. The `cloudflared` container dials out to Cloudflare, and Cloudflare
sends the site's traffic back down that connection.

```
visitor ──https──▶ Cloudflare ◀──tunnel (outbound)── cloudflared ──http──▶ firediff:8787 ──▶ emulator (127.0.0.1)
```

What `--hosted` adds to the local playground:

| Limit | Value | Flag to change it |
|---|---|---|
| Rules file size | 64 KB each (firediff.yml: 8 KB), else 413 | |
| Requests per comparison | 150 here (default 600), checked before running, else 413 | `--max-requests` |
| Time per comparison | 5 s, then 504 and a background emulator restart | `--timeout` (seconds) |
| Rate limit | 10 a minute and 100 a day per visitor (IPv6: per /64), else 429 | |
| Queue | one comparison at a time, 5 waiting, else 429 | |
| Emulator restart | every 500 comparisons, or above 1.5 GB | |

The container settings are in [compose.yml](compose.yml):
- **firediff** runs as a non-root user with a read-only filesystem and no Linux capabilities. It's
  limited to 2 GB of memory with no swap and 1.5 CPUs, and the emulator heap is capped at 1 GB.
- **cloudflared** is limited to 256 MB and 0.5 CPU.
- There are no host mounts and no published ports.
- The emulator listens on 127.0.0.1 inside the firediff container.
- Rate limits use the visitor address Cloudflare puts in `CF-Connecting-IP`.

The site also serves `robots.txt` (everything but `/api/`), `sitemap.xml` and `llms.txt`, and the
page carries a canonical URL, Open Graph tags and schema.org data, all built from `--public-url`.

Each comparison runs in two fresh projects (`fd-base-<hash>`, `fd-head-<hash>`), and their documents
are cleared afterwards. Nothing is stored. The app logs only request counts and timings.

## Cloudflare dashboard (once)

amsozzer.com's DNS is already on Cloudflare, so there's nothing to move. Your iCloud MX records
stay as they are.

1. Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com) and go to **Networks → Tunnels**.
   Newer dashboards may call this **Networks → Connectors**. Then **Create a tunnel**.
2. Choose **Cloudflared** and name it, e.g. `firediff-optiplex`. Save.
3. On the install page, pick **Docker**. Copy only the token, the long string after `--token`.
   Don't run the command shown. The token goes in `deploy/.env` on the server (next section). It's
   a secret: anyone with it can serve your hostname.
4. **Next**, then add a **Public hostname** (also called a published application route):
   - Subdomain `firediff`, domain `amsozzer.com`, path empty.
   - Service type **HTTP**, URL `firediff:8787`.
   - Save. Cloudflare creates the `firediff` CNAME (proxied) for you.

Optional extra layer: on the amsozzer.com zone, add a rate-limiting rule under **Security → WAF**
for `/api/diff` (the free plan includes one rule). firediff already limits on its own.

## Start

On the server, with Docker Engine and the compose plugin installed:

```sh
git clone https://github.com/Amsozzer1/firediff ~/firediff
cd ~/firediff/deploy
cp .env.example .env && chmod 600 .env
nano .env                         # TUNNEL_TOKEN=<token from step 3>
docker compose up -d --build
```

Check it:
- `docker compose ps` should show both containers up, with firediff "healthy" after about 30 s and
  no ports listed.
- `curl -s https://firediff.amsozzer.com/healthz` should return `{"ok":true,...}`.

Both containers have `restart: unless-stopped`, so they come back after a crash or a reboot, as long
as Docker starts on boot (`sudo systemctl enable docker`).

## Stop

```sh
cd ~/firediff/deploy
docker compose stop               # stop both; `docker compose start` brings them back
docker compose down               # stop and remove the containers (the image stays)
```

## Kill switch

- **At the server:** `docker compose stop cloudflared`. The site goes offline within seconds (visitors
  get a Cloudflare error page). firediff keeps running, so `docker compose start cloudflared` brings
  it straight back.
- **From anywhere:** in the Cloudflare dashboard, go to **Networks → Tunnels → firediff-optiplex**
  and delete the `firediff.amsozzer.com` public hostname. Add it again to switch the site back on.
- **If the token leaked:** delete the tunnel in the dashboard, which invalidates the token. Then
  create a new tunnel and put its token in `.env`.

## Logs

```sh
docker compose logs -f firediff       # comparisons (counts, times), timeouts, emulator restarts
docker compose logs -f cloudflared    # tunnel connections
docker compose logs firediff | grep restarting
docker stats                          # live CPU and memory per container
```

Logs rotate at 10 MB, keeping 3 files per container.

`/healthz` returns 503 in three cases:
- the emulator is down;
- the machine has under 10% of its memory available;
- the emulator is over 1.5 GB.

Otherwise it returns 200. Point any free uptime monitor at `https://firediff.amsozzer.com/healthz`
to get an email when that changes.

## Update

```sh
cd ~/firediff && git pull && cd deploy && docker compose up -d --build && docker image prune -f
```

To roll back, `git checkout <previous commit>`, then run `docker compose up -d --build`.

## Calibrating the request cap

The request cap has to finish within the 5 s limit. On the OptiPlex (i5-7600, 1.5 CPUs) a
comparison takes about 1 s plus 15–30 ms per request, depending on the rules:

| Requests | Time |
|---|---|
| 32 (the built-in example) | 1.5 s |
| 84 | 2.1–2.9 s |
| 144 | 3.6–4.5 s |
| 192 | 4.2–4.7 s |
| 288 | 6.4 s |
| 576 | 11.7 s |

More CPUs barely help, because requests go out one after another: with all 4 cores, 576 requests
still take 11.3 s. So compose.yml sets `--max-requests 150`, and the timeout only catches outliers.

To re-check after a hardware or firediff change, time [calibrate.json](calibrate.json) (576
requests; it should get a 413 with the cap at 150). Then time a file just under the cap. Each run
counts against the rate limit.

```sh
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  -H 'content-type: application/json' --data-binary @calibrate.json https://firediff.amsozzer.com/api/diff
```

To allow bigger files, raise both limits together, e.g. `"--max-requests", "400"` with
`"--timeout", "12"`. Then run `docker compose up -d`.
