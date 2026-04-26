// Per-route product tours. Each entry declares a ``routePrefix`` and
// a list of steps. The ProductTour component picks the tour with the
// longest matching prefix for the current path, so page-specific
// tours supersede the global welcome.
//
// Adding a tour = append a new entry. No code changes in the
// component itself.

export interface TourStep {
  selector: string;
  title: string;
  body: string;
}

export interface Tour {
  id: string;
  routePrefix: string;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    id: 'welcome',
    routePrefix: '/',
    steps: [
      {
        selector: 'aside nav',
        title: 'Welcome to FlowMiner',
        body: 'Explore projects, dashboards, alerts, connectors, and analysis tools from this sidebar. Press "/" to search anywhere or "?" to see shortcuts.',
      },
      {
        selector: 'aside nav a[href="/projects"]',
        title: 'Projects hold your event logs',
        body: 'Each project groups related event logs. Create one, upload a log, and FlowMiner will auto-detect the case / activity / timestamp columns with a confidence score.',
      },
      {
        selector: 'aside nav a[href="/overview"]',
        title: 'Overview is your starting point',
        body: 'One click away from Mission Control, Task Inbox, and AI-written executive briefings.',
      },
      {
        selector: 'aside nav a[href="/alerts"]',
        title: 'Turn findings into alerts',
        body: 'Thresholds on any metric trigger email, webhook, Slack, or Teams notifications. Pair with Initiatives to track fixes through to completion.',
      },
    ],
  },
  {
    id: 'process-view',
    routePrefix: '/process/',
    steps: [
      {
        selector: '[data-tour="process-map-toolbar"]',
        title: 'Toolbar controls',
        body: 'Swap absolute / percentage labels, highlight slow activities, or hide individual steps. Every change re-renders without losing your viewport.',
      },
      {
        selector: '[data-tour="filter-chip-bar"]',
        title: 'Filter chips drive everything',
        body: 'Click a node on the map, right-click for scoped filters, or type a filter expression. Every analysis tab re-scopes automatically.',
      },
      {
        selector: '[data-tour="ask-ai"]',
        title: 'Ask AI about this log',
        body: 'Chat mode answers questions about the discovered process — it automatically picks up any active filter chips so "how does this compare to last week" just works.',
      },
    ],
  },
  {
    id: 'variants',
    routePrefix: '/variants/',
    steps: [
      {
        selector: '[data-tour="variant-focus"]',
        title: 'Focus on a single variant',
        body: 'Hit Focus to re-scope every downstream analysis (bottlenecks, conformance, temporal profile) to only the cases of that variant. Hit Why to get an AI explanation of what makes it slow.',
      },
      {
        selector: '[data-tour="variant-evolution"]',
        title: 'Watch the process drift',
        body: 'Variant mix plotted over time reveals concept drift — if the stacked bars shift colour, the current process is no longer the process you modelled.',
      },
    ],
  },
  {
    id: 'ocpm',
    routePrefix: '/ocpm',
    steps: [
      {
        selector: '[data-tour="ocpm-improvements"]',
        title: 'Unified improvement report',
        body: 'OCEL-level findings + every object-type perspective + cross-object patterns in one place. AI writes the exec summary, and each finding has an Explain button for a plain-English walkthrough with 3 concrete next steps.',
      },
    ],
  },
];
