# TODO

## Page: say that we take a settled Protomaps build, and why

**Tabled on 7 November 2026.** A page change needs every translation redone, and
that pass costs real money and a review cycle. Do not start it for one entry.
Do this together with the next page change that needs a translation pass anyway.

What to add: a short explanation on the documentation page that Protomaps
sometimes pulls a map it already published, because something was wrong with it.
To make it less likely that the tiles we host have that problem, we update from a
build that is at least 14 days old at the time of the update.

Where it goes: the `How fresh is this?` section, `web/index.html` around line 919,
after the `Rebuilt once a month` item. The page already explains the monthly
rebuild there, so the settle rule belongs beside it.

The facts to state, in plain words:

- Protomaps lists a build before it removes it, and a removed build answers 404.
- On 7 November 2026 the build every shard took on 1 November was pulled six days
  after it was published.
- A build must be at least 14 days old at the monthly anchor before we take it.
  Measured over three years of releases, every build that Protomaps pulled was
  gone within 14 days.
- The cost of the rule is that the copy is 14 to 20 days behind the newest
  release, not 0 to 6. The page's `It is never current to the hour` item should
  agree with that number.

Do not use the words `shard`, `snippet`, `wrangler` or `Static Assets`: a test
refuses them on the page. See `i18n-plan.md` section 5 for what is translated.

Work:

1. Change the English text in `web/index.html` and the matching fragment in
   `web/i18n/en.json`.
2. Re-translate the changed fragments into every language in `web/i18n/`, and run
   the back-translation review that `i18n-plan.md` section 8 describes.
3. Update the test in `web/i18n/render.test.mjs` if the key set changes.
4. The facts come from `refresh.md`, "Why a build must settle".

## Page: this host is for range requests, not whole-file downloads

**Tabled on 7 November 2026.** Same reason: it needs the translation pass.

What to add: this tile host is meant for applications that read the archive with
range requests. It is not a place to download the whole archive. Anyone who wants
the full file should download it from Protomaps directly, at
`https://build.protomaps.com/`, and point their own hosting at that copy.

Where it goes: the `No whole-file download` item in the `What this is not`
section, `web/index.html` around line 907, and the matching fragment
`2a5364bfe71a` in `web/i18n/en.json`. The item already says a whole-file request
returns `416`; it should also say where to go instead.

The facts to state:

- Requests are answered in ranges of at most 512 KiB, which is all a PMTiles
  client asks for.
- A request for the whole archive returns `416`, and that is correct, not a
  fault.
- To download the whole archive, use the Protomaps release host. A URL in the
  text is not translated.

Work: the same four steps as the entry above.

## Page: a rebuild is 25 parts, not thirteen

**Tabled on 7 November 2026.** Same reason: it needs the translation pass. Fold it
into the same pass as the two entries above.

The `A rebuild is not instantaneous` item still says the copy is "thirteen
separate rebuilds spread over about six and a half hours". There are 25 shards,
not 13. The count was right when the archive was split 13 ways, and it was not
updated when the split changed to 25.

The time is wrong as well. `slotFor()` in `shard-repo/render-workflow.mjs` starts
the slots at 00:30 UTC and spaces them four minutes apart, so 25 slots end at
02:06 UTC, a span of 1 hour 36 minutes. The six and a half hours was the old
schedule. Each build also takes 8 to 15 minutes after its slot, so the window in
which the copy is a mix of two builds is longer than the slot span. Say both
plainly, or say "about two hours of slots" and leave the build time out.

Where it goes: the `A rebuild is not instantaneous` item, `web/index.html` around
line 941, and the matching fragment `fa033fc1116b` in `web/i18n/en.json`.

Work:

1. Change `thirteen` to `twenty-five`, and `six and a half hours` to the slot
   span above.
2. The same translation and review steps as the entries above.

`sharding.md` and the README said 13 in places that described the old split.
They were fixed on 7 November 2026, because they need no translation. Only the
page is left.
