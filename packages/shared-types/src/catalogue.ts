import type { ProviderId } from './provider.js';

/**
 * What the user actually picks from in "Connect an account".
 *
 * A catalogue entry is not the same thing as an adapter. Six of the services
 * below all speak the plain S3 API, so they share the single `s3` adapter and
 * differ only in the endpoint they point at — presenting them as one generic
 * "S3-compatible" option would make the user look up their own endpoint URL
 * for no reason.
 */

export interface CredentialField {
  name: string;
  label: string;
  placeholder?: string;
  help?: string;
  secret?: boolean;
  optional?: boolean;
}

export interface CatalogueEntry {
  /** Stable id used by the connect UI and stored on the account row. */
  key: string;
  label: string;
  /** The adapter that actually talks to it. */
  provider: ProviderId;
  /** Short line shown under the name in the connect dialog. */
  blurb: string;
  /**
   * For S3-compatible services: the endpoint, with {placeholders} filled from
   * the fields below. Absent for providers with a fixed or discovered endpoint.
   */
  endpointTemplate?: string;
  defaultRegion?: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-host
   * (`bucket.endpoint/key`). Required by some services, rejected by others.
   */
  forcePathStyle?: boolean;
  /** Extra inputs the connect form must collect beyond the standard ones. */
  fields?: CredentialField[];
}

const ACCESS_KEY_FIELDS: CredentialField[] = [
  { name: 'accessKeyId', label: 'Access key ID' },
  { name: 'secretAccessKey', label: 'Secret access key', secret: true },
  { name: 'bucket', label: 'Bucket name' },
];

