<template>
  <div class="page">
    <header class="hero">
      <p class="hero-badge">Watermarkly</p>
      <h1 class="hero-title">一站式图片水印处理工具</h1>
      <p class="hero-subtitle">
        支持加文字水印、加图片水印、去除水印。所有操作都在浏览器内完成，轻量、快速、易上手。
      </p>
    </header>

    <main class="content">
      <section class="feature-grid">
        <article class="feature-card">
          <h2 class="feature-title">加文字水印</h2>
          <p class="feature-desc">
            给图片添加自定义文案，支持字体、大小、透明度、旋转角度和位置调整。
          </p>
          <ul class="feature-list">
            <li>字体与字号</li>
            <li>颜色与透明度</li>
            <li>位置与旋转</li>
          </ul>
          <RouterLink class="feature-btn" to="/editor?tool=text">进入功能</RouterLink>
        </article>

        <article class="feature-card">
          <h2 class="feature-title">加图片水印</h2>
          <p class="feature-desc">
            上传 Logo 或品牌图作为水印，支持缩放、透明度、平铺和角落对齐。
          </p>
          <ul class="feature-list">
            <li>Logo 上传</li>
            <li>缩放与透明度</li>
            <li>单个或平铺</li>
          </ul>
          <RouterLink class="feature-btn" to="/editor?tool=image">进入功能</RouterLink>
        </article>

        <article class="feature-card">
          <h2 class="feature-title">去除水印</h2>
          <p class="feature-desc">
            通过选区修复去除图片中不需要的水印内容，适用于简单背景和基础场景。
          </p>
          <ul class="feature-list">
            <li>涂抹选区</li>
            <li>基础智能修复</li>
            <li>本地导出结果</li>
          </ul>
          <RouterLink class="feature-btn" to="/remove-watermark">进入功能</RouterLink>
        </article>
      </section>
    </main>
  </div>
</template>
