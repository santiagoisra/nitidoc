# Native iOS Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only SwiftUI iOS 18+ Nitidoc app that reaches the approved scanner, editing, library, and PDF-export parity through independently reviewable vertical slices.

**Architecture:** Create `ios-native/` as one Xcode application target structured as a feature-modular monolith. Feature presentation models consume domain protocols; VisionKit, Vision, SwiftData, ImageIO/Core Image/vImage, the filesystem, and PDF APIs live behind infrastructure adapters assembled at the app boundary. Source images are immutable private files, while SwiftData persists only document metadata and Codable edit recipes.

**Tech Stack:** Swift 6, SwiftUI, SwiftData, VisionKit, Vision, PhotosUI, Core Image, Accelerate/vImage, ImageIO, Core Graphics, PDFKit, XCTest/XCUITest, Swift Testing, Xcode 16.

## Global Constraints

- Create a complete native rewrite in `ios-native/`; do not embed React, Capacitor, OpenCV.js, Zustand, IndexedDB, or browser persistence.
- Set `IPHONEOS_DEPLOYMENT_TARGET = 18.0`; support iPhone only for the first release.
- Use only Apple frameworks and system UI; introduce no third-party iOS dependency.
- Keep the first release local-only: no account, backend, sync, analytics, upload, OCR, remote image processing, or document network client.
- Use `VNDocumentCameraViewController` for scanner UI. Treat each returned `UIImage` as an immutable source; post-production corners stay inside that image.
- Store document metadata and relationships in SwiftData; store source images in Application Support, thumbnails and render caches in Caches, and operation intermediates in unique Temporary directories.
- Normalize source orientation once through ImageIO, encode HEIF when supported with JPEG fallback, and never persist large image payloads as SwiftData blobs.
- Make `EditRecipe` a `Codable`, `Hashable`, `Sendable` value; recipe replacement is atomic and source files are never edited.
- Enforce `pageCount <= 30` before every scan/import/replace commit. The current web code confirms this executable contract in `src/features/scanner/lib/filterConstants.ts` and `src/features/scanner/store/documentSlice.ts`.
- Preserve the six presets: Original, Enhanced, Grayscale, Black and white, Black and white high contrast, and Eco.
- Preserve A4, Letter, Legal, Ticket, and Original. Pixels can establish shape only; automatic ISO detection is `probable`, and manual selection is authoritative.
- Run presentation models and SwiftUI view updates on `@MainActor`; use actors or `@ModelActor` for serialized file, repository, and render state. Image rendering, file I/O, and PDF export must be cancellable background work.
- Localize all Nitidoc-owned strings with `Localizable.xcstrings` for Spanish and English; never hard-code user-visible copy in feature code.
- Meet Dynamic Type, VoiceOver, Reduce Motion, sufficient contrast, safe-area, and non-drag reorder requirements on every Nitidoc-owned screen.
- Do not log image bytes, document contents, or user filenames other than the local title currently being displayed.
- Use conventional commits only. Before every commit, stage only `ios-native/` files belonging to the completed task and inspect `git diff --cached`.

---

## File map

| Path | Responsibility |
| --- | --- |
| `ios-native/Nitidoc.xcodeproj/project.pbxproj` | Single iOS application, unit-test, and UI-test targets; deployment target, capabilities, resources, and build settings. |
| `ios-native/Nitidoc/App/` | Composition root, scene root, dependency container, launch arguments, and global error presentation. |
| `ios-native/Nitidoc/Domain/` | Framework-free models, recipe validation, paper geometry, file identifiers, domain errors, and service protocols. |
| `ios-native/Nitidoc/Infrastructure/VisionKit/` | `UIViewControllerRepresentable` bridge around the system scanner. |
| `ios-native/Nitidoc/Infrastructure/Vision/` | Imported-photo document segmentation adapter. |
| `ios-native/Nitidoc/Infrastructure/Persistence/` | SwiftData models, repository, private image store, capacity checker, and transactional cleanup. |
| `ios-native/Nitidoc/Infrastructure/Imaging/` | ImageIO normalization, Core Image perspective/rotation/filter renderer, vImage adaptive filters, thumbnail renderer, and fixture comparator. |
| `ios-native/Nitidoc/Infrastructure/PDF/` | Sequential Core Graphics PDF producer, PDFKit validation, and share/files presentation adapter. |
| `ios-native/Nitidoc/Features/Documents/` | Empty and history library UI ordered by modification date. |
| `ios-native/Nitidoc/Features/Capture/` | Scan entry, scanner outcome handling, and photo-import entry. |
| `ios-native/Nitidoc/Features/Review/` | Draft review, page lifecycle, title editing, drag and accessible reorder. |
| `ios-native/Nitidoc/Features/Editor/` | Non-destructive crop, corners, filters, rotation, paper choice, and pending-recipe semantics. |
| `ios-native/Nitidoc/Features/Import/` | PhotosPicker transfer, detection proposal, and no-detection fallback. |
| `ios-native/Nitidoc/Features/Export/` | Export progress, recoverable failure UI, and explicit handoff to system sharing. |
| `ios-native/Nitidoc/Features/Settings/` | Native language and accessibility preferences only when a setting needs persistent UI. |
| `ios-native/Nitidoc/Resources/` | Asset catalog, `Info.plist`, privacy strings, string catalog, and document/image fixtures. |
| `ios-native/NitidocTests/` | Swift Testing unit, repository integration, image fixture, Vision integration, and PDF validation tests. |
| `ios-native/NitidocUITests/` | XCTest UI journeys and accessibility/localization launch-configuration coverage. |
| `ios-native/docs/` | Native-only parity matrix, fixture manifest, calibration procedure, and physical-device release evidence. |

## Common commands

Run these from the repository root on macOS with Xcode 16 installed after the relevant target exists. Set a concrete installed simulator once with `xcrun simctl list devices available` and reuse that destination for local work. This Windows checkout can author and review the plan, but it cannot verify `xcodebuild` results; do not mark a native build or test as passed unless it ran on macOS or a real iPhone as stated.

```bash
xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' test
xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'generic/platform=iOS' build
xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/RecipeTests test
xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LibraryFlowUITests test
```

The existing web checks (`npm test`, `npm run test:e2e`, `npm run build`) remain valuable regression checks for the web application, but they do not validate the new native target and must not be changed by this work.

---

## Milestone 1 — native shell and contracts

### Task 1: Create the iOS target, test targets, and an observable empty library

**Files:**
- Create: `ios-native/Nitidoc.xcodeproj/project.pbxproj`
- Create: `ios-native/Nitidoc/App/NitidocApp.swift`
- Create: `ios-native/Nitidoc/App/AppContainer.swift`
- Create: `ios-native/Nitidoc/Features/Documents/DocumentLibraryView.swift`
- Create: `ios-native/Nitidoc/Resources/Info.plist`
- Create: `ios-native/Nitidoc/Resources/Localizable.xcstrings`
- Create: `ios-native/NitidocTests/NitidocAppTests.swift`
- Create: `ios-native/NitidocUITests/LibraryFlowUITests.swift`

**Interfaces:**
- Produces: `@main struct NitidocApp: App`, `@MainActor final class AppContainer`, and `DocumentLibraryView` with `accessibilityIdentifier("document-library")`.
- Produces: a `Nitidoc` app target plus `NitidocTests` and `NitidocUITests` targets, all with iOS 18.0 deployment target.

- [ ] **Step 1: Create the Xcode project and targets with the required platform settings**

