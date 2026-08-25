// Processes every video in public/videos/ and publishes it to R2:
//   - a poster JPG (first frame) into public/thumbs/ — committed to git, just like photo thumbs
//   - a tiny muted hover-preview clip, uploaded to R2 under previews/<stem>.mp4
//   - the full video (re-encoded to H.264 + downscaled if it's HEVC / large / high-bitrate),
//     uploaded to R2 under videos/<stem>.mp4
// <stem> is the video's own poster stem (e.g. "000000000047") — every entry owns an
// exclusively-named R2 object, so two entries can never collide by sharing content.
// Entries are merged into public/gallery.json (type: "video"), alongside whatever
// scripts/generate-thumbnails.mjs already wrote for photos.
//
// Run with: node scripts/process-videos.mjs (or `npm run gallery` to also do photos).
// Safe to re-run: unchanged source videos are skipped via .media-cache.json.
//
// ⚠️ This script is ADD-ONLY. It never removes a video from gallery.json, because
// public/videos/ is git-ignored: on a fresh clone that folder is empty, and anything
// that rebuilt the manifest from it would delete every video on the site. Existing
// entries whose source file isn't present locally are carried through untouched.
// To remove a video, use `npm run deleteVideo <name>` (scripts/delete-media.mjs).
//
// Requires: `npx wrangler login` once, with access to the jeremyandtipsy-media R2 bucket.
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
	R2_PUBLIC_BASE_URL,
	STRIP_METADATA,
	execFileAsync,
	hashFromEntry,
	isVideo,
	loadCache,
	loadManifest,
	posterKey,
	previewKeyFor,
	repoRoot,
	saveCache,
	saveManifest,
	sha1File,
	thumbsDir,
	uploadToR2,
	videoKeyFor,
	videoNameToPoster,
	videosDir,
} from "./lib/media.mjs";

const stagingDir = path.join(repoRoot, ".video-staging");
// Videos that fail to probe/encode are moved here (sibling of the repo, never committed).
const invalidDir = path.join(repoRoot, "..", "invalid_videos");

const MAX_LONG_EDGE = 1280; // re-encode target for the full video
const REENCODE_BITRATE_THRESHOLD = 4_000_000; // bps; above this we re-encode even if already H.264
const PREVIEW_LONG_EDGE = 640;
const PREVIEW_DURATION = 3; // seconds

/** Do the fields that matter actually match, or is the cache describing a different world? */
function sameVideoEntry(a, b) {
	if (!a || !b) return false;
	return ["poster", "full", "preview", "hash", "width", "height", "duration"].every((k) => a[k] === b[k]);
}

async function probe(filePath) {
	const { stdout } = await execFileAsync(ffprobeStatic.path, [
		"-v",
		"error",
		"-show_entries",
		"stream=codec_type,codec_name,width,height,bit_rate",
		"-show_entries",
		"format=duration,bit_rate",
		"-of",
		"json",
		filePath,
	]);
	const data = JSON.parse(stdout);
	const video = data.streams?.find((s) => s.codec_type === "video");
	const audio = data.streams?.find((s) => s.codec_type === "audio");
	if (!video || !video.width || !video.height) {
		throw new Error("no usable video stream");
	}
	return {
		width: video.width,
		height: video.height,
		codec: video.codec_name,
		bitRate: Number(video.bit_rate || data.format?.bit_rate || 0),
		duration: Number(data.format?.duration || 0),
		hasAudio: Boolean(audio),
	};
}

function scaledDims(width, height, longEdge) {
	if (Math.max(width, height) <= longEdge) {
		return { width: evenify(width), height: evenify(height) };
	}
	if (width >= height) {
		return { width: longEdge, height: evenify(Math.round((height * longEdge) / width)) };
	}
	return { width: evenify(Math.round((width * longEdge) / height)), height: longEdge };
}

const evenify = (n) => (n % 2 === 0 ? n : n - 1);

function needsReencode(info) {
	return (
		info.codec !== "h264" ||
		Math.max(info.width, info.height) > MAX_LONG_EDGE ||
		info.bitRate > REENCODE_BITRATE_THRESHOLD
	);
}

async function run(args, label) {
	try {
		await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });
	} catch (err) {
		throw new Error(`${label} failed: ${err.stderr?.slice(-2000) || err.message}`);
	}
}

