import { useEffect, useState } from 'react';
import { Button } from '@ui5/webcomponents-react/Button';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import RequestAccessDialog from './RequestAccessDialog.jsx';
import { fetchMyAccessRequests } from '../services/accessRequestService.js';
import { deriveRestrictedView, formatTimestamp } from '../features/auth/accessRequestModel.js';

// Shared restricted-content state: illustration, explanation and a Request
// Access CTA backed by the access-request workflow. Used by the shell-level
// Member gate (area 'application') and by Admin-only pages. Render it only
// for a denied user whose identity has already loaded.
export function RestrictedState({ area, title = 'Access restricted', text, userInfo }) {
  const [requests, setRequests] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tierUnavailable, setTierUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMyAccessRequests()
      .then((rows) => { if (!cancelled) setRequests(rows); })
      // Fail quiet to the plain CTA: the backend dedupes duplicate pending
      // requests, so submitting without the history is harmless.
      .catch(() => { if (!cancelled) setRequests([]); });
    return () => { cancelled = true; };
  }, [area]);

  const view = deriveRestrictedView({ requests, area, tierUnavailable });
  const { request } = view;

  const handleSubmitted = (receipt) => {
    setRequests((current) => [
      { id: receipt.ID, referenceNumber: receipt.referenceNumber, area, status: 'PENDING', requestedAt: new Date().toISOString() },
      ...(current || [])
    ]);
  };

  return (
    <div>
      <IllustratedMessage name="UnableToLoad" titleText={title} subtitleText={text}>
        {view.showCta ? (
          <Button design="Emphasized" icon="key-user-settings" onClick={() => setDialogOpen(true)}>Request Access</Button>
        ) : null}
      </IllustratedMessage>

      <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', maxWidth: '40rem', margin: '0 auto' }}>
        {view.showTierUnavailable ? (
          <MessageStrip design="Information" hideCloseButton>
            Access requests are not available in this tier. Contact your AdoptOps administrator.
          </MessageStrip>
        ) : null}
        {view.showPending ? (
          <MessageStrip design="Information" hideCloseButton>
            Access request <strong>{request.referenceNumber}</strong> is pending review
            {request.requestedAt ? ` (submitted ${formatTimestamp(request.requestedAt)})` : ''}.
          </MessageStrip>
        ) : null}
        {view.showApproved ? (
          <MessageStrip design="Positive" hideCloseButton>
            Your access request <strong>{request.referenceNumber}</strong> was approved
            {request.decidedAt ? ` on ${formatTimestamp(request.decidedAt)}` : ''}. Sign out and back in to refresh your authorizations.
          </MessageStrip>
        ) : null}
        {view.showDeclined ? (
          <MessageStrip design="Critical" hideCloseButton>
            Your access request <strong>{request.referenceNumber}</strong> was declined
            {request.decidedAt ? ` on ${formatTimestamp(request.decidedAt)}` : ''}.
            {request.decisionNotes ? ` Reviewer note: ${request.decisionNotes}` : ''}
          </MessageStrip>
        ) : null}
      </div>

      <RequestAccessDialog
        open={dialogOpen}
        area={area}
        userInfo={userInfo}
        onClose={() => setDialogOpen(false)}
        onSubmitted={handleSubmitted}
        onTierUnavailable={() => setTierUnavailable(true)}
      />
    </div>
  );
}

export default RestrictedState;
