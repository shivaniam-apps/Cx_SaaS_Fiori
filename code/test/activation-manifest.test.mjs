import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildActivationManifest, renderManifestMarkdown } = require('../srv/srv/utils/activation-manifest.js');
const { deriveActivationSteps } = require('../srv/srv/utils/activation-plan.js');

const PROPOSALS = [
  { ID: 'p1', FioriId: 'F3893', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' },
  { ID: 'p2', FioriId: 'F0842A', BusinessRoleId: 'SAP_BR_PURCHASER' }
];

function fixture() {
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave 1' });
  return buildActivationManifest({
    plan: { ID: 'plan-1', Name: 'Activation of Wave 1', Status: 'COMPLETED', ExecutedBy: 'alice' },
    steps,
    wave: { ID: 'w1', Name: 'Wave 1' },
    targetSystem: { displayName: 'RD1 Development', systemId: 'RD1', client: '100' },
    transport: { TransportRequestId: 'RD1K900123', Status: 'MODIFIABLE', Description: 'Wave 1' }
  });
}

describe('activation manifest (QA/PROD replay runbook)', () => {
  it('splits steps into transportable content and per-system replay', () => {
    const manifest = fixture();
    const transportableTypes = manifest.transportable.map((e) => e.stepType);
    const replayTypes = manifest.localReplay.map((e) => e.stepType);

    expect(transportableTypes).to.include.members(['CREATE_SPACE', 'CREATE_PAGE', 'CREATE_PFCG_ROLE', 'ADD_TO_TRANSPORT']);
    expect(transportableTypes).to.not.include('ACTIVATE_ICF_NODE');
    expect(replayTypes).to.include.members(['RUN_TASK_LIST', 'ACTIVATE_ODATA_SERVICE', 'ACTIVATE_ICF_NODE']);
    expect(replayTypes).to.not.include('CREATE_PFCG_ROLE');
    // No step may be lost: every step is in at least one section.
    expect(manifest.transportable.length + manifest.localReplay.length).to.be.at.least(12);
  });

  it('gives every entry a verification line and every replay entry an action', () => {
    const manifest = fixture();
    for (const entry of [...manifest.transportable, ...manifest.localReplay]) {
      expect(entry.verification, entry.stepType).to.be.a('string').and.not.empty;
    }
    for (const entry of manifest.localReplay) {
      expect(entry.action, entry.stepType).to.be.a('string').and.not.empty;
    }
    const icf = manifest.localReplay.find((e) => e.stepType === 'ACTIVATE_ICF_NODE');
    expect(icf.action).to.match(/IRREVERSIBLE/);
  });

  it('parses object keys and survives broken ObjectKeyJson', () => {
    const manifest = buildActivationManifest({
      plan: { ID: 'p', Name: 'X', Status: 'DRAFT' },
      steps: [{ SequenceNo: 1, StepType: 'ACTIVATE_ICF_NODE', ObjectName: 'F1', StepGroup: 'SERVICE', Status: 'PENDING', Transportable: false, LocalReplay: true, ObjectKeyJson: 'not json' }],
      wave: null, targetSystem: null, transport: null
    });
    expect(manifest.localReplay[0].objectKey).to.equal(null);
    expect(manifest.transport).to.equal(null);
  });

  it('renders a markdown runbook with the three sections and checkboxes', () => {
    const markdown = renderManifestMarkdown(fixture());
    expect(markdown).to.include('# Activation replay manifest — Activation of Wave 1');
    expect(markdown).to.include('Transport request: RD1K900123');
    expect(markdown).to.include('## 1. Arrives via transport');
    expect(markdown).to.include('## 2. Per-system replay');
    expect(markdown).to.include('- [ ] CREATE_PFCG_ROLE');
    expect(markdown).to.match(/\d+\. \[ \] Activate the ICF node/);
    expect(markdown).to.include('assignments are client-local');
  });

  it('renders sensible empty states', () => {
    const markdown = renderManifestMarkdown(buildActivationManifest({
      plan: { ID: 'p', Name: 'Empty', Status: 'DRAFT' },
      steps: [], wave: null, targetSystem: null, transport: null
    }));
    expect(markdown).to.include('_No transportable content in this plan._');
    expect(markdown).to.include('_No local-replay steps in this plan._');
  });
});
