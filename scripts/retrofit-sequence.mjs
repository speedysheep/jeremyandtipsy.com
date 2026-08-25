// One-off migration: renumbers every existing photo and video to the sequential naming
// scheme (scripts/ingest-media.mjs already does this for anything NEW; this is the
// retroactive pass that was deliberately skipped when that script was written), rekeys
// every video's R2 objects from content-hash-derived to sequence-name-derived (so two
// entries can never again collide by sharing content — see scripts/lib/media.mjs's
// videoKeyFor/previewKeyFor), and removes exact-duplicate photos/videos along the way.
//
//   npm run renumber -- --dry-run   report everything, change nothing (always run this first)
//   npm run renumber
//
// Idempotent and resumable: every phase re-derives its work from the CURRENT on-disk
// state rather than trusting anything carried over from an earlier phase, so an
// interrupted run just picks up where it left off on re-run. Order within each phase is
// deliberately upload-new -> save-manifest -> delete-old, never reversed: a crash mid-run
// can leave a harmless orphaned R2 object, but never a live gallery entry pointing at a
// 404. Deletion — of a duplicate entry, or of a superseded pre-retrofit R2 object — only
// ever happens through scripts/lib/delete-media.mjs, the same module the
// `npm run deletePicture`/`npm run deleteVideo` CLIs use.
//
// Requires: `npx wrangler login`, with access to the jeremyandtipsy-media R2 bucket.
import ffmpegPath from "ffmpeg-static";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
	R2_PUBLIC_BASE_URL,
	STRIP_METADATA,
	downloadFromR2,
	execFileAsync,
	isSequenceName,
	loadManifest,
	loadSequenceCounter,
	manifestPath,
	normaliseExt,
	picturesDir,
	posterKey,
	previewKeyFor,
	repoRoot,
	saveManifest,
	saveSequenceCounter,
	sequenceStem,
	sequenceValue,
	sha1File,
	stemOfVideo,
	thumbsDir,
	uploadToR2,
	videoKeyFor,
	videosDir,
} from "./lib/media.mjs";
import { deletePictureEntry, deleteVideoEntry, deleteStaleVideoR2Objects } from "./lib/delete-media.mjs";
import { findOrphanedThumbs } from "./audit-orphans.mjs";

const stagingDir = path.join(repoRoot, ".retrofit-staging");
const backupPath = path.join(repoRoot, "gallery.json.pre-retrofit-backup.json");

// The R2 key scheme retired by this migration: videos/<sha1>.mp4. Kept here, and only
// here, as throwaway one-time migration code — nothing else in the repo should ever need
// to parse a hash back out of a URL again once entry.hash is populated on every entry.
const OLD_HASH_URL = /\/videos\/([0-9a-f]{6,64})\.mp4(?:\?.*)?$/i;

async function listNames(dir) {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
	} catch {
		return [];
	}
}

/** Same self-healing floor scripts/ingest-media.mjs uses: never hand out a number that's
 * already in use, even if media-sequence.json is stale or was never touched by this run
 * yet. Computed once, up front — Phase 4 and Phase 5 share this single counter. */
async function startingCounter(manifest) {
	const used = [...(await listNames(picturesDir)), ...(await listNames(thumbsDir)), ...manifest.map((e) => path.basename(e.full ?? e.poster ?? ""))];
	const derivedFloor = used.reduce((max, n) => Math.max(max, (sequenceValue(n) ?? -1) + 1), 0);
	const stored = await loadSequenceCounter();
	return Math.max(stored, derivedFloor);
}

/** Picks the next free sequence stem for `dir`, mirroring ingest-media.mjs's
 * collision-check — belt and suspenders on top of the floor above. */
function claimStem(counterRef, dir, ext) {
	let stem;
	do {
		stem = sequenceStem(counterRef.value++);
	} while (existsSync(path.join(dir, stem + ext)));
	return stem;
}

