# Provider icons

## What ships today

`apps/web/src/components/ProviderIcon.tsx` contains **original glyphs**, not the vendors' logos.
Each uses the service's own brand colour and a simple form that evokes it, so the provider list
is scannable at a glance.

Nothing in this repository reproduces a trademarked mark. That is deliberate. Orbit is a public
repository under the MIT licence, and bundling other companies' logos into it raises a licensing
question that is easier to not have than to answer. Every glyph here was drawn for this project.

## If you want the real brand marks

Every one of these vendors publishes official assets, and most permit their use to identify an
integration. The obligations differ, so read each before shipping:

| Provider | Where the assets live |
|---|---|
| Google Drive | Google Workspace / Drive brand guidelines, in the Google brand resource centre |
| OneDrive | Microsoft brand and trademark guidelines |
| Dropbox | Dropbox brand guidelines |
| pCloud | pCloud press kit |
| Amazon S3 | AWS architecture icons, published as an official icon set |
| Cloudflare R2 | Cloudflare brand and logo page |
| Supabase | Supabase brand assets |
| DigitalOcean Spaces | DigitalOcean press and brand resources |
| Backblaze B2 | Backblaze press kit |
| Google Cloud Storage | Google Cloud architecture icon set |
| Azure Blob Storage | Microsoft Azure architecture icons |
| Bunny Storage | Bunny brand resources |

Common conditions, worth checking against each licence rather than assuming:

- Use the mark to identify **their** service, never to imply they endorse or sponsor Orbit.
- Do not recolour, stretch, rotate, or redraw a logo, and respect its clear space.
- Some sets — AWS and Azure architecture icons in particular — carry terms restricting
  redistribution, which matters for a public repo in a way it would not for a private one.

## How to swap them in

`ProviderIcon` maps a catalogue key to a mark. To use official assets:

1. Put the files in `apps/web/public/providers/` (SVG preferred).
2. Replace the `render` function for that key with an `<image href="/providers/x.svg" …>`, or
   swap the component for an `<img>` — the call sites only pass `provider` and `size`, so
   nothing else has to change.
3. Add a `docs/licences/` note recording where each file came from and under what terms.

The keys are the catalogue keys from `PROVIDER_CATALOGUE`, not the adapter ids, so Cloudflare R2
and Backblaze B2 each get their own mark even though both route to the `s3` adapter.

## Accessibility

The icons are decorative: every one is `aria-hidden`, and the provider name always appears as
text next to it. Nothing is conveyed by icon alone, so colour blindness or a failed image load
costs nothing.
