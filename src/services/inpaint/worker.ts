/// <reference lib="webworker" />

import * as ortWasm from "onnxruntime-web";
import * as ortWebGpu from "onnxruntime-web/webgpu";
import type {
  InpaintBackend,
  InpaintRect,
  InpaintWorkerRequest,
  InpaintWorkerResponse,
} from "./types";

type EngineState = {
  backend: InpaintBackend;
  session: any;
  ready: boolean;
};

type TensorLayout = "nchw" | "nhwc";
type TensorDType = "float32" | "uint8";

const state: EngineState = {
  backend: "fallback",
  session: null,
  ready: false,
};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<InpaintWorkerRequest>) => {
  const payload = event.data;
  try {
    if (payload.type === "init") {
      const result = await initEngine(payload.modelUrl);
      const response: InpaintWorkerResponse = {
        id: payload.id,
        type: "init",
        ...result,
      };
      ctx.postMessage(response);
      return;
    }

    if (payload.type === "run") {
      const output = await runInpaint(payload.pixels, payload.width, payload.height, payload.rect);
      const response: InpaintWorkerResponse = {
        id: payload.id,
        type: "run",
        width: payload.width,
        height: payload.height,
        pixels: output.pixels,
        backend: state.backend,
        message: output.message,
      };
      ctx.postMessage(response, [output.pixels.buffer]);
    }
  } catch (error) {
    const response: InpaintWorkerResponse = {
      id: payload.id,
      type: "error",
      message: error instanceof Error ? error.message : "worker failed",
    };
    ctx.postMessage(response);
  }
};

async function initEngine(modelUrl: string) {
  try {
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`无法加载模型：${response.status}`);
    }
    const modelBytes = await response.arrayBuffer();

    try {
      const session = await ortWebGpu.InferenceSession.create(modelBytes, {
        executionProviders: ["webgpu"],
      });
      state.backend = "webgpu";
      state.session = session;
      state.ready = true;
      return { ready: true, backend: "webgpu" as const, message: "WebGPU 已启用" };
    } catch {
      const session = await ortWasm.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
      });
      state.backend = "wasm";
      state.session = session;
      state.ready = true;
      return { ready: true, backend: "wasm" as const, message: "WASM 已启用" };
    }
  } catch (error) {
    state.backend = "fallback";
    state.session = null;
    state.ready = false;
    return {
      ready: false,
      backend: "fallback" as const,
      message: error instanceof Error ? error.message : "模型初始化失败，已降级到基础算法",
    };
  }
}

