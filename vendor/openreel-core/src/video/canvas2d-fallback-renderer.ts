import type { Effect } from "../types/timeline";
import type { Renderer, RendererConfig, RenderLayer } from "./renderer-factory";

export class Canvas2DFallbackRenderer implements Renderer {
  readonly type = "canvas2d" as const;

  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private width: number;
  private height: number;
  private deviceLostCallbacks: Array<() => void> = [];
  private layers: RenderLayer[] = [];

  constructor(config: RendererConfig) {
    this.width = config.width;
    this.height = config.height;
    this.canvas = new OffscreenCanvas(config.width, config.height);
  }

  async initialize(): Promise<boolean> {
    try {
      this.ctx = this.canvas.getContext("2d");
      return this.ctx !== null;
    } catch {
      return false;
    }
  }

  isSupported(): boolean {
    return true; // Canvas 2D is always supported
  }

  destroy(): void {
    this.ctx = null;
    this.deviceLostCallbacks = [];
    this.layers = [];
  }

  beginFrame(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.layers = [];
  }

  renderLayer(layer: RenderLayer): void {
    this.layers.push(layer);
  }

  async endFrame(): Promise<ImageBitmap> {
    if (!this.ctx) {
      throw new Error("Canvas2D context not initialized");
    }
    for (const layer of this.layers) {
      await this.renderLayerToCanvas(layer);
    }

    return createImageBitmap(this.canvas);
  }

  private async renderLayerToCanvas(layer: RenderLayer): Promise<void> {
    if (!this.ctx) return;

    const ctx = this.ctx;
    const { transform, opacity, borderRadius } = layer;
    let image: ImageBitmap;
    if (layer.texture instanceof ImageBitmap) {
      image = layer.texture;
    } else {
      // For GPU textures, we can't render them directly
      // This is a limitation of the Canvas2D fallback
      return;
    }

    ctx.save();
    ctx.globalAlpha = opacity * transform.opacity;

    // Translate to position
    const centerX = this.width / 2 + transform.position.x;
    const centerY = this.height / 2 + transform.position.y;
    ctx.translate(centerX, centerY);
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(transform.scale.x, transform.scale.y);
    const drawX = -image.width * transform.anchor.x;
    const drawY = -image.height * transform.anchor.y;
    if (borderRadius > 0) {
      ctx.beginPath();
      this.roundRect(
        ctx,
        drawX,
        drawY,
        image.width,
        image.height,
        borderRadius,
      );
      ctx.clip();
    }

    // Draw the image
    ctx.drawImage(image, drawX, drawY);

    ctx.restore();
  }

  private roundRect(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  createTextureFromImage(image: ImageBitmap): ImageBitmap {
    // Canvas2D doesn't use GPU textures, just return the image
    return image;
  }

  releaseTexture(_texture: GPUTexture | ImageBitmap): void {
    // No-op for Canvas2D
  }

  applyEffects(
    texture: GPUTexture | ImageBitmap,
    _effects: Effect[],
  ): GPUTexture | ImageBitmap {
    // Canvas2D has limited effect support
    // For now, just return the texture unchanged
    return texture;
  }

  onDeviceLost(callback: () => void): void {
    this.deviceLostCallbacks.push(callback);
  }

  async recreateDevice(): Promise<boolean> {
    // Canvas2D doesn't have device loss
    return true;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  getMemoryUsage(): number {
    return this.width * this.height * 4;
  }

  getDevice(): GPUDevice | null {
    return null;
  }
}
