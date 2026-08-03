# Scan history (IndexedDB) — design

Date: 2026-08-03
Branch: `feat/scan-history-indexeddb`
Status: approved

## 1. Purpose

Nitidoc currently persists nothing. Every `warpedBlob`, `thumbnail` and `recipe`
lives in memory and dies on reload — the only persisted value in the whole app is
the locale, in `localStorage`. This design adds a **scan history**: finished
documents survive a reload, can be reopened, re-filtered and re-exported.

A second, dependent goal drives some of the choices here: the app is to be
packaged for Android (and later iOS) with Capacitor. History and cloud sync are
web-layer features — the native container inherits them. They must be built in
the web layer first. Section 9 covers the packaging work that follows.

## 2. Scope

Persisted per page: `warpedBlob`, `thumbnail`, `recipe`, warp dimensions.
**Not persisted: `originalBlob`.**

The user can reopen a document, change filters, rotate, reorder, delete pages and
re-export the PDF. The user **cannot** re-detect the document edges from scratch,
because that needs the un-warped original. Dropping `originalBlob` roughly halves
the storage cost, and re-cropping a finished scan is a rare operation compared to
re-exporting one.

Out of scope for this change: cloud sync, sharing, renaming documents, search,
folders, multi-select in the history list.

## 3. Data model

Two object stores. This mirrors the layered-memory principle the runtime store
already follows (D-MEM / ADR-007): **metadata is cheap and always resident, pixels
are materialized on demand.**

### `documents` (keyPath `id`)

| field          | type   | notes                                             |
| -------------- | ------ | ------------------------------------------------- |
| `id`           | string | `randomId()`; equals `DocumentSlice.documentId`   |
| `title`        | string | generated at save time, e.g. `Escaneo 03/08/2026` |
| `createdAt`    | number | epoch ms                                          |
| `lastOpenedAt` | number | epoch ms; drives LRU eviction                     |
| `pageCount`    | number |                                                   |
| `sizeBytes`    | number | sum of every stored blob for this document        |
| `cover`        | Blob   | page 0's thumbnail JPEG                           |
| `pinned`       | bool   | exempt from eviction                              |

Indexes: `by-createdAt` (list ordering, newest first), `by-lastOpenedAt`
(eviction scan).

Records are a few KB each. The history list reads **only** this store.

### `pages` (keyPath `['docId', 'order']`)

| field                          | type       | notes                             |
| ------------------------------ | ---------- | --------------------------------- |
| `docId`, `order`               | string/num | composite key                     |
| `recipe`                       | EditRecipe | JSON only, as it already is       |
| `warpedBlob`                   | Blob       | unfiltered warp base              |
| `thumbnail`                    | Blob       | ~150px JPEG                       |
| `warpedWidth`, `warpedHeight`  | number     |                                   |
| `needsReview`                  | bool?      | carried through                   |

The composite key makes every page of a document a contiguous key range, so
reading or deleting one document is `IDBKeyRange.bound([docId], [docId, []])` —
no secondary index needed. Arrays sort after every other key type in IDB, which
is what makes the `[docId, []]` upper bound work.

### Why thumbnails are stored as Blobs, not ImageBitmap

`DocumentPage.thumbnail` is a live `ImageBitmap` in memory. `ImageBitmap` is
structured-serializable, but IndexedDB uses *serialize-for-storage*, which does
not accept it. A JPEG `Blob` is unambiguously storable, smaller, and the codebase
already owns both directions of the conversion: `compressBitmapToJpeg` and
`decodeBlobToBitmap` in `pageResources.ts`.

### Rejected: one store with pages inline

IndexedDB cannot project a subset of a record's fields. Rendering a 20-document
list would deserialize 20 complete records — hundreds of MB of blobs to draw 20
thumbnails. That is precisely the failure mode the in-memory D-MEM design exists
to prevent.

### Noted escape hatch: blobs in OPFS

Metadata in IDB, blobs as OPFS files. Relieves IDB quota pressure, but deleting a
document stops being one transaction and becomes "delete the record AND the
files", with orphaned files as the failure mode. Not worth it at this data size.
Revisit if quota becomes a real constraint.

## 4. Modules

```
src/features/history/
  lib/
    historyConstants.ts   DB name/version, storage budget
    historyDb.ts          open + upgrade, transaction helpers
    historyMapper.ts      DocumentPage <-> StoredPage (ImageBitmap <-> Blob)
    historyRepository.ts  save / list / load / delete / usage
    historyEviction.ts    enforceBudget (size-capped LRU)
  hooks/
    useSaveToHistory.ts   called on document completion
    useHistoryList.ts     list + delete + usage for the screen
  components/
    HistoryScreen.tsx
    HistoryCard.tsx
src/shared/types/history.ts   HistoryDocumentMeta, StoredPage
```

