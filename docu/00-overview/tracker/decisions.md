# Decisions

Product-owner decisions the roadmap depends on. `[ ]` open, `[x]` decided (with date
and outcome). Decided entries stay here as the record.

## Open

- [ ] PO-1 Legal basis for deriving the app catalog from the SAP Fiori Apps Reference Library, or verify / license the 42-row shipped overlay — blocks S9 and proposal quality
- [ ] PO-2 Buy the BTP Audit Log service or ship with the in-app hash chain (A4) only — blocks T3; pilot proceeds on A4
- [ ] PO-3 Multitenancy timing and model (shared-schema tenantScoped discriminator recommended); fate of the [enterprise] HANA/MTX profile — blocks T1, T2
- [ ] PO-4 Service broker: README claims one, none exists; keep the claim or drop it — blocks T8

## Decided

- [x] D1 (2026-09-16) First production target is a single-tenant pilot on RD1 (activation writes to DEV client 100, usage read from PROD); multi-tenant GA follows without structural rework (shared-schema discriminator kept).
- [x] D2 (2026-09-16) Three parallel workstreams in separate worktrees; primary checkout stays on `main`.
