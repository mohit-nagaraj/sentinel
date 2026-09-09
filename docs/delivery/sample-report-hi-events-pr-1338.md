# Sentinel assessment - PR #1338

## PR and baseline identity

- Repository: hieventsdev/hi\.events
- Pull request: #1338 - Rework UTM attribution tracking and admin attribution report
- Base: `2064f88ff7590e93c738efb8becaa7d732063619`
- Head: `f68df0dabd18d04df5e6c7e873aac2b5e5201584`
- Graph commit: `2064f88ff7590e93c738efb8becaa7d732063619`

## Executive risk summary

Admin attribution analytics needs focused regression testing before release\. The pull request changes the attribution screen, request parameters, validation, aggregation, classification, and revenue presentation across the React and Laravel stack\. The reviewed evidence supports impact to the admin attribution workflow; it does not establish a production regression\.

Overall predicted risk: **HIGH**
Overall evidence strength: **B**

## Affected product areas

- UI/screens: 2
- Workflows: 1
- Requirements: 1
- Unknown: 3

## Affected UI, screens, and elements

### HIGH - Date and grouping filters

Administrators may see missing, stale, or incorrectly grouped rows when switching date periods or attribution dimensions\. The screen adds preset and custom UTC date ranges and expands grouping from four to seven dimensions\. The backend now validates those query values before aggregation\. Recommended checks: 1\) Switch through 24 hours, 7 days, 30 days, 90 days, and all time; confirm results and page reset are consistent\. 2\) Choose a custom range at day boundaries and confirm the request uses the intended UTC start and end\. 3\) Exercise source, medium, campaign, content, term, CTA, and source type grouping; confirm each label and total\. 4\) Send an end date before the start date and unsupported grouping values; confirm a clear validation response and no stale table data\.

- Evidence strength: A
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:1bb5858d1f82890d77060b611520da5fa348df99bb247b44781e6601fd73de80`: PR \#1338 (pull-request) -> Attribution React route (code-symbol) -> GET admin attribution endpoint (api-endpoint) -> validated request (api-endpoint) -> stats handler (code-symbol) -> admin attribution workflow (workflow) -> filter/group requirements (requirement)
Evidence: `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374`, `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c`
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Http/Request/Admin/GetUtmAttributionStatsRequest.php>
Reference `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c` (golden\_fixture)
- Source: `repository://packages/evaluation/fixtures/hi-events-pr-1338.golden.json`
### HIGH - Revenue by currency

Revenue totals are no longer one assumed USD value; rows can show several currencies, so missing or merged currency totals would mislead administrators\. The API response changes from total\_revenue to revenue\_by\_currency and the UI renders one formatted amount per returned currency\. Recommended checks: 1\) Use fixture accounts with orders in two currencies and confirm each currency appears separately with the correct amount\. 2\) Confirm a row with no revenue displays an intentional empty state rather than USD zero\. 3\) Change grouping and pagination while multi\-currency rows are visible; confirm totals do not move between attribution values\.

