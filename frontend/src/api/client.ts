// Barrel re-export. Each API resource now lives in its own per-resource
// module and the shared Axios instance lives in './http'. This module
// preserves the historical '@/api/client' import surface — every existing
// named export (resources + the types that were declared here) and the
// default export (the Axios instance) keep resolving unchanged.

export * from './auth';
export * from './projects';
export * from './eventLogs';
export * from './mining';
export * from './competitive';
export * from './governance';
export * from './ocel';
export * from './dashboards';
export * from './alerts';
export * from './connectors';
export * from './templates';
export * from './annotations';
export * from './search';
export * from './admin';
export * from './initiatives';
export * from './actionRules';
export * from './analytics';
export * from './tasks';
export * from './taskMining';
export * from './systemSettings';
export * from './ai';
export * from './logBuilder';

export { default } from './http';
