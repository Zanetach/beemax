# Caddy Artifact Site

BeeMax can publish Artifact Manifest integrity-checked document outputs through a Profile-owned Caddy
process. The final channel reply contains stable links in addition to the
existing native file delivery.

## Configuration

```yaml
gateway:
  artifactSite:
    enabled: true
    command: /opt/homebrew/bin/caddy
    # Optional overrides; omit both for this Profile's stable loopback port.
    listen: 127.0.0.1:18788
    publicBaseUrl: http://127.0.0.1:18788/artifacts
```

The equivalent environment variables are
`BEEMAX_ARTIFACT_SITE_ENABLED`, `BEEMAX_ARTIFACT_SITE_COMMAND`,
`BEEMAX_ARTIFACT_SITE_LISTEN`, and
`BEEMAX_ARTIFACT_SITE_PUBLIC_BASE_URL`.

Each enabled Profile owns a separate Caddy child process, generated Caddyfile,
PID file, publication store, and stable default loopback port. If ports are
overridden manually, every concurrently running Profile must use a distinct
`listen` address and matching `publicBaseUrl`.

Automatic addresses are persisted in
`<BEEMAX_HOME>/state/artifact-site-addresses.json`. Allocation is serialized
across Profile Gateway processes and resolves a hash collision to the next free
port. An explicit port already reserved by another Profile fails closed.

The loopback default opens from a browser on the Gateway machine. To make links
reachable from other devices, put an authenticated HTTPS reverse proxy or
tunnel in front of `listen`, then set `publicBaseUrl` to its external
`https://.../artifacts` URL. Do not bind an unauthenticated document site to a
public interface.

## Supported outputs

- HTML and PDF are served inline.
- DOC, DOCX, DOCM, DOT, DOTX, ODT, and RTF are served as downloads with explicit
  media types. Browsers normally download Word-family formats; browser-native
  editing or Office Online integration is not enabled.

Only file Artifacts with a workspace Manifest whose byte length and SHA-256
still match are eligible. BeeMax copies each accepted file into
`<agentDir>/artifact-site/public/<sha256>/<name>` and serves that immutable
copy. It never exposes the Profile workspace itself.

Directory browsing is disabled. Requests outside the configured artifact path
return 404. Responses use `nosniff`; HTML also receives a restrictive Content
Security Policy.

The Caddy process starts and stops with the Profile Gateway. Runtime files live
under `<agentDir>/artifact-site/runtime`, including the generated Caddyfile and
PID file.
