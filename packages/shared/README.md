# Leash shared contracts

## Contract versioning

Shared HTTP and event contracts evolve additively within a version: new fields are optional, defaulted at read boundaries, and independent of serialization order. Removing, renaming, narrowing, reinterpreting, or requiring a field creates a new version. Breaking versions are served in parallel for a documented compatibility window, and old clients continue receiving their negotiated serialization.

Readers ignore unknown additive fields. Compatibility tests cover the oldest supported serialization and the latest contract before release. Control Center connector, capability, decision-extension, enforcement-evidence, and conformance types are exported from `src/control-center-contracts.ts` under `LEASH_CONTROL_CENTER_CONTRACT_VERSION`.

This package contains the public TypeScript contracts shared by Leash clients and `client-api`.

Built-in Features use stable `openleash.*` identifiers and `/v1/plugins` compatibility routes, but execute as reviewed in-process TypeScript handlers registered by `client-api`. The public product has no third-party marketplace, publisher profile, rating/download analytics, Feature image, or container protocol requirement.

Capabilities bound Feature access to instructions, recent conversation context, model evaluation, portable state, notifications, Island contributions, logs, signals, and usage. The host owns validation, redaction, scope, persistence, and presentation.

The client view model is personal-account scoped and deliberately excludes dashboard, organization policy, and identity-provider state.