- Evidence strength: B
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:961294a20b7301a0b36a6c3086821766ff4dc6e3dee117aa4644e53200aaff7e`: PR \#1338 (pull-request) -> account attribution repository (code-symbol) -> stats handler (code-symbol) -> admin API client (code-symbol) -> revenue cell (ui-element)
Evidence: `evidence:v1:6cd2ee7c63e59318a26a636e6efdbffb83614cecd43e415e1826ae00aedbd84b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25`
Reference `evidence:v1:6cd2ee7c63e59318a26a636e6efdbffb83614cecd43e415e1826ae00aedbd84b` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/api/admin.client.ts>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Repository/Eloquent/AccountAttributionRepository.php>

## Affected workflows

### MEDIUM - Paid, organic, referral, and unattributed classification

Account\-source categories and summary cards may shift because classification and historical attribution data are reworked\. The pull request introduces a source classifier, changes account creation attribution handling, and includes a data reclassification migration\. Recommended checks: 1\) Create representative paid, organic, referral, and unattributed accounts and confirm exactly one category per account\. 2\) Compare summary cards with the paginated table for the same date range\. 3\) Run the migration on a disposable copy and compare category totals before and after; retain the migration log privately\.

- Evidence strength: B
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:84c327b413c7ab2e2e2ca1a8d0a3b5a567901d6d3e2b87a821243a18acd32cc8`: PR \#1338 (pull-request) -> account creation handler (code-symbol) -> source classifier (code-symbol) -> attribution repository (code-symbol) -> summary cards (screen)
Evidence: `evidence:v1:6ddfa7e96eca01f1f4586c1eb0bf2637460b1b3d6e81b8d13131d5f2f2731692`, `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25`, `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`
Reference `evidence:v1:6ddfa7e96eca01f1f4586c1eb0bf2637460b1b3d6e81b8d13131d5f2f2731692` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Services/Domain/Account/AttributionSourceClassifier.php>
Reference `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Repository/Eloquent/AccountAttributionRepository.php>
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>

## Requirements at risk and coverage

### HIGH - Admin attribution filters remain correct

The reviewed requirement expects administrators to filter and group attribution analytics correctly\. The same cross\-stack evidence makes date\-range, grouping, and validation behavior a high\-priority acceptance check\.

- Evidence strength: A
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:1bb5858d1f82890d77060b611520da5fa348df99bb247b44781e6601fd73de80`: PR \#1338 (pull-request) -> Attribution React route (code-symbol) -> GET admin attribution endpoint (api-endpoint) -> validated request (api-endpoint) -> stats handler (code-symbol) -> admin attribution workflow (workflow) -> filter/group requirements (requirement)
Evidence: `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374`, `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c`
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Http/Request/Admin/GetUtmAttributionStatsRequest.php>
Reference `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c` (golden\_fixture)
- Source: `repository://packages/evaluation/fixtures/hi-events-pr-1338.golden.json`
- Static evidence connects the attribution report across UI and backend layers; PR\-head browser behavior was not dynamically verified\. (status: partially_observed; scope: Admin attribution analytics on the reviewed baseline)

## Why items were flagged

### HIGH - Date and grouping filters

Administrators may see missing, stale, or incorrectly grouped rows when switching date periods or attribution dimensions\. The screen adds preset and custom UTC date ranges and expands grouping from four to seven dimensions\. The backend now validates those query values before aggregation\. Recommended checks: 1\) Switch through 24 hours, 7 days, 30 days, 90 days, and all time; confirm results and page reset are consistent\. 2\) Choose a custom range at day boundaries and confirm the request uses the intended UTC start and end\. 3\) Exercise source, medium, campaign, content, term, CTA, and source type grouping; confirm each label and total\. 4\) Send an end date before the start date and unsupported grouping values; confirm a clear validation response and no stale table data\.

- Evidence strength: A
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:1bb5858d1f82890d77060b611520da5fa348df99bb247b44781e6601fd73de80`: PR \#1338 (pull-request) -> Attribution React route (code-symbol) -> GET admin attribution endpoint (api-endpoint) -> validated request (api-endpoint) -> stats handler (code-symbol) -> admin attribution workflow (workflow) -> filter/group requirements (requirement)
Evidence: `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374`, `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c`
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Http/Request/Admin/GetUtmAttributionStatsRequest.php>
Reference `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c` (golden\_fixture)
- Source: `repository://packages/evaluation/fixtures/hi-events-pr-1338.golden.json`
### HIGH - Revenue by currency

Revenue totals are no longer one assumed USD value; rows can show several currencies, so missing or merged currency totals would mislead administrators\. The API response changes from total\_revenue to revenue\_by\_currency and the UI renders one formatted amount per returned currency\. Recommended checks: 1\) Use fixture accounts with orders in two currencies and confirm each currency appears separately with the correct amount\. 2\) Confirm a row with no revenue displays an intentional empty state rather than USD zero\. 3\) Change grouping and pagination while multi\-currency rows are visible; confirm totals do not move between attribution values\.