Use Xcode 16’s iOS App template to create `ios-native/Nitidoc.xcodeproj` with SwiftUI, Swift Testing available to `NitidocTests`, and XCTest available to `NitidocUITests`. Set every target’s deployment target to `18.0`, set the application’s supported device family to iPhone, add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` localization keys, and add `Localizable.xcstrings` as a resource. Do not enable iCloud, App Groups, network capabilities, or external packages.

- [ ] **Step 2: Write the failing empty-library UI test**

```swift
func testFirstLaunchShowsEmptyLibraryAndNewDocumentActions() {
    let app = XCUIApplication()
    app.launchArguments = ["-resetPersistentStore", "YES"]
    app.launch()

    XCTAssertTrue(app.otherElements["document-library"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.buttons["start-scan"].exists)
    XCTAssertTrue(app.buttons["import-photo"].exists)
    XCTAssertTrue(app.staticTexts["library-empty-title"].exists)
}
```

- [ ] **Step 3: Run the UI test and verify it fails because the target has no library root**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LibraryFlowUITests/testFirstLaunchShowsEmptyLibraryAndNewDocumentActions test`

Expected: test target builds, then fails because `document-library` does not exist.

- [ ] **Step 4: Implement the composition root and empty library**

```swift
@main
struct NitidocApp: App {
    @State private var container = AppContainer.preview

    var body: some Scene {
        WindowGroup {
            DocumentLibraryView(container: container)
        }
    }
}

struct DocumentLibraryView: View {
    let container: AppContainer

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("library-empty-title", systemImage: "doc.viewfinder")
                    .accessibilityIdentifier("library-empty-title")
            } description: {
                Text("library-empty-message")
                    .accessibilityIdentifier("library-empty-message")
            } actions: {
                Button("start-scan", action: container.startScan) .accessibilityIdentifier("start-scan")
                Button("import-photo", action: container.startPhotoImport) .accessibilityIdentifier("import-photo")
            }
        }
        .accessibilityIdentifier("document-library")
    }
}
```

Implement `AppContainer.preview` with closures that do nothing in this task; the next slices replace them with real routes.

- [ ] **Step 5: Run the target test and baseline build**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LibraryFlowUITests/testFirstLaunchShowsEmptyLibraryAndNewDocumentActions test`

Expected: PASS.

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'generic/platform=iOS' build`

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit the self-contained native shell**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): add native app shell"
```

### Task 2: Define the framework-free domain and service contracts

**Files:**
- Create: `ios-native/Nitidoc/Domain/DocumentModels.swift`
- Create: `ios-native/Nitidoc/Domain/EditRecipe.swift`
- Create: `ios-native/Nitidoc/Domain/PaperFormat.swift`
- Create: `ios-native/Nitidoc/Domain/ServiceProtocols.swift`
- Create: `ios-native/NitidocTests/RecipeTests.swift`
- Create: `ios-native/NitidocTests/PaperFormatTests.swift`

**Interfaces:**
- Consumes: the iOS 18 target from Task 1.
- Produces: `DocumentID`, `PageID`, `NormalizedPoint`, `CropQuad`, `EditRecipe`, `FilterPreset`, `FilterSelection`, `PaperFormat`, `PaperProvenance`, `PaperSelection`, `RenderPurpose`, `DocumentScanning`, `BorderDetecting`, `ImageRendering`, `DocumentRepository`, `PDFExporting`, and `StorageChecking`.

- [ ] **Step 1: Write failing pure-domain tests**

```swift
@Test func recipeRejectsCornersOutsideImmutableSource() throws {
    let invalid = CropQuad(topLeft: .init(x: -0.01, y: 0), topRight: .init(x: 1, y: 0),
                           bottomRight: .init(x: 1, y: 1), bottomLeft: .init(x: 0, y: 1))
    #expect(throws: RecipeValidationError.self) { try EditRecipe(crop: invalid) }
}

@Test func legalPaperUsesPhysicalPointsAndOriginalDoesNotClaimScale() {
    #expect(PaperFormat.legal.mediaBoxPoints == CGSize(width: 612, height: 1008))
    #expect(PaperFormat.original.mediaBoxPoints == nil)
}
```

- [ ] **Step 2: Run the focused domain tests and verify compilation fails**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/RecipeTests -only-testing:NitidocTests/PaperFormatTests test`

Expected: compile failure because the domain types do not exist.

- [ ] **Step 3: Implement immutable recipe and protocol signatures**

```swift
struct NormalizedPoint: Codable, Hashable, Sendable { let x: Double; let y: Double }
struct CropQuad: Codable, Hashable, Sendable {
    let topLeft: NormalizedPoint; let topRight: NormalizedPoint
    let bottomRight: NormalizedPoint; let bottomLeft: NormalizedPoint
    func validated() throws -> CropQuad
}

typealias DocumentID = UUID
typealias PageID = UUID

struct CapturedImage: @unchecked Sendable { let image: CGImage }
struct DocumentSummary: Identifiable, Sendable { let id: DocumentID; let title: String; let modifiedAt: Date; let pageCount: Int }
struct PageSnapshot: Identifiable, Sendable {
    let id: PageID; let order: Int; let sourceRelativePath: String
    let pixelSize: CGSize; let recipe: EditRecipe
}
struct DocumentSnapshot: Identifiable, Sendable { let id: DocumentID; let title: String; let state: DocumentState; let pages: [PageSnapshot] }
struct DocumentDraft: Identifiable, Sendable { let id: DocumentID; var title: String; var state: DocumentState; var pages: [PageSnapshot] }
struct IngestionRequest: Sendable { let title: String; let sources: [CapturedImage] }
struct FilterSelection: Codable, Hashable, Sendable { let preset: FilterPreset; let version: Int }
struct LocalizedErrorMessage: Equatable, Sendable { let key: String; let recoveryKey: String }
struct RenderRequest: Sendable { let page: PageSnapshot; let sourceURL: URL; let recipe: EditRecipe }
struct RenderedImage: @unchecked Sendable { let image: CGImage; let pixelWidth: Int; let pixelHeight: Int; let recipeFingerprint: String }
struct ExportedPDF: Equatable, Sendable { let url: URL }
struct ExpectedPDF: Sendable { let pageCount: Int; let mediaBoxes: [CGRect] = [] }
enum RenderPurpose: Sendable { case preview(maximumPixelSize: Int), thumbnail(maximumPixelSize: Int), export }
enum DocumentState: String, Codable, Sendable { case draft, saved }
enum CaptureError: Error, Sendable { case cancelled, unavailable, failed }
enum CropCorner: CaseIterable, Sendable { case topLeft, topRight, bottomRight, bottomLeft }
enum EditorResult: Equatable, Sendable { case confirmed(EditRecipe), cancelled }
enum PaperProvenance: String, Codable, Hashable, Sendable { case automatic, probable, manual }
struct PaperSelection: Codable, Hashable, Sendable { let format: PaperFormat; let provenance: PaperProvenance }

struct EditRecipe: Codable, Hashable, Sendable {
    var crop: CropQuad
    var rotation: QuarterTurn
    var filter: FilterSelection
    var paper: PaperSelection
    init(crop: CropQuad = .unitSquare, rotation: QuarterTurn = .zero,
         filter: FilterSelection = .original, paper: PaperSelection = .automaticOriginal) throws
}

protocol DocumentRepository: Sendable {
    func ingest(_ request: IngestionRequest) async throws -> DocumentSnapshot
    func load(id: DocumentID) async throws -> DocumentSnapshot
    func list() async throws -> [DocumentSummary]
    func save(_ draft: DocumentDraft) async throws
    func deletePage(documentID: DocumentID, pageID: PageID) async throws
}
```

Define `FilterPreset` with exactly six cases, `QuarterTurn` with cases `zero`, `ninety`, `oneEighty`, and `twoSeventy` whose raw degree values are `0`, `90`, `180`, and `270`, and paper definitions in PDF points: A4 `595×842`, Letter `612×792`, Legal `612×1008`; Ticket and Original return `nil` for `mediaBoxPoints`. Define `FilterSelection.original`, `PaperSelection.automaticOriginal`, `CropQuad.unitSquare`, `DocumentScanning.scan() async throws -> [CapturedImage]`, `BorderDetecting.detect(in:) async throws -> CropQuad?`, `ImageRendering.render(_:purpose:) async throws -> RenderedImage`, `PDFExporting.export(_ document: DocumentSnapshot) async throws -> ExportedPDF`, and `StorageChecking.requireAvailableBytes(_ bytes: Int64) async throws`.

