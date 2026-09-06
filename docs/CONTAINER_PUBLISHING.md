# Container publishing and public pulls

The CI workflow publishes these packages under `pe-engineering`:

- `ghcr.io/pe-engineering/wealth-watcher-public-api`
- `ghcr.io/pe-engineering/wealth-watcher-public-web`
- `ghcr.io/pe-engineering/wealth-watcher-public-webhook-relay`

## First publication in an organization

A public source repository does not make its GHCR packages public. New packages default to Private. An organization owner must enable **Public** under **Organization Settings → Packages → Package Creation** if that visibility is disabled. This permits public packages; it does not change existing packages or make future packages public automatically.

After the first successful publication, open **Organization → Packages**, select each of the three packages, then use **Package settings → Change visibility → Public**. Confirm the package name. Public visibility applies to subsequent versions of that package; repeat this setup for a newly introduced package name or namespace. GitHub does not allow a public package to be changed back to private.

Public GHCR images support anonymous pulls. Deployment hosts do not need a registry secret for these images. See [GitHub's package visibility documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

## Publishing and repository transfers

The workflow logs into GHCR using `GITHUB_TOKEN` with `packages: write`. That authenticates publishing inside the Actions job; it does not log a remote deployment host into Docker.

After a repository transfer, check both the image-publishing and release job repository guards, all three image destinations, and the OCI source label in `.github/workflows/ci.yml`. GitHub releases and tags appearing in the transferred repository do not prove that the container packages exist in the new namespace.

Successful `main` pushes publish development and SHA tags. Only version-tag pushes publish the stable `latest` alias. Follow [the release policy](../RELEASE_POLICY.md) to create a new version tag containing any workflow fixes; merging a fix into `main` alone does not populate `latest`. Rerunning a historical run uses its historical workflow definition.

## Troubleshooting unauthorized or denied pulls

Check that the exact package exists in the requested namespace, its visibility is Public, and the requested tag exists. A registry authorization error alone does not establish which of these is wrong.

To exclude saved Docker credentials, run this Bash command on the host that actually pulls the images. It pulls all three images without starting or replacing containers and leaves the normal Docker configuration untouched:

```bash
(
  set -euo pipefail
  config_dir="$(mktemp -d)"
  trap 'rm -rf -- "$config_dir"' EXIT

  for component in api web webhook-relay; do
    docker --config "$config_dir" pull \
      "ghcr.io/pe-engineering/wealth-watcher-public-${component}:latest"
  done
)
```

If this succeeds while the normal pull fails, inspect the normal Docker client's registry credentials. If it also fails, recheck package visibility, namespace, tag, and registry availability. SSH host-key verification failures occur before this registry step and belong to the deployment repository's SSH configuration.
