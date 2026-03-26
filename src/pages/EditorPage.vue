<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";

type ToolType = "text" | "image" | "remove";
type LayerType = "text" | "image";

type TextLayer = {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  opacity: number;
  rotation: number;
};

type ImageLayer = {
  id: string;
  type: "image";
  name: string;
  x: number;
  y: number;
  baseWidth: number;
  baseHeight: number;
  scale: number;
  opacity: number;
  rotation: number;
  image: HTMLImageElement;
  objectUrl: string;
};

type ActiveLayer = {
  type: LayerType;
  id: string;
};

const route = useRoute();

const requestedTool = computed<ToolType>(() => {
  const tool = route.query.tool;
  if (tool === "text" || tool === "image" || tool === "remove") return tool;
  return "text";
});

const currentToolLabel = computed(() => {
  if (requestedTool.value === "image") return "加图片水印";
  if (requestedTool.value === "remove") return "去除水印";
  return "加文字水印";
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
const sourceInputRef = ref<HTMLInputElement | null>(null);
const watermarkInputRef = ref<HTMLInputElement | null>(null);

const imageEl = ref<HTMLImageElement | null>(null);
const imageName = ref("");
const sourceObjectUrl = ref<string | null>(null);

const canvasWidth = ref(900);
const canvasHeight = ref(560);
const previewScale = ref(1);

const isDragOver = ref(false);
const imageLoading = ref(false);
const layerLoading = ref(false);
const exporting = ref(false);

const textLayers = ref<TextLayer[]>([]);
const imageLayers = ref<ImageLayer[]>([]);
const activeLayer = ref<ActiveLayer | null>(null);

const exportFormat = ref<"png" | "jpeg">("png");
const exportQuality = ref(92);

const draggingLayer = ref<ActiveLayer | null>(null);
const dragOffsetX = ref(0);
const dragOffsetY = ref(0);

const hasImage = computed(() => imageEl.value !== null);
const isTextTool = computed(() => requestedTool.value === "text");
const isImageTool = computed(() => requestedTool.value === "image");
const isRemoveTool = computed(() => requestedTool.value === "remove");
const loadingMessage = computed(() => {
  if (imageLoading.value) return "图片加载中，请稍候...";
  if (layerLoading.value) return "水印图层加载中，请稍候...";
  return "";
});

const selectedTextLayer = computed(() => {
  if (activeLayer.value?.type !== "text") return null;
  return textLayers.value.find((layer) => layer.id === activeLayer.value?.id) ?? null;
});

const selectedImageLayer = computed(() => {
  if (activeLayer.value?.type !== "image") return null;
  return imageLayers.value.find((layer) => layer.id === activeLayer.value?.id) ?? null;
});

function fitImageToCanvas(imageWidth: number, imageHeight: number) {
  const maxW = 900;
  const maxH = 560;
  const scale = Math.min(maxW / imageWidth, maxH / imageHeight, 1);
  previewScale.value = scale;
  canvasWidth.value = Math.max(320, Math.round(imageWidth * scale));
  canvasHeight.value = Math.max(220, Math.round(imageHeight * scale));
}

function createLayerId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function triggerSourceSelect() {
  if (!imageLoading.value) sourceInputRef.value?.click();
}

function triggerWatermarkSelect() {
  if (!layerLoading.value && hasImage.value) watermarkInputRef.value?.click();
}

function onSourceSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void loadSourceImage(file);
  input.value = "";
}

function onWatermarkSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void addImageLayerFromFile(file);
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
    const img = await loadImageFromObjectUrl(url);

    if (sourceObjectUrl.value) {
      URL.revokeObjectURL(sourceObjectUrl.value);
    }

    clearImageLayers();
    sourceObjectUrl.value = url;
    imageEl.value = img;
    imageName.value = file.name;

    fitImageToCanvas(img.width, img.height);
    textLayers.value = [];
    activeLayer.value = null;
    await nextTick();
    drawPreview();
  } catch {
    URL.revokeObjectURL(url);
    alert("图片加载失败，请重试");
  } finally {
    await keepLoadingAtLeast(loadingStart, 500);
    imageLoading.value = false;
  }
}

