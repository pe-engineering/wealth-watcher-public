# Operations guide

This guide covers the local/trusted Docker Compose deployment. Do not expose the stack to the public Internet until authentication, authorization, HTTPS, and tenant-isolation requirements are complete.

## Optional webhook relay

The webhook relay is an independently published image and deployment. Back up its `RELAY_DATA_PATH` directory together with the private API's PostgreSQL database when webhook delivery history matters; it contains the SQLite queue and retry state. Do not include the relay installation token or `SNAPTRADE_CONSUMER_KEY` in backups shared for support.

For a relay image update, pin `RELAY_IMAGE` to the desired release or immutable SHA tag and run:

```powershell
docker compose -f docker-compose.relay.yml pull
docker compose -f docker-compose.relay.yml up -d --no-build
```

Verify `https://<relay-host>/health`, the provider route `https://<relay-host>/webhooks/snaptrade`, the API endpoint `/api/integrations/webhook-relay/status`, and the application logs. The Integrations screen exposes the persisted relay enabled/disabled setting and a relay-to-API diagnostic. A disconnected or disabled relay must not be treated as a database or API health failure; scheduled polling remains the reconciliation path for connections configured in polling mode.

## Backups

1. Stop writes or schedule the backup during a quiet period.
2. Create a PostgreSQL dump using the same values as the private `.env` file:

   ```powershell
   docker compose exec -T db pg_dump -U wealthwatcher -d wealthwatcherdb --format=custom > wealthwatcher-$(Get-Date -Format yyyyMMdd-HHmmss).dump
   ```

3. Back up the `CONFIG_PATH` directory separately. It contains the ASP.NET Data Protection keys needed to decrypt stored integration credentials.
4. Store dumps and key backups encrypted, with access limited to the deployment owner. Test restores into a disposable environment.

## Restore

1. Stop the API and web services: `docker compose stop api web`.
2. Restore the database into a disposable or intentionally selected database using `pg_restore`; do not overwrite production data without a verified backup and maintenance window.
3. Restore the matching Data Protection key directory to `CONFIG_PATH` with permissions that allow the API container to read and write it.
4. Start the stack and verify `http://127.0.0.1:8182/api/health` and the browser UI.

Database migrations run during API startup. Review migration changes before upgrading and retain a backup before applying them.

## Application updates

Review the release note shown in the application Settings page or in `docs/release-notes` before updating. Release notes identify migrations, configuration changes, image tags, and known issues.

For a published-image deployment, back up PostgreSQL and the configured Data Protection key directory, update the `API_IMAGE` and `WEB_IMAGE` values in `.env` to the desired release tag or digest, and run:

```powershell
docker compose pull api web
docker compose up -d --no-build --remove-orphans
```

Verify `http://127.0.0.1:8182/api/health` and the browser UI after the services restart. The application version indicator does not execute these commands automatically. To roll back, restore the previous image tags or digests and repeat the same pull/start commands after assessing any database migration compatibility.

## Key loss and rotation

If the Data Protection key ring is lost, existing integration credentials cannot be decrypted and must be entered again. Rotation and recovery procedures should be tested as part of the deployment owner's operational review.
