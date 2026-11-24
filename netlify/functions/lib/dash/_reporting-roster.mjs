// Screenshot source of truth supplied September 22, 2026. Reporting only.
export const REPORTING_PHONES = {
  "+13236937212": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+12134102025": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+14244031692": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+15623178580": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+13237975109": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+14243561605": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+14243560711": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+12136422686": {
    "id": "Dcc7H7rZQIwkLFNphrOc",
    "name": "Jesse Pickar"
  },
  "+15626859159": {
    "id": "0o04fuZfD8lslmrIP4s5",
    "name": "Arturo Vazquez"
  },
  "+14244352741": {
    "id": "0o04fuZfD8lslmrIP4s5",
    "name": "Arturo Vazquez"
  },
  "+12135732218": {
    "id": "tkcNLziNqC1TOgoj0FE1",
    "name": "Bryce Roman-Tooley"
  },
  "+15623618170": {
    "id": "tkcNLziNqC1TOgoj0FE1",
    "name": "Bryce Roman-Tooley"
  },
  "+14244192485": {
    "id": "UxhQAXoTQ3k8St26dRwH",
    "name": "Carlos Marroquin"
  },
  "+15625125483": {
    "id": "UxhQAXoTQ3k8St26dRwH",
    "name": "Carlos Marroquin"
  },
  "+14243873025": {
    "id": "XyNOQ1RnHJMN0M8RQkK8",
    "name": "Gavin Hambright"
  },
  "+15622490812": {
    "id": "XyNOQ1RnHJMN0M8RQkK8",
    "name": "Gavin Hambright"
  },
  // Hard-coded: Ryan Roozen's line now reports under Arturo Vazquez (Art).
  "+15623623205": {
    "id": "0o04fuZfD8lslmrIP4s5",
    "name": "Arturo Vazquez"
  },
  "+13235534515": {
    "id": "uU07MWZRjOmCtPxncITU",
    "name": "Tino Vasquez"
  },
  "+12132633263": {
    "id": "npAoGH4GfhWRw593Tkq8",
    "name": "Zeth Vasquez"
  },
  "+12136993839": {
    "id": "XgYcgxk7k1OOHLgd3yVS",
    "name": "Seth Roman"
  }
};
// Triple Line flex ("filler") numbers, from the dialer's netlify/lib/flex-caller-ids.mjs.
// Since Nov 1, 2026 several setters share them on the Texted Calls list, so the caller ID
// says nothing about who dialed: only the dialer's signed-in session does. On or after
// FLEX_SINCE a call from one of these numbers is never mapped to a rep by caller ID and
// never dropped as an excluded phone. Earlier calls keep the old mapping (Spanish 2 was
// Gavin's line, Spanish 1 was Frank's).
export const FLEX_NUMBERS = new Set([
  "+15623624155", "+15623625772", "+15622625907", "+15625435251", // English 1-4
  "+13233077164", "+14243873025"                                  // Spanish 1-2
]);
export const FLEX_SINCE = Date.parse("2026-11-01T07:00:00Z"); // Nov 1, 2026 00:00 Los Angeles
export const isFlexCall = (number, at) => FLEX_NUMBERS.has(number) && Date.parse(at || "") >= FLEX_SINCE;
// Frank Chavez removed from the board (Jesse, 2026-11-01): his line and name are excluded like Kyle and Zaida.
export const EXCLUDED_PHONES = new Set(["+13233077164", "+13234176926", "+15625487029"]);
export const excludedRep = name => /^(kyle(?: yaross)?|zaida(?: cobb)?|frank(?: chavez)?)$/i.test(String(name || "").trim());
