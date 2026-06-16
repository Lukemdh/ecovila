# Vendored third-party libraries

Browser libraries committed here instead of loaded from a CDN, so the payment
pages have no third-party runtime dependency. Verify provenance before updating.

## qrcode.js

- **Library:** `qrcode-generator` by Kazuhiko Arase
- **Version:** 1.4.4
- **License:** MIT
- **Source:** npm `qrcode-generator@1.4.4` (`https://www.npmjs.com/package/qrcode-generator`)
- **SHA-256:** `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780`
- **Used by:** `js/plata-mia.js` to render the MIA payment QR on `plata-mia.html`.

Verified byte-identical to the published npm release. To re-verify or update:

```sh
npm pack qrcode-generator@1.4.4
tar xzf qrcode-generator-1.4.4.tgz
diff package/qrcode.js js/vendor/qrcode.js          # must be identical
shasum -a 256 js/vendor/qrcode.js                   # must match the SHA-256 above
```

Keep this file byte-identical to upstream (do not edit it locally) so the diff
check stays meaningful. If you bump the version, update the version + SHA-256 here.
