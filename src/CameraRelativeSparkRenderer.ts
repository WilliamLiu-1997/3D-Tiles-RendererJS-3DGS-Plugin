import {
  SparkRenderer,
  SplatEdit,
  SplatEditSdf,
  SplatMesh,
} from '@sparkjsdev/spark';
import {
  Camera,
  Matrix4,
  Object3D,
  Vector3,
  type Scene,
  type WebGLRenderer,
} from 'three';
import {
  isGaussianSplat,
  type SupportedSparkRendererOptions,
} from './GaussianSplatPlugin';

const _identityMatrix = new Matrix4();
const _cameraInverseWorldMatrix = new Matrix4();
const _parentInverseWorldMatrix = new Matrix4();
const _rebasedLocalMatrix = new Matrix4();

const _displayFrameInverseWorldMatrix = new Matrix4();
const _relativeRenderCameraMatrix = new Matrix4();

const _cameraWorldPosition = new Vector3();
const _cameraWorldDirection = new Vector3();
const _cameraPositionEpsilonSq = 1e-6;
const _cameraDirectionDotThreshold = 1 - 1e-3;

type RebasedCameraRelativeRoot = {
  target: Object3D;
  originalMatrix: Matrix4;
  originalMatrixAutoUpdate: boolean;
};

type GaussianSplatRootSnapshot = {
  kind: 'splat';
  opacity: number;
  matrixWorld: Matrix4;
};

type SplatEditSdfSnapshot = {
  uuid: string;
  matrixWorld: Matrix4;
  type: SplatEditSdf['type'];
  invert: boolean;
  opacity: number;
  color: SplatEditSdf['color'];
  radius: number;
  displace: SplatEditSdf['displace'];
  scale: SplatEditSdf['scale'];
};

type SplatEditRootSnapshot = {
  kind: 'edit';
  matrixWorld: Matrix4;
  ordering: number;
  rgbaBlendMode: SplatEdit['rgbaBlendMode'];
  sdfSmooth: number;
  softEdge: number;
  invert: boolean;
  sdfs: SplatEditSdfSnapshot[];
};

type CameraRelativeRootSnapshot =
  | GaussianSplatRootSnapshot
  | SplatEditRootSnapshot;

function ensureCameraClone(cached: Camera | null, source: Camera): Camera {
  if (!cached || cached.constructor !== source.constructor) {
    return source.clone();
  }
  cached.copy(source, false);
  return cached;
}

function hasGaussianSplatAncestor(node: Object3D) {
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor instanceof SplatMesh || isGaussianSplat(ancestor)) {
      return true;
    }
    ancestor = ancestor.parent;
  }

  return false;
}

function isGlobalSplatEdit(node: Object3D): node is SplatEdit {
  return node instanceof SplatEdit && !hasGaussianSplatAncestor(node);
}

function isCameraRelativeNode(node: Object3D): node is SplatMesh | SplatEdit {
  return isGaussianSplat(node) || isGlobalSplatEdit(node);
}

function hasCameraRelativeRootAncestor(node: Object3D) {
  let ancestor = node.parent;
  while (ancestor) {
    if (isCameraRelativeNode(ancestor)) {
      return true;
    }
    ancestor = ancestor.parent;
  }

  return false;
}

function cloneSplatRootSnapshot(
  node: SplatMesh,
): GaussianSplatRootSnapshot {
  return {
    kind: 'splat',
    opacity: node.opacity,
    matrixWorld: node.matrixWorld.clone(),
  };
}

function cloneSplatEditSdfSnapshot(
  sdf: SplatEditSdf,
): SplatEditSdfSnapshot {
  return {
    uuid: sdf.uuid,
    matrixWorld: sdf.matrixWorld.clone(),
    type: sdf.type,
    invert: sdf.invert,
    opacity: sdf.opacity,
    color: sdf.color.clone(),
    radius: sdf.radius,
    displace: sdf.displace.clone(),
    scale: sdf.scale.clone(),
  };
}

function cloneSplatEditRootSnapshot(
  edit: SplatEdit,
): SplatEditRootSnapshot {
  edit.updateMatrixWorld(true);

  const sdfs: SplatEditSdfSnapshot[] = [];
  const sourceSdfs = edit.sdfs;

  if (sourceSdfs != null) {
    for (const sdf of sourceSdfs) {
      sdf.updateMatrixWorld(true);
      sdfs.push(cloneSplatEditSdfSnapshot(sdf));
    }
  } else {
    edit.traverseVisible((child) => {
      if (child instanceof SplatEditSdf) {
        child.updateMatrixWorld(true);
        sdfs.push(cloneSplatEditSdfSnapshot(child));
      }
    });
  }

  return {
    kind: 'edit',
    matrixWorld: edit.matrixWorld.clone(),
    ordering: edit.ordering,
    rgbaBlendMode: edit.rgbaBlendMode,
    sdfSmooth: edit.sdfSmooth,
    softEdge: edit.softEdge,
    invert: edit.invert,
    sdfs,
  };
}

