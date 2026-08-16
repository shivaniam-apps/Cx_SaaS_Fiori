import { useLocation, useNavigate } from 'react-router-dom';
import { ShellBar } from '@ui5/webcomponents-react/ShellBar';
import { SideNavigation } from '@ui5/webcomponents-react/SideNavigation';
import { SideNavigationItem } from '@ui5/webcomponents-react/SideNavigationItem';
import { SideNavigationGroup } from '@ui5/webcomponents-react/SideNavigationGroup';

// Navigation map: the four-stage journey (Discover -> Adopt -> Activate)
// plus Overview and Administration. Paths use the optional-param route
// convention so tab/detail changes never remount pages.
const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [{ text: 'Dashboard', icon: 'home', path: '/dashboard' }]
  },
  {
    label: 'Discover',
    items: [
      { text: 'Target Systems', icon: 'connected', path: '/systems' },
      { text: 'Extractions', icon: 'database', path: '/extractions' },
      { text: 'Usage Insight', icon: 'bar-chart', path: '/usage' },
      { text: 'User & Role Landscape', icon: 'group-2', path: '/landscape' }
    ]
  },
  {
    label: 'Adopt',
    items: [
      { text: 'Proposals', icon: 'lightbulb', path: '/proposals' },
      { text: 'Adoption Waves', icon: 'activities', path: '/waves' }
    ]
  },
  {
    label: 'Activate',
    items: [
      { text: 'Activation Plans', icon: 'workflow-tasks', path: '/activation' },
      { text: 'Activation Runs', icon: 'sys-monitor', path: '/activation-runs' },
      { text: 'Transports', icon: 'shipping-status', path: '/transports' }
    ]
  },
  {
    label: 'Administration',
    items: [
      { text: 'Settings', icon: 'action-settings', path: '/settings' },
      { text: 'Audit Log', icon: 'log', path: '/audit-log' },
      { text: 'Access Requests', icon: 'employee', path: '/access-requests' },
      { text: 'Product Insights', icon: 'performance', path: '/product-insights' }
    ]
  }
];

function selectedPath(pathname) {
  const all = NAV_GROUPS.flatMap((group) => group.items);
  const hit = all.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
  return hit?.path || '/dashboard';
}

export function AdopsShell({ userInfo, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const current = selectedPath(location.pathname);

  return (
    <div className="adops-app">
      <ShellBar
        primaryTitle="AdoptOps"
        secondaryTitle="Fiori adoption, from evidence to activation"
        onLogoClick={() => navigate('/dashboard')}
        accessibilityAttributes={{ logo: { name: 'AdoptOps home' } }}
      />
      <div className="adops-body">
        <SideNavigation
          onSelectionChange={(event) => {
            const path = event.detail.item.dataset.path;
            if (path) navigate(path);
          }}
        >
          {NAV_GROUPS.map((group) => (
            <SideNavigationGroup text={group.label} expanded key={group.label}>
              {group.items.map((item) => (
                <SideNavigationItem
                  key={item.path}
                  text={item.text}
                  icon={item.icon}
                  data-path={item.path}
                  selected={current === item.path}
                />
              ))}
            </SideNavigationGroup>
          ))}
        </SideNavigation>
        <main className="adops-content">{children}</main>
      </div>
    </div>
  );
}

export default AdopsShell;
