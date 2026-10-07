import { storageBackend } from "./config";
import { uploadImageBytes } from "./object-storage";

export type StoredFile = { url: string; stored: boolean };

export interface DeliverableStore {
  readonly kind: "object-storage" | "dry-run";
  put(name: string, bytes: Buffer, contentType: string): Promise<StoredFile>;
}

/** Without S3 or Blob, files are measured but not kept; live publishing refuses them. */
export const dryRunDeliverableStore: DeliverableStore = {
  kind: "dry-run",
  async put(name) {
    return { url: `dry-run://print-files/${name}`, stored: false };
  },
};

export const objectDeliverableStore: DeliverableStore = {
  kind: "object-storage",
  async put(name, bytes, contentType) {
    const obj = await uploadImageBytes(bytes, contentType);
    if (!obj) return dryRunDeliverableStore.put(name, bytes, contentType);
    return { url: obj.url, stored: true };
  },
};

export function getDeliverableStore(): DeliverableStore {
  return storageBackend() === "none" ? dryRunDeliverableStore : objectDeliverableStore;
}