export const PROVIDER_CATALOGUE: CatalogueEntry[] = [
  // --- consumer drives, OAuth ------------------------------------------------
  {
    key: 'google_drive',
    label: 'Google Drive',
    provider: 'google_drive',
    blurb: 'Personal or Workspace Drive, including Shared with me.',
  },
  {
    key: 'onedrive',
    label: 'OneDrive',
    provider: 'onedrive',
    blurb: 'Personal OneDrive or OneDrive for Business.',
  },
  {
    key: 'dropbox',
    label: 'Dropbox',
    provider: 'dropbox',
    blurb: 'Personal or team Dropbox.',
  },
  {
    key: 'pcloud',
    label: 'pCloud',
    provider: 'pcloud',
    blurb: 'pCloud drive, EU or US region.',
  },

  // --- object storage, S3 API ------------------------------------------------
  {
    key: 'aws_s3',
    label: 'Amazon S3',
    provider: 's3',
    blurb: 'Any S3 bucket, in any region.',
    endpointTemplate: 'https://s3.{region}.amazonaws.com',
    defaultRegion: 'us-east-1',
    fields: [...ACCESS_KEY_FIELDS, { name: 'region', label: 'Region', placeholder: 'us-east-1' }],
  },
  {
    key: 'cloudflare_r2',
    label: 'Cloudflare R2',
    provider: 's3',
    blurb: 'R2 bucket. Uses an S3 API token from the R2 dashboard.',
    endpointTemplate: 'https://{accountId}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    forcePathStyle: true,
    fields: [
      {
        name: 'accountId',
        label: 'Cloudflare account ID',
        help: 'Shown on the R2 overview page, and in the S3 endpoint it gives you.',
      },
      // R2 hands out three values at once and only two of them work here, so
      // the fields say which is which rather than leaving Cloudflare to answer
      // with "length 53, should be 32".
      {
        name: 'accessKeyId',
        label: 'Access key ID',
        help: 'The 32-character hex value labelled "Access Key ID" — not the token value beginning cfat_, which is for Cloudflare’s own API.',
      },
      { name: 'secretAccessKey', label: 'Secret access key', secret: true },
      { name: 'bucket', label: 'Bucket name' },
    ],
  },
  {
    key: 'supabase_storage',
    label: 'Supabase Storage',
    provider: 's3',
    blurb: 'A Supabase storage bucket over its S3-compatible endpoint.',
    // Supabase moved S3 onto its own host; the older {ref}.supabase.co form no
    // longer answers.
    endpointTemplate: 'https://{projectRef}.storage.supabase.co/storage/v1/s3',
    forcePathStyle: true,
    fields: [
      {
        name: 'projectRef',
        label: 'Project reference',
        help: 'Paste the whole S3 endpoint from Project Settings, Storage - or just the reference from your project URL. Either works.',
      },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
      ...ACCESS_KEY_FIELDS,
    ],
  },
  {
    key: 'digitalocean_spaces',
    label: 'DigitalOcean Spaces',
    provider: 's3',
    blurb: 'A Space, addressed by its regional endpoint.',
    endpointTemplate: 'https://{region}.digitaloceanspaces.com',
    defaultRegion: 'nyc3',
    fields: [...ACCESS_KEY_FIELDS, { name: 'region', label: 'Region', placeholder: 'nyc3' }],
  },
  {
    key: 'backblaze_b2',
    label: 'Backblaze B2',
    provider: 's3',
    blurb: 'A B2 bucket over the S3-compatible API.',
    endpointTemplate: 'https://s3.{region}.backblazeb2.com',
    defaultRegion: 'us-west-004',
    fields: [...ACCESS_KEY_FIELDS, { name: 'region', label: 'Region', placeholder: 'us-west-004' }],
  },
  {
    key: 's3_other',
    label: 'Other S3-compatible',
    provider: 's3',
    blurb: 'MinIO, Ceph, Storj, or anything else that speaks the S3 API.',
    forcePathStyle: true,
    fields: [
      { name: 'endpoint', label: 'Endpoint URL', placeholder: 'https://s3.example.com' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1', optional: true },
      ...ACCESS_KEY_FIELDS,
    ],
  },

  // --- object storage, native APIs -------------------------------------------
  {
    key: 'gcs',
    label: 'Google Cloud Storage',
    provider: 's3',
    blurb: 'A GCS bucket, over its S3-compatible interoperability endpoint.',
    endpointTemplate: 'https://storage.googleapis.com',
    defaultRegion: 'auto',
    forcePathStyle: true,
    fields: [
      {
        name: 'accessKeyId',
        label: 'Access key',
        help: 'An HMAC key from Cloud Storage → Settings → Interoperability. Not a service account JSON key.',
      },
      { name: 'secretAccessKey', label: 'Secret', secret: true },
      { name: 'bucket', label: 'Bucket name' },
    ],
  },
  {
    key: 'azure_blob',
    label: 'Azure Blob Storage',
    provider: 'azure_blob',
    blurb: 'A blob container, authenticated with a storage account key.',
    fields: [
      { name: 'azureAccountName', label: 'Storage account name' },
      { name: 'azureAccountKey', label: 'Account key', secret: true },
      { name: 'azureContainer', label: 'Container name' },
    ],
  },
  {
    key: 'bunny',
    label: 'Bunny Storage',
    provider: 'bunny',
    blurb: 'A Bunny Edge Storage zone.',
    fields: [
      { name: 'bunnyStorageZone', label: 'Storage zone name' },
      { name: 'bunnyAccessKey', label: 'Storage zone password', secret: true },
      {
        name: 'bunnyRegionHost',
        label: 'Region host',
        placeholder: 'storage.bunnycdn.com',
        help: 'The main region is storage.bunnycdn.com; others are prefixed, e.g. ny.storage.bunnycdn.com.',
        optional: true,
      },
    ],
  },
];

/**
 * Services people ask for that Orbit cannot support, with the reason. Surfaced
 * through the API so the connect dialog can say why, rather than silently
 * omitting them and looking incomplete.
 */
export function catalogueEntry(key: string): CatalogueEntry | undefined {
  return PROVIDER_CATALOGUE.find((entry) => entry.key === key);
}

/** Fills an endpoint template from collected field values. */
export function resolveEndpoint(entry: CatalogueEntry, values: Record<string, string>): string | undefined {
  if (!entry.endpointTemplate) return values.endpoint;
  return entry.endpointTemplate.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
