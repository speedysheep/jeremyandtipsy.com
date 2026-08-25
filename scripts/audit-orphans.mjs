// Read-only report of mismatches between public/gallery.json and the files on disk.
// Deletes NOTHING — that's the whole point of this script existing. It replaces the
// silent "sweep unreferenced thumbnails" step generate-thumbnails.mjs used to run on
// every `npm run gallery`; now that's surfaced here instead, for a human to act on with
// `npm run deletePicture`/`npm run deleteVideo <name>`.
//
//   npm run audit
//
// Two kinds of mismatch:
//   - orphaned thumbnail/poster: a file in public/thumbs/ that no gallery.json entry
//     references any more (e.g. left behind after a manual file deletion).
//   - broken entry: a gallery.json entry whose file is missing from disk (a photo whose
//     public/pictures/ file is gone, or a video whose poster is gone) — the entry is
//     still there because nothing but the delete command is allowed to remove it.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadManifest, pictureKey, posterKey, picturesDir, thumbsDir } from "./lib/media.mjs";

const exists = async (dir, name) => {
	try {
		return (await readdir(dir)).some((f) => f.toLowerCase() === name.toLowerCase());
	} catch {
		return false;
	}
};

export async function findOrphanedThumbs() {
	const manifest = (await loadManifest()) ?? [];
	const photos = manifest.filter((e) => e.type === "photo" || !e.type);
	const videos = manifest.filter((e) => e.type === "video");

	const referenced = new Set(manifest.map(posterKey));
	const thumbFiles = (await readdir(thumbsDir, { withFileTypes: true }))
		.filter((e) => e.isFile() && /\.jpe?g$/i.test(e.name))
		.map((e) => e.name);
	const orphanedThumbs = thumbFiles.filter((name) => !referenced.has(name.toLowerCase()));

	const pictureFiles = new Set((await readdir(picturesDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));
	const missingPhotoFiles = photos.filter((e) => !pictureFiles.has(pictureKey(e)));

	const thumbSet = new Set(thumbFiles.map((n) => n.toLowerCase()));
	const missingPosterFiles = videos.filter((e) => !thumbSet.has(posterKey(e)));

	return { orphanedThumbs, missingPhotoFiles, missingPosterFiles };
}

async function main() {
	const { orphanedThumbs, missingPhotoFiles, missingPosterFiles } = await findOrphanedThumbs();

	if (orphanedThumbs.length === 0 && missingPhotoFiles.length === 0 && missingPosterFiles.length === 0) {
		console.log("Clean — every thumbnail/poster is referenced, and every entry's file exists.");
		return;
	}

	if (orphanedThumbs.length > 0) {
		console.log(`${orphanedThumbs.length} orphaned thumbnail(s) in public/thumbs/ (not referenced by any gallery.json entry):`);
		for (const name of orphanedThumbs) console.log(`  thumbs/${name}`);
		console.log("  These are harmless clutter — nothing links to them. Delete by hand if you want them gone.\n");
	}

	if (missingPhotoFiles.length > 0) {
		console.log(`${missingPhotoFiles.length} photo entr${missingPhotoFiles.length === 1 ? "y" : "ies"} whose file is missing from public/pictures/:`);
		for (const e of missingPhotoFiles) console.log(`  ${e.full} — run: npm run deletePicture ${path.basename(e.full)} yes`);
		console.log();
	}

	if (missingPosterFiles.length > 0) {
		console.log(`${missingPosterFiles.length} video entr${missingPosterFiles.length === 1 ? "y" : "ies"} whose poster is missing from public/thumbs/:`);
		for (const e of missingPosterFiles) console.log(`  ${e.poster} — run: npm run deleteVideo ${path.basename(e.poster)} yes`);
	}
}

// Only run as a report when invoked directly (`npm run audit`) — other scripts import
// findOrphanedThumbs() without wanting this to print or exit on their behalf.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
