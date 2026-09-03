import { Capability } from './models';

/** Base class for all routing errors. `code` is a stable machine-readable string. */
export class RouterError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when a requested capability is not known to any model. */
export class UnknownCapabilityError extends RouterError {
  constructor(capability: string, known: readonly Capability[]) {
    super(
      'UNKNOWN_CAPABILITY',
      `Unknown capability "${capability}". Known capabilities: ${known.join(', ') || '(none)'}`
    );
  }
}

export type NoRouteReason =
  | 'empty-model-table'
  | 'no-model-matches'
  | 'no-model-under-cost-ceiling'
  // Reasons added with the tiered/filtered routing pipeline. Each filter has
  // its own reason so a 400 tells the caller which constraint was too tight.
  | 'all-models-excluded'
  | 'no-available-provider'
  | 'no-model-with-enough-context';

/** Raised when no model satisfies the request (capability filter and/or cost ceiling). */
export class NoRouteError extends RouterError {
  readonly reason: NoRouteReason;

  constructor(reason: NoRouteReason) {
    super('NO_ROUTE', `No model matches the request: ${reason}`);
    this.reason = reason;
  }
}

/** Raised when a caller asks for a routing strategy that is not registered. */
export class UnknownStrategyError extends RouterError {
  constructor(name: string, known: readonly string[]) {
    super(
      'UNKNOWN_STRATEGY',
      `Unknown routing strategy "${name}". Registered strategies: ${known.join(', ') || '(none)'}`
    );
  }
}