async function phase0Preflight() {
	console.log("=== Phase 0: preflight ===");
	await copyFile(manifestPath, backupPath);
	console.log(`Backed up public/gallery.json -> ${path.relative(repoRoot, backupPath)}`);
	await mkdir(stagingDir, { recursive: true });
}

/** Backfills entry.hash from the pre-retrofit URL shape. Required before dedup/rekey can
 * reason about identity at all. Mutates `manifest` in place (even in dry-run — later
 * phases in THIS run need to see it to report accurately) but only writes it to disk
 * when dryRun is false. */
async function phase1HashBackfill(manifest, dryRun) {
	console.log("\n=== Phase 1: video hash backfill ===");
	let backfilled = 0;
	let missing = [];

	for (const entry of manifest) {
		if (entry.type !== "video" || entry.hash) continue;
		const match = OLD_HASH_URL.exec(entry.full ?? "");
		if (!match) {
			missing.push(entry);
			continue;
		}
		entry.hash = match[1];
		backfilled++;
	}

	if (missing.length > 0) {
		console.error(`${missing.length} video entr${missing.length === 1 ? "y has" : "ies have"} neither a hash nor a parseable URL — aborting:`);
		for (const e of missing) console.error(`  ${e.poster}`);
		process.exit(1);
	}

	console.log(`Backfilled hash on ${backfilled} entr${backfilled === 1 ? "y" : "ies"}.`);
	if (!dryRun && backfilled > 0) await saveManifest(manifest);
	return backfilled;
}

/** Groups video entries by content hash; for each duplicate group, keeps the first and
 * deletes the rest. deleteR2:false because the loser and survivor still share the SAME
 * pre-retrofit R2 object at this point — Phase 5 cleans it up once the survivor has its
 * own, exclusively-named object. The actual deletion (files/R2/disk manifest) goes
 * through scripts/lib/delete-media.mjs; `manifest` is also spliced in place here purely
 * so later phases in THIS run see the loser as already gone, dry-run or not. */
async function phase2VideoDedup(manifest, dryRun) {
	console.log("\n=== Phase 2: video dedup ===");
	const videos = manifest.filter((e) => e.type === "video");
	const byHash = new Map();
	for (const e of videos) byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e]);

	let removed = 0;
	for (const group of byHash.values()) {
		if (group.length < 2) continue;
		const [survivor, ...losers] = group;
		for (const loser of losers) {
			console.log(`  DUPLICATE: ${posterKey(loser)} is byte-identical to ${posterKey(survivor)} (hash ${loser.hash}) — removing.`);
			await deleteVideoEntry(posterKey(loser), { dryRun, deleteR2: false });
			manifest.splice(manifest.indexOf(loser), 1);
			removed++;
		}
	}
	console.log(`${dryRun ? "Would remove" : "Removed"} ${removed} duplicate video entr${removed === 1 ? "y" : "ies"}.`);
	return removed;
}

/** Same idea for photos — no shortcut available, has to hash file contents, but 285
 * small JPEGs is cheap enough to always do unconditionally. */
async function phase3PhotoDedup(manifest, dryRun) {
	console.log("\n=== Phase 3: photo dedup ===");
	const photos = manifest.filter((e) => e.type === "photo" || !e.type);
	const byHash = new Map();
	for (const e of photos) {
		const file = path.join(picturesDir, path.basename(e.full));
		if (!existsSync(file)) continue; // ADD-ONLY manifest can carry entries with no file
		const hash = await sha1File(file);
		byHash.set(hash, [...(byHash.get(hash) ?? []), e]);
	}

	let removed = 0;
	for (const group of byHash.values()) {
		if (group.length < 2) continue;
		const [survivor, ...losers] = group;
		for (const loser of losers) {
			console.log(`  DUPLICATE: ${loser.full} is byte-identical to ${survivor.full} — removing.`);
			await deletePictureEntry(path.basename(loser.full), { dryRun });
			manifest.splice(manifest.indexOf(loser), 1);
			removed++;
		}
	}
	console.log(`${dryRun ? "Would remove" : "Removed"} ${removed} duplicate photo entr${removed === 1 ? "y" : "ies"}.`);
	return removed;
}

