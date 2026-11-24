import {
  ipcContract,
  isIpcChannel,
  type IpcChannel,
  type IpcContract,
  type IpcOutput,
  type IpcResult,
} from '@celldesk/shared';
import type { z } from 'zod';
import { AppError } from '../errors';

export interface IpcContext {
  /** URL of the page that sent the request, already checked by the caller. */
  senderUrl: string;
}

type ParsedInput<C extends IpcChannel> = z.output<IpcContract[C]['input']>;

export type IpcHandler<C extends IpcChannel> = (
  input: ParsedInput<C>,
  context: IpcContext,
) => IpcOutput<C> | Promise<IpcOutput<C>>;

export interface IpcRouterOptions {
  /** Validate handler output against the contract (enabled in development and tests). */
  validateOutput: boolean;
  logError: (message: string, error: unknown) => void;
}

/**
 * Dispatches renderer requests to handlers. Every request is checked against the
 * shared contract before a handler runs, and every failure is returned as a
 * structured result instead of an exception crossing the process boundary.
 */
export class IpcRouter {
  private readonly handlers = new Map<IpcChannel, IpcHandler<IpcChannel>>();

  constructor(private readonly options: IpcRouterOptions) {}

  register<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
    if (this.handlers.has(channel)) throw new Error(`IPC handler already registered for ${channel}`);
    this.handlers.set(channel, handler as unknown as IpcHandler<IpcChannel>);
  }

  missingHandlers(): IpcChannel[] {
    return (Object.keys(ipcContract) as IpcChannel[]).filter((channel) => !this.handlers.has(channel));
  }

  async dispatch(channel: unknown, rawInput: unknown, context: IpcContext): Promise<IpcResult<unknown>> {
    if (!isIpcChannel(channel)) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } };
    }
    const handler = this.handlers.get(channel);
    if (!handler) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'This action is not available' } };
    }

    const spec = ipcContract[channel];
    const parsed = spec.input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request contained invalid data',
          details: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`),
        },
      };
    }

    try {
      const output = await handler(parsed.data as never, context);
      if (this.options.validateOutput) {
        const checked = spec.output.safeParse(output);
        if (!checked.success) {
          this.options.logError(`IPC output for ${channel} does not match the contract`, checked.error);
          return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } };
        }
      }
      return { ok: true, data: output };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        };
      }
      this.options.logError(`IPC handler ${channel} failed`, error);
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } };
    }
  }
}
