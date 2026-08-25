import { WebGLRenderer, type Scene } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';
import {
  GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS,
  type GaussianSplatPluginHost,
  type SupportedGaussianSplatRendererOptions,
} from './GaussianSplatPlugin';
import { GaussianSplatRenderer } from 'gaussian-splat-lite';

const _sharedGaussianSplatRendererManagersByScene = new WeakMap<
  Scene,
  SharedGaussianSplatRendererManager
>();
const _sharedGaussianSplatRendererManagersByRenderer = new WeakMap<
  WebGLRenderer,
  SharedGaussianSplatRendererManager
>();

const MATERIAL_GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS = new Set<string>([
  'depthTest',
  'depthWrite',
]);

function normalizeGaussianSplatRendererOptions(
  options: SupportedGaussianSplatRendererOptions = {},
) {
  const source = options as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized as SupportedGaussianSplatRendererOptions;
}

class SharedGaussianSplatRendererManager {
  #scene: Scene;
  #gaussianSplatRendererOptions: SupportedGaussianSplatRendererOptions;
  #tilesRenderers = new Set<TilesRenderer>();
  readonly gaussianSplatRenderer: GaussianSplatRenderer;
  readonly renderer: WebGLRenderer;

  constructor(host: GaussianSplatPluginHost) {
    this.#scene = host.scene;
    this.renderer = host.renderer;
    this.#gaussianSplatRendererOptions = normalizeGaussianSplatRendererOptions(
      host.gaussianSplatRendererOptions,
    );
    this.gaussianSplatRenderer = new GaussianSplatRenderer({
      ...this.#gaussianSplatRendererOptions,
      renderer: host.renderer,
    });
    this.gaussianSplatRenderer.matrixAutoUpdate = false;
    this.gaussianSplatRenderer.onDirty = () => {
      for (const tilesRenderer of this.#tilesRenderers) {
        tilesRenderer.dispatchEvent({ type: 'needs-update' } as any);
      }
    };
    host.scene.add(this.gaussianSplatRenderer);
  }

  retain(tiles: TilesRenderer) {
    this.#tilesRenderers.add(tiles);
  }

  applyGaussianSplatRendererOptions(
    gaussianSplatRendererOptions: SupportedGaussianSplatRendererOptions = {},
    warnOnChange = true,
  ) {
    const next = normalizeGaussianSplatRendererOptions(
      gaussianSplatRendererOptions,
    ) as Record<string, unknown>;
    const prev = this.#gaussianSplatRendererOptions as Record<string, unknown>;
    const renderer = this.gaussianSplatRenderer as unknown as Record<
      string,
      unknown
    >;
    const material = this.gaussianSplatRenderer.material as unknown as Record<
      string,
      unknown
    >;

    let merged: Record<string, unknown> | null = null;

    for (const [key, nextValue] of Object.entries(next)) {
      const target = MATERIAL_GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS.has(key)
        ? material
        : renderer;

      // With no tracked opinion yet, compare against the renderer's actual
      // current value so an explicit `next === current` is a no-op.
      const baseline = prev[key] !== undefined ? prev[key] : target[key];
      if (baseline === nextValue) continue;

      target[key] = nextValue;
      merged ??= { ...prev };
      merged[key] = nextValue;
    }

    if (!merged) return;

    this.#gaussianSplatRendererOptions =
      merged as SupportedGaussianSplatRendererOptions;
    this.gaussianSplatRenderer.setDirty();
    if (warnOnChange) {
      console.warn(
        `GaussianSplatPlugin: Updating shared gaussianSplatRendererOptions for Scene/WebGLRenderer. Existing: ${JSON.stringify(prev)}, received: ${JSON.stringify(next)}.`,
      );
    }
  }

  release(tiles: TilesRenderer) {
    this.#tilesRenderers.delete(tiles);
    if (this.#tilesRenderers.size > 0) {
      return;
    }

    this.#dispose();
  }

  #dispose() {
    // Remove associations immediately
    _sharedGaussianSplatRendererManagersByScene.delete(this.#scene);
    _sharedGaussianSplatRendererManagersByRenderer.delete(this.renderer);
    this.gaussianSplatRenderer.onDirty = undefined;
    this.gaussianSplatRenderer.removeFromParent();
    this.gaussianSplatRenderer.dispose();
  }
}

export function getSharedGaussianSplatRendererManager(
  host: GaussianSplatPluginHost,
) {
  const managerByScene = _sharedGaussianSplatRendererManagersByScene.get(
    host.scene,
  );
  const managerByRenderer = _sharedGaussianSplatRendererManagersByRenderer.get(
    host.renderer,
  );

  if (managerByScene && managerByRenderer) {
    if (managerByScene !== managerByRenderer) {
      throw new Error(
        'GaussianSplatPlugin: Scene and WebGLRenderer are already bound to different GaussianSplatRenderer managers.',
      );
    }

    managerByScene.applyGaussianSplatRendererOptions(
      host.gaussianSplatRendererOptions,
    );
    return managerByScene;
  }

  if (managerByScene || managerByRenderer) {
    throw new Error(
      'GaussianSplatPlugin: Scene and WebGLRenderer must be bound in a strict 1:1:1 relationship.',
    );
  }

  const manager = new SharedGaussianSplatRendererManager(host);
  _sharedGaussianSplatRendererManagersByScene.set(host.scene, manager);
  _sharedGaussianSplatRendererManagersByRenderer.set(host.renderer, manager);

  return manager;
}

export function getGaussianSplatRendererForScene(
  scene: Scene,
): GaussianSplatRenderer | null {
  const manager = _sharedGaussianSplatRendererManagersByScene.get(scene);
  return manager ? manager.gaussianSplatRenderer : null;
}

export function updateSharedGaussianSplatRendererOptions(
  scene: Scene,
  gaussianSplatRendererOptions: SupportedGaussianSplatRendererOptions,
) {
  const manager = _sharedGaussianSplatRendererManagersByScene.get(scene);
  if (manager) {
    manager.applyGaussianSplatRendererOptions(
      gaussianSplatRendererOptions,
      false,
    );
  }
}

export type { SharedGaussianSplatRendererManager };
