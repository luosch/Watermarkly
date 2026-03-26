<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { RouterLink } from "vue-router";
import { createInpaintClient } from "../services/inpaint/client";
import type { InpaintBackend } from "../services/inpaint/types";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const imageName = ref("");
const sourceObjectUrl = ref<string | null>(null);
const previewScale = ref(1);
const canvasWidth = ref(900);
const canvasHeight = ref(560);

const isDragOver = ref(false);
const imageLoading = ref(false);
const processing = ref(false);
const exporting = ref(false);
const modelInitializing = ref(false);
const engineBackend = ref<InpaintBackend>("fallback");
const engineMessage = ref("未初始化");

const brushMode = ref(false);
const brushSize = ref(48);
const isPainting = ref(false);
const lastPaintX = ref(0);
const lastPaintY = ref(0);
const hasBrushPaint = ref(false);
const rectMode = ref(false);
const isSelectingRect = ref(false);
const rectStartX = ref(0);
const rectStartY = ref(0);
const rectSelection = ref<{ x: number; y: number; width: number; height: number } | null>(null);

const exportFormat = ref<"png" | "jpeg">("png");
const exportQuality = ref(92);
const modelUrl = import.meta.env.VITE_INPAINT_MODEL_URL || "/models/migan_pipeline_v2.onnx";

const workingCanvas = document.createElement("canvas");
const workingCtx = workingCanvas.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const maskBuffer = ref<Uint8Array | null>(null);

const inpaintClient = createInpaintClient();

const hasImage = computed(() => workingCanvas.width > 0 && workingCanvas.height > 0);
const loadingMessage = computed(() =>
  imageLoading.value
    ? "图片加载中，请稍候..."
    : modelInitializing.value
      ? "模型初始化中，请稍候..."
      : "处理中，请稍候...",
);

function triggerFileSelect() {
  if (!imageLoading.value) fileInputRef.value?.click();
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void loadSourceImage(file);
  input.value = "";
}

function onDrop(event: DragEvent) {
  isDragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  void loadSourceImage(file);
}

async function loadSourceImage(file: File) {
  if (!file.type.startsWith("image/")) {
    alert("请选择图片文件");
    return;
  }

  imageLoading.value = true;
  const loadingStart = performance.now();
  const url = URL.createObjectURL(file);

  try {
    const image = await loadImageFromObjectUrl(url);
    if (sourceObjectUrl.value) {
      URL.revokeObjectURL(sourceObjectUrl.value);
    }
    sourceObjectUrl.value = url;
    imageName.value = file.name;

    fitImageToPreview(image.width, image.height);
    workingCanvas.width = image.width;
    workingCanvas.height = image.height;
    maskCanvas.width = image.width;
    maskCanvas.height = image.height;
    maskBuffer.value = new Uint8Array(image.width * image.height);
    if (!workingCtx || !maskCtx) throw new Error("canvas init failed");

    workingCtx.clearRect(0, 0, image.width, image.height);
    workingCtx.drawImage(image, 0, 0, image.width, image.height);
    clearBrushMask();

    await nextTick();
    drawPreview();
    if (engineMessage.value === "未初始化") void initInpaintEngine();
  } catch {
    URL.revokeObjectURL(url);
    alert("图片加载失败，请重试");
  } finally {
    await keepLoadingAtLeast(loadingStart, 450);
    imageLoading.value = false;
  }
}

async function initInpaintEngine() {
  if (modelInitializing.value) return;
  modelInitializing.value = true;
  try {
    const result = await inpaintClient.init(modelUrl);
    engineBackend.value = result.backend;
    engineMessage.value = result.message || (result.ready ? "模型就绪" : "使用降级算法");
  } catch {
    engineBackend.value = "fallback";
    engineMessage.value = "模型加载失败，使用降级算法";
  } finally {
    modelInitializing.value = false;
  }
}

