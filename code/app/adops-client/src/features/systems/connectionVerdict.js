// Pure presentation model for a target system's connection verdict: the
// rollup tag and one badge per ZADO endpoint (USAGE read service, ACTIVATE
// write unit). A live verdict from "Test Connection" wins over the verdict
// persisted on the row (lastCheckStatus / lastCheckEndpointsJson).
//
// Stage semantics come from the server (TargetConnectionCheck /
// TargetEndpointCheck in public-service.cds): the activation endpoint must
// be reachable on DEV and UNPUBLISHED on QA/PROD; EXPOSED is a safety
// finding, not a connectivity problem.

export const CONNECTION_STAGE = {
  OK: 'OK',
  DESTINATION: 'DESTINATION',
  SERVICE: 'SERVICE',
  ACTIVATION: 'ACTIVATION'
};

const SUMMARY_LABELS = {
  OK: 'Connected',
  DESTINATION: 'Destination failed',
  SERVICE: 'Service failed',
  ACTIVATION: 'Activation check failed'
};

const ENDPOINT_LABELS = { USAGE: 'Usage', ACTIVATE: 'Activation' };

const ENDPOINT_STAGES = {
  OK: { suffix: 'ok', design: 'Positive' },
  UNPUBLISHED: { suffix: 'unpublished', design: 'Information' },
  EXPOSED: { suffix: 'exposed', design: 'Critical' },
  SERVICE: { suffix: 'failed', design: 'Negative' }
};

function parseEndpoints(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Rollup for the Connection column.
export function connectionSummary(system, liveVerdict) {
  const status = liveVerdict
    ? (liveVerdict.Ok ? CONNECTION_STAGE.OK : (liveVerdict.Stage || CONNECTION_STAGE.DESTINATION))
    : (system?.lastCheckStatus || '');
  if (!status) return { status: '', label: 'Untested', design: 'Neutral' };
  return {
    status,
    label: SUMMARY_LABELS[status] || SUMMARY_LABELS.SERVICE,
    design: status === CONNECTION_STAGE.OK ? 'Positive' : 'Negative'
  };
}

// One badge per endpoint verdict, in server order (USAGE, ACTIVATE).
export function endpointBadges(system, liveVerdict) {
  const endpoints = liveVerdict ? (liveVerdict.Endpoints || []) : parseEndpoints(system?.lastCheckEndpointsJson);
  return endpoints
    .filter((e) => e && e.Endpoint)
    .map((e) => {
      const stage = ENDPOINT_STAGES[e.Stage] || ENDPOINT_STAGES.SERVICE;
      return {
        endpoint: e.Endpoint,
        stage: e.Stage || 'SERVICE',
        label: `${ENDPOINT_LABELS[e.Endpoint] || e.Endpoint} ${stage.suffix}`,
        design: stage.design,
        message: e.Message || ''
      };
    });
}