- [ ] **Step 4: Run the focused domain tests**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/RecipeTests -only-testing:NitidocTests/PaperFormatTests test`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract boundary**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): define scanner domain contracts"
```

## Milestone 2 — system scan begins and completes safely

### Task 3: Wrap VisionKit behind the capture protocol

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/VisionKit/VisionKitDocumentScanner.swift`
- Create: `ios-native/Nitidoc/Infrastructure/VisionKit/DocumentScannerSheet.swift`
- Create: `ios-native/Nitidoc/Features/Capture/CaptureCoordinator.swift`
- Create: `ios-native/NitidocTests/CaptureCoordinatorTests.swift`
- Create: `ios-native/NitidocUITests/CaptureEntryUITests.swift`

**Interfaces:**
- Consumes: `DocumentScanning`, `CapturedImage`, and `DocumentLibraryView` from Tasks 1–2.
- Produces: `VisionKitDocumentScanner`, `DocumentScannerSheet`, `@MainActor CaptureCoordinator`, and `CaptureState`.

- [ ] **Step 1: Write fake-driven capture outcome tests**

```swift
@Test @MainActor func scannerCancellationReturnsToLibraryWithoutIngestion() async {
    let scanner = FakeDocumentScanner(result: .failure(CaptureError.cancelled))
    let coordinator = CaptureCoordinator(scanner: scanner, onPages: { _ in Issue.record("must not ingest") })

    await coordinator.start()

    #expect(coordinator.state == .idle)
    #expect(coordinator.lastError == nil)
}

@Test @MainActor func scannerFailureOffersPhotoImportFallback() async {
    let scanner = FakeDocumentScanner(result: .failure(CaptureError.unavailable))
    let coordinator = CaptureCoordinator(scanner: scanner, onPages: { _ in })

    await coordinator.start()

    #expect(coordinator.state == .offerPhotoImport)
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/CaptureCoordinatorTests test`

Expected: compile failure because `CaptureCoordinator` and the fake seam are absent.

- [ ] **Step 3: Implement the VisionKit bridge and outcome mapping**

```swift
@MainActor
final class VisionKitDocumentScanner: NSObject, DocumentScanning {
    func scan() async throws -> [CapturedImage]
}

struct DocumentScannerSheet: UIViewControllerRepresentable {
    let scanner: VisionKitDocumentScanner
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}
}

@MainActor
final class CaptureCoordinator: ObservableObject {
    enum State: Equatable { case idle, scanning, offerPhotoImport, failed(LocalizedErrorMessage) }
    @Published private(set) var state: State = .idle
    @Published private(set) var lastError: LocalizedErrorMessage?
    func start() async
}
```

The coordinator maps `VNDocumentCameraViewControllerDelegate.documentCameraViewControllerDidCancel` to `CaptureError.cancelled` and leaves state `.idle`. It copies every VisionKit page into `CapturedImage` in memory only; persistence begins in Task 4. Map unavailable presentation and scanner failures to localized fallback UI, not a crash. Keep the delegate continuation single-resume and dismiss the scanner before publishing state.

- [ ] **Step 4: Connect the library scan button and test entry behavior**

```swift
func testScanEntryPresentsSystemScannerOrInjectedFake() {
    let app = XCUIApplication()
    app.launchArguments = ["-useFakeScanner", "YES", "-fakeScannerOutcome", "cancelled"]
    app.launch()
    app.buttons["start-scan"].tap()
    XCTAssertTrue(app.otherElements["document-library"].waitForExistence(timeout: 2))
}
```

Route `AppContainer.startScan` through `CaptureCoordinator`; in UI tests, inject `FakeDocumentScanner` from launch arguments rather than attempting to automate VisionKit.

- [ ] **Step 5: Run focused unit and UI tests**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/CaptureCoordinatorTests -only-testing:NitidocUITests/CaptureEntryUITests test`

Expected: PASS.

- [ ] **Step 6: Commit system-scanner entry and safe outcomes**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): add VisionKit capture adapter"
```

## Milestone 3 — transactional ingestion and durable local library

### Task 4: Persist draft metadata and immutable private sources transactionally

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/Persistence/SwiftDataModels.swift`
- Create: `ios-native/Nitidoc/Infrastructure/Persistence/PrivateImageStore.swift`
- Create: `ios-native/Nitidoc/Infrastructure/Persistence/LocalDocumentRepository.swift`
- Create: `ios-native/Nitidoc/Infrastructure/Persistence/StorageCapacityChecker.swift`
- Create: `ios-native/NitidocTests/LocalDocumentRepositoryTests.swift`
- Create: `ios-native/NitidocTests/PrivateImageStoreTests.swift`

**Interfaces:**
- Consumes: `IngestionRequest`, `DocumentSnapshot`, `DocumentRepository`, `StorageChecking`, `EditRecipe`, and `CapturedImage` from Tasks 2–3.
- Produces: `@Model final class DocumentRecord`, `@Model final class PageRecord`, `actor PrivateImageStore`, and `@ModelActor actor LocalDocumentRepository`.

- [ ] **Step 1: Write isolated-store transaction tests**

```swift
@Test func failedSecondPageLeavesNoDraftOrFiles() async throws {
    let harness = try RepositoryHarness.makeFailingOnWrite(number: 2)
    let request = IngestionRequest(title: "Receipt", sources: [fixture("one"), fixture("two")])

    await #expect(throws: IngestionError.self) { try await harness.repository.ingest(request) }

    #expect(try await harness.repository.list().isEmpty)
    #expect(try harness.applicationSupportChildren().isEmpty)
    #expect(try harness.temporaryChildren().isEmpty)
}

@Test func ingestionNormalizesOnceAndKeepsRecipeSeparateFromSource() async throws {
    let harness = try RepositoryHarness.make()
    let document = try await harness.repository.ingest(.init(title: "Invoice", sources: [fixture("rotated")]))

    #expect(document.pages[0].sourceRelativePath.hasSuffix(".heic") || document.pages[0].sourceRelativePath.hasSuffix(".jpg"))
    #expect(document.pages[0].recipe == try EditRecipe())
}
```

- [ ] **Step 2: Run the repository tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/LocalDocumentRepositoryTests -only-testing:NitidocTests/PrivateImageStoreTests test`

Expected: compile failure because the SwiftData models and image store do not exist.

- [ ] **Step 3: Implement storage model and all-or-nothing ingestion**

```swift
@Model final class DocumentRecord {
    @Attribute(.unique) var id: UUID
    var title: String
    var createdAt: Date
    var modifiedAt: Date
    var stateRawValue: String
    @Relationship(deleteRule: .cascade, inverse: \PageRecord.document) var pages: [PageRecord]
}

@Model final class PageRecord {
    @Attribute(.unique) var id: UUID
    var order: Int
    var sourceRelativePath: String
    var pixelWidth: Int
    var pixelHeight: Int
    var orientationRawValue: Int
    var recipeData: Data
    var document: DocumentRecord?
}

actor PrivateImageStore {
    func beginIngestion() throws -> URL
    func normalizeAndWrite(_ image: CGImage, to transaction: URL, pageID: PageID) async throws -> StoredSource
    func commit(_ transaction: URL, documentID: DocumentID) throws
    func removeDocument(_ id: DocumentID) throws
    func cleanup(_ transaction: URL) throws
}
```

`LocalDocumentRepository.ingest` must: reject empty or more-than-30 input; call `StorageChecking.requireAvailableBytes`; create a random temporary directory; normalize and validate every source (decodable, positive dimensions, writable encoding); insert SwiftData metadata only after file validation; move the transaction into `Application Support/Nitidoc/Documents/<document-id>/`; save the context; and remove the transaction plus any partially committed directory on every error or cancellation. Persist `EditRecipe` with `JSONEncoder` in `recipeData`; do not store `CGImage`, `UIImage`, blobs, or thumbnails in SwiftData.

Define `StoredSource` in this task as `struct StoredSource: Sendable { let relativePath: String; let pixelWidth: Int; let pixelHeight: Int; let orientation: Int }`. Implement `LocalDocumentRepository` as a SwiftData model actor, not a class, so repository serialization is compatible with the `@ModelActor` macro and does not run on the main actor.

- [ ] **Step 4: Run repository tests plus whole unit target**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/LocalDocumentRepositoryTests -only-testing:NitidocTests/PrivateImageStoreTests test`

