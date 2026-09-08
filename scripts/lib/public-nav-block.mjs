// Locates the governed public nav block inside a page.
//
// This used to be one regex whose tail read:
//
//   <div class="nav-mobile" id="mobileNav">[\s\S]*?<\/div>\s*(?:<script ...>)?
//
// `[\s\S]*?</div>` is non-greedy, so it stopped at the FIRST closing tag inside
// the mobile nav. Once that drawer gained a nested <div> for the "For pros"
// group, the match ended early: the real </div> and the mobile-nav script were
// left behind, and the sync wrote a complete block in front of them. Running
// `governance:nav` appended a duplicate </div> and a second script tag to 394 of
// 413 public pages — about.html went from 74 open / 74 close divs to 74 open
// against 75 close, which closes an ancestor element early on every page.
//
// Nesting is exactly what a regex cannot count, so the closing tag is now found
// by walking the markup and tracking depth. This is correct at any nesting
// depth, including none.

const NAV_OPEN = '<nav class="nav">';
const NAV_CLOSE = '</nav>';
const MOBILE_OPEN_RE = /<div class="nav-mobile" id="mobileNav">/i;
const SKIP_NAV_RE = /<a href="#main-content" class="skip-nav"[\s\S]*?<\/a>\s*/i;
const NAV_COMMENT_RE = /<!-- NAV -->\s*/i;
// Either the shared script or the older inline initialiser that predates it.
const MOBILE_SCRIPT_RE = /^\s*(?:<script src="\/assets\/js\/mobile-nav\.js" defer><\/script>|<script>document\.getElementById\('mobileNav'\)[\s\S]*?<\/script>)/i;

/** Index just past the tag that closes the element opened at `openIndex`. */
function findBalancedClose(html, openIndex, tagName) {
  const open = new RegExp(`<${tagName}\\b`, 'ig');
  const close = new RegExp(`</${tagName}>`, 'ig');
  let depth = 0;
  let cursor = openIndex;

  while (cursor < html.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return -1;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return cursor;
  }
  return -1;
}

/**
 * Returns { start, end } spanning the governed nav block, or null when the page
 * has none. `end` is exclusive and includes any trailing mobile-nav script.
 */
export function findNavBlock(html) {
  const navOpen = html.indexOf(NAV_OPEN);
  if (navOpen === -1) return null;

  const navEnd = findBalancedClose(html, navOpen, 'nav');
  if (navEnd === -1) return null;

  // Walk backwards over the optional prefix so it is replaced too, exactly as
  // the previous pattern did.
  let start = navOpen;
  const before = html.slice(0, navOpen);
  const comment = before.match(new RegExp(NAV_COMMENT_RE.source + '$', 'i'));
  if (comment) start -= comment[0].length;
  const skip = html.slice(0, start).match(new RegExp(SKIP_NAV_RE.source + '$', 'i'));
  if (skip) start -= skip[0].length;

  let end = navEnd;
  const after = html.slice(navEnd);
  const mobile = after.match(MOBILE_OPEN_RE);
  // Only the drawer that immediately follows the nav belongs to this block.
  if (mobile && after.slice(0, mobile.index).trim() === '') {
    const mobileOpen = navEnd + mobile.index;
    const mobileEnd = findBalancedClose(html, mobileOpen, 'div');
    if (mobileEnd === -1) return null;
    end = mobileEnd;

    const script = html.slice(end).match(MOBILE_SCRIPT_RE);
    if (script) end += script[0].length;
  }

  // Trailing whitespace was part of the old match; keep that so the rebuilt
  // block sits exactly where the old one did.
  const trailing = html.slice(end).match(/^[ \t]*\r?\n?/);
  if (trailing) end += trailing[0].length;

  return { start, end };
}
