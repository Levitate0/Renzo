"use client";

// Email (SMTP) pane — owner only. Full relay form + test send. Ports
// index.html email pane + app.js loadSmtp/smtpSave/smtpTestBtn. Blank host
// disables email; blank password keeps the saved one.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useAutofillGuard, useMaskedInput } from "@/lib/autofill";
import type { SmtpPublic } from "@/lib/types";
import { cn } from "@/lib/utils";

import { errMsg, Field, PaneSection } from "@/components/settings/shared";

export function SmtpPane() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const owner = user?.role === "owner";

  const smtpQ = useQuery({
    queryKey: ["smtp"],
    queryFn: () => api<SmtpPublic | null>("/smtp"),
    enabled: !!owner,
  });

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState("");
  const [secure, setSecure] = useState(false);
  const [testTo, setTestTo] = useState("");
  const hostGuard = useAutofillGuard();
  const userGuard = useAutofillGuard();
  const fromGuard = useAutofillGuard();
  const testGuard = useAutofillGuard();
  const passMask = useMaskedInput();

  // Populate from the saved settings whenever they (re)load (old loadSmtp).
  const loadedFor = useRef<SmtpPublic | null | undefined>(undefined);
  useEffect(() => {
    if (smtpQ.data === undefined || loadedFor.current === smtpQ.data) return;
    loadedFor.current = smtpQ.data;
    const s = smtpQ.data;
    setHost(s?.host ?? "");
    setPort(String(s?.port ?? 587));
    setSmtpUser(s?.user ?? "");
    setFrom(s?.from ?? "");
    setSecure(!!s?.secure);
  }, [smtpQ.data]);

  if (!owner) return null;

  const hasPassword = !!smtpQ.data?.hasPassword;

  const save = async () => {
    try {
      const r = await api<{ ok: boolean; cleared?: boolean }>("/smtp", {
        method: "POST",
        body: JSON.stringify({
          host: host.trim(),
          port,
          user: smtpUser.trim(),
          pass,
          from: from.trim(),
          secure,
        }),
      });
      setPass("");
      toast(r.cleared ? "Email disabled" : "SMTP saved");
      void qc.invalidateQueries({ queryKey: ["smtp"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const sendTest = async () => {
    const to = testTo.trim();
    if (!to) {
      toast("Enter a recipient");
      return;
    }
    try {
      await api("/smtp/test", { method: "POST", body: JSON.stringify({ to }) });
      toast(`Test email sent to ${to}`);
    } catch (e) {
      toast("Test failed: " + errMsg(e));
    }
  };

  return (
    <PaneSection
      title="Email (SMTP)"
      sub="Outbound relay for invite & password emails (e.g. Gmail app password, Brevo, Resend, SendGrid). Renzo only submits mail to the relay — it never hosts a mail server. Leave the host empty to disable email."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="SMTP Host" htmlFor="smtpHost">
          <Input
            id="smtpHost"
            {...hostGuard}
            placeholder="smtp.resend.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field label="Port" htmlFor="smtpPort">
          <Input
            id="smtpPort"
            type="number"
            placeholder="587"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field label="Username" htmlFor="smtpUser">
          <Input
            id="smtpUser"
            {...userGuard}
            placeholder="username"
            value={smtpUser}
            onChange={(e) => setSmtpUser(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="smtpPass">
          <Input
            id="smtpPass"
            {...passMask}
            className={cn(passMask.className)}
            placeholder={hasPassword ? "•••••• (saved — blank keeps it)" : "password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Field label="From Address" htmlFor="smtpFrom">
          <Input
            id="smtpFrom"
            {...fromGuard}
            placeholder="noreply@yourdomain.com"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2.5 self-end pb-2 text-sm">
          <Checkbox checked={secure} onCheckedChange={(v) => setSecure(v === true)} />
          <span>Implicit TLS (port 465). Off = STARTTLS (587).</span>
        </label>
      </div>

      <div>
        <Button onClick={() => void save()}>Save</Button>
      </div>

      <div className="border-t border-border pt-4">
        <Field
          label="Send a test email"
          htmlFor="smtpTest"
          hint={
            <>
              Uses the last <i>saved</i> SMTP settings — save first.
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="smtpTest"
              type="email"
              inputMode="email"
              {...testGuard}
              className="w-full flex-1 sm:w-auto"
              placeholder="you@example.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
            />
            <Button variant="outline" className="shrink-0" onClick={() => void sendTest()}>
              Send test
            </Button>
          </div>
        </Field>
      </div>
    </PaneSection>
  );
}