async function addImageLayerFromFile(file: File) {
  if (!hasImage.value || !imageEl.value) return;
  if (!file.type.startsWith("image/")) {
    alert("请选择图片文件");
    return;
  }

  layerLoading.value = true;
  const loadingStart = performance.now();
  const url = URL.createObjectURL(file);

  try {
    const wmImage = await loadImageFromObjectUrl(url);
    const targetBaseWidth = Math.max(120, Math.round(imageEl.value.width * 0.28));
    const ratio = wmImage.height / wmImage.width;
    const layer: ImageLayer = {
      id: createLayerId(),
      type: "image",
      name: file.name,
      x: Math.round(imageEl.value.width / 2),
      y: Math.round(imageEl.value.height / 2),
      baseWidth: targetBaseWidth,
      baseHeight: Math.round(targetBaseWidth * ratio),
      scale: 1,
      opacity: 1,
      rotation: 0,
      image: wmImage,
      objectUrl: url,
    };

    imageLayers.value.push(layer);
    activeLayer.value = { type: "image", id: layer.id };
    drawPreview();
  } catch {
    URL.revokeObjectURL(url);
    alert("水印图层加载失败，请重试");
  } finally {
    await keepLoadingAtLeast(loadingStart, 350);
    layerLoading.value = false;
  }
}

function addTextLayer() {
  if (!imageEl.value) return;

  const imageWidth = imageEl.value.width;
  const imageHeight = imageEl.value.height;
  const offset = textLayers.value.length * 18;

  const layer: TextLayer = {
    id: createLayerId(),
    type: "text",
    text: "Watermarkly",
    x: Math.round(imageWidth / 2 + offset),
    y: Math.round(imageHeight / 2 + offset),
    fontSize: 160,
    fontFamily: "Arial",
    color: "#ffffff",
    opacity: 1,
    rotation: 0,
  };

  textLayers.value.push(layer);
  activeLayer.value = { type: "text", id: layer.id };
  drawPreview();
}

function onAddLayerClick() {
  if (!hasImage.value) return;
  if (isImageTool.value) {
    triggerWatermarkSelect();
    return;
  }
  addTextLayer();
}

function updateSelectedTextLayer(patch: Partial<TextLayer>) {
  if (!selectedTextLayer.value) return;
  Object.assign(selectedTextLayer.value, patch);
  drawPreview();
}

function updateSelectedImageLayer(patch: Partial<ImageLayer>) {
  if (!selectedImageLayer.value) return;
  Object.assign(selectedImageLayer.value, patch);
  drawPreview();
}

function removeActiveLayer() {
  if (!activeLayer.value) return;
  if (activeLayer.value.type === "text") {
    textLayers.value = textLayers.value.filter((layer) => layer.id !== activeLayer.value?.id);
  } else {
    const target = imageLayers.value.find((layer) => layer.id === activeLayer.value?.id);
    if (target) URL.revokeObjectURL(target.objectUrl);
    imageLayers.value = imageLayers.value.filter((layer) => layer.id !== activeLayer.value?.id);
  }
  activeLayer.value = null;
  drawPreview();
}

function drawPreview() {
  if (!canvasRef.value || !imageEl.value) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = canvasWidth.value;
  canvas.height = canvasHeight.value;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imageEl.value, 0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(previewScale.value, previewScale.value);

  for (const layer of textLayers.value) {
    drawTextLayer(ctx, layer, isActiveLayer(layer), true);
  }
  for (const layer of imageLayers.value) {
    drawImageLayer(ctx, layer, isActiveLayer(layer), true);
  }

  ctx.restore();
}

