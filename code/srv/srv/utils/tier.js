const cds = require('@sap/cds');

const KNOWN_TIERS = new Set(['basic', 'standard', 'enterprise']);

function currentTier() {
  const fromEnv = (process.env.ADOPTOPS_TIER || process.env.adops_TIER || '').toLowerCase();
  if (KNOWN_TIERS.has(fromEnv)) return fromEnv;

  const profiles = cds.env?.profiles || [];
  if (profiles.includes('basic')) return 'basic';
  if (profiles.includes('standard')) return 'standard';
  if (profiles.includes('enterprise')) return 'enterprise';
  return 'basic';
}

function dbMode() {
  const explicit = (process.env.ADOPTOPS_DB_MODE || '').toLowerCase();
  if (explicit) return explicit;
  if (cds.env?.profiles?.includes('development')) return 'sqlite';
  return ({ basic: 'postgres', standard: 'postgres', enterprise: 'hana' })[currentTier()];
}

function isDatabaseLess() {
  return dbMode() === 'none';
}

function isTenantAutomationEnabled() {
  if (String(process.env.ADOPTOPS_TENANT_AUTOMATION || '').toLowerCase() === 'false') return false;
  return currentTier() === 'enterprise';
}

module.exports = {
  currentTier,
  dbMode,
  isDatabaseLess,
  isTenantAutomationEnabled
};
