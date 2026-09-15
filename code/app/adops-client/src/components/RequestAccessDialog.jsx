import { useEffect, useState } from 'react';
import { Button } from '@ui5/webcomponents-react/Button';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Label } from '@ui5/webcomponents-react/Label';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Option } from '@ui5/webcomponents-react/Option';
import { Select } from '@ui5/webcomponents-react/Select';
import { Text } from '@ui5/webcomponents-react/Text';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
import {
  submitAccessRequest,
  getServiceErrorMessage
} from '../services/accessRequestService.js';
import {
  ACCESS_REQUEST_AREAS,
  ACCESS_REQUEST_URGENCIES,
  isTierUnavailableError,
  requesterLabel
} from '../features/auth/accessRequestModel.js';

// Request-access entry point, opened from a restricted page. The technical
// context (area, role, requester) is filled in server-side and shown
// read-only; the user provides only the business fields.
export function RequestAccessDialog({ open, area, userInfo, onClose, onSubmitted, onTierUnavailable }) {
  const [justification, setJustification] = useState('');
  const [urgency, setUrgency] = useState('NORMAL');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [receipt, setReceipt] = useState(null);

  const areaConfig = ACCESS_REQUEST_AREAS[area] || { label: area, role: 'Admin', roleLabel: 'Administrator' };
  const justificationMissing = !justification.trim();

  // Reset on every open so a second request never shows the previous receipt.
  useEffect(() => {
    if (!open) return;
    setJustification('');
    setUrgency('NORMAL');
    setSubmitError('');
    setReceipt(null);
  }, [open]);

  const submit = async () => {
    if (justificationMissing || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await submitAccessRequest({
        area,
        role: areaConfig.role,
        justification: justification.trim(),
        urgency
      });
      setReceipt(result);
      onSubmitted?.(result);
    } catch (error) {
      if (isTierUnavailableError(error)) {
        onTierUnavailable?.();
        onClose();
        return;
      }
      setSubmitError(getServiceErrorMessage(error, 'Your access request could not be submitted. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} headerText="Request Access" onClose={onClose}>
      <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '24rem', maxWidth: '36rem' }}>
        {receipt ? (
          <>
            <MessageStrip design="Positive" hideCloseButton>
              Access request <strong>{receipt.referenceNumber}</strong> submitted.
            </MessageStrip>
            <Text>An AdoptOps administrator will review it. You can check its status on this page.</Text>
          </>
        ) : (
          <>
            {submitError ? <MessageStrip design="Negative" hideCloseButton>{submitError}</MessageStrip> : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--adops-space-md)', rowGap: 'var(--adops-space-xs)' }}>
              <Label>Requested area</Label>
              <Text>{areaConfig.label}</Text>
              <Label>Role to be granted</Label>
              <Text>{areaConfig.roleLabel}</Text>
              <Label>Requester</Label>
              <Text>{requesterLabel(userInfo)}</Text>
            </div>

            <Label required>Business justification</Label>
            <TextArea
              value={justification}
              rows={5}
              required
              maxlength={2000}
              placeholder="Why do you need this access, and for which systems or tasks?"
              onInput={(e) => setJustification(e.target.value)}
            />

            <Label>Urgency</Label>
            <Select onChange={(e) => setUrgency(e.detail.selectedOption.dataset.value || 'NORMAL')}>
              {ACCESS_REQUEST_URGENCIES.map((option) => (
                <Option key={option.id} data-value={option.id} selected={option.id === urgency}>{option.label}</Option>
              ))}
            </Select>
          </>
        )}
      </div>
      <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
        {receipt ? (
          <Button design="Emphasized" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button design="Transparent" disabled={submitting} onClick={onClose}>Cancel</Button>
            <Button design="Emphasized" disabled={justificationMissing || submitting} onClick={submit}>
              {submitting ? 'Submitting…' : 'Submit Request'}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

export default RequestAccessDialog;