function fitImageToPreview(imageWidth: number, imageHeight: number) {
  const maxW = 900;
  const maxH = 560;
  const scale = Math.min(maxW / imageWidth, maxH / imageHeight, 1);
  previewScale.value = scale;
  canvasWidth.value = Math.max(320, Math.round(imageWidth * scale));
  canvasHeight.value = Math.max(220, Math.round(imageHeight * scale));
}

function clearBrushMask() {
  if (!maskBuffer.value) return;
  maskBuffer.value.fill(0);
  hasBrushPaint.value = false;
  if (maskCtx) {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  }
  drawPreview();
}

function drawPreview() {
  if (!canvasRef.value || !hasImage.value) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = canvasWidth.value;
  canvas.height = canvasHeight.value;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(workingCanvas, 0, 0, canvas.width, canvas.height);

  if (hasBrushPaint.value) {
    ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
  }

  if (rectSelection.value) {
    const x = rectSelection.value.x * previewScale.value;
    const y = rectSelection.value.y * previewScale.value;
    const width = rectSelection.value.width * previewScale.value;
    const height = rectSelection.value.height * previewScale.value;
    ctx.save();
    ctx.fillStyle = "rgba(34, 197, 94, 0.18)";
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  }
}

function toggleBrushMode() {
  if (!hasImage.value) return;
  if (!brushMode.value) rectMode.value = false;
  brushMode.value = !brushMode.value;
}

function toggleRectMode() {
  if (!hasImage.value) return;
  if (!rectMode.value) brushMode.value = false;
  rectMode.value = !rectMode.value;
}

function clearRectSelection() {
  rectSelection.value = null;
  drawPreview();
}

function getImagePoint(event: MouseEvent) {
  if (!canvasRef.value) return { x: 0, y: 0 };
  const rect = canvasRef.value.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(workingCanvas.width - 1, (event.clientX - rect.left) / previewScale.value)),
    y: Math.max(
      0,
      Math.min(workingCanvas.height - 1, (event.clientY - rect.top) / previewScale.value),
    ),
  };
}

function onCanvasMouseDown(event: MouseEvent) {
  const point = getImagePoint(event);
  if (!hasImage.value || processing.value) return;

  if (rectMode.value) {
    isSelectingRect.value = true;
    rectStartX.value = point.x;
    rectStartY.value = point.y;
    rectSelection.value = { x: point.x, y: point.y, width: 1, height: 1 };
    drawPreview();
    return;
  }

  if (brushMode.value) {
    isPainting.value = true;
    lastPaintX.value = point.x;
    lastPaintY.value = point.y;
    paintBrush(point.x, point.y);
  }
}

function onCanvasMouseMove(event: MouseEvent) {
  const point = getImagePoint(event);
  if (!hasImage.value) return;

  if (isSelectingRect.value) {
    const x = Math.min(rectStartX.value, point.x);
    const y = Math.min(rectStartY.value, point.y);
    const width = Math.max(1, Math.abs(point.x - rectStartX.value));
    const height = Math.max(1, Math.abs(point.y - rectStartY.value));
    rectSelection.value = { x, y, width, height };
    drawPreview();
    return;
  }

  if (isPainting.value) {
    paintLine(lastPaintX.value, lastPaintY.value, point.x, point.y);
    lastPaintX.value = point.x;
    lastPaintY.value = point.y;
  }
}

function onCanvasMouseUp() {
  isPainting.value = false;
  isSelectingRect.value = false;
}

function paintLine(x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance < 1) {
    paintBrush(x1, y1);
    return;
  }

  for (let i = 0; i <= distance; i += 1) {
    const t = i / distance;
    paintBrush(x0 + dx * t, y0 + dy * t);
  }
}

function paintBrush(cx: number, cy: number) {
  if (!maskBuffer.value || !maskCtx) return;
  const radius = Math.max(2, Math.floor(brushSize.value / 2));
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(workingCanvas.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(workingCanvas.height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      maskBuffer.value[y * workingCanvas.width + x] = 255;
    }
  }
  hasBrushPaint.value = true;
  maskCtx.save();
  maskCtx.fillStyle = "rgba(59, 130, 246, 0.55)";
  maskCtx.beginPath();
  maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.restore();
  drawPreview();
}