`historyDb.ts` owns the single IDB footgun: an IDB transaction auto-commits when
the microtask queue drains, so `await`-ing anything that is not an IDB request
inside a transaction silently kills it. Every blob conversion therefore happens
**before** the transaction opens. This constraint is enforced by module boundary —
`historyMapper` is fully async and never sees a transaction; `historyRepository`
opens transactions only over already-materialized data.

Raw IndexedDB, no dependency. The surface is six operations, and the project
already prefers thin hand-written wrappers (`pageResources.ts`, `randomId.ts`).
A promise wrapper would remove boilerplate but not the auto-commit hazard, which
is the only thing here that actually bites.

## 5. Document identity

`DocumentSlice` gains `documentId: string`, seeded with `randomId()` and
regenerated by `resetDocument()`. It gives the in-progress document a stable
identity, which makes the history write an idempotent `put`: exporting the same
document twice updates one record instead of creating two.

## 6. Data flow

**Save** (`useSaveToHistory`, fired after a successful PDF export and on entering
the `done` phase):

1. Convert each page's `thumbnail` ImageBitmap to a JPEG Blob (async, outside any
   transaction).
2. Sum blob sizes into `sizeBytes`.
3. One `readwrite` transaction over both stores: `put` the document record, `put`
   every page record.
4. Run `enforceBudget()` in a separate transaction.
5. Request `navigator.storage.persist()` once, on the first successful save.

**List** (`useHistoryList`): cursor over `documents.by-createdAt` in reverse.
Object URLs for covers are created on render and revoked on unmount.

**Open**: read the document's page range, map each `StoredPage` back to a
`DocumentPage` (decoding thumbnails to ImageBitmap), reset the scanner store,
load the pages, set phase to `grid`, and stamp `lastOpenedAt`.

Rehydrated pages have no original. To avoid changing `DocumentPage`'s shape and
rippling through `useActivePage`, a restored page sets `originalBlob = warpedBlob`
and `originalWidth/Height = warpedWidth/Height`, and carries a new optional
`restoredFromHistory?: boolean`. Every existing code path keeps working
unchanged; re-entering the corner editor crops *into the already-straightened
page*, which the UI labels honestly rather than pretending it is a fresh crop.

**Delete**: one `readwrite` transaction removing the document record and its page
key range.

## 7. Retention and quota

Budget: 500 MB (`HISTORY.BUDGET_BYTES`, a calibratable starting value, following
the existing `FILTER`/`DETECTION` constants convention).

`enforceBudget()` walks `by-lastOpenedAt` ascending, summing `sizeBytes`, and
deletes the oldest **non-pinned** documents until the total fits. It reads only
metadata records — never a blob.

`QuotaExceededError` on write is caught, `enforceBudget()` runs, and the write is
retried exactly once. A second failure surfaces a toast and leaves the in-memory
document untouched: **a failed history write must never cost the user the
document they are holding.**

## 8. Error handling and testing

Every repository call resolves to a result the caller can act on rather than
throwing into a void. History is an enhancement — the scanner must stay fully
usable when IndexedDB is unavailable (private mode, disabled storage), exactly as
`LocaleProvider` already degrades when `localStorage` throws.

Unit tests (vitest, happy-dom + `fake-indexeddb`): schema upgrade, save/load
round-trip preserving recipes and dimensions, composite-key range isolation
between documents, eviction ordering and pinned exemption, quota retry.

E2E (Playwright, real Chromium IDB): scan → export → reload → history lists the
document → open it → the page grid shows the right page count.

## 9. Follow-on: Android packaging with Capacitor

Capacitor rather than a TWA, decided by the iOS requirement: a TWA is
Android-only with no iOS counterpart, so one codebase for both platforms rules it
out.

Known work, from reading the current code:

1. `exportPdf.ts` ends in `jsPDF.save()`, which triggers a browser download. An
   Android WebView does not handle that. Native builds must branch to
   `Filesystem.writeFile` + `Share`.
2. `opencv.worker.ts` is a classic worker that calls
   `importScripts('/opencv/opencv.js')`. Capacitor serves the bundle from
   `https://localhost/`, so the absolute path resolves — but this is the single
   highest-risk assumption in the packaging work and gets verified first, not
   last.
3. The service worker is redundant in a native build and must be disabled there,
   alongside the existing `httpsPreview` condition in `vite.config.ts`.
4. `CAMERA` permission in the manifest; Capacitor's WebChromeClient maps the
   WebView's `getUserMedia` permission request onto the Android runtime prompt.
   To be verified against the installed Capacitor version rather than assumed.
5. Torch via `applyConstraints` is inconsistent across Android WebView vendors.
   Degrading gracefully is already the existing behavior (`setTorch` swallows a
   rejected `applyConstraints`), so this is a known limitation, not a blocker.
