import { Toast } from '@ui5/webcomponents-react/Toast';

// Shared success / confirmation toast (fiori-ux.md, Destructive Actions):
// transient feedback that survives the follow-up list reload, unlike an
// inline MessageStrip. Fully controlled: `message` non-empty opens it, the
// component's close event (auto after `duration`, or on user dismissal)
// calls onClose so the owner clears the message. Pair with useFeedback,
// which routes Positive / Information notices here and the rest to a strip.
export function AdopsToast({ message, onClose, duration = 4000, placement = 'BottomCenter' }) {
  return (
    <Toast open={Boolean(message)} duration={duration} placement={placement} onClose={onClose}>
      {message || ''}
    </Toast>
  );
}

export default AdopsToast;
