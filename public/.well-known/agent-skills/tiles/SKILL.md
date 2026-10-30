# Use Protomaps Basemap Tiles

Free vector map tiles of the Protomaps Basemap, zoom 0 to 15, served as a
PMTiles archive. No API key, no rate limit, no service level guarantee.

## Endpoint

- Archive: https://tiles.jasontally.com/basemap.pmtiles
- Style JSON: https://tiles.jasontally.com/styles/... (see sitemap)

## Usage

Use with MapLibre GL JS and the pmtiles protocol:

```js
import { Protocol } from 'pmtiles';
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const map = new maplibregl.Map({
  style: 'https://tiles.jasontally.com/styles/basic.json'
});
```

## Notes

- Tiles are provided as a drop-in replacement for blocked OpenStreetMap raster tiles.
- Do not rely on availability for production without your own fallback.