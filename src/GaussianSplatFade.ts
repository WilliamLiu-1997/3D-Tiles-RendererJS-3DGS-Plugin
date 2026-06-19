import {
  dyno,
  type GsplatModifier,
  type SplatMesh,
} from '@sparkjsdev/spark';

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

export type GaussianFadeState = {
  opacity: number;
  opacityUniform: dyno.DynoFloat<string>;
};

const _dynoFloatZero = dyno.dynoLiteral('float', '0.0');
const _dynoFloatOne = dyno.dynoLiteral('float', '1.0');
const _dynoFloatTwo = dyno.dynoLiteral('float', '2.0');
const _dynoFloatQuarter = dyno.dynoLiteral('float', '0.25');
const _dynoFloatThree = dyno.dynoLiteral('float', '3.0');
const _dynoFloatFour = dyno.dynoLiteral('float', '4.0');
const _dynoFloatFive = dyno.dynoLiteral('float', '5.0');
const _dynoFloatE = dyno.dynoLiteral('float', '2.718281828459045');
const _dynoSparkLodOpacityMin = dyno.dynoLiteral('float', '0.000001');
const _dynoSparkLodOpacityMax = dyno.dynoLiteral('float', '1000.0');

export function createGaussianFadeState(): GaussianFadeState {
  return {
    opacity: 1,
    opacityUniform: dyno.dynoFloat(1, 'gaussianFadeOpacity'),
  };
}

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

function decodeSparkLodOpacityValue(
  opacity: dyno.DynoVal<'float'>,
): dyno.DynoVal<'float'> {
  const lodOpacity = dyno.min(
    dyno.sub(dyno.mul(opacity, _dynoFloatFour), _dynoFloatThree),
    _dynoFloatFive,
  );
  const decodedLodOpacity = dyno.exp(
    dyno.div(dyno.sub(dyno.sqr(lodOpacity), _dynoFloatOne), _dynoFloatE),
  );

  return dyno.select(
    dyno.lessThanEqual(opacity, _dynoFloatOne),
    opacity,
    decodedLodOpacity,
  );
}

function encodeSparkLodOpacityValue(
  opacity: dyno.DynoVal<'float'>,
): dyno.DynoVal<'float'> {
  const clampedOpacity = dyno.clamp(
    opacity,
    _dynoSparkLodOpacityMin,
    _dynoSparkLodOpacityMax,
  );
  const lodOpacity = dyno.sqrt(
    dyno.add(_dynoFloatOne, dyno.mul(_dynoFloatE, dyno.log(clampedOpacity))),
  );
  const encodedLodOpacity = dyno.min(
    _dynoFloatTwo,
    dyno.max(
      _dynoFloatOne,
      dyno.add(
        _dynoFloatOne,
        dyno.mul(_dynoFloatQuarter, dyno.sub(lodOpacity, _dynoFloatOne)),
      ),
    ),
  );

  return dyno.select(
    dyno.lessThanEqual(opacity, _dynoFloatOne),
    dyno.max(_dynoFloatZero, opacity),
    encodedLodOpacity,
  );
}

export function createGaussianFadeModifier(
  fadeOpacityUniform: dyno.DynoFloat<string>,
): GsplatModifier {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      if (!gsplat) {
        return;
      }

      const { opacity } = dyno.splitGsplat(gsplat).outputs;
      const fadedOpacity = dyno.mul(
        decodeSparkLodOpacityValue(opacity),
        fadeOpacityUniform,
      );
      return {
        gsplat: dyno.combineGsplat({
          gsplat,
          opacity: encodeSparkLodOpacityValue(fadedOpacity),
        }),
      };
    },
    {
      globals: () => [dyno.defineGsplat],
    },
  );
}

function applyGaussianFadeOpacity(
  mesh: SplatMesh,
  fadeState: GaussianFadeState,
  opacity: number,
) {
  const fadeOpacity = Math.min(Math.max(opacity, 0), 1);
  if (fadeState.opacity === fadeOpacity) {
    mesh.opacity = 1;
    return;
  }

  fadeState.opacityUniform.value = fadeOpacity;
  fadeState.opacity = fadeOpacity;
  mesh.opacity = 1;
  mesh.updateVersion();
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

function watchGaussianFadeValue(
  fadeValue: GaussianFadeValueHolder,
  key: 'fadeIn' | 'fadeOut',
  state: { fadeIn: number; fadeOut: number },
  updateOpacity: () => void,
) {
  let currentValue = getFiniteFadeValue(fadeValue.value);
  state[key] = currentValue;

  try {
    Object.defineProperty(fadeValue, 'value', {
      configurable: true,
      enumerable: true,
      get: () => currentValue,
      set: (value: unknown) => {
        currentValue = getFiniteFadeValue(value);
        state[key] = currentValue;
        updateOpacity();
      },
    });
  } catch {
    // Property is non-configurable; skip interception.
  }
  updateOpacity();
}

function attachGaussianFadeWatcher(
  mesh: SplatMesh,
  fadeState: GaussianFadeState,
  fadeParams: GaussianFadeParamsLike,
) {
  const state = {
    fadeIn: getFiniteFadeValue(fadeParams.fadeIn.value),
    fadeOut: getFiniteFadeValue(fadeParams.fadeOut.value),
  };
  const updateOpacity = () => {
    applyGaussianFadeOpacity(
      mesh,
      fadeState,
      getGaussianSplatOpacityFromFade(state.fadeIn, state.fadeOut),
    );
  };

  watchGaussianFadeValue(fadeParams.fadeIn, 'fadeIn', state, updateOpacity);
  watchGaussianFadeValue(fadeParams.fadeOut, 'fadeOut', state, updateOpacity);
}

export function createGaussianFadeMaterial(
  mesh: SplatMesh,
  fadeState: GaussianFadeState,
): GaussianSplatFadeMaterial {
  const material: GaussianSplatFadeMaterial = {
    dispose() {},
  };
  return new Proxy(material, {
    set(target, property, value) {
      const didSet = Reflect.set(target, property, value);
      if (isGaussianFadeParamsLike(value)) {
        attachGaussianFadeWatcher(mesh, fadeState, value);
      }

      return didSet;
    },
  });
}
