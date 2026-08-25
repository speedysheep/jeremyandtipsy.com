// The ONLY code in this repo permitted to delete a published photo, video, thumbnail,
// poster, or R2 object, or to remove an entry from public/gallery.json. Every other
// script only ever ADDS or refreshes entries (scripts/ingest-media.mjs,
// scripts/generate-thumbnails.mjs, scripts/process-videos.mjs) — a file or entry going
// missing must always trace back to a call into this module, never to a side effect of
// running the ordinary pipeline.
//
// Used by scripts/delete-media.mjs (the `npm run deletePicture`/`deleteVideo` CLIs) and by
// scripts/retrofit-sequence.mjs (dedup cleanup + superseded-object cleanup during the
// sequence-name migration). Nothing else should import from here.
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import {
	R2_PUBLIC_BASE_URL,
	VIDEO_EXTENSIONS,
	deleteFromR2,
	loadCache,
	loadManifest,
	photoNameToThumb,
	pictureKey,
	picturesDir,
	posterKey,
	repoRoot,
	saveCache,
	saveManifest,
	thumbsDir,
	videoNameToPoster,
	videosDir,
} from "./media.mjs";

const exists = async (p) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

const relLabel = (p) => path.relative(repoRoot, p).replace(/\\/g, "/");

/**
 * Deletes one photo: public/pictures/<pictureName>, its thumbnail, and its gallery.json
 * entry. `pictureName` must already be resolved to an exact filename (case-insensitive)
 * — ambiguous-name resolution is the caller's job (scripts/delete-media.mjs).
 *
 * Loads and saves the manifest itself, so calling this repeatedly in a loop (as the
 * retrofit's dedup pass does) always leaves gallery.json consistent between calls.
 */
export async function deletePictureEntry(pictureName, { dryRun = false } = {}) {
	const manifest = await loadManifest();
	if (!manifest) throw new Error("Couldn't read public/gallery.json — refusing to delete anything.");

	const wanted = pictureName.toLowerCase();
	const entry = manifest.find((e) => (e.type === "photo" || !e.type) && pictureKey(e) === wanted);
	if (!entry) return { found: false };

	const thumbName = photoNameToThumb(pictureName);
	const files = [];
	for (const target of [path.join(picturesDir, pictureName), path.join(thumbsDir, thumbName)]) {
		const existed = await exists(target);
		files.push({ path: target, existed, deleted: false });
	}

	let manifestChanged = false;
	if (!dryRun) {
		for (const f of files) {
			if (!f.existed) continue;
			await rm(f.path, { force: true });
			f.deleted = true;
		}
		await saveManifest(manifest.filter((e) => e !== entry));
		manifestChanged = true;
	}

	return { found: true, entry, files: files.map((f) => ({ ...f, path: relLabel(f.path) })), manifestChanged };
}

/**
 * Deletes one video: its full+preview R2 objects (the keys are read straight out of the
 * entry's OWN `full`/`preview` URLs, not reconstructed from its poster name — an entry
 * that hasn't been through `npm run renumber` yet may still be sitting at an old,
 * content-hash-derived key, and guessing the new-scheme key would silently delete
 * nothing while orphaning the real object. Pass deleteR2:false when a surviving sibling
 * entry still points at the same, pre-retrofit, shared object), its local source in
 * public/videos/ if present, its poster, its .media-cache.json bookkeeping, and its
 * gallery.json entry. `posterName` must already be an exact "<stem>.jpg" filename
 * (case-insensitive).
 */
export async function deleteVideoEntry(posterName, { dryRun = false, deleteR2 = true } = {}) {
	const manifest = await loadManifest();
	if (!manifest) throw new Error("Couldn't read public/gallery.json — refusing to delete anything.");

	const wanted = posterName.toLowerCase();
	const entry = manifest.find((e) => e.type === "video" && posterKey(e) === wanted);
	if (!entry) return { found: false };

	const r2Keys = [];
	if (deleteR2) {
		const keys = [entry.full, entry.preview].map((url) => url.replace(`${R2_PUBLIC_BASE_URL}/`, ""));
		for (const key of keys) {
			if (dryRun) {
				r2Keys.push({ key, deleted: false });
				continue;
			}
			try {
				await deleteFromR2(key);
				r2Keys.push({ key, deleted: true });
			} catch (err) {
				r2Keys.push({ key, deleted: false, error: err.stderr?.trim() || err.message });
			}
		}
	}

	const targets = [path.join(thumbsDir, path.basename(entry.poster))];
	const stem = path.basename(entry.poster).replace(/\.jpg$/i, "");
	for (const ext of VIDEO_EXTENSIONS) {
		const candidate = path.join(videosDir, stem + ext);
		if (await exists(candidate)) targets.push(candidate);
	}
	const files = [];
	for (const target of targets) {
		const existed = await exists(target);
		files.push({ path: target, existed, deleted: false });
	}

	const cache = await loadCache();
	const cacheKeysCleared = Object.keys(cache).filter((k) => videoNameToPoster(k).toLowerCase() === wanted);

	let manifestChanged = false;
	if (!dryRun) {
		for (const f of files) {
			if (!f.existed) continue;
			await rm(f.path, { force: true });
			f.deleted = true;
		}
		await saveManifest(manifest.filter((e) => e !== entry));
		manifestChanged = true;

		if (cacheKeysCleared.length) {
			for (const k of cacheKeysCleared) delete cache[k];
			await saveCache(cache);
		}
	}

	return { found: true, entry, r2Keys, files: files.map((f) => ({ ...f, path: relLabel(f.path) })), cacheKeysCleared, manifestChanged };
}

/**
 * Deletes the full+preview R2 objects at explicit keys — nothing else. Used only by
 * scripts/retrofit-sequence.mjs, right after it has durably re-pointed a gallery.json
 * entry at its new sequence-named key, to clean up the now-unreferenced old
 * (pre-retrofit, hash-derived) objects. The only other deleteFromR2 caller in the repo.
 */
export async function deleteStaleVideoR2Objects(fullKey, previewKey, { dryRun = false } = {}) {
	const results = [];
	for (const key of [fullKey, previewKey]) {
		if (dryRun) {
			results.push({ key, deleted: false });
			continue;
		}
		try {
			await deleteFromR2(key);
			results.push({ key, deleted: true });
		} catch (err) {
			results.push({ key, deleted: false, error: err.stderr?.trim() || err.message });
		}
	}
	return results;
}
