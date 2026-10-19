# Hosted playground

This is how to run `firediff playground --hosted` on a public server. It runs on one small VM with
Docker and the real Java emulator, with Caddy in front for TLS.

What `--hosted` adds to the local playground:

| Limit | Value | Flag to change it |
|---|---|---|
| Rules file size | 64 KB each (firediff.yml: 8 KB) | |
| Requests per comparison | 600, checked before running | `--max-requests` |
| Time per comparison | 5 s, then 504 and a background emulator restart | `--timeout` (seconds) |
| Rate limit | 10 a minute and 100 a day per address (IPv6: per /64) | |
| Queue | one comparison at a time, 5 waiting, then 429 | |
| Emulator restart | every 500 comparisons, or above 1.5 GB | |

Other behaviour:

- Each comparison runs in two fresh `fd-base-<hash>` and `fd-head-<hash>` projects with a random id,
  and its documents are cleared afterwards.
- The emulator listens on 127.0.0.1 inside the container only.
- Nothing is stored. The app logs only request counts and timings, and Caddy keeps no access log.

## 1. Server (Hetzner Cloud console)

1. Create a project, then a server:
   - **Type:** CX23 (2 vCPU, 4 GB; shared, x86).
   - **Location:** any EU one.
   - **Image:** Ubuntu 24.04.
   - **Networking:** public IPv4 and IPv6.
   - **SSH key:** yours. With a key, Hetzner turns off root password login.
2. Add a firewall under **Firewalls → Create firewall**, and apply it to the server. Inbound rules:
   - TCP 22, from your IP only
   - TCP 80 and TCP 443, from any
   - UDP 443, from any (HTTP/3)
3. DNS: point the subdomain's `A` record at the server's IPv4, and its `AAAA` record at its IPv6.

Cost: about €5.49/month for CX23, plus about €0.50–0.60/month for the IPv4 address. Check
Hetzner's price list when ordering; prices changed in 2026.

## 2. Docker

SSH in as root (`ssh root@<server-ip>`), then install Docker Engine from Docker's apt repository:

```sh
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Ubuntu 24.04 installs security updates automatically. To check that it's on, run
`systemctl status unattended-upgrades`.

## 3. Deploy

```sh
git clone https://github.com/Amsozzer1/firediff /opt/firediff
cd /opt/firediff/deploy
cp .env.example .env
nano .env                      # PLAYGROUND_DOMAIN=<your subdomain>
docker compose up -d --build
```

That starts two containers, both with `restart: unless-stopped`, so they come back after a crash
or a reboot:

- **firediff** runs from the [Dockerfile](../Dockerfile): Node 22, Java 21, the emulator jar
  (checked against its sha256 at build time), and the committed `dist/cli` bundle.
  - It runs as a non-root user with a read-only filesystem and no Linux capabilities.
  - Memory is capped at 3 GB, and the emulator heap at 1 GB.
  - Its port is reachable only from Caddy.
- **caddy** gets a Let's Encrypt certificate for the domain on first start. This needs DNS to point
  at the server already.

Check it:

```sh
docker compose ps                         # both up; firediff "healthy" after ~30 s
curl -s https://<your subdomain>/healthz  # {"ok":true,...}
```

Then open the subdomain in a browser and press Compare on the built-in example.

## 4. Calibrate the request cap

The 600-request cap and the 5 s limit have to fit together on this machine.
- **Mac VM measurement:** in a 2-vCPU Docker VM on a Mac, a comparison took about 1.4 s plus
  7.5 ms per request. That's 4.4 s at 432 requests and 5.8 s at 576, so 600 doesn't fit in 5 s
  there.
- **On the CX23:** time [calibrate.json](calibrate.json) (576 requests) a few times. Each request
  counts against the rate limit.

```sh
for i in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
    -H 'content-type: application/json' --data-binary @calibrate.json https://<your subdomain>/api/diff
done
```

- **200, under about 4 s:** keep the defaults.
- **504, or close to 5 s:** choose one of these, then run `docker compose up -d`:
  - Lower the cap: add `"--max-requests", "400"` to `command:` in [compose.yml](compose.yml). Time
    grows about linearly with requests.
  - Raise the time limit, e.g. `"--timeout", "10"`.

Every 504 also costs an emulator restart (about 2 s), so a cap that fits is better than a timeout
that fires.

## 5. Alerts

`/healthz` returns 503 in three cases:
- the emulator is down;
- the VM has under 10% of its memory available;
- the emulator is over 1.5 GB.

Otherwise it returns 200. So one external HTTP monitor covers both uptime and memory:

- **Uptime and memory:** add an HTTP(S) monitor for `https://<your subdomain>/healthz`. Any free
  uptime service works (UptimeRobot, Better Stack, and others). Check every 5 minutes, alert by email
  on anything but 200, and optionally require the keyword `"ok":true`.
- **Restarts:** `docker compose logs firediff | grep restarting` lists each emulator restart and its
  reason (timeout, run count, memory, exited).
- **Out of memory:** if the container goes past 3 GB, Docker kills it and the restart policy brings it
  back. The monitor sees the gap.

## Updating, stopping

```sh
cd /opt/firediff && git pull && cd deploy && docker compose up -d --build && docker image prune -f
docker compose down            # stop (the certificate stays in the caddy_data volume)
```

To roll back, `git checkout <previous commit>`, then run `docker compose up -d --build`.

When it's live, uncomment the "Try it in the browser" line near the top of the main
[README](../README.md) and put the real subdomain in it.
