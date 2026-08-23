# Native iOS Application Design

**Status:** Approved design
**Date:** 2026-08-23
**Product:** Nitidoc
**Platform:** iOS 18 and later

## 1. Summary

Nitidoc will gain a fully native iOS application written in Swift and SwiftUI. It will not embed the existing React application or use Capacitor on iOS.

The app will use Apple's VisionKit document camera for capture because reliable automatic document detection is the primary goal. Once VisionKit finishes, Nitidoc will own the multipage review, post-production editor, filters, local library, and PDF export experience.

The implementation will be a feature-modular monolith. Apple framework integrations will sit behind small protocols so domain behavior remains testable without a physical camera or persistent device storage.

## 2. Goals

- Deliver a genuinely native SwiftUI application for iOS 18 and later.
- Use VisionKit for automatic edge detection, capture, crop correction, and multipage scanning.
- Reach functional parity with the current Nitidoc application before public release.
- Preserve Nitidoc's local-only privacy model: no account, backend, or document upload.
- Keep editing non-destructive after VisionKit returns each processed page.
- Support automatic document detection and manual corner refinement for imported photos.
- Produce multipage PDFs with correct page order and physical paper dimensions.
- Provide evidence-based parity and quality validation on a real iPhone.

## 3. Non-goals

- Migrating documents or history from Safari, the PWA, or Android.
- Sharing the React runtime, OpenCV.js worker, Zustand store, or browser persistence layer.
- Building a custom AVFoundation camera for the first native release.
- Recovering pixels that VisionKit removed from a captured page.
- Importing existing PDF files.
- Adding accounts, cloud synchronization, OCR, or a backend.
- Supporting iOS versions earlier than iOS 18.

## 4. Approved product decisions

1. The iOS app is a complete Swift/SwiftUI rewrite.
2. The minimum deployment target is iOS 18.
3. Capture uses Apple's VisionKit document-camera interface.
4. The first release requires functional parity, not a reduced scanner MVP.
5. The native document library starts empty; no PWA history migration is required.
6. VisionKit's returned page is Nitidoc's immutable source image.
7. Post-production corner editing is supported, but it cannot extend beyond the pixels VisionKit returned.
8. Imported photos retain their full source image and use Vision for automatic document detection before manual confirmation.
9. The codebase uses a feature-modular monolith rather than multiple Swift packages or a single undifferentiated MVVM module.

## 5. Alternatives considered

### 5.1 Feature-modular SwiftUI monolith — selected

A single application target is divided by product capability. Framework adapters are replaceable at protocol boundaries, while feature code stays close to its UI and use cases.

This provides sufficient isolation without introducing package-management and dependency-graph overhead before the domain boundaries have stabilized.

### 5.2 Multiple local Swift packages

Separate packages would provide stronger compile-time boundaries and independent tests. They were rejected for the initial rewrite because the operational overhead is disproportionate to the current app size. Packages can be extracted later if a module gains another consumer or independent release cadence.

### 5.3 Single-target MVVM without feature boundaries

This would start quickly but would likely couple camera callbacks, image processing, persistence, and navigation as parity work grows. It was rejected because those responsibilities have different failure modes and testing needs.

## 6. Repository and module structure

The native project will live beside the existing web and Android code:

```text
ios-native/
├── Nitidoc.xcodeproj
├── Nitidoc/
│   ├── App/
│   ├── Features/
│   │   ├── Documents/
│   │   ├── Capture/
│   │   ├── Review/
│   │   ├── Editor/
│   │   ├── Import/
│   │   ├── Export/
│   │   └── Settings/
│   ├── Domain/
│   ├── Infrastructure/
│   │   ├── VisionKit/
│   │   ├── Vision/
│   │   ├── Imaging/
│   │   ├── Persistence/
│   │   └── PDF/
│   └── Resources/
├── NitidocTests/
└── NitidocUITests/
```

Feature modules may depend on `Domain` contracts. Infrastructure implements those contracts and is composed at the app boundary. Features must not call VisionKit, SwiftData, FileManager, or PDF APIs directly.

