// Downloads every video referenced in public/gallery.json into public/videos/, purely so
// a local copy exists on this machine — public/videos/ is git-ignored and R2 is the real
// store, so nothing in the pipeline actually needs this to have been run. It's peace of
// mind, not functionality.
//
//   npm run downloadVideos
//
// Skips anything already present locally under any of VIDEO_EXTENSIONS — determined
// entirely from gallery.json + what's on disk, no R2 listing involved. Never overwrites:
// if a local copy already exists, whatever's in it is left alone.
//
// Runs as part of `npm run gallery`, between the thumbnail and video-processing steps, so
// anything it fetches gets folded into the same run via scripts/process-videos.mjs's
// existing hash-match fast path instead of being treated as untouched.
//
// Requires: `npx wrangler login` once, with access to the jeremyandtipsy-media R2 bucket.
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { R2_PUBLIC_BASE_URL, VIDEO_EXTENSIONS, downloadFromR2, loadManifest, videosDir } from "./lib/media.mjs";

const exists = async (p) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

async function main() {
	await mkdir(videosDir, { recursive: true });
	const manifest = (await loadManifest()) ?? [];
	const videos = manifest.filter((e) => e.type === "video");

	console.log(`Checking ${videos.length} video entries against public/videos/...`);

	let downloaded = 0;
	let skipped = 0;
	let failed = 0;

	for (const entry of videos) {
		const stem = path.parse(path.basename(entry.poster ?? "")).name;
		const alreadyLocal = (await Promise.all(VIDEO_EXTENSIONS.map((ext) => exists(path.join(videosDir, stem + ext))))).some(Boolean);
		if (alreadyLocal) {
			skipped++;
			continue;
		}

		// Read the key straight out of the entry's own URL rather than reconstructing it
		// from the poster name — an entry that hasn't been through `npm run renumber` yet
		// may still be sitting at an old, content-hash-derived key.
		const key = entry.full.replace(`${R2_PUBLIC_BASE_URL}/`, "");
		const localPath = path.join(videosDir, `${stem}.mp4`); // full videos are always uploaded as .mp4
		console.log(`  downloading ${key} -> videos/${stem}.mp4`);
		try {
			await downloadFromR2(key, localPath);
			downloaded++;
		} catch (err) {
			console.warn(`  ! ${stem}: couldn't download (${err.stderr?.trim() || err.message})`);
			failed++;
		}
	}

	console.log(`\n${downloaded} downloaded, ${skipped} already present locally${failed ? `, ${failed} failed` : ""}.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
