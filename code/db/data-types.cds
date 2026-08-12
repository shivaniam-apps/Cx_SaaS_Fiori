type Percentage : Decimal(5,2) @assert.range: [0,100] @Measures.Unit : '%';
type Score      : Decimal(6,2) @assert.range: [0,100];

// Logical tenancy for the basic/standard tiers (shared PostgreSQL, per
// config/tiers.json multitenancyMode). The enterprise tier gets physical
// isolation via CAP MTX + HDI containers and simply ignores the column.
// Stamped/filtered by srv/utils/tenant-scope.js; 'GLOBAL' in single-tenant
// operation so the switch to real tenant ids is additive.
aspect tenantScoped {
  TenantId : String(60) default 'GLOBAL';
}