function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  isActive: boolean,
  showSelection: boolean,
) {
  ctx.save();
  ctx.translate(layer.x, layer.y);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.globalAlpha = layer.opacity;
  ctx.fillStyle = layer.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${layer.fontSize}px ${layer.fontFamily}`;
  ctx.fillText(layer.text, 0, 0);
  ctx.globalAlpha = 1;

  if (isActive && showSelection) {
    const textWidth = ctx.measureText(layer.text).width;
    const boxPadding = 8;
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.25 / previewScale.value;
    ctx.strokeRect(
      -textWidth / 2 - boxPadding,
      -layer.fontSize / 2 - boxPadding,
      textWidth + boxPadding * 2,
      layer.fontSize + boxPadding * 2,
    );
  }

  ctx.restore();
}

function drawImageLayer(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer,
  isActive: boolean,
  showSelection: boolean,
) {
  const width = layer.baseWidth * layer.scale;
  const height = layer.baseHeight * layer.scale;

  ctx.save();
  ctx.translate(layer.x, layer.y);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.globalAlpha = layer.opacity;
  ctx.drawImage(layer.image, -width / 2, -height / 2, width, height);
  ctx.globalAlpha = 1;

  if (isActive && showSelection) {
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.25 / previewScale.value;
    ctx.strokeRect(-width / 2, -height / 2, width, height);
  }

  ctx.restore();
}

function isActiveLayer(layer: TextLayer | ImageLayer) {
  return activeLayer.value?.id === layer.id && activeLayer.value?.type === layer.type;
}

function getImagePoint(event: MouseEvent) {
  if (!canvasRef.value) return { x: 0, y: 0 };
  const rect = canvasRef.value.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / previewScale.value,
    y: (event.clientY - rect.top) / previewScale.value,
  };
}

function pickLayerAtPoint(x: number, y: number): ActiveLayer | null {
  if (!canvasRef.value) return null;
  const ctx = canvasRef.value.getContext("2d");
  if (!ctx) return null;

  for (let i = imageLayers.value.length - 1; i >= 0; i -= 1) {
    const layer = imageLayers.value[i];
    const relative = toLayerLocalPoint(x, y, layer.x, layer.y, layer.rotation);
    const halfW = (layer.baseWidth * layer.scale) / 2 + 8;
    const halfH = (layer.baseHeight * layer.scale) / 2 + 8;
    if (Math.abs(relative.x) <= halfW && Math.abs(relative.y) <= halfH) {
      return { type: "image", id: layer.id };
    }
  }

  for (let i = textLayers.value.length - 1; i >= 0; i -= 1) {
    const layer = textLayers.value[i];
    ctx.save();
    ctx.font = `${layer.fontSize}px ${layer.fontFamily}`;
    const width = ctx.measureText(layer.text).width;
    ctx.restore();
    const relative = toLayerLocalPoint(x, y, layer.x, layer.y, layer.rotation);
    const halfW = width / 2 + 10;
    const halfH = layer.fontSize / 2 + 10;
    if (Math.abs(relative.x) <= halfW && Math.abs(relative.y) <= halfH) {
      return { type: "text", id: layer.id };
    }
  }

  return null;
}

function toLayerLocalPoint(
  x: number,
  y: number,
  layerX: number,
  layerY: number,
  rotation: number,
) {
  const dx = x - layerX;
  const dy = y - layerY;
  const rad = (-rotation * Math.PI) / 180;
  return {
    x: dx * Math.cos(rad) - dy * Math.sin(rad),
    y: dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

function onCanvasMouseDown(event: MouseEvent) {
  if (!hasImage.value) return;
  const point = getImagePoint(event);
  const picked = pickLayerAtPoint(point.x, point.y);

  if (!picked) {
    activeLayer.value = null;
    drawPreview();
    return;
  }

  activeLayer.value = picked;
  draggingLayer.value = picked;
  const target = getLayerByActive(picked);
  if (target) {
    dragOffsetX.value = point.x - target.x;
    dragOffsetY.value = point.y - target.y;
  }
  drawPreview();
}

function onCanvasMouseMove(event: MouseEvent) {
  if (!draggingLayer.value || !imageEl.value) return;
  const target = getLayerByActive(draggingLayer.value);
  if (!target) return;

  const point = getImagePoint(event);
  target.x = Math.max(0, Math.min(imageEl.value.width, point.x - dragOffsetX.value));
  target.y = Math.max(0, Math.min(imageEl.value.height, point.y - dragOffsetY.value));
  drawPreview();
}

function stopDragging() {
  draggingLayer.value = null;
}

function getLayerByActive(active: ActiveLayer) {
  if (active.type === "text") {
    return textLayers.value.find((layer) => layer.id === active.id) ?? null;
  }
  return imageLayers.value.find((layer) => layer.id === active.id) ?? null;
}

function exportImage() {
  if (!imageEl.value || exporting.value) return;
  exporting.value = true;

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = imageEl.value.width;
  exportCanvas.height = imageEl.value.height;
  const ctx = exportCanvas.getContext("2d");

  if (!ctx) {
    exporting.value = false;
    alert("导出失败，请重试");
    return;
  }

  ctx.drawImage(imageEl.value, 0, 0, exportCanvas.width, exportCanvas.height);
  for (const layer of textLayers.value) {
    drawTextLayer(ctx, layer, false, false);
  }
  for (const layer of imageLayers.value) {
    drawImageLayer(ctx, layer, false, false);
  }

  const mimeType = exportFormat.value === "png" ? "image/png" : "image/jpeg";
  const quality = exportFormat.value === "png" ? 1 : exportQuality.value / 100;
  const suffix = isImageTool.value ? "image-watermark" : "text-watermark";
  const filenameBase = imageName.value.replace(/\.[^.]+$/, "") || "watermarkly";

  exportCanvas.toBlob(
    (blob) => {
      if (!blob) {
        exporting.value = false;
        alert("导出失败，请重试");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}-${suffix}.${exportFormat.value === "png" ? "png" : "jpg"}`;
      a.click();
      URL.revokeObjectURL(url);
      exporting.value = false;
    },
    mimeType,
    quality,
  );
}

