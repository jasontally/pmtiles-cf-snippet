/**
 * Fill `{{key}}` placeholders in a style template.
 *
 * One implementation, used in two places. `web/make-styles.mjs` uses it to prove
 * that the template reproduces the shipped styles, and the documentation page
 * imports this file to build a custom style from the same template. If the two
 * had separate copies, the builder would eventually hand out a style that is not
 * the one on screen.
 *
 * The placeholder can sit anywhere inside a string, not only fill one whole, so
 * the match is not anchored to the quotes. Substitution happens on the JSON text,
 * which is what makes that easy, so only the escaped inner value is inserted: the
 * placeholder already sits inside a JSON string and adding quotes would double
 * them.
 *
 * A placeholder with no value is left literal. A literal `{{water}}` in the JSON
 * a user copies is a visible bug; a silently blank colour is not.
 */

/**
 * @param {object} template     a style with `{{key}}` and `{{show:id}}` placeholders
 * @param {object} values       colour and label values, keyed by name
 * @param {object} show         layer group ids mapped to false to hide them
 * @returns {object} the finished style
 */
export function renderTemplate(template, values = {}, show = {}) {
  const raw = (value) => JSON.stringify(value).slice(1, -1);

  const text = JSON.stringify(template).replace(
    /\{\{([a-zA-Z0-9:_-]+)\}\}/g,
    (whole, key) => {
      if (key.startsWith("show:")) return show[key.slice(5)] === false ? "none" : "visible";
      if (values[key] !== undefined) return raw(values[key]);
      if (key === "name" || key === "flavor") return "custom";
      return whole;
    }
  );
  return JSON.parse(text);
}

/** True when a rendered style still has a placeholder in it. */
export function hasUnfilled(template) {
  return JSON.stringify(template).includes("{{");
}

/**
 * Pack only the values that differ from a base palette, for a shareable URL.
 *
 * A full palette is about 700 characters, which is too long for a link people
 * will paste. Only the edits are sent, and they are hex colours, so base64url of
 * the JSON is short enough to read past.
 */
export function packEdits(base, values, show) {
  const colors = {};
  for (const [key, value] of Object.entries(values)) {
    if (base[key] !== value) colors[key] = value;
  }
  const off = Object.entries(show).filter(([, on]) => on === false).map(([id]) => id);
  return btoa(JSON.stringify({ c: colors, o: off }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unpack what packEdits produced, on top of a base palette. */
export function unpackEdits(base, packed) {
  const json = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
  const { c = {}, o = [] } = JSON.parse(json);
  const values = { ...base };
  const show = {};
  for (const [key, value] of Object.entries(c)) values[key] = value;
  for (const id of o) show[id] = false;
  return { values, show };
}