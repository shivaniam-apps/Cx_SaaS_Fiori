# Pseudonymisation of SAP user ids

Note for the data-protection officer and the works council. Roadmap item
A9. Status: **draft for product-owner sign-off** (see the last section).

## What AdoptOps needs and what it does not

AdoptOps proposes SAP Fiori apps from real transaction usage. For that it
needs, per transaction code, how many people use it and how intensively.
It does not need to know who they are. User identities therefore never
leave the customer's SAP system: they are replaced by pseudonyms inside
the system, before any data is transmitted.

## What leaves the S/4HANA system

| Data | Personal reference |
|---|---|
| Transaction code, execution counts, dialog steps, response times, period | none |
| Pseudonym (24 hexadecimal characters) per user and transaction code, with its execution counts | pseudonymous |
| Top-N users per transaction only (default 20), above a minimum execution count | pseudonymous, bounded |

No user name, first name, last name, e-mail address, cost centre, department
or organisational assignment is read or transmitted.

## How the pseudonym is built

The pseudonym is a SHA-256 hash, truncated to 24 hexadecimal characters,
computed inside the SAP system by the AdoptOps add-on
(`ZCL_ADO_PSEUDONYM`) over three parts:

1. **A secret** stored in the SAP system (table `ZADO_CFG`, key
   `PSEUDONYM_SECRET`), generated once per client with the report
   `ZADO_CFG_INIT`. It is never displayed, exported or transported and
   never reaches AdoptOps.
2. **The AdoptOps tenant id** of the subscriber reading the system.
3. **The SAP user id** in upper case.

Consequences:

- The same user keeps the same pseudonym across extractions, so usage can
  be aggregated per person without identifying the person.
- The same user read by two different AdoptOps tenants (for example two
  subaccounts of a group) yields two different pseudonyms; datasets cannot
  be joined across tenants.
- AdoptOps, its operator and anyone with access to the SaaS database cannot
  reverse the pseudonym and cannot try candidate user ids against it,
  because the secret is unknown outside the SAP system.
- Reversal would require access to the SAP system's `ZADO_CFG` table and
  its user master, i.e. the customer's own basis administrators, who already
  hold that data.

Without a configured secret the add-on falls back to a system-derived salt
(the system id). That still hides the identity but does not resist
guessing by someone who knows the system id and a user id list. Generating
the secret with `ZADO_CFG_INIT` in every productive client is part of the
target-system onboarding (docu/15).

## Identified mode

Identified usage (real user ids instead of pseudonyms) exists for
customers whose works-council agreement allows it. It is:

- off by default for every target system,
- switched on only by an AdoptOps administrator, per target system,
- recorded in the tamper-evident audit log as `IDENTIFIED_USAGE_CHANGED`
  with the administrator's identity, before and after state
  (docu/10, hash-chained, append-only),
- enforced in the SAP system: the add-on hashes unless the request carries
  the opt-in, and the offline export requires an explicit tick.

## Offline export

Where no connection exists, `ZADO_EXPORT_USAGE` writes the same data to a
file inside the SAP system, pseudonymised with the same secret and an
optional tenant id. AdoptOps imports the file as it would a live read. A
file exported as identified is accepted only for a target system whose
identified mode is on; otherwise AdoptOps hashes the user ids again with a
per-tenant random secret of its own (`TenantSecrets`), so an identified
file can never populate a pseudonymous system by mistake.

## Retention and deletion

Usage rows live in extraction runs. An administrator purges whole runs
(`purgeExtractionRun`), which removes the pseudonymous rows with them.
Telemetry about the AdoptOps application itself (not about SAP usage) has
its own retention settings.

## Rotation

Rotating the secret (`ZADO_CFG_INIT` with "Rotate existing secret")
changes every pseudonym; earlier snapshots no longer join with later ones.
Rotate after a suspected compromise of the SAP system's configuration data,
or when the works council asks for a break in traceability.

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Product owner | | | |
| Data-protection officer | | | |
| Works council (if applicable) | | | |

Open points for the product owner: whether the Top-N default of 20 users
per transaction is acceptable as the maximum granularity, and whether
identified mode should require a second administrator's approval.
