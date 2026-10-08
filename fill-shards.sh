#!/bin/bash
# Push the shard template into shards 10, 11 and 12 once GitHub's repo
# creation cooldown has passed. Idempotent: skips repos that already exist.
set -u
TEMPLATE=/home/jtally/tiles/shard-repo
for i in 10 11 12; do
  n=$(printf '%02d' $i)
  repo="pmtiles-shard-$n"
  if gh repo view "jasontally/$repo" >/dev/null 2>&1; then
    echo "$repo exists, skipping"
    continue
  fi
  echo "creating $repo"
  if ! gh repo create "$repo" --public --description \
      "Shard $i of the Protomaps basemap PMTiles archive, served from Cloudflare Static Assets"; then
    echo "  $repo still rate limited, will retry"
    continue
  fi
  d=$(mktemp -d)
  cp -r "$TEMPLATE/." "$d/"
  sed -i "s/SHARD_WORKER_NAME/$repo/" "$d/wrangler.jsonc"
  sed -i "s/\"name\": \"pmtiles-shard\"/\"name\": \"$repo\"/" "$d/package.json"
  node /home/jtally/tiles/render-readme.mjs "$i" "$repo" > "$d/README.md"
  git -C "$d" init -q -b main
  git -C "$d" add -A
  printf 'Shard %s of the Protomaps basemap archive.\n\nSee sharding.md in jasontally/pmtiles-cf-snippet.\n' "$i" \
    | git -C "$d" -c user.name="Jason Tally" -c user.email="719178+jasontally@users.noreply.github.com" commit -q -F -
  git -C "$d" remote add origin "https://github.com/jasontally/$repo.git"
  git -C "$d" push -q --force origin main
  rm -rf "$d"
  echo "  pushed $repo"
  sleep 20
done
