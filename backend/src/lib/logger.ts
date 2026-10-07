type LogContext = Record<string, string | number | boolean | null>;
type LogLevel = 'info' | 'warn' | 'error';

function write(level: LogLevel, event: string, context: LogContext = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.info(output);
  }
}

export const logger = {
  info(event: string, context?: LogContext): void {
    write('info', event, context);
  },
  warn(event: string, context?: LogContext): void {
    write('warn', event, context);
  },
  error(event: string, context?: LogContext): void {
    write('error', event, context);
  },
};