async function makeFullVideo(srcPath, outPath, info) {
	if (!needsReencode(info)) {
		await execFileAsync(ffmpegPath, ["-y", "-i", srcPath, "-c", "copy", ...STRIP_METADATA, "-movflags", "+faststart", outPath]);
		return;
	}
	const { width, height } = scaledDims(info.width, info.height, MAX_LONG_EDGE);
	const args = [
		"-y",
		"-i",
		srcPath,
		...STRIP_METADATA,
		"-vf",
		`scale=${width}:${height}`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"26",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
	];
	if (info.hasAudio) {
		args.push("-c:a", "aac", "-b:a", "128k");
	} else {
		args.push("-an");
	}
	args.push(outPath);
	await run(args, "full video re-encode");
}

async function makePreviewClip(srcPath, outPath, info) {
	const { width, height } = scaledDims(info.width, info.height, PREVIEW_LONG_EDGE);
	const start = Math.min(1, info.duration * 0.1);
	const clipLength = Math.min(PREVIEW_DURATION, Math.max(info.duration - start, 0.5));
	await run(
		[
			"-y",
			"-ss",
			String(start),
			"-i",
			srcPath,
			"-t",
			String(clipLength),
			...STRIP_METADATA,
			"-vf",
			`scale=${width}:${height}`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"30",
			"-pix_fmt",
			"yuv420p",
			"-an",
			"-movflags",
			"+faststart",
			outPath,
		],
		"preview clip encode",
	);
}

async function makePoster(srcPath, outJpgPath, info) {
	const framePath = path.join(stagingDir, `poster-${path.basename(outJpgPath)}.raw.jpg`);
	const at = Math.min(1, info.duration / 2);
	await run(["-y", "-ss", String(at), "-i", srcPath, "-frames:v", "1", "-q:v", "2", framePath], "poster extraction");
	await sharp(framePath).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(outJpgPath);
	await rm(framePath, { force: true });
}

async function quarantine(name, reason) {
	await mkdir(invalidDir, { recursive: true });
	console.warn(`  ! ${name}: ${reason} -- moving to ${invalidDir}`);
	try {
		await rename(path.join(videosDir, name), path.join(invalidDir, name));
	} catch (err) {
		console.warn(`    (couldn't move it: ${err.message}; leaving it in public/videos/)`);
	}
}

