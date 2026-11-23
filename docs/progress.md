# Release status

Letterdock is in preview. The current `main` branch includes security and
storage fixes added after `v0.1.0-preview.1`.

CI checks TypeScript, builds the dashboard and Docker image, and runs the
PostgreSQL and Chromium integration suite. The suite covers catch-all import,
BCC, duplicate imports, HTML sanitization, SDK and attachment access,
domain-scoped keys, and automatic pruning.

Before promoting a build to a stable release, verify real external delivery,
sender-visible Worker storage failures, recovery after VPS downtime, and
signed webhook retries against the deployment being released. Follow the
[setup and upgrade guide](../README.md) for deployment checks.
