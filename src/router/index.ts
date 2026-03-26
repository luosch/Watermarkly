import { createRouter, createWebHistory } from "vue-router";
import HomePage from "../pages/HomePage.vue";
import EditorPage from "../pages/EditorPage.vue";
import RemoveWatermarkPage from "../pages/RemoveWatermarkPage.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: HomePage,
    },
    {
      path: "/editor",
      name: "editor",
      component: EditorPage,
    },
    {
      path: "/remove-watermark",
      name: "remove-watermark",
      component: RemoveWatermarkPage,
    },
  ],
});

export default router;
