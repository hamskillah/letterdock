#!/usr/bin/env bash
# Executed on the deployment host; token is read from stdin, never an argument.
set -Eeuo pipefail
live=$1 candidate=$2 sha=$3 repository=$4 run=$5
IFS= read -r token
[[ $sha =~ ^[0-9a-f]{40}$ && $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $run =~ ^[0-9]+-[0-9]+$ ]] || exit 2
[[ -n $token && -f $live/.env && -f $live/compose.yml && -f $candidate/compose.yml ]] || exit 2
exec 9>"${live}.deploy.lock"
flock -x 9
marker="${live}.deploy-needs-review"
[[ ! -e $marker ]] || { echo "Previous cutover needs operator review: $marker" >&2; exit 1; }
# Changes to Compose need a separately reviewed migration of the live configuration.
cmp -s "$live/compose.yml" "$candidate/compose.yml" || { echo 'Compose differs from live; manual migration required' >&2; exit 1; }
cmp -s "$live/deploy/compose.domain-connect.example.yml" "$candidate/deploy/compose.domain-connect.example.yml" || { echo 'Domain Connect overlay differs; manual migration required' >&2; exit 1; }
cd "$live"
# Only the known base plus Domain Connect overlay is supported. Do not silently
# replace an operator's override or a Compose environment override.
python3 - "$live" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
for name in ('compose.yaml', 'docker-compose.yml', 'docker-compose.yaml',
             'compose.override.yaml', 'docker-compose.override.yml', 'docker-compose.override.yaml'):
    if (p / name).exists(): sys.exit('Unsupported Compose file: ' + name)
if re.search(r'(?m)^\s*(?:export\s+)?COMPOSE_[A-Z0-9_]+\s*=', (p / '.env').read_text()):
    sys.exit('COMPOSE_* in .env requires manual migration')
override = p / 'compose.override.yml'
if override.is_symlink(): sys.exit('Override must not be a symlink')
if override.exists():
    text = override.read_text()
    pattern = (r'# Managed by Letterdock deployment\nservices:\n  app:\n'
               r'    extends:\n      file: deploy/compose.domain-connect.example.yml\n'
               r'      service: app\n    build: !reset null\n    image: letterdock-candidate:[0-9]+-[0-9]+\n'
               r'secrets:\n  domain_connect_key:\n'
               r'    file: \$\{DOMAIN_CONNECT_SIGNING_KEY_PATH:\?Set the host path to the private signing PEM\}\n')
    if not re.fullmatch(pattern, text): sys.exit('Unmanaged Compose override')
PY
had_override=no
previous_override="$candidate/.previous-override.yml"
if [[ -f $live/compose.override.yml ]]; then
  cp -p "$live/compose.override.yml" "$previous_override"
  had_override=yes
