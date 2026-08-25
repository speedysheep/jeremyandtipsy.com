// Deletes a single photo or video from the gallery, everywhere it exists. The ONLY
// supported way to remove published media from this repo — see scripts/lib/delete-media.mjs
// for why that's a hard rule, not just a convention.
//
//   npm run deletePicture <name>        e.g. npm run deletePicture jeremy-in-a-hat.jpg
//   npm run deleteVideo   <name>        e.g. npm run deleteVideo   tipsywiggles.mp4
//
// Bare like that, it ONLY reports what it would do — nothing is deleted. Add a literal
// `yes` as the next argument to actually delete:
//
//   npm run deletePicture jeremy-in-a-hat.jpg yes
//   npm run deleteVideo tipsywiggles.mp4 yes
//
// This is a plain word, not a --yes flag, on purpose: npm only forwards trailing
// argv that look like flags when the command uses `--`, so a --yes here would be
// silently swallowed by npm itself and never reach this script — forgetting it would
// fail safe (nothing happens) rather than unsafe, either way, but a plain word means
// the short command actually works as typed.
//
// The name can be with or without its extension. For pictures, a unique stem match is
// enough ("jeremy" finds "jeremy.jpg"); ambiguous stems (jeremy.jpg *and* jeremy.png)
// are refused. For videos it can be the source filename, the poster name, or the bare
// stem. Requires `npx wrangler login` for video deletes (R2 access).
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { deletePictureEntry, deleteVideoEntry } from "./lib/delete-media.mjs";
import { isPhoto, loadManifest, photoNameToThumb, picturesDir, r2DeleteCommand } from "./lib/media.mjs";

const exists = async (p) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

const stemOf = (name) => path.basename(name).replace(/\.[^.]+$/, "").toLowerCase();

/** Same resolution rules scripts/remove-picture.mjs used to have: exact name, else a
 * unique stem match, refusing an ambiguous one. */
async function resolvePicture(arg) {
	const entries = await readdir(picturesDir, { withFileTypes: true });
	const names = entries.filter((e) => e.isFile() && isPhoto(e.name)).map((e) => e.name);

	const wanted = path.basename(arg.replace(/\\/g, "/"));
	const exact = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
	if (exact) return { name: exact, candidates: names };

	const stem = stemOf(wanted);
	const byStem = names.filter((n) => stemOf(n) === stem);
	if (byStem.length === 1) return { name: byStem[0], candidates: names };
	if (byStem.length > 1) {
		console.error(`"${arg}" is ambiguous — public/pictures/ has ${byStem.join(", ")}.`);
		console.error("Pass the full filename including its extension.");
		process.exit(1);
	}
	return { name: null, candidates: names };
}

/** Accepts "clip.mp4", "clip.MOV", "clip.jpg", "public/videos/clip.mp4" or "clip". */
function toPosterName(arg) {
	const base = path.basename(arg.replace(/\\/g, "/"));
	if (/\.(mp4|mov|m4v)$/i.test(base)) return base.replace(/\.(mp4|mov|m4v)$/i, ".jpg");
	if (/\.jpe?g$/i.test(base)) return base.replace(/\.jpe?g$/i, ".jpg");
	return `${base}.jpg`;
}

function printFileResults(files) {
	for (const f of files) {
		if (!f.existed) {
			console.log(`  ${f.path} isn't there, skipping`);
		} else if (f.deleted) {
			console.log(`  deleted ${f.path}`);
		} else {
			console.log(`  would delete ${f.path}`);
		}
	}
}

async function runPicture(name, { dryRun, real }) {
	const { name: resolved, candidates } = await resolvePicture(name);
	if (!resolved) {
		console.error(`No photo in public/pictures/ matches "${name}".`);
		const stem = stemOf(name);
		const near = candidates.filter((n) => stem.length >= 3 && n.toLowerCase().includes(stem));
		if (near.length) {
			console.error("\nDid you mean:");
			for (const n of near.slice(0, 10)) console.error(`  ${n}`);
		} else {
			console.error(`\npublic/pictures/ has ${candidates.length} photos.`);
		}
		process.exit(1);
	}

	// Cross-type guard: this filename's thumb might actually be a video's poster.
	const thumbName = photoNameToThumb(resolved);
	const manifest = (await loadManifest()) ?? [];
	const clashingVideo = manifest.find((e) => e.type === "video" && path.basename(e.poster ?? "").toLowerCase() === thumbName.toLowerCase());
	if (clashingVideo) {
		console.error(`\nthumbs/${thumbName} is the poster for a video, not this photo's thumbnail.`);
		console.error("Rename the photo, or remove the video first with `npm run deleteVideo <name>`.");
		process.exit(1);
	}

	console.log(`${real ? "" : "[dry run] "}Removing ${resolved}`);
	const result = await deletePictureEntry(resolved, { dryRun });
	printFileResults(result.files);
	if (real) {
		console.log("  removed the entry from public/gallery.json");
		console.log("\nDone. Commit public/gallery.json and the deleted pictures/ and thumbs/ files.");
	} else {
		console.log("  would remove the entry from public/gallery.json");
	}
}

