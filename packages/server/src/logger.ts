/**
 * Structured JSON logger. Every log line is a single JSON object on stdout,
 * so logs can be piped into any JSON log collector without parsing glue.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...fields,
    });
    // stdout is the convention for structured logs; stderr reserved for fatal errors.
    // eslint-disable-next-line no-console
    console.log(line);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }
}

/** Shared default logger for the process. */
export const logger = new Logger();