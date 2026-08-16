---
paths:
  - "code/app/**"
---
# AdoptOps SAP Fiori UX Rules

AdoptOps must provide a consistent SAP Fiori-oriented enterprise experience.

## UI Technology

Prefer:
- UI5 Web Components for React
- existing project components
- SAP Fiori patterns

Avoid introducing another UI framework merely to solve a local styling problem.

## React-Implemented "UI5" Components

Several @ui5/webcomponents-react components are plain React divs, NOT web
components — ObjectStatus, FilterBar, AnalyticalTable and ObjectPage among
them. They carry `data-component-name` attributes and CSS-module classes,
and their internals live in the LIGHT DOM. Consequences:

- Tag selectors such as `ui5-object-status` NEVER match; that CSS is
  silently dead (a "fix" against ui5-object-status shipped in this repo
  and never applied). Style them via
  `div[data-component-name='ObjectStatus']`.
- ObjectStatus contains screen-reader-only spans ("Object Status", state
  texts like "Invalid entry") hidden by a single-class library rule. Any
  broader descendant `span` rule outranks that class and paints those
  spans over the visible value — the garbled/overlapping status text.
  Scope label/typography rules to direct children, never to all spans.
- FilterBar lays out filter items with internal negative margins that
  assume a padded host (the DynamicPage header provides one). A custom
  card hosting it must carry its own inset or the first column of labels
  and controls is clipped by the card edge.

## Page Structure

Pages should consistently organise:
1. breadcrumbs where applicable
2. page title and primary actions
3. filter/selection area where applicable
4. content
5. contextual messages close to the affected content

Reuse the common page shell/header when one exists.

Header action toolbars (ui5-toolbar) slot only toolbar-item elements; plain
text or ui5-text children are silently dropped (no slot assigned, rendered
0x0). Non-interactive captions/metadata belong beside the toolbar, in the
title subheading, or in a tooltip - never as toolbar children.

## Page-Level Tabs

Pages with tabbed sub-views (Settings, Product Insights, Favorites &
Recent) use the shared AdopsPageTabs component, not ui5 TabContainer:
v2 TabContainer owns its own selection state, which fights route-driven
(controlled) selection - the same v2 friction class as dialogs/toasts.
AdopsPageTabs is fully controlled (activeTabId + onSelect), keyboard
accessible, and supports count badges.

When tabs represent navigable sub-views, back them with routes (one
`/page/:view?` route so tab switches never remount the page - see
/settings/:view?) and derive tab metadata from a pure module in
src/features so it is testable.

## Secondary Guidance Belongs Behind (i)

Keep screens and dialogs lean. Additional business context - behavioural
caveats, "how this works" notes, scope clarifications - must NOT be rendered
as inline text blocks on the screen or in dialog bodies. Put it behind a
small (i) information Button that toggles a Popover.

- Reference implementation: AdopsNotificationRules (also TemplatesPage
  dialogs). The (i) toggles by opener identity - UI5 light dismiss ignores
  opener clicks, so an always-open handler would re-open on the closing
  click.
- Inside a MODAL dialog the Popover must render within the dialog's own
  subtree (reference: TemplatesPage `DialogInfoHint`). The modal makes the
  rest of the document inert, so a page-level shared popover self-closes
  instantly: the opener updates, `open` silently reverts, and no error is
  raised.
- Inline text stays reserved for: the one-line primary consequence of the
  dialog's action (e.g. what Copy will create), field-level help that is
  part of operating the control (e.g. "Separate tags with commas"), and
  validation/error messages next to the affected component.

## Filters

Filters must:
- represent business concepts rather than technical implementation details
- remain consistent between source and target pages
- support navigation context from Dashboard and related pages
- avoid silently discarding incoming navigation filters

Filter bar apply contract (Dashboard, Monitor Jobs; adopt for new list pages):
- The filter bar edits a DRAFT. Only Go commits the draft to the applied
  state that cards, queries and click-through navigation consume; a dropdown
  or search edit must never reshape the page by itself.