function cloneCameraRelativeRootSnapshot(
  node: SplatMesh | SplatEdit,
): CameraRelativeRootSnapshot {
  return node instanceof SplatEdit
    ? cloneSplatEditRootSnapshot(node)
    : cloneSplatRootSnapshot(node);
}

function areSplatRootStatesEqual(
  a: GaussianSplatRootSnapshot,
  b: GaussianSplatRootSnapshot,
) {
  return a.opacity === b.opacity && a.matrixWorld.equals(b.matrixWorld);
}

function areSplatEditSdfStatesEqual(
  a: SplatEditSdfSnapshot,
  b: SplatEditSdfSnapshot,
) {
  return (
    a.uuid === b.uuid &&
    a.type === b.type &&
    a.invert === b.invert &&
    a.opacity === b.opacity &&
    a.radius === b.radius &&
    a.matrixWorld.equals(b.matrixWorld) &&
    a.color.equals(b.color) &&
    a.displace.equals(b.displace) &&
    a.scale.equals(b.scale)
  );
}

function areSplatEditRootStatesEqual(
  a: SplatEditRootSnapshot,
  b: SplatEditRootSnapshot,
) {
  if (
    !a.matrixWorld.equals(b.matrixWorld) ||
    a.ordering !== b.ordering ||
    a.rgbaBlendMode !== b.rgbaBlendMode ||
    a.sdfSmooth !== b.sdfSmooth ||
    a.softEdge !== b.softEdge ||
    a.invert !== b.invert ||
    a.sdfs.length !== b.sdfs.length
  ) {
    return false;
  }

  for (let i = 0; i < a.sdfs.length; i++) {
    if (!areSplatEditSdfStatesEqual(a.sdfs[i], b.sdfs[i])) {
      return false;
    }
  }

  return true;
}

function areCameraRelativeRootStatesEqual(
  a: CameraRelativeRootSnapshot | undefined,
  b: CameraRelativeRootSnapshot | undefined,
) {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'splat') {
    return b.kind === 'splat' && areSplatRootStatesEqual(a, b);
  }

  return b.kind === 'edit' && areSplatEditRootStatesEqual(a, b);
}

export class CameraRelativeSparkRenderer extends SparkRenderer {
  #updateCamera: Camera | null = null;
  #renderCamera: Camera | null = null;

  #lastCameraPosition = new Vector3();
  #lastCameraDirection = new Vector3();
  #hasLastCameraPose = false;
  #lastRootStates = new Map<string, CameraRelativeRootSnapshot>();
  #currentRootStates = new Map<string, CameraRelativeRootSnapshot>();

  #rebasedRootsPool: RebasedCameraRelativeRoot[] = [];
  #rebasedRootsCount = 0;
  #hadRebasedLastFrame = false;

  constructor(
    renderer: WebGLRenderer,
    options: SupportedSparkRendererOptions = {},
  ) {
    super({
      ...options,
      renderer,
      autoUpdate: false,
      preUpdate: false,
    });

    this.matrixAutoUpdate = false;
    this.raycast = () => {};
  }

