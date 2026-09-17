// Parameterised usage entity (S6 parameters, A9 tenant): the CAP side passes
// only the parameters the backend's $metadata declares, so an add-on that
// predates a parameter is still read with the plain path.
import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseEntityParameterNames,
  buildParameterisedEntityPath,
  usageEntityParameters
} = require('../srv/srv/utils/s4-fiori-adapter.js');

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0"><edmx:DataServices><Schema Namespace="com.sap.gateway.srvd.zado_usage_srv.v0001">
<EntityType Name="UserTransactionUsageParameters">
  <Key><PropertyRef Name="P_TopUsers"/><PropertyRef Name="P_MinExecutions"/><PropertyRef Name="P_TenantId"/></Key>
  <Property Name="P_TopUsers" Type="Edm.Int32" Nullable="false"/>
  <Property Name="P_MinExecutions" Type="Edm.Int32" Nullable="false"/>
  <Property Name="P_TenantId" Type="Edm.String" Nullable="false" MaxLength="60"/>
  <NavigationProperty Name="Set" Type="Collection(com.sap.gateway.srvd.zado_usage_srv.v0001.UserTransactionUsageType)"/>
</EntityType>
<EntityType Name="UserTransactionUsageType"><Key><PropertyRef Name="UserKey"/></Key><Property Name="UserKey" Type="Edm.String"/></EntityType>
<EntityType Name="TransactionUsageType"><Key><PropertyRef Name="TransactionCode"/></Key><Property Name="TransactionCode" Type="Edm.String"/></EntityType>
</Schema></edmx:DataServices></edmx:Edmx>`;

describe('parameterised usage entity (S6 / A9)', () => {
  it('reads the parameter names of the entity from $metadata and nothing else', () => {
    const names = parseEntityParameterNames(METADATA, 'UserTransactionUsage');
    expect([...names]).to.deep.equal(['P_TopUsers', 'P_MinExecutions', 'P_TenantId']);
    expect(parseEntityParameterNames(METADATA, 'TransactionUsage').size).to.equal(0);
    expect(parseEntityParameterNames('', 'UserTransactionUsage').size).to.equal(0);
    expect(parseEntityParameterNames({ not: 'xml' }, 'UserTransactionUsage').size).to.equal(0);
  });

  it('formats the parameter segment like RAP expects and keeps the plain path without parameters', () => {
    const base = '/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001/UserTransactionUsage';
    expect(buildParameterisedEntityPath(base, {})).to.equal(base);
    expect(buildParameterisedEntityPath(base, undefined)).to.equal(base);
    expect(buildParameterisedEntityPath(base, { P_TopUsers: 20, P_MinExecutions: 1, P_TenantId: 'tenant-a' }))
      .to.equal(`${base}(P_TopUsers=20,P_MinExecutions=1,P_TenantId='tenant-a')/Set`);
    expect(buildParameterisedEntityPath(base, { P_TenantId: "o'brien", P_Skip: undefined }))
      .to.equal(`${base}(P_TenantId='o''brien')/Set`);
    expect(buildParameterisedEntityPath(base, { P_TopUsers: 0 })).to.equal(`${base}(P_TopUsers=0)/Set`);
  });

  it('never reads metadata in mock mode', async () => {
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    try {
      const names = await usageEntityParameters({ targetSystem: { destinationName: 'S4H_2023' }, entitySet: 'UserTransactionUsage' });
      expect(names.size).to.equal(0);
    } finally {
      delete process.env.ADOPTOPS_MOCK_S4;
    }
  });
});
