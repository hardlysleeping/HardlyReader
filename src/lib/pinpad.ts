/**
 * The rules of a passcode keypad, with no DOM in them.
 *
 * The pad is eleven buttons and a submit; the interesting part is what a press
 * is allowed to do to the code, and that is testable on its own. The extension
 * accepts one to six digits, so the pad refuses to grow past six rather than
 * silently trimming what someone typed.
 */

/** Digits the extension's passcode accepts. */
export const PIN_MAX = 6;

/**
 * Whether a key is one of the ten digits.
 *
 * Strict on purpose: `"10"` and `"-"` are not digits, and a keypad that
 * accepted them would send a passcode the server can never match.
 */
export function isDigitKey(key: string): boolean {
  return key.length === 1 && key >= "0" && key <= "9";
}

/**
 * One press, one digit.
 *
 * A full code ignores the press instead of dropping the oldest digit: losing a
 * digit you can see is worse than a key that does nothing.
 */
export function appendDigit(code: string, key: string): string {
  if (!isDigitKey(key)) return code;
  if (code.length >= PIN_MAX) return code;
  return code + key;
}

/** Backspace on an empty code is a no-op, not a crash on `slice`. */
export function backspace(code: string): string {
  return code.slice(0, -1);
}

/** Nothing to send while the code is empty. */
export function canSubmit(code: string): boolean {
  return code.length > 0;
}

/**
 * One flag per slot, so the dots are drawn from the code rather than counted
 * alongside it — a second counter is a second thing that can drift.
 *
 * `count` is how many dots to draw, which is not always `PIN_MAX`: a pad that
 * knows the passcode is four digits draws four, and one that does not know draws
 * six. The code can never make it draw fewer than it holds, because a digit the
 * reader typed has to have somewhere to appear.
 */
export function slots(code: string, count: number = PIN_MAX): boolean[] {
  const drawn = Math.max(1, Math.min(PIN_MAX, Math.round(count)));
  const width = Math.max(drawn, Math.min(code.length, PIN_MAX));
  return Array.from({ length: width }, (_, index) => index < code.length);
}
