import { Title } from '@ui5/webcomponents-react/Title';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';

// Stand-in for pages that land in later phases; keeps every navigation
// target real from the first commit.
export function PlaceholderPage({ title, phase }) {
  return (
    <div>
      <Title level="H2">{title}</Title>
      <IllustratedMessage
        name="NoData"
        titleText={`${title} arrives in ${phase}`}
        subtitleText="This area is part of the approved implementation plan and is not built yet."
      />
    </div>
  );
}

export default PlaceholderPage;
