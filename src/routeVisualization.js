import { WGS84_ELLIPSOID } from "3d-tiles-renderer";
import {
  Box3,
  BoxGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Sphere,
  Vector3,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const MARKER_SEGMENTS = 24;
const DEG2RAD = Math.PI / 180;
const ROUTE_LINE_WIDTH = 10; // primary route width, screen pixels
const ROUTE_ALT_LINE_WIDTH = 7; // alternative route width, screen pixels

// Relative-to-mesh draping: snap the route onto the loaded 3D tiles surface
// (e.g. bridge decks) so the line stays continuous instead of sinking under
// elevated geometry. Tuned in meters.
const DRAPE_SAMPLE_SPACING = 8; // target spacing between draped samples
const DRAPE_MAX_SUBDIVISIONS = 64; // cap subdivisions per source segment
const DRAPE_RAY_ABOVE = 300; // start the ray this far above the terrain point
const DRAPE_RAY_BELOW = 80; // and extend it this far below
const DRAPE_MAX_GRADE = 0.15; // max road grade; steeper "climbs" are mesh artifacts
const DRAPE_INTERVAL = 0.15; // seconds between re-drape passes
const DRAPE_RAYCAST_BUDGET = 150; // max raycasts per pass, across all routes
const DRAPE_MAX_DISTANCE = 3000; // only drape samples within this range of camera
const DRAPE_CAM_EPS_SQ = 1; // camera move (m^2) that triggers a re-drape
const DRAPE_HEIGHT_EPS = 0.5; // ignore height changes smaller than this (m)

export function createRouteVisualization() {
  const routeGroup = new Group();
  routeGroup.name = "route-visualization";

  let activeTilesGroup = null;
  let lastResponse = null;
  let altitudeOffset = 0;
  let markerAltitudeOffset = 0;
  let markerRadius = 4;
  let showMarkers = false;
  let primaryRouteMarkerPoints = [];
  let carMesh = null;
  let animationState = null;
  let firstPersonPose = null;
  let drapeTargets = [];
  let drapeAccumulator = 0;
  let drapeDirty = false; // tiles streamed in / route changed: needs a pass
  let drapePending = false; // budget ran out mid-pass: keep going next pass
  let drapeTargetCursor = 0; // round-robins which route gets budget first
  const raycaster = new Raycaster();
  raycaster.firstHitOnly = true;
  const rayOrigin = new Vector3();
  const rayDir = new Vector3();
  const drapeFinalPos = new Vector3();
  const drapeIntersects = [];
  const drapeFrustum = new Frustum();
  const drapeProjScreen = new Matrix4();
  const drapeSphere = new Sphere(new Vector3(), 30);
  const drapeCamPos = new Vector3();
  const lastCamPos = new Vector3(Infinity, Infinity, Infinity);
  let drapeTilesRenderer = null;
  const zAxis = new Vector3(0, 0, 1);
  const routeTangent = new Vector3();
  const routeNormal = new Vector3();
  const routeBinormal = new Vector3();
  const routeMatrix = new Matrix4();
  const targetQuaternion = new Quaternion();
  const routeColors = [
    new Color(0x1d4ed8),
    new Color(0x60a5fa),
    new Color(0x14b8a6),
    new Color(0xf97316),
    new Color(0xa855f7),
    new Color(0xef4444),
  ];

  function attachToTilesGroup(tilesGroup) {
    if (activeTilesGroup === tilesGroup) {
      return;
    }

    routeGroup.removeFromParent();

    if (drapeTilesRenderer) {
      drapeTilesRenderer.removeEventListener("load-content", markDrapeDirty);
      drapeTilesRenderer.removeEventListener("tiles-load-end", markDrapeDirty);
      drapeTilesRenderer = null;
    }

    activeTilesGroup = tilesGroup;
    primaryRouteMarkerPoints = [];
    animationState = null;
    carMesh = null;
    firstPersonPose = null;
    drapeTargets = [];

    // Re-drape as new tile detail streams in (e.g. higher LOD on zoom-in).
    drapeTilesRenderer = tilesGroup?.tilesRenderer ?? null;
    if (drapeTilesRenderer) {
      drapeTilesRenderer.addEventListener("load-content", markDrapeDirty);
      drapeTilesRenderer.addEventListener("tiles-load-end", markDrapeDirty);
    }

    if (activeTilesGroup?.parent) {
      activeTilesGroup.parent.add(routeGroup);
    }

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function render(response) {
    clear();
    lastResponse = response;

    if (!activeTilesGroup) {
      return;
    }

    const routes = response?.routes?.filter(
      (route) => Array.isArray(route.path) && route.path.length > 0
    );
    if (!routes?.length) {
      return null;
    }

    const allPoints = [];
    primaryRouteMarkerPoints = [];

    routes.forEach((route, routeIndex) => {
      const routeColor = routeColors[routeIndex % routeColors.length];
      const stepSegments = getRouteSegments(route);

      stepSegments.forEach((segment) => {
        const samples = buildDrapeSamples(segment.path);
        if (samples.length < 2) {
          return;
        }

        const positions = new Array(samples.length * 3);
        samples.forEach((sample, index) => {
          allPoints.push(sample.basePos);
          positions[index * 3] = sample.basePos.x;
          positions[index * 3 + 1] = sample.basePos.y;
          positions[index * 3 + 2] = sample.basePos.z;
        });

        const lineGeometry = new LineGeometry();
        lineGeometry.setPositions(positions);
        const lineMaterial = new LineMaterial({
          color: routeColor,
          linewidth: routeIndex === 0 ? ROUTE_LINE_WIDTH : ROUTE_ALT_LINE_WIDTH,
          worldUnits: false,
          dashed: segment.travelMode === "WALKING",
          dashSize: 12,
          gapSize: 8,
        });
        lineMaterial.resolution.set(window.innerWidth, window.innerHeight);

        const line = new Line2(lineGeometry, lineMaterial);
        line.computeLineDistances();
        routeGroup.add(line);

        drapeTargets.push({
          line,
          geometry: lineGeometry,
          samples,
          positions,
          // rawHeights holds each sample's latest mesh hit (NaN until first
          // hit); work is the smoothed copy written to the geometry so
          // smoothing never feeds back into the raw hits.
          rawHeights: new Float64Array(samples.length).fill(NaN),
          work: new Float64Array(samples.length),
          cursor: 0,
        });
      });

      const markerPoints = route.path.map((point) =>
        routePointToVector3(point, markerAltitudeOffset).applyMatrix4(
          activeTilesGroup.matrixWorld
        )
      );

      if (routeIndex === 0) {
        primaryRouteMarkerPoints = markerPoints.map((point) => point.clone());
      }

      if (showMarkers) {
        const markerMaterial = new MeshBasicMaterial({
          color: routeColor,
          transparent: true,
          opacity: routeIndex === 0 ? 0.95 : 0.8,
        });

        markerPoints.forEach((point) => {
          const marker = new Mesh(
            new CircleGeometry(markerRadius, MARKER_SEGMENTS),
            markerMaterial.clone()
          );
          const normal = point.clone().normalize();
          marker.position.copy(point);
          marker.quaternion.copy(
            new Quaternion().setFromUnitVectors(zAxis, normal)
          );
          routeGroup.add(marker);
        });
      }
    });

    drapeDirty = true;
    drapePending = false;
    drapeTargetCursor = 0;

    const bounds = new Sphere();
    new Box3().setFromPoints(allPoints).getBoundingSphere(bounds);
    return { points: allPoints, bounds };
  }

  function clear() {
    lastResponse = null;
    animationState = null;
    primaryRouteMarkerPoints = [];
    carMesh = null;
    firstPersonPose = null;
    drapeTargets = [];
    routeGroup.children.forEach((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    });
    routeGroup.clear();
  }

  function startAnimation() {
    if (primaryRouteMarkerPoints.length < 2) {
      console.warn("No primary route available to animate.");
      return;
    }

    const curve = new CatmullRomCurve3(
      primaryRouteMarkerPoints.map((point) => point.clone()),
      false,
      "centripetal"
    );
    const totalDistance = curve.getLength();

    animationState = {
      distance: 0,
      speed: 30,
      curve,
      totalDistance,
      paused: false,
    };

    if (!carMesh) {
      carMesh = new Mesh(
        new BoxGeometry(22, 12, 8),
        new MeshBasicMaterial({ color: 0xffffff })
      );
      routeGroup.add(carMesh);
    }

    updateCarTransform();
  }

  function update(deltaSeconds, camera) {
    updateDrape(deltaSeconds, camera);

    if (!animationState || !carMesh || animationState.paused) {
      return;
    }

    animationState.distance = Math.min(
      animationState.distance + animationState.speed * deltaSeconds,
      animationState.totalDistance
    );

    updateCarTransform();

    if (animationState.distance >= animationState.totalDistance) {
      animationState.paused = true;
    }
  }

  function setResolution(width, height) {
    routeGroup.children.forEach((child) => {
      if (child.material?.isLineMaterial) {
        child.material.resolution.set(width, height);
      }
    });
  }

  function routePointToVector3(point, additionalOffset = 0) {
    const lat = getPointValue(point, "lat");
    const lng = getPointValue(point, "lng");
    const altitude = getPointValue(point, "altitude") ?? 0;
    const position = new Vector3();

    WGS84_ELLIPSOID.getCartographicToPosition(
      lat * (Math.PI / 180),
      lng * (Math.PI / 180),
      altitude + altitudeOffset + additionalOffset,
      position
    );

    return position;
  }

  function geodeticToWorld(lat, lng, altitude, matrixWorld) {
    const position = new Vector3();
    WGS84_ELLIPSOID.getCartographicToPosition(
      lat * DEG2RAD,
      lng * DEG2RAD,
      altitude,
      position
    );
    return position.applyMatrix4(matrixWorld);
  }

  function makeSample(lat, lng, altitude, matrixWorld) {
    const terrainPos = geodeticToWorld(lat, lng, altitude, matrixWorld);
    const up = terrainPos.clone().normalize();
    const basePos = terrainPos.clone().addScaledVector(up, altitudeOffset);
    return { terrainPos, up, basePos };
  }

  // Densify the source polyline so the draped line conforms to curved surfaces
  // (e.g. bridge decks) instead of cutting straight chords through the mesh.
  function buildDrapeSamples(path) {
    const matrixWorld = activeTilesGroup.matrixWorld;
    const raw = path
      .map((point) => {
        const lat = getPointValue(point, "lat");
        const lng = getPointValue(point, "lng");
        if (typeof lat !== "number" || typeof lng !== "number") {
          return null;
        }
        const alt = getPointValue(point, "altitude") ?? 0;
        return { lat, lng, alt, pos: geodeticToWorld(lat, lng, alt, matrixWorld) };
      })
      .filter(Boolean);

    if (raw.length < 2) {
      return [];
    }

    const samples = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      const subdivisions = Math.max(
        1,
        Math.min(
          DRAPE_MAX_SUBDIVISIONS,
          Math.ceil(a.pos.distanceTo(b.pos) / DRAPE_SAMPLE_SPACING)
        )
      );
      for (let j = 0; j < subdivisions; j++) {
        const t = j / subdivisions;
        samples.push(
          makeSample(
            a.lat + (b.lat - a.lat) * t,
            a.lng + (b.lng - a.lng) * t,
            a.alt + (b.alt - a.alt) * t,
            matrixWorld
          )
        );
      }
    }
    const last = raw[raw.length - 1];
    samples.push(makeSample(last.lat, last.lng, last.alt, matrixWorld));
    return samples;
  }

  function markDrapeDirty() {
    drapeDirty = true;
  }

  function updateDrape(deltaSeconds, camera) {
    if (!activeTilesGroup || drapeTargets.length === 0 || !camera) {
      return;
    }

    drapeAccumulator += deltaSeconds;
    if (drapeAccumulator < DRAPE_INTERVAL) {
      return;
    }
    drapeAccumulator = 0;

    camera.getWorldPosition(drapeCamPos);
    const cameraMoved =
      lastCamPos.distanceToSquared(drapeCamPos) > DRAPE_CAM_EPS_SQ;

    // Rest when nothing relevant changed: no camera movement, no newly loaded
    // tiles, and no work left over from a budget-capped pass.
    if (!drapeDirty && !drapePending && !cameraMoved) {
      return;
    }

    lastCamPos.copy(drapeCamPos);
    // Refine existing heights only when tiles actually changed (LOD streamed
    // in). Plain camera movement just drapes samples that are newly in range,
    // leaving settled heights untouched so the line doesn't shake while panning.
    const refine = drapeDirty;
    drapeDirty = false;
    drapePending = false;

    activeTilesGroup.updateMatrixWorld();
    drapeProjScreen.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    drapeFrustum.setFromProjectionMatrix(drapeProjScreen);

    const maxDistanceSq = DRAPE_MAX_DISTANCE * DRAPE_MAX_DISTANCE;
    const changed = new Set();
    let budget = DRAPE_RAYCAST_BUDGET;

    for (let t = 0; t < drapeTargets.length && budget > 0; t++) {
      const index = (drapeTargetCursor + t) % drapeTargets.length;
      const target = drapeTargets[index];
      const { samples, rawHeights } = target;
      let scanned = 0;

      while (scanned < samples.length) {
        const i = target.cursor;
        const sample = samples[i];

        // Only spend raycasts on samples in view and close enough that the
        // tiles under them are at high detail; far/coarse hits give bad
        // heights, so leave those on the terrain baseline until we approach.
        const needsDrape = refine || !Number.isFinite(rawHeights[i]);
        if (
          needsDrape &&
          drapeCamPos.distanceToSquared(sample.basePos) <= maxDistanceSq &&
          frustumContains(sample.basePos)
        ) {
          if (budget <= 0) {
            drapePending = true;
            break;
          }
          if (raycastSample(sample, rawHeights, i)) {
            changed.add(target);
          }
          budget--;
        }

        target.cursor = (i + 1) % samples.length;
        scanned++;
      }

      if (drapePending) {
        drapeTargetCursor = index;
        break;
      }
    }

    if (!drapePending) {
      drapeTargetCursor = 0;
    }

    changed.forEach(rebuildTargetGeometry);
  }

  function frustumContains(point) {
    drapeSphere.center.copy(point);
    return drapeFrustum.intersectsSphere(drapeSphere);
  }

  // Returns true when the sample's draped height actually changed.
  function raycastSample(sample, rawHeights, index) {
    rayOrigin.copy(sample.terrainPos).addScaledVector(sample.up, DRAPE_RAY_ABOVE);
    rayDir.copy(sample.up).multiplyScalar(-1);
    raycaster.set(rayOrigin, rayDir);
    raycaster.far = DRAPE_RAY_ABOVE + DRAPE_RAY_BELOW;
    drapeIntersects.length = 0;
    raycaster.intersectObject(activeTilesGroup, true, drapeIntersects);

    if (drapeIntersects.length === 0) {
      return false; // no geometry here yet; keep the previous height
    }

    // First hit is the highest surface along the downward ray (the deck).
    drapeFinalPos.copy(drapeIntersects[0].point).sub(sample.terrainPos);
    const height = drapeFinalPos.dot(sample.up);

    if (
      Number.isFinite(rawHeights[index]) &&
      Math.abs(rawHeights[index] - height) < DRAPE_HEIGHT_EPS
    ) {
      return false;
    }

    rawHeights[index] = height;
    return true;
  }

  function rebuildTargetGeometry(target) {
    const { samples, rawHeights, work, positions } = target;
    work.set(rawHeights);
    fillAndSmoothHeights(work, samples);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const height = Number.isFinite(work[i]) ? work[i] : 0;
      drapeFinalPos
        .copy(sample.terrainPos)
        .addScaledVector(sample.up, height + altitudeOffset);
      positions[i * 3] = drapeFinalPos.x;
      positions[i * 3 + 1] = drapeFinalPos.y;
      positions[i * 3 + 2] = drapeFinalPos.z;
    }

    target.geometry.setPositions(positions);
    target.line.computeLineDistances();
  }

  function fillAndSmoothHeights(heights, samples) {
    const n = heights.length;

    // 1) Fill samples with no mesh hit by interpolating between valid neighbors.
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(heights[i])) {
        continue;
      }
      if (prev === -1) {
        for (let k = 0; k < i; k++) heights[k] = heights[i];
      } else if (i - prev > 1) {
        const span = heights[i] - heights[prev];
        for (let k = prev + 1; k < i; k++) {
          heights[k] = heights[prev] + (span * (k - prev)) / (i - prev);
        }
      }
      prev = i;
    }
    if (prev === -1) {
      return; // nothing was hit
    }
    for (let k = prev + 1; k < n; k++) heights[k] = heights[prev];

    // 2) Slope-limited "cone erosion". Where the route passes UNDER a crossing
    //    overpass the top-down ray grabs the upper deck, producing a plateau
    //    joined to the real road by impossibly steep jumps. A road's height
    //    can't change faster than DRAPE_MAX_GRADE, so pull down any height that
    //    isn't reachable from its neighbors within that grade. Because it's
    //    anchored from both directions, a genuine bridge the route drives onto
    //    (gentle ramps either side) is preserved, while an under-crossing
    //    (road stays low on both sides) gets flattened back down — at any width.
    for (let i = 1; i < n; i++) {
      const d = samples[i].terrainPos.distanceTo(samples[i - 1].terrainPos);
      heights[i] = Math.min(heights[i], heights[i - 1] + DRAPE_MAX_GRADE * d);
    }
    for (let i = n - 2; i >= 0; i--) {
      const d = samples[i].terrainPos.distanceTo(samples[i + 1].terrainPos);
      heights[i] = Math.min(heights[i], heights[i + 1] + DRAPE_MAX_GRADE * d);
    }
  }

  function setAltitudeOffset(value) {
    altitudeOffset = value;
    // The offset only shifts the line along the surface normal, so re-apply it
    // to the cached mesh hits instead of re-rendering (which would throw away
    // the drape results and re-raycast the whole route).
    drapeTargets.forEach(rebuildTargetGeometry);
  }

  function setMarkerAltitudeOffset(value) {
    markerAltitudeOffset = value;

    // Markers are only rebuilt by render(); skip it (and the costly re-drape it
    // triggers) when markers aren't visible.
    if (showMarkers && lastResponse) {
      render(lastResponse);
    }
  }

  function setMarkerRadius(value) {
    markerRadius = value;

    if (showMarkers && lastResponse) {
      render(lastResponse);
    }
  }

  function setShowMarkers(value) {
    showMarkers = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function getPointValue(point, key) {
    const value = point?.[key];
    if (typeof value === "function") {
      return value.call(point);
    }
    return value;
  }

  function getRouteSegments(route) {
    const segments =
      route.legs?.flatMap((leg) =>
        leg.steps
          ?.filter((step) => Array.isArray(step.path) && step.path.length > 1)
          .map((step) => ({
            path: step.path,
            travelMode: step.travelMode,
          })) || []
      ) || [];

    if (segments.length > 0) {
      return segments;
    }

    return [
      {
        path: route.path,
        travelMode: "DRIVING",
      },
    ];
  }

  function updateCarTransform() {
    const state = animationState;
    if (!state || !carMesh || primaryRouteMarkerPoints.length < 2) {
      return;
    }

    const progress = Math.min(
      state.distance / Math.max(state.totalDistance, 1e-6),
      1
    );
    const lookAheadDistance = Math.min(18, state.totalDistance * 0.05);
    const lookAheadProgress = Math.min(
      (state.distance + lookAheadDistance) / Math.max(state.totalDistance, 1e-6),
      1
    );
    const position = state.curve.getPointAt(progress);
    const lookAhead = state.curve.getPointAt(lookAheadProgress);

    routeTangent.subVectors(lookAhead, position).normalize();
    routeNormal.copy(position).normalize();
    routeBinormal.crossVectors(routeNormal, routeTangent).normalize();
    routeTangent.crossVectors(routeBinormal, routeNormal).normalize();

    routeMatrix.makeBasis(routeTangent, routeBinormal, routeNormal);
    carMesh.position.copy(position);
    targetQuaternion.setFromRotationMatrix(routeMatrix);
    carMesh.quaternion.slerp(targetQuaternion, 0.18);
    firstPersonPose = {
      position: position.clone(),
      forward: routeTangent.clone(),
      up: routeNormal.clone(),
      right: routeBinormal.clone(),
    };
  }

  function toggleAnimation() {
    if (!primaryRouteMarkerPoints.length) {
      console.warn("No primary route available to animate.");
      return;
    }

    if (!animationState) {
      startAnimation();
      return;
    }

    animationState.paused = !animationState.paused;
  }

  function stopAnimation() {
    if (!animationState) {
      if (carMesh) {
        carMesh.visible = false;
      }
      return;
    }

    animationState.distance = 0;
    animationState.paused = true;

    if (carMesh) {
      carMesh.visible = true;
    }

    updateCarTransform();
  }

  function getCarPosition() {
    if (!carMesh || !animationState || animationState.paused) return null;
    if (animationState.distance >= animationState.totalDistance) return null;
    return carMesh.position;
  }

  return {
    attachToTilesGroup,
    render,
    clear,
    startAnimation,
    toggleAnimation,
    stopAnimation,
    update,
    getFirstPersonPose: () => firstPersonPose,
    getCarPosition,
    setAltitudeOffset,
    setMarkerAltitudeOffset,
    setMarkerRadius,
    setShowMarkers,
    setResolution,
  };
}
