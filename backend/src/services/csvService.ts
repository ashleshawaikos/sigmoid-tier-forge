import { parse } from 'csv-parse/sync';
import { z } from 'zod';

import type { StoreInput } from '../lib/db.js';

const requiredHeaders = [
  'store_id',
  'store_name',
  'address',
  'city',
  'state',
  'country',
];
const storeSchema = z.object({
  store_id: z.string().trim().min(1),
  store_name: z.string().trim().min(1),
  address: z.string().trim().min(1),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  country: z.string().trim().min(1),
});

export function parseStoreCsv(source: string): StoreInput[] {
  let records: string[][];
  try {
    records = parse(source, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }) as string[][];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Malformed CSV';
    throw new Error(`Invalid CSV: ${message}`);
  }

  const headers = records.shift()?.map((header) => header.trim()) ?? [];
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(
      `CSV is missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
    );
  }
  if (records.length === 0) {
    throw new Error('CSV contains no store rows.');
  }
  const duplicateHeaders = requiredHeaders.filter(
    (header) => headers.filter((item) => item === header).length > 1,
  );
  if (duplicateHeaders.length) {
    throw new Error(
      `CSV contains duplicate required column${duplicateHeaders.length > 1 ? 's' : ''}: ${duplicateHeaders.join(', ')}`,
    );
  }

  const seen = new Set<string>();
  return records.map((record, index) => {
    const row: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      row[header] = record[headerIndex] ?? '';
    });
    const parsed = storeSchema.safeParse(row);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ');
      throw new Error(
        `Invalid store on CSV row ${index + 2}: ${fields} must be non-empty.`,
      );
    }
    if (seen.has(parsed.data.store_id)) {
      throw new Error(
        `Duplicate store_id "${parsed.data.store_id}" on CSV row ${index + 2}.`,
      );
    }
    seen.add(parsed.data.store_id);
    return parsed.data;
  });
}
