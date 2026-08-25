// Strips metadata from a JPEG while keeping the two tags that aren't personal data:
// DateTimeOriginal ("date taken") and Orientation.
//
// This works on the JPEG's marker segments rather than re-encoding through sharp, so the
// compressed image data is copied through byte-for-byte — no generation loss. Dropping
// EXIF entirely would also mean losing the Orientation tag, which would leave photos shot
// in portrait displaying sideways; keeping it avoids having to bake the rotation in
// (which would require a re-encode).
//
// Removed: EXIF (GPS, Make/Model, serial numbers, MakerNote, the embedded thumbnail),
// XMP, Photoshop/IPTC and comment segments. Kept: JFIF (APP0) and any ICC colour
// profile (APP2), neither of which identifies anything.

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP15 = 0xef;
const COM = 0xfe;

const TAG_ORIENTATION = 0x0112;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_ASCII = 2;

/** Reads Orientation and a best-available "date taken" out of a raw EXIF/APP1 payload. */
export function readExifBasics(exifBuffer) {
	const result = { orientation: null, dateTimeOriginal: null };
	if (!exifBuffer || exifBuffer.length < 8) return result;

	// sharp hands back the APP1 payload, usually still carrying its "Exif\0\0" header.
	let tiff = exifBuffer;
	if (tiff.slice(0, 4).toString("latin1") === "Exif") tiff = tiff.slice(6);
	if (tiff.length < 8) return result;

	const bo = tiff.slice(0, 2).toString("latin1");
	if (bo !== "II" && bo !== "MM") return result;
	const le = bo === "II";
	const u16 = (o) => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0);
	const u32 = (o) => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0);

	const ascii = (entryOffset, count) => {
		const start = count <= 4 ? entryOffset + 8 : u32(entryOffset + 8);
		if (start + count > tiff.length) return null;
		return tiff.slice(start, start + count).toString("latin1").replace(/\0.*$/, "").trim() || null;
	};

	const dates = {};
	const walk = (ifdOffset, depth) => {
		if (depth > 2 || ifdOffset <= 0 || ifdOffset + 2 > tiff.length) return;
		const count = u16(ifdOffset);
		for (let i = 0; i < count; i++) {
			const e = ifdOffset + 2 + i * 12;
			if (e + 12 > tiff.length) return;
			const tag = u16(e);
			const type = u16(e + 2);
			const n = u32(e + 4);
			if (tag === TAG_ORIENTATION && type === TYPE_SHORT && result.orientation === null) {
				const v = u16(e + 8);
				if (v >= 1 && v <= 8) result.orientation = v;
			} else if (tag === TAG_EXIF_POINTER) {
				walk(u32(e + 8), depth + 1);
			} else if ((tag === TAG_DATETIME_ORIGINAL || tag === TAG_DATETIME_DIGITIZED || tag === TAG_DATETIME) && type === TYPE_ASCII) {
				dates[tag] = ascii(e, n);
			}
		}
	};
	walk(u32(4), 0);

	// Prefer when the shutter fired, then when it was digitised, then the file's own stamp.
	result.dateTimeOriginal = dates[TAG_DATETIME_ORIGINAL] ?? dates[TAG_DATETIME_DIGITIZED] ?? dates[TAG_DATETIME] ?? null;
	return result;
}

/**
 * Builds a minimal little-endian EXIF APP1 payload holding at most Orientation (IFD0)
 * and DateTimeOriginal (ExifIFD). Returns null when there's nothing worth keeping.
 */
