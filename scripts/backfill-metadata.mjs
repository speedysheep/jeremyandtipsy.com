// One-off backfill: strips location data from media that was published before
// scripts/ingest-media.mjs and the ffmpeg -map_metadata flags existed.
//
//   npm run backfill              both photos and videos
//   npm run backfill -- --photos  photos only
//   npm run backfill -- --videos  videos only
//   npm run backfill -- --dry-run report what would change, touch nothing
//
// Photos: every JPEG in public/pictures/ is rewritten in place with the same lossless
// segment surgery new files get — date taken and orientation kept, GPS and the rest
// dropped. Filenames don't change, so no URL and no gallery.json entry changes.
//
// Videos: for each entry whose R2 objects still carry a location tag, both the full video
// and its hover preview are pulled from the bucket, stripped with a stream copy (no
// re-encode, so no quality loss and no re-hashing), and written back to the SAME key.
// gallery.json and every published URL stay exactly as they are.
//
// Cloudflare's edge will keep serving the old copies until they're purged or expire —
// see the "Removed videos stay in the CDN cache" section of the README.
//
// Requires: `npx wrangler login`, with access to the jeremyandtipsy-media R2 bucket.
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { R2_PUBLIC_BASE_URL, downloadFromR2, execFileAsync, isPhoto, loadManifest, picturesDir, repoRoot, uploadToR2 } from "./lib/media.mjs";

import { stripJpegMetadata } from "./lib/jpeg-metadata.mjs";

const stagingDir = path.join(repoRoot, ".backfill-staging");

const LOCATION_TAGS = ["location", "location-eng"];

async function formatTags(target) {
	const { stdout } = await execFileAsync(ffprobeStatic.path, ["-v", "error", "-show_entries", "format_tags", "-of", "json", target], {
		maxBuffer: 1024 * 1024 * 8,
	});
	return JSON.parse(stdout).format?.tags ?? {};
}

const hasLocation = (tags) => LOCATION_TAGS.some((t) => tags[t]);

async function backfillPhotos(dryRun) {
	const files = (await readdir(picturesDir, { withFileTypes: true })).filter((e) => e.isFile() && isPhoto(e.name)).map((e) => e.name);
	console.log(`\n=== Photos: ${files.length} in public/pictures/ ===`);

	let changed = 0;
	let before = 0;
	let after = 0;
	let skipped = 0;

	for (const name of files) {
		if (!/\.jpe?g$/i.test(name)) {
			skipped++;
			continue;
		}
		const file = path.join(picturesDir, name);
		const input = await readFile(file);
		const result = stripJpegMetadata(input);
		if (!result) {
			console.warn(`  ! ${name}: couldn't parse as JPEG, left alone`);
			skipped++;
			continue;
		}
		if (result.buffer.length === input.length && result.buffer.equals(input)) continue; // already clean

		before += input.length;
		after += result.buffer.length;
		changed++;
		const kept = result.kept.dateTimeOriginal ? `kept date taken ${result.kept.dateTimeOriginal}` : "no date taken to keep";
		if (dryRun) {
			console.log(`  would strip ${name} (-${((input.length - result.buffer.length) / 1024).toFixed(0)} KB, ${kept})`);
			continue;
		}
		// Keep the original timestamps: generate-thumbnails.mjs decides whether a thumbnail
		// is stale by comparing mtimes, and a metadata-only rewrite doesn't change a pixel.
		const { atime, mtime } = await stat(file);
		await writeFile(file, result.buffer);
		await utimes(file, atime, mtime);
		console.log(`  ${name} (-${((input.length - result.buffer.length) / 1024).toFixed(0)} KB, ${kept})`);
	}

	console.log(
		`${dryRun ? "Would rewrite" : "Rewrote"} ${changed} photo(s), ${skipped} skipped, ` +
			`${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB.`,
	);
}

