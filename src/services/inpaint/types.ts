export type InpaintBackend = "webgpu" | "wasm" | "fallback";

export type InpaintRect = {
  x: number;
  y: number;
  size: number;
};

export type InpaintInitResult = {
  ready: boolean;
  backend: InpaintBackend;
  message?: string;
};

export type InpaintRunResult = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  backend: InpaintBackend;
};

export type InpaintWorkerRequest =
  | {
      id: number;
      type: "init";
      modelUrl: string;
    }
  | {
      id: number;
      type: "run";
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
      rect: InpaintRect;
    };

export type InpaintWorkerResponse =
  | {
      id: number;
      type: "init";
      ready: boolean;
      backend: InpaintBackend;
      message?: string;
    }
  | {
      id: number;
      type: "run";
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
      backend: InpaintBackend;
    }
  | {
      id: number;
      type: "error";
      message: string;
    };
