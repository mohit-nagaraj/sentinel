# Sentinel implementation blockers

This file records external inputs discovered during the autonomous implementation campaign. It contains configuration names and remediation steps only—never secret values.

## Current configuration readiness

Checked on 2026-09-07 without displaying values:

- Supabase database, URL, publishable key, S3-compatible Storage endpoint/region/key IDs, and bucket name: configured.
- Neo4j Aura URI, username, password, and database: configured.
- Azure OpenAI endpoint, API key, and deployment: configured.

Provider compatibility and permission checks still need to be established by each owning issue; a configured value is not proof that the corresponding service capability is available.

## Later inputs to verify

- SNT-026: GitHub App App ID, Client ID, installation ID, and private-key file are configured locally. Webhook secret and public webhook URL still need to be set when the hook is enabled.
- SNT-030: trusted public baseline and PR-head deployment identity/preview strategy.

Update this file whenever an implementation task cannot proceed without user action. Do not place credentials, tokens, private URLs, or secret-derived values here.