- Evidence strength: B
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:961294a20b7301a0b36a6c3086821766ff4dc6e3dee117aa4644e53200aaff7e`: PR \#1338 (pull-request) -> account attribution repository (code-symbol) -> stats handler (code-symbol) -> admin API client (code-symbol) -> revenue cell (ui-element)
Evidence: `evidence:v1:6cd2ee7c63e59318a26a636e6efdbffb83614cecd43e415e1826ae00aedbd84b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25`
Reference `evidence:v1:6cd2ee7c63e59318a26a636e6efdbffb83614cecd43e415e1826ae00aedbd84b` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/api/admin.client.ts>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Repository/Eloquent/AccountAttributionRepository.php>
### MEDIUM - Paid, organic, referral, and unattributed classification

Account\-source categories and summary cards may shift because classification and historical attribution data are reworked\. The pull request introduces a source classifier, changes account creation attribution handling, and includes a data reclassification migration\. Recommended checks: 1\) Create representative paid, organic, referral, and unattributed accounts and confirm exactly one category per account\. 2\) Compare summary cards with the paginated table for the same date range\. 3\) Run the migration on a disposable copy and compare category totals before and after; retain the migration log privately\.

- Evidence strength: B
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:84c327b413c7ab2e2e2ca1a8d0a3b5a567901d6d3e2b87a821243a18acd32cc8`: PR \#1338 (pull-request) -> account creation handler (code-symbol) -> source classifier (code-symbol) -> attribution repository (code-symbol) -> summary cards (screen)
Evidence: `evidence:v1:6ddfa7e96eca01f1f4586c1eb0bf2637460b1b3d6e81b8d13131d5f2f2731692`, `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25`, `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`
Reference `evidence:v1:6ddfa7e96eca01f1f4586c1eb0bf2637460b1b3d6e81b8d13131d5f2f2731692` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Services/Domain/Account/AttributionSourceClassifier.php>
Reference `evidence:v1:ee452dbd88ddc83ea6dd57046fa5c3c41741864f90896c7a0bb55951ae04ae25` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Repository/Eloquent/AccountAttributionRepository.php>
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>
### HIGH - Admin attribution filters remain correct

The reviewed requirement expects administrators to filter and group attribution analytics correctly\. The same cross\-stack evidence makes date\-range, grouping, and validation behavior a high\-priority acceptance check\.

- Evidence strength: A
- Changed symbols: 1
- Inspectable paths: 1

Path `sha256:1bb5858d1f82890d77060b611520da5fa348df99bb247b44781e6601fd73de80`: PR \#1338 (pull-request) -> Attribution React route (code-symbol) -> GET admin attribution endpoint (api-endpoint) -> validated request (api-endpoint) -> stats handler (code-symbol) -> admin attribution workflow (workflow) -> filter/group requirements (requirement)
Evidence: `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b`, `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a`, `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374`, `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c`
Reference `evidence:v1:f9a3b2d8f3dc961aa9c7de0e114ce15bd4f4e05bfb24ff3089faf53a4b1a940b` (public\_pr)
- Source: <https://github.com/HiEventsDev/Hi.Events/pull/1338>
Reference `evidence:v1:932ed4cb37770c818e02f482ee0c7a6d6d5ac277af2ff424aa8a4cf3e246497a` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx>
Reference `evidence:v1:cf76880aede4ccb5ac0960047ad86308c6476c27c46e9b1d26a6c98d96033374` (public\_diff)
- Source: <https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Http/Request/Admin/GetUtmAttributionStatsRequest.php>
Reference `evidence:v1:b6d8092825eeb583edbd6c0996bf8a86ddf0a2318d9efbc92340b47ffafabd7c` (golden\_fixture)
- Source: `repository://packages/evaluation/fixtures/hi-events-pr-1338.golden.json`
### UNKNOWN - PR\-head runtime behavior was not verified

No trusted Render deployment registration for the exact head SHA was supplied, so Sentinel cannot claim the changed filters or aggregation ran successfully in a browser\. Operator action: Register and attest a disposable PR\-head deployment, then run the bounded affected scenarios and one checkout control\.

