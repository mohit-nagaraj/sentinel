# Security verification policy

## Default gate

`pnpm security` is deterministic and credential-free. It runs:

1. high-confidence secret scanning across tracked and untracked non-ignored text
   plus semantic checks for `.env`, auth state, and private-key ignore rules;
2. production dependency advisory validation;
3. production license inventory validation;
4. the malicious-input and policy test project;
5. the 100-repetition SNT-033 deterministic evaluation baseline and a Git diff
   check proving the committed reports are current.

GitHub Actions runs this command as a separate matrix job. It never sets a live,
paid, provider, target credential, or external integration flag.

## Secret policy

The scanner recognizes private-key headers, classic and fine-grained GitHub
tokens, legacy and stateless GitHub App installation tokens, OpenAI keys, and AWS
access-key shapes. GitHub tokens are treated as opaque variable-length values;
the scanner does not assume the older 40-character format. Findings contain only
path, line, rule, and a SHA-256 fingerprint, never the matched value. Exceptions
require exact path+fingerprint, rationale, and an expiry. Current exceptions are
synthetic values deliberately used in redaction tests; a changed value or
location fails the gate.

Runtime errors and public projections have separate redaction tests. Secret
scanning is defense in depth, not permission to persist raw provider responses.

## Dependency policy

Every high or critical production advisory fails with no exception mechanism.
Low/moderate advisories also fail unless their exact GHSA, package, severity,
rationale, source, and future expiry appear in `security/policy.json`.

As of 2026-09-09, Next.js was upgraded from 16.2.6 to 16.3.3 and patched PostCSS
and xmldom versions were forced through workspace overrides. Two moderate Crawlee
transitives remain temporarily accepted:

- `stream-json`: the compatible Crawlee line requires 1.x while the advisory's
  fix is a 3.x major. Sentinel does not call the affected nested filter API and
  independently bounds crawler input/time.
- `adm-zip`: the advisory names 0.6.1 as fixed, but the registry has no such
  release. The transitive header-generation data path is not used to extract
  target content; Sentinel does not accept source archives.

Both exceptions expire on 2026-10-09 and must be removed, renewed with evidence,
or resolved by an upstream update.

## License policy

`pnpm licenses list --prod --json` must contain only the permissive/attribution
licenses in `security/policy.json`. Unknown metadata fails unless the exact
package/version is documented with source, rationale, and expiry. Current exact
exceptions cover `khroma@2.1.0` and `map-stream@0.1.0`; both are unmodified
transitive packages and must be re-reviewed by 2026-10-09.

This is an assignment-appropriate inventory review, not legal advice. Any new
copyleft, proprietary, unlicensed, or unknown dependency requires explicit human
review before merge.
