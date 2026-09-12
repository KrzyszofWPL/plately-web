/* ==========================================================================
   A QR encoder small enough to ship inline — byte mode, error-correction
   level M, versions 1–40, mask chosen by the standard's penalty rules.

   Why not a library: the gift page's CSP allows scripts from this origin and
   Cloudflare only, on purpose, and the one thing the page needs is a square
   of modules for a URL. This is a straight port of the reference algorithm
   (ISO/IEC 18004; the structure follows Nayuki's qrcodegen), kept to what
   that needs. `qrModules(text)` returns the matrix; `qrSvg(text)` an SVG.

   test/qr.test.mjs renders it and reads it back with a real decoder.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlatelyQR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Error-correction level M: format bits 0b00, and per version the number
  // of EC codewords in each block and the number of blocks.
  var ECC_M_FORMAT = 0;
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // --- Reed–Solomon over GF(2^8), polynomial 0x11D -------------------------
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var r = 1;
    for (var j = 0; j < degree; j++) {
      for (var k = 0; k < result.length; k++) {
        result[k] = gfMul(result[k], r);
        if (k + 1 < result.length) result[k] ^= result[k + 1];
      }
      r = gfMul(r, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  // --- bits ------------------------------------------------------------------
  function appendBits(bits, val, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }

  function utf8Bytes(str) {
    var enc = encodeURIComponent(str), out = [];
    for (var i = 0; i < enc.length; i++) {
      if (enc.charAt(i) !== "%") out.push(enc.charCodeAt(i));
      else { out.push(parseInt(enc.substr(i + 1, 2), 16)); i += 2; }
    }
    return out;
  }

  // Byte mode: 4-bit mode, count (8 or 16 bits), the bytes; then terminator,
  // byte alignment, and the 0xEC/0x11 filler to the version's capacity.
  function encodeData(bytes, ver) {
    var bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(bits, b, 8); });
    var capacity = dataCodewords(ver) * 8;
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    appendBits(bits, 0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);
    var out = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var ver = 1; ver <= 40; ver++) {
      var need = 4 + (ver <= 9 ? 8 : 16) + byteLen * 8;
      if (need <= dataCodewords(ver) * 8) return ver;
    }
    throw new Error("text too long for a QR code");
  }

  // Split into blocks, add EC to each, interleave.
  function addEccAndInterleave(data, ver) {
    var numBlocks = NUM_BLOCKS[ver], ecLen = ECC_PER_BLOCK[ver];
    var rawCw = Math.floor(rawDataModules(ver) / 8);
    var numShort = numBlocks - rawCw % numBlocks;
    var shortLen = Math.floor(rawCw / numBlocks);
    var blocks = [], divisor = rsDivisor(ecLen), k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var len = shortLen - ecLen + (i < numShort ? 0 : 1);
      var dat = data.slice(k, k + len);
      k += len;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0); // placeholder so columns line up
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      blocks.forEach(function (blk, j) {
        // skip the placeholder in the short blocks
        if (col !== shortLen - ecLen || j >= numShort) result.push(blk[col]);
      });
    }
    return result;
  }

  // --- the matrix ------------------------------------------------------------
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var size = ver * 4 + 17;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function Matrix(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < this.size; i++) {
      var row = [], fn = [];
      for (var j = 0; j < this.size; j++) { row.push(false); fn.push(false); }
      this.modules.push(row);
      this.isFunction.push(fn);
    }
  }

  Matrix.prototype.set = function (x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  };

  Matrix.prototype.drawFinder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var dist = Math.max(Math.abs(dx), Math.abs(dy));
      var xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
    }
  };

  Matrix.prototype.drawAlignment = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  Matrix.prototype.drawFormatBits = function (mask) {
    var data = (ECC_M_FORMAT << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var bit = function (i) { return ((bits >>> i) & 1) !== 0; };
    for (var a = 0; a <= 5; a++) this.set(8, a, bit(a));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (var b = 9; b < 15; b++) this.set(14 - b, 8, bit(b));
    for (var c = 0; c < 8; c++) this.set(this.size - 1 - c, 8, bit(c));
    for (var d = 8; d < 15; d++) this.set(8, this.size - 15 + d, bit(d));
    this.set(8, this.size - 8, true);
  };

  Matrix.prototype.drawVersion = function () {
    if (this.ver < 7) return;
    var rem = this.ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.ver << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var dark = ((bits >>> j) & 1) !== 0;
      var a = this.size - 11 + j % 3, b = Math.floor(j / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  };

  Matrix.prototype.drawFunctionPatterns = function () {
    for (var i = 0; i < this.size; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    this.drawFinder(3, 3); this.drawFinder(this.size - 4, 3); this.drawFinder(3, this.size - 4);
    var pos = alignmentPositions(this.ver), n = pos.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      var corner = (a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0);
      if (!corner) this.drawAlignment(pos[a], pos[b]);
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };

  Matrix.prototype.drawCodewords = function (data) {
    var i = 0, size = this.size;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  };

  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) for (var x = 0; x < this.size; x++) {
      var invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = x * y % 2 + x * y % 3 === 0; break;
        case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
        default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
      }
      if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
    }
  };

  // The four penalty rules of the standard, used to pick the mask.
  Matrix.prototype.penalty = function () {
    var size = this.size, m = this.modules, result = 0, x, y, i;
    var at = function (row, col, x2, y2) { return row ? m[x2][y2] : m[y2][x2]; };
    // Rules 1 and 3, along rows then along columns.
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < size; i++) {
        var line = [];
        for (var k = 0; k < size; k++) line.push(pass === 0 ? m[i][k] : m[k][i]);
        // rule 1: runs of five or more of one colour
        var runLen = 1;
        for (k = 1; k <= size; k++) {
          if (k < size && line[k] === line[k - 1]) runLen++;
          else { if (runLen >= 5) result += 3 + (runLen - 5); runLen = 1; }
        }
        // rule 3: the finder-like 1011101 with four light modules on a side
        for (k = 0; k + 7 <= size; k++) {
          var f = line[k] && !line[k + 1] && line[k + 2] && line[k + 3] && line[k + 4] && !line[k + 5] && line[k + 6];
          if (!f) continue;
          var before = k >= 4 && !line[k - 1] && !line[k - 2] && !line[k - 3] && !line[k - 4];
          var after = k + 10 < size && !line[k + 7] && !line[k + 8] && !line[k + 9] && !line[k + 10];
          if (before || after || k === 0 || k + 7 === size) result += 40;
        }
      }
    }
    void at;
    // rule 2: 2x2 blocks of one colour
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
    }
    // rule 4: how far the dark share is from one half
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    result += Math.floor(Math.abs(dark * 100 / total - 50) / 5) * 10;
    return result;
  };

  function qrModules(text) {
    var bytes = utf8Bytes(String(text));
    var ver = pickVersion(bytes.length);
    var data = addEccAndInterleave(encodeData(bytes, ver), ver);
    var mx = new Matrix(ver);
    mx.drawFunctionPatterns();
    mx.drawCodewords(data);
    var best = 0, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      mx.applyMask(mask);
      mx.drawFormatBits(mask);
      var score = mx.penalty();
      if (score < bestScore) { bestScore = score; best = mask; }
      mx.applyMask(mask); // undo (XOR)
    }
    mx.applyMask(best);
    mx.drawFormatBits(best);
    return mx.modules;
  }

  function qrSvg(text, opts) {
    var o = opts || {};
    var m = qrModules(text), n = m.length, quiet = o.quiet == null ? 2 : o.quiet;
    var path = "";
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if (m[y][x]) path += "M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z";
    }
    var span = n + quiet * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + span + " " + span + '" shape-rendering="crispEdges"' +
      (o.attrs ? " " + o.attrs : "") + '><rect width="100%" height="100%" fill="' + (o.light || "#fff") + '"/><path d="' + path + '" fill="' + (o.dark || "#000") + '"/></svg>';
  }

  return { qrModules: qrModules, qrSvg: qrSvg };
});