- Evidence strength: D
- Changed symbols: 0
- Inspectable paths: 0
### UNKNOWN - This reference report is not an active graph publication

The report is generated from the committed human\-reviewed golden fixture and public diff metadata, not a persisted Neo4j assessment run\. Operator action: Use this artifact to review report shape; do not use its risk labels as production release evidence\.

- Evidence strength: D
- Changed symbols: 0
- Inspectable paths: 0
### UNKNOWN - Authoritative product requirements are limited

The public PR diff describes implementation changes, but a separately approved product specification for every attribution behavior was not available\. Operator action: Have a product owner confirm the expected date, grouping, classification, and currency behavior before treating those statements as acceptance criteria\.

- Evidence strength: D
- Changed symbols: 0
- Inspectable paths: 0

## Recommended QA scenarios

- ui interaction for Date and grouping filters; checkpoints: `screen:v1:4b3eb7a6dc75cc850e62028bdf28e412c2eabb3d64c5df9fddf3b27a76f8f0a4`
- ui interaction for Revenue by currency; checkpoints: `ui-element:v1:f5f1f1ffa720ed2aa96d875db5b94be4e72a62b840d0c48065be7f2da67411a5`
- workflow checkpoint for Paid, organic, referral, and unattributed classification; checkpoints: `workflow:v1:6f5d85bec35bb5b7e0f0875e66d9d86e9ae5b99ddcf20063a5b5f975d1b50b17`
- requirement acceptance for Admin attribution filters remain correct; checkpoints: `requirement:v1:bf56cd25d9ba89ea3872d50fc1ff6839d81fdfdb5b428be3dd45e5f214b6adfb`

## Verification results

No trusted pull\-request head deployment was registered for this sample run\. (status: verification_unavailable; version: 0)

## Unknowns, exclusions, and stale or missing evidence

- No trusted Render deployment registration for the exact head SHA was supplied, so Sentinel cannot claim the changed filters or aggregation ran successfully in a browser\. Operator action: Register and attest a disposable PR\-head deployment, then run the bounded affected scenarios and one checkout control\. [`sha256:0711988c917da9007149374c5b717bc0f32d5d964dd31c234a9e9200e59d0277`]
- The report is generated from the committed human\-reviewed golden fixture and public diff metadata, not a persisted Neo4j assessment run\. Operator action: Use this artifact to review report shape; do not use its risk labels as production release evidence\. [`sha256:22bdf324215710751b1ef3bb073d55617e34a380d72227ff14fc1d444f5035d7`]
- The public PR diff describes implementation changes, but a separately approved product specification for every attribution behavior was not available\. Operator action: Have a product owner confirm the expected date, grouping, classification, and currency behavior before treating those statements as acceptance criteria\. [`sha256:8c41d3bf966a4de5a0767bf22c705dde55eb2cfb6748dd02fb5950071268e6ab`]
- Excluded: Control flow Ticket checkout order creation: The reviewed attribution evidence path does not traverse the public order\-creation workflow\. Keep one checkout smoke as an environment control; this is not a claim that checkout has zero risk\.
- Excluded: This is deterministic reference output from the SNT\-033 golden fixture, not a live model, browser, database, or Neo4j run\.
- Excluded: The product report pipeline and incremental refresh are implemented; this committed sample uses deterministic fallback wording rather than a persisted live assessment\.
- Excluded: SNT\-031 dynamic trusted\-head verification is not implemented on this revision, so verification remains unavailable\.
- Excluded: No private screenshot, trace, credential, signed artifact URL, or production data is embedded\.
- Excluded: Risk labels prioritize the reviewed narrow slice and are not calibrated probabilities or a declaration that the pull request is unsafe\.

## Report generation

- Generated at: 2026-09-09T12:00:00.000Z
- Report ID: `sha256:a7c3b08efa54ac7dd5d0dcdfa380c4c041ad50fdd0732327759d1f7c65cb68f3`
- Policy: `blast-radius-policy-v1`
- Template: `assessment-report-v1`
- Wording prompt: `report-wording-v1`
- Wording mode: deterministic_fallback
