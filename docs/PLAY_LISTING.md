# Google Play listing

Everything Play Console asks for, prepared. Build the artifact with
`npm run android:aab` (see `docs/RELEASING.md`).

## Read this first: the signing key decision

At listing creation Play Console offers **Play App Signing**, and the choice it
presents is not obvious. Take the option to **upload your existing key** as the
app signing key, rather than letting Google generate a new one.

Why it matters here specifically: Nitidoc is already distributed as a signed
APK on GitHub Releases. If Play signs with a *different* key, a user who
installed from GitHub cannot update through Play at all — Android refuses the
install on a signature mismatch, and they have to uninstall and lose their scan
history to switch. Uploading the existing key keeps both channels
interchangeable.

You still get the recovery benefit: Google holds the app signing key, so a lost
or compromised *upload* key can be replaced. That is the one recoverable
failure in a system where losing the app signing key is permanent.

## Store listing

### App name

```
Nitidoc
```

### Short description (max 80 characters)

es-419:

```
Escaneá documentos a PDF. Gratis, sin anuncios y sin subir nada a internet.
```

en-US:

```
Scan documents to PDF. Free, no ads, and nothing ever leaves your phone.
```

### Full description (max 4000 characters)

es-419:

```
Nitidoc convierte la cámara de tu teléfono en un escáner de documentos. Apuntás, capturás y obtenés un PDF derecho, legible y listo para enviar.

Todo pasa dentro de tu teléfono. La detección de bordes, la corrección de perspectiva, los filtros y el armado del PDF corren localmente. Tus documentos no se suben a ningún servidor, porque no hay servidor: podés usar Nitidoc entero en modo avión.

QUÉ HACE

• Escaneo multipágina: capturá una hoja tras otra y armá un solo PDF.
• Detección automática de bordes y corrección de perspectiva, para que una foto tomada en ángulo salga como una hoja derecha.
• Seis filtros: original, mejorado, escala de grises, blanco y negro, alto contraste y eco (ahorra tinta al imprimir).
• Ajustá el recorte a mano cuando la detección no acierta.
• Reordená, recortá de nuevo o eliminá páginas antes de terminar.
• Vista previa a pantalla completa que muestra exactamente lo que va a tener el PDF.
• Historial: tus escaneos quedan guardados en el teléfono. Volvés a abrirlos, les cambiás el filtro y los exportás de nuevo cuando quieras.
• Exportá a PDF y compartilo por WhatsApp, mail, Drive o donde necesites.
• Español e inglés.

QUÉ NO HACE

• No pide cuenta ni registro.
• No muestra publicidad.
• No pone marcas de agua.
• No tiene suscripción ni funciones pagas.
• No recolecta datos, no tiene analítica y no rastrea nada.

SIN CÁMARA TAMBIÉN FUNCIONA

Si preferís no darle acceso a la cámara, podés importar una foto que ya tengas y procesarla igual.

CÓDIGO ABIERTO

Nitidoc es software libre bajo licencia AGPL-3.0. El código está publicado, así que no tenés que creernos: podés leerlo y verificar vos mismo que no envía nada a ninguna parte.

https://github.com/santiagoisra/nitidoc

Política de privacidad: https://nitidoc.com/privacidad
```

en-US:

```
Nitidoc turns your phone's camera into a document scanner. Point, capture, and get a straightened, legible PDF ready to send.

Everything happens on your phone. Edge detection, perspective correction, filtering and PDF generation all run locally. Your documents are never uploaded to a server, because there is no server: Nitidoc works fully in airplane mode.

WHAT IT DOES

• Multi-page scanning: capture sheet after sheet into a single PDF.
• Automatic edge detection and perspective correction, so a photo taken at an angle comes out as a straight page.
• Six filters: original, enhanced, grayscale, black and white, high contrast, and eco (saves ink when printing).
• Adjust the crop by hand when detection misses.
• Reorder, re-crop or delete pages before finishing.
• Full-screen preview showing exactly what the PDF will contain.
• History: your scans stay on your phone. Reopen them, change the filter and export again whenever you like.
• Export to PDF and share via WhatsApp, email, Drive or wherever you need.
• Spanish and English.

WHAT IT DOESN'T DO

• No account, no sign-up.
• No advertising.
• No watermarks.
• No subscription, no paid tiers.
• No data collection, no analytics, no tracking.

WORKS WITHOUT THE CAMERA

If you would rather not grant camera access, you can import a photo you already have and process it the same way.

OPEN SOURCE

Nitidoc is free software under AGPL-3.0. The source is published, so you do not have to take our word for it: you can read it and verify for yourself that it sends nothing anywhere.

https://github.com/santiagoisra/nitidoc

Privacy policy: https://nitidoc.com/privacidad
```

## Data safety form

Play asks this as a questionnaire. The answers are unusually simple here, and
they are verifiable against the source rather than asserted:

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | N/A — no data is transmitted |
| Do you provide a way for users to request that their data be deleted? | N/A — nothing is collected. Scans are local and deletable in-app or by uninstalling |

If the form insists on a justification: scanning, detection, filtering and PDF
export run entirely on-device; saved scans live in the app's own local storage;
the app makes no network requests. `grep` for `fetch(`, `XMLHttpRequest`,
`analytics`, `sentry`, `gtag` across `src/` returns nothing but a comment.

## Content rating questionnaire

Category: **Utility / Productivity**. Every content question (violence, sexual
content, profanity, drugs, gambling, user-generated content, sharing location,
in-app purchases) answers **no**. Expected outcome: rated for everyone.

## Camera permission justification

Play asks why the app needs `CAMERA`. It is the app's core function — capturing
the document pages the user scans. The camera is accessed only while the capture
screen is open; no video is recorded and nothing is captured in the background.
An import-an-image path exists for users who decline the permission.

## Graphic assets

| Asset | Requirement |
|---|---|
| App icon | 512×512 PNG, 32-bit with alpha |
| Feature graphic | 1024×500 PNG or JPEG, no alpha |
| Phone screenshots | 2–8, min 320px, max 3840px on the long edge, 16:9 or 9:16 |

The icon can come from `landing/icons/icon-512.png`. The feature graphic is the
one thing that has to be designed rather than captured.

### Suggested screenshot order

Sequence matters more than polish — the first two are what most people see
before deciding. Scan something real; a lorem-ipsum page reads as a mockup and
undersells it.

1. **Camera aimed at a document**, edges visible. This is the "what is this app"
   shot and it should be first.
2. **The finished document screen** with several page thumbnails fanned out —
   shows it does multi-page, which the competition charges for.
3. **The filter strip**, mid-adjustment, so the six presets are visible.
4. **My scans**, with a few documents in the history.
5. **The full-screen viewer** on a clean, straightened page — the payoff shot.

Avoid capturing anything with real personal data: an ID card, an invoice with a
name. Play screenshots are public forever.
