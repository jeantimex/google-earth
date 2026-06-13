import { WGS84_ELLIPSOID } from "3d-tiles-renderer";
import {
  Box3,
  BoxGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
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

// Relative-to-mesh draping: snap the route onto the loaded 3D tiles surface
// (e.g. bridge decks) so the line stays continuous instead of sinking under
// elevated geometry. Tuned in meters.
const DRAPE_SAMPLE_SPACING = 8; // target spacing between draped samples
const DRAPE_MAX_SUBDIVISIONS = 64; // cap subdivisions per source segment
const DRAPE_RAY_ABOVE = 300; // start the ray this far above the terrain point
const DRAPE_RAY_BELOW = 80; // and extend it this far below
const DRAPE_SPIKE_THRESHOLD = 8; // height deviation that flags an under-crossing
const DRAPE_INTERVAL = 0.15; // seconds between re-drape passes
const DRAPE_RAYCAST_BUDGET = 150; // max raycasts per pass, across all routes

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
  const raycaster = new Raycaster();
  raycaster.firstHitOnly = true;
  const rayOrigin = new Vector3();
  const rayDir = new Vector3();
  const drapeFinalPos = new Vector3();
  const drapeIntersects = [];
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
    activeTilesGroup = tilesGroup;
    primaryRouteMarkerPoints = [];
    animationState = null;
    carMesh = null;
    firstPersonPose = null;
    drapeTargets = [];

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
          linewidth: routeIndex === 0 ? 6 : 4,
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
          // rawHeights holds each sample's mesh hit (NaN until resolved); work
          // is the smoothed copy written to the geometry so smoothing never
          // feeds back into the raw hits.
          rawHeights: new Float64Array(samples.length).fill(NaN),
          work: new Float64Array(samples.length),
          resolved: new Uint8Array(samples.length),
          resolvedCount: 0,
          cursor: 0,
          complete: false,
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

  function update(deltaSeconds) {
    updateDrape(deltaSeconds);

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

  function updateDrape(deltaSeconds) {
    if (!activeTilesGroup || drapeTargets.length === 0) {
      return;
    }

    drapeAccumulator += deltaSeconds;
    if (drapeAccumulator < DRAPE_INTERVAL) {
      return;
    }
    drapeAccumulator = 0;

    if (drapeTargets.every((target) => target.complete)) {
      return; // every route is fully draped; nothing left to raycast
    }

    activeTilesGroup.updateMatrixWorld();

    // Bound the work per pass so a long route can't stall a frame. Unresolved
    // samples are retried across passes as tiles stream in.
    let budget = DRAPE_RAYCAST_BUDGET;
    for (const target of drapeTargets) {
      if (budget <= 0) {
        break;
      }
      if (!target.complete) {
        budget = drapeTarget(target, budget);
      }
    }
  }

  function drapeTarget(target, budget) {
    const { samples, rawHeights, resolved } = target;
    let changed = false;
    let scanned = 0;
    let i = target.cursor;

    while (scanned < samples.length && budget > 0) {
      if (!resolved[i]) {
        const sample = samples[i];
        rayOrigin
          .copy(sample.terrainPos)
          .addScaledVector(sample.up, DRAPE_RAY_ABOVE);
        rayDir.copy(sample.up).multiplyScalar(-1);
        raycaster.set(rayOrigin, rayDir);
        raycaster.far = DRAPE_RAY_ABOVE + DRAPE_RAY_BELOW;
        drapeIntersects.length = 0;
        raycaster.intersectObject(activeTilesGroup, true, drapeIntersects);

        if (drapeIntersects.length > 0) {
          // First hit is the highest surface along the downward ray (the deck).
          drapeFinalPos
            .copy(drapeIntersects[0].point)
            .sub(sample.terrainPos);
          rawHeights[i] = drapeFinalPos.dot(sample.up);
          resolved[i] = 1;
          target.resolvedCount++;
          changed = true;
        }
        budget--;
      }

      i = (i + 1) % samples.length;
      scanned++;
    }

    target.cursor = i;
    if (target.resolvedCount >= samples.length) {
      target.complete = true;
    }

    if (changed) {
      rebuildTargetGeometry(target);
    }

    return budget;
  }

  function rebuildTargetGeometry(target) {
    const { samples, rawHeights, work, positions } = target;
    work.set(rawHeights);
    fillAndSmoothHeights(work);

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

  function fillAndSmoothHeights(heights) {
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

    // 2) Drop spikes: where the route passes under a crossing overpass the
    //    top-down ray grabs the upper deck. Pull such outliers back to the
    //    local median so the line stays on its own road.
    const window = 2;
    for (let pass = 0; pass < 2; pass++) {
      const source = heights.slice();
      for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - window);
        const hi = Math.min(n - 1, i + window);
        const neighborhood = [];
        for (let k = lo; k <= hi; k++) {
          if (k !== i) neighborhood.push(source[k]);
        }
        neighborhood.sort((a, b) => a - b);
        const median = neighborhood[Math.floor(neighborhood.length / 2)];
        if (Math.abs(source[i] - median) > DRAPE_SPIKE_THRESHOLD) {
          heights[i] = median;
        }
      }
    }
  }

  function setAltitudeOffset(value) {
    altitudeOffset = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function setMarkerAltitudeOffset(value) {
    markerAltitudeOffset = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function setMarkerRadius(value) {
    markerRadius = value;

    if (lastResponse) {
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
