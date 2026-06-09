// Lightweight, client-only onboarding activation tracking.
//
// A self-hosted instance has no telemetry backend, so the getting-started
// checklist tracks completion via four localStorage flags. Any surface that
// represents a real activation milestone calls markOnboardingStep(); the
// OnboardingWizard reads the flags and listens for the change event so it can
// re-render its progress without a full reload.

export type OnboardingStep = 'sample' | 'upload' | 'map' | 'analysis';

export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  'sample',
  'upload',
  'map',
  'analysis',
];

const STEP_KEYS: Record<OnboardingStep, string> = {
  sample: 'fm-onb-sample',
  upload: 'fm-onb-upload',
  map: 'fm-onb-map',
  analysis: 'fm-onb-analysis',
};

/** Event fired (same-tab) whenever a step flag flips, so React can re-read. */
export const ONBOARDING_EVENT = 'flowminer-onboarding-progress';

export function markOnboardingStep(step: OnboardingStep): void {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(STEP_KEYS[step]) === '1') return;
  localStorage.setItem(STEP_KEYS[step], '1');
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT));
}

export function getOnboardingProgress(): Record<OnboardingStep, boolean> {
  if (typeof window === 'undefined') {
    return { sample: false, upload: false, map: false, analysis: false };
  }
  return {
    sample: localStorage.getItem(STEP_KEYS.sample) === '1',
    upload: localStorage.getItem(STEP_KEYS.upload) === '1',
    map: localStorage.getItem(STEP_KEYS.map) === '1',
    analysis: localStorage.getItem(STEP_KEYS.analysis) === '1',
  };
}