Initial service boundaries:

- `DocumentScanning`: presents the system scanner and returns page images or cancellation.
- `BorderDetecting`: detects a document quadrilateral in an imported image.
- `ImageRendering`: applies crop, perspective correction, rotation, and filters.
- `DocumentRepository`: stores document metadata and coordinates private files.
- `PDFExporting`: renders an ordered document to a temporary PDF.
- `StorageChecking`: checks capacity before ingestion and export.

SwiftUI views and observable presentation models run on the main actor. Image rendering, file operations, and export run in cancellable background tasks. Stateful repositories and render coordinators use actors where serialization is required.

## 7. Capture boundary

`VNDocumentCameraViewController` is wrapped by a small SwiftUI bridge using `UIViewControllerRepresentable` and a coordinator delegate.

VisionKit owns:

- Camera permission and preview.
- Automatic document-edge detection.
- Automatic and manual capture behavior offered by the system UI.
- Capture-time crop correction and multipage review.
- Flash and system camera controls.

Nitidoc receives:

- Completion, cancellation, or failure.
- The final page count.
- One processed `UIImage` per page.

VisionKit does not provide a public contract for the uncropped source image or detected corner metadata. Nitidoc therefore treats each returned image as the immutable source boundary. The post-production editor can crop further or change the quadrilateral inside that image, but it cannot recover removed pixels.

Canceling the scanner returns to the library without creating an empty document.

## 8. Data model

### 8.1 DocumentRecord

- Stable UUID.
- User-visible title.
- Creation and modification timestamps.
- Ordered relationship to pages.
- State: draft or saved.

### 8.2 PageRecord

- Stable UUID and document relationship.
- Stable integer order.
- Reference to an immutable private source file.
- Pixel dimensions and normalized orientation metadata.
- Current `EditRecipe`.
- Reference to a regenerable thumbnail.

### 8.3 EditRecipe

`EditRecipe` is a value-type, Codable description of the current edit:

- Four crop points normalized to the source image coordinate space.
- Rotation constrained to quarter turns.
- Filter preset and its versioned parameters.
- Selected paper format.
- Paper-format provenance: automatic, probable, or manual.

Recipes replace previous values atomically. Editing never overwrites the source image. The same recipe drives onscreen previews and final PDF rendering.

### 8.4 Storage layout

- SwiftData stores metadata, relationships, and recipes.
- Source images live in the private Application Support container under document and page identifiers.
- Orientation is normalized and each source is encoded once through ImageIO, preferring HEIF with a JPEG fallback.
- Regenerable thumbnails and render caches live in the Caches directory.
- Ingestion and export intermediates live in a task-specific temporary directory.
- Temporary files are removed after success, cancellation, or failure.

Large image payloads are not stored as SwiftData blobs.

## 9. Product flows

### 9.1 New scan

1. The user starts a scan from the local library.
2. Nitidoc presents VisionKit full screen.
3. The user scans and reviews one or more pages in Apple's interface.
4. On completion, Nitidoc copies and validates every returned page in a temporary ingestion transaction.
5. The repository atomically creates a draft document and moves validated sources into private storage.
6. Nitidoc opens the multipage review screen.
7. The user may reorder, delete, add, replace, or edit pages.
8. Leaving a nonempty review auto-saves the draft.
9. The user exports a PDF without losing the editable document.

### 9.2 Imported photo

1. The user selects an image with `PhotosPicker`.
2. Nitidoc copies the full source into its temporary ingestion area.
3. Vision's iOS 18 document-segmentation request proposes a quadrilateral.
4. A valid result preselects the detected corners; no result falls back to the full image.
5. The user confirms or adjusts the corners in Nitidoc's editor.
6. The page joins the same review and persistence flow as a scanned page.

### 9.3 Post-production editor

The editor provides:

