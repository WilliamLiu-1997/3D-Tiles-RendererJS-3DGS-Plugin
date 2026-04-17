import { SparkRenderer } from '@sparkjsdev/spark';
import {
  Camera,
  Matrix4,
  Object3D,
  Vector3,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { isGaussianSplat, isGaussianSplatScene } from './GaussianSplatPlugin';

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

type RebasedGaussianRoot = {
  target: Object3D;
  originalMatrix: Matrix4;
  originalMatrixAutoUpdate: boolean;
};

function ensureCameraClone(cached: Camera | null, source: Camera): Camera {
  if (!cached || cached.constructor !== source.constructor) {
    return source.clone();
  }
  cached.copy(source, false);
  return cached;
}

export class CameraRelativeSparkRenderer extends SparkRenderer {
  #updateCamera: Camera | null = null;
  #renderCamera: Camera | null = null;

  #lastCameraPosition = new Vector3();
  #lastCameraDirection = new Vector3();
  #hasLastCameraPose = false;
  #lastSplatUUIDs = new Set<string>();
  #currentSplatUUIDs = new Set<string>();

  #rebasedRootsPool: RebasedGaussianRoot[] = [];
  #rebasedRootsCount = 0;

  constructor(renderer: WebGLRenderer) {
    super({
      renderer,
      autoUpdate: false,
      preUpdate: false,
      accumExtSplats: false,
      pagedExtSplats: true,
      blurAmount: 0.2,
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

    const rebasedCount = this.#rebaseGaussianRoots(scene, camera);
    const hasRebased = rebasedCount > 0;

    try {
      // Build a relative camera from the display's world frame
      // instead of always passing the identity-rebased camera.
      const renderCamera = hasRebased ? this.#getRenderCamera(camera) : camera;
      super.onBeforeRender(renderer, scene, renderCamera);

      if (hasRebased && this.#shouldUpdate(camera)) {
        const updateCamera = this.#getUpdateCamera(camera);
        const prevDisplay = this.display;
        const prevCurrent = this.current;

        const cameraWorldSnapshot = camera.matrixWorld.clone();
        const cameraPositionSnapshot = _cameraWorldPosition.clone();
        const cameraDirectionSnapshot = _cameraWorldDirection.clone();
        const splatUUIDsSnapshot = new Set(this.#currentSplatUUIDs);

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
          this.#lastCameraPosition.copy(cameraPositionSnapshot);
          this.#lastCameraDirection.copy(cameraDirectionSnapshot);
          this.#hasLastCameraPose = true;

          this.#lastSplatUUIDs.clear();
          for (const uuid of splatUUIDsSnapshot) {
            this.#lastSplatUUIDs.add(uuid);
          }
        }
      }
    } finally {
      this.#restoreGaussianRoots();
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

    const current = this.#currentSplatUUIDs;
    const last = this.#lastSplatUUIDs;

    let splatsChanged = current.size !== last.size;
    if (!splatsChanged) {
      for (const uuid of current) {
        if (!last.has(uuid)) {
          splatsChanged = true;
          break;
        }
      }
    }

    return poseChanged || splatsChanged;
  }

  /**
   * Identity camera for the update pass — makes Spark treat
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

  #rebaseGaussianRoots(scene: Scene, camera: Camera): number {
    this.#rebasedRootsCount = 0;
    this.#currentSplatUUIDs.clear();
    _cameraInverseWorldMatrix.copy(camera.matrixWorld).invert();

    scene.traverseVisible((node) => {
      if (!isGaussianSplat(node) && !isGaussianSplatScene(node)) {
        return;
      }

      this.#currentSplatUUIDs.add(node.uuid);

      // Only rebase top-level splat roots
      if (
        node.parent &&
        (isGaussianSplat(node.parent) || isGaussianSplatScene(node.parent))
      ) {
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

  #restoreGaussianRoots() {
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
