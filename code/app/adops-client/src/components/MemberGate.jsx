import { useEffect, useState } from 'react';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { fetchUserInfo, getServiceErrorMessage } from '../services/coreService.js';
import { hasMemberAccess } from '../features/auth/memberAccess.js';
import RestrictedState from './RestrictedState.jsx';

// Application-level gate: identity comes from /core/userInfo (server-derived,
// reachable by role-less users). Members and above pass; everyone else sees
// the restricted state with the Request Access flow (CoreService, role-less).
export function MemberGate({ children }) {
  const [state, setState] = useState({ loading: true, userInfo: null, error: null });

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((userInfo) => {
        if (!cancelled) setState({ loading: false, userInfo, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, userInfo: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '20vh' }} />;
  }

  if (state.error) {
    return (
      <IllustratedMessage
        name="UnableToLoad"
        titleText="Sign-in check failed"
        subtitleText={getServiceErrorMessage(state.error, 'Could not read your user information.')}
      />
    );
  }

  if (!hasMemberAccess(state.userInfo)) {
    return (
      <div style={{ padding: 'var(--adops-space-md)' }}>
        <RestrictedState
          area="application"
          title="You do not have access to AdoptOps yet"
          text="AdoptOps needs the Member role. Request it here, or ask your administrator."
          userInfo={state.userInfo}
        />
      </div>
    );
  }

  return typeof children === 'function' ? children(state.userInfo) : children;
}

export default MemberGate;