fi
# Derive identity from the running deployment, never from the candidate directory.
container=$(sudo docker compose ps -q app)
[[ -n $container ]] || { echo 'No running app found in the existing Compose project' >&2; exit 1; }
project=$(sudo docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container")
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 1
files=$(sudo docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$container")
if [[ $files != "$live/compose.yml,$live/deploy/compose.domain-connect.example.yml" && $files != "$live/compose.yml,$live/compose.override.yml" ]]; then
  prefix="$live/compose.yml,${live}.releases/"
  [[ $files == "$prefix"* ]] || { echo 'Unexpected running Compose files' >&2; exit 1; }
  suffix=${files#"$prefix"}
  [[ $suffix =~ ^[0-9]+-[0-9]+/\.letterdock-image-override\.yml$ ]] || exit 1
  cmp -s "${live}.releases/$suffix" "$live/compose.override.yml" || { echo 'Running and published overrides differ' >&2; exit 1; }
fi
[[ $files != *compose.override.yml || -f $live/compose.override.yml ]] || exit 1
compose=(sudo docker compose --project-directory "$live" -p "$project" -f "$live/compose.yml" -f "$live/deploy/compose.domain-connect.example.yml")
# Refuse to redeploy a container whose relevant runtime config drifted.
python3 "$candidate/deploy/check-running.py" "$live" "$project" "$container"
old_image=$(sudo docker inspect --format '{{.Image}}' "$container")
[[ $old_image == sha256:* ]] || exit 1
sudo docker image tag "$old_image" "letterdock-rollback:$run"
sudo docker build -t "letterdock-candidate:$run" "$candidate"
check_tip() {
  local tip
  tip=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsS --max-time 20 -K - -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repository/commits/main" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
  [[ $tip == "$sha" ]] || { echo 'Stale deployment: main has moved' >&2; return 1; }
}
check_tip
backup_dir="$HOME/letterdock-backups"
install -d -m 700 "$backup_dir"
backup="$backup_dir/letterdock-$run.dump"
# noclobber avoids overwriting a previous backup, including on reruns.
(umask 077; set -o noclobber; "${compose[@]}" exec -T db pg_dump -U letterdock -Fc letterdock > "$backup")
[[ -s $backup ]] || { echo 'Database backup is empty' >&2; exit 1; }
"${compose[@]}" exec -T db pg_restore -l < "$backup" >/dev/null
override="$candidate/.letterdock-image-override.yml"
cat > "$override" <<EOF
# Managed by Letterdock deployment
services:
  app:
    extends:
      file: deploy/compose.domain-connect.example.yml
      service: app
    build: !reset null
    image: letterdock-candidate:$run
secrets:
  domain_connect_key:
    file: \${DOMAIN_CONNECT_SIGNING_KEY_PATH:?Set the host path to the private signing PEM}
EOF
# Capture resolved models only in the comparison process's memory.
python3 "$candidate/deploy/compare-compose.py" before "$live" "$project" "$override"
# Backup may have taken arbitrarily long; recheck runtime and tip before cutover.
[[ $("${compose[@]}" ps -q app) == "$container" ]] || { echo 'Running app changed during deployment' >&2; exit 1; }
python3 "$candidate/deploy/check-running.py" "$live" "$project" "$container"
check_tip
unset token
# Persist an interlock before cutover, including on interruption or migration failure.
(umask 077; set -o noclobber; printf "%s %s\n" "$sha" "$run" > "$marker")
# Cut over using the staged override. Do not publish it as the default until
# the new container has passed health checks. Other Docker users are not locked.
sudo docker compose --project-directory "$live" -p "$project" -f "$live/compose.yml" -f "$override" up -d --no-deps --no-build app
for attempt in {1..20}; do
  if timeout --kill-after=2s 10s "${compose[@]}" exec -T db pg_isready -U letterdock -d letterdock >/dev/null && \
     timeout --kill-after=2s 10s "${compose[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    "${compose[@]}" ps
    # Do not overwrite a concurrently changed default override.
    if [[ $had_override == yes ]]; then
      [[ -f $live/compose.override.yml && ! -L $live/compose.override.yml ]] && cmp -s "$previous_override" "$live/compose.override.yml" || { echo 'Default override changed during deployment' >&2; exit 1; }
    else
      [[ ! -e $live/compose.override.yml && ! -L $live/compose.override.yml ]] || { echo 'Default override appeared during deployment' >&2; exit 1; }
    fi
    # Publish only after healthy cutover; failures retain the interlock.
    if [[ $had_override == yes ]]; then cp -p "$previous_override" "$backup_dir/override-$run.yml"; fi
    staged=$(mktemp "$live/.compose-override.XXXXXX")
    cat "$override" > "$staged"
    mv -f "$staged" "$live/compose.override.yml"
    python3 "$candidate/deploy/compare-compose.py" after "$live" "$project" "$override"
    rm -- "$marker"
    echo "Deploy $sha completed; backup: $backup; previous image: letterdock-rollback:$run"
    exit 0
  fi
  sleep 3
done
echo 'Health check failed after cutover; investigate migration and restore compatibility before recovery' >&2
exit 1
