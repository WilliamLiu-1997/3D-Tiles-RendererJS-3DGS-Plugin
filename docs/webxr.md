# WebXR / VR

The Gaussian splat renderer is WebXR-aware when `renderer.xr.isPresenting`.
The integration below applies to `WebGLRenderer` and an initialized
`WebGPURenderer`, subject to browser/device support for the chosen backend
and XR session. Initialize `WebGPURenderer` with `await renderer.init()` before
creating `GaussianSplatRenderer`. GSL's `autoStochastic` mode is disabled in
XR; manual stochastic rendering is available through its
[renderer API](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/v1.0.0/docs/GaussianSplatRenderer.md#webxr).

For a pure WebXR render loop, use the same session-switching pattern as the
upstream
[3D Tiles Renderer VR example](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/example/three/vr.js):
register the normal camera outside XR, switch `TilesRenderer` to Three.js' XR
`ArrayCamera` when an XR session starts, and switch back when the session ends.

```js
import { Vector2 } from 'three';
import { Scheduler } from '3d-tiles-renderer';
import { VRButton } from 'three/addons/webxr/VRButton.js';

tiles.setCamera(camera);
const size = new Vector2();
tiles.setResolution(camera, renderer.getSize(size));

renderer.xr.enabled = true;
document.body.appendChild(VRButton.createButton(renderer));

let xrSession = null;

function clearTilesCameras() {
  for (const registeredCamera of [...tiles.cameras]) {
    tiles.deleteCamera(registeredCamera);
  }
}

function syncTilesCameraForXR() {
  if (renderer.xr.isPresenting) {
    camera.updateMatrixWorld();
    renderer.xr.updateCamera(camera);

    const xrCamera = renderer.xr.getCamera();

    if (xrSession === null) {
      clearTilesCameras();
      tiles.setCamera(xrCamera);

      xrSession = renderer.xr.getSession();
      Scheduler.setXRSession(xrSession);
    }

    const firstViewCamera = xrCamera.cameras[0];
    if (firstViewCamera) {
      tiles.setResolution(
        xrCamera,
        firstViewCamera.viewport.z,
        firstViewCamera.viewport.w,
      );
    }
  } else if (xrSession !== null) {
    clearTilesCameras();
    tiles.setCamera(camera);
    tiles.setResolution(camera, renderer.getSize(size));

    xrSession = null;
    Scheduler.setXRSession(null);
  }
}

renderer.setAnimationLoop(() => {
  syncTilesCameraForXR();
  tiles.update();
  renderer.render(scene, camera);
});
```

The important ordering is `camera.updateMatrixWorld()` before
`renderer.xr.updateCamera(camera)`, and `syncTilesCameraForXR()` before
`tiles.update()`. That makes tile visibility and LOD use the headset camera
during XR. Re-run `tiles.setResolution(camera, renderer.getSize(size))` from your
resize handler when the canvas size changes.

For AR placement and hit testing, use an AR-specific flow such as the
[Three.js AR hit-test example](https://threejs.org/examples/#webxr_ar_hittest)
in addition to this 3D Tiles camera/session pattern. AR applications still need
application-level reference-space alignment, anchors, real-world depth, and
occlusion handling.
