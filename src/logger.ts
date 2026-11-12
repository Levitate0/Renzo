import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const line = `${ts()} [${level.toUpperCase()}] (${scope})`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(line, ...args);
}

export function logger(scope: string) {
  return {
    // config.debug, not process.env.DEBUG: any non-empty string is truthy, so
    // DEBUG=false used to switch debug logging ON.
    debug: (...a: unknown[]) => { if (config.debug) emit("debug", scope, a); },
    info: (...a: unknown[]) => emit("info", scope, a),
    warn: (...a: unknown[]) => emit("warn", scope, a),
    error: (...a: unknown[]) => emit("error", scope, a),
  };
}
