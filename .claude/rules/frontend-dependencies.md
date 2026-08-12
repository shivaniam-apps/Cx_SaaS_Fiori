---
paths:
  - "code/app/adops-client/package.json"
  - "code/app/adops-client/package-lock.json"
---

# AdoptOps Client Dependency Rules

Development happens on Windows; CI and CF builds run on Linux. Vite 8's
bundler (rolldown) ships its native binary as per-platform optional
dependencies, and npm has a long-standing bug: regenerating a lockfile
while node_modules exists records ONLY the current platform's optional
binaries. The build then works everywhere locally and fails only on the
Linux runner (`Cannot find module '../rolldown-binding.linux-x64-gnu.node'`,
observed on PR #4).

After ANY change that rewrites code/app/adops-client/package-lock.json:

- Verify the lock still contains the full @rolldown/binding-* platform set
  (in particular binding-linux-x64-gnu), e.g.
  `node -e "const l=require('./package-lock.json');console.log(Object.keys(l.packages).filter(k=>k.includes('@rolldown/binding')).join('\n'))"`
- If platforms are missing, regenerate cleanly: delete BOTH node_modules
  and package-lock.json, then `npm install`. `npm install
  --package-lock-only` does NOT heal an already-stripped lock.
