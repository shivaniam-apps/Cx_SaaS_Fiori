import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// ObjectKeyJson contract: planner <-> ABAP dispatcher <-> smoke program.
//
// The fixture is the contract. This suite parses the ABAP MIRROR in
// abap/src/activate (the two files below are copied from a4h_2023_zado in the
// PR that changes a step type or key shape) and fails when the
// dispatcher's key types or the smoke program's literals drift from it -
// the only cross-language check we can run without an ABAP system.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const fixture = require('./fixtures/activation-object-keys.json');

const here = path.dirname(fileURLToPath(import.meta.url));
const ABAP_DIR = path.resolve(here, '../../abap/src/activate');
const dispatcherSource = readFileSync(path.join(ABAP_DIR, 'zcl_ado_activate.clas.abap'), 'utf8');
const smokeSource = readFileSync(path.join(ABAP_DIR, 'zado_activate_smoke.prog.abap'), 'utf8');

// /ui2/cl_json pretty_mode-camel_case: fiori_id <-> fioriId.
const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// Contract per step type = union of every fixture shape for that type
// (ADD_TO_TRANSPORT has a create and a release variant).
function contractKeys() {
  const byType = {};
  const add = (type, key) => {
    byType[type] = new Set([...(byType[type] || []), ...Object.keys(key)]);
  };
  for (const [type, key] of Object.entries(fixture.planned)) add(type, key);
  for (const entry of Object.values(fixture.other)) add(entry.stepType, entry.key);
  return Object.fromEntries(Object.entries(byType).map(([type, set]) => [type, [...set].sort()]));
}

// TYPES: BEGIN OF ty_x_key, <field> TYPE ..., END OF ty_x_key.
function abapKeyTypes(source) {
  const types = {};
  for (const m of source.matchAll(/TYPES: BEGIN OF (ty_\w+),([\s\S]*?)END OF \1\./g)) {
    types[m[1]] = [...m[2].matchAll(/^\s*(\w+)\s+TYPE\s/gm)].map((f) => camel(f[1])).sort();
  }
  return types;
}

// WHEN 'STEP_TYPE'. DATA ls_x TYPE ty_x_key.  -> dispatchable step types
function abapDispatch(source) {
  const map = {};
  for (const m of source.matchAll(/WHEN '([A-Z_]+)'\.\s*\n\s*DATA \w+ TYPE (ty_\w+)\./g)) map[m[1]] = m[2];
  return map;
}

// lv_step_type = 'STEP_TYPE'. lv_json = |\{ "a": "{ p_x }", ... \}|.
// The ABAP string template becomes JSON by replacing embedded expressions
// with a placeholder and unescaping the braces; top-level keys are compared.
function smokeScenarios(source) {
  const map = {};
  for (const m of source.matchAll(/lv_step_type = '([A-Z_]+)'\.\s*\n\s*lv_json\s*=\s*\|(.*)\|\./g)) {
    const json = m[2]
      .replace(/(?<!\\)\{[^{}]*\}/g, 'X')   // { p_rname } -> X (inside quotes)
      .replace(/\\\{/g, '{')
      .replace(/\\\}/g, '}');
    map[m[1]] = Object.keys(JSON.parse(json)).sort();
  }
  return map;
}

describe('ObjectKeyJson contract: ABAP dispatcher mirrors the fixture', () => {
  const contract = contractKeys();
  const types = abapKeyTypes(dispatcherSource);
  const dispatch = abapDispatch(dispatcherSource);

  it('parses the dispatcher source (guards against a silent regex miss)', () => {
    expect(Object.keys(types)).to.have.length.greaterThan(4);
    expect(Object.keys(dispatch)).to.include.members(['ACTIVATE_ICF_NODE', 'CREATE_PFCG_ROLE', 'ADD_TO_TRANSPORT']);
  });

  it('deserializes every dispatchable step type into exactly the fixture fields', () => {
    for (const [stepType, typeName] of Object.entries(dispatch)) {
      expect(contract[stepType], `${stepType} is dispatched by ABAP but absent from the fixture`).to.be.an('array');
      expect(types[typeName], `${typeName} not found in the dispatcher TYPES`).to.be.an('array');
      expect(types[typeName], `${stepType} (${typeName})`).to.deep.equal(contract[stepType]);
    }
  });

  it('dispatches the step types the roadmap marks executable today', () => {
    // S3 part 2: every planner step type has an executor. The ones on
    // release-dependent SAP APIs are dispatched dynamically (call_executor).
    expect(Object.keys(dispatch).sort()).to.deep.equal([
      'ACTIVATE_ICF_NODE', 'ACTIVATE_ODATA_SERVICE', 'ADD_CATALOG_TO_ROLE', 'ADD_SPACE_TO_ROLE', 'ADD_TO_TRANSPORT',
      'APPEND_TO_TRANSPORT', 'ASSIGN_BUSINESS_CATALOG', 'ASSIGN_PAGE_TO_SPACE', 'ASSIGN_ROLE_TO_USERS', 'CREATE_PAGE',
      'CREATE_PFCG_ROLE', 'CREATE_SPACE', 'GENERATE_PROFILE', 'ROLLBACK_CREATE_PFCG_ROLE', 'ROLLBACK_GENERATE_PROFILE',
      'RUN_TASK_LIST'
    ]);
    for (const cls of ['ZCL_ADO_ACT_ODATA', 'ZCL_ADO_ACT_SPACE', 'ZCL_ADO_ACT_MENU']) {
      expect(dispatcherSource, cls).to.include(`iv_class           = '${cls}'`);
    }
  });
});

describe('ObjectKeyJson contract: zado_activate_smoke feeds planner-shaped keys', () => {
  const scenarios = smokeScenarios(smokeSource);

  it('covers transport create/append, role, profile and ICF with the planned key names', () => {
    expect(Object.keys(scenarios).sort()).to.deep.equal(['ACTIVATE_ICF_NODE', 'ADD_TO_TRANSPORT', 'APPEND_TO_TRANSPORT', 'CREATE_PFCG_ROLE', 'GENERATE_PROFILE']);
    for (const [stepType, keys] of Object.entries(scenarios)) {
      // The smoke role literal predates the engine-injected trkorr; every
      // other key must match the planned shape exactly.
      const planned = Object.keys(fixture.planned[stepType]).filter((k) => !(stepType === 'CREATE_PFCG_ROLE' && k === 'trkorr')).sort();
      expect(keys, stepType).to.deep.equal(planned);
    }
  });

  it('accepts a pasted planner row unchanged (custom scenario)', () => {
    expect(smokeSource).to.match(/lv_step_type = p_step\./);
    expect(smokeSource).to.match(/lv_json\s*=\s*p_json\./);
  });
});
