# LetterDock — Production Deployment Runbook (Tencent Cloud)

**Target Host:** Tencent Cloud Production VPS (`43.160.198.156` / `43.159.63.207`)  
**Deployment Target Version:** `v1.0.1`  
**Document Classification:** Standard Operating Procedure (SOP) / Production Runbook  
**Last Updated:** 2026-11-27  
**Governance Authority:** LetterDock Founder Strategic Decisions (ADR 0001, 0002, 0003) & Operating Policy

---

## 1. Executive Overview & Governance Rules

This runbook specifies the step-by-step operational procedure for deploying and maintaining LetterDock **v1.0.1** on the hardened Tencent Cloud production host. 

### Mandatory Governance Constraints
1. **Strict Authorization Gate (§20):** No autonomous production deployment may be executed without explicit Founder authorization. All commands in this runbook are prepared for authorized human operators or authorized CI/CD execution.
2. **Zero Inbound Port 25:** In accordance with **D04 (Ingress Architecture)**, port 25 must remain closed at all times. Ingress is handled exclusively via Cloudflare Email Routing / HTTPS Ingestion API.
3. **Zero Direct Root Push:** All changes must originate from reviewed Git tags (`v1.0.1`) merged through pull requests using account `hamskillah`.
4. **Data Preservation:** Production `.env` file, PostgreSQL persistent volume (`letterdock_database`), and blob storage directory (`/app/data/storage`) must **never** be overwritten or deleted during deployment.

---

## 2. Architecture & Topology

```
+---------------------------------------------------------------------------------+
|                                 Cloudflare CDN / Edge                           |
|      - Email Routing (MX to Cloudflare)                                         |
|      - Reverse Proxy / SSL Termination (Zero Port 25 Exposed)                   |
+----------------------------------------+----------------------------------------+
                                         | HTTPS (Port 443 / Ingress API)
                                         v
+---------------------------------------------------------------------------------+
|  Tencent Cloud Production Host (43.160.198.156 / VM-0-14-ubuntu)                |
|  - OS: Ubuntu 24.04.5 LTS                                                       |
|  - Firewall (UFW): Active, Default Deny Inbound, Allow 22/tcp (SSH only)        |
|  - Docker Engine: Rootless/Sudo Compose                                         |
|                                                                                 |
|   +-------------------------------------------------------------------------+   |
|   | Docker Compose Network: letterdock-network (bridge)                     |   |
|   |                                                                         |   |
|   |  +-----------------------------+       +-----------------------------+  |   |
|   |  | Container: letterdock-app   | ----> | Container: letterdock-db    |  |   |
|   |  | (Fastify Node 24 slim)      |       | (PostgreSQL 17 Alpine)      |  |   |
|   |  | Internal Port: 3000         |       | Internal Port: 5432         |  |   |
|   |  | Host Bind: 127.0.0.1:3000   |       | No Host Port Binding        |  |   |
|   |  | Max Memory RSS: < 150 MiB   |       | Volume: letterdock_database |  |   |
|   |  | Storage: /app/data/storage  |       +-----------------------------+  |   |
|   |  +-----------------------------+                                        |   |
|   +-------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------+
```

---

## 3. Preflight Checklist & Verification

Execute these preflight verification checks on the Tencent production host prior to initiating deployment:

```bash
# 1. Connect via authorized SSH alias
ssh -i ~/.ssh/id_ed25519_devhost ubuntu@43.160.198.156

# 2. Check System Resource Availability (Disk, RAM, CPU)
df -h /
free -m
uptime

# Ensure minimum 5 GB free disk space and at least 512 MB available RAM.

# 3. Verify Docker Engine & Compose availability
sudo docker info > /dev/null 2>&1 && echo "Docker daemon OK" || echo "Docker daemon ERROR"
sudo docker compose version

# 4. Verify UFW Firewall Status
sudo ufw status verbose
# Expected output: Status: active, Default: deny (incoming), allow (outgoing), 22/tcp ALLOW

# 5. Verify Production Environment Variables Integrity
cd /srv/letterdock # or production repo path
if [ ! -f .env ]; then
  echo "CRITICAL: .env file missing in production directory!"
  exit 1
fi

# Verify critical keys exist in .env
grep -q '^ADMIN_PASSWORD=' .env && echo "ADMIN_PASSWORD present"
grep -q '^SESSION_SECRET=' .env && echo "SESSION_SECRET present"
grep -q '^APP_ENCRYPTION_KEY=' .env && echo "APP_ENCRYPTION_KEY present"
grep -q '^DATABASE_URL=' .env && echo "DATABASE_URL present"
```

---

## 4. Pre-Deployment Atomic Encrypted Backup

**MANDATORY:** Always perform an atomic encrypted backup before pulling code, rebuilding containers, or running migrations.

```bash
cd /srv/letterdock

# Set timestamped backup path
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/srv/backups/letterdock-backup-${BACKUP_DATE}.ldk.enc"
sudo mkdir -p /srv/backups

# Execute native LetterDock encrypted point-in-time backup tool
# This generates an AES-256-GCM encrypted container with magic header 'LDKB' and SHA-256 manifest
sudo docker compose exec -T app node dist/scripts/backup.js --output /tmp/backup.ldk.enc

# Copy backup out of container to host persistent backup store
sudo docker compose cp app:/tmp/backup.ldk.enc ${BACKUP_FILE}

# Verify backup header integrity
head -c 4 ${BACKUP_FILE} | grep -q 'LDKB' && echo "Backup magic header LDKB verified!" || echo "CRITICAL: Corrupted backup"
ls -lh ${BACKUP_FILE}
```

---

## 5. Deployment Execution Procedure (v1.0.1)

