const crypto = require('node:crypto');

// Secret-bearing key names that must never reach the telemetry store. Applied
// to free text (messages, stack traces) as `key ... value` patterns and to
// bare token shapes.
const SECRET_KEY_PATTERN = [
    'authorization',
    'cookie',
    'set-cookie',
    'access[_-]?token',
    'refresh[_-]?token',
    'id[_-]?token',
    'client[_-]?secret',
    'password',
    'passwd',
    'api[_-]?key',
    'x-api-key',
    'csrf[_-]?token',
].join('|');

// `authorization: Bearer xyz`, `password=abc`, `"api_key": "abc"` etc.
const SECRET_ASSIGNMENT_REGEX = new RegExp(
    `((?:${SECRET_KEY_PATTERN})["']?\\s*[:=]\\s*)((?:["'][^"']*["'])|(?:(?:bearer|basic)\\s+)?[^\\s;,&"']+)`,
    'gi'
);

// Bearer/Basic credentials appearing without a key name.
const BEARER_REGEX = /\b(bearer|basic)\s+[a-z0-9\-_.~+/]+=*/gi;

// JWT-shaped blobs (three base64url segments).
const JWT_REGEX = /\b[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{4,}\b/g;

const NEWLINE_CODE = 10;
const TAB_CODE = 9;
const DELETE_CODE = 127;

// Strip control characters (newline and tab survive for stack traces),
// then bound the length. Implemented as a code-point filter to keep the
// source free of literal control characters.
function clampText(value, maxLength) {
    let text = '';
    for (const ch of String(value ?? '')) {
        const code = ch.codePointAt(0);
        const isControl = (code < 32 && code !== NEWLINE_CODE && code !== TAB_CODE) || code === DELETE_CODE;
        if (!isControl) text += ch;
    }
    text = text.trim();
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redactSensitiveText(value) {
    return String(value ?? '')
        .replace(SECRET_ASSIGNMENT_REGEX, '$1[REDACTED]')
        .replace(BEARER_REGEX, '$1 [REDACTED]')
        .replace(JWT_REGEX, '[REDACTED]');
}

// Keep only the path portion of a failed endpoint: query strings can carry
// tokens or business data and are dropped entirely rather than sanitized.
function sanitizeEndpointPath(value, maxLength = 300) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const withoutQuery = raw.split(/[?#]/)[0];
    try {
        // Absolute URLs lose host/credentials; relative paths pass through.
        const parsed = new URL(withoutQuery, 'http://internal');
        return clampText(parsed.pathname, maxLength);
    } catch {
        return clampText(withoutQuery, maxLength);
    }
}

// Stable grouping key for repeated occurrences of the same error. Volatile
// parts (numbers, uuids, hex ids, quoted values) are normalized away so
// "timeout after 5012ms" and "timeout after 4998ms" group together.
function normalizeForFingerprint(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
        .replace(/0x[0-9a-f]+/g, '<hex>')
        .replace(/\d+/g, '<n>')
        .replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '<str>')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstStackFrame(stackTrace) {
    const lines = String(stackTrace ?? '').split('\n').map((line) => line.trim());
    return lines.find((line) => /^at\s|@|:\d+:\d+/.test(line)) || '';
}

function buildErrorFingerprint({ errorType, errorMessage, stackTrace, route, endpointPath, httpStatus }) {
    const material = [
        normalizeForFingerprint(errorType),
        normalizeForFingerprint(errorMessage),
        normalizeForFingerprint(firstStackFrame(stackTrace)),
        normalizeForFingerprint(route),
        normalizeForFingerprint(endpointPath),
        httpStatus ? String(httpStatus) : '',
    ].join('||');
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 40);
}

module.exports = {
    clampText,
    redactSensitiveText,
    sanitizeEndpointPath,
    normalizeForFingerprint,
    buildErrorFingerprint,
};
