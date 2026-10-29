import {
  appendDigit,
  backspace,
  canSubmit,
  isDigitKey,
  PIN_MAX,
  slots,
} from "../../src/lib/pinpad.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- what counts as a digit -------------------------------------------------
// The pad has ten digit keys, but the holder is fed from a real keyboard too,
// and a keypad that accepted "10" would build a passcode the server cannot have.
check("a single digit is a digit", isDigitKey("7"));
check("zero is a digit", isDigitKey("0"));
check("two characters are not", !isDigitKey("10"));
check("a letter is not", !isDigitKey("a"));
check("a minus sign is not", !isDigitKey("-"));
check("a space is not", !isDigitKey(" "));
check("an empty string is not", !isDigitKey(""));

// --- growing the code -------------------------------------------------------
check("one press adds one digit", appendDigit("", "4") === "4");
check("presses accumulate in order", appendDigit(appendDigit("1", "2"), "3") === "123");
check("changing a digit is not possible, only appending", appendDigit("12", "9") === "129");
check("a non-digit press changes nothing", appendDigit("12", "x") === "12");

let full = "";
for (const digit of "123456") full = appendDigit(full, digit);
check("six digits fill the code", full.length === PIN_MAX, full);
// A full code ignores the press rather than dropping its oldest digit: losing a
// digit you can count is worse than a key that does nothing.
check("a seventh digit is refused, not truncated", appendDigit(full, "7") === full);
check("the refused press did not shift the code", appendDigit(full, "7").slice(0, 2) === "12");

// --- taking one back --------------------------------------------------------
check("backspace removes the last digit", backspace("123") === "12");
check("backspace on one digit empties it", backspace("1") === "");
check("backspace on nothing is nothing", backspace("") === "");
check("backspace does not mangle a longer code", backspace("123456") === "12345");

// --- when the submit key is live -------------------------------------------
check("no code, nothing to submit", !canSubmit(""));
check("one digit is enough to submit", canSubmit("4"));
check("six digits are enough", canSubmit(full));

// --- the dots ---------------------------------------------------------------
// Dots are drawn from the code rather than counted beside it: a second counter
// is a second thing that can drift.
check("there are always six dots", slots("").length === PIN_MAX);
check("no dots are filled at the start", slots("").every((on) => !on));
check("three digits fill three dots, in order", JSON.stringify(slots("123")) ===
  JSON.stringify([true, true, true, false, false, false]));
check("a full code fills every dot", slots(full).every((on) => on));
check("the dot count follows backspace", slots(backspace("1234")).filter(Boolean).length === 3);
check("slots can be drawn at another size", slots("12", 4).length === 4);

/* A pad that knows the passcode is four digits draws four dots. Six dots under a
   four-digit code tells the reader their code is two digits longer than it is. */
{
  check("a four-digit code draws four dots", slots("", 4).length === 4);
  check("...and fills them one press at a time", slots("12", 4).filter(Boolean).length === 2);
  check("a six-digit code still draws six", slots("", 6).length === 6);
  check("an unknown length draws the maximum", slots("").length === PIN_MAX);
  check("the pad never draws fewer dots than it holds", slots("123456", 2).length === 6);
  check("a silly count is clamped, not drawn", slots("", 0).length === 1 && slots("", 99).length === PIN_MAX);
  check("a fractional count does not become a fractional dot", slots("", 3.6).length === 4);
}

if (failures === 0) {
  console.log(`ok ${checks} checks — passcode keypad rules`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