```bash
cd /srv/letterdock

# 1. Fetch tags and checkout release v1.0.1
git fetch --tags origin
git checkout tags/v1.0.1

# Verify tag signature and commit hash (ff2c0b4)
git rev-parse HEAD

# 2. Build production Docker image
sudo docker compose build --no-cache app

# 3. Gracefully switch container to new release
sudo docker compose up -d --remove-orphans app

# 4. Inspect container startup and health status
sleep 5
sudo docker compose ps
```

---

## 6. Database Migration & Schema Integrity Validation

LetterDock includes automated schema migration on server startup. Verify migration success and idempotency:

```bash
# 1. Check container startup logs for migration confirmation
sudo docker compose logs --tail=50 app | grep -i "migrat"

# 2. Verify all required relational tables exist in PostgreSQL
sudo docker compose exec -T db psql -U letterdock -d letterdock -c "
  SELECT table_name FROM information_schema.tables 
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name;
"

# 3. Verify core configuration and default workspace
sudo docker compose exec -T db psql -U letterdock -d letterdock -c "
  SELECT id, name FROM workspaces WHERE id = 'default';
"
```

---

## 7. Post-Deployment Verification & Health Checks

Verify operational telemetry and resource limits:

```bash
# 1. Health Endpoint Probe
curl -sSf http://127.0.0.1:3000/health | jq .
# Expected: { "status": "ok", "timestamp": "..." }

# 2. Prometheus Metrics Verification
curl -s http://127.0.0.1:3000/metrics | grep -E "(letterdock_up|letterdock_process_resident_memory_bytes)"
# Expected:
# letterdock_up 1
# letterdock_process_resident_memory_bytes <value in bytes>

# 3. Resource Footprint Profiling (Pillar 5 Gate)
sudo docker stats --no-stream --format "table {{.Name}}	{{.CPUPerc}}	{{.MemUsage}}	{{.MemPerc}}"
# Mandatory threshold: letterdock-app Memory Usage must be < 150 MiB.
```

---

## 8. Smoke Testing Suite

Perform lightweight functional verification without affecting production tenant data:

```bash
# 1. Verify OpenAPI 3.1 & Interactive Scalar UI
curl -s -I http://127.0.0.1:3000/docs | grep -E "(200 OK|302)"
curl -s http://127.0.0.1:3000/api/openapi.json | jq .info.version
# Expected: "1.0.1"

# 2. Verify Webhook Ingress Barrier
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3000/api/ingress/raw
# Expected: 401 (Unauthorized - ingress requires valid authentication)

# 3. Verify CSRF Origin Protection on Session Endpoint
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3000/api/login \
  -H "Origin: https://malicious-attacker.com" \
  -H "Content-Type: application/json" \
  -d '{"password":"probe"}'
# Expected: 403 (Forbidden - Origin rejected)
```

---

## 9. Rollback Procedure

In the event of an unexpected regression, high memory consumption (>150 MiB), or migration incompatibility:

```bash
cd /srv/letterdock

echo "=== INITIATING IMMEDIATE ROLLBACK ==="

# 1. Checkout previous stable version (v1.0.0)
git checkout tags/v1.0.0

# 2. Rebuild and restart application container
sudo docker compose up -d --build app

# 3. If database state was corrupted, restore from pre-deployment backup:
if [ -f "${BACKUP_FILE}" ]; then
  echo "Restoring database from pre-deployment snapshot: ${BACKUP_FILE}"
  sudo docker compose exec -T app node dist/scripts/restore.js \
    --input /srv/backups/${BACKUP_FILE} \
    --target-db postgres://letterdock:${POSTGRES_PASSWORD}@db:5432/letterdock
fi

# 4. Verify rollback health
curl -sSf http://127.0.0.1:3000/health
echo "Rollback completed and verified."
```

---

## 10. Disaster Recovery (DR) Protocol

For catastrophic host failure or multi-region recovery:

1. **Provision New Host:** Launch Ubuntu 24.04 LTS instance, install Docker + Docker Compose, enable UFW with 22/tcp allow.
2. **Clone Repository:** `git clone https://github.com/hamskillah/letterdock.git /srv/letterdock && cd /srv/letterdock && git checkout tags/v1.0.1`.
3. **Restore Environment Variables:** Provision `.env` containing original `APP_ENCRYPTION_KEY` and `SESSION_SECRET`.
4. **Transfer Encrypted Backup Archive:** Securely copy latest `*.ldk.enc` backup archive from off-site storage.
5. **Execute Disaster Restore:**
   ```bash
   sudo docker compose up -d db
   sleep 5
   sudo docker compose run --rm app node dist/scripts/restore.js \
     --input /srv/backups/latest.ldk.enc \
     --target-db postgres://letterdock:${POSTGRES_PASSWORD}@db:5432/letterdock \
     --target-storage /app/data/storage
   ```
6. **Launch Full Stack:** `sudo docker compose up -d`.
7. **Verify Cryptographic & Storage Integrity:** All blob hashes are automatically verified against the manifest SHA-256 table during restore.

---

## 11. Autonomous Escalation Matrix

| Incident Type | Severity | Automatic Action | Escalation Action |
|---|---|---|---|
| Container Health Check Failure | HIGH | Docker auto-restart (up to 5 retries) | Alert operator via ping; check `docker logs` |
| Memory RSS > 150 MiB | MEDIUM | Process continues running | Inspect worker queue depth & heap snapshot; schedule graceful container restart |
| Database Connection Loss | HIGH | Fastify reconnect pool backoff | Check PostgreSQL container health and disk space |
| Unauthorized Root/Port 25 Open | CRITICAL | Immediate UFW block | Halt deployment immediately; notify Founder |
| Restore Auth Tag Mismatch | CRITICAL | Restore aborts with error | Tampering or wrong encryption key; do not overwrite DB |