async function main() {
	await mkdir(videosDir, { recursive: true });
	await mkdir(thumbsDir, { recursive: true });
	await mkdir(stagingDir, { recursive: true });

	const entries = await readdir(videosDir, { withFileTypes: true });
	const videos = entries
		.filter((e) => e.isFile() && isVideo(e.name))
		.map((e) => e.name)
		.sort();

	const manifest = (await loadManifest()) ?? [];
	const otherEntries = manifest.filter((e) => e.type !== "video");
	const existingVideos = manifest.filter((e) => e.type === "video");
	const byPoster = new Map(existingVideos.map((e) => [posterKey(e), e]));

	const missingHash = existingVideos.filter((e) => !hashFromEntry(e));
	if (missingHash.length > 0) {
		console.error(
			`${missingHash.length} video entr${missingHash.length === 1 ? "y is" : "ies are"} missing a "hash" field — ` +
				`this usually means \`npm run renumber\` hasn't been run yet. Refusing to continue.`,
		);
		process.exit(1);
	}

	console.log(`Found ${videos.length} videos in public/videos/, ${existingVideos.length} already in gallery.json.`);

	const cache = await loadCache();
	// Kept in sync with the manifest on disk after every single video, not just at the end —
	// a crash partway through a run must never leave the cache "ahead of" gallery.json.
	let currentVideos = existingVideos.slice();
	let added = 0;
	let updated = 0;
	let unchanged = 0;

	const persist = () => saveManifest([...otherEntries, ...currentVideos]);

	for (const name of videos) {
		const srcPath = path.join(videosDir, name);
		const posterName = videoNameToPoster(name);
		const key = posterName.toLowerCase();
		const existing = byPoster.get(key);

		let info;
		try {
			info = await probe(srcPath);
		} catch (err) {
			await quarantine(name, `couldn't read it (${err.message})`);
			continue;
		}

		const srcStat = await stat(srcPath);
		const cached = cache[name];

		// Fast path: gallery already has it, the file hasn't moved since we cached it, AND
		// the cached entry still matches what's actually live in gallery.json. That last
		// check matters — a cache can end up describing a gallery.json that got reverted or
		// hand-edited after the cache was written, and blindly trusting size/mtime alone was
		// exactly how a past run's real work silently never made it into the manifest.
		if (existing && cached && cached.size === srcStat.size && cached.mtimeMs === srcStat.mtimeMs && sameVideoEntry(cached.entry, existing)) {
			unchanged++;
			continue;
		}

		console.log(`\n${name}`);

		let hash;
		try {
			hash = await sha1File(srcPath);
		} catch (err) {
			await quarantine(name, `couldn't hash it (${err.message})`);
			continue;
		}

		// Slower path: no usable cache (fresh clone, cache deleted), but the bytes are the
		// same ones the gallery entry was built from. Nothing to re-encode or re-upload.
		const existingHash = existing ? hashFromEntry(existing) : null;
		if (existing && existingHash === hash) {
			console.log("  unchanged (matched gallery entry by hash), refreshing cache only");
			cache[name] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs, entry: existing };
			await saveCache(cache);
			unchanged++;
			continue;
		}

		// Either brand-new, or the source really did change. Build everything from scratch.
		const posterPath = path.join(thumbsDir, posterName);
		const fullStagePath = path.join(stagingDir, `full-${hash}.mp4`);
		const previewStagePath = path.join(stagingDir, `preview-${hash}.mp4`);

		try {
			console.log("  extracting poster frame...");
			await makePoster(srcPath, posterPath, info);

			console.log("  encoding preview clip...");
			await makePreviewClip(srcPath, previewStagePath, info);

			console.log(needsReencode(info) ? "  re-encoding full video (H.264, capped at 1280px)..." : "  full video already web-friendly, copying...");
			await makeFullVideo(srcPath, fullStagePath, info);
		} catch (err) {
			await quarantine(name, err.message);
			continue;
		}

		// Keyed by this entry's OWN poster stem, not by content — so re-processing an
		// existing entry (source content changed) overwrites the same URL instead of
		// minting a new one, and there's no stale object to clean up afterward.
		const stem = path.parse(posterName).name;
		const videoKey = videoKeyFor(stem);
		const previewKey = previewKeyFor(stem);

		console.log("  uploading to R2...");
		await uploadToR2(fullStagePath, videoKey, "video/mp4");
		await uploadToR2(previewStagePath, previewKey, "video/mp4");

		await rm(fullStagePath, { force: true });
		await rm(previewStagePath, { force: true });

		const finalDims = needsReencode(info) ? scaledDims(info.width, info.height, MAX_LONG_EDGE) : { width: info.width, height: info.height };

		const entry = {
			type: "video",
			poster: `thumbs/${posterName}`,
			preview: `${R2_PUBLIC_BASE_URL}/${previewKey}`,
			full: `${R2_PUBLIC_BASE_URL}/${videoKey}`,
			width: finalDims.width,
			height: finalDims.height,
			duration: info.duration,
			hash,
		};

		if (existing) {
			const i = currentVideos.indexOf(existing);
			currentVideos[i] = entry;
			byPoster.set(key, entry);
			updated++;
		} else {
			currentVideos.push(entry);
			byPoster.set(key, entry);
			added++;
		}

		cache[name] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs, entry };
		await saveCache(cache);
		// Persisted immediately, not batched until the whole run finishes — a crash on the
		// NEXT video must never leave this one cached-as-done but missing from gallery.json.
		await persist();

		console.log(`  done -> ${entry.full}`);
	}

	// Harmless no-op if the loop above already persisted everything (it always does).
	await persist();

	const localPosters = new Set(videos.map((n) => videoNameToPoster(n).toLowerCase()));
	const carriedOver = existingVideos.filter((e) => !localPosters.has(posterKey(e))).length;
	console.log(`\ngallery.json: ${currentVideos.length} video entries (${added} added, ${updated} updated, ${unchanged} unchanged).`);
	if (carriedOver > 0) {
		console.log(`${carriedOver} entries have no source file in public/videos/ and were left untouched (that folder is git-ignored).`);
	}
	console.log("This script never removes videos — use `npm run deleteVideo <name>` for that.");

	await rm(stagingDir, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
