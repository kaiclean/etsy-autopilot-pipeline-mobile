export type PinImage = { kind: "url"; url: string } | { kind: "base64"; contentType: string; data: string };

export type PinInput = {
  boardId: string;
  title: string;
  description: string;
  link: string;
  altText: string;
  image: PinImage;
};

export interface PinterestAdapter {
  readonly mode: "dry-run" | "live";
  /** Creates one pin on the board. Dry-run records the call and touches nothing. */
  createPin(input: PinInput): Promise<{ pinId: string }>;
}
