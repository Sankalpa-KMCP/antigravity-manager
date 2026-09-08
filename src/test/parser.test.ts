import { parseUserStatus } from '../usage/parser';
import { RawUserStatusResponse } from '../rpc/endpoints';

export function runParserTests(): boolean {
  console.log('--- RUNNING PARSER TESTS (V1.1 HARDENED) ---');
  let passed = true;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  // Test 1: Full payload parsing
  const mockPayload: RawUserStatusResponse = {
    userStatus: {
      email: 'testuser@gmail.com',
      name: 'Test User',
      userTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro'
      },
      planStatus: {
        availablePromptCredits: 450,
        availableFlowCredits: 90,
        planInfo: {
          planName: 'Google AI Pro',
          teamsTier: 'TEAMS_TIER_PRO',
          monthlyPromptCredits: 50000,
          monthlyFlowCredits: 150000
        }
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 3.8 Flash (High)',
            modelOrTier: 'gemini-3.8-flash-high',
            quotaInfo: {
              remainingFraction: 0.885,
              resetTime: '2026-09-08T12:00:00Z',
              isExhausted: false
            }
          }
        ]
      }
    }
  };

  const parsed = parseUserStatus(mockPayload);
  assert(parsed.email === 'testuser@gmail.com', 'email extracted correctly');
  assert(parsed.userName === 'Test User', 'name extracted correctly');
  assert(parsed.userTier === 'Google AI Pro', 'userTier extracted correctly');
  assert(parsed.planName === 'Google AI Pro', 'planName extracted correctly');
  assert(parsed.credits?.availablePromptCredits === 450, 'availablePromptCredits extracted');
  assert(parsed.credits?.monthlyPromptCredits === 50000, 'monthlyPromptCredits extracted');
  assert(parsed.credits?.computedUsedPromptCredits === 49550, 'computedUsedPromptCredits correctly calculated (50000 - 450)');
  assert(parsed.credits?.availableFlowCredits === 90, 'availableFlowCredits extracted');
  assert(parsed.credits?.monthlyFlowCredits === 150000, 'monthlyFlowCredits extracted');
  assert(parsed.credits?.computedUsedFlowCredits === 149910, 'computedUsedFlowCredits correctly calculated (150000 - 90)');
  assert(parsed.models.length === 1, 'models length is 1');
  assert(parsed.models[0].remainingFraction === 0.885, 'remainingFraction preserved');

  // Test 2: Empty/malformed payload parsing
  const emptyParsed = parseUserStatus({});
  assert(emptyParsed.email === null, 'empty payload yields null email');
  assert(emptyParsed.credits === null, 'empty payload yields null credits');
  assert(emptyParsed.models.length === 0, 'empty payload yields 0 models');

  return passed;
}