function clearImageLayers() {
  for (const layer of imageLayers.value) {
    URL.revokeObjectURL(layer.objectUrl);
  }
  imageLayers.value = [];
}

async function keepLoadingAtLeast(startAt: number, minimumMs: number) {
  const elapsed = performance.now() - startAt;
  if (elapsed >= minimumMs) return;
  await new Promise((resolve) => setTimeout(resolve, minimumMs - elapsed));
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

onBeforeUnmount(() => {
  if (sourceObjectUrl.value) {
    URL.revokeObjectURL(sourceObjectUrl.value);
  }
  clearImageLayers();
});
</script>

<template>
  <div class="editor-page">
    <header class="editor-header">
      <div>
        <p class="editor-badge">Editor</p>
        <h1 class="editor-title">{{ currentToolLabel }}</h1>
        <p v-if="isRemoveTool" class="editor-tip">
          当前版本先专注加文字水印和加图片水印，去除水印功能后续开发。
        </p>
      </div>
      <RouterLink class="back-link" to="/">返回首页</RouterLink>
    </header>

    <main class="editor-main">
      <section class="editor-canvas-wrap">
        <div class="editor-toolbar">
          <button
            class="primary-btn"
            type="button"
            :disabled="imageLoading"
            @click="triggerSourceSelect"
          >
            {{ imageLoading ? "加载中..." : "添加图片" }}
          </button>
          <button
            class="secondary-btn"
            type="button"
            :disabled="!hasImage || layerLoading || isRemoveTool"
            @click="onAddLayerClick"
          >
            {{
              isImageTool
                ? (layerLoading ? "水印加载中..." : "添加图片水印图层")
                : "添加文字图层"
            }}
          </button>

          <input
            ref="sourceInputRef"
            class="hidden-input"
            type="file"
            accept="image/*"
            @change="onSourceSelected"
          />
          <input
            ref="watermarkInputRef"
            class="hidden-input"
            type="file"
            accept="image/*"
            @change="onWatermarkSelected"
          />
        </div>

        <div
          class="dropzone"
          :class="{ dragging: isDragOver, loading: imageLoading || layerLoading }"
          @dragenter.prevent="isDragOver = true"
          @dragover.prevent="isDragOver = true"
          @dragleave.prevent="isDragOver = false"
          @drop.prevent="onDrop"
        >
          <div v-if="imageLoading || layerLoading" class="loading-mask">
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
              :width="canvasWidth"
              :height="canvasHeight"
              @mousedown="onCanvasMouseDown"
              @mousemove="onCanvasMouseMove"
              @mouseup="stopDragging"
              @mouseleave="stopDragging"
            />
          </template>
        </div>
      </section>

      <aside class="editor-panel">
        <p class="sidebar-title">{{ isImageTool ? "图片水印图层编辑" : "文字图层编辑" }}</p>
        <div v-if="!hasImage" class="panel-empty">请先上传图片后再添加图层。</div>

        <template v-else-if="isTextTool">
          <div class="layer-list">
            <button
              v-for="(layer, index) in textLayers"
              :key="layer.id"
              class="layer-item"
              :class="{ active: activeLayer?.type === 'text' && layer.id === activeLayer.id }"
              type="button"
              @click="activeLayer = { type: 'text', id: layer.id }"
            >
              图层 {{ index + 1 }}：{{ layer.text || "未命名文字" }}
            </button>
          </div>

          <div v-if="selectedTextLayer" class="form-grid">
            <label class="field">
              <span>文字内容</span>
              <input
                :value="selectedTextLayer.text"
                type="text"
                @input="
                  updateSelectedTextLayer({ text: ($event.target as HTMLInputElement).value })
                "
              />
            </label>

            <label class="field">
              <span>字体</span>
              <select
                :value="selectedTextLayer.fontFamily"
                @change="
                  updateSelectedTextLayer({
                    fontFamily: ($event.target as HTMLSelectElement).value,
                  })
                "
              >
                <option value="Arial">Arial</option>
                <option value="Verdana">Verdana</option>
                <option value="Georgia">Georgia</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Courier New">Courier New</option>
              </select>
            </label>

            <label class="field">
              <span>字体大小（{{ selectedTextLayer.fontSize }}）</span>
              <input
                :value="selectedTextLayer.fontSize"
                type="range"
                min="16"
                max="320"
                step="1"
                @input="
                  updateSelectedTextLayer({
                    fontSize: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
            </label>

            <label class="field">
              <span>透明度（{{ Math.round(selectedTextLayer.opacity * 100) }}%）</span>
              <input
                :value="Math.round(selectedTextLayer.opacity * 100)"
                type="range"
                min="5"
                max="100"
                step="1"
                @input="
                  updateSelectedTextLayer({
                    opacity: Number(($event.target as HTMLInputElement).value) / 100,
                  })
                "
              />
            </label>

            <label class="field">
              <span>旋转角度（{{ selectedTextLayer.rotation }}°）</span>
              <input
                :value="selectedTextLayer.rotation"
                type="range"
                min="-180"
                max="180"
                step="1"
                @input="
                  updateSelectedTextLayer({
                    rotation: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
            </label>

            <label class="field">
              <span>文字颜色</span>
              <input
                :value="selectedTextLayer.color"
                type="color"
                @input="
                  updateSelectedTextLayer({ color: ($event.target as HTMLInputElement).value })
                "
              />
            </label>

            <button class="danger-btn" type="button" @click="removeActiveLayer">
              删除当前图层
            </button>
          </div>

          <div v-else class="panel-empty">请先点击“添加文字图层”。</div>
        </template>

        <template v-else-if="isImageTool">
          <div class="layer-list">
            <button
              v-for="(layer, index) in imageLayers"
              :key="layer.id"
              class="layer-item"
              :class="{ active: activeLayer?.type === 'image' && layer.id === activeLayer.id }"
              type="button"
              @click="activeLayer = { type: 'image', id: layer.id }"
            >
              图层 {{ index + 1 }}：{{ layer.name }}
            </button>
          </div>

          <div v-if="selectedImageLayer" class="form-grid">
            <label class="field">
              <span>缩放（{{ Math.round(selectedImageLayer.scale * 100) }}%）</span>
              <input
                :value="Math.round(selectedImageLayer.scale * 100)"
                type="range"
                min="10"
                max="320"
                step="1"
                @input="
                  updateSelectedImageLayer({
                    scale: Number(($event.target as HTMLInputElement).value) / 100,
                  })
                "
              />
            </label>

            <label class="field">
              <span>透明度（{{ Math.round(selectedImageLayer.opacity * 100) }}%）</span>
              <input
                :value="Math.round(selectedImageLayer.opacity * 100)"
                type="range"
                min="5"
                max="100"
                step="1"
                @input="
                  updateSelectedImageLayer({
                    opacity: Number(($event.target as HTMLInputElement).value) / 100,
                  })
                "
              />
            </label>

            <label class="field">
              <span>旋转角度（{{ selectedImageLayer.rotation }}°）</span>
              <input
                :value="selectedImageLayer.rotation"
                type="range"
                min="-180"
                max="180"
                step="1"
                @input="
                  updateSelectedImageLayer({
                    rotation: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
            </label>

            <button class="danger-btn" type="button" @click="removeActiveLayer">
              删除当前图层
            </button>
          </div>

          <div v-else class="panel-empty">请先点击“添加图片水印图层”。</div>
        </template>

        <template v-else>
          <div class="panel-empty">去除水印功能待开发。</div>
        </template>

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

          <button
            class="primary-btn"
            type="button"
            :disabled="!hasImage || exporting"
            @click="exportImage"
          >
            {{ exporting ? "导出中..." : "导出图片" }}
          </button>
        </div>
      </aside>
    </main>
  </div>
</template>
