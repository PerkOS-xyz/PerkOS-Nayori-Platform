export type LogFields = Readonly<Record<string, unknown>>;

export interface AppLogger {
  info(fields: LogFields): void;
  error(fields: LogFields): void;
}

function write(stream: NodeJS.WriteStream, level: "info" | "error", fields: LogFields): void {
  stream.write(`${JSON.stringify({ level, timestamp: new Date().toISOString(), ...fields })}\n`);
}

export const consoleLogger: AppLogger = {
  info(fields) {
    write(process.stdout, "info", fields);
  },
  error(fields) {
    write(process.stderr, "error", fields);
  },
};
