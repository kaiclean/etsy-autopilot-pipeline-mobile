import sharp from "sharp";

export type DesignHash = Uint8Array;

/** 64-bit difference hash (as 64 bits): robust to scaling and small colour changes, cheap to compare. */
export async function differenceHash(bytes: Buffer): Promise<DesignHash> {
  const { data } = await sharp(bytes, { limitInputPixels: 128_000_000 })
    .greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const hash = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) hash[y * 8 + x] = data[y * 9 + x]! > data[y * 9 + x + 1]! ? 1 : 0;
  }
  return hash;
}

export function hammingDistance(a: DesignHash, b: DesignHash) {
  let bits = 0;
  for (let index = 0; index < 64; index++) if (a[index] !== b[index]) bits++;
  return bits;
}

/** Two designs this close (out of 64 bits) read as the same composition to a shopper. */
export const NEAR_DUPLICATE_BITS = 10;

export function isNearDuplicate(hash: DesignHash, seen: readonly DesignHash[], threshold = NEAR_DUPLICATE_BITS) {
  return seen.some((other) => hammingDistance(hash, other) <= threshold);
}
