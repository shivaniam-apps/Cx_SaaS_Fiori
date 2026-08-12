# AdoptOps Architecture Rules

AdoptOps is a multi-system SAP SaaS application. Changes must preserve the
separation between the React frontend, CAP application layer and SAP S/4HANA backend.

## Layers

Frontend
- React
- UI5 Web Components for React
- Responsible for presentation, interaction and lightweight UI state
- Must not perform heavy business-data aggregation

CAP
- Application/API orchestration layer
- Performs cross-service orchestration where appropriate
- Provides APIs optimised for the frontend
- Enforces application-level validation and tenant/system context

SAP S/4HANA
- RAP/CDS/OData V4
- ZADO namespace
- Performs SAP-native data selection, filtering and business operations
- Expensive SAP queries should be reduced as close to S/4HANA as practical

Do not duplicate business logic across React, CAP and S/4HANA — implement it
once, in the layer responsible for it.

## Design Direction

Prefer:

React
  -> purpose-built CAP endpoint
     -> efficient SAP query/CDS/API

over:

React
  -> several broad CAP calls
     -> download large datasets
     -> aggregate/filter in browser

## Shared Contracts

The following are cross-workstream contracts unless proven otherwise:

- Target System model
- destination resolution
- Location ID handling
- navigation/filter state
- proposal review-status semantics
- activation step-status semantics
- background task status semantics
- shared CAP service definitions
- shared CDS entities
- shared React components
- authentication/tenant context
- global settings/defaults

Before changing one of these, identify all consumers.

Avoid hard-coded environment-specific system identifiers; use configured
target-system metadata as the source of system identity.

## Backward Compatibility

Do not rename or remove:
- CDS properties
- CAP endpoints
- navigation parameters
- persisted fields
- settings properties

without first checking all consumers and migration impact.

## Reuse

Before creating a new:
- component
- hook
- service
- formatter
- filter model
- API wrapper

search for an existing equivalent.

Prefer improving a reusable abstraction over creating page-specific duplication,
provided the abstraction is genuinely shared.
