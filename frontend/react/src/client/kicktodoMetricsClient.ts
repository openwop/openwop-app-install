/**
 * KickTodo metrics FE client (ADR 0432 P4) — React-free over
 * `/host/openwop-app/kicktodo/metrics/*`. Every rate arrives as a
 * `FlooredCell`: a null value with a reason is a WITHHELD cell, not a zero.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/metrics`;

export interface FlooredCell<T> {
  value: T | null;
  contributors: number;
  withheldReason?: 'below-k-floor';
}

export interface ActivationMetrics {
  daysToFirstCompletedActionP50: FlooredCell<number>;
  enrollmentsStarted: number;
  enrollmentsWithAnyCompletion: FlooredCell<number>;
}

export interface EngagementMetrics {
  weeklyMeaningfulProgress: FlooredCell<number>;
  retentionD7: FlooredCell<number>;
  retentionD30: FlooredCell<number>;
  completionRate: FlooredCell<number>;
  abandonmentRate: FlooredCell<number>;
  recoveryRate7d: FlooredCell<number>;
}

export interface FactoryMetrics {
  candidatesByState: Record<string, number>;
  publishRate: FlooredCell<number>;
}

export interface VerifierQuality {
  sampled: number;
  resolved: number;
  agreed: number;
  falsePositives: number;
  falseNegatives: number;
  disagreementRate: number | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`metrics request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getActivation(): Promise<ActivationMetrics> {
  return await get<ActivationMetrics>('/activation');
}

export async function getEngagement(): Promise<EngagementMetrics> {
  return await get<EngagementMetrics>('/engagement');
}

export async function getFactory(): Promise<FactoryMetrics> {
  return await get<FactoryMetrics>('/factory');
}

export async function getVerifierQuality(): Promise<VerifierQuality> {
  return await get<VerifierQuality>('/verifier-quality');
}
