import type { SplatMesh } from 'gaussian-splat-lite';

export type GaussianSplatFadeMaterial = Record<PropertyKey, unknown> & {
  defines?: Record<string, unknown>;
  needsUpdate?: boolean;
  onBeforeCompile?: (shader: unknown) => void;
  dispose(): void;
};

type GaussianFadeValueHolder = Record<PropertyKey, unknown> & {
  value: number;
};

type GaussianFadeParamsLike = {
  fadeIn: GaussianFadeValueHolder;
  fadeOut: GaussianFadeValueHolder;
};

function isFadeEndpoint(value: number) {
  return value === 0 || value === 1;
}

function getGaussianSplatOpacityFromFade(fadeIn: number, fadeOut: number) {
  // TilesFadePlugin disables shader fading entirely once both values reach an
  // endpoint, so the fully visible opacity must be restored here as well.
  if (isFadeEndpoint(fadeIn) && isFadeEndpoint(fadeOut)) {
    // fadeIn=1, fadeOut=0 -> visible; fadeIn=1, fadeOut=1 -> hidden.
    return fadeOut === 0 ? 1 : 0;
  }

  return Math.min(Math.max(fadeIn - fadeOut, 0), 1);
}

function applyGaussianFadeOpacity(mesh: SplatMesh, opacity: number) {
  // Gaussian Splat Lite tracks opacity changes during SplatMesh.frameUpdate,
  // so assigning this value is enough to invalidate the generated splats.
  mesh.opacity = Math.min(Math.max(opacity, 0), 1);
}

function getFiniteFadeValue(value: unknown) {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function isGaussianFadeParamsLike(
  value: unknown,
): value is GaussianFadeParamsLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const fadeIn = (value as { fadeIn?: unknown }).fadeIn;
  const fadeOut = (value as { fadeOut?: unknown }).fadeOut;
  return Boolean(
    fadeIn &&
      typeof fadeIn === 'object' &&
      'value' in fadeIn &&
      fadeOut &&
      typeof fadeOut === 'object' &&
      'value' in fadeOut,
  );
}

function attachGaussianFadeUpdater(
  mesh: SplatMesh,
  fadeParams: GaussianFadeParamsLike,
) {
  const updateOpacity = () => {
    applyGaussianFadeOpacity(
      mesh,
      getGaussianSplatOpacityFromFade(
        getFiniteFadeValue(fadeParams.fadeIn.value),
        getFiniteFadeValue(fadeParams.fadeOut.value),
      ),
    );
  };

  mesh.onFrame = updateOpacity;
  updateOpacity();
}

export function createGaussianFadeMaterial(
  mesh: SplatMesh,
): GaussianSplatFadeMaterial {
  const material: GaussianSplatFadeMaterial = {
    dispose() {},
  };
  return new Proxy(material, {
    set(target, property, value) {
      const didSet = Reflect.set(target, property, value);
      if (isGaussianFadeParamsLike(value)) {
        attachGaussianFadeUpdater(mesh, value);
      }

      return didSet;
    },
  });
}
