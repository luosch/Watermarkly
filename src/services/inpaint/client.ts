import InpaintWorker from "./worker?worker";
import type {
  InpaintInitResult,
  InpaintRect,
  InpaintRunResult,
  InpaintWorkerRequest,
  InpaintWorkerResponse,
} from "./types";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export class InpaintClient {
  private worker: Worker;

  private seq = 1;

  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new InpaintWorker();
    this.worker.onmessage = (event: MessageEvent<InpaintWorkerResponse>) => {
      const payload = event.data;
      const task = this.pending.get(payload.id);
      if (!task) return;
      this.pending.delete(payload.id);

      if (payload.type === "error") {
        task.reject(new Error(payload.message));
        return;
      }
      task.resolve(payload);
    };
  }

  async init(modelUrl: string): Promise<InpaintInitResult> {
    const response = (await this.request({
      type: "init",
      modelUrl,
    })) as Extract<InpaintWorkerResponse, { type: "init" }>;

    return {
      ready: response.ready,
      backend: response.backend,
      message: response.message,
    };
  }

  async run(
    imageData: ImageData,
    rect: InpaintRect,
  ): Promise<InpaintRunResult> {
    const copied = new Uint8ClampedArray(imageData.data);
    const response = (await this.request(
      {
        type: "run",
        width: imageData.width,
        height: imageData.height,
        pixels: copied,
        rect,
      },
      [copied.buffer],
    )) as Extract<InpaintWorkerResponse, { type: "run" }>;

    return {
      width: response.width,
      height: response.height,
      pixels: response.pixels,
      backend: response.backend,
    };
  }

  destroy() {
    this.worker.terminate();
    this.pending.clear();
  }

  private request(
    payload: Omit<InpaintWorkerRequest, "id">,
    transfer?: Transferable[],
  ) {
    const id = this.seq++;

    return new Promise<InpaintWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: InpaintWorkerRequest = { ...payload, id } as InpaintWorkerRequest;
      this.worker.postMessage(message, transfer ?? []);
    });
  }
}

export function createInpaintClient() {
  return new InpaintClient();
}
