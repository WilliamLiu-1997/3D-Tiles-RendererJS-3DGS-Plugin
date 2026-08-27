# WebXR / VR

The Gaussian splat renderer is WebXR-aware when `renderer.xr.isPresenting`.
For a pure WebXR render loop, use the same session-switching pattern as the
upstream
[3D Tiles Renderer VR example](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/example/three/vr.js):
register the normal camera outside XR, switch `TilesRenderer` to Three.js' XR
`ArrayCamera` when an XR session starts, and switch back when the session ends.

```js
import { Scheduler } from '3d-tiles-renderer';
import { VRButton } from 'three/addons/webxr/VRButton.js';

tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);

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
    tiles.setResolutionFromRenderer(camera, renderer);

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
during XR. Re-run `tiles.setResolutionFromRenderer(camera, renderer)` from your
resize handler when the canvas size changes.

For AR placement and hit testing, use an AR-specific flow such as the
[Three.js AR hit-test example](https://threejs.org/examples/#webxr_ar_hittest)
in addition to this 3D Tiles camera/session pattern. AR applications still need
application-level reference-space alignment, anchors, real-world depth, and
occlusion handling.
