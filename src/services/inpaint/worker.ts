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
      const output = await runInpaint(
        payload.pixels,
        payload.width,
        payload.height,
        payload.rect,
      );
      const response: InpaintWorkerResponse = {
        id: payload.id,
        type: "run",
        width: payload.width,
        height: payload.height,
        pixels: output,
        backend: state.backend,
      };
      ctx.postMessage(response, [output.buffer]);
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
      return await runWithOrt(pixels, width, height, rect, state.session);
    } catch {
      state.backend = "fallback";
      state.session = null;
      state.ready = false;
    }
  }
  return runFallback(pixels, width, height, rect);
}

async function runWithOrt(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: InpaintRect,
  session: any,
) {
  const inputImage = rgbaToNchwFloat32(pixels, width, height);
  const inputMask = createMaskTensor(width, height, rect);

  const imageName = session.inputNames[0];
  const maskName = session.inputNames[1];
  if (!imageName || !maskName) {
    throw new Error("模型输入不匹配");
  }

  const feeds: Record<string, ortWasm.Tensor | ortWebGpu.Tensor> = {
    [imageName]: new ortWasm.Tensor("float32", inputImage, [1, 3, height, width]),
    [maskName]: new ortWasm.Tensor("float32", inputMask, [1, 1, height, width]),
  };

  const result = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = result[outputName];
  if (!output) {
    throw new Error("模型输出为空");
  }

  const data = output.data as Float32Array;
  return nchwToRgbaUint8(data, width, height);
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

function createMaskTensor(width: number, height: number, rect: InpaintRect) {
  const out = new Float32Array(width * height);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const size = Math.max(1, Math.floor(rect.size));
  const x1 = Math.min(width, x0 + size);
  const y1 = Math.min(height, y0 + size);

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      out[y * width + x] = 1;
    }
  }

  return out;
}

function nchwToRgbaUint8(data: Float32Array, width: number, height: number) {
  const channelSize = width * height;
  const out = new Uint8ClampedArray(channelSize * 4);

  const looksNormalized = data.some((v) => v > 1.1 || v < 0);
  const scale = looksNormalized ? 255 : 1;

  for (let i = 0; i < channelSize; i += 1) {
    const r = clamp255(data[i] * scale);
    const g = clamp255(data[i + channelSize] * scale);
    const b = clamp255(data[i + channelSize * 2] * scale);
    const dst = i * 4;
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
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
  const size = Math.max(1, Math.floor(rect.size));
  const x1 = Math.min(width, x0 + size);
  const y1 = Math.min(height, y0 + size);

  const iterations = Math.min(80, Math.max(24, Math.floor(size / 3)));

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

function clamp255(value: number) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}
