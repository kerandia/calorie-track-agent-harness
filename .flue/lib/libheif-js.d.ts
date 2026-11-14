declare module "libheif-js/wasm-bundle.js" {
  export interface HeifEnumValue {
    readonly value: number;
  }

  export interface HeifError {
    readonly code: HeifEnumValue;
    readonly subcode: HeifEnumValue;
    readonly message: string;
  }

  export interface HeifContext {}
  export interface HeifImageHandle {}
  export interface HeifImagePtr {
    readonly ptr?: number;
    readonly $$?: { readonly ptr?: number };
  }

  export interface HeifDecodedChannel {
    readonly id: HeifEnumValue;
    readonly stride: number;
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly bits_per_pixel: number;
  }

  export interface HeifDecodedImage {
    readonly code?: HeifEnumValue;
    readonly message?: string;
    readonly image: HeifImagePtr;
    readonly width: number;
    readonly height: number;
    readonly channels: HeifDecodedChannel[];
  }

  export interface LibHeifModule {
    readonly ready: Promise<void> | void;
    readonly heif_error_code: {
      readonly heif_error_Ok: HeifEnumValue;
    };
    readonly heif_colorspace: {
      readonly heif_colorspace_RGB: HeifEnumValue;
    };
    readonly heif_chroma: {
      readonly heif_chroma_interleaved_RGBA: HeifEnumValue;
    };
    readonly heif_channel: {
      readonly heif_channel_interleaved: HeifEnumValue;
    };
    heif_context_alloc(): HeifContext | null;
    heif_context_free(ctx: HeifContext): void;
    heif_context_read_from_memory(ctx: HeifContext, data: Uint8Array): HeifError;
    heif_context_get_primary_image_handle(ctx: HeifContext): (HeifImageHandle & Partial<HeifError>) | null;
    heif_context_get_list_of_top_level_image_IDs(ctx: HeifContext): number[] & Partial<HeifError>;
    heif_context_get_image_handle(ctx: HeifContext, id: number): (HeifImageHandle & Partial<HeifError>) | null;
    heif_image_handle_release(handle: HeifImageHandle): void;
    heif_image_handle_is_premultiplied_alpha(handle: HeifImageHandle): number;
    heif_image_is_premultiplied_alpha?(image: HeifImagePtr): number;
    heif_js_decode_image2(
      handle: HeifImageHandle,
      colorspace: HeifEnumValue,
      chroma: HeifEnumValue,
    ): HeifDecodedImage | null;
    heif_image_release(image: HeifImagePtr): void;
    _heif_image_get_decoding_warnings(
      imagePtr: number,
      firstWarningIdx: number,
      outWarningsPtr: number,
      maxOutBufferEntries: number,
    ): number;
  }

  const libheif: LibHeifModule;
  export default libheif;
}
