import {
  EventDispatcher,
  MathUtils,
  Matrix4,
  Mesh,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { Ellipsoid } from '3d-tiles-renderer';

const CAMERA_CENTER_MODE_DISTANCE = 3000000;
const CAMERA_CENTER_MODE_DISTANCE_SQ = CAMERA_CENTER_MODE_DISTANCE ** 2;

class PointerTracker {
  buttons;
  pointerType;
  pointerOrder;
  previousPositions;
  pointerPositions;
  startPositions;
  hoverPosition;
  hoverSet;
  constructor() {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.hoverPosition = new Vector2();
    this.hoverSet = false;
  }
  reset() {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.hoverPosition = new Vector2();
    this.hoverSet = false;
  }
  // The pointers can be set multiple times per frame so track whether the pointer has
  // been set this frame or not so we don't overwrite the previous position and lose information
  // about pointer movement
  updateFrame() {
    const { previousPositions, pointerPositions } = this;
    for (const id in pointerPositions) {
      previousPositions[id].copy(pointerPositions[id]);
    }
  }
  setHoverEvent(e) {
    if (e.pointerType === 'mouse' || e.type === 'wheel') {
      this.getAdjustedPointer(e, this.hoverPosition);
      this.hoverSet = true;
    }
  }
  getLatestPoint(target) {
    if (this.pointerType !== null) {
      this.getCenterPoint(target);
      return target;
    } else if (this.hoverSet) {
      target.copy(this.hoverPosition);
      return target;
    } else {
      return null;
    }
  }
  // get the pointer position in the coordinate system of the target element
  getAdjustedPointer(e, target) {
    const domRef = e.target;
    const rect = domRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    target.set(x, y);
  }
  addPointer(e) {
    const id = e.pointerId;
    const position = new Vector2();
    this.getAdjustedPointer(e, position);
    if (this.pointerOrder.indexOf(id) === -1) {
      this.pointerOrder.push(id);
    }
    this.pointerPositions[id] = position;
    this.previousPositions[id] = position.clone();
    this.startPositions[id] = position.clone();
    if (this.getPointerCount() === 1) {
      this.pointerType = e.pointerType;
      this.buttons = e.buttons;
    }
  }
  updatePointer(e) {
    const id = e.pointerId;
    if (!(id in this.pointerPositions)) {
      return false;
    }
    this.getAdjustedPointer(e, this.pointerPositions[id]);
    return true;
  }
  deletePointer(e) {
    const id = e.pointerId;
    const pointerOrder = this.pointerOrder;
    pointerOrder.splice(pointerOrder.indexOf(id), 1);
    delete this.pointerPositions[id];
    delete this.previousPositions[id];
    delete this.startPositions[id];
    if (this.getPointerCount() === 0) {
      this.buttons = 0;
      this.pointerType = null;
    }
  }
  getPointerCount() {
    return this.pointerOrder.length;
  }
  getCenterPoint(target, pointerPositions = this.pointerPositions) {
    const pointerOrder = this.pointerOrder;
    if (this.getPointerCount() === 1 || this.getPointerType() === 'mouse') {
      const id = pointerOrder[0];
      target.copy(pointerPositions[id]);
      return target;
    } else if (this.getPointerCount() === 2) {
      const id0 = this.pointerOrder[0];
      const id1 = this.pointerOrder[1];
      const p0 = pointerPositions[id0];
      const p1 = pointerPositions[id1];
      target.addVectors(p0, p1).multiplyScalar(0.5);
      return target;
    } else if (this.getPointerCount() > 2) {
      target.set(0, 0);
      for (let i = 0; i < pointerOrder.length; i++) {
        const id = pointerOrder[i];
        target.add(pointerPositions[id]);
      }
      target.divideScalar(pointerOrder.length);
      return target;
    }
    return null;
  }
  getPreviousCenterPoint(target) {
    return this.getCenterPoint(target, this.previousPositions);
  }
  getStartCenterPoint(target) {
    return this.getCenterPoint(target, this.startPositions);
  }
  getMoveDistance() {
    this.getCenterPoint(_vec);
    this.getPreviousCenterPoint(_vec2);
    return _vec.sub(_vec2).length();
  }
  getTouchPointerDistance(pointerPositions = this.pointerPositions) {
    if (this.getPointerCount() <= 1 || this.getPointerType() === 'mouse') {
      return 0;
    }
    const { pointerOrder } = this;
    const id0 = pointerOrder[0];
    const id1 = pointerOrder[1];
    const p0 = pointerPositions[id0];
    const p1 = pointerPositions[id1];
    return p0.distanceTo(p1);
  }
  getPreviousTouchPointerDistance() {
    return this.getTouchPointerDistance(this.previousPositions);
  }
  getStartTouchPointerDistance() {
    return this.getTouchPointerDistance(this.startPositions);
  }
  getPointerType() {
    return this.pointerType;
  }
  isPointerTouch() {
    return this.getPointerType() === 'touch';
  }
  getPointerButtons() {
    return this.buttons;
  }
  isLeftClicked() {
    return Boolean(this.buttons & 1);
  }
  isRightClicked() {
    return Boolean(this.buttons & 2);
  }
  isMiddleClicked() {
    return Boolean(this.buttons & 4);
  }
}

class PivotPointMesh extends Mesh {
  constructor(size = 15, thickness = 3) {
    super(new PlaneGeometry(0, 0), new PivotMaterial(size, thickness));
    this.renderOrder = Infinity;
  }

  set focus(value) {
    this.material.uniforms.opacity.value = value ? 1 : 0.5;
  }

  onBeforeRender(renderer) {
    renderer.getSize(this.material.uniforms.resolution.value);
  }

  updateMatrixWorld() {
    this.matrixWorld.makeTranslation(this.position);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

class PivotMaterial extends ShaderMaterial {
  constructor(size, thickness) {
    const coreD = size + thickness;
    const planeD = coreD + 3 * thickness;
    const normThk = thickness / coreD;
    const ringR = (coreD - 0.4 * thickness - 4.0) / coreD;
    const hw = 0.4 * normThk;

    super({
      depthWrite: false,
      depthTest: false,
      transparent: true,

      uniforms: {
        resolution: { value: new Vector2() },
        opacity: { value: 1 },
        planeD: { value: planeD },
        hw: { value: hw },
        ringR: { value: ringR },
        shadowW: { value: hw * 5.0 },
        uvScale: { value: planeD / coreD },
      },

      vertexShader: `
        uniform float planeD;
        uniform vec2 resolution;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          float aspect = resolution.x / resolution.y;
          vec2 offset = uv * 2.0 - vec2(1.0);
          offset.y *= aspect;
          vec4 screenPoint = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          screenPoint.xy += offset * planeD * screenPoint.w / resolution.x;
          gl_Position = screenPoint;
        }
      `,
      fragmentShader: `
        uniform float hw;
        uniform float ringR;
        uniform float shadowW;
        uniform float opacity;
        uniform float uvScale;
        varying vec2 vUv;

        void main() {
          vec2 uv = (vUv * 2.0 - 1.0) * uvScale;
          float len = length(uv);
          float fw = fwidth(len) * 0.5;
          float d = abs(len - ringR);

          float ring = 1.0 - smoothstep(hw - fw, hw + fw, d);

          float shadow = (1.0 - smoothstep(hw, shadowW, d)) * (1.0 - smoothstep(ringR - fw, ringR + fw, len)) * 0.5;

          float white = ring;
          float black = shadow * (1.0 - white);
          float alpha = (white + black) * opacity;
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(vec3(white / max(alpha / opacity, 0.001)), alpha);
        }
      `,
    });
  }
}

const _matrix = new Matrix4();
// custom version of set raycaster from camera that relies on the underlying matrices
// so the ray origin is position at the camera near clip.
function setRaycasterFromCamera(raycaster, coords, camera) {
  const ray = raycaster instanceof Ray ? raycaster : raycaster.ray;
  const { origin, direction } = ray;
  // With reversed depth the NDC z range is [1, 0] (near→1, far→0)
  // instead of the standard [-1, 1] (near→-1, far→1).
  const nearZ = camera.reversedDepth ? 1 : -1;
  const farZ = camera.reversedDepth ? 0 : 1;
  // get the origin and direction of the frustum ray
  origin.set(coords.x, coords.y, nearZ).unproject(camera);
  direction.set(coords.x, coords.y, farZ).unproject(camera).sub(origin);
  if (!raycaster.isRay) {
    // compute the far value based on the distance from point on the near
    // plane and point on the far plane. Then normalize the direction.
    raycaster.near = 0;
    raycaster.far = direction.length();
    raycaster.camera = camera;
  }
  // normalize the ray direction
  direction.normalize();
}
function mouseToCoords(clientX, clientY, element, target) {
  const rect = element.getBoundingClientRect();
  target.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  target.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}
function makeRotateAroundPoint(point, quat, target) {
  target.makeTranslation(-point.x, -point.y, -point.z);
  _matrix.makeRotationFromQuaternion(quat);
  target.premultiply(_matrix);
  _matrix.makeTranslation(point.x, point.y, point.z);
  target.premultiply(_matrix);
  return target;
}
const NONE = 0;
const DRAG = 1;
const ROTATE = 2;
const IDLE = 3;
const START_EVENT = { type: 'start' };
const UPDATE_EVENT = { type: 'update' };
const FINISH_EVENT = { type: 'finish' };
const THRESHOLD = 1e-3;
const INTERIOR_CAMERA_ANCHOR_TAPER_START_DISTANCE =
  (CAMERA_CENTER_MODE_DISTANCE * 2) / 3;
const MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE =
  CAMERA_CENTER_MODE_DISTANCE - THRESHOLD;
const MAX = 1e8;
const PIVOT_SIZE = 22;
const PIVOT_THICKNESS = 2.5;
const VIRTUAL_HIT_DISTANCE = 50;
const _pointer = new Vector2();
const _pointer1 = new Vector2();
const _pointer2 = new Vector2();
const _pivotPoint = new Vector3();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _forward = new Vector3(0, 0, -1);
const _worldZ = new Vector3(0, 0, 1);
const _vec = new Vector3(1, 1, 1);
const _vec1 = new Vector3();
const _vec2 = new Vector3();
const _vec3 = new Vector3();
const _vec4 = new Vector3();
const _vec5 = new Vector3();
const _vec6 = new Vector3();
const _axis = new Vector3();
const _localUp = new Vector3();
const _positionUp = new Vector3();
const _localRight = new Vector3();
const _anchorLocal = new Vector3();
const _anchorOffset = new Vector3();
const _rotMatrix = new Matrix4();
const _quaternion = new Quaternion();
const _plane = new Plane();
const _ray = new Ray();
const _dragEllipsoid = new Ellipsoid(1, 1, 1);
class CameraController extends EventDispatcher {
  enableDamping;
  dampingFactor;
  state;
  zooming;
  touchZooming;
  minDistance;
  minZoomLimit;
  #pointerTracker;
  #domElement;
  #camera;
  #scene;
  #raycaster;
  #pivotMesh;
  #zoomDelta;
  #zoomInertia;
  #rotateInertia;
  #dragInertia;
  #dragAnchorPoint;
  #dragPlaneNormal;
  #inertiaValue;
  #enabled;
  #ellipsoid;
  #ellipsoidMaxRadius;
  #lastTime;
  #hit;
  #pointerDownFilter;
  #raycastHitFilter;
  #zoomTimeout;
  constructor(renderer, scene, camera, options = {}) {
    super();
    if (typeof options !== 'object' || options === null) {
      options = {};
    }
    this.#scene = scene;
    this.#camera = camera;
    this.#domElement = options.domElement ?? renderer.domElement;
    this.enableDamping = options.enableDamping ?? true;
    this.dampingFactor = 0.8;
    this.minDistance = 0.5;
    this.minZoomLimit = false;
    this.state = NONE;
    this.zooming = false;
    this.touchZooming = false;
    this.#pointerTracker = new PointerTracker();
    this.#raycaster = new Raycaster();
    this.#raycaster.params.Points.threshold = 0.1;
    this.#pivotMesh = new PivotPointMesh(PIVOT_SIZE, PIVOT_THICKNESS);
    this.#pivotMesh.visible = false;
    this.#zoomDelta = 0;
    this.#zoomInertia = 0;
    this.#rotateInertia = new Vector2();
    this.#dragInertia = new Vector3();
    this.#dragAnchorPoint = new Vector3();
    this.#dragPlaneNormal = new Vector3();
    this.#inertiaValue = 0;
    this.#enabled = false;
    this.#ellipsoid = null;
    this.#ellipsoidMaxRadius = 0;
    this.#lastTime = 0;
    this.#hit = null;
    this.#pointerDownFilter =
      typeof options.pointerDownFilter === 'function'
        ? options.pointerDownFilter
        : null;
    this.#raycastHitFilter =
      typeof options.raycastHitFilter === 'function'
        ? options.raycastHitFilter
        : null;
    this.#zoomTimeout = null;
    this.init();
  }
  get enabled() {
    return this.#enabled;
  }
  set enabled(v) {
    if (v !== this.enabled) {
      this.#enabled = v;
      this.#resetState();
      this.#pointerTracker.reset();
      this.dispatchEvent(UPDATE_EVENT);
      this.dispatchEvent(FINISH_EVENT);
    }
  }
  get camera() {
    return this.#camera;
  }
  get indicator() {
    return this.#pivotMesh;
  }
  #setState(state = this.state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    if (state !== NONE) {
      this.#pivotMesh.visible = true;
    }
  }
  #setZooming(zooming, touchZooming = false) {
    if (!this.zooming && this.state === NONE && zooming) {
      this.#pivotMesh.visible = true;
    }
    this.zooming = zooming;
    this.touchZooming = touchZooming;
  }
  #resetState() {
    this.state = NONE;
    this.zooming = false;
    this.touchZooming = false;
    this.#inertiaValue = 0;
    this.#rotateInertia.set(0, 0);
    this.#dragInertia.set(0, 0, 0);
    this.#dragAnchorPoint.set(0, 0, 0);
    this.#dragPlaneNormal.set(0, 0, 0);
    this.#zoomInertia = 0;
    this.#hit = null;
    this.#pivotMesh.visible = false;
  }
  setCamera(camera) {
    this.#camera = camera;
    this.#resetState();
    this.dispatchEvent(UPDATE_EVENT);
    this.dispatchEvent(FINISH_EVENT);
  }
  setEllipsoid(ellipsoid) {
    this.#ellipsoid = ellipsoid;
    const r = ellipsoid.radius;
    this.#ellipsoidMaxRadius = Math.max(r.x, r.y, r.z);
  }
  setPointerDownFilter(filter) {
    this.#pointerDownFilter = typeof filter === 'function' ? filter : null;
    this.#resetState();
    this.#pointerTracker.reset();
  }
  setRaycastHitFilter(filter) {
    this.#raycastHitFilter = typeof filter === 'function' ? filter : null;
    this.#resetState();
  }
  init() {
    this.#domElement.style.touchAction = 'none';
    this.#pivotMesh.raycast = () => {};
    this.#scene.add(this.#pivotMesh);
    this.#bindEvents();
    this.#enabled = true;
  }
  update(time = performance.now()) {
    const deltaTime = time - this.#lastTime;
    if (!this.#enabled || !this.#camera || deltaTime === 0) {
      return;
    }
    this.#lastTime = time;
    if (this.state === NONE && !this.zooming) {
      return;
    }
    const factor =
      (deltaTime * (1 - this.dampingFactor)) /
      (50 +
        50 * (1 - this.dampingFactor) +
        Math.max(0.001, (1 - this.#inertiaValue) ** 3) * 50);
    this.#inertiaValue -= factor;
    this.#inertiaValue = Math.max(this.#inertiaValue, 0);
    if (this.state === ROTATE) {
      this.#pointerTracker.getCenterPoint(_pointer1);
      this.#pointerTracker.getPreviousCenterPoint(_pointer2);
      if (!_pointer1.equals(_pointer2)) {
        _pointer
          .subVectors(_pointer2, _pointer1)
          .multiplyScalar((2 * Math.PI) / this.#domElement.clientHeight);
        this.#rotate(_pointer);
        this.#rotateInertia.copy(_pointer);
        this.#inertiaValue = 1;
        this.#zoomInertia = 0;
        this.#dragInertia.set(0, 0, 0);
        this.#finalizeCamera();
        this.dispatchEvent(UPDATE_EVENT);
      }
    } else if (this.state === DRAG) {
      this.#pointerTracker.getCenterPoint(_pointer1);
      this.#pointerTracker.getPreviousCenterPoint(_pointer2);
      if (!_pointer1.equals(_pointer2) && this.#hit && this.#hit.distance > 0) {
        mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
        mouseToCoords(_pointer2.x, _pointer2.y, this.#domElement, _pointer2);
        const shouldDragModified = this.#shouldDragModified();
        if (shouldDragModified) {
          if (this.#modifiedDrag(_pointer1)) {
            this.#inertiaValue = 1;
            this.#rotateInertia.set(0, 0);
            this.#zoomInertia = 0;
            this.#finalizeCamera(false);
          } else {
            this.#setState(IDLE);
          }
          this.dispatchEvent(UPDATE_EVENT);
        } else if (
          this.#intersectDragPlane(_pointer1, _vec1) &&
          this.#intersectDragPlane(_pointer2, _vec2)
        ) {
          _vec.subVectors(_vec1, this.#dragAnchorPoint);
          _vec5.subVectors(_vec1, _vec2);
          this.#camera.position.sub(_vec);
          this.#dragInertia.copy(_vec5);
          this.#inertiaValue = 1;
          this.#rotateInertia.set(0, 0);
          this.#zoomInertia = 0;
          this.#finalizeCamera();
          if (!shouldDragModified && this.#shouldDragModified()) {
            this.#initializeDragAnchor();
          }
          this.dispatchEvent(UPDATE_EVENT);
        }
      }
    } else if (this.state === IDLE) {
      if (this.enableDamping) {
        if (this.#rotateInertia.lengthSq() > 0 && this.#inertiaValue > 0) {
          _pointer.copy(this.#rotateInertia).multiplyScalar(this.#inertiaValue);
          this.#rotate(_pointer);
          this.#finalizeCamera();
        } else if (this.#dragInertia.lengthSq() > 0 && this.#inertiaValue > 0) {
          const shouldDragModified = this.#shouldDragModified();
          if (shouldDragModified) {
            _vec.copy(this.#dragInertia).multiplyScalar(this.#inertiaValue);
            const angle = _vec.length();
            if (angle > THRESHOLD) {
              _axis.copy(_vec).multiplyScalar(1 / angle);
              _quaternion.setFromAxisAngle(_axis, angle);
              this.#applyCameraRotationAroundOrigin(_quaternion);
            }
            this.#finalizeCamera(false);
          } else {
            _vec.copy(this.#dragInertia).multiplyScalar(this.#inertiaValue);
            this.#camera.position.sub(_vec);
            this.#finalizeCamera();
          }
          if (!shouldDragModified && this.#shouldDragModified()) {
            this.#initializeDragAnchor();
          }
        }
        if (
          (this.#rotateInertia.lengthSq() === 0 &&
            this.#dragInertia.lengthSq() === 0) ||
          this.#inertiaValue === 0
        ) {
          this.#rotateInertia.set(0, 0);
          this.#dragInertia.set(0, 0, 0);
          if (!this.zooming) {
            this.#resetState();
            this.dispatchEvent(UPDATE_EVENT);
            this.dispatchEvent(FINISH_EVENT);
          } else {
            this.#setState(NONE);
            this.dispatchEvent(UPDATE_EVENT);
          }
        } else {
          this.dispatchEvent(UPDATE_EVENT);
        }
      } else {
        this.#rotateInertia.set(0, 0);
        this.#dragInertia.set(0, 0, 0);
        this.#zoomInertia = 0;
        this.#resetState();
        this.dispatchEvent(UPDATE_EVENT);
        this.dispatchEvent(FINISH_EVENT);
      }
    }
    if (this.zooming) {
      if (this.touchZooming) {
        const previousDistance =
          this.#pointerTracker.getPreviousTouchPointerDistance();
        const currentDistance = this.#pointerTracker.getTouchPointerDistance();
        const delta =
          (currentDistance - previousDistance) /
          Math.sqrt(
            this.#domElement.clientWidth ** 2 +
              this.#domElement.clientHeight ** 2,
          );
        this.#zoomDelta = delta * 4000;
      }
      if (this.#zoomDelta !== 0) {
        this.#rotateInertia.set(0, 0);
        this.#dragInertia.set(0, 0, 0);
        if (this.#zoomTimeout !== null) {
          clearTimeout(this.#zoomTimeout);
          this.#zoomTimeout = null;
        }
        if (this.#zoomDelta <= 0 && this.#reachCameraMaxDistance()) {
          this.#zoomDelta = 0;
        } else {
          this.#applyZoom(this.#zoomDelta);
        }
        this.#zoomInertia = this.#zoomDelta;
        this.#inertiaValue = 1;
        this.#zoomDelta = 0;
        this.dispatchEvent(UPDATE_EVENT);
        if (!this.enableDamping) {
          this.#zoomTimeout = setTimeout(() => {
            this.#zoomInertia = 0;
            this.#zoomTimeout = null;
            if (this.state === NONE || this.state === IDLE) {
              this.#resetState();
              this.dispatchEvent(UPDATE_EVENT);
              this.dispatchEvent(FINISH_EVENT);
            }
          }, 500);
        }
      } else if (this.enableDamping && this.#inertiaValue > 0) {
        if (this.#zoomInertia <= 0 && this.#reachCameraMaxDistance()) {
          this.#zoomInertia = 0;
          this.dispatchEvent(UPDATE_EVENT);
        } else {
          if (
            this.#zoomInertia !== 0 &&
            this.#inertiaValue > 0 &&
            this.#hit &&
            this.#hit.distance > 0
          ) {
            this.#applyZoom(this.#zoomInertia * this.#inertiaValue);
            this.dispatchEvent(UPDATE_EVENT);
          } else {
            this.#zoomInertia = 0;
            if (this.state === NONE) {
              this.#resetState();
              this.dispatchEvent(UPDATE_EVENT);
              this.dispatchEvent(FINISH_EVENT);
            }
          }
        }
      } else if (this.enableDamping && this.state === NONE) {
        this.#resetState();
        this.dispatchEvent(UPDATE_EVENT);
        this.dispatchEvent(FINISH_EVENT);
      } else {
        this.#zoomDelta = 0;
        this.#zoomInertia = 0;
      }
    }
    this.#pointerTracker.updateFrame();
  }
  dispose() {
    if (this.#zoomTimeout !== null) {
      clearTimeout(this.#zoomTimeout);
      this.#zoomTimeout = null;
    }
    this.#domElement.removeEventListener('contextmenu', this.#contextMenu);
    this.#domElement.removeEventListener('pointerdown', this.#pointerDown);
    this.#domElement.removeEventListener('pointermove', this.#pointerMove);
    this.#domElement.removeEventListener('pointerup', this.#pointerUp);
    this.#domElement.removeEventListener('wheel', this.#wheel);
    this.#domElement.removeEventListener('pointerenter', this.#pointerEnter);
    this.#pivotMesh.removeFromParent();
    this.#pivotMesh.dispose();
    this.#domElement.style.touchAction = '';
    this.#enabled = false;
    this.#ellipsoid = null;
  }
  #bindEvents() {
    this.#domElement.addEventListener('contextmenu', this.#contextMenu);
    this.#domElement.addEventListener('pointerdown', this.#pointerDown);
    this.#domElement.addEventListener('pointermove', this.#pointerMove);
    this.#domElement.addEventListener('pointerup', this.#pointerUp);
    this.#domElement.addEventListener('wheel', this.#wheel);
    this.#domElement.addEventListener('pointerenter', this.#pointerEnter);
  }
  #contextMenu = (e) => {
    e.preventDefault();
  };
  #updateIndicatorFromHit() {
    if (this.#hit && this.#hit.distance > 0) {
      this.#pivotMesh.visible = true;
      this.#pivotMesh.position.copy(this.#hit.point);
      this.#pivotMesh.focus = !this.#hit.onGlobe;
    } else {
      this.#pivotMesh.visible = false;
    }
  }
  #pointerDown = (e) => {
    if (!this.#enabled) {
      return;
    }
    if (this.#pointerDownFilter && !this.#pointerDownFilter(e)) {
      return;
    }
    this.#pointerTracker.addPointer(e);
    if (
      (this.#pointerTracker.getPointerCount() === 2 &&
        this.#pointerTracker.isPointerTouch()) ||
      (!this.#pointerTracker.isPointerTouch() &&
        this.#pointerTracker.isRightClicked()) ||
      (this.#pointerTracker.isLeftClicked() && e.shiftKey)
    ) {
      this.#setState(DRAG);
      this.#setZooming(false);
    } else if (
      (this.#pointerTracker.getPointerCount() === 1 &&
        this.#pointerTracker.isPointerTouch()) ||
      (!this.#pointerTracker.isPointerTouch() &&
        this.#pointerTracker.isLeftClicked() &&
        !e.shiftKey)
    ) {
      this.#setState(ROTATE);
      this.#setZooming(false);
    }
    if (
      this.#pointerTracker.getPointerCount() === 2 &&
      this.#pointerTracker.isPointerTouch()
    ) {
      this.#setZooming(true, true);
    }
    if (this.state === NONE) {
      this.#setState(IDLE);
    }
    if (this.state === ROTATE || this.state === DRAG || this.zooming) {
      this.#pointerTracker.getCenterPoint(_pointer1);
      mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
      setRaycasterFromCamera(this.#raycaster, _pointer1, this.#camera);
      this.#hit = this.#raycast(this.#raycaster);
      this.#updateIndicatorFromHit();
      if (this.state === DRAG && this.#hit.distance > 0) {
        this.#initializeDragAnchor();
      }
      this.dispatchEvent(START_EVENT);
    }
    this.#rotateInertia.set(0, 0);
    this.#dragInertia.set(0, 0, 0);
    this.#zoomInertia = 0;
    this.#zoomDelta = 0;
    this.dispatchEvent(UPDATE_EVENT);
  };
  #pointerMove = (e) => {
    e.preventDefault();
    if (!this.#enabled) {
      return;
    }
    this.#pointerTracker.setHoverEvent(e);
    this.#pointerTracker.updatePointer(e);
  };
  #pointerUp = (e) => {
    this.#pointerTracker.deletePointer(e);
    if (!this.#enabled) {
      return;
    }
    if (this.zooming || this.state !== NONE) {
      this.#setState(IDLE);
    }
    this.dispatchEvent(UPDATE_EVENT);
  };
  #wheel = (e) => {
    e.preventDefault();
    if (!this.#enabled) {
      return;
    }
    const tooClose =
      this.#pivotMesh.position.distanceTo(this.#camera.position) <=
      this.#camera.near;
    if (!this.zooming || tooClose) {
      this.#rotateInertia.set(0, 0);
      this.#dragInertia.set(0, 0, 0);
      this.#zoomInertia = 0;
      this.#zoomDelta = 0;
    }
    this.#pointerTracker.setHoverEvent(e);
    this.#pointerTracker.updatePointer(e);
    this.#pointerTracker.getLatestPoint(_pointer1);
    mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
    setRaycasterFromCamera(this.#raycaster, _pointer1, this.#camera);
    if ((!this.zooming && this.state === NONE) || tooClose) {
      this.#hit = this.#raycast(this.#raycaster);
      this.#updateIndicatorFromHit();
    }
    let delta = 0;
    switch (e.deltaMode) {
      case 2: // Pages
        delta = e.deltaY * 800;
        break;
      case 1: // Lines
        delta = e.deltaY * 40;
        break;
      case 0: // Pixels
        delta = e.deltaY;
        break;
    }
    // use LOG to scale the scroll delta and hopefully normalize them across platforms
    const deltaSign = Math.sign(delta);
    const normalizedDelta = Math.max(40, Math.abs(delta));
    this.#zoomDelta =
      -0.8 *
      deltaSign *
      normalizedDelta *
      (this.enableDamping ? 1 - this.dampingFactor : 1);
    this.#setZooming(true);
    this.dispatchEvent(START_EVENT);
    this.dispatchEvent(UPDATE_EVENT);
  };
  #pointerEnter = (e) => {
    if (!this.#enabled) {
      return;
    }
    if (e.buttons !== this.#pointerTracker.getPointerButtons()) {
      this.#pointerTracker.deletePointer(e);
      this.#resetState();
      this.dispatchEvent(UPDATE_EVENT);
      this.dispatchEvent(FINISH_EVENT);
    }
  };
  #finalizeCamera(preservePolarAnchor = true) {
    const fixedPoint =
      this.#hit && this.#hit.distance > 0 ? this.#hit.point : undefined;
    this.#limitCameraDistance(fixedPoint);
    const wasInsideEllipsoid = this.#isPositionInsideEllipsoid(
      this.#camera.position,
    );
    if (fixedPoint && !this.#isCameraCenterMode()) {
      this.#keepCameraUp(fixedPoint);
    } else {
      this.#keepCameraUp();
    }
    if (
      !wasInsideEllipsoid &&
      this.#isPositionInsideEllipsoid(this.#camera.position)
    ) {
      this.#limitCameraDistance(fixedPoint);
      this.#keepCameraUp();
    }
    const isCameraCenterMode = this.#isCameraCenterMode();
    const referenceUp = isCameraCenterMode
      ? _worldZ
      : this.#getPositionUpDirection(this.#camera.position, _positionUp);
    // Modified globe drag already rotates around the Earth center. Preserving
    // an off-center anchor during a polar correction would translate the
    // camera and make the globe silhouette drift or change size.
    this.#clampCameraPolarAngle(
      referenceUp,
      isCameraCenterMode || !preservePolarAnchor ? undefined : fixedPoint,
    );
    this.#camera.updateMatrixWorld();
  }
  #getPositionUpDirection(position, target) {
    if (this.#ellipsoid) {
      this.#ellipsoid.getPositionToNormal(position, target);
      if (target.lengthSq() > THRESHOLD * THRESHOLD) {
        return target;
      }
    }
    if (position.lengthSq() > THRESHOLD * THRESHOLD) {
      return target.copy(position).normalize();
    }
    return target.copy(_worldZ);
  }
  #rotateNearAnchor(rotateVec) {
    if (!this.#hit) {
      return;
    }
    this.#camera.getWorldDirection(_forward);
    const cameraVerticalAngle = Math.PI - _forward.angleTo(_worldZ);
    const maxVerticalAngle = Math.PI - THRESHOLD;
    const minVerticalAngle = THRESHOLD;
    const verticalAngle = Math.min(
      Math.max(rotateVec.y, minVerticalAngle - cameraVerticalAngle),
      maxVerticalAngle - cameraVerticalAngle,
    );
    const horizontalAngle = rotateVec.x;
    _quaternion.setFromAxisAngle(_worldZ, horizontalAngle);
    makeRotateAroundPoint(this.#hit.point, _quaternion, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    this.#camera.matrixWorld.decompose(
      this.#camera.position,
      this.#camera.quaternion,
      _vec6,
    );
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _vec1.crossVectors(_forward, _up).normalize();
    _right.copy(_vec1).projectOnPlane(_worldZ);
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      _right.crossVectors(_forward, _worldZ);
    }
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      return;
    }
    _right.normalize();
    if (_right.dot(_vec1) < 0) {
      _right.negate();
    }
    _quaternion.setFromAxisAngle(_right, verticalAngle);
    makeRotateAroundPoint(this.#hit.point, _quaternion, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    this.#camera.matrixWorld.decompose(
      this.#camera.position,
      this.#camera.quaternion,
      _vec6,
    );
  }
  #clampVerticalRotateAngle(axis, pivotPoint, verticalAngle) {
    if (verticalAngle <= 0) {
      return verticalAngle;
    }
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    const axisDotUp = axis.dot(_up);
    const axisDotPivot = axis.dot(pivotPoint);
    const axisProjection = axisDotPivot * axisDotUp;
    const a = pivotPoint.dot(_up) - axisProjection;
    const b = pivotPoint.dot(_vec1.crossVectors(axis, _up));
    const d = this.#camera.position.dot(_up) - a;
    const amplitude = Math.hypot(a, b);
    if (amplitude <= THRESHOLD) {
      return verticalAngle;
    }
    const cosValue = -d / amplitude;
    if (cosValue < -1 - THRESHOLD || cosValue > 1 + THRESHOLD) {
      return verticalAngle;
    }
    const clampedCosValue = Math.min(1, Math.max(-1, cosValue));
    const phase = Math.atan2(b, a);
    const delta = Math.acos(clampedCosValue);
    let result = verticalAngle;
    for (const candidate of [phase - delta, phase + delta]) {
      for (const offset of [-2 * Math.PI, 0, 2 * Math.PI]) {
        const angle = candidate + offset;
        if (angle > THRESHOLD && angle < result && angle <= verticalAngle) {
          result = angle;
        }
      }
    }
    return result;
  }
  #rotate(rotateVec) {
    if (!this.#hit) {
      return;
    }
    if (this.#isCameraCenterMode()) {
      this.#rotateNearAnchor(rotateVec);
      return;
    }
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _right.crossVectors(_forward, _up).normalize();
    this.#getPositionUpDirection(this.#hit.point, _localUp);
    this.#getPositionUpDirection(this.#camera.position, _positionUp);
    const cameraVerticalAngle = Math.PI - _forward.angleTo(_positionUp);
    const maxVerticalAngle = Math.PI - THRESHOLD;
    const minVerticalAngle = THRESHOLD;
    let verticalAngle = Math.min(
      Math.max(rotateVec.y, minVerticalAngle - cameraVerticalAngle),
      maxVerticalAngle - cameraVerticalAngle,
    );
    _ray.set(
      _pivotPoint
        .copy(this.#hit.point)
        .sub(_vec6.copy(_right).multiplyScalar(MAX)),
      _right,
    );
    _plane.setFromNormalAndCoplanarPoint(_right, this.#camera.position);
    _ray.intersectPlane(_plane, _pivotPoint);
    verticalAngle = this.#clampVerticalRotateAngle(
      _right,
      _pivotPoint,
      verticalAngle,
    );
    // Rotate around the right axis
    _quaternion.setFromAxisAngle(_right, verticalAngle);
    makeRotateAroundPoint(_pivotPoint, _quaternion, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    // Rotate around the up axis
    const horizontalAngle = rotateVec.x;
    _quaternion.setFromAxisAngle(_localUp, horizontalAngle);
    makeRotateAroundPoint(this.#hit.point, _quaternion, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    // Explicitly set the quaternion before decomposing
    this.#camera.matrixWorld.decompose(
      this.#camera.position,
      this.#camera.quaternion,
      _vec6,
    );
  }
  #initializeDragAnchor() {
    if (!this.#hit || this.#hit.distance <= 0) {
      return;
    }
    this.#dragAnchorPoint.copy(this.#hit.point);
  }
  #intersectDragPlane(pointer, target) {
    this.#camera.getWorldDirection(this.#dragPlaneNormal);
    _plane.setFromNormalAndCoplanarPoint(
      this.#dragPlaneNormal,
      this.#dragAnchorPoint,
    );
    setRaycasterFromCamera(this.#raycaster, pointer, this.#camera);
    return this.#raycaster.ray.intersectPlane(_plane, target) !== null;
  }
  #modifiedDrag(pointer) {
    if (!this.#hit || this.#hit.distance <= 0 || this.#hit.virtual) {
      return false;
    }
    const radius = this.#dragAnchorPoint.length();
    if (radius <= THRESHOLD) {
      return false;
    }
    _dragEllipsoid.radius.setScalar(radius);
    setRaycasterFromCamera(this.#raycaster, pointer, this.#camera);
    if (!_dragEllipsoid.intersectRay(this.#raycaster.ray, _vec1)) {
      return false;
    }
    _vec2.copy(_vec1).normalize();
    if (this.#raycaster.ray.direction.dot(_vec2) > 0) {
      return false;
    }
    _vec1.normalize();
    _vec2.copy(this.#dragAnchorPoint).normalize();
    _quaternion.setFromUnitVectors(_vec1, _vec2);
    this.#setModifiedDragInertia(_quaternion);
    this.#applyCameraRotationAroundOrigin(_quaternion);
    return true;
  }
  #setModifiedDragInertia(rotation) {
    _axis.set(rotation.x, rotation.y, rotation.z);
    if (rotation.w < 0) {
      _axis.negate();
    }
    const axisLength = _axis.length();
    if (axisLength <= THRESHOLD) {
      this.#dragInertia.set(0, 0, 0);
      return;
    }
    const angle = 2 * Math.atan2(axisLength, Math.abs(rotation.w));
    this.#dragInertia.copy(_axis).multiplyScalar(angle / axisLength);
  }
  #applyCameraRotationAroundOrigin(rotation) {
    makeRotateAroundPoint(_vec3.set(0, 0, 0), rotation, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    this.#camera.matrixWorld.decompose(
      this.#camera.position,
      this.#camera.quaternion,
      _vec3,
    );
  }
  #getZoomDistanceScale(zoomAmount, source, anchorPoint) {
    if (zoomAmount >= 0 || !this.#ellipsoid || this.#isCameraCenterMode()) {
      return 1;
    }
    if (anchorPoint && this.#isPositionInsideEllipsoid(source)) {
      const currentDistance = source.distanceTo(anchorPoint);
      if (currentDistance <= INTERIOR_CAMERA_ANCHOR_TAPER_START_DISTANCE) {
        return 1;
      }
      if (currentDistance >= MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE) {
        return 0;
      }
      return (
        (MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE - currentDistance) /
        (MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE -
          INTERIOR_CAMERA_ANCHOR_TAPER_START_DISTANCE)
      );
    }
    const taperStartRadius = this.#ellipsoidMaxRadius * 1.5;
    const maxRadius = this.#ellipsoidMaxRadius * 2;
    const currentDistance = source.length();
    if (currentDistance <= taperStartRadius) {
      return 1;
    }
    if (currentDistance >= maxRadius) {
      return 0;
    }
    return (maxRadius - currentDistance) / (maxRadius - taperStartRadius);
  }
  #applyZoom(zoomAmount) {
    const hit = this.#hit;
    if (!hit || hit.distance <= 0) return;
    // Regenerate virtual hit at 50m from current camera position
    if (hit.virtual) {
      _forward.subVectors(hit.point, this.#camera.position).normalize();
      hit.point
        .copy(this.#camera.position)
        .addScaledVector(_forward, VIRTUAL_HIT_DISTANCE);
      hit.distance = VIRTUAL_HIT_DISTANCE;
      this.#pivotMesh.position.copy(hit.point);
    }
    let zoomFactor = Math.exp(-zoomAmount * 0.001);
    if (this.minDistance > 0 && zoomFactor < 1) {
      const distance = this.#camera.position.distanceTo(hit.point);
      if (distance * zoomFactor < this.minDistance) {
        zoomFactor = this.minDistance / distance;
      }
    }
    if (this.#camera.isOrthographicCamera) {
      this.#camera.zoom /= zoomFactor;
      this.#camera.updateProjectionMatrix();
    }
    const source = _vec4.copy(this.#camera.position);
    // Preserve the established exterior-zoom alignment for the whole step.
    const useExteriorZoomAlignment =
      !!this.#ellipsoid && !this.#isPositionInsideEllipsoid(source);
    const distanceScale = this.#getZoomDistanceScale(
      zoomAmount,
      source,
      hit.virtual ? undefined : hit.point,
    );
    this.#camera.position
      .copy(source)
      .sub(hit.point)
      .multiplyScalar(1 + (zoomFactor - 1) * distanceScale)
      .add(hit.point);
    this.#limitCameraDistance(hit.point);
    const keepZoomAnchor =
      !this.#ellipsoid ||
      this.#isPositionInsideEllipsoid(this.#camera.position) ||
      this.#canApplyCameraRollAroundAnchor(hit.point);
    const wasInsideEllipsoid = this.#isPositionInsideEllipsoid(
      this.#camera.position,
    );
    if (this.#isCameraCenterMode()) {
      this.#camera.updateMatrixWorld();
    } else {
      this.#keepCameraUp(
        keepZoomAnchor ? hit.point : undefined,
        useExteriorZoomAlignment,
      );
    }
    if (
      !wasInsideEllipsoid &&
      this.#isPositionInsideEllipsoid(this.#camera.position)
    ) {
      this.#limitCameraDistance(hit.point);
      if (!this.#isCameraCenterMode()) {
        this.#keepCameraUp(undefined, useExteriorZoomAlignment);
      }
    }
    this.#camera.updateMatrixWorld();
    if (this.state === DRAG) {
      this.#initializeDragAnchor();
    }
  }
  #reachCameraMaxDistance() {
    if (!this.#ellipsoid || this.#isCameraCenterMode()) return false;
    if (
      this.#hit &&
      this.#hit.distance > 0 &&
      !this.#hit.virtual &&
      this.#isPositionInsideEllipsoid(this.#camera.position) &&
      this.#camera.position.distanceToSquared(this.#hit.point) >=
        MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE ** 2
    ) {
      return true;
    }
    return this.#camera.position.length() >= this.#ellipsoidMaxRadius * 2;
  }
  #isCameraCenterMode() {
    return this.#camera.position.lengthSq() <= CAMERA_CENTER_MODE_DISTANCE_SQ;
  }
  #isPositionInsideEllipsoid(position) {
    if (!this.#ellipsoid) return false;
    return _vec3.copy(position).divide(this.#ellipsoid.radius).lengthSq() < 1;
  }
  #canApplyCameraRollAroundAnchor(anchorPoint) {
    return (
      anchorPoint.dot(_vec3.subVectors(this.#camera.position, anchorPoint)) >= 0
    );
  }
  #clampCameraDistanceFromPoint(point) {
    _vec6.subVectors(this.#camera.position, point);
    const distanceSq = _vec6.lengthSq();
    if (distanceSq <= MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE ** 2) return;
    this.#camera.position
      .copy(point)
      .addScaledVector(
        _vec6,
        MAX_INTERIOR_CAMERA_ANCHOR_DISTANCE / Math.sqrt(distanceSq),
      );
  }
  #limitCameraDistance(pivotPosition) {
    if (!this.#ellipsoid || this.#isCameraCenterMode()) return;
    if (this.#isPositionInsideEllipsoid(this.#camera.position)) {
      if (pivotPosition) {
        this.#clampCameraDistanceFromPoint(pivotPosition);
      }
      if (
        this.#isCameraCenterMode() ||
        this.#isPositionInsideEllipsoid(this.#camera.position)
      ) {
        return;
      }
    }
    const maxRadius = this.#ellipsoidMaxRadius * 2;
    const currentDistance = this.#camera.position.length();
    if (currentDistance <= maxRadius) return;
    if (pivotPosition) {
      _vec6.subVectors(this.#camera.position, pivotPosition);
      const a = _vec6.lengthSq();
      if (a <= THRESHOLD * THRESHOLD) {
        this.#camera.position.setLength(maxRadius);
        return;
      }
      // Solve for t in: |pivotPosition + t * (cameraPosition - pivotPosition)| = maxRadius
      const b = 2 * pivotPosition.dot(_vec6);
      const c = pivotPosition.lengthSq() - maxRadius ** 2;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) {
        this.#camera.position.setLength(maxRadius);
        return;
      }
      const sqrtDiscriminant = Math.sqrt(discriminant);
      const t0 = (-b - sqrtDiscriminant) / (2 * a);
      const t1 = (-b + sqrtDiscriminant) / (2 * a);
      // Clamp to the intersection on the pivot->camera segment; fall back to
      // radial clamp if the line only intersects outside the segment, to avoid
      // large jumps when the pivot is virtual or near-tangent.
      let t = Number.NaN;
      if (t0 >= 0 && t0 <= 1) {
        t = t0;
      }
      if (t1 >= 0 && t1 <= 1) {
        t = Number.isNaN(t) ? t1 : Math.max(t, t1);
      }
      if (Number.isNaN(t)) {
        this.#camera.position.setLength(maxRadius);
        return;
      }
      this.#camera.position.copy(pivotPosition).addScaledVector(_vec6, t);
    } else {
      this.#camera.position.setLength(maxRadius);
    }
  }
  #shouldDragModified() {
    return (
      !!this.#ellipsoid &&
      !this.#isCameraCenterMode() &&
      this.#camera.position.length() >= this.#ellipsoidMaxRadius * 1.05
    );
  }
  #alignCameraRollForExteriorZoom(referenceUp) {
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _right.crossVectors(_forward, _up).normalize();
    _localRight.crossVectors(_up, referenceUp);
    if (_localRight.dot(_right) < 0) {
      _localRight.negate();
    }
    _quaternion.setFromUnitVectors(_right, _localRight);
    this.#camera.quaternion.premultiply(_quaternion);
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _right.crossVectors(_forward, _up).normalize();
    _localUp.crossVectors(_forward, referenceUp);
    if (_localUp.dot(_right) < 0) {
      const forwardAngle = _forward.angleTo(referenceUp);
      if (forwardAngle < Math.PI / 2) {
        _axis.crossVectors(_forward, referenceUp).normalize();
        _quaternion.setFromAxisAngle(_axis, forwardAngle);
        this.#camera.quaternion.premultiply(_quaternion);
      } else {
        _axis
          .crossVectors(_forward, _vec4.copy(referenceUp).negate())
          .normalize();
        const negatedAngle = _forward.angleTo(_vec4);
        _quaternion.setFromAxisAngle(_axis, negatedAngle);
        this.#camera.quaternion.premultiply(_quaternion);
      }
    }
  }
  #alignCameraRoll(referenceUp) {
    this.#camera.updateMatrixWorld();
    _forward.set(0, 0, -1).transformDirection(this.#camera.matrixWorld);
    _right.set(-1, 0, 0).transformDirection(this.#camera.matrixWorld);
    // Fade the correction when forward and referenceUp are nearly parallel,
    // where a unique screen-up direction does not exist.
    let alpha = MathUtils.mapLinear(
      1 - Math.abs(_forward.dot(referenceUp)),
      0,
      0.2,
      0,
      1,
    );
    alpha = MathUtils.clamp(alpha, 0, 1);
    // Keep this a pure roll by rotating the camera-side vector around forward.
    _localRight
      .crossVectors(referenceUp, _forward)
      .lerp(_right, 1 - alpha)
      .normalize();
    _quaternion.setFromUnitVectors(_right, _localRight);
    this.#camera.quaternion.premultiply(_quaternion);
  }
  #clampCameraPolarAngle(referenceUp, fixedPoint) {
    this.#camera.updateMatrixWorld();
    _forward.set(0, 0, 1).transformDirection(this.#camera.matrixWorld);
    _right.set(1, 0, 0).transformDirection(this.#camera.matrixWorld);
    const minVerticalAngle = THRESHOLD;
    const maxVerticalAngle = Math.PI - THRESHOLD;
    const verticalAngle = referenceUp.angleTo(_forward);
    const side = _vec.crossVectors(referenceUp, _forward).dot(_right);
    let targetAngle;
    if (side < 0) {
      // The signed angle wrapped across an endpoint of the legal 0..PI arc.
      // Select the closest endpoint so crossing PI cannot snap back to zero.
      targetAngle =
        verticalAngle < Math.PI / 2 ? minVerticalAngle : maxVerticalAngle;
    } else if (verticalAngle < minVerticalAngle) {
      targetAngle = minVerticalAngle;
    } else if (verticalAngle > maxVerticalAngle) {
      targetAngle = maxVerticalAngle;
    } else {
      return;
    }
    if (fixedPoint) {
      // Preserve the complete camera-local anchor position so the final polar
      // correction cannot move the active rotate / drag point on screen.
      _anchorLocal
        .copy(fixedPoint)
        .applyMatrix4(this.#camera.matrixWorldInverse);
    }
    _right.projectOnPlane(referenceUp);
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      if (Math.abs(referenceUp.z) > 0.9) {
        _axis.set(0, 1, 0);
      } else {
        _axis.set(0, 0, 1);
      }
      _right.crossVectors(_axis, referenceUp);
    }
    _right.normalize();
    _forward.copy(referenceUp);
    _quaternion.setFromAxisAngle(_right, targetAngle);
    _forward.applyQuaternion(_quaternion).normalize();
    _localUp.crossVectors(_forward, _right).normalize();
    _rotMatrix.makeBasis(_right, _localUp, _forward);
    this.#camera.quaternion.setFromRotationMatrix(_rotMatrix);
    if (fixedPoint) {
      this.#camera.updateMatrixWorld();
      _anchorLocal.applyMatrix4(this.#camera.matrixWorld);
      this.#camera.position.add(
        _anchorOffset.subVectors(fixedPoint, _anchorLocal),
      );
    }
    this.#camera.updateMatrixWorld();
  }
  #keepCameraUp(anchorPoint, useExteriorZoomAlignment = false) {
    if (anchorPoint) {
      // Preserve the complete camera-local anchor position. This works on both
      // sides of the ellipsoid tangent plane and keeps perspective as well as
      // orthographic projection stable through the roll correction.
      this.#camera.updateMatrixWorld();
      _anchorLocal
        .copy(anchorPoint)
        .applyMatrix4(this.#camera.matrixWorldInverse);
    }
    // Near the ellipsoid centre the surface normal is unstable, so fall back to
    // the world up direction.
    const referenceUp = this.#isCameraCenterMode()
      ? _worldZ
      : this.#getPositionUpDirection(this.#camera.position, _positionUp);
    if (useExteriorZoomAlignment) {
      this.#alignCameraRollForExteriorZoom(referenceUp);
    } else {
      this.#alignCameraRoll(referenceUp);
    }
    if (anchorPoint) {
      this.#camera.updateMatrixWorld();
      _anchorLocal.applyMatrix4(this.#camera.matrixWorld);
      this.#camera.position.add(
        _anchorOffset.subVectors(anchorPoint, _anchorLocal),
      );
      this.#camera.updateMatrixWorld();
    }
  }
  #normalRaycastClosest(raycaster, objects) {
    const targets = Array.isArray(objects) ? objects : [objects];
    if (targets.length === 0) return null;
    const intersects = raycaster.intersectObjects(targets, true);
    for (const intersection of intersects) {
      if (
        this.#raycastHitFilter &&
        !this.#raycastHitFilter(intersection, raycaster)
      ) {
        continue;
      }
      return {
        point: intersection.point.clone(),
        distance: intersection.point.distanceTo(this.#camera.position),
      };
    }
    return null;
  }
  #raycast(raycaster) {
    const sceneHit = this.#normalRaycastClosest(raycaster, this.#scene);
    if (sceneHit) {
      return sceneHit;
    }
    const result = this.#isCameraCenterMode()
      ? undefined
      : this.#ellipsoid?.intersectRay(raycaster.ray, _vec6);
    if (result) {
      return {
        point: _vec6.clone(),
        distance: _vec6.distanceTo(this.#camera.position),
        onGlobe: true,
      };
    }
    return {
      point: raycaster.ray.at(VIRTUAL_HIT_DISTANCE, _vec6).clone(),
      distance: VIRTUAL_HIT_DISTANCE,
      onGlobe: true,
      virtual: true,
    };
  }
}

export { CameraController };
