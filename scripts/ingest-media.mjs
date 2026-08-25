// Normalises newly added media before anything else looks at it:
//   1. renames it to the next number in a shared 12-digit sequence (000000000000.jpg,
//      000000000001.mp4, ...) so nobody has to type a WhatsApp checksum ever again
//   2. strips metadata from JPEGs, keeping only "date taken" and orientation
//
// Runs first in `npm run gallery`, so the thumbnail and video steps only ever see the
// final names.
//
// "New" means "not already referenced by public/gallery.json" — photos by filename,
// videos by the stem of their poster. Everything already in the gallery keeps the name it
// has: this is deliberately not a retroactive renumbering.
//
// The counter lives in the committed media-sequence.json and only ever goes up. It is
// never derived from a file count, because deleting media must not cause a number to be
// handed out twice (public/thumbs/<n>.jpg is a URL, and a reused one would collide with a
// cached copy of the old image).
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
	isPhoto,
	isSequenceName,
	isVideo,
	loadManifest,
	loadSequenceCounter,
	normaliseExt,
	picturesDir,
	repoRoot,
	saveSequenceCounter,
	sequenceName,
	sequenceValue,
	videosDir,
} from "./lib/media.mjs";

import { stripJpegMetadata } from "./lib/jpeg-metadata.mjs";

const stemOf = (name) => path.parse(name).name.toLowerCase();

async function listMedia(dir, predicate) {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isFile() && predicate(e.name)).map((e) => e.name);
	} catch {
		return [];
	}
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");

	const manifest = await loadManifest();
	if (!manifest) {
		console.error("Couldn't read public/gallery.json — refusing to rename anything.");
		console.error("Without it there's no way to tell a new file from one already in the gallery.");
		process.exit(1);
	}

	const knownPhotos = new Set(
		manifest.filter((e) => e.type === "photo" || !e.type).map((e) => path.basename(e.full ?? "").toLowerCase()),
	);
	const knownVideoStems = new Set(
		manifest.filter((e) => e.type === "video").map((e) => stemOf(path.basename(e.poster ?? ""))),
	);

	const pictures = await listMedia(picturesDir, isPhoto);
	const videos = await listMedia(videosDir, isVideo);

	// A file that already carries a sequence name has been through here before — the
	// gallery just hasn't caught up yet (ingest runs before the thumbnail/video steps that
	// write the entry). Skipping them keeps a second `npm run ingest` from renumbering.
	const candidates = [
		...pictures
			.filter((n) => !knownPhotos.has(n.toLowerCase()) && !isSequenceName(n))
			.map((name) => ({ name, dir: picturesDir, kind: "picture" })),
		...videos
			.filter((n) => !knownVideoStems.has(stemOf(n)) && !isSequenceName(n))
			.map((name) => ({ name, dir: videosDir, kind: "video" })),
	];

	if (candidates.length === 0) {
		console.log("No new media to ingest.");
		return;
	}

	// Number them in the order they landed on disk, so a picture dropped in before a video
	// gets the lower number regardless of which folder they're in.
	for (const c of candidates) c.mtimeMs = (await stat(path.join(c.dir, c.name))).mtimeMs;
	candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

	console.log(`Ingesting ${candidates.length} new file(s).`);

	// The stored counter is the authority, but floor it with anything already using a
	// sequence name so a lost or stale media-sequence.json can't hand out a duplicate.
	const used = [...pictures, ...videos, ...manifest.map((e) => path.basename(e.full ?? e.poster ?? ""))];
	const derivedFloor = used.reduce((max, n) => Math.max(max, (sequenceValue(n) ?? -1) + 1), 0);
	const stored = await loadSequenceCounter();
	let counter = Math.max(stored, derivedFloor);
	if (derivedFloor > stored) {
		console.log(`  (media-sequence.json said ${stored}, existing names require ${derivedFloor} — using ${counter})`);
	}

	let renamed = 0;
	let stripped = 0;

	for (const c of candidates) {
		const ext = normaliseExt(c.name);
		let target;
		do {
			target = sequenceName(counter, ext);
			counter++;
		} while (existsSync(path.join(c.dir, target)));

		const from = path.join(c.dir, c.name);
		const to = path.join(c.dir, target);
		const rel = path.relative(repoRoot, c.dir).replace(/\\/g, "/");

		if (dryRun) {
			console.log(`  would rename ${rel}/${c.name} -> ${target}`);
		} else {
			await rename(from, to);
			console.log(`  ${rel}/${c.name} -> ${target}`);
			renamed++;
		}

		// Only JPEGs carry the EXIF we care about. Videos are handled by ffmpeg's
		// -map_metadata -1 in process-videos.mjs; posters and thumbnails come out of
		// sharp, which drops metadata by default.
		if (c.kind !== "picture" || ext !== ".jpg") continue;

		const source = dryRun ? from : to;
		const input = await readFile(source);
		const result = stripJpegMetadata(input);
		if (!result) {
			console.warn(`    ! couldn't parse ${target} as a JPEG — leaving its metadata alone`);
			continue;
		}
		const saved = input.length - result.buffer.length;
		const keptBits = [
			result.kept.dateTimeOriginal ? `date taken ${result.kept.dateTimeOriginal}` : null,
			result.kept.orientation ? `orientation ${result.kept.orientation}` : null,
		].filter(Boolean);

		if (dryRun) {
			console.log(`    would strip metadata (${(saved / 1024).toFixed(0)} KB), keeping ${keptBits.join(" + ") || "nothing"}`);
			continue;
		}
		await writeFile(to, result.buffer);
		stripped++;
		console.log(`    stripped metadata (-${(saved / 1024).toFixed(0)} KB), kept ${keptBits.join(" + ") || "nothing"}`);
	}

	if (dryRun) {
		console.log(`\nDry run — nothing was changed. Next number would be ${String(counter).padStart(12, "0")}.`);
		return;
	}

	await saveSequenceCounter(counter);
	console.log(`\nRenamed ${renamed} file(s), stripped ${stripped} JPEG(s). Next number: ${String(counter).padStart(12, "0")}.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
