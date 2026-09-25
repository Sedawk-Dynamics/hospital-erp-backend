#!/bin/sh

# Keep liveness independent from schema-maintenance failures. `db push` remains
# deliberately conservative (no --accept-data-loss); if Prisma detects a risky
# change or the database is briefly unavailable, preserve the existing schema
# and bring the HTTP process up so /health and unaffected routes remain usable.
if ./node_modules/.bin/prisma db push --skip-generate; then
  echo "Database schema synchronized."
else
  schema_status=$?
  echo "WARNING: Prisma schema synchronization failed with status ${schema_status}." >&2
  echo "Starting the API with the existing schema; review the deployment log and apply schema maintenance explicitly." >&2
fi

exec node dist/server.js
