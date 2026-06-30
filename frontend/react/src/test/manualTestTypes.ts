/**
 * Manual-test data model (authored by the `/manual-tests` skill). Human-run
 * feature tests rendered by ManualTestPage.tsx at `/test?suite=<key>`. The shape
 * follows the myndhyve runner (TestSuite → TestCase → TestStep) adapted to
 * openwop's design system.
 */
export type TestStatus = 'untested' | 'pass' | 'fail' | 'blocked' | 'skip';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TestStep {
  /** What the tester does. */
  action: string;
  /** The expected, checkable result of that action. */
  expect: string;
}

export interface TestCase {
  /** Stable id, e.g. 'RUNS-01' — used as the localStorage + tracker key. */
  id: string;
  title: string;
  priority: Priority;
  /** A failure here blocks the release. */
  blocker?: boolean;
  preconditions: string[];
  steps: TestStep[];
}

export interface FeatureToggle {
  /** The feature is OFF by default — the first case must enable it. */
  off: boolean;
  /** Exact steps to turn it on (cite features.tsx:NN / env / kb toggle / AppGate). */
  howToEnable: string[];
  howToRevert?: string[];
}

export interface TestSuite {
  /** Feature slug — the `?suite=` value. */
  key: string;
  feature: string;
  route: string;
  description: string;
  toggle: FeatureToggle;
  cases: TestCase[];
  /** ISO date the suite was authored/updated. */
  updatedAt: string;
  /** HEAD sha when authored — drives staleness detection in the skill's audit. */
  sourceCommit: string;
  /** Feature source paths watched for drift (staleness). */
  sourceFiles: string[];
}
