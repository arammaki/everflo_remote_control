/* Uploads are the raw landscape frame, 640x480; the calibration is bound to the
   canvas the pages analyse, which is mirrored and rotated 270 — 480x640. Same
   transform as the admin page's orient(): canvas(xc,yc) = image(w-1-yc,
   h-1-xc), done on an RGBA array. Feeding the raw frame straight in gives
   dx=40, dy=-40, reg 0.07 and looks exactly like a camera that has fallen off
   the wall. One copy, for the reader Worker and tools/score_uploads.mjs. */
export function orient(im) {
  const W = im.height, H = im.width, out = new Uint8ClampedArray(W * H * 4);
  for (let yc = 0; yc < H; yc++) for (let xc = 0; xc < W; xc++) {
    const s = ((im.height - 1 - xc) * im.width + (im.width - 1 - yc)) * 4, t = (yc * W + xc) * 4;
    out[t] = im.data[s]; out[t + 1] = im.data[s + 1]; out[t + 2] = im.data[s + 2]; out[t + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
