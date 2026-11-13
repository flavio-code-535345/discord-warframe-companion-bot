# Image code

Notes for this folder. The rules that apply everywhere, the commands and the list of the other notes are in the root `CLAUDE.md`.

**WebP:** riven screenshots may be PNG, JPEG or WebP. `src/imaging/webp.ts` decodes WebP with libwebp compiled to WebAssembly (`@saschazar/wasm-webp`, no native module) and `scanCard` converts a WebP to a PNG first (`webpToPng`), so the rest of the image code stays PNG/JPEG only. The wasm module can decode only once before `free()`, so every picture gets a fresh instance, and its wasm file is passed as bytes (`wasmBinary`) because its loader would otherwise `fetch()` a file path, which fails on Node 24. The screenshot-roles reader is unchanged (a WebP there still goes straight to the vision models).

**Guards:** `size.ts` reads the size a PNG/JPEG/WebP header declares and refuses anything over 40 million pixels before a decoder allocates it (a 43 KB file can declare 6000x6000; `normalizeImage`, `decodeImage`, `decodeWebp` and `scanCard` all check). `sniff.ts` (`normalizeImage`) goes by the file header and not by Discord's content type: a pasted PNG arrives labelled image/webp.

**Drawing** (pureimage: pure JS, no native canvas): a picture is drawn larger and averaged down (4x for the emoji badges and icons in `badges.ts` and `icons.ts`), because pureimage only smooths horizontally; its bitmaps start opaque black, hence `blank()`. It reads TTF only, so `font.ts` converts the packaged Roboto WOFF to TTF at start (`woffToSfnt`, written to the temp dir) and registers regular and bold as two families. What each drawing is for is written where it is used: the emojis in `src/discord/CLAUDE.md`, the riven picture in `src/rivens/CLAUDE.md`, the stats chart in `src/alecaframe/CLAUDE.md`.