function hasMaskPainted() {
  return hasBrushPaint.value;
}

function hasRectSelection() {
  return !!rectSelection.value && rectSelection.value.width > 0 && rectSelection.value.height > 0;
}

function buildRunMask() {
  const mask = new Uint8Array(workingCanvas.width * workingCanvas.height);
  if (maskBuffer.value) {
    mask.set(maskBuffer.value);
  }

  if (rectSelection.value) {
    const x0 = Math.max(0, Math.floor(rectSelection.value.x));
    const y0 = Math.max(0, Math.floor(rectSelection.value.y));
    const x1 = Math.min(workingCanvas.width, Math.ceil(rectSelection.value.x + rectSelection.value.width));
    const y1 = Math.min(
      workingCanvas.height,
      Math.ceil(rectSelection.value.y + rectSelection.value.height),
    );
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        mask[y * workingCanvas.width + x] = 255;
      }
    }
  }
  return mask;
}

async function removeSelectionWatermark() {
  if (!workingCtx || !maskBuffer.value || processing.value) return;
  if (!hasMaskPainted() && !hasRectSelection()) {
    alert("请先用画笔或矩形选取要去除的区域");
    return;
  }

  processing.value = true;
  const start = performance.now();

  try {
    const imageData = workingCtx.getImageData(0, 0, workingCanvas.width, workingCanvas.height);
    const result = await inpaintClient.run(imageData, buildRunMask());
    const outputPixels = new Uint8ClampedArray(result.pixels);
    const output = new ImageData(outputPixels, result.width, result.height);
    workingCtx.putImageData(output, 0, 0);
    engineBackend.value = result.backend;
    engineMessage.value =
      result.message ||
      (result.backend === "webgpu"
        ? "当前使用 WebGPU 推理"
        : result.backend === "wasm"
          ? "当前使用 WASM 推理"
          : "当前使用降级算法");

    clearBrushMask();
    clearRectSelection();
    brushMode.value = false;
    rectMode.value = false;
    drawPreview();
  } finally {
    await keepLoadingAtLeast(start, 350);
    processing.value = false;
  }
}