- Manual four-corner adjustment bounded by the immutable source.
- Reset to the source bounds for VisionKit pages.
- Automatic re-detection and manual correction for imported photos.
- Rotation in 90-degree steps.
- Paper-format selection.
- Filter selection with immediate downsampled previews.
- Confirm and cancel semantics; cancel discards the pending recipe.

### 9.4 Multipage review

The review screen provides:

- Ordered page thumbnails.
- Drag-based reordering with an accessible non-drag alternative.
- Page deletion with confirmation and safe file cleanup.
- Adding more scanned pages through VisionKit.
- Replacing a selected page.
- Opening the page editor.
- Document title editing.
- PDF export.

The app enforces the current executable page limit of 30 pages per document.

## 10. Image processing

The native implementation does not port OpenCV.js. It uses Apple-native image APIs:

- Vision for automatic border detection on imported photos.
- Core Image for perspective correction, rotation, color transforms, compositing, and final rendering.
- Accelerate/vImage for deterministic grayscale and adaptive black-and-white operations where neighborhood processing is required.
- ImageIO for orientation normalization, encoding, metadata control, and downsampling.

The filter parity set is:

- Original.
- Enhanced.
- Grayscale.
- Black and white.
- Black and white high contrast.
- Eco.

Filter behavior is calibrated against shared document fixtures and reference output from the current application. Preview rendering may use a downsampled source, but export always renders from the immutable full-resolution source.

The render pipeline applies operations in a stable order:

1. Decode and normalize orientation.
2. Apply perspective correction from the recipe quadrilateral.
3. Apply quarter-turn rotation.
4. Apply the selected filter.
5. Scale into the target paper page without distortion.

## 11. Paper formats and PDF export

The native app preserves the current format domain:

- A4.
- Letter.
- Legal.
- Ticket.
- Original.

Automatic geometry may mark an ISO A-series ratio as probable rather than claiming physical scale from pixels. Manual selection remains authoritative.

Export uses Core Graphics page boxes with physical dimensions for formats that define them. Original and Ticket preserve aspect ratio and use an explicit raster-dependent fallback rather than stretching the document.

Export behavior:

1. Preflight available storage.
2. Render pages sequentially in document order to bound peak memory.
3. Write to a unique temporary PDF.
4. Reopen the PDF to validate page count and page boxes.
5. Present the system Share Sheet or Files destination.
6. Remove the temporary export when its lifecycle ends.

An export failure never modifies the editable document.

## 12. Local library, localization, and accessibility

The first launch starts with an empty SwiftData library. Documents are ordered by most recently modified and remain available offline.

The native UI supports Spanish and English from the first release. Existing product terminology is reused where it remains accurate, but strings are implemented through native localization resources rather than copied into source code.

Accessibility requirements:

- Dynamic Type without clipped primary actions.
- VoiceOver names, values, and actions for page thumbnails and corner handles.
- A non-drag method to reorder pages.
- Sufficient contrast and no color-only state communication.
- Respect for Reduce Motion.
- Correct safe-area behavior on supported iPhones.

The VisionKit portion inherits Apple's system accessibility behavior; Nitidoc is responsible for every screen after the scanner closes.

## 13. Privacy and security boundary

- No account, backend, or cloud document synchronization.
- No document upload or remote image processing.
- Source images, metadata, thumbnails, and drafts remain inside the app container.
- Export occurs only after an explicit user action through system sharing or Files UI.
- Logs and errors must never contain image bytes, recognized document contents, or user filenames beyond what is required for local presentation.
- Temporary files use random task-specific directories and are removed deterministically.
- File protection uses the strongest protection compatible with background-safe local workflows.

Privacy is an architectural property, not a network promise: the first release does not include a document network client.

## 14. Error handling

- Unsupported or failed VisionKit presentation returns to the library and offers photo import.
- User cancellation is not treated as an error and creates no empty document.
- Page ingestion validates page count, dimensions, encoding, and writable capacity before committing metadata.
- A partial ingestion failure rolls back the new draft and its temporary files.
- Existing documents are never deleted automatically to recover storage.
- A filter or preview failure preserves the source, shows Original, and offers retry.
- Export is published only after the temporary PDF is complete and validated.
- Deletion coordinates metadata, source files, thumbnails, and caches so the library cannot retain orphaned records.
- Background tasks observe cancellation and release large image buffers promptly.

