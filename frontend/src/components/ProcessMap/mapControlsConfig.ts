export type Algorithm = 'dfg' | 'alpha' | 'heuristic' | 'inductive' | 'split_miner';

// ``help`` is a short "when to use this" hint surfaced as the button
// tooltip so users aren't left guessing which discovery algorithm fits
// their question (finding #15: spaghetti guidance).
export const algorithmOptions: { value: Algorithm; label: string; short: string; help: string }[] = [
  {
    value: 'dfg',
    label: 'Directly-Follows Graph',
    short: 'DFG',
    help: 'DFG — fastest, most literal. Shows every observed hand-off as a frequency/performance graph. Best for a first look and for spotting the busiest paths, but can look like spaghetti on noisy logs.',
  },
  {
    value: 'alpha',
    label: 'Alpha Miner',
    short: 'Alpha',
    help: 'Alpha Miner — classic Petri-net discovery. Good for clean, well-structured logs; struggles with noise, loops, and short cases.',
  },
  {
    value: 'heuristic',
    label: 'Heuristic Miner',
    short: 'Heuristic',
    help: 'Heuristic Miner — frequency-based with a noise filter. Use the Noise slider to drop rare edges and tame a spaghetti DFG while keeping the dominant behaviour.',
  },
  {
    value: 'inductive',
    label: 'Inductive Miner',
    short: 'Inductive',
    help: 'Inductive Miner — always returns a sound, block-structured model. Use the Noise slider to control how much infrequent behaviour is filtered. Best when you need a guaranteed-replayable model.',
  },
  {
    value: 'split_miner',
    label: 'Split Miner',
    short: 'Split',
    help: 'Split Miner — modern algorithm balancing fitness and precision with clean gateways. A strong default for a readable BPMN-like model on real-world logs.',
  },
];

export const detailLevels = [
  { label: 'Simple', value: 20 },
  { label: 'Low', value: 40 },
  { label: 'Medium', value: 60 },
  { label: 'High', value: 80 },
  { label: 'Full', value: 100 },
];