Expected: PASS.

- [ ] **Step 5: Commit transactional local persistence**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): persist document drafts transactionally"
```

### Task 5: Make completed scans create and reopen a local draft library item

**Files:**
- Modify: `ios-native/Nitidoc/App/AppContainer.swift`
- Modify: `ios-native/Nitidoc/Features/Documents/DocumentLibraryView.swift`
- Modify: `ios-native/Nitidoc/Features/Capture/CaptureCoordinator.swift`
- Create: `ios-native/Nitidoc/Features/Documents/DocumentLibraryModel.swift`
- Create: `ios-native/Nitidoc/Features/Documents/DocumentRow.swift`
- Create: `ios-native/NitidocUITests/LocalLibraryUITests.swift`

**Interfaces:**
- Consumes: `DocumentRepository.ingest(_:)`, `DocumentRepository.list()`, and `CaptureCoordinator`.
- Produces: `@MainActor DocumentLibraryModel.refresh() async`, `DocumentLibraryModel.ingestScan(_:) async`, and library rows sorted by `modifiedAt` descending.

- [ ] **Step 1: Write the completed-scan library UI test**

```swift
func testCompletedFakeScanCreatesDraftVisibleAfterRelaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-resetPersistentStore", "YES", "-useFakeScanner", "YES", "-fakeScannerOutcome", "one-page"]
    app.launch()
    app.buttons["start-scan"].tap()
    XCTAssertTrue(app.cells["document-row-0"].waitForExistence(timeout: 3))

    app.terminate()
    app.launch()
    XCTAssertTrue(app.cells["document-row-0"].waitForExistence(timeout: 3))
}
```

- [ ] **Step 2: Run the UI test and verify it fails**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LocalLibraryUITests/testCompletedFakeScanCreatesDraftVisibleAfterRelaunch test`

Expected: FAIL because completed capture has no repository handoff or row.

- [ ] **Step 3: Implement scan-to-draft routing and ordered local history**

```swift
@MainActor
@Observable final class DocumentLibraryModel {
    private(set) var documents: [DocumentSummary] = []
    func refresh() async
    func ingestScan(_ pages: [CapturedImage]) async -> DocumentID?
    func open(_ id: DocumentID)
}
```

On a successful capture, construct `IngestionRequest(title: localizedDefaultDocumentTitle(), sources: pages)`, persist it, refresh the list, and navigate directly to the review route introduced in Task 6. On persistence failure, retain the existing library, show the localized actionable error, and do not create an empty row. Query only metadata for the list, order by `modifiedAt` descending, and load thumbnails asynchronously from Caches or regenerate them without embedding original pixels in the list.

- [ ] **Step 4: Run the persistence UI test and all unit tests**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LocalLibraryUITests test`

Expected: PASS.

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests test`

Expected: PASS.

- [ ] **Step 5: Commit the first durable scan slice**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): show captured drafts in local library"
```

## Milestone 4 — complete multipage review lifecycle

### Task 6: Add review, title editing, page order, and auto-save

**Files:**
- Create: `ios-native/Nitidoc/Features/Review/DocumentReviewView.swift`
- Create: `ios-native/Nitidoc/Features/Review/DocumentReviewModel.swift`
- Create: `ios-native/Nitidoc/Features/Review/PageThumbnailView.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/Persistence/LocalDocumentRepository.swift`
- Create: `ios-native/NitidocTests/DocumentReviewModelTests.swift`
- Create: `ios-native/NitidocUITests/ReviewLifecycleUITests.swift`

**Interfaces:**
- Consumes: `DocumentRepository.load(id:)`, `DocumentRepository.save(_:)`, `DocumentDraft`, and document rows from Task 5.
- Produces: `DocumentReviewModel.movePages(from:to:)`, `rename(to:)`, `leaveReview() async`, and an explicit `PageMoveAction` accessible reorder API.

- [ ] **Step 1: Write page ordering and auto-save tests**

```swift
@Test @MainActor func moveReindexesEveryPageAndSavesDraft() async throws {
    let repository = FakeDocumentRepository(document: .threePages)
    let model = DocumentReviewModel(documentID: .threePages.id, repository: repository)
    try await model.load()

    model.movePages(from: IndexSet(integer: 0), to: 3)
    await model.leaveReview()

    #expect(repository.savedDraft?.pages.map(\.order) == [0, 1, 2])
    #expect(repository.savedDraft?.pages.map(\.id) == [.page2, .page3, .page1])
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/DocumentReviewModelTests test`

Expected: compile failure because the review model is absent.

- [ ] **Step 3: Implement review presentation and persistence boundary**

```swift
@MainActor
@Observable final class DocumentReviewModel {
    private(set) var document: DocumentDraft?
    func load() async throws
    func rename(to title: String)
    func movePages(from offsets: IndexSet, to destination: Int)
    func perform(_ action: PageMoveAction)
    func leaveReview() async
}

enum PageMoveAction: CaseIterable, Sendable { case moveEarlier, moveLater }
```

Use `List`/`ForEach` move support for drag reordering and expose per-page VoiceOver custom actions named from localized `move-page-earlier` and `move-page-later`. On every order mutation, create a newly ordered `DocumentDraft` with dense `0...n-1` integer orders. `leaveReview()` saves any nonempty draft and returns to the local library. Preserve the document when saving fails and expose retry; never delete a document merely because auto-save failed.

- [ ] **Step 4: Write and run the review UI flow test**

```swift
func testReviewAllowsRenameAndAccessibleReorder() {
    let app = XCUIApplication()
    app.launchArguments = ["-seedDocument", "three-pages"]
    app.launch()
    app.cells["document-row-0"].tap()
    app.textFields["document-title"].tap()
    app.textFields["document-title"].typeText("Travel receipts")
    app.buttons["page-0-move-later"].tap()
    app.navigationBars.buttons["library-back"].tap()
    XCTAssertTrue(app.cells["document-row-0"].waitForExistence(timeout: 2))
}
```

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/DocumentReviewModelTests -only-testing:NitidocUITests/ReviewLifecycleUITests test`

Expected: PASS.

- [ ] **Step 5: Commit multipage review and auto-save**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): add multipage document review"
```

### Task 7: Add, replace, delete, and clean up review pages with the 30-page guard

**Files:**
- Modify: `ios-native/Nitidoc/Features/Review/DocumentReviewModel.swift`
- Modify: `ios-native/Nitidoc/Features/Review/DocumentReviewView.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/Persistence/LocalDocumentRepository.swift`
- Create: `ios-native/NitidocTests/PageLifecycleTests.swift`
- Create: `ios-native/NitidocUITests/PageLifecycleUITests.swift`

**Interfaces:**
- Consumes: `DocumentScanning.scan()`, `DocumentRepository.deletePage(documentID:pageID:)`, `IngestionRequest`, and `DocumentReviewModel`.
- Produces: `addScanPages(_:) async`, `replace(pageID:with:) async`, `requestDelete(pageID:)`, and `confirmDelete() async`.

- [ ] **Step 1: Write lifecycle and page-cap tests**

```swift
@Test @MainActor func addingAtThirtyShowsCapAndDoesNotStartScanner() async throws {
    let scanner = FakeDocumentScanner(result: .success([fixture("one")]))
    let model = DocumentReviewModel(documentID: .thirtyPages.id, repository: .thirtyPages, scanner: scanner)

    await model.startAddScan()

    #expect(scanner.callCount == 0)
    #expect(model.alert == .pageLimitReached(limit: 30))
}