export function buildMinimalExif({ orientation, dateTimeOriginal }) {
	if (!orientation && !dateTimeOriginal) return null;

	// EXIF dates are exactly 19 chars plus a NUL: "YYYY:MM:DD HH:MM:SS".
	const dateBytes = dateTimeOriginal ? Buffer.from(dateTimeOriginal.slice(0, 19).padEnd(19, " ") + "\0", "latin1") : null;

	const ifd0Count = (orientation ? 1 : 0) + (dateBytes ? 1 : 0); // orientation + ExifIFD pointer
	const ifd0Start = 8;
	const ifd0Size = 2 + ifd0Count * 12 + 4;
	const exifIfdStart = ifd0Start + ifd0Size;
	const exifIfdSize = dateBytes ? 2 + 12 + 4 : 0;
	const dateStart = exifIfdStart + exifIfdSize;
	const total = dateStart + (dateBytes ? dateBytes.length : 0);

	const tiff = Buffer.alloc(total);
	tiff.write("II", 0, "latin1");
	tiff.writeUInt16LE(42, 2);
	tiff.writeUInt32LE(ifd0Start, 4);

	let p = ifd0Start;
	tiff.writeUInt16LE(ifd0Count, p);
	p += 2;
	// Entries must be written in ascending tag order.
	if (orientation) {
		tiff.writeUInt16LE(TAG_ORIENTATION, p);
		tiff.writeUInt16LE(TYPE_SHORT, p + 2);
		tiff.writeUInt32LE(1, p + 4);
		tiff.writeUInt16LE(orientation, p + 8); // inline, 2 bytes + 2 padding
		p += 12;
	}
	if (dateBytes) {
		tiff.writeUInt16LE(TAG_EXIF_POINTER, p);
		tiff.writeUInt16LE(TYPE_LONG, p + 2);
		tiff.writeUInt32LE(1, p + 4);
		tiff.writeUInt32LE(exifIfdStart, p + 8);
		p += 12;
	}
	tiff.writeUInt32LE(0, p); // no IFD1
	p += 4;

	if (dateBytes) {
		tiff.writeUInt16LE(1, exifIfdStart);
		const e = exifIfdStart + 2;
		tiff.writeUInt16LE(TAG_DATETIME_ORIGINAL, e);
		tiff.writeUInt16LE(TYPE_ASCII, e + 2);
		tiff.writeUInt32LE(dateBytes.length, e + 4);
		tiff.writeUInt32LE(dateStart, e + 8);
		tiff.writeUInt32LE(0, e + 12); // no next IFD
		dateBytes.copy(tiff, dateStart);
	}

	return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
}

/**
 * Rewrites a JPEG with its metadata segments removed, re-inserting a minimal EXIF block
 * carrying only Orientation and DateTimeOriginal. The entropy-coded image data is copied
 * verbatim, so this is lossless.
 *
 * Returns { buffer, kept, dropped } — or null if the input isn't a JPEG we recognise, in
 * which case the caller should leave the file alone.
 */
export function stripJpegMetadata(input) {
	if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) return null;

	const keptSegments = [];
	const dropped = [];
	let exifPayload = null;
	let offset = 2;

	while (offset < input.length) {
		if (input[offset] !== 0xff) return null; // not at a marker boundary; bail rather than corrupt
		let marker = input[offset + 1];
		// Skip fill bytes (a run of 0xFF is legal padding before a marker).
		let markerOffset = offset;
		while (marker === 0xff && markerOffset + 2 < input.length) {
			markerOffset++;
			marker = input[markerOffset + 1];
		}
		if (marker === EOI) break;
		if (marker === SOS) {
			// Everything from here to the end is entropy-coded data; copy it untouched.
			keptSegments.push({ marker: SOS, raw: input.slice(markerOffset) });
			break;
		}
		const length = input.readUInt16BE(markerOffset + 2);
		const segEnd = markerOffset + 2 + length;
		if (length < 2 || segEnd > input.length) return null;

		const isApp = marker >= APP0 && marker <= APP15;
		const isMetadata = (isApp && marker !== APP0 && marker !== APP2) || marker === COM;

		if (isMetadata) {
			const payload = input.slice(markerOffset + 4, segEnd);
			if (marker === APP1 && payload.slice(0, 4).toString("latin1") === "Exif") exifPayload = payload;
			dropped.push(marker === COM ? "COM" : `APP${marker - APP0}`);
		} else {
			keptSegments.push({ marker, raw: input.slice(markerOffset, segEnd) });
		}
		offset = segEnd;
	}

	if (!keptSegments.some((s) => s.marker === SOS)) return null; // no image data found

	const basics = readExifBasics(exifPayload);
	const minimal = buildMinimalExif(basics);

	const parts = [Buffer.from([0xff, SOI])];
	// APP0/JFIF conventionally comes first, then our EXIF, then everything else.
	for (const s of keptSegments.filter((s) => s.marker === APP0)) parts.push(s.raw);
	if (minimal) {
		const header = Buffer.alloc(4);
		header[0] = 0xff;
		header[1] = APP1;
		header.writeUInt16BE(minimal.length + 2, 2);
		parts.push(header, minimal);
	}
	for (const s of keptSegments.filter((s) => s.marker !== APP0)) parts.push(s.raw);

	return { buffer: Buffer.concat(parts), kept: basics, dropped };
}
