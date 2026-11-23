# Release status

The local integration suite covers durable PostgreSQL import, catch-all routing, a BCC
envelope recipient, duplicate object delivery, search and labels, sanitized HTML, the
official Node SDK, attachment download, and Chromium navigation at desktop and mobile sizes.

Public release still requires a provisioned private Cloudflare staging bucket, Worker,
two test domains, and access to the target VPS. Verify Gmail and Outlook delivery,
Worker storage failure as observed by the sender, VPS downtime replay, the 25 MiB
boundary, and signed HTTPS webhook retries on that deployment before publishing.