- Clear returns every filter to the variant defaults and applies immediately
  (an explicit "show everything" action, not a draft edit).
- Restore discards un-applied draft edits and resets the Adapt Filters
  layout; it must not change the applied page scope or trigger reads.
- Adapt Filters hide/reorder choices must actually persist (wire
  visibleFilterIds/filterOrder through AdopsFilterBar); a dialog whose Save
  discards its result is a defect.
- In-content scope gestures (e.g. a system row click) apply immediately AND
  write the draft, so the bar never disagrees with the page.
- Applied search/status changes are discrete commits: refetch directly, no
  keystroke debounce.
- Go applies scope and performs no re-read when nothing changed; Refresh is
  the data-recency action and re-reads at unchanged scope. Keep both; never
  merge them into one button.

## Tables and Lists

For enterprise-scale data:
- use server-side paging/filtering where available
- show loading state
- show meaningful empty state
- show actionable error state
- avoid rendering excessive records unnecessarily

## Asynchronous Operations

When the user performs an operation:
- show a busy/loading indication
- disable duplicate execution where necessary
- refresh only the affected scope when practical
- provide a useful failure message

Card-level failures should normally remain card-level.

## Destructive Actions

Delete, abort and equivalent destructive operations require confirmation.

Confirmation should explain:
- what will be affected
- the relevant object/job/schedule
- whether the operation is reversible where useful

Confirmation dialog lifecycle (AdopsConfirmDialog):
- Keep the dialog's content payload in state until the dialog reports it has
  closed; never null it while the dialog is still animating out (the content
  falls back to another action's wording mid-close).
- before-close may veto ONLY Escape-while-busy. Never veto a programmatic
  close (open prop -> false) from before-close: the event fires while React
  is still committing, so any state-based guard there races the commit and
  strands an unclosable dialog (ui5-dialog reverts its internal open to true
  while React believes it is false and never re-applies it).
- With that rule in place, releasing busy and requesting the close may share
  one commit; do not reintroduce setTimeout-split commits (the timer can
  fire before React's render task, merging the commits anyway).
- @ui5/webcomponents-react v2 dialogs have NO onAfterClose event; use
  onClose. An onAfterClose prop is silently dead.
- Success feedback for a destructive action is a MessageToast (AdopsToast);
  message strips get wiped by the follow-up list reload.
- Reference implementation: WorkflowDesignsPage (Scheduling).

## Mass Actions on Selections

A toolbar action that operates on the current selection (e.g. Delete
Selected) follows the Fiori enablement rule:

- Disabled while NO selected row is applicable. Never enabled-then-toast:
  a click that answers "none of these qualify" is a defect.
- Enabled for a mixed selection; executing applies to the applicable
  subset and the confirmation states selected/applicable/skipped counts.
- The label carries the applicable count ("Delete Selected (2)").
- Applicability comes from the same pure predicate the row-level action
  uses (features module), so button, row menu and execution always agree.
- Reference implementation: MonitorJobsPage Delete Selected +
  canBulkDeleteJob/partitionDeleteSelection in features/monitoring.

## Page Header Favorites

Pages that can be pinned to Favorites & Recent use the shared
AdopsFavoritePageAction star, placed as the LAST element of the header
action row. Do not create page-local favorite toggles.

## Navigation

Navigation must preserve intent.

Example:

Dashboard Failed Jobs
  -> Monitor Jobs
  -> relevant target system/date/status filters already applied

Do not navigate users to a broad default dataset when the source interaction
already established the intended subset.

The shell logo is the global home affordance: ShellBar logo-click navigates
to the Dashboard from every page, with an accessible name on the logo area.
At non-S breakpoints UI5 renders logo + primary title as one clickable
logo area, so both act as home.

## Terminology

Use business-facing target-system names in the UI.

Do not expose BTP destination names as the primary system label unless the
screen is specifically dealing with destination administration.