@Test func deletingPageRemovesMetadataSourceThumbnailAndCache() async throws {
    let harness = try RepositoryHarness.make(document: .onePage)
    try await harness.repository.deletePage(documentID: .onePage.id, pageID: .page1)
    #expect(try harness.allManagedFiles().isEmpty)
}
```

- [ ] **Step 2: Run focused lifecycle tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PageLifecycleTests test`

Expected: compile failure because the lifecycle commands do not exist.

- [ ] **Step 3: Implement atomic page lifecycle operations**

```swift
extension DocumentReviewModel {
    func startAddScan() async
    func replace(pageID: PageID, with source: CapturedImage) async
    func requestDelete(pageID: PageID)
    func confirmDelete() async
}
```

Check capacity before presenting VisionKit and before repository commit. For replacement, write and validate the new source inside its own temporary directory, persist the page record pointing to it, then remove the old source and caches only after metadata save succeeds. For deletion, show a localized confirmation that includes the page ordinal; delete the SwiftData page relationship and every managed source/thumbnail/cache in one recoverable repository operation. Reject deletion of the last page by returning to the library after document-level confirmation rather than retaining an empty draft.

- [ ] **Step 4: Run focused tests and UI add/replace/delete flow**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PageLifecycleTests -only-testing:NitidocUITests/PageLifecycleUITests test`

Expected: PASS.

- [ ] **Step 5: Commit page lifecycle coverage**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): manage review page lifecycle"
```

## Milestone 5 — imported photos and non-destructive editor

### Task 8: Import a photo and obtain a Vision crop proposal with full-frame fallback

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/Vision/VisionBorderDetector.swift`
- Create: `ios-native/Nitidoc/Features/Import/PhotoImportCoordinator.swift`
- Create: `ios-native/Nitidoc/Features/Import/PhotoImportView.swift`
- Modify: `ios-native/Nitidoc/App/AppContainer.swift`
- Create: `ios-native/NitidocTests/VisionBorderDetectorTests.swift`
- Create: `ios-native/NitidocTests/PhotoImportCoordinatorTests.swift`
- Create: `ios-native/Nitidoc/Resources/Fixtures/manifest.json`

**Interfaces:**
- Consumes: `BorderDetecting`, `CapturedImage`, `CropQuad`, `DocumentReviewModel`, and `DocumentRepository`.
- Produces: `VisionBorderDetector.detect(in:)`, `PhotoImportCoordinator.load(_:) async`, `PhotoImportCoordinator.State.ready(_:)`, `ImportedPageDraft`, `PhotoImportInput`, and `DetectionState`.

- [ ] **Step 1: Add approved fixture manifest and failing proposal tests**

Create `manifest.json` with named local fixtures for bright paper, low contrast, shadow, similar background, skew, and dense text. Do not copy customer documents into the repository. Then write:

```swift
@Test func noSegmentationResultUsesUnitSquare() async throws {
    let detector = FakeBorderDetector(result: nil)
    let coordinator = PhotoImportCoordinator(detector: detector)

    let state = try await coordinator.load(fixture("similar-background"))

    #expect(state.recipe.crop == .unitSquare)
    #expect(state.detection == .notFound)
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/VisionBorderDetectorTests -only-testing:NitidocTests/PhotoImportCoordinatorTests test`

Expected: compile failure because the Vision adapter and import coordinator are absent.

- [ ] **Step 3: Implement PhotosPicker transfer and Vision request adapter**

```swift
actor VisionBorderDetector: BorderDetecting {
    func detect(in source: CapturedImage) async throws -> CropQuad?
}

@MainActor
@Observable final class PhotoImportCoordinator {
    enum State { case idle, loading, ready(ImportedPageDraft), failed(LocalizedErrorMessage) }
    private(set) var state: State = .idle
    func load(_ input: PhotoImportInput) async throws -> ImportedPageDraft
}

enum DetectionState: Equatable, Sendable { case found, notFound }
struct ImportedPageDraft: Sendable { let source: CapturedImage; let recipe: EditRecipe; let detection: DetectionState }
enum PhotoImportInput { case photosPickerItem(PhotosPickerItem), fixture(name: String, url: URL) }
```

Use `PhotosPicker` and `Transferable` data loading to copy the selected full source into a task-specific temporary directory before calling Vision. Implement Vision's iOS 18 `DetectDocumentSegmentationRequest` in `VisionBorderDetector`, convert its image-space quadrilateral to validated normalized coordinates, and return `nil` for no observation, malformed geometry, or cancellation. Seed `EditRecipe.crop` with the detected quad only when valid; otherwise use `.unitSquare`. Send either result to Task 9’s editor before committing to the review document. Tests use `PhotoImportInput.fixture`; production uses `PhotoImportInput.photosPickerItem`.

- [ ] **Step 4: Run Vision integration tests on supported simulator and fake tests everywhere**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/VisionBorderDetectorTests -only-testing:NitidocTests/PhotoImportCoordinatorTests test`

Expected: PASS; fixture tests assert geometry tolerance, not exact compressed pixels.

- [ ] **Step 5: Commit imported-photo detection**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): detect borders for imported photos"
```

### Task 9: Build the pending-recipe editor with bounded corners, rotation, and paper choice

**Files:**
- Create: `ios-native/Nitidoc/Features/Editor/PageEditorModel.swift`
- Create: `ios-native/Nitidoc/Features/Editor/PageEditorView.swift`
- Create: `ios-native/Nitidoc/Features/Editor/CropOverlayView.swift`
- Create: `ios-native/Nitidoc/Features/Editor/PaperFormatPicker.swift`
- Create: `ios-native/NitidocTests/PageEditorModelTests.swift`
- Create: `ios-native/NitidocUITests/PageEditorUITests.swift`

**Interfaces:**
- Consumes: `EditRecipe`, `CropQuad.validated()`, `PaperSelection`, `DocumentReviewModel`, and `ImportedPageDraft`.
- Produces: `PageEditorModel.confirm()`, `cancel()`, `resetCrop()`, `rotateClockwise()`, `setPaper(_:)`, and `updateCorner(_:to:)`.

- [ ] **Step 1: Write pending-edit semantics tests**

```swift
@Test @MainActor func cancelRestoresSavedRecipeExactly() throws {
    let saved = try EditRecipe(crop: .unitSquare)
    let model = PageEditorModel(source: fixture("page"), savedRecipe: saved, allowsRedetection: false)
    try model.updateCorner(.topLeft, to: .init(x: 0.2, y: 0.1))
    model.rotateClockwise()

    model.cancel()

    #expect(model.result == .cancelled)
    #expect(model.savedRecipe == saved)
}

@Test @MainActor func cornerOutsideSourceIsRejected() throws {
    let model = PageEditorModel(source: fixture("page"), savedRecipe: try EditRecipe(), allowsRedetection: false)
    #expect(throws: RecipeValidationError.self) { try model.updateCorner(.bottomRight, to: .init(x: 1.2, y: 1)) }
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PageEditorModelTests test`

Expected: compile failure because the editor model is absent.

- [ ] **Step 3: Implement draft-only edits and corner accessibility**

```swift
@MainActor
@Observable final class PageEditorModel {
    private(set) var savedRecipe: EditRecipe
    var pendingRecipe: EditRecipe
    private(set) var result: EditorResult?
    func updateCorner(_ corner: CropCorner, to point: NormalizedPoint) throws
    func resetCrop()
    func rotateClockwise()
    func setPaper(_ selection: PaperSelection)
    func confirm() throws -> EditRecipe
    func cancel()
}
```

Render four handles over a downsampled preview. Convert gestures into normalized source coordinates and validate every changed quadrilateral before assigning `pendingRecipe`. The reset action uses `.unitSquare` for VisionKit sources; imported photos expose `redetect()` and only replace the pending crop after validated Vision output. Give each handle a VoiceOver value describing its normalized position and adjustable increment/decrement actions. Manual paper selection sets provenance `.manual`; ratio-based suggestion sets `.probable` and cannot claim physical scale. `confirm()` returns a new recipe; only the review model persists it.

- [ ] **Step 4: Add UI proof for cancel, paper format, and non-drag actions**

```swift
func testEditorCancelDoesNotPersistAndConfirmDoes() {
    let app = XCUIApplication()
    app.launchArguments = ["-seedDocument", "one-page"]
    app.launch()
    app.cells["document-row-0"].tap()
    app.buttons["page-0-edit"].tap()
    app.buttons["paper-legal"].tap()
    app.buttons["editor-cancel"].tap()
    XCTAssertFalse(app.staticTexts["paper-legal-selected"].exists)
}
```

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PageEditorModelTests -only-testing:NitidocUITests/PageEditorUITests test`

Expected: PASS.

- [ ] **Step 5: Commit the non-destructive editor foundation**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): add non-destructive page editor"
```

## Milestone 6 — calibrated native filter parity

### Task 10: Add a single full-resolution renderer and downsampled preview renderer

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/Imaging/ImageRenderer.swift`
- Create: `ios-native/Nitidoc/Infrastructure/Imaging/FilterParameters.swift`
- Create: `ios-native/Nitidoc/Infrastructure/Imaging/ThumbnailRenderer.swift`
- Create: `ios-native/NitidocTests/ImageRendererTests.swift`
- Create: `ios-native/NitidocTests/ImageFixtureComparisonTests.swift`

