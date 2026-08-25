# jeremyandtipsy.com !

Static site for [jeremyandtipsy.com](https://jeremyandtipsy.com), deployed to Cloudflare
Workers (static assets).

Substantially developed with Claude (Anthropic). See commit history for which model authored which change.

## Local development

```powershell
npm install
npm run dev
```

## Deploy

Preferred: connect this repo in the Cloudflare dashboard (**Workers & Pages** →
`jeremyandtipsy-com` → **Settings** → **Builds** → **Connect**) so every push to `main` builds
and deploys automatically. Deploy command: `npx wrangler deploy`.

Manual deploy, if you ever need it:

```powershell
npx wrangler login
npm run deploy
```

## Custom domain

Attached via `routes` in `wrangler.jsonc` (`custom_domain: true`). Requires
`jeremyandtipsy.com` to already be an active zone on this Cloudflare account, and no
conflicting DNS record on the root hostname.

## Adding photos and videos

- Drop new photos into `public/pictures/`.
- Drop new videos into `public/videos/` (this folder is git-ignored — the files themselves
  never get committed; they're uploaded to R2 instead).
- Run:

  ```powershell
  npm run gallery
  ```

  This updates `public/gallery.json` and generates everything it needs. It only ever
  ADDS entries or refreshes existing ones — see
  [How the gallery is stored](#how-the-gallery-is-stored-read-this-before-changing-the-scripts)
  for why removing something is a separate, explicit command.
  - **Renaming and metadata stripping** (via `scripts/ingest-media.mjs`): every newly
    added file is renamed to the next number in a shared sequence, and new JPEGs have
    their metadata stripped. See [File naming](#file-naming) and
    [Metadata](#metadata) below.
  - **Local video backup** (via `scripts/download-videos.mjs`, `npm run downloadVideos`):
    downloads any full video referenced in `gallery.json` that isn't already sitting in
    `public/videos/` under its expected name. Purely peace-of-mind — nothing in the
    pipeline needs this, R2 is the real store — and never overwrites a file that's
    already there. Thumbnails and hover-preview clips aren't included, only the full
    video.
  - **Photos**: a thumbnail in `public/thumbs/` (via `scripts/generate-thumbnails.mjs`,
    using `sharp`).
  - **Videos** (via `scripts/process-videos.mjs`, using `ffmpeg-static`/`ffprobe-static`):
    a poster-frame thumbnail in `public/thumbs/`; a small muted ~3s hover-preview clip; and
    the full video, re-encoded to H.264 capped at 1280px if it's HEVC, high-bitrate, or
    larger than that (this matters beyond file size — HEVC doesn't play in Chrome/Firefox
    at all). The preview clip and full video are uploaded to the `jeremyandtipsy-media`
    R2 bucket, keyed by the video's own poster name (`videos/<name>.mp4`,
    `previews/<name>.mp4`), and served from `https://media.jeremyandtipsy.com`; only the
    poster JPG is committed to git.
  - Safe to re-run: unchanged videos are skipped (tracked in the git-ignored
    `.media-cache.json`, cross-checked against the live entry in `gallery.json` before
    being trusted). Any video that fails to read or encode gets moved to
    `../invalid_videos/` (a sibling of this repo, never touched by git) instead of failing
    the whole batch.
  - Requires `npx wrangler login` once, with access to the `jeremyandtipsy-media` R2
    bucket.
- Commit `public/pictures/`, `public/thumbs/`, `public/gallery.json` and
  `media-sequence.json`. Do **not** commit `public/videos/` — it's ignored on purpose.

## File naming

Anything dropped into `public/pictures/` or `public/videos/` is renamed on the next
`npm run gallery` to a 12-digit zero-padded number, so nothing in the repo is ever named
`IMG-20230819-WA0046.jpg` or a WhatsApp checksum again:

```
public/pictures/WhatsApp Image 2026-08-09 at 12.00.00.jpeg  ->  000000000000.jpg
public/videos/PXL_20260809_120001.MP4                       ->  000000000001.mp4
```

Points worth knowing:

- **One sequence across both types.** A picture followed by a video gets `…12` then `…13`.
  Within a run, files are numbered in the order they landed on disk (by mtime).
- **The counter only ever goes up.** It lives in `media-sequence.json`, which is
  **committed** — the number must not restart on another clone. It is never derived from a
  file count, because deleting media would then hand the same number out twice, and
  `thumbs/<n>.jpg` is a URL: a reused one would collide with a CDN-cached copy of the old
  image. If `media-sequence.json` is ever lost, the next run floors the counter above every
  number already in use rather than starting over.
- Extensions are normalised to lowercase, and `.jpeg` becomes `.jpg`.
- Re-running `npm run ingest` on its own is safe: a file that already has a sequence name
  is left alone even if the gallery hasn't caught up with it yet.

Every file in the gallery follows this scheme now — see
[One-time sequence retrofit](#one-time-sequence-retrofit) below for how the files that
predated `scripts/ingest-media.mjs` got there.

## One-time sequence retrofit

`scripts/retrofit-sequence.mjs` (`npm run renumber`) is the migration that brought every
pre-existing photo and video (originally named things like `IMG-20230819-WA0046.jpg` or a
WhatsApp checksum) into the sequential scheme above, and moved every video's R2 objects
from a content-hash-derived key to the same sequence-name-derived key new uploads use.
It also removes exact byte-for-byte duplicate photos/videos it finds along the way.

```powershell
npm run renumber -- --dry-run   # always do this first — reports everything, changes nothing
npm run renumber
```

It's idempotent and safe to re-run: every phase re-checks the current state of
`gallery.json` and the filesystem rather than trusting anything from an earlier attempt,
so an interrupted run just picks up where it left off. It's a one-time migration, not
part of the normal `npm run gallery` flow — you shouldn't need to run it again unless a
future change reintroduces non-sequential names on purpose.

## Metadata

New JPEGs have their metadata stripped as part of the same step. **Date taken**
(`DateTimeOriginal`) and **orientation** are kept; everything else goes — GPS coordinates,
camera make/model and serial numbers, MakerNote, the embedded EXIF thumbnail, XMP, IPTC
and comments. The JFIF header and any ICC colour profile are kept, as neither identifies
anything.

This is done by editing the JPEG's marker segments (`scripts/lib/jpeg-metadata.mjs`)
rather than re-encoding through sharp, so the compressed image data is copied through
byte-for-byte — **there is no quality loss**. Orientation is kept precisely so the
rotation doesn't have to be baked into the pixels, which *would* require a re-encode.

The rest of the pipeline was already clean, with one exception that wasn't:

| Output | Metadata |
|---|---|
| Thumbnails and video posters | already stripped — sharp drops metadata unless asked not to |
| Videos uploaded to R2 | **were not stripped** until this was added |

ffmpeg copies container metadata into its output by default, so phone footage was carrying
its `location` tag (GPS coordinates) all the way into the public bucket. All three ffmpeg
paths in `scripts/process-videos.mjs` — full re-encode, stream copy, and hover preview —
now pass `-map_metadata -1 -map_chapters -1`. Only the container brand and the ffmpeg
encoder string survive.

### Backfilling older media

Everything published before those fixes carried its location data — 119 of the photos and
56 of the 80 videos. `npm run backfill` cleans them up after the fact, and has already
been run once:

```powershell
npm run backfill              # both
npm run backfill -- --photos  # photos only
npm run backfill -- --videos  # videos only
npm run backfill -- --dry-run # report, change nothing
```

It's safe to re-run — anything already clean is skipped. Photos are rewritten in place
with the same lossless surgery, so filenames, URLs and `gallery.json` don't change. Videos
are pulled from R2, stripped with a **stream copy** (the container is rebuilt, the encoded
video is untouched — no re-encode, no quality loss) and written back to the **same key**,
so every published URL keeps working and `gallery.json` needs no edit. Each
object is re-probed after stripping and the upload is skipped if a location tag somehow
survived.

The one thing it can't do is evict Cloudflare's edge cache, which will keep serving the
old copies until they expire or are purged — see
[Removed videos stay in the CDN cache](#removed-videos-stay-in-the-cdn-cache).

## How the gallery is stored (read this before changing the scripts)

`public/gallery.json` is the **source of truth**, not the filesystem. That matters because
the two media types are backed very differently:

| | Photos | Videos |
|---|---|---|
| Originals live in | `public/pictures/` — **committed** | `public/videos/` — **git-ignored** |
| Served from | this Worker's static assets | R2, via `media.jeremyandtipsy.com` |
| On a fresh clone | all present | **none present** |
| `npm run gallery` can remove entries? | **never** | **never** |

Both media scripts are **add-only**: they add an entry for anything new they find and
refresh an existing entry's thumbnail/poster if its source changed, but never remove one.
For videos this is a hard requirement — `public/videos/` is git-ignored, so a fresh clone
has no source videos, and rebuilding the manifest from that empty folder would wipe every
video off the site on someone else's first `npm run gallery`. Photos used to be handled
differently (rebuilt fresh from `public/pictures/` every run, so a file going missing —
even by accident — silently dropped its entry too) but that's exactly the kind of
unintentional loss this project doesn't want any more, so photos are add-only now as well:
a photo file going missing leaves its entry in place (now pointing at a broken image)
until someone explicitly removes it.

The upshot: **the only way any entry, file, thumbnail, poster, or R2 object is ever
removed is `npm run deletePicture`/`npm run deleteVideo`** (below). If a file's missing
or an entry's stale for any other reason, `npm run audit` will tell you — it never
deletes anything itself.

## Removing photos and videos

```powershell
npm run deletePicture jeremy-in-a-hat.jpg yes
npm run deleteVideo tipsywiggles.mp4 yes
```

Without the trailing `yes`, this **always** reports what it would do and deletes
nothing — forgetting it fails safe, not unsafe. It's a plain word rather than a `--yes`
flag on purpose: npm only forwards flag-shaped args to the underlying script when the
command uses `--`, so a `--yes` here would be silently swallowed by npm itself and never
reach the script. The name can be with or without its extension; for videos it can also
be the source filename or the bare stem (`tipsywiggles`). An ambiguous picture stem
(`jeremy.jpg` *and* `jeremy.png` both existing) is refused rather than guessed at.

**Photos** — `npm run deletePicture <name> yes` deletes the original from
`public/pictures/`, the thumbnail from `public/thumbs/`, and the entry from
`gallery.json`, directly — no re-run of `npm run gallery` needed.

**Videos** — `npm run deleteVideo <name> yes`:

- deletes `previews/<name>.mp4` and `videos/<name>.mp4` from the R2 bucket
- removes the entry from `public/gallery.json`
- deletes the poster JPG from `public/thumbs/`
- deletes the source from `public/videos/`, if this machine has it
- clears the `.media-cache.json` bookkeeping entry

Deleting the local source is not optional — leave it in place and the next
`npm run gallery` re-encodes, re-uploads and re-adds the video you just removed.

Then commit `public/gallery.json` and the deleted poster.

### Removed (or edited) videos can stay in the CDN cache

Deleting the R2 objects does **not** immediately make the URL stop working. Uploads are
sent with `Cache-Control: public, max-age=31536000, immutable`, so Cloudflare's edge keeps
serving a cached copy — a deleted video can still return `200` at its original URL for up
to a year, even though R2 itself returns `404`. To check what's actually in the bucket,
bypass the cache with a junk query string:

```powershell
curl -s -o /dev/null -w "%{http_code}" "https://media.jeremyandtipsy.com/videos/<name>.mp4?cb=$(Get-Random)"
```

The gallery won't link to it any more either way, so for ordinary tidying this doesn't
matter. **If you're removing something for privacy reasons, purge it as well** — Cloudflare
dashboard → the `jeremyandtipsy.com` zone → **Caching** → **Configuration** →
**Purge Cache** → *Custom Purge* → by URL, listing both the `videos/` and `previews/` URLs.
`wrangler` has no cache-purge command; the alternative is the
[purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/), which
needs an API token with the *Cache Purge* permission.

The same caveat applies if you re-edit an existing video's content under the same source
filename: `npm run gallery` overwrites that entry's URL in place (the key is derived from
its poster name, not its content, so an edit doesn't get a fresh URL the way a brand new
upload does), and the edge may keep serving the pre-edit bytes at that URL for a while.
Purge it the same way if you need the new cut live immediately.

### Doing it by hand

The R2 side is just two objects, keyed by the entry's own poster name — for

```json
"poster": "thumbs/000000000047.jpg",
"full": "https://media.jeremyandtipsy.com/videos/000000000047.mp4"
```

the two commands are:

```powershell
npx wrangler r2 object delete jeremyandtipsy-media/previews/000000000047.mp4 --remote
npx wrangler r2 object delete jeremyandtipsy-media/videos/000000000047.mp4 --remote
```

Note `wrangler` has no `r2 object list` — objects can only be listed via the
S3-compatible API or a Worker with a bucket binding, so an R2 listing on its own can't
tell you which poster, dimensions or duration belonged to which object. If `gallery.json`
loses its video entries, R2 cannot reconstruct them: **that file is the only record.**

Nothing prunes R2 automatically, so a video removed by editing `gallery.json` alone leaves
its objects in the bucket, still publicly fetchable at their URLs, forever — use
`npm run deleteVideo <name> yes` instead, which cleans up both.
