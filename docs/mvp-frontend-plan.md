# Watermarkly 前端 MVP 方案（Vue）

## 目标
构建一个纯前端 Web 工具，支持：
- 加文字水印
- 加图片水印
- 去水印（基础版）

## 技术栈
- Vue 3
- Vite
- TypeScript
- Pinia
- Tailwind CSS
- Canvas API
- OpenCV.js（去水印基础能力）
- VueUse（可选）

## 页面与模块

### 页面
- `/` 首页
- `/editor` 编辑器

### 编辑器模块
- UploadPanel（上传/替换/重置）
- CanvasStage（主画布预览与交互）
- ToolTabs（工具切换）
- TextWatermarkPanel（文字水印配置）
- ImageWatermarkPanel（图片水印配置）
- RemoveWatermarkPanel（去水印区域与参数）
- ExportPanel（格式、质量、下载）

## 状态管理
主 Store：`useEditorStore`

建议核心状态：
- `sourceImage`
- `previewImage`
- `activeTool` (`text` / `image` / `remove`)
- `textWatermarkConfig`
- `imageWatermarkConfig`
- `removeConfig`
- `exportConfig`
- `history` / `future`（可选）

建议核心动作：
- `setSourceImage()`
- `applyTextWatermark()`
- `applyImageWatermark()`
- `applyRemoveWatermark()`
- `resetAll()`
- `exportImage()`

## 数据流
1. 用户上传图片
2. 写入 Store 并渲染画布
3. 参数变更触发重绘
4. 去水印时调用 OpenCV.js 处理并回写
5. 下载时通过 `canvas.toBlob()` 导出

## MVP 开发顺序
1. 上传 + 画布预览
2. 文字水印（单个 -> 平铺）
3. 图片水印
4. 导出下载
5. 去水印（基础版）

## 风险与边界
- 纯前端去水印对复杂背景效果有限
- 超大图片在低配置设备上可能卡顿
- 后续可通过 Web Worker 优化渲染与处理