**Interfaces:**
- Consumes: immutable source files, `EditRecipe`, `ImageRendering`, `RenderPurpose`, and fixture manifest from Task 8.
- Produces: `CoreImageRenderer.render(_:purpose:)` and `ImageDifference` tolerance checks.

- [ ] **Step 1: Write recipe-order and preview/export source tests**

```swift
@Test func rendererAppliesPerspectiveRotationFilterAndScaleInOrder() async throws {
    let renderer = CoreImageRenderer()
    let trace = try await renderer.debugOperationTrace(source: fixture("skew"), recipe: .fixture)
    #expect(trace == [.decodeAndNormalize, .perspective, .rotation, .filter, .scale])
}

@Test func previewAndExportUseSameRecipeButDifferentDecodeScale() async throws {
    let renderer = CoreImageRenderer()
    let preview = try await renderer.render(.fixture, purpose: .preview(maximumPixelSize: 1600))
    let export = try await renderer.render(.fixture, purpose: .export)
    #expect(preview.recipeFingerprint == export.recipeFingerprint)
    #expect(preview.pixelWidth < export.pixelWidth)
}
```

- [ ] **Step 2: Run the renderer tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/ImageRendererTests -only-testing:NitidocTests/ImageFixtureComparisonTests test`

Expected: compile failure because `CoreImageRenderer` is absent.

- [ ] **Step 3: Implement deterministic decode, recipe pipeline, and cache policy**

```swift
actor CoreImageRenderer: ImageRendering {
    func render(_ request: RenderRequest, purpose: RenderPurpose) async throws -> RenderedImage
    func invalidateCaches(for pageID: PageID) async
}
```

Use ImageIO for source decode and orientation normalization, `CIPerspectiveCorrection` for the normalized crop quad, Core Image affine transform for the quarter turn, and a final aspect-preserving scale into the requested destination. Store preview and thumbnail outputs only below `Caches/Nitidoc/`; key caches by source identifier plus canonical JSON recipe digest and render purpose. `Task.checkCancellation()` before decode, before each expensive filter, and before write; discard `CGImage`/`CIContext` intermediates as each page completes.

- [ ] **Step 4: Run renderer tests**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/ImageRendererTests -only-testing:NitidocTests/ImageFixtureComparisonTests test`

Expected: PASS.

- [ ] **Step 5: Commit the shared render path**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): render recipes with native image pipeline"
```

### Task 11: Implement all six filters, calibrate fixtures, and expose instant previews

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/Imaging/VImageFilterProcessor.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/Imaging/ImageRenderer.swift`
- Create: `ios-native/Nitidoc/Features/Editor/FilterPicker.swift`
- Modify: `ios-native/Nitidoc/Features/Editor/PageEditorModel.swift`
- Modify: `ios-native/Nitidoc/Features/Editor/PageEditorView.swift`
- Create: `ios-native/NitidocTests/FilterParameterTests.swift`
- Create: `ios-native/NitidocTests/FilterParityFixtureTests.swift`

**Interfaces:**
- Consumes: `FilterPreset`, `FilterSelection`, `CoreImageRenderer`, and fixture manifest.
- Produces: `FilterParameters.parameters(for:)`, `VImageFilterProcessor.apply(_:preset:)`, and `PageEditorModel.setFilter(_:)`.

- [ ] **Step 1: Write filter catalog and fixture-tolerance tests**

```swift
@Test(arguments: FilterPreset.allCases) func everyPresetHasVersionedParameters(_ preset: FilterPreset) {
    #expect(FilterParameters.parameters(for: preset).version == 1)
}

@Test(arguments: FilterPreset.allCases) func presetMatchesReferenceWithinDocumentTolerance(_ preset: FilterPreset) async throws {
    let actual = try await renderFixture("low-contrast", preset: preset)
    let reference = try fixtureReference("low-contrast", preset: preset)
    #expect(ImageDifference(actual, reference).meanAbsoluteLumaError < 0.035)
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/FilterParameterTests -only-testing:NitidocTests/FilterParityFixtureTests test`

Expected: compile failure because no filter processor or catalog exists.

- [ ] **Step 3: Implement the six preset routes without mutating source pixels**

```swift
enum FilterPreset: String, Codable, CaseIterable, Sendable {
    case original, enhanced, grayscale, blackAndWhite, blackAndWhiteHighContrast, eco
}

actor VImageFilterProcessor {
    func apply(_ image: CGImage, preset: FilterPreset) async throws -> CGImage
}
```

Original returns the corrected image unchanged. Enhanced uses deterministic Core Image brightness/contrast/sharpening parameters. Grayscale uses a fixed luminance transform. Black and white and high contrast use vImage grayscale plus adaptive threshold parameters versioned in `FilterParameters`. Eco uses the calibrated light-ink curve. Keep parameter values in one `Codable` catalog associated with recipe `FilterSelection.version`; a missing future version falls back to Original with a localized retry action and preserves the stored source and recipe. Generate native reference images from the approved fixtures, record the tolerance and fixture version in `ios-native/docs/filter-calibration.md`, and never compare JPEG byte equality.

- [ ] **Step 4: Wire the picker to the pending recipe and run test suite**

```swift
extension PageEditorModel {
    func setFilter(_ filter: FilterSelection) { pendingRecipe.filter = filter }
}
```

The picker requests `.preview(maximumPixelSize: 1600)` through the same renderer, debounces rapid selection changes, cancels stale tasks, and identifies the selected preset with VoiceOver value. Confirm persists the recipe only; export renders from full resolution in Task 12.

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/FilterParameterTests -only-testing:NitidocTests/FilterParityFixtureTests -only-testing:NitidocUITests/PageEditorUITests test`

Expected: PASS.

- [ ] **Step 5: Commit filter parity slice**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): add calibrated document filters"
```

## Milestone 7 — physical PDF export with independent validation

### Task 12: Export validated, non-distorted PDFs sequentially

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/PDF/CoreGraphicsPDFExporter.swift`
- Create: `ios-native/Nitidoc/Infrastructure/PDF/PDFValidator.swift`
- Create: `ios-native/Nitidoc/Features/Export/ExportCoordinator.swift`
- Create: `ios-native/Nitidoc/Features/Export/ExportProgressView.swift`
- Modify: `ios-native/Nitidoc/Features/Review/DocumentReviewView.swift`
- Create: `ios-native/NitidocTests/PDFExportTests.swift`
- Create: `ios-native/NitidocTests/PDFValidatorTests.swift`
- Create: `ios-native/NitidocUITests/ExportFlowUITests.swift`

**Interfaces:**
- Consumes: `PDFExporting`, `StorageChecking`, `ImageRendering`, `DocumentSnapshot`, `PaperFormat`, and `DocumentReviewModel`.
- Produces: `CoreGraphicsPDFExporter.export(_:)`, `PDFValidator.validate(url:expected:)`, and `ExportCoordinator.export(documentID:) async`.

- [ ] **Step 1: Write paper geometry, order, and failure-isolation tests**

```swift
@Test func exportPreservesOrderAndPhysicalA4MediaBox() async throws {
    let url = try await exporter.export(.fixtureDocument(formats: [.a4, .letter]))
    let pdf = try PDFValidator().validate(url: url, expected: .init(pageCount: 2))
    #expect(pdf.pages[0].mediaBox == CGRect(x: 0, y: 0, width: 595, height: 842))
    #expect(pdf.pages[1].mediaBox == CGRect(x: 0, y: 0, width: 612, height: 792))
}

