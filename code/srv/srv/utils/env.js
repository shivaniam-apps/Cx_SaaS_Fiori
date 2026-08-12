// Single funnel for product env knobs. Lifted code arriving from ChronoPilot
// keeps its bare names; this resolves ADOPTOPS_<name>, then ADOPS_<name>,
// then the bare name — one file to change if the product is renamed again.
function envValue(name, fallback) {
    const candidates = [`ADOPTOPS_${name}`, `ADOPS_${name}`, name];
    for (const key of candidates) {
        const value = process.env[key];
        if (value !== undefined && value !== '') return value;
    }
    return fallback;
}

function envNumber(name, fallback) {
    const raw = envValue(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(name, fallback = false) {
    const raw = envValue(name);
    if (raw === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

module.exports = { envValue, envNumber, envFlag };
