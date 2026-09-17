// Server-side lint (roadmap A6). Same baseline as the client
// (js.configs.recommended); CommonJS for the CAP runtime and its scripts,
// ESM for the .mjs tooling and the mocha suites. cds injects the query
// builders (SELECT, INSERT, ...) as globals at runtime, so they are declared
// here instead of being required in every file.
import js from '@eslint/js';
import globals from 'globals';

const cdsGlobals = {
  SELECT: 'readonly',
  INSERT: 'readonly',
  UPDATE: 'readonly',
  UPSERT: 'readonly',
  DELETE: 'readonly',
  CREATE: 'readonly',
  DROP: 'readonly',
  cds: 'readonly'
};

export default [
  {
    ignores: [
      'gen/**', 'node_modules/**', 'app/**', 'router/**', 'db/sqlite/**', '**/*.sqlite', 'srv/gen/**',
      // Dead provisioning path (missing tenant-automator.js, undeclared
      // packages); roadmap A8 removes or declares it. Not worth fixing twice.
      'srv/srv/provisioning.js', 'srv/srv/utils/cloud-foundry.js', 'srv/srv/utils/alert-notification.js'
    ]
  },
  js.configs.recommended,
  {
    files: ['srv/**/*.js', 'scripts/**/*.js', 'check-bindings.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...cdsGlobals }
    }
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.mocha, ...cdsGlobals }
    }
  },
  {
    rules: {
      // Lifted ChronoPilot code keeps a few catch-all parameters; unused
      // arguments are noise, unused variables are still errors.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Flags only the "let x = {}; try { x = JSON.parse(..) } catch { x = {} }"
      // idiom the activation code uses deliberately.
      'no-useless-assignment': 'off'
    }
  }
];