Errors are localized, actionable, and scoped to the failed operation.

## 15. Testing strategy

### 15.1 Unit tests

- Normalized corner-coordinate conversion and validation.
- Perspective and rotation recipe behavior.
- Paper-format dimensions and provenance.
- Page ordering and the 30-page limit.
- Repository lifecycle and temporary-file cleanup.
- Filter parameter mapping and deterministic image helpers.

### 15.2 Fixture-based quality tests

- Real document fixtures covering bright pages, low contrast, shadows, similar backgrounds, skew, and text density.
- Reference comparisons for crop geometry and every filter preset.
- Explicit tolerances for platform rendering differences rather than exact compressed-byte equality.
- Full-resolution and preview paths checked against the same recipe.

### 15.3 Integration tests

- Real Vision document segmentation over approved photo fixtures.
- SwiftData with isolated temporary stores and file containers.
- Ingestion commit and rollback behavior.
- PDF generation followed by PDFKit/Core Graphics validation of page count, order, and page boxes.
- Camera success, cancellation, and failure through a fake `DocumentScanning` implementation.

### 15.4 UI tests

- Empty library and first scan entry.
- Photo import, corner confirmation, and no-detection fallback.
- Multipage reorder, add, replace, edit, and delete.
- Draft restoration and local history.
- Filter and paper-format selection.
- Export success and injected failure states.
- Spanish and English navigation.
- Dynamic Type and critical VoiceOver actions.

### 15.5 Real-device validation

VisionKit capture is not considered validated by Simulator or protocol fakes. Before release, an iPhone running iOS 18 or later must validate:

- Automatic border detection against varied lighting and backgrounds.
- Multipage capture and capture-time manual correction.
- Cancellation at different stages.
- Large documents up to the 30-page limit.
- Memory pressure, backgrounding, and return to the app.
- Post-production editing and PDF sharing.

### 15.6 Parity gate

The release checklist maps every current PWA capability to one of:

- Automated native test evidence.
- Fixture-based image evidence.
- Real-device evidence.

The native app does not ship while a required capability lacks evidence or has an unresolved behavioral regression.

## 16. Acceptance criteria

The design is satisfied when:

1. A SwiftUI app targeting iOS 18 presents VisionKit and ingests a multipage result.
2. Canceling or failing capture leaves no empty or corrupt document.
3. VisionKit pages are stored as immutable private sources.
4. Imported photos receive automatic Vision detection with manual-corner fallback.
5. Users can reorder, add, replace, edit, and delete pages up to the 30-page limit.
6. Post-production crops remain bounded by their source and never imply pixel recovery.
7. All six existing filter presets render from the same recipe in preview and export paths.
8. A4, Letter, Legal, Ticket, and Original produce non-distorted PDF pages under their documented sizing rules.
9. Drafts and saved documents survive app restarts without a backend.
10. Spanish, English, Dynamic Type, VoiceOver, and non-drag reordering are verified.
11. Transactional failure tests leave existing documents intact and remove operation temporaries.
12. A real iPhone completes the approved VisionKit and parity validation matrix.

## 17. Implementation sequencing constraints

Implementation planning must proceed vertically rather than building all infrastructure first. Each slice must finish with an observable product behavior and its focused tests.

The first implementation plan should establish, in order:

1. Native project shell and dependency rules.
2. VisionKit capture adapter with fake-driven tests.
3. Transactional document ingestion and local library.
4. Multipage review and page lifecycle.
5. Non-destructive editor and imported-photo detection.
6. Native filter parity.
7. Physical PDF sizing and export.
8. Localization, accessibility, resilience, and full parity validation.

No implementation work starts until this written design has been reviewed by the user.
