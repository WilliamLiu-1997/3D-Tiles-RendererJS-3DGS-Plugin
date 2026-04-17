import { WebGLRenderer, type Scene } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';
import type { GaussianSplatPluginHost } from './GaussianSplatPlugin';
import { CameraRelativeSparkRenderer } from './CameraRelativeSparkRenderer';

const _sharedSparkManagersByScene = new WeakMap<
  Scene,
  SharedSparkRendererManager
>();
const _sharedSparkManagersByRenderer = new WeakMap<
  WebGLRenderer,
  SharedSparkRendererManager
>();
class SharedSparkRendererManager {
  #sparkRenderer: CameraRelativeSparkRenderer;
  #scene: Scene;
  #notifyHandle: ReturnType<typeof setTimeout> | null = null;
  #disposeHandle: ReturnType<typeof setTimeout> | null = null;
  #tilesRenderers = new Set<TilesRenderer>();
  #disposed = false;
  readonly renderer: WebGLRenderer;

  constructor(host: GaussianSplatPluginHost) {
    this.#scene = host.scene;
    this.renderer = host.renderer;
    this.#sparkRenderer = new CameraRelativeSparkRenderer(host.renderer);
    this.#sparkRenderer.onDirty = () => {
      if (!this.#disposed) {
        this.#scheduleSortUpdatedNotification();
      }
    };
    host.scene.add(this.#sparkRenderer);
  }

  retain(tiles: TilesRenderer) {
    this.#tilesRenderers.add(tiles);
  }

  release(tiles: TilesRenderer) {
    this.#tilesRenderers.delete(tiles);
    if (this.#disposed || this.#tilesRenderers.size > 0) {
      return;
    }

    this.#dispose();
  }

  #dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    // Remove associations immediately
    _sharedSparkManagersByScene.delete(this.#scene);
    _sharedSparkManagersByRenderer.delete(this.renderer);
    this.#stopScheduledNotifications();
    this.#sparkRenderer.removeFromParent();
    this.#sparkRenderer.visible = false;
    this.#sparkRenderer.autoUpdate = false;
    this.#tilesRenderers.clear();
    this.#sparkRenderer.onDirty = undefined;

    // Defer sparkRenderer.dispose() until sort finishes
    if (this.#sparkRenderer.sorting) {
      this.#waitForSortAndDispose();
    } else {
      this.#sparkRenderer.dispose();
    }
  }

  #stopScheduledNotifications() {
    if (this.#notifyHandle !== null) {
      clearTimeout(this.#notifyHandle);
      this.#notifyHandle = null;
    }

    if (this.#disposeHandle !== null) {
      clearTimeout(this.#disposeHandle);
      this.#disposeHandle = null;
    }
  }

  #scheduleSortUpdatedNotification() {
    if (this.#notifyHandle !== null) {
      return;
    }

    this.#notifyHandle = setTimeout(() => {
      this.#notifyHandle = null;

      if (this.#disposed) {
        return;
      }

      for (const tilesRenderer of this.#tilesRenderers) {
        tilesRenderer.dispatchEvent({ type: 'needs-update' } as any);
      }
    }, 0);
  }

  #waitForSortAndDispose() {
    if (this.#disposeHandle !== null) {
      return;
    }

    const checkSorting = () => {
      this.#disposeHandle = null;

      if (!this.#sparkRenderer.sorting) {
        this.#sparkRenderer.dispose();
        return;
      }

      this.#disposeHandle = setTimeout(checkSorting, 16);
    };

    this.#disposeHandle = setTimeout(checkSorting, 16);
  }
}

export function getSharedSparkRendererManager(host: GaussianSplatPluginHost) {
  const managerByScene = _sharedSparkManagersByScene.get(host.scene);
  const managerByRenderer = _sharedSparkManagersByRenderer.get(host.renderer);

  if (managerByScene && managerByRenderer) {
    if (managerByScene !== managerByRenderer) {
      throw new Error(
        'GaussianSplatPlugin: Scene and WebGLRenderer are already bound to different SparkRenderer managers.',
      );
    }

    return managerByScene;
  }

  if (managerByScene || managerByRenderer) {
    throw new Error(
      'GaussianSplatPlugin: Scene and WebGLRenderer must be bound in a strict 1:1:1 relationship.',
    );
  }

  const manager = new SharedSparkRendererManager(host);
  _sharedSparkManagersByScene.set(host.scene, manager);
  _sharedSparkManagersByRenderer.set(host.renderer, manager);

  return manager;
}

export type { SharedSparkRendererManager };
