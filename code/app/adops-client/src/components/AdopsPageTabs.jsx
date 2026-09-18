import { Icon } from '@ui5/webcomponents-react/Icon';

import './AdopsPageTabs.css';

// Page-level tab strip (Fiori icon-tab-bar look) for pages with tabbed
// sub-views (Settings, Product Insights). Selection is fully controlled -
// pass the active id and handle onSelect (usually a route change) - so it
// works as a navigation surface, unlike the v2 TabContainer which owns its
// own selection state (fiori-ux.md, Page-Level Tabs). Roving tabindex with
// Arrow/Home/End keys and an optional numeric badge per tab.
export default function AdopsPageTabs({ tabs = [], activeTabId, onSelect, ariaLabel, className = '' }) {
  const handleKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'ArrowRight') nextIndex = Math.min(tabs.length - 1, currentIndex + 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    const next = tabs[nextIndex];
    if (!next || next.id === activeTabId) return;
    onSelect?.(next.id);
    event.currentTarget.closest('[role="tablist"]')
      ?.querySelector(`[data-page-tab="${next.id}"]`)
      ?.focus();
  };

  return (
    <div className={`adops-page-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const showBadge = Number.isInteger(tab.badge) && tab.badge > 0;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-page-tab={tab.id}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={isActive ? 'active' : ''}
            onKeyDown={handleKeyDown}
            onClick={() => { if (!isActive) onSelect?.(tab.id); }}
          >
            {tab.icon ? <Icon mode="Decorative" name={tab.icon} /> : null}
            <span>{tab.label}</span>
            {showBadge ? (
              <span className="adops-page-tabs-badge" aria-label={`${tab.badge} pending`}>
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