@Test func failedExportDoesNotModifyEditableDraft() async throws {
    let repository = FakeDocumentRepository(document: .onePage)
    let exporter = FailingPDFExporter()
    let coordinator = ExportCoordinator(repository: repository, exporter: exporter)
    await coordinator.export(documentID: .onePage.id)
    #expect(repository.saveCallCount == 0)
}
```

- [ ] **Step 2: Run focused PDF tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PDFExportTests -only-testing:NitidocTests/PDFValidatorTests test`

Expected: compile failure because the exporter and validator do not exist.

- [ ] **Step 3: Implement sequential temporary PDF production and validation**

```swift
actor CoreGraphicsPDFExporter: PDFExporting {
    func export(_ document: DocumentSnapshot) async throws -> ExportedPDF
}

struct PDFValidator {
    func validate(url: URL, expected: ExpectedPDF) throws -> ValidatedPDF
}

struct ValidatedPDF: Sendable { let pages: [ValidatedPDFPage] }
struct ValidatedPDFPage: Sendable { let index: Int; let mediaBox: CGRect }
```

Before writing, calculate the required free-space estimate and call `StorageChecking.requireAvailableBytes`. Make one random temporary export directory, render pages one at a time in stable `order`, and release every rendered image before continuing. Use Core Graphics page boxes in points for A4, Letter, and Legal; orient the box without distortion. For Ticket and Original, derive a page box from raster aspect ratio through a documented 72-points-per-inch fallback and center the image without stretching. Close the context, reopen with PDFKit, validate page count, order markers from test fixtures, and MediaBoxes before publishing `ExportedPDF`. On error or cancellation remove the temporary directory and leave the editable draft untouched.

- [ ] **Step 4: Add explicit system sharing and Files handoff**

```swift
@MainActor
@Observable final class ExportCoordinator {
    enum State: Equatable { case idle, preparing, rendering(completed: Int, total: Int), ready(ExportedPDF), failed(LocalizedErrorMessage) }
    private(set) var state: State = .idle
    func export(documentID: DocumentID) async
    func consumePublishedFile() async
}
```

Present `UIActivityViewController` only after `PDFValidator` succeeds. Keep the resulting temporary file alive until the share controller’s completion handler, then remove it whether the user completes or cancels. Provide a Files destination through the system share sheet; do not add custom cloud or network destinations.

- [ ] **Step 5: Run PDF tests and export UI fake test**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/PDFExportTests -only-testing:NitidocTests/PDFValidatorTests -only-testing:NitidocUITests/ExportFlowUITests test`

Expected: PASS.

- [ ] **Step 6: Commit validated PDF export**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): export validated multipage PDFs"
```

## Milestone 8 — release-quality localization, resilience, and parity evidence

### Task 13: Finish localization and accessibility across native-owned screens

**Files:**
- Modify: `ios-native/Nitidoc/Resources/Localizable.xcstrings`
- Modify: `ios-native/Nitidoc/Features/Documents/DocumentLibraryView.swift`
- Modify: `ios-native/Nitidoc/Features/Review/DocumentReviewView.swift`
- Modify: `ios-native/Nitidoc/Features/Editor/PageEditorView.swift`
- Modify: `ios-native/Nitidoc/Features/Export/ExportProgressView.swift`
- Create: `ios-native/NitidocUITests/LocalizationAccessibilityUITests.swift`
- Create: `ios-native/Nitidoc/docs/accessibility-audit.md`

**Interfaces:**
- Consumes: accessibility identifiers and localization keys from Tasks 1–12.
- Produces: Spanish and English string entries, Dynamic Type layouts, VoiceOver custom actions, and an audit record tied to UI tests.

- [ ] **Step 1: Write English, Spanish, Dynamic Type, and VoiceOver action tests**

```swift
func testSpanishLibraryAndAccessiblePageMoveAction() {
    let app = XCUIApplication()
    app.launchArguments = ["-AppleLanguages", "(es)", "-AppleLocale", "es_AR", "-seedDocument", "three-pages"]
    app.launch()
    XCTAssertTrue(app.buttons["Escanear documento"].exists)
    app.cells["page-0"].press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Mover página hacia adelante"].exists)
}

func testAccessibilityExtraExtraExtraLargeKeepsExportActionVisible() {
    let app = XCUIApplication()
    app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL", "-seedDocument", "one-page"]
    app.launch()
    app.cells["document-row-0"].tap()
    XCTAssertTrue(app.buttons["export-pdf"].isHittable)
}
```

- [ ] **Step 2: Run accessibility and localization tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LocalizationAccessibilityUITests test`

Expected: failure until every required string and accessible action exists.

- [ ] **Step 3: Implement strings and accessible behavior**

Add English and Spanish values for every UI key, including all operation errors and confirmations. Use `Text(String(localized:))`, `.accessibilityLabel`, `.accessibilityValue`, `.accessibilityHint`, `.accessibilityAction`, and `.accessibilityReduceMotion` only where they express real behavior. Preserve visible labels at large text sizes with wrapping and scrollable content rather than clipping. Ensure color is not the only selected/error signal and every page thumbnail exposes ordinal, title, filter, paper selection, and move actions.

- [ ] **Step 4: Run UI test and manually audit critical screens**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocUITests/LocalizationAccessibilityUITests test`

Expected: PASS.

Record the tested screen, locale, text size, VoiceOver action, result, device, and build in `ios-native/docs/accessibility-audit.md`.

- [ ] **Step 5: Commit native accessibility and localization**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): localize and harden native accessibility"
```

### Task 14: Add cancellation, cleanup, storage, and degraded-render resilience

**Files:**
- Create: `ios-native/Nitidoc/Infrastructure/Persistence/OperationCleanup.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/Persistence/LocalDocumentRepository.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/Imaging/ImageRenderer.swift`
- Modify: `ios-native/Nitidoc/Infrastructure/PDF/CoreGraphicsPDFExporter.swift`
- Create: `ios-native/NitidocTests/OperationResilienceTests.swift`
- Create: `ios-native/NitidocUITests/FailureRecoveryUITests.swift`

**Interfaces:**
- Consumes: all cancellable task boundaries and temporary directories introduced in Tasks 4, 8, 10, and 12.
- Produces: `OperationCleanup.withTemporaryDirectory`, typed localized operation errors, and UI-test fake failure injection.

- [ ] **Step 1: Write cancellation and fallback tests**

```swift
@Test func cancelledExportRemovesTemporaryDirectory() async throws {
    let harness = try ExportHarness.make(blockingAfterPage: 1)
    let task = Task { try await harness.exporter.export(.threePages) }
    await harness.waitUntilFirstPageRenders()
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(try harness.temporaryChildren().isEmpty)
}

@Test func previewFilterFailureShowsOriginalWithoutChangingRecipe() async throws {
    let model = try PageEditorModel.failingRendererFixture()
    await model.refreshPreview()
    #expect(model.preview.kind == .originalFallback)
    #expect(model.pendingRecipe.filter.preset == .blackAndWhite)
}
```

- [ ] **Step 2: Run resilience tests and verify failure**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/OperationResilienceTests test`

Expected: failure because cleanup and fallback behavior are incomplete.

- [ ] **Step 3: Implement deterministic cleanup and recoverable failure UI**

```swift
enum OperationCleanup {
    static func withTemporaryDirectory<T: Sendable>(prefix: String,
        operation: @Sendable (URL) async throws -> T) async throws -> T
}
```

