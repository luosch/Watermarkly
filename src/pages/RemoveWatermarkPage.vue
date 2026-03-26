<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { RouterLink } from "vue-router";
import { createInpaintClient } from "../services/inpaint/client";
import type { InpaintBackend } from "../services/inpaint/types";

type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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

const selectionMode = ref(false);
const isSelecting = ref(false);
const selection = ref<SelectionRect | null>(null);
const selectionStartX = ref(0);
const selectionStartY = ref(0);

const exportFormat = ref<"png" | "jpeg">("png");
const exportQuality = ref(92);
const modelUrl = import.meta.env.VITE_INPAINT_MODEL_URL || "/models/migan_pipeline_v2.onnx";

const workingCanvas = document.createElement("canvas");
const workingCtx = workingCanvas.getContext("2d");
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
    if (!workingCtx) throw new Error("canvas init failed");
    workingCtx.clearRect(0, 0, image.width, image.height);
    workingCtx.drawImage(image, 0, 0, image.width, image.height);

    selection.value = null;
    selectionMode.value = false;
    await nextTick();
    drawPreview();

    if (engineMessage.value === "未初始化") {
      void initInpaintEngine();
    }
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

function drawPreview() {
  if (!canvasRef.value || !hasImage.value) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = canvasWidth.value;
  canvas.height = canvasHeight.value;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(workingCanvas, 0, 0, canvas.width, canvas.height);

  if (selection.value) {
    const x = selection.value.x * previewScale.value;
    const y = selection.value.y * previewScale.value;
    const width = selection.value.width * previewScale.value;
    const height = selection.value.height * previewScale.value;
    ctx.save();
    ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  }
}

function toggleSelectionMode() {
  if (!hasImage.value) return;
  selectionMode.value = !selectionMode.value;
}

function getImagePoint(event: MouseEvent) {
  if (!canvasRef.value) return { x: 0, y: 0 };
  const rect = canvasRef.value.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(workingCanvas.width, (event.clientX - rect.left) / previewScale.value)),
    y: Math.max(
      0,
      Math.min(workingCanvas.height, (event.clientY - rect.top) / previewScale.value),
    ),
  };
}

function onCanvasMouseDown(event: MouseEvent) {
  if (!selectionMode.value || !hasImage.value || processing.value) return;
  const point = getImagePoint(event);
  isSelecting.value = true;
  selectionStartX.value = point.x;
  selectionStartY.value = point.y;
  selection.value = { x: point.x, y: point.y, width: 1, height: 1 };
  drawPreview();
}

function onCanvasMouseMove(event: MouseEvent) {
  if (!isSelecting.value || !hasImage.value) return;
  const point = getImagePoint(event);
  const dx = point.x - selectionStartX.value;
  const dy = point.y - selectionStartY.value;

  const x = Math.min(selectionStartX.value, point.x);
  const y = Math.min(selectionStartY.value, point.y);
  const rawWidth = Math.abs(dx);
  const rawHeight = Math.abs(dy);

  const clampedX = Math.max(0, Math.min(workingCanvas.width - 1, x));
  const clampedY = Math.max(0, Math.min(workingCanvas.height - 1, y));
  const width = Math.max(1, Math.min(rawWidth, workingCanvas.width - clampedX));
  const height = Math.max(1, Math.min(rawHeight, workingCanvas.height - clampedY));

  selection.value = {
    x: clampedX,
    y: clampedY,
    width,
    height,
  };
  drawPreview();
}

function onCanvasMouseUp() {
  isSelecting.value = false;
}

async function removeSelectionWatermark() {
  if (!workingCtx || !selection.value || processing.value) return;
  processing.value = true;
  const start = performance.now();

  try {
    const imageData = workingCtx.getImageData(0, 0, workingCanvas.width, workingCanvas.height);
    const result = await inpaintClient.run(imageData, selection.value);
    const output = new ImageData(result.pixels, result.width, result.height);
    workingCtx.putImageData(output, 0, 0);
    engineBackend.value = result.backend;
    engineMessage.value =
      result.message ||
      (result.backend === "webgpu"
        ? "当前使用 WebGPU 推理"
        : result.backend === "wasm"
          ? "当前使用 WASM 推理"
          : "当前使用降级算法");
    drawPreview();
  } finally {
    await keepLoadingAtLeast(start, 350);
    processing.value = false;
    selectionMode.value = false;
    selection.value = null;
    drawPreview();
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
  if (sourceObjectUrl.value) {
    URL.revokeObjectURL(sourceObjectUrl.value);
  }
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
          <button
            class="secondary-btn"
            type="button"
            :disabled="!hasImage || processing"
            @click="toggleSelectionMode"
          >
            {{ selectionMode ? "取消选区" : "选择矩形区域" }}
          </button>
          <button
            class="secondary-btn"
            type="button"
            :disabled="!selection || processing"
            @click="removeSelectionWatermark"
          >
            {{ processing ? "处理中..." : "去掉选区水印" }}
          </button>
          <input
            ref="fileInputRef"
            class="hidden-input"
            type="file"
            accept="image/*"
            @change="onFileSelected"
          />
        </div>

        <div
          class="dropzone"
          :class="{
            dragging: isDragOver,
            loading: imageLoading || processing || modelInitializing,
            selecting: selectionMode,
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
              :class="{ selecting: selectionMode }"
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
          <li>点击“选择矩形区域”，在图片上拖拽出矩形选区。</li>
          <li>点击“去掉选区水印”执行处理。</li>
          <li>处理完成后可继续选区，最后导出图片。</li>
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
