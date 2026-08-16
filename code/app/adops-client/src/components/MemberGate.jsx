import { useEffect, useState } from 'react';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { fetchUserInfo, getServiceErrorMessage } from '../services/coreService.js';
import { hasMemberAccess } from '../features/auth/memberAccess.js';

// Application-level gate: identity comes from /core/userInfo (server-derived,
// reachable by role-less users). Members and above pass; everyone else sees
// the restricted state. The access-request flow lands with the Settings work.
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
      <IllustratedMessage
        name="NoData"
        titleText="You do not have access to AdoptOps yet"
        subtitleText="Ask your administrator for the AdoptOps Member role."
      />
    );
  }

  return typeof children === 'function' ? children(state.userInfo) : children;
}

export default MemberGate;
