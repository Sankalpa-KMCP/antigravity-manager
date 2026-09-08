import { filterAndOrderModels, ModelQuotaItem, PREFERRED_MODEL_ORDER } from '../models/filter';

export function runModelsFilterTests(): boolean {
  console.log('--- RUNNING MODEL QUOTA FILTER & FIXED ORDER TESTS ---');
  let passed = true;

  function assert(condition: boolean, testName: string) {
    if (!condition) {
      console.error(`  FAIL: ${testName}`);
      passed = false;
    } else {
      console.log(`  PASS: ${testName}`);
    }
  }

  const sampleRawModels: ModelQuotaItem[] = [
    { label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9, resetTime: '2026-09-08T12:00:00Z', isExhausted: false },
    { label: 'Gemini 3.8 Flash (Low)', remainingFraction: 1.0, resetTime: '2026-09-08T12:00:00Z', isExhausted: false },
    { label: 'Claude Opus 4.6 (Thinking)', remainingFraction: 0.1, resetTime: '2026-09-08T14:00:00Z', isExhausted: false },
    { label: 'Gemini 3.7 Flash (High)', remainingFraction: 0.4, resetTime: '2026-09-08T11:00:00Z', isExhausted: false },
    { label: 'Gemini 3.6 Flash (High)', remainingFraction: 0.0, resetTime: '2026-09-08T10:00:00Z', isExhausted: true },
    { label: 'Gemini 3.6 Flash (Medium)', remainingFraction: 0.8, resetTime: '2026-09-08T12:00:00Z', isExhausted: false },
    { label: 'GPT-OSS 120B (Medium)', remainingFraction: 1.0, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Gemini 3.1 Pro (High)', remainingFraction: 0.7, resetTime: '2026-09-08T09:00:00Z', isExhausted: false },
    { label: 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 0.5, resetTime: '2026-09-08T13:00:00Z', isExhausted: false },
    { label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.2, resetTime: '2026-09-08T16:00:00Z', isExhausted: false }
  ];

  const filtered = filterAndOrderModels(sampleRawModels);

  // 1. Check count and membership
  assert(filtered.length === 6, 'Filtered list has exactly 6 models');
  assert(!filtered.some(m => m.label.includes('Medium')), 'All Medium models are hidden');
  assert(!filtered.some(m => m.label.includes('Low')), 'All Low models are hidden');
  assert(!filtered.some(m => m.label.includes('GPT-OSS')), 'Non-High/Thinking models are hidden');
  assert(filtered.every(m => m.label.includes('(High)') || m.label.includes('(Thinking)')), 'All displayed models contain (High) or (Thinking)');

  // 2. Check exact fixed order
  const labels = filtered.map(m => m.label);
  assert(labels[0] === 'Gemini 3.8 Flash (High)', 'Position 1 is Gemini 3.8 Flash (High)');
  assert(labels[1] === 'Gemini 3.1 Pro (High)', 'Position 2 is Gemini 3.1 Pro (High)');
  assert(labels[2] === 'Gemini 3.7 Flash (High)', 'Position 3 is Gemini 3.7 Flash (High)');
  assert(labels[3] === 'Gemini 3.6 Flash (High)', 'Position 4 is Gemini 3.6 Flash (High)');
  assert(labels[4] === 'Claude Sonnet 4.6 (Thinking)', 'Position 5 is Claude Sonnet 4.6 (Thinking)');
  assert(labels[5] === 'Claude Opus 4.6 (Thinking)', 'Position 6 is Claude Opus 4.6 (Thinking)');

  // 3. Verify order invariance (exhaustion, percentage, reset time do not disturb order)
  const exhaustedFirst = [...sampleRawModels].reverse();
  const filteredReversed = filterAndOrderModels(exhaustedFirst);
  assert(
    JSON.stringify(filteredReversed.map(m => m.label)) === JSON.stringify(labels),
    'Order remains identical regardless of input order, percentages, or exhaustion'
  );

  // 4. Missing model omits cleanly without shifting relative order
  const missingSonnet = sampleRawModels.filter(m => !m.label.includes('Claude Sonnet'));
  const filteredMissing = filterAndOrderModels(missingSonnet);
  assert(filteredMissing.length === 5, 'Missing model omits cleanly (5 models remain)');
  assert(!filteredMissing.some(m => m.label.includes('Claude Sonnet')), 'Omitted model is absent');
  assert(filteredMissing[4].label === 'Claude Opus 4.6 (Thinking)', 'Claude Opus remains at end without disruption');

  // 5. Future unknown High/Thinking model is appended after predefined sequence
  const withUnknown = [
    ...sampleRawModels,
    { label: 'Zeta 1.0 (Thinking)', remainingFraction: 1.0, resetTime: '2026-09-08T12:00:00Z', isExhausted: false },
    { label: 'Alpha 2.0 (High)', remainingFraction: 1.0, resetTime: '2026-09-08T12:00:00Z', isExhausted: false }
  ];
  const filteredUnknown = filterAndOrderModels(withUnknown);
  assert(filteredUnknown.length === 8, 'Unknown High/Thinking models are accepted');
  assert(filteredUnknown[6].label === 'Alpha 2.0 (High)', 'Unknown model Alpha sorted after predefined models');
  assert(filteredUnknown[7].label === 'Zeta 1.0 (Thinking)', 'Unknown model Zeta sorted after Alpha');

  return passed;
}