/** Renames every non-sequence-named photo (and its thumbnail), updating gallery.json
 * per-entry so an interruption never leaves a renamed file whose entry still has the old
 * name. Metadata stripping is deliberately NOT redone here — `npm run backfill` already
 * covers every JPEG in public/pictures/ regardless of name. */
async function phase4PhotoRekey(manifest, dryRun, counterRef) {
	console.log("\n=== Phase 4: photo rekey ===");
	const photos = manifest.filter((e) => e.type === "photo" || !e.type);

	let renamed = 0;
	for (const entry of photos) {
		const oldName = path.basename(entry.full);
		if (isSequenceName(oldName)) continue;
		if (!existsSync(path.join(picturesDir, oldName))) continue; // ADD-ONLY: file already gone

		const ext = normaliseExt(oldName);
		const stem = claimStem(counterRef, picturesDir, ext);
		const newName = stem + ext;
		const oldThumb = path.basename(entry.thumb);
		const newThumb = `${stem}.jpg`;

		console.log(`  ${dryRun ? "would rename" : "renaming"} pictures/${oldName} -> ${newName}`);
		if (!dryRun) {
			await rename(path.join(picturesDir, oldName), path.join(picturesDir, newName));
			if (existsSync(path.join(thumbsDir, oldThumb))) await rename(path.join(thumbsDir, oldThumb), path.join(thumbsDir, newThumb));
			entry.full = `pictures/${newName}`;
			entry.thumb = `thumbs/${newThumb}`;
			await saveManifest(manifest);
		}
		renamed++;
	}
	console.log(`${dryRun ? "Would rename" : "Renamed"} ${renamed} photo(s).`);
	return renamed;
}

/** Downloads, strips metadata (belt and suspenders — `npm run backfill` likely already
 * did this), re-uploads under the new sequence-name-derived key, updates the entry, THEN
 * deletes the old objects — safe only because Phase 2 already guaranteed no surviving
 * entry still shares them. */
async function phase5VideoRekey(manifest, dryRun, counterRef) {
	console.log("\n=== Phase 5: video rekey ===");
	const videos = manifest.filter((e) => e.type === "video");

	let rekeyed = 0;
	for (const entry of videos) {
		const currentPosterStem = stemOfVideo(entry);
		const wantsFull = `${R2_PUBLIC_BASE_URL}/${videoKeyFor(currentPosterStem)}`;
		const wantsPreview = `${R2_PUBLIC_BASE_URL}/${previewKeyFor(currentPosterStem)}`;
		if (entry.full === wantsFull && entry.preview === wantsPreview) continue; // already migrated

		const newStem = isSequenceName(currentPosterStem) ? currentPosterStem : claimStem(counterRef, thumbsDir, ".jpg");
		const oldFullKey = entry.full.replace(`${R2_PUBLIC_BASE_URL}/`, "");
		const oldPreviewKey = entry.preview.replace(`${R2_PUBLIC_BASE_URL}/`, "");
		const newFullKey = videoKeyFor(newStem);
		const newPreviewKey = previewKeyFor(newStem);

		console.log(`  ${dryRun ? "would rekey" : "rekeying"} ${posterKey(entry)}: ${oldFullKey} -> ${newFullKey}`);
		if (dryRun) {
			rekeyed++;
			continue;
		}

		for (const [oldKey, newKey] of [
			[oldFullKey, newFullKey],
			[oldPreviewKey, newPreviewKey],
		]) {
			const dirty = path.join(stagingDir, `dirty-${path.basename(newKey)}`);
			const clean = path.join(stagingDir, `clean-${path.basename(newKey)}`);
			try {
				await downloadFromR2(oldKey, dirty);
				await execFileAsync(ffmpegPath, ["-y", "-i", dirty, "-c", "copy", ...STRIP_METADATA, "-movflags", "+faststart", clean], {
					maxBuffer: 1024 * 1024 * 32,
				});
				await uploadToR2(clean, newKey, "video/mp4");
			} finally {
				await rm(dirty, { force: true });
				await rm(clean, { force: true });
			}
		}

		// Local poster: rename if it needs a new stem, otherwise it's already right.
		if (newStem !== currentPosterStem) {
			const oldPoster = path.join(thumbsDir, path.basename(entry.poster));
			const newPoster = path.join(thumbsDir, `${newStem}.jpg`);
			if (existsSync(oldPoster)) await rename(oldPoster, newPoster);
			entry.poster = `thumbs/${newStem}.jpg`;
		}
		// Local source, if this machine happens to have it (rare — public/videos/ is
		// git-ignored). Not sanctioned-deletion territory: renaming the source WE are
		// actively managing, on the same machine, in the same run, is not "deleting
		// published content" — nothing is destroyed.
		for (const ext of [".mp4", ".mov", ".m4v"]) {
			const oldSrc = path.join(videosDir, currentPosterStem + ext);
			if (existsSync(oldSrc) && newStem !== currentPosterStem) await rename(oldSrc, path.join(videosDir, newStem + ext));
		}

		entry.full = `${R2_PUBLIC_BASE_URL}/${newFullKey}`;
		entry.preview = `${R2_PUBLIC_BASE_URL}/${newPreviewKey}`;
		await saveManifest(manifest);

		await deleteStaleVideoR2Objects(oldFullKey, oldPreviewKey, { dryRun: false });
		rekeyed++;
	}
	console.log(`${dryRun ? "Would rekey" : "Rekeyed"} ${rekeyed} video(s).`);
	return rekeyed;
}

