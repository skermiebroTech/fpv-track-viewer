// ===========================================================================
// The credit banner an exported track carries in its XML header:
//
//   <!-- created by <pilot> using 9dtr's track editor -->
//   <!-- created with 9dtr's track editor -->          (no name given)
//
// Kept in its own dependency-free module because THREE places need it and they
// must not drift: the converter (convert/emit-mrsim.js), the editor's own
// serialiser (mrsim-test.html, which never goes through the converter) and the
// CLI's -p flag.
//
// The pilot name is TYPED BY A USER, so it is sanitised rather than trusted.
// This is not hypothetical tidying — every class of input rejected below was
// verified to produce a file that fails to parse AT ALL, i.e. a track the game
// silently refuses to load. The surrogate case needs no hostile intent
// whatsoever: a name that simply ends in an emoji gets cut in half by the
// length cap.
//
// The rejected sets are numeric code-point ranges rather than regex character
// classes on purpose — the characters themselves are invisible or control
// codes, so written literally they are unreadable and trivially corrupted by
// an editor, a diff, or a copy-paste.
// ===========================================================================

// How long a credited name may be. Generous for a real pilot name or handle,
// short enough that the header stays one readable line.
const MAX = 60;

// May this code point appear in the credit?
function allowed(cp) {
  // C0/C1 control characters — a pasted 0x07, or a NUL from a bad clipboard.
  // XML 1.0 forbids these outright, even inside a comment. (Tab/CR/LF are
  // legal, but they are folded to spaces before this runs.)
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false;
  // the U+FFFE / U+FFFF noncharacters — also flatly invalid XML
  if (cp === 0xfffe || cp === 0xffff) return false;
  // half of a surrogate pair on its own: not valid XML either, and the usual
  // way in is pasting a truncated emoji. A WELL-FORMED emoji never reaches
  // here as a surrogate — iterating by code point yields it as a single
  // value above 0xFFFF, which is kept.
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  // Invisible formatting: soft hyphen, BOM, zero-width characters, the
  // directional marks and bidi overrides. All legal XML, but a header credit
  // that renders as a name nobody typed is a spoof, and invisible padding
  // would silently eat the length budget.
  if (cp === 0xad || cp === 0xfeff) return false;
  if (cp >= 0x200b && cp <= 0x200f) return false;
  if (cp >= 0x202a && cp <= 0x202e) return false;
  if (cp >= 0x2060 && cp <= 0x206f) return false;
  return true;
}

// Clean a typed pilot name down to something that can always be embedded in an
// XML comment. Returns '' when nothing usable is left.
export function cleanPilotName(pilotName) {
  // fold every run of whitespace to one space FIRST, so dropping a control
  // character below can never fuse two words together
  const folded = String(pilotName ?? '').replace(/\s+/g, ' ');
  let kept = '';
  for (const ch of folded) {          // string iteration walks CODE POINTS
    if (allowed(ch.codePointAt(0))) kept += ch;
  }
  const nm = kept
    // A comment may not contain "--" anywhere. This is the one rule that must
    // not simply delete: hyphenated names are ordinary (Jean-Luc), and a
    // pasted "-->" has to be defused without mangling the legitimate case.
    // Collapsing runs to a single hyphen does both.
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')             // again: filtering can leave doubled gaps
    .trim();
  // Cap by CODE POINT, never by UTF-16 unit: slicing "...AAA<emoji>" at 60
  // units would cut the emoji in half and leave a lone surrogate — the very
  // thing rejected above, reintroduced by the cap itself.
  return [...nm].slice(0, MAX).join('').trim();
}

// The finished comment body (no <!-- --> delimiters).
export function creditComment(pilotName) {
  const nm = cleanPilotName(pilotName);
  return nm
    ? `created by ${nm} using 9dtr's track editor`
    : "created with 9dtr's track editor";
}

// Recognises a credit already in a file, so a re-export REPLACES it instead of
// stacking copies. Also matches the converter's pre-credit legacy line, which
// gets upgraded on the way through.
export const CREDIT_RE = /9dtr's track editor|Converted from VelociDrone by track-viewer/;

// Pulls the pilot back out of an existing credit, to pre-fill the export prompt.
export const CREDIT_PILOT_RE = /created by (.+?) using 9dtr's track editor/;
