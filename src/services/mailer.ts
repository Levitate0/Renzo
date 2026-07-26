import nodemailer from "nodemailer";
import { logger } from "../logger.js";
import { db } from "../db.js";
import type { SmtpSettings } from "../types.js";

const log = logger("mailer");

export function smtpConfigured(): boolean {
  const s = db.smtp();
  return Boolean(s?.host && s.from);
}

/** Public (no password) view of the SMTP settings for the UI. */
export function smtpPublic(): (Omit<SmtpSettings, "pass"> & { hasPassword: boolean }) | null {
  const s = db.smtp();
  if (!s) return null;
  const { pass, ...rest } = s;
  return { ...rest, hasPassword: Boolean(pass) };
}

function transport(s: SmtpSettings) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure, // true = 465 implicit TLS; false = STARTTLS
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
}

export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<void> {
  const s = db.smtp();
  if (!s?.host || !s.from) throw new Error("SMTP is not configured");
  await transport(s).sendMail({
    from: s.from,
    to,
    subject,
    text: text ?? html.replace(/<[^>]+>/g, " "),
    html,
  });
  log.info(`sent "${subject}" to ${to}`);
}

/** Verify the connection with the provided (or saved) settings — for the test button. */
export async function verifySmtp(s: SmtpSettings): Promise<void> {
  await transport(s).verify();
}
