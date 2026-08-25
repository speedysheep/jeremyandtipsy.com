// Shared paths, R2 helpers and gallery.json plumbing for the media scripts.
//
// The single most important rule this module encodes: public/gallery.json is the
// source of truth for both media types, NOT the filesystem. Photos and videos are only
// ever ADDED by scripts/ingest-media.mjs / scripts/generate-thumbnails.mjs /
// scripts/process-videos.mjs, and only ever REMOVED by scripts/lib/delete-media.mjs
// (via `npm run deletePicture`/`npm run deleteVideo <name>`) — nothing else in this repo is allowed
// to delete a published file, an R2 object, or a manifest entry. See that file's header
// for the full rationale.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.join(__dirname, "..", "..");
export const publicDir = path.join(repoRoot, "public");
export const picturesDir = path.join(publicDir, "pictures");
export const videosDir = path.join(publicDir, "videos");
export const thumbsDir = path.join(publicDir, "thumbs");
export const manifestPath = path.join(publicDir, "gallery.json");
export const cachePath = path.join(repoRoot, ".media-cache.json");
// Committed, unlike .media-cache.json — the counter has to survive a clone, or a second
// machine would restart numbering and collide with names already in use.
export const sequencePath = path.join(repoRoot, "media-sequence.json");

export const SEQUENCE_DIGITS = 12;
export const sequenceStem = (n) => String(n).padStart(SEQUENCE_DIGITS, "0");
export const sequenceName = (n, ext) => sequenceStem(n) + ext;
export const isSequenceName = (name) => new RegExp(`^\\d{${SEQUENCE_DIGITS}}$`).test(path.parse(name).name);
export const sequenceValue = (name) => (isSequenceName(name) ? Number(path.parse(name).name) : null);

/** Reads the high-water mark. Only ever moves forward — numbers are never reused. */
export async function loadSequenceCounter() {
	try {
		const parsed = JSON.parse(await readFile(sequencePath, "utf8"));
		return Number.isInteger(parsed?.next) && parsed.next >= 0 ? parsed.next : 0;
	} catch {
		return 0;
	}
}

export async function saveSequenceCounter(next) {
	await writeFile(sequencePath, `${JSON.stringify({ next }, null, 2)}\n`);
}

export const R2_BUCKET = "jeremyandtipsy-media";
export const R2_PUBLIC_BASE_URL = "https://media.jeremyandtipsy.com";

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];

export const isVideo = (name) => /\.(mp4|mov|m4v)$/i.test(name);
export const isPhoto = (name) => /\.(jpe?g|png|webp)$/i.test(name);

/** Normalises the extension a file should be stored under: lowercase, .jpeg -> .jpg. */
export function normaliseExt(name) {
	const ext = path.extname(name).toLowerCase();
	return ext === ".jpeg" ? ".jpg" : ext;
}

/** "clip.MOV" -> "clip.jpg" (poster/thumbnail filename for a video source). */
export const videoNameToPoster = (name) => name.replace(/\.(mp4|mov|m4v)$/i, ".jpg");

/** "snap.PNG" -> "snap.jpg" (thumbnail filename for a photo source). */
export const photoNameToThumb = (name) => name.replace(/\.(jpe?g|png|webp)$/i, ".jpg");

/** The key an entry is matched on: the basename of its poster/thumb, lowercased. */
export const posterKey = (entry) => path.basename(entry?.poster ?? entry?.thumb ?? "").toLowerCase();

/** Same idea for photos: the basename of `full`, lowercased. */
export const pictureKey = (entry) => path.basename(entry?.full ?? "").toLowerCase();

/** The bare filename stem (no extension) of a video entry's poster, e.g. "000000000047". */
export const stemOfVideo = (entry) => path.parse(path.basename(entry?.poster ?? "")).name;

// R2 keys are named after the entry's own poster stem, not content — every entry owns an
// exclusively-named object, so two entries can never collide by having identical content.
export const videoKeyFor = (stem) => `videos/${stem}.mp4`;
export const previewKeyFor = (stem) => `previews/${stem}.mp4`;

/**
 * The sha1 of a video entry's local source file, as of when it was last processed.
 * Used for change-detection (has the source been re-edited since?) and dedup — it has
 * nothing to do with the entry's R2 key any more, see videoKeyFor/previewKeyFor above.
 */
export function hashFromEntry(entry) {
	return typeof entry?.hash === "string" && entry.hash ? entry.hash : null;
}

/**
 * Reads public/gallery.json. Returns null (not []) when it can't be read or parsed,
 * so callers can tell "no manifest" from "empty manifest" — the difference between
 * skipping a destructive prune and doing one.
 */
export async function loadManifest() {
	try {
		const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Writes the manifest photos-first, videos-second, preserving order within each group. */
export async function saveManifest(entries) {
	const photos = entries.filter((e) => e.type === "photo" || !e.type);
	const videos = entries.filter((e) => e.type === "video");
	await writeFile(manifestPath, JSON.stringify([...photos, ...videos], null, 2));
}

export async function loadCache() {
	try {
		return JSON.parse(await readFile(cachePath, "utf8"));
	} catch {
		return {};
	}
}

export async function saveCache(cache) {
	await writeFile(cachePath, JSON.stringify(cache, null, 2));
}

const wranglerEntry = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

export async function uploadToR2(localPath, key, contentType) {
	await execFileAsync(process.execPath, [
		wranglerEntry,
		"r2",
		"object",
		"put",
		`${R2_BUCKET}/${key}`,
		"--file",
		localPath,
		"--content-type",
		contentType,
		"--cache-control",
		"public, max-age=31536000, immutable",
		"--remote",
	]);
}

export async function downloadFromR2(key, destPath) {
	await execFileAsync(process.execPath, [wranglerEntry, "r2", "object", "get", `${R2_BUCKET}/${key}`, "--file", destPath, "--remote"], {
		maxBuffer: 1024 * 1024 * 16,
	});
}

export async function deleteFromR2(key) {
	await execFileAsync(process.execPath, [wranglerEntry, "r2", "object", "delete", `${R2_BUCKET}/${key}`, "--remote"]);
}

/** The equivalent hand-run command, for README parity and for printing on failure. */
export const r2DeleteCommand = (key) => `npx wrangler r2 object delete ${R2_BUCKET}/${key} --remote`;

/** Sha1 of a file's bytes — used for change-detection and dedup, never for an R2 key. */
export async function sha1File(filePath) {
	const hash = createHash("sha1");
	await new Promise((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", resolve);
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

// ffmpeg copies container metadata into its output by default, which on phone footage
// means the GPS coordinates a video was shot at travel all the way to the public bucket.
// -1 means "map metadata from nowhere". Chapters go too; nothing here uses them.
export const STRIP_METADATA = ["-map_metadata", "-1", "-map_chapters", "-1"];