async function runVideo(name, { dryRun, real }) {
	const manifest = (await loadManifest()) ?? [];
	const wanted = toPosterName(name).toLowerCase();
	const videoEntries = manifest.filter((e) => e.type === "video");
	const entry = videoEntries.find((e) => path.basename(e.poster ?? "").toLowerCase() === wanted);

	if (!entry) {
		console.error(`No video in gallery.json matches "${name}".`);
		const stem = stemOf(name);
		const near = videoEntries.filter((e) => stem.length >= 3 && path.basename(e.poster ?? "").toLowerCase().includes(stem));
		if (near.length) {
			console.error("\nDid you mean:");
			for (const e of near.slice(0, 10)) console.error(`  ${path.basename(e.poster).replace(/\.jpg$/i, "")}`);
		} else {
			console.error(`\ngallery.json has ${videoEntries.length} video entries; check the poster name in it.`);
		}
		process.exit(1);
	}

	// Cross-type guard, the other direction: this poster name might actually be a photo.
	const clashingPhoto = manifest.find((e) => (e.type === "photo" || !e.type) && path.basename(e.thumb ?? "").toLowerCase() === wanted);
	if (clashingPhoto) {
		console.error(`\nthumbs/${wanted} is a photo's thumbnail, not a video poster.`);
		console.error("Remove the photo instead with `npm run deletePicture <name>`.");
		process.exit(1);
	}

	const posterName = path.basename(entry.poster);
	console.log(`${real ? "" : "[dry run] "}Removing ${posterName.replace(/\.jpg$/, "")}`);

	const result = await deleteVideoEntry(posterName, { dryRun });
	for (const { key, deleted, error } of result.r2Keys) {
		if (error) {
			console.warn(`  ! couldn't delete R2 object ${key}: ${error}`);
			console.warn(`    run by hand: ${r2DeleteCommand(key)}`);
		} else {
			console.log(`  ${deleted ? "deleted" : "would delete"} R2 object ${key}`);
		}
	}
	printFileResults(result.files);
	if (real) {
		console.log("  removed the entry from public/gallery.json");
		if (result.cacheKeysCleared.length) console.log("  cleared its .media-cache.json entry");
		console.log("\nDone. Commit public/gallery.json and the deleted thumbs/ poster.");
	} else {
		console.log("  would remove the entry from public/gallery.json");
		if (result.cacheKeysCleared.length) console.log("  would clear its .media-cache.json entry");
	}
}

async function main() {
	// argv[2] ("picture"/"video") is hardcoded by the npm script that invokes this
	// (deletePicture / deleteVideo) — a direct `node scripts/delete-media.mjs ...`
	// call needs to supply it itself.
	const [kind, name, confirm] = process.argv.slice(2);

	if (!kind || !["picture", "video"].includes(kind) || !name) {
		console.error("Usage: npm run deletePicture <name> [yes]");
		console.error("       npm run deleteVideo <name> [yes]");
		console.error("   e.g. npm run deletePicture jeremy-in-a-hat.jpg");
		console.error("        npm run deleteVideo tipsywiggles.mp4");
		process.exit(1);
	}

	// Fail safe by default: no trailing "yes" means dry-run, full stop.
	const real = confirm === "yes";
	const dryRun = !real;
	if (!real) console.log('No "yes" given — showing what would happen; nothing will be deleted.\n');

	if (kind === "picture") await runPicture(name, { dryRun, real });
	else await runVideo(name, { dryRun, real });

	if (dryRun) {
		const cmd = kind === "picture" ? "deletePicture" : "deleteVideo";
		console.log(`\nRe-run as \`npm run ${cmd} ${name} yes\` to actually delete.`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
