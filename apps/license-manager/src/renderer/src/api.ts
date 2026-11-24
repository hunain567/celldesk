import type { LmChannel, LmInput, LmOutput, LmResult } from '../../shared/contract';

declare global {
  interface Window {
    licenseManager: { invoke(channel: string, input?: unknown): Promise<unknown> };
  }
}

export class LmApiError extends Error {}

export async function lm<C extends LmChannel>(channel: C, input?: LmInput<C>): Promise<LmOutput<C>> {
  const result = (await window.licenseManager.invoke(channel, input)) as LmResult<LmOutput<C>>;
  if (!result.ok) throw new LmApiError(result.error.message);
  return result.data;
}

export function message(error: unknown): string {
  return error instanceof LmApiError ? error.message : 'Something went wrong. Please try again.';
}

const day = new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const formatDay = (iso: string) => day.format(new Date(iso));
export const formatDayTime = (iso: string) => dayTime.format(new Date(iso));

/** Today's local date as YYYY-MM-DD. */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const PLAN_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'six-months', label: '6 months' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom' },
] as const;

export function planLabel(plan: string): string {
  return PLAN_OPTIONS.find((option) => option.value === plan)?.label ?? plan;
}

/** Copies text; the License Manager window has clipboard write permission only. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
