---
paths:
  - "code/app/adops-client/**"
---
# AdoptOps Frontend Testing Rules

The React client (code/app/adops-client) has NO vitest, jest or
testing-library. Its `npm test` runs `node --test` over an EXPLICIT list of
files in the package.json test script.

Consequences:

- Component/DOM tests are not possible in this harness. Design testable
  logic as pure, dependency-free modules under `src/features/<area>/` and
  test those (see features/auth/accessRequestModel.js,
  features/settings/settingsViews.js). Components stay thin consumers.
- A new `*.test.js` file does NOT run until it is appended to the test
  script's file list in code/app/adops-client/package.json. Adding the
  file without registering it silently skips it.
- Feature modules under src/features must not import services, axios or
  anything touching `import.meta.env` - node --test loads them outside
  Vite.
- Do not introduce vitest/jest for a single feature; follow the existing
  pattern or raise the tooling change separately.
