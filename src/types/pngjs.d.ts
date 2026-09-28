declare module "pngjs" {
  export interface PngImage {
    width: number;
    height: number;
    data: Buffer;
  }
  export const PNG: {
    sync: {
      read(buffer: Buffer, options?: { checkCRC?: boolean; skipRescale?: boolean }): PngImage;
      write(image: PngImage, options?: {
        bitDepth?: number;
        colorType?: number;
        inputColorType?: number;
        inputHasAlpha?: boolean;
      }): Buffer;
    };
  };
}
