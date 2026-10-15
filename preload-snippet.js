/**
 * Optional root-page snippet: inject preload tags for the first map view.
 *
 * This file is a skeleton. The bucket table is generated at build time from the
 * archive layout; the check below keeps the empty table from injecting anything.
 */

const FALLBACK = { center: [0, 18], zoom: 2.4 };

function bucket(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Ten-degree cells, kept coarse so the generated table stays small.
  return `${Math.floor(lat / 10) * 10}:${Math.floor(lon / 10) * 10}`;
}

function bucketFile(lat, lon) {
  const key = bucket(lat, lon);
  return key ? `/preload/${encodeURIComponent(key)}.json` : null;
}

export { bucket, bucketFile };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return fetch(request);

    const response = await fetch(request);
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.startsWith("text/html")) return response;

    const lat = Number(request.cf && request.cf.latitude);
    const lon = Number(request.cf && request.cf.longitude);
    const path = bucketFile(lat, lon);
    if (!path) return response;

    let urls = [];
    try {
      const bucketResponse = await fetch(new URL(path, request.url));
      if (bucketResponse.ok) {
        const data = await bucketResponse.json();
        if (Array.isArray(data)) urls = data.filter((x) => typeof x === "string");
      }
    } catch (error) {
      return response;
    }

    if (!urls.length) return response;

    const links = urls.map((href) =>
      `<link rel="preload" as="fetch" href="${href}" crossorigin>`
    ).join("");
    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(links, { html: true });
        },
      })
      .transform(response);
  },
};