async function runInpaint(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
) {
  if (state.session) {
    try {
      const output = await runWithOrt(pixels, width, height, rect, state.session);
      return {
        pixels: output,
        message: state.backend === "webgpu" ? "WebGPU 推理成功" : "WASM 推理成功",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型推理失败";
      const signature = getModelSignature(state.session);
      state.backend = "fallback";
      state.session = null;
      state.ready = false;
      return {
        pixels: runFallback(pixels, width, height, rect),
        message: `模型推理失败，已降级：${message} | ${signature}`,
      };
    }
  }

  return {
    pixels: runFallback(pixels, width, height, rect),
    message: "模型未就绪，使用降级算法",
  };
}

async function runWithOrt(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
  session: any,
) {
  const imageName = session.inputNames[0];
  const maskName = session.inputNames[1];
  if (!imageName || !maskName) throw new Error("模型输入不匹配");
  if ((session.inputNames?.length ?? 0) < 2) throw new Error("模型至少需要 image + mask 两个输入");

  const attempts: Array<{
    dtype: TensorDType;
    preferNhwc: boolean;
    invertMask: boolean;
    maskInputImage: boolean;
  }> = [
    { dtype: "uint8", preferNhwc: true, invertMask: false, maskInputImage: false },
    { dtype: "uint8", preferNhwc: true, invertMask: true, maskInputImage: false },
    { dtype: "uint8", preferNhwc: false, invertMask: false, maskInputImage: false },
    { dtype: "uint8", preferNhwc: false, invertMask: true, maskInputImage: false },
    { dtype: "uint8", preferNhwc: true, invertMask: false, maskInputImage: true },
    { dtype: "uint8", preferNhwc: true, invertMask: true, maskInputImage: true },
    { dtype: "float32", preferNhwc: false, invertMask: false, maskInputImage: false },
    { dtype: "float32", preferNhwc: true, invertMask: false, maskInputImage: false },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await runWithOrtAttempt({
        session,
        pixels,
        width,
        height,
        rect,
        imageName,
        maskName,
        dtype: attempt.dtype,
        preferNhwc: attempt.preferNhwc,
        invertMask: attempt.invertMask,
        maskInputImage: attempt.maskInputImage,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("模型推理失败");
}

async function runWithOrtAttempt(params: {
  session: any;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  rect: InpaintRect;
  imageName: string;
  maskName: string;
  dtype: TensorDType;
  preferNhwc: boolean;
  invertMask: boolean;
  maskInputImage: boolean;
}) {
  const {
    session,
    pixels,
    width,
    height,
    rect,
    imageName,
    maskName,
    dtype,
    preferNhwc,
    invertMask,
    maskInputImage,
  } = params;

  const imageLayout = inferTensorLayout(
    session.inputMetadata?.[imageName]?.dimensions,
    "image",
    preferNhwc,
  );
  const maskLayout = inferTensorLayout(
    session.inputMetadata?.[maskName]?.dimensions,
    "mask",
    preferNhwc,
  );
  const { modelWidth, modelHeight } = getModelInputSize(
    session,
    imageName,
    imageLayout,
    width,
    height,
  );

  const resizedPixels = resizeRgba(pixels, width, height, modelWidth, modelHeight);
  const scaledRect = {
    x: (rect.x / width) * modelWidth,
    y: (rect.y / height) * modelHeight,
    width: Math.max((rect.width / width) * modelWidth, 1),
    height: Math.max((rect.height / height) * modelHeight, 1),
  };

  const preparedImage = maskInputImage
    ? fillRectOnRgba(resizedPixels, modelWidth, modelHeight, scaledRect, 255)
    : resizedPixels;
  const inputImage = createImageTensorData(preparedImage, modelWidth, modelHeight, imageLayout, dtype);
  const inputMask = createMaskTensorData(modelWidth, modelHeight, scaledRect, dtype, invertMask);

  const imageShape =
    imageLayout === "nhwc" ? [1, modelHeight, modelWidth, 3] : [1, 3, modelHeight, modelWidth];
  const maskShape =
    maskLayout === "nhwc" ? [1, modelHeight, modelWidth, 1] : [1, 1, modelHeight, modelWidth];

  const feeds: Record<string, ortWasm.Tensor | ortWebGpu.Tensor> = {
    [imageName]: new ortWasm.Tensor(dtype, inputImage as any, imageShape),
    [maskName]: new ortWasm.Tensor(dtype, inputMask as any, maskShape),
  };

  const result = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = result[outputName];
  if (!output) throw new Error("模型输出为空");

  const outputDims = output.dims as Array<number | string | null | undefined> | undefined;
  const outputLayout = inferTensorLayout(outputDims, "image", preferNhwc);
  const outputType = (output.type as string | undefined) ?? "float32";
  const modelOutputRgba =
    outputLayout === "nhwc"
      ? outputType === "uint8"
        ? nhwcUint8ToRgbaUint8(output.data as Uint8Array, modelWidth, modelHeight)
        : nhwcFloatToRgbaUint8(output.data as Float32Array, modelWidth, modelHeight)
      : outputType === "uint8"
        ? nchwUint8ToRgbaUint8(output.data as Uint8Array, modelWidth, modelHeight)
        : nchwFloatToRgbaUint8(output.data as Float32Array, modelWidth, modelHeight);

  if (!hasMeaningfulChangeInRect(resizedPixels, modelOutputRgba, modelWidth, modelHeight, scaledRect)) {
    throw new Error("模型输出在选区内无明显变化，尝试其他掩码语义");
  }

  const composited = compositeInsideRect(
    resizedPixels,
    modelOutputRgba,
    modelWidth,
    modelHeight,
    scaledRect,
  );

  return resizeRgba(composited, modelWidth, modelHeight, width, height);
}

function createImageTensorData(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  layout: TensorLayout,
  dtype: TensorDType,
) {
  if (dtype === "uint8") {
    return layout === "nhwc" ? rgbaToNhwcUint8(pixels, width, height) : rgbaToNchwUint8(pixels, width, height);
  }
  return layout === "nhwc" ? rgbaToNhwcFloat32(pixels, width, height) : rgbaToNchwFloat32(pixels, width, height);
}

function createMaskTensorData(
  width: number,
  height: number,
  rect: InpaintRect,
  dtype: TensorDType,
  invertMask: boolean,
) {
  const insideValue = dtype === "uint8" ? (invertMask ? 0 : 255) : invertMask ? 0 : 1;
  const outsideValue = dtype === "uint8" ? (invertMask ? 255 : 0) : invertMask ? 1 : 0;
  const out = dtype === "uint8" ? new Uint8Array(width * height) : new Float32Array(width * height);
  out.fill(outsideValue as any);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const rectW = Math.max(1, Math.floor(rect.width));
  const rectH = Math.max(1, Math.floor(rect.height));
  const x1 = Math.min(width, x0 + rectW);
  const y1 = Math.min(height, y0 + rectH);

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      out[y * width + x] = insideValue as any;
    }
  }
  return out;
}

function rgbaToNchwFloat32(pixels: Uint8ClampedArray, width: number, height: number) {
  const channelSize = width * height;
  const out = new Float32Array(channelSize * 3);
  for (let i = 0; i < channelSize; i += 1) {
    const src = i * 4;
    out[i] = pixels[src] / 255;
    out[i + channelSize] = pixels[src + 1] / 255;
    out[i + channelSize * 2] = pixels[src + 2] / 255;
  }
  return out;
}

function rgbaToNhwcFloat32(pixels: Uint8ClampedArray, width: number, height: number) {
  const out = new Float32Array(width * height * 3);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const src = i * 4;
    const dst = i * 3;
    out[dst] = pixels[src] / 255;
    out[dst + 1] = pixels[src + 1] / 255;
    out[dst + 2] = pixels[src + 2] / 255;
  }
  return out;
}

function rgbaToNchwUint8(pixels: Uint8ClampedArray, width: number, height: number) {
  const channelSize = width * height;
  const out = new Uint8Array(channelSize * 3);
  for (let i = 0; i < channelSize; i += 1) {
    const src = i * 4;
    out[i] = pixels[src];
    out[i + channelSize] = pixels[src + 1];
    out[i + channelSize * 2] = pixels[src + 2];
  }
  return out;
}

function rgbaToNhwcUint8(pixels: Uint8ClampedArray, width: number, height: number) {
  const out = new Uint8Array(width * height * 3);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const src = i * 4;
    const dst = i * 3;
    out[dst] = pixels[src];
    out[dst + 1] = pixels[src + 1];
    out[dst + 2] = pixels[src + 2];
  }
  return out;
}