function exportImage() {
  if (!hasImage.value || exporting.value) return;
  exporting.value = true;

  const mimeType = exportFormat.value === "png" ? "image/png" : "image/jpeg";
  const quality = exportFormat.value === "png" ? 1 : exportQuality.value / 100;
  const filenameBase = imageName.value.replace(/\.[^.]+$/, "") || "watermarkly";

  workingCanvas.toBlob(
    (blob) => {
      if (!blob) {
        exporting.value = false;
        alert("导出失败，请重试");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}-remove-watermark.${exportFormat.value === "png" ? "png" : "jpg"}`;
      a.click();
      URL.revokeObjectURL(url);
      exporting.value = false;
    },
    mimeType,
    quality,
  );
}

function loadImageFromObjectUrl(url: string) {
  const img = new Image();
  img.decoding = "async";
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => {
      if (!img.width || !img.height) {
        reject(new Error("invalid image"));
        return;
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

async function keepLoadingAtLeast(startAt: number, minimumMs: number) {
  const elapsed = performance.now() - startAt;
  if (elapsed >= minimumMs) return;
  await new Promise((resolve) => setTimeout(resolve, minimumMs - elapsed));
}

onBeforeUnmount(() => {
  if (sourceObjectUrl.value) URL.revokeObjectURL(sourceObjectUrl.value);
  inpaintClient.destroy();
});
</script>

<template>
  <div class="editor-page">
    <header class="editor-header">
      <div>
        <p class="editor-badge">Editor</p>
        <h1 class="editor-title">去除水印</h1>
      </div>
      <RouterLink class="back-link" to="/">返回首页</RouterLink>
    </header>

    <main class="editor-main remove-layout">
      <section class="editor-canvas-wrap">
        <div class="editor-toolbar">
          <button class="primary-btn" type="button" :disabled="imageLoading" @click="triggerFileSelect">
            {{ imageLoading ? "加载中..." : "添加图片" }}
          </button>
          <button class="secondary-btn" type="button" :disabled="!hasImage || processing" @click="toggleBrushMode">
            {{ brushMode ? "结束涂抹" : "画笔涂抹" }}
          </button>
          <button class="secondary-btn" type="button" :disabled="!hasImage || processing" @click="toggleRectMode">
            {{ rectMode ? "结束矩形选取" : "矩形选取" }}
          </button>
          <button class="secondary-btn" type="button" :disabled="!hasImage || processing" @click="clearBrushMask">
            清空涂抹
          </button>
          <button class="secondary-btn" type="button" :disabled="!hasImage || processing" @click="clearRectSelection">
            清空矩形
          </button>
          <button
            class="secondary-btn"
            type="button"
            :disabled="!hasImage || processing || (!hasMaskPainted() && !hasRectSelection())"
            @click="removeSelectionWatermark"
          >
            {{ processing ? "处理中..." : "去掉选中区域水印" }}
          </button>
          <input
            ref="fileInputRef"
            class="hidden-input"
            type="file"
            accept="image/*"
            @change="onFileSelected"
          />
        </div>

        <div class="brush-row">
          <label class="field brush-field">
            <span>画笔大小（{{ brushSize }}）</span>
            <input v-model.number="brushSize" type="range" min="8" max="200" step="1" />
          </label>
        </div>

        <div
          class="dropzone"
          :class="{
            dragging: isDragOver,
            loading: imageLoading || processing || modelInitializing,
            selecting: brushMode,
          }"
          @dragenter.prevent="isDragOver = true"
          @dragover.prevent="isDragOver = true"
          @dragleave.prevent="isDragOver = false"
          @drop.prevent="onDrop"
        >
          <div v-if="imageLoading || processing || modelInitializing" class="loading-mask">
            <div class="loading-dot" />
            <p>{{ loadingMessage }}</p>
          </div>

          <template v-if="!hasImage">
            <p class="dropzone-title">把图片拖入区域中添加</p>
            <p class="dropzone-subtitle">或点击上方“添加图片”按钮选择文件</p>
          </template>

          <template v-else>
            <canvas
              ref="canvasRef"
              class="preview-canvas"
              :class="{ selecting: brushMode || rectMode }"
              :width="canvasWidth"
              :height="canvasHeight"
              @mousedown="onCanvasMouseDown"
              @mousemove="onCanvasMouseMove"
              @mouseup="onCanvasMouseUp"
              @mouseleave="onCanvasMouseUp"
            />
          </template>
        </div>
      </section>

      <aside class="editor-panel">
        <p class="sidebar-title">推理引擎</p>
        <div class="engine-card">
          <p class="engine-backend">后端：{{ engineBackend.toUpperCase() }}</p>
          <p class="engine-message">{{ engineMessage }}</p>
        </div>

        <hr class="panel-divider" />

        <p class="sidebar-title">操作说明</p>
        <ol class="help-list">
          <li>添加图片或拖拽图片到画布区域。</li>
          <li>点击“画笔涂抹”或“矩形选取”，选择要去除的区域。</li>
          <li>点击“去掉选中区域水印”执行处理。</li>
          <li>处理完成后会自动清空选取层，可继续下一次处理。</li>
        </ol>

        <hr class="panel-divider" />

        <p class="sidebar-title">导出</p>
        <div class="form-grid">
          <label class="field">
            <span>导出格式</span>
            <select v-model="exportFormat">
              <option value="png">PNG</option>
              <option value="jpeg">JPG</option>
            </select>
          </label>

          <label v-if="exportFormat === 'jpeg'" class="field">
            <span>JPG 质量（{{ exportQuality }}）</span>
            <input v-model.number="exportQuality" type="range" min="40" max="100" step="1" />
          </label>

          <button class="primary-btn" type="button" :disabled="!hasImage || exporting" @click="exportImage">
            {{ exporting ? "导出中..." : "导出图片" }}
          </button>
        </div>
      </aside>
    </main>
  </div>
</template>
