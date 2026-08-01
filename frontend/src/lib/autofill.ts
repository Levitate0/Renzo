// ---------------------------------------------------------------------------
// suppressAutofill, ported (public/app.js:119). Browsers' password managers
// treat every text box as a login username once the page contains
// type=password inputs — so authenticated-area credential fields render as
// type="text" with the `masked` class (CSS `-webkit-text-security: disc`
// keeps them visually dotted), and every non-auth field opts out of autofill
// and stays READONLY until first focus/tap (the one reliable cross-browser
// opt-out: managers don't autofill or pop their dropdown on a readonly field).
//
// Use `useAutofillGuard()` / `useMaskedInput()` on credentials/settings
// inputs. Do NOT use on the login/setup/reset gates — those must stay real
// password fields in a real <form> with enterkeyhint so the Android TV IME's
// Go action submits (CONTRACTS, commit bbe2b84).
// ---------------------------------------------------------------------------
import { useCallback, useState } from "react";

/** Class that visually masks a text input like a password field (globals.css). */
export const MASKED_CLASS = "masked";

/** Static autofill/password-manager opt-out attributes (no readonly trick). */
export const AUTOFILL_OPTOUT_PROPS = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;

export interface AutofillGuardProps {
  autoComplete: "off";
  "data-1p-ignore": "";
  "data-lpignore": "true";
  "data-form-type": "other";
  readOnly: boolean;
  onFocus: () => void;
  onPointerDown: () => void;
}

/**
 * Spread onto a normal input/textarea: autofill opt-out attrs + the
 * readonly-until-first-focus guard. Once unlocked it stays unlocked (matches
 * the old one-shot listener). Don't use on fields that are readonly by design
 * (e.g. the API-key display) — those need no guard.
 *
 *   const guard = useAutofillGuard();
 *   <Input {...guard} />
 */
export function useAutofillGuard(): AutofillGuardProps {
  const [locked, setLocked] = useState(true);
  const unlock = useCallback(() => setLocked(false), []);
  return {
    ...AUTOFILL_OPTOUT_PROPS,
    readOnly: locked,
    onFocus: unlock,
    onPointerDown: unlock,
  };
}

export interface MaskedInputProps extends AutofillGuardProps {
  type: "text";
  className: string;
}

/**
 * A secret field (RD/AD tokens, SMTP password, …): guard props + type="text"
 * masked-as-password. Merge the returned className with your own via cn():
 *
 *   const masked = useMaskedInput();
 *   <Input {...masked} className={cn(masked.className, "w-full")} />
 */
export function useMaskedInput(): MaskedInputProps {
  const guard = useAutofillGuard();
  return { ...guard, type: "text", className: MASKED_CLASS };
}
