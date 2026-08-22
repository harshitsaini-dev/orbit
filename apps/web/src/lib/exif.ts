/**
 * Reading a photo's own record of how it was taken.
 *
 * Written here rather than pulled in, for the same reason the ZIP reader was:
 * the format is small and fully specified, and the useful part of it is a
 * handful of tags. What a library would add is every tag ever registered, most
 * of which nothing would ever show.
 *
 * The important property is that this needs the *beginning* of a file, not the
 * file. EXIF sits in the first marker segment of a JPEG, so a range request for
 * the first few tens of kilobytes is enough however large the photo is - which
 * is what makes it free to show for a 40 MB raw shot from a phone.
 *
 * Nothing here trusts the file. Every offset is checked against the buffer, and
 * a malformed or hostile header returns what could be read rather than throwing
 * into the viewer.
 */

export interface GpsPosition {
  latitude: number;
  longitude: number;
  /** Metres above sea level, where the camera recorded it. */
  altitude?: number;
}

export interface ExifData {
  make?: string;
  model?: string;
  lens?: string;
  /** As written by the camera, in its own local time - there is no zone in it. */
  takenAt?: string;
  exposureTime?: string;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  orientation?: number;
  widthPx?: number;
  heightPx?: number;
  software?: string;
  /**
   * Where the photo was taken, when the camera recorded it.
   *
   * Kept separate from everything else in this record because it is the one
   * field that is not about the photograph: it is somebody's location, often
   * their home, and every surface that shows it has to decide deliberately.
   */
  gps?: GpsPosition;
}

/** How much of a file has to be read for this to work, in practice. */
export const EXIF_HEAD_BYTES = 256 * 1024;

const TAGS = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  software: 0x0131,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  isoSpeed: 0x8833,
  dateTimeOriginal: 0x9003,
  focalLength: 0x920a,
  pixelX: 0xa002,
  pixelY: 0xa003,
  lensModel: 0xa434,
} as const;

const GPS = {
  latRef: 0x0001,
  lat: 0x0002,
  lonRef: 0x0003,
  lon: 0x0004,
  altRef: 0x0005,
  alt: 0x0006,
} as const;

type Value = string | number | number[] | undefined;

/** Bytes per component, indexed by the TIFF type code. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

/**
 * Finds the TIFF header the tags are written against.
 *
 * JPEG keeps it in an APP1 segment, PNG in an `eXIf` chunk, and a TIFF or a raw
 * file simply starts with it. All three end at the same place, so everything
 * after this is one reader.
 */
function findTiffStart(view: DataView): number | null {
  const length = view.byteLength;
  if (length < 8) return null;

  // A bare TIFF: the byte order mark is the first thing in the file.
  const first = view.getUint16(0);
  if (first === 0x4949 || first === 0x4d4d) return 0;

  if (first === 0xffd8) {
    // JPEG. Walk the marker segments; EXIF is in APP1, which is normally first
    // but is not required to be.
    let offset = 2;

    while (offset + 4 <= length) {
      if (view.getUint8(offset) !== 0xff) return null;

      const marker = view.getUint8(offset + 1);
      // Start of scan: the image data begins and there are no more segments.
      if (marker === 0xda) return null;

      const size = view.getUint16(offset + 2);
      if (size < 2) return null;

      if (marker === 0xe1 && offset + 10 <= length) {
        const tag = String.fromCharCode(
          view.getUint8(offset + 4),
          view.getUint8(offset + 5),
          view.getUint8(offset + 6),
          view.getUint8(offset + 7),
        );
        // "Exif\0\0" - and an APP1 that is XMP rather than EXIF is skipped.
        if (tag === 'Exif') return offset + 10;
      }

      offset += 2 + size;
    }

    return null;
  }

  // PNG: signature, then chunks of length/type/data/crc.
  if (first === 0x8950) {
    let offset = 8;

    while (offset + 8 <= length) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7),
      );

      if (type === 'eXIf') return offset + 8;
      // IDAT means the pixels have started; anything after is not metadata
      // worth walking a large file for.
      if (type === 'IDAT' || type === 'IEND') return null;

      offset += 12 + size;
    }
  }

  return null;
}

interface Reader {
  view: DataView;
  tiff: number;
  little: boolean;
}

function readValue(reader: Reader, entry: number): Value {
  const { view, tiff, little } = reader;

  const type = view.getUint16(entry + 2, little);
  const count = view.getUint32(entry + 4, little);
  const size = TYPE_SIZE[type];
  if (!size || count === 0) return undefined;

  const total = size * count;
  // Four bytes or fewer are written in the entry itself; anything larger is an
  // offset from the start of the TIFF header.
  const start = total <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
  if (start < 0 || start + total > view.byteLength) return undefined;

  if (type === 2) {
    let text = '';
    for (let i = 0; i < count; i += 1) {
      const code = view.getUint8(start + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text.trim();
  }

  const numbers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = start + i * size;

    if (type === 1 || type === 7) numbers.push(view.getUint8(at));
    else if (type === 3) numbers.push(view.getUint16(at, little));
    else if (type === 4) numbers.push(view.getUint32(at, little));
    else if (type === 6) numbers.push(view.getInt8(at));
    else if (type === 8) numbers.push(view.getInt16(at, little));
    else if (type === 9) numbers.push(view.getInt32(at, little));
    else if (type === 5 || type === 10) {
      const numerator = type === 5 ? view.getUint32(at, little) : view.getInt32(at, little);
      const denominator = type === 5 ? view.getUint32(at + 4, little) : view.getInt32(at + 4, little);
      // A zero denominator is a camera writing "unknown"; NaN would reach the
      // page as a value.
      numbers.push(denominator === 0 ? 0 : numerator / denominator);
    }
  }

  return numbers.length === 1 ? numbers[0] : numbers;
}

/** Every tag in one directory, as a map. Returns null if the offset is unusable. */
function readIfd(reader: Reader, offset: number): Map<number, Value> | null {
  const { view, little } = reader;
  if (offset < 0 || offset + 2 > view.byteLength) return null;

  const count = view.getUint16(offset, little);
  // A directory claiming thousands of entries is a corrupt offset, not a photo.
  if (count > 512 || offset + 2 + count * 12 > view.byteLength) return null;

  const entries = new Map<number, Value>();
  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12;
    entries.set(view.getUint16(entry, little), readValue(reader, entry));
  }

  return entries;
}

