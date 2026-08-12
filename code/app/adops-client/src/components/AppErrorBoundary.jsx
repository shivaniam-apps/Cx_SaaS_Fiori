import React from 'react';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { Button } from '@ui5/webcomponents-react/Button';

// Keyed on the route pathname by the caller so a crash on one page never
// strands the whole app: navigating remounts a fresh boundary.
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <IllustratedMessage
        name="UnableToLoad"
        titleText="Something went wrong on this page"
        subtitleText={String(this.state.error?.message || this.state.error)}
      >
        <Button design="Emphasized" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </IllustratedMessage>
    );
  }
}

export default AppErrorBoundary;