function nchwFloatToRgbaUint8(data: Float32Array, width: number, height: number) {
  const channelSize = width * height;
  const out = new Uint8ClampedArray(channelSize * 4);
  const appearsByteRange = data.some((v) => v > 1.1 || v < 0);
  const scale = appearsByteRange ? 1 : 255;

  for (let i = 0; i < channelSize; i += 1) {
    const dst = i * 4;
    out[dst] = clamp255(data[i] * scale);
    out[dst + 1] = clamp255(data[i + channelSize] * scale);
    out[dst + 2] = clamp255(data[i + channelSize * 2] * scale);
    out[dst + 3] = 255;
  }
  return out;
}

function nhwcFloatToRgbaUint8(data: Float32Array, width: number, height: number) {
  const out = new Uint8ClampedArray(width * height * 4);
  const appearsByteRange = data.some((v) => v > 1.1 || v < 0);
  const scale = appearsByteRange ? 1 : 255;

  for (let i = 0; i < width * height; i += 1) {
    const src = i * 3;
    const dst = i * 4;
    out[dst] = clamp255(data[src] * scale);
    out[dst + 1] = clamp255(data[src + 1] * scale);
    out[dst + 2] = clamp255(data[src + 2] * scale);
    out[dst + 3] = 255;
  }
  return out;
}

function nchwUint8ToRgbaUint8(data: Uint8Array, width: number, height: number) {
  const channelSize = width * height;
  const out = new Uint8ClampedArray(channelSize * 4);
  for (let i = 0; i < channelSize; i += 1) {
    const dst = i * 4;
    out[dst] = data[i];
    out[dst + 1] = data[i + channelSize];
    out[dst + 2] = data[i + channelSize * 2];
    out[dst + 3] = 255;
  }
  return out;
}

function nhwcUint8ToRgbaUint8(data: Uint8Array, width: number, height: number) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * 3;
    const dst = i * 4;
    out[dst] = data[src];
    out[dst + 1] = data[src + 1];
    out[dst + 2] = data[src + 2];
    out[dst + 3] = 255;
  }
  return out;
}

function runFallback(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
) {
  const out = new Uint8ClampedArray(pixels);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const rectW = Math.max(1, Math.floor(rect.width));
  const rectH = Math.max(1, Math.floor(rect.height));
  const x1 = Math.min(width, x0 + rectW);
  const y1 = Math.min(height, y0 + rectH);
  const iterations = Math.min(80, Math.max(24, Math.floor(Math.max(rectW, rectH) / 3)));

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (y * width + x) * 4;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
          [x - 1, y - 1],
          [x + 1, y - 1],
          [x - 1, y + 1],
          [x + 1, y + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const inRect = nx >= x0 && nx < x1 && ny >= y0 && ny < y1;
          if (iter === 0 && inRect) continue;
          const nIdx = (ny * width + nx) * 4;
          r += out[nIdx];
          g += out[nIdx + 1];
          b += out[nIdx + 2];
          count += 1;
        }
        if (count > 0) {
          out[idx] = Math.round(r / count);
          out[idx + 1] = Math.round(g / count);
          out[idx + 2] = Math.round(b / count);
          out[idx + 3] = 255;
        }
      }
    }
  }
  return out;
}