async function backfillVideos(dryRun) {
	const manifest = (await loadManifest()) ?? [];
	const videos = manifest.filter((e) => e.type === "video");
	console.log(`\n=== Videos: checking ${videos.length} published entries ===`);

	await mkdir(stagingDir, { recursive: true });
	let affected = 0;
	let rewritten = 0;
	let failed = 0;

	for (const [index, entry] of videos.entries()) {
		const label = path.basename(entry.poster ?? "?").replace(/\.jpg$/i, "");
		// Read the key straight out of the entry's own URL rather than reconstructing it
		// from the poster name — an entry that hasn't been through `npm run renumber` yet
		// may still be sitting at an old, content-hash-derived key, and reconstructing the
		// new-scheme key would strip-and-upload to a URL nothing points at, leaving the
		// real (dirty) object untouched.
		const fullKey = entry.full.replace(`${R2_PUBLIC_BASE_URL}/`, "");
		const previewKey = entry.preview.replace(`${R2_PUBLIC_BASE_URL}/`, "");

		// Probe the public URLs first — cheap, and tells us whether there's anything to do.
		let targets;
		try {
			const [fullTags, previewTags] = await Promise.all([formatTags(entry.full), formatTags(entry.preview)]);
			targets = [hasLocation(fullTags) ? fullKey : null, hasLocation(previewTags) ? previewKey : null].filter(Boolean);
		} catch (err) {
			console.warn(`  ! ${label}: couldn't probe (${err.message.split("\n")[0]}), skipping`);
			failed++;
			continue;
		}

		if (targets.length === 0) continue;
		affected++;

		if (dryRun) {
			console.log(`  [${index + 1}/${videos.length}] would strip ${label}: ${targets.join(", ")}`);
			continue;
		}

		console.log(`  [${index + 1}/${videos.length}] ${label}`);
		for (const key of targets) {
			const dirty = path.join(stagingDir, `dirty-${path.basename(key)}`);
			const clean = path.join(stagingDir, `clean-${path.basename(key)}`);
			try {
				await downloadFromR2(key, dirty);
				// Stream copy: containers get rewritten, the encoded video is untouched.
				await execFileAsync(ffmpegPath, ["-y", "-i", dirty, "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", clean], {
					maxBuffer: 1024 * 1024 * 32,
				});
				const remaining = await formatTags(clean);
				if (hasLocation(remaining)) throw new Error("location tag survived the strip");
				const size = (await stat(clean)).size;
				await uploadToR2(clean, key, "video/mp4");
				console.log(`      ${key} rewritten (${(size / 1048576).toFixed(1)} MB)`);
				rewritten++;
			} catch (err) {
				console.warn(`      ! ${key} failed: ${err.stderr?.slice(-300)?.trim() || err.message}`);
				failed++;
			} finally {
				await rm(dirty, { force: true });
				await rm(clean, { force: true });
			}
		}
	}

	await rm(stagingDir, { recursive: true, force: true });
	console.log(
		`${dryRun ? "Would rewrite" : "Rewrote"} ${affected} video(s)` +
			(dryRun ? "" : ` (${rewritten} objects)`) +
			(failed ? `, ${failed} failure(s)` : "") +
			".",
	);
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const onlyPhotos = args.includes("--photos");
	const onlyVideos = args.includes("--videos");
	const doPhotos = onlyPhotos || !onlyVideos;
	const doVideos = onlyVideos || !onlyPhotos;

	if (dryRun) console.log("Dry run — nothing will be changed.");

	if (doPhotos) await backfillPhotos(dryRun);
	if (doVideos) await backfillVideos(dryRun);

	if (!dryRun) {
		console.log("\nDone.");
		if (doPhotos) console.log("Commit the rewritten files in public/pictures/.");
		if (doVideos) console.log("gallery.json is unchanged — the R2 objects were replaced at their existing keys.");
		console.log("Cloudflare's edge still has the old copies cached; purge if that matters.");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
