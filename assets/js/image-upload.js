/**
 * Browser mirror of api/_upload-limits.js, plus the one way a page turns a
 * chosen photo into something that can actually be sent.
 *
 * There is no bundler here, so a page cannot import the server module. Keep the
 * numbers below byte-identical to api/_upload-limits.js; scripts/test-upload-limits.mjs
 * loads both and fails the build the moment they disagree.
 *
 * WHY EVERY UPLOAD SCREEN MUST CALL prepare()
 * Sending the original file is what broke job completion: a 4 MB photo became a
 * 5.4 MB base64 body, Vercel returned 413 before the function ran, and the Easer
 * was told "Connection error". Downscaling first removes the ceiling as a
 * concern entirely, and re-encoding to JPEG also converts iPhone HEIC, which
 * Chrome cannot decode and the server would have rejected on its magic bytes.
 */
(function (global) {
  'use strict';

  var VERCEL_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);
  var BASE64_EXPANSION = 4 / 3;
  var JSON_ENVELOPE_BYTES = 4096;
  var SAFETY_FACTOR = 0.9;
  var MAX_UPLOAD_BYTES = Math.floor(
    ((VERCEL_BODY_LIMIT_BYTES * SAFETY_FACTOR) - JSON_ENVELOPE_BYTES) / BASE64_EXPANSION
  );
  var IMAGE_MAX_EDGE_PX = 1600;
  var IMAGE_JPEG_QUALITY = 0.8;
  var IMAGE_FALLBACK_QUALITIES = [0.6, 0.45];
  var UPLOAD_TOO_LARGE_MESSAGE =
    'That photo is too large to send. Take it again at a lower resolution, or pick a smaller one.';

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(String(e.target.result || '')); };
      reader.onerror = function () { reject(new Error('That file could not be read. Try choosing it again.')); };
      reader.readAsDataURL(file);
    });
  }

  // createImageBitmap honours EXIF orientation explicitly, so a photo taken
  // sideways is not stored sideways. The <img> path is the fallback for older
  // browsers, where the decoder applies orientation itself.
  function decode(file, dataUrl) {
    if (typeof global.createImageBitmap === 'function') {
      try {
        return global.createImageBitmap(file, { imageOrientation: 'from-image' })
          .catch(function () { return decodeViaImg(dataUrl); });
      } catch (e) { /* older signature: fall through */ }
    }
    return decodeViaImg(dataUrl);
  }

  function decodeViaImg(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('UNDECODABLE')); };
      img.src = dataUrl;
    });
  }

  function scaledSize(w, h) {
    if (w <= IMAGE_MAX_EDGE_PX && h <= IMAGE_MAX_EDGE_PX) return { w: w, h: h };
    return w >= h
      ? { w: IMAGE_MAX_EDGE_PX, h: Math.max(1, Math.round(h * IMAGE_MAX_EDGE_PX / w)) }
      : { h: IMAGE_MAX_EDGE_PX, w: Math.max(1, Math.round(w * IMAGE_MAX_EDGE_PX / h)) };
  }

  /** Bytes a base64 payload occupies on the wire, minus its data-URL prefix. */
  function dataUrlBytes(dataUrl) {
    var comma = dataUrl.indexOf(',');
    var body = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
    var padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    return Math.floor(body.length * 3 / 4) - padding;
  }

  /**
   * Turn a chosen File into something sendable.
   * Resolves { base64, dataUrl, mimeType, bytes, originalBytes, resized }.
   * Rejects with an Error whose message is safe to show the user.
   */
  function prepare(file) {
    if (!file) return Promise.reject(new Error('Choose a photo first.'));
    if (!file.size) return Promise.reject(new Error('That file is empty. Choose another photo.'));

    return readAsDataUrl(file).then(function (dataUrl) {
      return decode(file, dataUrl).then(function (source) {
        var w = source.width || source.naturalWidth;
        var h = source.height || source.naturalHeight;
        if (!w || !h) throw new Error('UNDECODABLE');

        var size = scaledSize(w, h);
        var canvas = document.createElement('canvas');
        canvas.width = size.w;
        canvas.height = size.h;
        canvas.getContext('2d').drawImage(source, 0, 0, size.w, size.h);
        if (source.close) source.close();

        var out = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
        for (var i = 0; i < IMAGE_FALLBACK_QUALITIES.length && dataUrlBytes(out) > MAX_UPLOAD_BYTES; i += 1) {
          out = canvas.toDataURL('image/jpeg', IMAGE_FALLBACK_QUALITIES[i]);
        }
        if (dataUrlBytes(out) > MAX_UPLOAD_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);

        return {
          dataUrl: out,
          base64: out.slice(out.indexOf(',') + 1),
          // Read back what the canvas actually produced rather than asserting
          // JPEG. A browser that ignores the requested type would otherwise have
          // us declare a mime the bytes do not match, and the server checks
          // magic bytes against the declared type and rejects the mismatch.
          mimeType: out.slice(5, out.indexOf(';')) || 'image/jpeg',
          bytes: dataUrlBytes(out),
          originalBytes: file.size,
          resized: true,
        };
      }).catch(function (err) {
        if (err && err.message && err.message !== 'UNDECODABLE') throw err;
        // This browser cannot decode the format, so it cannot be shrunk. Send
        // the original only if it genuinely fits; never pretend it will.
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
        if (!file.type) throw new Error('This browser could not read that image. Take the photo again with the camera.');
        return {
          dataUrl: dataUrl,
          base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          mimeType: file.type,
          bytes: file.size,
          originalBytes: file.size,
          resized: false,
        };
      });
    });
  }

  /**
   * What went wrong with an upload response, in words worth showing.
   * A 413 never carries JSON, so parsing it first is what produced the
   * misleading "Connection error" the Easer used to see.
   */
  function describeUploadFailure(response) {
    if (response && response.status === 413) return Promise.resolve(UPLOAD_TOO_LARGE_MESSAGE);
    return response.json().then(function (data) {
      return (data && data.error) || 'Upload failed. Please try again.';
    }).catch(function () {
      return 'Upload failed (server said ' + ((response && response.status) || 'nothing') + '). Please try again.';
    });
  }

  global.AAE_UPLOAD = {
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    IMAGE_MAX_EDGE_PX: IMAGE_MAX_EDGE_PX,
    IMAGE_JPEG_QUALITY: IMAGE_JPEG_QUALITY,
    UPLOAD_TOO_LARGE_MESSAGE: UPLOAD_TOO_LARGE_MESSAGE,
    prepare: prepare,
    describeUploadFailure: describeUploadFailure,
  };
})(typeof window !== 'undefined' ? window : globalThis);