function getModelInputSize(
  session: any,
  imageName: string,
  layout: TensorLayout,
  fallbackWidth: number,
  fallbackHeight: number,
) {
  const metadata = session.inputMetadata?.[imageName];
  const dims = metadata?.dimensions as Array<number | string | null | undefined> | undefined;
  const maybeH = Number(layout === "nhwc" ? dims?.[1] : dims?.[2]);
  const maybeW = Number(layout === "nhwc" ? dims?.[2] : dims?.[3]);
  const modelHeight = Number.isFinite(maybeH) && maybeH > 0 ? maybeH : fallbackHeight;
  const modelWidth = Number.isFinite(maybeW) && maybeW > 0 ? maybeW : fallbackWidth;
  return { modelWidth, modelHeight };
}

function inferTensorLayout(
  dims: Array<number | string | null | undefined> | undefined,
  kind: "image" | "mask",
  preferNhwc = false,
): TensorLayout {
  if (!dims || dims.length < 4) return preferNhwc ? "nhwc" : "nchw";
  const second = Number(dims[1]);
  const fourth = Number(dims[3]);
  if (kind === "image") {
    if (second === 3) return "nchw";
    if (fourth === 3) return "nhwc";
    return preferNhwc ? "nhwc" : "nchw";
  }
  if (second === 1) return "nchw";
  if (fourth === 1) return "nhwc";
  return preferNhwc ? "nhwc" : "nchw";
}

function resizeRgba(
  pixels: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const srcCanvas = new OffscreenCanvas(srcWidth, srcHeight);
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) return pixels;
  srcCtx.putImageData(new ImageData(pixels, srcWidth, srcHeight), 0, 0);

  const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
  const targetCtx = targetCanvas.getContext("2d");
  if (!targetCtx) return pixels;
  targetCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
  return targetCtx.getImageData(0, 0, targetWidth, targetHeight).data;
}

function compositeInsideRect(
  original: Uint8ClampedArray,
  generated: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
) {
  const out = new Uint8ClampedArray(original);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const rectW = Math.max(1, Math.floor(rect.width));
  const rectH = Math.max(1, Math.floor(rect.height));
  const x1 = Math.min(width, x0 + rectW);
  const y1 = Math.min(height, y0 + rectH);

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width + x) * 4;
      out[idx] = generated[idx];
      out[idx + 1] = generated[idx + 1];
      out[idx + 2] = generated[idx + 2];
      out[idx + 3] = 255;
    }
  }
  return out;
}

function fillRectOnRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
  fill: number,
) {
  const out = new Uint8ClampedArray(pixels);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const rectW = Math.max(1, Math.floor(rect.width));
  const rectH = Math.max(1, Math.floor(rect.height));
  const x1 = Math.min(width, x0 + rectW);
  const y1 = Math.min(height, y0 + rectH);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width + x) * 4;
      out[idx] = fill;
      out[idx + 1] = fill;
      out[idx + 2] = fill;
      out[idx + 3] = 255;
    }
  }
  return out;
}

function hasMeaningfulChangeInRect(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const rectW = Math.max(1, Math.floor(rect.width));
  const rectH = Math.max(1, Math.floor(rect.height));
  const x1 = Math.min(width, x0 + rectW);
  const y1 = Math.min(height, y0 + rectH);

  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width + x) * 4;
      const diff =
        Math.abs(before[idx] - after[idx]) +
        Math.abs(before[idx + 1] - after[idx + 1]) +
        Math.abs(before[idx + 2] - after[idx + 2]);
      if (diff > 10) changed += 1;
      total += 1;
    }
  }
  if (total === 0) return false;
  return changed / total > 0.005;
}

function clamp255(value: number) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

function getModelSignature(session: any) {
  try {
    const inputParts = (session.inputNames ?? []).map((name: string) => {
      const dims = session.inputMetadata?.[name]?.dimensions;
      const type = session.inputMetadata?.[name]?.type;
      return `${name}:${JSON.stringify(dims)}:${type}`;
    });
    const outputParts = (session.outputNames ?? []).map((name: string) => {
      const dims = session.outputMetadata?.[name]?.dimensions;
      const type = session.outputMetadata?.[name]?.type;
      return `${name}:${JSON.stringify(dims)}:${type}`;
    });
    return `inputs=[${inputParts.join(", ")}], outputs=[${outputParts.join(", ")}]`;
  } catch {
    return "无法读取模型签名";
  }
}
