import exifr from 'exifr';

export interface ExifSummary {
    maker?: string;
    model?: string;
    lensModel?: string;
    takenAt?: string;
    exposureTime?: number;
    fNumber?: number;
    iso?: number;
    focalLength?: number;
    focalLengthIn35mm?: number;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    raw: Record<string, unknown> | null;
}

const PICK_FIELDS = [
    'Maker',
    'Model',
    'LensModel',
    'DateTimeOriginal',
    'ExposureTime',
    'FNumber',
    'ISO',
    'FocalLength',
    'FocalLengthIn35mmFormat',
    'GPSLatitude',
    'GPSLongitude',
    'GPSAltitude'
] as const;

type PickField = (typeof PICK_FIELDS)[number];

const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const parsed = Number(trimmed);
        if (!Number.isNaN(parsed)) return parsed;
    }
    if (Array.isArray(value)) {
        const [numerator, denominator] = value as unknown[];
        if (typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0) {
            return numerator / denominator;
        }
    }
    return undefined;
};

const toCoordinate = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value;
    if (Array.isArray(value)) {
        const parts = value.filter(part => typeof part === 'number') as number[];
        if (parts.length === 3) {
            const [degrees, minutes, seconds] = parts;
            return degrees + minutes / 60 + seconds / 3600;
        }
    }
    return undefined;
};

const toIsoDate = (value: unknown): string | undefined => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const normalized = trimmed.replace(
            /^([0-9]{4}):([0-9]{2}):([0-9]{2})([ T])/, '$1-$2-$3$4'
        );
        const candidate = normalized.replace(' ', 'T');
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        const parsedUtc = new Date(`${candidate}Z`);
        if (!Number.isNaN(parsedUtc.getTime())) {
            return parsedUtc.toISOString();
        }
    }
    return undefined;
};

export async function extractExifData(buffer: ArrayBuffer): Promise<ExifSummary | null> {
    try {
        const parsed = await exifr.parse(buffer, { pick: PICK_FIELDS });
        if (!parsed) {
            return null;
        }

        const get = (key: PickField): unknown => {
            return (parsed as Record<string, unknown>)[key];
        };

        const maker = get('Maker');
        const model = get('Model');
        const lensModel = get('LensModel');
        const takenAt = toIsoDate(get('DateTimeOriginal'));
        const exposureTime = toNumber(get('ExposureTime'));
        const fNumber = toNumber(get('FNumber'));
        const iso = toNumber(get('ISO'));
        const focalLength = toNumber(get('FocalLength'));
        const focalLengthIn35mm = toNumber(get('FocalLengthIn35mmFormat'));
        const latitude = toCoordinate(get('GPSLatitude'));
        const longitude = toCoordinate(get('GPSLongitude'));
        const altitude = toNumber(get('GPSAltitude'));

        return {
            maker: typeof maker === 'string' ? maker : undefined,
            model: typeof model === 'string' ? model : undefined,
            lensModel: typeof lensModel === 'string' ? lensModel : undefined,
            takenAt,
            exposureTime,
            fNumber,
            iso,
            focalLength,
            focalLengthIn35mm,
            latitude,
            longitude,
            altitude,
            raw: parsed as Record<string, unknown>,
        };
    } catch (error) {
        console.warn('Failed to parse EXIF data', error);
        return null;
    }
}
