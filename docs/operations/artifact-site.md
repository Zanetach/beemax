# Caddy Artifact Site

Thruvera can publish Artifact Manifest integrity-checked document outputs through a Profile-owned Caddy
process. The final channel reply contains stable links in addition to the
existing native file delivery. It is enabled by default for new Profiles and
for existing Profiles that do not configure `gateway.artifactSite.enabled`.
Set that field or `THRUVERA_ARTIFACT_SITE_ENABLED` to `false` for an explicit
Profile opt-out.

## Configuration

```yaml
gateway:
  artifactSite:
    enabled: true
    # Optional overrides; omit both for this Profile's stable loopback port.
    listen: 127.0.0.1:18788
    publicBaseUrl: http://127.0.0.1:18788/artifacts
```

The Profile-scoped environment equivalents are
`THRUVERA_ARTIFACT_SITE_ENABLED`, `THRUVERA_ARTIFACT_SITE_LISTEN`, and
`THRUVERA_ARTIFACT_SITE_PUBLIC_BASE_URL`. The executable is deliberately not a
Profile setting: when Caddy is not on the Gateway service's trusted `PATH`, set
`THRUVERA_ARTIFACT_SITE_COMMAND` in the Gateway host/service environment. A
`command` field in Profile YAML, or `THRUVERA_ARTIFACT_SITE_COMMAND` in the
Profile `.env`, is rejected.

Caddy is a required host dependency while the site is enabled. The standard
Thruvera installer provisions it on supported Ubuntu/macOS hosts. `thruvera doctor`
runs the host-resolved command's `version` operation and fails before Gateway
startup when it is unavailable. Doctor and Gateway use the same resolver and
credential-free child environment. The managed Caddy process receives only a
small allowlist from the trusted host environment (for example `PATH`, platform
launch variables, display, locale, and timezone); it receives no Profile
environment or Secret and never inherits the host environment wholesale.
`HOME`, `USERPROFILE`, all XDG state, `TMPDIR`, `TMP`, and `TEMP` point into this
Profile's private `artifact-site/runtime` directory.

Each Profile owns a separate Caddy child process, generated Caddyfile,
PID file, publication store, and stable default loopback port. If ports are
overridden manually, every concurrently running Profile must use a distinct
`listen` address and matching `publicBaseUrl`.

Automatic addresses are persisted in
`<THRUVERA_HOME>/state/artifact-site-addresses.json`. Allocation is serialized
across Profile Gateway processes and resolves a hash collision to the next free
port. An explicit port already reserved by another Profile fails closed.

The loopback default opens from a browser on the Gateway machine. To make links
reachable from other devices, put an authenticated HTTPS reverse proxy or
tunnel in front of `listen`, then set `publicBaseUrl` to its external
`https://.../artifacts` URL. Preserve a distinct origin for every Profile; do
not merge multiple Profile sites under paths on one shared origin. Do not bind
an unauthenticated document site to a public interface.

## Supported outputs

- HTML and PDF are served inline.
- DOC, DOCX, DOCM, DOT, DOTX, ODT, and RTF are served as downloads with explicit
  media types. Browsers normally download Word-family formats; browser-native
  editing or Office Online integration is not enabled.

Only file Artifacts with a workspace Manifest whose byte length and SHA-256
still match are eligible. Thruvera copies each accepted file into
`<agentDir>/artifact-site/public/<sha256>/<name>` and serves that immutable
copy. Source bytes are read and hashed from the same pinned file descriptor,
then committed through an exclusive temporary file and atomic rename. Invalid
pre-existing entries are moved outside the served tree. It never exposes the
Profile workspace itself.

Directory browsing is disabled. Requests outside the configured artifact path
return 404. Responses use `nosniff`; HTML also receives a restrictive Content
Security Policy with an opaque sandboxed origin, no form submission, and no
network connections. Inline scripts remain available for self-contained charts
but cannot read other same-origin documents.

The Caddy process starts and stops with the Profile Gateway. Runtime files live
under `<agentDir>/artifact-site/runtime`, including the generated Caddyfile and
PID file.
