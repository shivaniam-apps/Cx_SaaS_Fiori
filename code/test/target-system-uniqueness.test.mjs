// Unique destination per target system (O11 / I6): the destination name is
// the persisted routing identity, so a second row on the same destination in
// the tenant is refused on both services that let Admins edit TargetSystems.
import { expect } from 'chai';
import { test, as, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

describe('target system destination uniqueness', function () {
  this.timeout(30000);

  const DEST = 'UNIQ_DEV_100';
  let firstId;
  let secondId;

  before(async () => {
    expectInMemoryDb();
    const first = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'Uniqueness A', destinationName: DEST, systemId: 'UQA', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(first.status, JSON.stringify(first.data)).to.equal(201);
    firstId = first.data.ID;
    const second = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'Uniqueness B', destinationName: 'UNIQ_QAS_100', systemId: 'UQB', client: '100', environment: 'QAS'
    }, json('alice'));
    expect(second.status, JSON.stringify(second.data)).to.equal(201);
    secondId = second.data.ID;
  });

  it('refuses a second system on the same destination (create, both services)', async () => {
    const viaPublic = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'Duplicate', destinationName: `  ${DEST} `, environment: 'DEV'
    }, json('alice'));
    expect(viaPublic.status).to.equal(409);
    expect(viaPublic.data?.error?.message).to.include(DEST).and.include('Uniqueness A');

    const viaAdmin = await test.axios.post('/catalog/AdminService/TargetSystems', {
      displayName: 'Duplicate', destinationName: DEST, environment: 'DEV'
    }, json('alice'));
    expect(viaAdmin.status).to.equal(409);
  });

  it('refuses moving a system onto another system\'s destination, allows its own', async () => {
    const stolen = await test.axios.patch(`/fiori/TargetSystems(${secondId})`, { destinationName: DEST }, json('alice'));
    expect(stolen.status).to.equal(409);

    const own = await test.axios.patch(`/fiori/TargetSystems(${firstId})`, { destinationName: DEST, displayName: 'Uniqueness A (renamed)' }, json('alice'));
    expect(own.status, JSON.stringify(own.data)).to.equal(200);

    const untouched = await test.axios.patch(`/fiori/TargetSystems(${secondId})`, { displayName: 'Uniqueness B (renamed)' }, json('alice'));
    expect(untouched.status, JSON.stringify(untouched.data)).to.equal(200);
  });

  it('requires a destination name and trims it', async () => {
    const empty = await test.axios.post('/fiori/TargetSystems', { displayName: 'No destination', destinationName: '   ', environment: 'DEV' }, json('alice'));
    expect(empty.status).to.equal(400);
    const missing = await test.axios.post('/fiori/TargetSystems', { displayName: 'No destination', environment: 'DEV' }, json('alice'));
    expect(missing.status).to.equal(400);

    const padded = await test.axios.post('/fiori/TargetSystems', { displayName: 'Padded', destinationName: '  UNIQ_PRD_100  ', environment: 'PRD' }, json('alice'));
    expect(padded.status, JSON.stringify(padded.data)).to.equal(201);
    const reread = await test.axios.get(`/fiori/TargetSystems(${padded.data.ID})`, as('carol'));
    expect(reread.data.destinationName).to.equal('UNIQ_PRD_100');
  });
});