Make `withTemporaryDirectory` create a UUID-suffixed directory under `FileManager.default.temporaryDirectory`, call `Task.checkCancellation()` at entry and exit, and remove it in both success and error paths. Use it for ingestion, import transfer, image cache staging, and export. Translate capacity, encoding, Vision, rendering, and sharing failures into localized actionable messages. A preview filter failure displays Original with a retry button but retains the pending recipe. Existing documents are never evicted or deleted to recover capacity.

- [ ] **Step 4: Run unit and injected-failure UI tests**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:NitidocTests/OperationResilienceTests -only-testing:NitidocUITests/FailureRecoveryUITests test`

Expected: PASS.

- [ ] **Step 5: Commit resilience guarantees**

```powershell
git add ios-native
git diff --cached --check
git commit -m "feat(ios): recover safely from local operations"
```

### Task 15: Publish the parity matrix and complete simulator plus real-device release gates

**Files:**
- Create: `ios-native/docs/parity-matrix.md`
- Create: `ios-native/docs/real-device-validation.md`
- Create: `ios-native/docs/release-checklist.md`
- Modify: `ios-native/NitidocUITests/LibraryFlowUITests.swift`
- Modify: `ios-native/NitidocUITests/CaptureEntryUITests.swift`
- Modify: `ios-native/NitidocUITests/ReviewLifecycleUITests.swift`
- Modify: `ios-native/NitidocUITests/PageEditorUITests.swift`
- Create: `ios-native/NitidocUITests/ExportFlowUITests.swift`

**Interfaces:**
- Consumes: every completed slice, fixture manifest, UI launch seams, and product requirements in the approved native design.
- Produces: an evidence row for each required PWA capability and a sign-off checklist that blocks release when evidence is absent.

- [ ] **Step 1: Write the parity-matrix contract before the final combined run**

Create one row for each capability: empty local library; VisionKit scan success/cancel/failure; 30-page guard; photo import; detection and fallback; four-corner correction; reset/redetect; rotation; six filters; A4/Letter/Legal/Ticket/Original; add/replace/delete/reorder; draft restart restoration; local history; PDF order/page boxes/share; Spanish; English; Dynamic Type; VoiceOver; non-drag reorder; privacy boundary; cleanup; and real-device VisionKit validation. Each row must name its automated test, fixture evidence, real-device evidence, or `not applicable` with its reason. No row may be marked complete without a command result or recorded device observation.

- [ ] **Step 2: Add the combined UI smoke test**

```swift
func testSeededDocumentCanEditFilterReorderAndStartExport() {
    let app = XCUIApplication()
    app.launchArguments = ["-seedDocument", "three-pages", "-useFakeExporter", "YES"]
    app.launch()
    app.cells["document-row-0"].tap()
    app.buttons["page-0-edit"].tap()
    app.buttons["filter-eco"].tap()
    app.buttons["editor-confirm"].tap()
    app.buttons["page-0-move-later"].tap()
    app.buttons["export-pdf"].tap()
    XCTAssertTrue(app.otherElements["export-ready"].waitForExistence(timeout: 3))
}
```

- [ ] **Step 3: Run the full native suite on a simulator**

Run: `xcodebuild -project ios-native/Nitidoc.xcodeproj -scheme Nitidoc -destination 'platform=iOS Simulator,name=iPhone 16 Pro' test`

Expected: every `NitidocTests` and `NitidocUITests` case passes. Save the `.xcresult` path and test date in `ios-native/docs/release-checklist.md`.

- [ ] **Step 4: Perform and record physical-device validation before release**

Install the signed Debug or Release build on an iPhone running iOS 18 or later. Run VisionKit with bright paper, low contrast, shadow, similar background, skew, and dense text fixtures in real conditions; verify automatic capture, capture-time manual correction, cancellation from each scanner stage, and a 30-page scan. Verify background/return, memory pressure, editor corners, every filter, export/share, localized navigation, Dynamic Type, and VoiceOver custom actions. Record device model, iOS version, build number, fixture/environment, expected result, observed result, and any defect in `ios-native/docs/real-device-validation.md`.

- [ ] **Step 5: Run privacy and artifact checks**

Run: `rg -n "URLSession|NWConnection|CloudKit|Firebase|analytics|upload|OCR" ios-native/Nitidoc ios-native/NitidocTests`

Expected: no application network client, cloud, analytics, upload, or OCR implementation. Framework mentions in test names or approved documentation require an explicit documented reason.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit release evidence and final native validation**

```powershell
git add ios-native
git diff --cached --check
git commit -m "test(ios): document native parity validation"
```

---

## Execution sequence and review boundaries

1. Milestone 1 (Tasks 1–2): project shell and pure contracts.
2. Milestone 2 (Task 3): VisionKit capture adapter, fake-driven cancellation/failure behavior.
3. Milestone 3 (Tasks 4–5): transactional ingestion and a durable local library.
4. Milestone 4 (Tasks 6–7): full review lifecycle and 30-page safety.
5. Milestone 5 (Tasks 8–9): imported-photo detection and non-destructive editing.
6. Milestone 6 (Tasks 10–11): shared render pipeline and filter quality parity.
7. Milestone 7 (Task 12): physical PDF export and validation.
8. Milestone 8 (Tasks 13–15): localization, accessibility, resilience, and release evidence.

Each task is a fresh review boundary: it has one observable product outcome, a focused failing test before implementation, a focused passing test after implementation, and its own conventional commit. A reviewer can reject a later milestone without invalidating a completed earlier slice.

## Risks and controls

- VisionKit must be verified on a physical iPhone; fakes and Simulator only prove Nitidoc’s adapter and routes. Task 15 keeps physical-device capture as a hard release gate.
- The iOS Vision document-segmentation API may produce no valid quadrilateral for difficult photos. Task 8 defines full-image fallback and Task 9 keeps manual correction available.
- VisionKit has already cropped camera pages by the time Nitidoc receives them. The domain and editor explicitly bound post-production corners to the immutable returned source; the UI must never suggest recovery beyond those pixels.
- Filter algorithms will vary slightly across native platforms and encoders. Task 11 uses approved fixtures, versioned parameters, image-space tolerances, and no byte-equality checks.
- Large images and 30-page PDFs can pressure memory and storage. Tasks 4, 10, 12, and 14 use capacity preflight, sequential work, cancellation checks, and deterministic temporary cleanup.
- The current README’s marketing copy says there is no page limit, while the executable web code and approved design use a 30-page cap. Native behavior follows the approved design; product copy reconciliation is outside this plan’s implementation scope and should be handled separately before public iOS launch.

## Self-review against approved design

- **Spec coverage:** All sixteen acceptance criteria are mapped: VisionKit and capture outcomes (Task 3), immutable private sources and transactional persistence (Task 4), imported-photo detection and bounded manual corners (Tasks 8–9), review lifecycle and 30-page limit (Tasks 6–7), six filter presets and shared preview/export recipe (Tasks 10–11), physical paper dimensions and validated PDFs (Task 12), restart persistence (Task 5), ES/EN/accessibility (Task 13), cleanup/failure integrity (Task 14), and physical iPhone parity evidence (Task 15).
- **Vertical sequencing:** The eight milestones follow the design’s required sequence, and every task ends with an independently testable user-visible or integrity outcome.
- **No-placeholder scan:** This document contains no deferred implementation marker, generic error-handling instruction, undefined referenced interface, or cross-task shorthand. Every referenced service type is defined in Task 2 or produced before its first consumer.
- **Type consistency:** `EditRecipe`, `DocumentRepository`, `DocumentReviewModel`, `ImageRendering`, `PDFExporting`, `DocumentScanning`, `BorderDetecting`, `StorageChecking`, `DocumentID`, and `PageID` retain the same ownership and signature direction throughout the plan.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-native-ios-app.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh implementation agent per task, with review between tasks.

2. **Inline Execution** — execute ordered task batches in one session with explicit review checkpoints.

Which approach?
