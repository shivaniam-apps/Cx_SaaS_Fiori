import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSource, formatFindings } from './staticAudit.js';
import { auditClientSources } from '../../../scripts/a11y-audit.mjs';

const reasons = (source) => auditSource(source).map((f) => `${f.tag}:${f.reason}`);

test('icon-only buttons are flagged, buttons with text or an accessible name are not', () => {
  assert.deepEqual(reasons('<Button icon="add" onClick={() => go()} />'), ['Button:icon-only button needs accessibleName']);
  assert.deepEqual(reasons('<Button icon="add"></Button>'), ['Button:icon-only button needs accessibleName']);
  assert.deepEqual(reasons('<Button icon="add" accessibleName="Add system" />'), []);
  assert.deepEqual(reasons('<Button icon="add">Add</Button>'), []);
  assert.deepEqual(reasons('<Button design="Transparent" onClick={(e) => e.stopPropagation()}>{label}</Button>'), []);
  assert.deepEqual(reasons('<Button icon="add"><Icon name="x" mode="Decorative" /></Button>'), ['Button:icon-only button needs accessibleName']);
});

test('fields need a linked Label, an accessible name or a reference', () => {
  assert.equal(reasons('<Input value={x} />').length, 1);
  assert.deepEqual(reasons('<Label for="f1">Name</Label><Input id="f1" value={x} />'), []);
  assert.deepEqual(reasons('<Input accessibleName="Name" value={x} />'), []);
  assert.deepEqual(reasons('<Select accessibleNameRef="lbl"><Option>A</Option></Select>'), []);
  assert.deepEqual(reasons('<Label>Name</Label><TextArea value={x} />'), ['TextArea:field needs a linked Label (id + for), accessibleName or accessibleNameRef']);
  assert.deepEqual(reasons('<Input id="other" /><Label for="f1">Name</Label>'), ['Input:field needs a linked Label (id + for), accessibleName or accessibleNameRef']);
});

test('toggles, tables, icons, dialogs and native fields have their own rules', () => {
  assert.deepEqual(reasons('<CheckBox checked />'), ['CheckBox:toggle needs text or accessibleName']);
  assert.deepEqual(reasons('<CheckBox text="Active" checked />'), []);
  assert.deepEqual(reasons('<Switch accessibleName="Identified usage" />'), []);
  assert.deepEqual(reasons('<Table headerRow={<TableHeaderRow />}>{rows}</Table>'), ['Table:table needs accessibleName']);
  assert.deepEqual(reasons('<Table accessibleName="Users">{rows}</Table>'), []);
  assert.deepEqual(reasons('<Icon name="home" />'), ['Icon:icon needs accessibleName or mode="Decorative"']);
  assert.deepEqual(reasons('<Icon name="home" mode="Decorative" />'), []);
  assert.deepEqual(reasons('<Dialog open>{body}</Dialog>'), ['Dialog:dialog needs headerText or accessibleName']);
  assert.deepEqual(reasons('<Dialog open headerText="New wave">{body}</Dialog>'), []);
  assert.deepEqual(reasons('<input type="file" style={{ display: "none" }} />'), ['input:native field needs aria-label or a linked label']);
  assert.deepEqual(reasons('<input type="file" aria-label="Import file" />'), []);
  assert.deepEqual(reasons('<input type="hidden" name="csrf" />'), []);
});

test('attribute scanning survives arrow functions and quotes inside the tag', () => {
  const source = `
    <Select
      accessibleName="Status"
      onChange={(e) => setDraft({ ...draft, status: e.detail.selectedOption.dataset.value || '' })}
    >
      <Option data-value=">">Greater</Option>
    </Select>
    <Table headerRow={<TableHeaderRow sticky><TableHeaderCell><span>A</span></TableHeaderCell></TableHeaderRow>}>
    </Table>`;
  const findings = auditSource(source, { file: 'x.jsx' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tag, 'Table');
  assert.equal(findings[0].line, 8);
  assert.match(formatFindings(findings), /^x\.jsx:8 <Table> /);
});

test('every page, layout and component control carries an accessible name', () => {
  const findings = auditClientSources();
  assert.equal(findings.length, 0, `unlabeled controls:\n${formatFindings(findings)}`);
});
