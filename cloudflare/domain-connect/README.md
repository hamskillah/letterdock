# Cloudflare authorization for Letterdock

This template adds only the domain ownership TXT. Cloudflare Email Routing, MX,
catch-all and R2 still use the installation's existing provisioning flow.

1. The provider ID is `tokenhouse.site`. The template applies to the receiving domain selected in the dashboard.
2. Generate a dedicated RSA signing key. Publish its public key as a Domain
   Connect TXT record at `_dck1.domainconnect.tokenhouse.site` and keep the
   private PEM in a read-only secret mount on the Letterdock server.
3. Submit the template to Domain-Connect/Templates. After approval, request
   onboarding from Cloudflare with the merged template, signing TXT hostname,
   and Letterdock logo.
4. Set `DOMAIN_CONNECT_PROVIDER_ID` to the registered provider ID and `DOMAIN_CONNECT_KEY_FILE` to the mounted key path. The example Compose override in `deploy/` mounts the private key. Keep it outside the repository.
   The dashboard checks template availability before opening Cloudflare.
5. Test approval and cancellation from the localhost dashboard via SSH tunnel.
   Confirm whether the Cloudflare consent page accepts the signed loopback
   redirect. Recheck the public DNS before reporting ownership verification.

See https://developers.cloudflare.com/dns/reference/domain-connect/ for the provider requirements.