  override onBeforeRender(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
  ) {
    camera.updateMatrixWorld(true);

    const rebasedCount = this.#rebaseCameraRelativeRoots(scene, camera);
    const hasRebased = rebasedCount > 0;

    try {
      if (
        (hasRebased || this.#hadRebasedLastFrame) &&
        this.#shouldUpdate(camera)
      ) {
        const updateCamera = this.#getUpdateCamera(camera);
        const prevDisplay = this.display;
        const prevCurrent = this.current;

        const cameraWorldSnapshot = camera.matrixWorld.clone();

        void this.update({
          scene,
          camera: updateCamera,
        });

        const updateAccepted =
          this.current !== prevCurrent || this.display !== prevDisplay;

        // Spark receives an identity-rebased camera, so it writes identity
        // into accumulator.viewToWorld. Overwrite it back to the real world
        // frame that these camera-local splats actually correspond to.
        if (this.current !== prevCurrent) {
          this.current.viewToWorld.copy(cameraWorldSnapshot);
        }

        if (this.display !== prevDisplay) {
          this.display.viewToWorld.copy(cameraWorldSnapshot);
        }

        if (updateAccepted) {
          this.#lastCameraPosition.copy(_cameraWorldPosition);
          this.#lastCameraDirection.copy(_cameraWorldDirection);
          this.#hasLastCameraPose = true;
          this.#lastRootStates = new Map(this.#currentRootStates);
        }
      }
      this.#hadRebasedLastFrame = hasRebased;

      // Build a relative camera from the display's world frame
      // instead of always passing the identity-rebased camera.
      const renderCamera = hasRebased ? this.#getRenderCamera(camera) : camera;
      super.onBeforeRender(renderer, scene, renderCamera);
    } finally {
      this.#restoreCameraRelativeRoots();
    }
  }

  #shouldUpdate(camera: Camera) {
    camera.getWorldPosition(_cameraWorldPosition);
    camera.getWorldDirection(_cameraWorldDirection);

    const poseChanged =
      !this.#hasLastCameraPose ||
      _cameraWorldPosition.distanceToSquared(this.#lastCameraPosition) >
        _cameraPositionEpsilonSq ||
      _cameraWorldDirection.dot(this.#lastCameraDirection) <
        _cameraDirectionDotThreshold;

    const current = this.#currentRootStates;
    const last = this.#lastRootStates;

    let rootsChanged = current.size !== last.size;
    if (!rootsChanged) {
      for (const [uuid, state] of current) {
        // Covers both "uuid missing" (get -> undefined) and state mismatch.
        if (!areCameraRelativeRootStatesEqual(state, last.get(uuid))) {
          rootsChanged = true;
          break;
        }
      }
    }

    return poseChanged || rootsChanged;
  }

  /**
   * Identity camera for the update pass - makes Spark treat
   * the camera's own frame as the reference frame.
   */
  #getUpdateCamera(camera: Camera) {
    this.#updateCamera = ensureCameraClone(this.#updateCamera, camera);
    const updateCamera = this.#updateCamera;
    updateCamera.position.set(0, 0, 0);
    updateCamera.quaternion.identity();
    updateCamera.scale.set(1, 1, 1);
    updateCamera.matrixAutoUpdate = false;
    updateCamera.matrix.copy(_identityMatrix);
    updateCamera.matrixWorld.copy(_identityMatrix);
    updateCamera.matrixWorldInverse.copy(_identityMatrix);
    updateCamera.matrixWorldNeedsUpdate = false;
    return updateCamera;
  }

  /**
   * Render-pass camera:
   *   relative = inverse(displayFrameWorld) * currentCameraWorld
   */
  #getRenderCamera(camera: Camera) {
    this.#renderCamera = ensureCameraClone(this.#renderCamera, camera);
    const renderCamera = this.#renderCamera;

    _displayFrameInverseWorldMatrix.copy(this.display.viewToWorld).invert();

    _relativeRenderCameraMatrix
      .copy(_displayFrameInverseWorldMatrix)
      .multiply(camera.matrixWorld);

    renderCamera.matrixAutoUpdate = false;
    renderCamera.matrix.copy(_relativeRenderCameraMatrix);
    renderCamera.matrix.decompose(
      renderCamera.position,
      renderCamera.quaternion,
      renderCamera.scale,
    );
    renderCamera.matrixWorld.copy(_relativeRenderCameraMatrix);
    // inverse(A * B) = inverse(B) * inverse(A)
    // = camera.matrixWorldInverse * display.viewToWorld
    renderCamera.matrixWorldInverse
      .copy(camera.matrixWorldInverse)
      .multiply(this.display.viewToWorld);
    renderCamera.matrixWorldNeedsUpdate = false;
    return renderCamera;
  }

  #rebaseCameraRelativeRoots(scene: Scene, camera: Camera): number {
    this.#rebasedRootsCount = 0;
    this.#currentRootStates.clear();
    _cameraInverseWorldMatrix.copy(camera.matrixWorld).invert();

    scene.traverseVisible((node) => {
      if (!isCameraRelativeNode(node)) {
        return;
      }

      this.#currentRootStates.set(
        node.uuid,
        cloneCameraRelativeRootSnapshot(node),
      );

      // Rebase each root once. SDF children inherit their SplatEdit rebase
      // through normal Object3D transforms.
      if (hasCameraRelativeRootAncestor(node)) {
        return;
      }

      const idx = this.#rebasedRootsCount++;
      const pool = this.#rebasedRootsPool;

      if (idx >= pool.length) {
        pool.push({
          target: node,
          originalMatrix: node.matrix.clone(),
          originalMatrixAutoUpdate: node.matrixAutoUpdate,
        });
      } else {
        const entry = pool[idx];
        entry.target = node;
        entry.originalMatrix.copy(node.matrix);
        entry.originalMatrixAutoUpdate = node.matrixAutoUpdate;
      }

      const parent = node.parent;
      if (!parent || parent === scene) {
        _rebasedLocalMatrix
          .copy(_cameraInverseWorldMatrix)
          .multiply(node.matrixWorld);
      } else {
        _rebasedLocalMatrix
          .copy(_parentInverseWorldMatrix.copy(parent.matrixWorld).invert())
          .multiply(_cameraInverseWorldMatrix)
          .multiply(node.matrixWorld);
      }

      node.matrixAutoUpdate = false;
      node.matrix.copy(_rebasedLocalMatrix);
      node.matrixWorldNeedsUpdate = true;
      node.updateMatrixWorld(true);
    });

    return this.#rebasedRootsCount;
  }

  #restoreCameraRelativeRoots() {
    const pool = this.#rebasedRootsPool;
    for (let i = this.#rebasedRootsCount - 1; i >= 0; i--) {
      const { target, originalMatrix, originalMatrixAutoUpdate } = pool[i];
      target.matrix.copy(originalMatrix);
      target.matrixAutoUpdate = originalMatrixAutoUpdate;
      target.matrixWorldNeedsUpdate = true;
    }
    for (let i = 0; i < this.#rebasedRootsCount; i++) {
      pool[i].target.updateMatrixWorld(true);
    }
  }
}
