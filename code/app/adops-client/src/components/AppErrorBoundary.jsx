import React from 'react';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { Button } from '@ui5/webcomponents-react/Button';
import { Text } from '@ui5/webcomponents-react/Text';
import { reportRenderError } from '../services/coreService.js';

// Keyed on the route pathname by the caller so a crash on one page never
// strands the whole app: navigating remounts a fresh boundary.
//
// Every render crash is reported once (recordClientError -> ClientErrorReports)
// with the correlation id of the last request, and that reference is shown
// to the user so support can find the matching backend log lines.
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, reference: '' };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportRenderError({ error, componentStack: info?.componentStack })
      .then((receipt) => {
        if (this.state.error === error) this.setState({ reference: receipt?.correlationId || '' });
      })
      .catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <IllustratedMessage
        name="UnableToLoad"
        titleText="Something went wrong on this page"
        subtitleText={String(this.state.error?.message || this.state.error)}
      >
        <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', justifyItems: 'center' }}>
          <Button design="Emphasized" onClick={() => this.setState({ error: null, reference: '' })}>
            Try again
          </Button>
          {this.state.reference ? (
            <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>
              Reported. Reference for support: {this.state.reference}
            </Text>
          ) : null}
        </div>
      </IllustratedMessage>
    );
  }
}

export default AppErrorBoundary;
