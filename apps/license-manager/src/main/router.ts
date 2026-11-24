import { lmContract, type LmChannel, type LmContract, type LmOutput, type LmResult } from '../shared/contract';
import type { z } from 'zod';

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

type Handler<C extends LmChannel> = (input: z.output<LmContract[C]['input']>) => LmOutput<C> | Promise<LmOutput<C>>;

/** Validates every request against the contract; only UserError messages reach the screen. */
export class LmRouter {
  private readonly handlers = new Map<LmChannel, Handler<LmChannel>>();

  constructor(private readonly logError: (message: string, error: unknown) => void, private readonly isUserError: (error: unknown) => string | null) {}

  register<C extends LmChannel>(channel: C, handler: Handler<C>): void {
    this.handlers.set(channel, handler as unknown as Handler<LmChannel>);
  }

  missing(): LmChannel[] {
    return (Object.keys(lmContract) as LmChannel[]).filter((channel) => !this.handlers.has(channel));
  }

  async dispatch(channel: unknown, raw: unknown): Promise<LmResult<unknown>> {
    if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(lmContract, channel)) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } };
    }
    const name = channel as LmChannel;
    const handler = this.handlers.get(name);
    if (!handler) return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } };
    const parsed = lmContract[name].input.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'The request contained invalid data',
          details: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`),
        },
      };
    }
    try {
      return { ok: true, data: await handler(parsed.data as never) };
    } catch (error) {
      const message = this.isUserError(error);
      if (message) return { ok: false, error: { code: 'REFUSED', message } };
      this.logError(`License Manager handler ${name} failed`, error);
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } };
    }
  }
}