function asNumber(value: Value): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return undefined;
}

function asText(value: Value): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Degrees, minutes and seconds as the file stores them, into one number. */
function toDegrees(value: Value, ref: Value): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;

  const [degrees = 0, minutes = 0, seconds = 0] = value;
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(magnitude)) return undefined;

  const south = typeof ref === 'string' && /^[SW]/i.test(ref);
  return south ? -magnitude : magnitude;
}

/** "2026:08:22 14:03:11" is EXIF's own shape, and no other reader's. */
function toIsoish(value: Value): string | undefined {
  const text = asText(value);
  if (!text) return undefined;

  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}` : text;
}

/** A shutter speed reads as 1/250, not as 0.004. */
export function formatExposure(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

/**
 * What a file says about itself, from as much of it as was read.
 *
 * Returns null when there is nothing to say - no EXIF, an unreadable header, or
 * a format that does not carry it. Never throws: a corrupt photo is a photo
 * with no details, not a broken page.
 */
export function readExif(bytes: ArrayBuffer): ExifData | null {
  try {
    const view = new DataView(bytes);
    const tiff = findTiffStart(view);
    if (tiff === null || tiff + 8 > view.byteLength) return null;

    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const little = order === 0x4949;

    // 42, in whichever order the file just declared. Anything else means the
    // offset found above was not really a TIFF header.
    if (view.getUint16(tiff + 2, little) !== 42) return null;

    const reader: Reader = { view, tiff, little };
    const zeroth = readIfd(reader, tiff + view.getUint32(tiff + 4, little));
    if (!zeroth) return null;

    const exif = readIfd(reader, tiff + (asNumber(zeroth.get(TAGS.exifIfd)) ?? -tiff - 1));
    const gps = readIfd(reader, tiff + (asNumber(zeroth.get(TAGS.gpsIfd)) ?? -tiff - 1));

    const get = (tag: number): Value => exif?.get(tag) ?? zeroth.get(tag);

    const data: ExifData = {};

    const make = asText(zeroth.get(TAGS.make));
    const model = asText(zeroth.get(TAGS.model));
    if (make) data.make = make;
    // "Canon Canon EOS R6" is what naive concatenation gives; the model often
    // repeats the manufacturer already.
    if (model) data.model = make && model.startsWith(make) ? model.slice(make.length).trim() : model;

    const lens = asText(get(TAGS.lensModel));
    if (lens) data.lens = lens;

    const software = asText(zeroth.get(TAGS.software));
    if (software) data.software = software;

    const takenAt = toIsoish(get(TAGS.dateTimeOriginal));
    if (takenAt) data.takenAt = takenAt;

    const exposure = asNumber(get(TAGS.exposureTime));
    if (exposure !== undefined && exposure > 0) data.exposureTime = formatExposure(exposure);

    const fNumber = asNumber(get(TAGS.fNumber));
    if (fNumber) data.fNumber = Number(fNumber.toFixed(1));

    const iso = asNumber(get(TAGS.iso)) ?? asNumber(get(TAGS.isoSpeed));
    if (iso) data.iso = Math.round(iso);

    const focal = asNumber(get(TAGS.focalLength));
    if (focal) data.focalLength = Math.round(focal);

    const orientation = asNumber(zeroth.get(TAGS.orientation));
    if (orientation) data.orientation = orientation;

    const width = asNumber(get(TAGS.pixelX));
    const height = asNumber(get(TAGS.pixelY));
    if (width) data.widthPx = width;
    if (height) data.heightPx = height;

    if (gps) {
      const latitude = toDegrees(gps.get(GPS.lat), gps.get(GPS.latRef));
      const longitude = toDegrees(gps.get(GPS.lon), gps.get(GPS.lonRef));

      if (latitude !== undefined && longitude !== undefined) {
        const position: GpsPosition = { latitude, longitude };

        const altitude = asNumber(gps.get(GPS.alt));
        // Reference 1 means below sea level, which is how a camera records a
        // negative altitude - the value itself is always positive.
        if (altitude !== undefined) {
          position.altitude = Math.round(asNumber(gps.get(GPS.altRef)) === 1 ? -altitude : altitude);
        }

        position.latitude = Number(latitude.toFixed(6));
        position.longitude = Number(longitude.toFixed(6));
        data.gps = position;
      }
    }

    return Object.keys(data).length > 0 ? data : null;
  } catch {
    // A hostile or truncated header is a file with no details.
    return null;
  }
}
