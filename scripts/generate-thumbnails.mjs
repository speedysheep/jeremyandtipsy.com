// Generates gallery thumbnails for every photo in public/pictures/.
// Run with: node scripts/generate-thumbnails.mjs (or `npm run gallery` to also process videos)
// Run any time you add photos to public/pictures/ before deploying.
//
// ADD-ONLY, like scripts/process-videos.mjs: a photo already in gallery.json keeps its
// entry even if its file later goes missing from public/pictures/ (accidental delete, bad
// rsync, whatever) — only its thumbnail gets refreshed if the source changed. The ONLY way
// an entry is ever removed is `npm run deletePicture <name>` (scripts/delete-media.mjs).
// This used to rebuild the whole photo list from disk and silently drop/clean up anything
// no longer present; see scripts/audit-orphans.mjs for the read-only report that replaced
// that sweep.
import sharp from "sharp";
import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { isPhoto, loadManifest, pictureKey, picturesDir, saveManifest, thumbsDir } from "./lib/media.mjs";
import { findOrphanedThumbs } from "./audit-orphans.mjs";

const THUMB_WIDTH = 480; // ~2x a 240px grid cell, for retina screens
const THUMB_QUALITY = 78;

async function main() {
	await mkdir(picturesDir, { recursive: true });
	await mkdir(thumbsDir, { recursive: true });

	const entries = await readdir(picturesDir, { withFileTypes: true });
	const photos = entries
		.filter((e) => e.isFile() && isPhoto(e.name))
		.map((e) => e.name)
		.sort();

	const manifest = (await loadManifest()) ?? [];
	const otherEntries = manifest.filter((e) => e.type !== "photo" && e.type);
	const existingPhotos = manifest.filter((e) => e.type === "photo" || !e.type);
	const byFull = new Map(existingPhotos.map((e) => [pictureKey(e), e]));

	console.log(`Found ${photos.length} photos in public/pictures/, ${existingPhotos.length} already in gallery.json.`);

	let added = 0;
	let refreshed = 0;
	const currentPhotos = existingPhotos.slice();

	for (const name of photos) {
		const srcPath = path.join(picturesDir, name);
		const thumbName = name.replace(/\.(jpe?g|png|webp)$/i, ".jpg");
		const thumbPath = path.join(thumbsDir, thumbName);
		const key = name.toLowerCase();
		const existing = byFull.get(key);

		const image = sharp(srcPath).rotate(); // rotate() auto-applies EXIF orientation
		const meta = await image.metadata();

		const srcStat = await stat(srcPath);
		let thumbStat;
		try {
			thumbStat = await stat(thumbPath);
		} catch {
			thumbStat = null;
		}

		if (!thumbStat || thumbStat.mtimeMs < srcStat.mtimeMs) {
			await image
				.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
				.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
				.toFile(thumbPath);
			thumbStat = await stat(thumbPath);
			console.log(
				`  ${name} (${(srcStat.size / 1024).toFixed(0)} KB) -> thumbs/${thumbName} (${(thumbStat.size / 1024).toFixed(0)} KB)`,
			);
			if (existing) refreshed++;
		}

		const entry = { type: "photo", full: `pictures/${name}`, thumb: `thumbs/${thumbName}`, width: meta.width, height: meta.height };
		if (existing) {
			currentPhotos[currentPhotos.indexOf(existing)] = entry;
			byFull.set(key, entry);
		} else {
			currentPhotos.push(entry);
			byFull.set(key, entry);
			added++;
			console.log(`  ${name} -> thumbs/${thumbName} (new)`);
		}
	}

	await saveManifest([...currentPhotos, ...otherEntries]);
	console.log(`\ngallery.json: ${currentPhotos.length} photo entries (${added} added, ${refreshed} thumbnail(s) refreshed).`);

	const localFiles = new Set(photos.map((n) => n.toLowerCase()));
	const carriedOver = existingPhotos.filter((e) => !localFiles.has(pictureKey(e))).length;
	if (carriedOver > 0) {
		console.log(`${carriedOver} entries have no file in public/pictures/ — run \`npm run audit\` for details.`);
	}
	console.log("This script never removes photos — use `npm run deletePicture <name>` for that.");

	const { orphanedThumbs } = await findOrphanedThumbs();
	if (orphanedThumbs.length > 0) {
		console.log(`${orphanedThumbs.length} orphaned thumbnail(s) found — run \`npm run audit\` for details.`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