async function phase6Audit() {
	console.log("\n=== Phase 6: read-only audit ===");
	const { orphanedThumbs, missingPhotoFiles, missingPosterFiles } = await findOrphanedThumbs();
	if (orphanedThumbs.length === 0 && missingPhotoFiles.length === 0 && missingPosterFiles.length === 0) {
		console.log("Clean — every thumbnail/poster is referenced, and every entry's file exists.");
		return;
	}
	console.warn("Not clean — something didn't fully migrate. Run `npm run audit` for details:");
	if (orphanedThumbs.length) console.warn(`  ${orphanedThumbs.length} orphaned thumbnail(s)`);
	if (missingPhotoFiles.length) console.warn(`  ${missingPhotoFiles.length} photo entr${missingPhotoFiles.length === 1 ? "y" : "ies"} with a missing file`);
	if (missingPosterFiles.length) console.warn(`  ${missingPosterFiles.length} video entr${missingPosterFiles.length === 1 ? "y" : "ies"} with a missing poster`);
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	if (dryRun) console.log("Dry run — nothing will be changed.\n");

	const manifest = await loadManifest();
	if (!manifest) {
		console.error("Couldn't read public/gallery.json — refusing to touch anything.");
		process.exit(1);
	}
	await phase0Preflight();

	// A single manifest array, threaded through every phase and mutated in place — even in
	// --dry-run, so phase N's preview can see what phase N-1 would have done. Nothing here
	// is persisted to disk unless a phase is explicitly told dryRun is false.
	await phase1HashBackfill(manifest, dryRun);
	await phase2VideoDedup(manifest, dryRun);
	await phase3PhotoDedup(manifest, dryRun);

	// One counter, shared across both phases — mirrors ingest-media.mjs numbering a
	// picture and a video from the same sequence.
	const counterRef = { value: await startingCounter(manifest) };
	await phase4PhotoRekey(manifest, dryRun, counterRef);
	await phase5VideoRekey(manifest, dryRun, counterRef);

	if (!dryRun) {
		await saveSequenceCounter(counterRef.value);
		await phase6Audit();
	}

	await rm(stagingDir, { recursive: true, force: true });

	console.log(dryRun ? "\nDry run complete — nothing was changed." : "\nDone. Review `git status` and commit the results.");
	if (!dryRun) console.log(`A pre-retrofit backup of gallery.json is at ${path.relative(repoRoot, backupPath)} if you need to compare.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
