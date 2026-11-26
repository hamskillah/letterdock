# Production deployment and recovery

The main-branch workflow stages each run in a new sibling directory
`<DEPLOY_PATH>.releases/<run-id>-<attempt>`; it never synchronizes or deletes
files in the live checkout. The host needs Bash, flock, Python 3, curl, rsync,
Docker Compose with `!reset` support, GNU `timeout`, sudo Docker access, outbound
GitHub API access, and enough disk
for images, candidates and backups. `DEPLOY_PATH` must be an absolute path
without spaces or `..`; the existing deployment must have `.env`, `compose.yml`
and an app container discoverable by `sudo docker compose ps -q app` from that
path. Its labels must identify either exactly `compose.yml` plus
`deploy/compose.domain-connect.example.yml` (in that order), or the base file
plus the managed `compose.override.yml` installed by an earlier run, or
the exact staged override from an earlier successful run when it matches the
managed override. The candidate copies of both source Compose files must match the live files. The
script rejects unmanaged implicit overrides, alternate default file names,
`COMPOSE_*` settings in `.env`, and a different default project name. The
workflow does not edit `.env` or the source Compose files.

Actions serializes jobs (pending jobs can be replaced), and a host flock protects
the deployment critical section against other invocations of this script. Before
backup and again immediately before cutover the script checks that the run SHA
is still the GitHub main tip; API failure or a stale SHA fails closed. This is not an atomic transaction with
GitHub: main can advance immediately after the check. Other deploy mechanisms
that ignore the same lock are not serialized. **Operational prerequisite:** ensure
no operator or automation runs Compose or other Docker mutations against this
project during deployment or while an interlock remains; this script cannot
enforce that restriction against an unrestricted Docker user. Failed or skipped runs need operator
attention; this is not a deployment queue guaranteeing every commit is deployed.

Before building and again immediately before cutover, the script compares the
running app's environment (including image defaults), bind/volume and file-secret
mounts, and configured host port bindings against the resolved live base plus
Domain Connect model. It fails closed on a mismatch, unsupported mount or network
mode, missing data, inspection failure, or a changed app container. Resolved
values and inspect results stay in process memory and are not logged. This is
not full container equivalence: it does not verify file/secret contents, volume
data, network connectivity, health, runtime process state beyond running, image
semantics, every mount option, or operator mutations after the check. Anonymous
image-declared volumes are checked for target, type and read/write mode, not
for a historical volume identity. Non-file secrets, dynamic ports and unsupported
configurations require separate review.

The candidate is built before backup, without starting it. The existing app's
image is tagged `letterdock-rollback:<run-id>-<attempt>`, then a private local
PostgreSQL custom-format dump is made and its archive table of contents checked.
The existing project identity, `.env`, Domain Connect configuration and database
volume are retained. The staged override carries the Domain Connect settings,
secret mount, selected image and `build: !reset null`. Before cutover the
resolved models are compared in memory, allowing only image selection and removal
of the app build configuration to differ. Unsupported Compose versions fail the
comparison rather than deploying.

Cutover uses the staged override explicitly. Only after the new app passes its
health checks is that override atomically published as `compose.override.yml`
for ordinary Compose commands, then the default model is checked. The previous
managed override is saved beside the dump. Disabling the app build prevents
ordinary `docker compose up -d --build` from rebuilding the selected candidate
tag from the stale live checkout. Explicit commands that omit the managed
override, direct Docker builds/tags, or overriding configuration can still bypass
this protection. The app alone is restarted, so downtime is possible. Changes
to either source Compose file, other overlays, project identity, ports, or env
require a separately planned migration.

Resolved Compose models can contain secrets. Comparisons capture them only in
process memory; command output and errors are not logged or written to files.

The script retries PostgreSQL readiness and the app's HTTP root from inside the
app container. Each Docker exec client is limited to 10 seconds (plus a 2-second
forced-kill grace), and the Node HTTP fetch has a 5-second abort. A stuck Docker
daemon or exec process inside a container may require separate operator cleanup;
the client timeout is not a guarantee that a remote process was terminated. These checks do **not** establish end-to-end mail delivery,
authentication, external routing, correct migrations or full database health.
After a successful deploy, an operator should check authenticated Health and
send a real test message through the external delivery path.

## Failure and recovery

Before cutover the script creates `<DEPLOY_PATH>.deploy-needs-review`; it removes
this interlock only after health checks succeed. A failed or interrupted cutover
blocks subsequent runs. After investigating and resolving the incident, an
authorized operator must remove the interlock before redeploying.

No automatic rollback is attempted. The application runs migrations and data
updates on startup; even a failed cutover can leave the database changed. An old
image may not support the new schema or data. Stop and inspect the deployment,
logs, schema and release changes before deciding on a forward fix or rollback.
Preserve the candidate directory, `.letterdock-image-override.yml`, image tags and dump as evidence.
A rollback image can be selected by an operator by deliberately updating the
managed override in the same existing project, **only after** schema compatibility
is established; it is not a database rollback. Do not run plain Compose, remove the interlock, or change the override blindly:
the new container may already be running while the published default still
selects the previous image. A plain `up` could restart the old image against a
changed database. Failure after publication can instead leave the new override
installed. The interlock only blocks this deployment script, not manual Docker
commands or other automation.

Database restoration is a separate, destructive operation: coordinate downtime,
protect writes, evaluate data lost since the dump, and rehearse a restore into an
isolated empty database first. Restoration may require compatible database and
application versions and matching secrets. Never restore automatically over the
live database. The `pg_restore -l` check only verifies the archive's table of
contents, not a complete restore or data integrity. Local dumps and image tags
are not disaster recovery: host loss, disk exhaustion, compromise and corruption
can affect both production and backups. Arrange encrypted off-host backups,
retention, access controls and regular restore drills separately. Candidates,
images and dumps accumulate; clean up only through an approved retention process.

Run `python3 tests/deploy_release_test.py` for isolated protocol tests using fake
Docker and network commands. `python3 tests/deploy_compose_lifecycle_test.py`
uses a uniquely named real Compose project, real PostgreSQL and Docker builds,
but a fake GitHub response and fake application health command. It tests the
Domain Connect environment/secret mount, repeated `up --build` with a real
build context, stale SHA after backup, unmanaged overrides, health failure and
interruption after container cutover, plus actual environment, mount and port drift.
The fake-command tests also exercise hanging database and app health checks. The
real lifecycle has been run locally with Compose 2.40.3 and 5.8.0; this does not
validate the production host or its Docker Engine. It removes only its own
uniquely named project containers, network, and volume and verifies that the
volume no longer exists. Neither test proves GitHub
permissions, a complete PostgreSQL restore, production paths or external delivery.
